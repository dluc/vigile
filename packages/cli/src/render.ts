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

function more(ui: Ui, result: any): void {
  if (!result.continuation) return;
  ui.out();
  ui.out(`  ${dim(ui, `There are more. Next page: add --continuation ${result.continuation}`)}`);
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
    pairs.push(["Assigned to", item.assigned_to.length ? item.assigned_to.join(", ") : "nobody"]);
  }
  if (item.kind === "project") pairs.push(["Progress", `${item.progress.finished} of ${plural(item.progress.total, "task")} finished`]);
  if (item.kind === "user") pairs.push(["Type", item.type], ["Built in", item.built_in ? "yes" : "no"]);
  if (item.completed_at) pairs.push(["Completed", item.completed_at]);
  pairs.push(["Created", `${item.created_at} by ${item.created_by}`], ["Updated", item.updated_at], ["Version", String(item.version)]);
  fields(ui, pairs);

  const links = Object.entries(item.links ?? {}) as Array<[string, any[]]>;
  if (links.length) {
    ui.out();
    const size = Math.max(...links.map(([relation]) => relation.length));
    for (const [relation, items] of links) {
      for (const other of items) {
        ui.out(`  ${dim(ui, pad(relation, size))}  ${accent(ui, other.id)}  ${titled(other.title)}${other.status ? `  ${status(ui, other.status)}` : ""}${other.deleted ? dim(ui, "  (deleted)") : ""}`);
      }
    }
  }
  if (item.timeline?.length) {
    ui.out();
    for (const entry of item.timeline) ui.out(`  ${dim(ui, entry.at)}  ${pad(status(ui, entry.status), 11)}  ${dim(ui, `by ${entry.by}`)}`);
  }
  if (item.history?.length) {
    ui.out();
    ui.out(`  ${dim(ui, "History")}`);
    const size = Math.max(...item.history.map((h: any) => label(h.action).length));
    for (const entry of item.history) {
      ui.out(`  ${dim(ui, entry.at)}  ${pad(label(entry.action), size)}  ${dim(ui, `by ${entry.by}`)}  ${change(entry.data)}`.trimEnd());
    }
  }
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

type Printer = (ui: Ui, result: any, base: string) => void;

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
  ui.out();
};

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
  list_next_tasks: tasks(true),
  get: detail,
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
export function renderResult(ui: Ui, operation: string, given: any, base: string): void {
  const result = printable(given);
  if (Object.hasOwn(PRINTED, operation)) PRINTED[operation]!(ui, result, base);
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
    for (const item of Array.isArray(error.blocking) ? error.blocking : []) {
      if (typeof item !== "object" || item === null) continue;
      lines.push(`    ${dim(ui, SYMBOL.dot)} ${accent(ui, word(item.id))}  ${word(item.title)}${word(item.status) ? `  ${status(ui, word(item.status))}` : ""}`);
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
