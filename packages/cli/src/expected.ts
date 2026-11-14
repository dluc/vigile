import { GUIDE_TOPICS, KINDS, PROJECT_STATUSES, TASK_STATUSES, TASK_TYPES, USER_TYPES, findLinkType, findOperation, isIdOfKind, isMoment, isStoredNumber, isUsername, isVersion, isWho, normalizeId, splitRef, toHyphens, type Kind } from "@vigile/core";
import { isRecord, notAsOperation, unknownOutcome } from "./answers.js";

/**
 * What the answer of each operation has to carry, for the command line to say anything about it. An answer is
 * judged by the operation that was called, and never by what it happens to look like: a list of tasks does not
 * say that an item was deleted, the answer of add_link does not say that a link was removed, and a project is
 * not the task that was asked for.
 *
 * Three things are checked of an answer, and no more.
 * - It is the answer of the operation that was called: every field the service always sends is there, of the
 *   kind the service sends it as, and what it sends only when there is something to say is of its kind when it
 *   is there. That holds whatever the call asked: a list of dependencies is a list of references to tasks and
 *   projects as the service writes them, the users a task is assigned to are usernames. And it is never held to
 *   more than the service can answer. The service answers with its stored items as they are, and what a stored
 *   item may be is said once, in the engine (shape.ts in core): the rule for a moment, a number, a version, a
 *   username, an ID is taken from there, and where the engine says "a text", a title that may be empty, this
 *   says "a text". No field has a rule of the command line's own.
 * - Where the call names an item that exists, an item to read, change, delete or bring back, a user to give a
 *   key, the two ends of a link, the answer is about that item, by the rule the service itself has for what a
 *   reference names. Where that cannot be told, a user named by its username and answered by its ID, it is at
 *   least an item of that kind, named in the form the store has its ID in.
 * - What a sentence of success rests on is so: deleted is `true`, a link was made or was there or was removed
 *   by a yes or a no that is one, a key is a text.
 *
 * What is not checked is whether the values of the item in the answer are the ones the call asked for: the
 * title, the status, the priority, what it depends on, who it is assigned to, a date, whether a deletion was for
 * good. What the service makes of a call is the engine's to decide, by rules that are the engine's and are
 * tested there: it removes what is given twice, takes a name or an ID for the same user, fills in what was left
 * out, writes a text its own way. The command line does not work those rules out a second time. It prints what
 * the service says it stored, so that whoever asked sees it.
 */

type Input = Record<string, unknown>;
/** Why an answer is not the one the operation gives to this call, or nothing when it is. */
type Judge = (answer: unknown, input: Input) => string | null;

interface Sort {
  is(value: unknown): boolean;
  called: string;
}
/** A text that the service makes itself and that always says something: a key, the name of a link's type. */
const TEXT: Sort = { is: (value) => typeof value === "string" && value !== "", called: "a text" };
/** A text as it is stored, which may say nothing: a title, a description. */
const WORDS: Sort = { is: (value) => typeof value === "string", called: "text" };
const NUMBER: Sort = { is: isStoredNumber, called: "a number" };
const YES_NO: Sort = { is: (value) => typeof value === "boolean", called: "yes or no" };
const OBJECT: Sort = { is: isRecord, called: "an object" };
const optional = (sort: Sort): Sort => ({ is: (value) => value === undefined || sort.is(value), called: sort.called });
const orNothing = (sort: Sort): Sort => ({ is: (value) => value === null || sort.is(value), called: sort.called });
const exactly = (wanted: unknown): Sort => ({ is: (value) => value === wanted, called: JSON.stringify(wanted) });
const oneOf = (words: readonly string[], called: string): Sort => ({ is: (value) => typeof value === "string" && words.includes(value), called });
const listOf = (sort: Sort, called: string): Sort => ({ is: (value) => Array.isArray(value) && value.every((item) => sort.is(item)), called });
const each = (spec: Record<string, Sort>, called: string): Sort => ({ is: (value) => Array.isArray(value) && value.every((item) => carries(item, "", spec) === null), called });
const having = (spec: Record<string, Sort>, called: string): Sort => ({ is: (value) => carries(value, "", spec) === null, called });

/** Whether a value has the fields that are named, each of its sort. Says the first that is not. */
function carries(value: unknown, what: string, spec: Record<string, Sort>): string | null {
  if (!isRecord(value)) return `it is not ${what}`;
  for (const [field, sort] of Object.entries(spec)) {
    if (!sort.is(Object.hasOwn(value, field) ? value[field] : undefined)) return `"${field}" of ${what} is not ${sort.called}`;
  }
  return null;
}

/**
 * The sorts of value the service's answers are made of (views.ts in core), each by the rule the engine has for
 * the stored field it shows: an ID in the one form its kind has, a version that is a whole number from 1 up, a
 * status that is one of the kind's, a moment that is any text naming one. A value that a command takes from an
 * answer and sends on, such as the ID and the version that a removal names, is then what the request it goes
 * into needs.
 */
const idOf = (kind: Kind): Sort => ({ is: (value) => isIdOfKind(kind, value), called: `the ID of a ${kind}` });

/**
 * The kinds, among those given, that a text names an item of as the service writes a reference to one (refText
 * in core): the item's ID, with "project:" in front for a project whose ID is a number and for nothing else, so
 * that a bare number is a task. None when the text is no reference the service would write.
 */
function writtenFor(text: unknown, kinds: readonly Kind[]): Kind[] {
  if (typeof text !== "string") return [];
  if (text.startsWith("project:")) return kinds.includes("project") && /^\d+$/.test(text.slice(8)) && isIdOfKind("project", text.slice(8)) ? ["project"] : [];
  return kinds.filter((kind) => isIdOfKind(kind, text) && !(kind === "project" && /^\d+$/.test(text)));
}
/** The ID in a reference as the service writes one. */
const idIn = (written: string): string => (written.startsWith("project:") ? written.slice(8) : written);
const refsTo = (kinds: readonly Kind[], called: string): Sort => ({ is: (value) => Array.isArray(value) && value.every((item) => writtenFor(item, kinds).length > 0), called });
const NAME_OF_USER: Sort = { is: isUsername, called: "a username" };
/** Who did something, as an item shows it: the name of the user, or what is stored of a user the service no longer finds, which is the user's ID. */
const WHO: Sort = { is: (value) => isUsername(value) || isWho(value), called: "a username or the ID of a user" };
const VERSION_OF_ITEM: Sort = { is: isVersion, called: "a whole number from 1 up" };
/** A count the service works out: of tasks, of those that are finished. */
const HOW_MANY: Sort = { is: (value) => typeof value === "number" && Number.isInteger(value) && value >= 0, called: "a whole number from 0 up" };
const MOMENT: Sort = { is: isMoment, called: "a moment" };
const KIND = oneOf(KINDS, "project, task or user");
const PROGRESS = having({ finished: HOW_MANY, total: HOW_MANY }, "how many are finished, and of how many");
// What a problem is called and what it says are the service's words, made of what is stored: text.
const PROBLEMS = optional(each({ code: WORDS, message: WORDS }, "a list of problems"));

/** An item as lists and the answers to changes have it: every field the service always sends, and those it sends only when there is something to say. */
const TASK: Record<string, Sort> = {
  kind: exactly("task"),
  id: idOf("task"),
  title: WORDS,
  type: oneOf(TASK_TYPES, `one of ${TASK_TYPES.join(", ")}`),
  status: oneOf(TASK_STATUSES, `one of ${TASK_STATUSES.join(", ")}`),
  priority: NUMBER,
  value: orNothing(NUMBER),
  size: orNothing(NUMBER),
  version: VERSION_OF_ITEM,
  contained_in: refsTo(["project", "task"], "a list of the projects and tasks it is in"),
  depends_on: refsTo(["task", "project"], "a list of the tasks and projects it depends on"),
  assigned_to: listOf(NAME_OF_USER, "a list of usernames"),
  is_assigned: YES_NO,
  is_next: YES_NO,
  is_waiting: YES_NO,
  waiting_for: refsTo(["task", "project"], "a list of the tasks and projects it waits for"),
  has_problems: YES_NO,
  problems: PROBLEMS,
  progress: optional(PROGRESS),
  completed_at: optional(MOMENT),
  deleted_at: optional(MOMENT),
};
const PROJECT: Record<string, Sort> = {
  kind: exactly("project"),
  id: idOf("project"),
  title: WORDS,
  status: oneOf(PROJECT_STATUSES, `one of ${PROJECT_STATUSES.join(", ")}`),
  version: VERSION_OF_ITEM,
  progress: PROGRESS,
  has_problems: YES_NO,
  problems: PROBLEMS,
  deleted_at: optional(MOMENT),
};
const USER: Record<string, Sort> = {
  kind: exactly("user"),
  id: idOf("user"),
  username: NAME_OF_USER,
  type: oneOf(USER_TYPES, `one of ${USER_TYPES.join(", ")}`),
  built_in: YES_NO,
  version: VERSION_OF_ITEM,
  deleted_at: optional(MOMENT),
};
const SUMMARY: Record<Kind, Record<string, Sort>> = { task: TASK, project: PROJECT, user: USER };

/**
 * What `get` adds to an item: its links in both directions, by the name each reads by; when it was made and
 * changed, and by whom; its texts and its timeline, which a user has none of; and its history when asked.
 */
const LINKS: Sort = {
  is: (value) =>
    isRecord(value) &&
    Object.entries(value).every(
      ([name, items]) =>
        findLinkType(name) !== null &&
        each({ kind: KIND, id: TEXT, title: WORDS, status: optional(TEXT), deleted: optional(exactly(true)) }, "").is(items) &&
        // What is linked is named as the service writes a reference to an item of the kind it says it is.
        (items as Array<{ kind: Kind; id: string }>).every((item) => writtenFor(item.id, [item.kind]).length === 1),
    ),
  called: "the links of the item, by what they say",
};
// An entry of the history is not an item, and the engine has no rule for what one may be but that it is kept
// as it was written: when, by whom and what are text, and what it says of the change is an object in a shape of
// its own for each kind of change. It is shown as far as it is known, and nothing is done on the strength of it.
const READ = { links: LINKS, created_at: MOMENT, created_by: WHO, updated_at: MOMENT, history: optional(each({ at: WORDS, by: WORDS, action: WORDS, data: OBJECT }, "a history")) };
const timelineOf = (statuses: readonly string[]): Sort => each({ status: oneOf(statuses, ""), at: MOMENT, by: WHO }, "a timeline");
const DETAIL: Record<Kind, Record<string, Sort>> = {
  task: { ...READ, description: WORDS, why: orNothing(WORDS), timeline: timelineOf(TASK_STATUSES) },
  project: { ...READ, description: WORDS, timeline: timelineOf(PROJECT_STATUSES) },
  user: READ,
};

const isKind = (value: unknown): value is Kind => (KINDS as readonly unknown[]).includes(value);

/** An item of one of the kinds, as a summary of it. */
function summary(answer: unknown, kinds: readonly Kind[], more: (kind: Kind) => Record<string, Sort> = () => ({})): string | null {
  const kind = isRecord(answer) ? answer.kind : undefined;
  if (!isKind(kind) || !kinds.includes(kind)) return `it is not a ${kinds.join(" or a ")}`;
  return carries(answer, `the ${kind}`, { ...SUMMARY[kind], ...more(kind) });
}

/**
 * Whether a reference, as it was written in the call, names the item that came back. The rule is the service's
 * own: the ID of the kind, however it was typed, or a username for a user, with the kind in front where it was.
 */
function names(asked: unknown, kinds: readonly Kind[], item: Record<string, unknown>): boolean {
  if (typeof asked !== "string" || !isKind(item.kind)) return false;
  const { kind: stated, rest } = splitRef(asked);
  if (!(stated ? [stated] : kinds).includes(item.kind)) return false;
  if (normalizeId(item.kind, rest) === item.id) return true;
  return item.kind === "user" && rest.toLowerCase() === item.username;
}

/** The kinds a call may be about: the one it states, or any. */
const kindsOf = (input: Input, among: readonly Kind[] = KINDS): readonly Kind[] => (isKind(input.kind) ? among.filter((kind) => kind === input.kind) : among);

/** One item, read, changed or brought back: the item the call names, with what the operation says of it. */
const theItem =
  (kinds: readonly Kind[], more: (input: Input, kind: Kind) => Record<string, Sort> = () => ({})): Judge =>
  (answer, input) => {
    const among = kindsOf(input, kinds);
    return summary(answer, among, (kind) => more(input, kind)) ?? (names(input.id, among, answer as Record<string, unknown>) ? null : `it is about ${about(answer)}, and not about ${String(input.id)}`);
  };

const about = (answer: unknown): string => (isRecord(answer) && typeof answer.kind === "string" && typeof answer.id === "string" ? `the ${answer.kind} ${answer.id}` : "something else");

/** A list of items, with what else the list says: where the next page begins when there is one. */
const listed =
  (field: string, spec: Record<string, Sort>, what: string, more: Record<string, Sort> = { continuation: optional(TEXT) }): Judge =>
  (answer) =>
    carries(answer, "a list", { [field]: each(spec, `a list of ${what}`), ...more });

/**
 * A key that was issued: the key, and the user it is for. Where the call names a user that exists, it is that
 * user; a user that the call makes is held to being a user.
 */
const issued =
  (named?: (input: Input) => unknown): Judge =>
  (answer, input) => {
    // The key is the service's to make: any text that says something.
    const why = carries(answer, "an issued key", { api_key: TEXT, warning: optional(TEXT) }) ?? carries((answer as Record<string, unknown>).user, "the user", USER);
    if (why) return why;
    const user = (answer as { user: Record<string, unknown> }).user;
    return !named || names(named(input), ["user"], user) ? null : `it is about ${about(user)}, and not about ${String(named(input))}`;
  };

/**
 * Whether an end of a link, or a reference like one, as the call wrote it, is the one that came back. It comes
 * back as the service writes a reference: that has to name an item of a kind the call allows, in the form the
 * store has its ID in. Then it is the item the call named, by the service's own rule. One thing cannot be told:
 * a user that was named by its username comes back as its ID, and which user has which name only the service
 * knows. Any user's ID is then taken for it, and nothing that is not the ID of a user.
 */
function isEnd(asked: unknown, kinds: readonly Kind[], written: unknown): boolean {
  if (typeof asked !== "string" || typeof written !== "string") return false;
  const { kind: stated, rest } = splitRef(asked);
  const among = writtenFor(written, stated ? kinds.filter((kind) => kind === stated) : kinds);
  if (among.some((kind) => normalizeId(kind, rest) === idIn(written))) return true;
  return among.includes("user") && normalizeId("user", rest) === null;
}

/** A link that was made or removed: the link the call names, by the name its type has, with what became of it. */
const linked =
  (became: Record<string, Sort>): Judge =>
  (answer, input) => {
    const why = carries(answer, "what became of a link", became) ?? carries((answer as Record<string, unknown>).link, "the link", { from: TEXT, type: TEXT, to: TEXT });
    if (why) return why;
    const link = (answer as { link: Record<string, string> }).link;
    const found = typeof input.type === "string" ? findLinkType(input.type) : null;
    if (!found || link.type !== found.linkType.type) return `it is about a link "${link.type}", and not "${String(input.type)}"`;
    // A type that was written by its other name connects the same two items the other way round.
    const [from, to] = found.reversed ? [input.to, input.from] : [input.from, input.to];
    return isEnd(from, found.linkType.from, link.from) && isEnd(to, found.linkType.to, link.to) ? null : `it is about the link ${link.from} ${link.type} ${link.to}, and not the one that was asked for`;
  };

/**
 * An item that was deleted: a yes that is `true`, whether for good by a yes or a no, and the item the call names.
 * The answer names the item by its kind and by a reference as the service writes one: that has to be a reference
 * to an item of that kind, and the kind one the call allows. Then it is the item the call named, with the one
 * thing that cannot be told: a user that was named by its username comes back as its ID, and the answer of a
 * deletion carries no username. Any user's ID is then taken for it, and nothing that is not the ID of a user.
 */
const deleted: Judge = (answer, input) => {
  const why = carries(answer, "a deletion", { deleted: exactly(true), permanent: YES_NO, kind: KIND, id: TEXT });
  if (why) return why;
  const { kind, id } = answer as { kind: Kind; id: string };
  if (writtenFor(id, [kind]).length !== 1) return `"id" of a deletion is not the ID of a ${kind}`;
  return isEnd(input.id, kindsOf(input).filter((allowed) => allowed === kind), id) ? null : `it is about ${about(answer)}, and not about ${String(input.id)}`;
};

/**
 * Every operation, by its name, with what its answer has to be. An operation that is not here has no answer the
 * command line would take for it: a test fails when the engine has one that this table does not.
 */
export const EXPECTED: Record<string, Judge> = {
  // What makes a new item answers with the item, as what changes one does. The call names no item that exists,
  // so the answer is held to being a project, a task, a user with its key: which one, and with what values, is
  // the service's to say.
  create_project: (answer) => summary(answer, ["project"]),
  set_project_status: theItem(["project"]),
  // A list is of whatever the service found for what was asked: which items those are is the service's to say,
  // and the command line, which does not have the plan, holds a list to nothing but that each item is one.
  list_projects: listed("projects", PROJECT, "projects"),
  create_task: (answer) => summary(answer, ["task"]),
  update_task: theItem(["task"]),
  set_task_status: theItem(["task"]),
  list_tasks: listed("tasks", TASK, "tasks"),
  // Each of them can be started: that is what the list says of them.
  list_next_tasks: listed("tasks", { ...TASK, is_next: exactly(true) }, "tasks that can be started"),
  get: theItem(KINDS, (_input, kind) => DETAIL[kind]),
  delete: deleted,
  restore: theItem(KINDS),
  override_timestamp: theItem(["project", "task"]),
  add_link: linked({ created: YES_NO }),
  remove_link: linked({ removed: exactly(true) }),
  list_link_types: listed("link_types", { type: TEXT, reverse: TEXT, from: listOf(KIND, "a list of kinds"), to: listOf(KIND, "a list of kinds"), built_in: YES_NO, effect: TEXT }, "link types", {}),
  create_user: issued(),
  // Who asked is said with the list.
  list_users: listed("users", USER, "users", { you: NAME_OF_USER }),
  reset_user_key: issued((input) => input.user),
  // The part of the guide that was asked for is the part that is read.
  get_guide: (answer, input) =>
    carries(answer, "a guide", {
      topic: typeof input.topic === "string" ? exactly(input.topic) : oneOf(GUIDE_TOPICS, "a topic of the guide"),
      title: TEXT,
      text: TEXT,
      topics: each({ topic: oneOf(GUIDE_TOPICS, ""), title: TEXT, summary: TEXT }, "a list of topics"),
    }),
};

/**
 * Judges the answer to a call of an operation. Returns why it is not what that operation answers to that call,
 * or nothing when it is. An operation the command line has no expectation for has no answer it takes.
 */
export function judge(operation: string, input: Input, answer: unknown): string | null {
  if (!Object.hasOwn(EXPECTED, operation)) return `this command line does not know what ${operation} answers`;
  return EXPECTED[operation]!(answer, input);
}

/**
 * The answer to a call, once it is what the called operation gives to that call. Any other answer is a failure:
 * to a change, that its outcome is not known, with how to find out; to a question, that it was not answered as
 * the operation answers. Nothing is said, and nothing shown as a result, on the strength of such an answer.
 */
export function accepted<T = any>(base: string, operation: string, input: Input, answer: unknown, findOut: string): T {
  const why = judge(operation, input, answer);
  if (why === null) return answer as T;
  const asked = `POST /api/${toHyphens(operation)}`;
  throw findOperation(operation)?.kind === "read" ? notAsOperation(base, asked, toHyphens(operation), why) : unknownOutcome(base, asked, answer, why, findOut);
}
