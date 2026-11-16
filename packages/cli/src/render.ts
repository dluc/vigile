import { isToken } from "@vigile/core";
import { SYMBOL, accent, bold, dim, fields, mark, note, pad, plural, table, type Ui } from "./ui.js";

type Style = Parameters<Ui["paint"]>[0];

const STATUS_STYLE: Record<string, Style> = {
  in_progress: "blue",
  in_review: "magenta",
  open: "green",
  done: "green",
  ready: "green",
  in_preview: "magenta",
  broken: "red",
  paused: "gray",
  draft: "gray",
  cancelled: "gray",
};

const label = (status: string): string => status.replaceAll("_", " ");
/** How a status is painted. One that is not listed, whatever word it is, is painted grey. */
const styleOf = (value: string): Style => (Object.hasOwn(STATUS_STYLE, value) ? STATUS_STYLE[value]! : "gray");
const status = (ui: Ui, value: string): string => ui.paint(styleOf(value), label(value));
const orDash = (value: unknown): string => (value === null || value === undefined || value === "" ? SYMBOL.none : String(value));
/**
 * A title as it is shown. One that shows nothing, empty or made of spaces and marks that have no width, which a
 * stored item may have, is said to be that: a blank would hide the item it stands for.
 */
const NO_TITLE = "(no title)";
const titled = (title: unknown): string => (typeof title === "string" && title.replace(/[\s\p{Cf}\p{Cc}]/gu, "") !== "" ? title : NO_TITLE);

function state(task: any): string {
  if (task.status === "open") return task.is_waiting ? "waiting" : "next";
  return label(task.status);
}

function taskTable(ui: Ui, tasks: any[], next: boolean): void {
  table(ui, tasks, [
    { title: "ID", value: (t) => t.id, style: () => "cyan" },
    ...(next ? [] : [{ title: "STATE", value: (t: any) => state(t), style: (t: any): Style => (t.is_waiting ? "yellow" : styleOf(t.status)) }]),
    { title: "TYPE", value: (t: any) => (t.type === "task" ? SYMBOL.none : t.type), style: (t: any): Style | undefined => (t.type === "task" ? "dim" : "magenta") },
    { title: next ? "PRIORITY" : "PRI", value: (t) => String(t.priority), right: true },
    { title: "VALUE", value: (t) => orDash(t.value), right: true },
    { title: "SIZE", value: (t) => orDash(t.size), right: true },
    { title: "ASSIGNED", value: (t) => (t.assigned_to.length ? t.assigned_to.join(",") : SYMBOL.none) },
    { title: "TITLE", value: (t) => `${t.has_problems ? `${SYMBOL.warn} ` : ""}${titled(t.title)}${t.progress ? `  (${t.progress.finished}/${t.progress.total})` : ""}` },
  ]);
}

/**
 * What is added to a command to read on, with the token the service gave for it. The token is printed for a
 * person to paste into a command: it is printed only when it is a token as the service makes them, which is
 * letters, digits, "-" and "_" beginning with a letter, and needs no quotes in any shell. An answer is looked
 * at before it is printed (expected.ts); should anything else get here, it is not printed, and the answer is
 * reported as one that cannot be read.
 */
function readOn(token: unknown): string {
  if (!isToken(token)) throw new TypeError("what says where to read on is not a continuation token");
  return `add --continuation ${token}`;
}

function more(ui: Ui, result: any): void {
  if (result.continuation === undefined) return;
  ui.out();
  ui.out(`  ${dim(ui, `There are more. Next page: ${readOn(result.continuation)}`)}`);
}

function detail(ui: Ui, item: any): void {
  ui.out();
  const flags = [item.is_next && ui.paint("green", "next"), item.is_waiting && ui.paint("yellow", "waiting"), item.deleted_at && ui.paint("red", "deleted")].filter(Boolean);
  ui.out(`  ${accent(ui, item.id)}  ${item.status ? status(ui, item.status) : dim(ui, item.type)}${flags.length ? `  ${flags.join("  ")}` : ""}`);
  ui.out(`  ${bold(ui, item.kind === "user" ? item.username : titled(item.title))}`);
  ui.out();
  for (const problem of item.problems ?? []) note(ui, "warn", problem.message);
  if (item.problems?.length) ui.out();
  if (item.description) {
    for (const line of String(item.description).split("\n")) ui.out(`  ${line}`);
    ui.out();
  }
  if (item.why) {
    ui.out(`  ${dim(ui, "Why")}`);
    for (const line of String(item.why).split("\n")) ui.out(`  ${line}`);
    ui.out();
  }
  const pairs: Array<[string, string]> = [];
  if (item.kind === "task") {
    pairs.push(["Type", item.type], ["Priority", String(item.priority)], ["Value", orDash(item.value)], ["Size", orDash(item.size)]);
    if (item.progress) pairs.push(["Progress", `${item.progress.finished} of ${plural(item.progress.total, "task")} inside finished`]);
    pairs.push(["Assigned to", item.assigned_to.length ? `${item.assigned_to.join(", ")}${item.more?.assigned_to ? `, … (${item.more.assigned_to.total} in all)` : ""}` : "nobody"]);
  }
  if (item.kind === "project") pairs.push(["Progress", `${item.progress.finished} of ${plural(item.progress.total, "task")} finished`]);
  if (item.kind === "user") pairs.push(["Type", item.type], ["Built in", item.built_in ? "yes" : "no"]);
  if (item.completed_at) pairs.push(["Completed", item.completed_at]);
  pairs.push(["Created", `${item.created_at} by ${item.created_by}`], ["Updated", item.updated_at], ["Version", String(item.version)]);
  // Since when nothing that is shown of the item has changed: what a further page is held against.
  pairs.push(["Unchanged since", `revision ${item.unchanged_since}`]);
  fields(ui, pairs);
  lists(ui, item);
  ui.out();
}

/** What says that a list is not whole: how many of how many are shown, and how to read on. */
function cut(ui: Ui, shown: number, part: any, of: string, next: string): string {
  return dim(ui, `${of} ${shown} of ${part.total}. ${next}: ${readOn(part.continuation)}`);
}

/**
 * The lists of an item: its links, its timeline, its history. Each holds at most a page; one that goes on says
 * so, with the token that reads on. This is also all there is to show of a page that continues one of them.
 */
function lists(ui: Ui, item: any, continued = false): void {
  const more = item.more ?? {};
  // Of a timeline and a history the latest entries come first, and a page that continues holds the ones before.
  const these = continued ? "A further" : "The latest";
  const links = Object.entries(item.links ?? {}) as Array<[string, any[]]>;
  if (links.length) {
    ui.out();
    const size = Math.max(...links.map(([relation]) => relation.length));
    for (const [relation, items] of links) {
      for (const other of items) {
        ui.out(`  ${dim(ui, pad(relation, size))}  ${accent(ui, other.id)}  ${titled(other.title)}${other.status ? `  ${status(ui, other.status)}` : ""}${other.deleted ? dim(ui, "  (deleted)") : ""}`);
      }
      const part = more.links && Object.hasOwn(more.links, relation) ? more.links[relation] : undefined;
      if (part) ui.out(`  ${dim(ui, pad(relation, size))}  ${cut(ui, items.length, part, "These are", "Next page")}`);
    }
  }
  if (item.timeline?.length) {
    ui.out();
    if (more.timeline) ui.out(`  ${cut(ui, item.timeline.length, more.timeline, these, "The ones before")}`);
    for (const entry of item.timeline) ui.out(`  ${dim(ui, entry.at)}  ${pad(status(ui, entry.status), 11)}  ${dim(ui, `by ${entry.by}`)}`);
  }
  if (item.history?.length) {
    ui.out();
    ui.out(`  ${dim(ui, "History")}`);
    if (more.history) ui.out(`  ${cut(ui, item.history.length, more.history, these, "The ones before")}`);
    const size = Math.max(...item.history.map((h: any) => label(h.action).length));
    for (const entry of item.history) {
      ui.out(`  ${dim(ui, entry.at)}  ${pad(label(entry.action), size)}  ${dim(ui, `by ${entry.by}`)}  ${change(entry.data)}`.trimEnd());
    }
  }
}

/**
 * One list of an item, read on with a continuation: the item's ID and version, and that list. The command line
 * does not know what was printed before: it says since which revision of the plan nothing that is shown of the
 * item has changed, for whoever reads it to hold against what the first page said. Pages that say two different
 * revisions were read with a change in between, and do not belong together.
 */
function page(ui: Ui, item: any): void {
  ui.out();
  ui.out(`  ${accent(ui, item.id)}  ${dim(ui, `v${item.version}`)}`);
  ui.out(`  ${dim(ui, `A page of the item as it is unchanged since revision ${item.unchanged_since}. If the first page said "Unchanged since" another revision, the item or one of its lists has changed in between: read it again from the start.`)}`);
  lists(ui, item, true);
  if (![...Object.values(item.links ?? {}), item.timeline ?? [], item.history ?? []].some((list: any) => list.length)) ui.out(`  ${dim(ui, "Nothing more.")}`);
  ui.out();
}

/** A history entry's data in a few words. */
function change(data: any): string {
  // A link has two ends and a type. A type alone is that of a task created as a bug, or of a user.
  if (data.from !== undefined && data.to !== undefined && data.type === undefined) return `${label(String(data.from))} ${SYMBOL.fix} ${label(String(data.to))}`;
  if (data.from !== undefined && data.to !== undefined) return `${data.from} ${data.type} ${data.to}`;
  if (data.changes) {
    return Object.entries(data.changes)
      .map(([field, value]) => (Array.isArray(value) ? `${field}: ${JSON.stringify(value[0])} ${SYMBOL.fix} ${JSON.stringify(value[1])}` : field))
      .join(", ");
  }
  if (data.status) return [`as ${label(String(data.status))}`, data.type && `type ${data.type}`, data.contained_in && `in ${data.contained_in.join(", ")}`].filter(Boolean).join(", ");
  if (data.username) return `${data.username}, ${data.type}`;
  return "";
}

function oneLine(ui: Ui, item: any): string {
  if (item.kind === "user") return `${accent(ui, item.id)}  ${item.username}  ${dim(ui, item.type)}`;
  const extra = item.kind === "task" ? (item.is_waiting ? `  ${ui.paint("yellow", `waiting for ${item.waiting_for.join(", ")}`)}` : item.is_next ? `  ${ui.paint("green", "next")}` : "") : "";
  return `${accent(ui, item.id)}  ${titled(item.title)}  ${status(ui, item.status)}${extra}  ${dim(ui, `v${item.version}`)}`;
}

/**
 * What came from the service, made safe to print: text that people and agents wrote may hold characters that
 * steer a terminal, which could wipe a line, draw a row that is not there or hide what follows. Each becomes a
 * mark that shows something was there. Line breaks and tabs stay, as they do in a description; a return to the
 * start of the line that no new line follows would let what comes after it write over what came before.
 */
export function printable<T>(value: T): T {
  if (typeof value === "string") return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]|\r(?!\n)/g, "\uFFFD") as T;
  if (Array.isArray(value)) return value.map(printable) as T;
  // The names of fields too: those of a history entry's changes are printed, and are whatever the store holds.
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [printable(key), printable(inner)])) as T;
  return value;
}

/** Prints the answer of an operation. `input` is what the operation was called with: an answer is printed as the answer to that call. */
type Printer = (ui: Ui, result: any, base: string, input: Record<string, unknown>) => void;

const tasks =
  (next: boolean): Printer =>
  (ui, result) => {
    ui.out();
    if (result.tasks.length) taskTable(ui, result.tasks, next);
    ui.out(result.tasks.length ? "" : `  ${dim(ui, next ? "Nothing can be started right now." : "No tasks match.")}`);
    if (result.tasks.length) ui.out(`  ${dim(ui, next ? `${plural(result.tasks.length, "task")} can be started now` : plural(result.tasks.length, "task"))}`);
    more(ui, result);
    ui.out();
  };

/** Quiet assigned work, with the timing evidence that makes each claim belong in this list. */
const staleTasks: Printer = (ui, result) => {
  ui.out();
  table<any>(ui, result.claims, [
    { title: "ID", value: (task) => task.id, style: () => "cyan" },
    { title: "QUIET SINCE", value: (task) => task.quiet_since },
    { title: "ATTENTION SINCE", value: (task) => task.attention_since },
    { title: "ASSIGNED", value: (task) => task.assigned_to.join(",") },
    { title: "TITLE", value: (task) => titled(task.title) },
  ]);
  ui.out(result.claims.length ? "" : `  ${dim(ui, "No assigned work has been quiet past the attention threshold.")}`);
  ui.out(`  ${dim(ui, `Attention threshold: ${result.attention_after_hours} hours without a recorded task change`)}`);
  more(ui, result);
  ui.out();
};

const projects: Printer = (ui, result) => {
  ui.out();
  table<any>(ui, result.projects, [
    { title: "ID", value: (p) => p.id, style: () => "cyan" },
    { title: "STATUS", value: (p) => label(p.status), style: (p) => styleOf(p.status) },
    { title: "PROGRESS", value: (p) => `${p.progress.finished}/${p.progress.total}`, right: true },
    { title: "TITLE", value: (p) => `${p.has_problems ? `${SYMBOL.warn} ` : ""}${titled(p.title)}` },
  ]);
  ui.out();
  ui.out(`  ${dim(ui, plural(result.projects.length, "project"))}`);
  more(ui, result);
  ui.out();
};

const users: Printer = (ui, result) => {
  ui.out();
  table<any>(ui, result.users, [
    { title: "ID", value: (u) => u.id, style: () => "cyan" },
    { title: "USERNAME", value: (u) => u.username },
    { title: "TYPE", value: (u) => u.type },
    { title: "", value: (u) => (u.built_in ? "built in" : ""), style: () => "dim" },
  ]);
  more(ui, result);
  ui.out();
};

/** What `get` answers: the item in full, or, to a call with a continuation, the next page of one of its lists. */
const read: Printer = (ui, result, _base, input) => (input.continuation === undefined ? detail(ui, result) : page(ui, result));

const guide: Printer = (ui, result) => {
  ui.out();
  ui.out(`  ${accent(ui, result.title)}`);
  ui.out();
  for (const line of result.text.split("\n")) ui.out(line.startsWith("## ") ? `  ${accent(ui, line.slice(3))}` : `  ${line}`);
  ui.out();
  ui.out(`  ${dim(ui, "Topics:")}`);
  for (const topic of result.topics) ui.out(`    ${topic.topic === result.topic ? SYMBOL.fix : " "} ${topic.topic.padEnd(11)} ${dim(ui, topic.summary)}`);
  ui.out(`  ${dim(ui, "Read one with: vigile get-guide --topic <topic>")}`);
  ui.out();
};

const linkTypes: Printer = (ui, result) => {
  ui.out();
  for (const type of result.link_types) {
    ui.out(`  ${accent(ui, `"${type.type}"`)}  ${dim(ui, `reverse: "${type.reverse}"`)}`);
    ui.out(`    ${type.from.join(" or ")} ${SYMBOL.fix} ${type.to.join(" or ")}`);
    ui.out(`    ${dim(ui, type.effect)}`);
    ui.out();
  }
};

const key: Printer = (ui, result, base) => {
  ui.out();
  note(ui, "ok", `${result.user.username} (${result.user.type}) has a new API key`);
  ui.out();
  fields(ui, [
    ["Key", result.api_key],
    ["MCP URL", `${base}/mcp`],
    ["Header", `Authorization: Bearer ${result.api_key}`],
  ]);
  ui.out();
  ui.out(`  ${dim(ui, "The key is stored in the config file. Give it to the client; it will not be shown again here.")}`);
  if (result.warning) note(ui, "warn", result.warning);
  ui.out();
};

const linkText = (result: any): string => `${result.link.from} ${result.link.type} ${result.link.to}`;
// A yes that is `true` and nothing else: a text that reads as one is not one.
const linked: Printer = (ui, result) => note(ui, "ok", result.created === true ? `Linked: ${linkText(result)}` : `Already linked: ${linkText(result)}`);
const unlinked: Printer = (ui, result) => note(ui, "ok", `Removed: ${linkText(result)}`);

const historyChanges: Printer = (ui, result) => {
  for (const change of result.changes) {
    const item = change.title ? `${change.kind} ${change.id} · ${change.title}` : `${change.kind} ${change.id}`;
    ui.out(`${change.at}  ${change.action.replaceAll("_", " ")}  ${item}  by ${change.by}`);
    if (Object.keys(change.data).length) ui.out(`  ${JSON.stringify(change.data)}`);
  }
  // `more` says to add the continuation to the command that produced this page, so its original filters stay in place.
  more(ui, result);
};

const deleted: Printer = (ui, result) => {
  const forGood = result.permanent === true;
  note(ui, "ok", `${result.kind} ${result.id} deleted${forGood ? " permanently" : ""}`, forGood ? undefined : `To bring it back: vigile restore ${result.id}`);
};

const item: Printer = (ui, result) => {
  ui.out(`  ${mark(ui, "ok")} ${oneLine(ui, result)}`);
  for (const problem of result.problems ?? []) ui.out(`    ${ui.paint("yellow", SYMBOL.warn)} ${problem.message}`);
};

/**
 * How the answer of each operation is printed. The way goes by the operation that was called, and not by what
 * an answer happens to look like: whether the answer is what that operation gives is judged before it gets
 * here (see expected.ts). A test fails when the engine has an operation that is not in this table.
 */
const PRINTED: Record<string, Printer> = {
  create_project: item,
  set_project_status: item,
  list_projects: projects,
  create_task: item,
  update_task: item,
  set_task_status: item,
  list_tasks: tasks(false),
  list_history: historyChanges,
  list_next_tasks: tasks(true),
  list_stale_tasks: staleTasks,
  get: read,
  delete: deleted,
  restore: item,
  override_timestamp: item,
  add_link: linked,
  remove_link: unlinked,
  list_link_types: linkTypes,
  create_user: key,
  list_users: users,
  reset_user_key: key,
  get_guide: guide,
};

/** Whether the command line has a way to print the answer of an operation. */
export const isPrinted = (operation: string): boolean => Object.hasOwn(PRINTED, operation);

/**
 * Shows an operation's result the way a person reads it. `--json` skips this and prints the raw result.
 * An operation that has no way of its own is shown as it came.
 */
export function renderResult(ui: Ui, operation: string, given: any, base: string, input: Record<string, unknown> = {}): void {
  const result = printable(given);
  if (Object.hasOwn(PRINTED, operation)) PRINTED[operation]!(ui, result, base, input);
  else ui.out(JSON.stringify(result, null, 2));
}

/** A word of an answer as it is printed: a text or a number, and nothing for anything else. */
const word = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value) : "");

/**
 * A refusal: what happened, what is in the way, and what can be done. The refusal is the service's, and is read
 * for what it is: a part of it that is of another kind than a refusal has is left out, and one that says nothing
 * that can be read is reported as that. Nothing in it can keep the failure from being reported.
 */
export function renderError(ui: Ui, given: unknown): void {
  const lines: string[] = [];
  try {
    const safe: unknown = printable(given);
    const error: Record<string, unknown> = typeof safe === "object" && safe !== null && !Array.isArray(safe) ? (safe as Record<string, unknown>) : {};
    lines.push(`  ${ui.paint("red", SYMBOL.fail)} ${word(error.message) || "The service refused the request, and did not say why in a way this command line can read."}`);
    const blocking: unknown[] = Array.isArray(error.blocking) ? error.blocking : [];
    for (const item of blocking) {
      if (typeof item !== "object" || item === null) continue;
      lines.push(`    ${dim(ui, SYMBOL.dot)} ${accent(ui, word((item as Record<string, unknown>).id))}  ${word((item as Record<string, unknown>).title)}${word((item as Record<string, unknown>).status) ? `  ${status(ui, word((item as Record<string, unknown>).status))}` : ""}`);
    }
    // A refusal names the first few of what is in the way, and says how many there are when those are not all.
    const total: unknown = error.blocking_total;
    if (typeof total === "number" && Number.isSafeInteger(total) && total > blocking.length) {
      lines.push(`    ${dim(ui, `${SYMBOL.dot} and ${total - blocking.length} more`)}`);
    }
    for (const action of Array.isArray(error.actions) ? error.actions : []) if (typeof action === "string") lines.push(`    ${dim(ui, SYMBOL.fix)} ${action}`);
    if (error.current && typeof error.current === "object") {
      const current = error.current as Record<string, unknown>;
      lines.push(`    ${dim(ui, `now: ${word(current.id)}  ${word(current.status)}  v${word(current.version)}`)}`);
    }
  } catch {
    // Nested too deep to walk, as no refusal of the service is.
    lines.length = 0;
    lines.push(`  ${ui.paint("red", SYMBOL.fail)} The service refused the request, and did not say why in a way this command line can read.`);
  }
  ui.err();
  for (const line of lines) ui.err(line);
  ui.err();
}
