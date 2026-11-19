import {
  GUIDE_TOPICS,
  KINDS,
  PROJECT_STATUSES,
  DECISION_STATUSES,
  TASK_STATUSES,
  TASK_TYPES,
  USER_TYPES,
  findLinkType,
  findOperation,
  isIdOfKind,
  isMoment,
  isStoredNumber,
  isToken,
  isUsername,
  isVersion,
  isWho,
  paging,
  normalizeId,
  splitRef,
  toHyphens,
  type Kind,
} from "@vigile/core";
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
  live_containers: optional(refsTo(["project", "task"], "a list of the live projects and tasks it is inside of")),
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
const DECISION = { kind: exactly("decision"), id: idOf("decision"), title: WORDS, status: oneOf(DECISION_STATUSES, "a decision status"), version: VERSION_OF_ITEM, deleted_at: optional(MOMENT) };
const SUMMARY: Record<Kind, Record<string, Sort>> = { task: TASK, project: PROJECT, user: USER, decision: DECISION };

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
/** How many entries a list has, or a revision of the plan: a whole number that can be counted to, and is printed as one. */
const COUNT: Sort = { is: (value) => Number.isSafeInteger(value) && (value as number) >= 0, called: "a whole number from 0 up" };
// Its place among the item's changes is the revision that wrote it and its number in that revision: what the
// token after a page of history names.
const HISTORY = each({ at: WORDS, by: WORDS, action: WORDS, data: OBJECT, place: { is: (value) => Array.isArray(value) && value.length === 2 && value.every((part) => COUNT.is(part)), called: "a place" } }, "a history");
const HISTORY_FEED = {
  kind: KIND,
  id: { is: (value: unknown) => typeof value === "string" && KINDS.some((kind) => isIdOfKind(kind, value)), called: "an item ID" },
  title: orNothing(WORDS),
  at: MOMENT,
  by: WHO,
  action: TEXT,
  data: OBJECT,
  duration_ms: optional(COUNT),
  place: { is: (value: unknown) => Array.isArray(value) && value.length === 2 && value.every((part) => COUNT.is(part)), called: "a place" },
};
/**
 * A continuation token, by the engine's own rule for what it makes: letters, digits, "-" and "_", beginning
 * with a letter. It is printed into the command that reads on and sent on as it came, and is held to being
 * what can be: nothing in it ends an option or means something to a shell.
 */
const TOKEN: Sort = { is: isToken, called: "a continuation token" };
/** Since which revision of the plan nothing that the answer shows has changed: what pages of one item are held against each other by. */
const UNCHANGED_SINCE = COUNT;
// What says that lists go on, `more`, is held against the lists of the answer it comes with: see `goesOn`.
const READ = { links: LINKS, created_at: MOMENT, created_by: WHO, updated_at: MOMENT, unchanged_since: UNCHANGED_SINCE, history: optional(HISTORY) };
/** Each entry of a timeline says its place, counted from the item's first status: what the token after a page of it names. */
const timelineOf = (statuses: readonly string[]): Sort => each({ status: oneOf(statuses, ""), at: MOMENT, by: WHO, place: COUNT }, "a timeline");
const DETAIL: Record<Kind, Record<string, Sort>> = {
  task: { ...READ, description: WORDS, why: orNothing(WORDS), timeline: timelineOf(TASK_STATUSES) },
  project: { ...READ, description: WORDS, timeline: timelineOf(PROJECT_STATUSES) },
  decision: { ...READ, description: WORDS, why: orNothing(WORDS), timeline: timelineOf(DECISION_STATUSES) },
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

/** Where a list that is read on by itself stands in an answer of `get`: a list of links under its name, the timeline, the history. */
type At = paging.At;
/** The lists of a task's summary, which `get` cuts and counts, and which are read on as lists of links. */
const COUNTED = ["contained_in", "live_containers", "depends_on", "assigned_to", "waiting_for"] as const;

/**
 * What an answer of `get` says of its lists that go on, `more`, held against those lists. The service names a
 * list there when it returned a part of it, and only then:
 * - a list that can be read on, the links under one name, the timeline, the history: how many entries it has,
 *   which is more than the answer shows of it, and the token that reads on. The token is one, and it is the
 *   token of that list of that item: it is what the command line prints for whoever reads on.
 * - in an item in full, a list of a task's summary: how many it has, more than are shown, and no token.
 * - in a page that continues a list (`page`), that list and no other; nothing when the page is the last.
 * A `more` that names no list is not sent, and neither is one about a list the answer does not carry.
 */
function goesOn(answer: Record<string, unknown>, kind: Kind, what: string, page?: At): string | null {
  if (!Object.hasOwn(answer, "more")) return null;
  const more = answer.more;
  if (!isRecord(more)) return `"more" of ${what} is not which lists go on`;
  const item = { kind, id: String(answer.id), feature_profile: answer.feature_profile as string | undefined };
  let named = 0;
  /** More than what is shown, and what is shown is something. */
  const counted = (field: string, part: unknown, shown: unknown): string | null => {
    named++;
    if (!Array.isArray(shown)) return `"more.${field}" of ${what} is about a list the answer does not carry`;
    if (!isRecord(part) || !COUNT.is(part.total) || (part.total as number) <= shown.length || shown.length === 0) {
      return `"more.${field}" of ${what} does not say how many entries the list has in all, more than the ${shown.length} that are shown`;
    }
    return null;
  };
  const readOn = (field: string, part: unknown, shown: unknown, at: At): string | null => {
    if (page && (page[0] !== at[0] || page[1] !== at[1])) return `"more.${field}" of ${what} is about another list than the page holds`;
    const why = counted(field, part, shown);
    if (why) return why;
    // The token is one of that list of that item, and names a place that list can have: the one check of a
    // token, which is the service's own.
    return paging.isTokenOf(paging.describeItemList(item, at), (part as Record<string, unknown>).continuation) ? null : `"more.${field}.continuation" of ${what} is not the token that reads on in that list`;
  };
  for (const field of COUNTED) {
    if (!Object.hasOwn(more, field)) continue;
    if (page) return `"more.${field}" of ${what} is about another list than the page holds`;
    const part = more[field];
    const why = counted(field, part, answer[field]) ?? (Object.hasOwn(part as object, "continuation") ? `"more.${field}" of ${what} carries a token, and the list is not read on by itself` : null);
    if (why) return why;
  }
  for (const field of ["timeline", "history"] as const) {
    if (!Object.hasOwn(more, field)) continue;
    const why = readOn(field, more[field], answer[field], [field]);
    if (why) return why;
  }
  if (Object.hasOwn(more, "links")) {
    const links = isRecord(answer.links) ? answer.links : {};
    if (!isRecord(more.links) || Object.keys(more.links).length === 0) return `"more.links" of ${what} is not which lists of links go on, by what they say`;
    for (const [name, part] of Object.entries(more.links)) {
      if (findLinkType(name) === null) return `"more.links" of ${what} is not which lists of links go on, by what they say`;
      const why = readOn(`links.${name}`, part, Object.hasOwn(links, name) ? links[name] : undefined, ["links", name]);
      if (why) return why;
    }
  }
  return named ? null : `"more" of ${what} names no list that goes on`;
}

/**
 * Whether a page of a list is one as the service gives it, by the steps that hold for whoever reads a list
 * (`takePage` in core's `paging.ts`): every entry has a place in the list, none is there twice, each is after
 * the place the page was asked from (`sent`, the token of the call), and what the page goes on with is a token
 * of this list that names the place of its furthest entry, neither one before it nor one beyond. It holds
 * for a page that ends the list as for one that goes on. What the command line prints as the way to read on
 * has passed this.
 */
function inPlace(list: paging.ListDescriptor, entries: unknown, continuation: unknown, sent: unknown, where: string): string | null {
  try {
    // A page that was asked for with a token is not the first: where it was asked from is the place that token names.
    paging.takePage(list, sent !== undefined && paging.isTokenOf(list, sent) ? paging.askedWith(list, sent) : paging.begun(), entries, continuation);
    return null;
  } catch (error) {
    if (error instanceof paging.NotAList) return `${where} is not a page of that list: ${error.why}`;
    throw error;
  }
}

/** What a list of an item goes on with, as the answer says it in `more`: the token of that list, or that the list ends. */
function onwards(answer: Record<string, unknown>, at: At): unknown {
  const more = isRecord(answer.more) ? answer.more : {};
  const part = at[0] === "links" ? (isRecord(more.links) && Object.hasOwn(more.links, at[1]) ? more.links[at[1]] : undefined) : Object.hasOwn(more, at[0]) ? more[at[0]] : undefined;
  return isRecord(part) ? part.continuation : paging.ENDS;
}

/** Every list of an answer of `get`, or the one list of a page, held to being a page of that list: see `inPlace`. */
function listsInPlace(answer: Record<string, unknown>, kind: Kind, what: string, page?: At, sent?: unknown): string | null {
  const item = { kind, id: String(answer.id), feature_profile: answer.feature_profile as string | undefined };
  const links = isRecord(answer.links) ? answer.links : {};
  const all: At[] = page ? [page] : [...Object.keys(links).map((name): At => ["links", name]), ...(["timeline", "history"] as const).filter((list) => Object.hasOwn(answer, list)).map((list): At => [list])];
  for (const at of all) {
    const entries = at[0] === "links" ? links[at[1]] : answer[at[0]];
    const why = inPlace(paging.describeItemList(item, at), entries, onwards(answer, at), sent, `"${at.join(".")}" of ${what}`);
    if (why) return why;
  }
  return null;
}

/** An item in full, as `get` answers a call without a continuation: the item the call names, what it says of its lists that go on, and each list a first page of itself. */
const inFull: Judge = (answer, input) => {
  const why = theItem(KINDS, (_input, kind) => DETAIL[kind])(answer, input);
  if (why) return why;
  const { kind } = answer as { kind: Kind };
  return goesOn(answer as Record<string, unknown>, kind, `the ${kind}`) ?? listsInPlace(answer as Record<string, unknown>, kind, `the ${kind}`);
};

/**
 * The next page of one of an item's lists, which `get` answers to a call with a continuation: the item's kind,
 * ID and version, since when it is unchanged, and that one list, with what says that it goes on. It is no whole
 * item, and is not held to being one. It is about the item the call names, and its list is the one the token of
 * the call continues: of that item, its timeline, its history, or its links under one name, which a page of
 * links says also when it holds nothing. Which list a token is for is read from the token by the engine's own
 * rule, as the service reads it. A user that was named by its username comes back as its ID, and a page
 * carries no username: the token says which user's list it continues.
 */
const aPage: Judge = (answer, input) => {
  const among = kindsOf(input);
  const kind = isRecord(answer) ? answer.kind : undefined;
  if (!isRecord(answer) || !isKind(kind) || !among.includes(kind)) return `it is not a page of a ${among.join(" or a ")}`;
  const what = `a page of the ${kind}`;
  // A user has no timeline: its lists are its links and its history.
  const lists: Record<string, Sort> = { links: LINKS, ...(kind === "user" ? {} : { timeline: DETAIL[kind].timeline! }), history: HISTORY };
  const there = Object.keys(lists).filter((list) => Object.hasOwn(answer, list)) as Array<"links" | "timeline" | "history">;
  const list = there[0];
  if (there.length !== 1 || !list) return `it is not one list of the ${kind}: a page carries its links, its timeline or its history, and one of them`;
  const why = carries(answer, what, { id: idOf(kind), version: VERSION_OF_ITEM, unchanged_since: UNCHANGED_SINCE, [list]: lists[list]! });
  if (why) return why;
  const names = list === "links" ? Object.keys(answer.links as object) : [];
  if (list === "links" && names.length !== 1) return `"links" of ${what} is not one list of links, under the name it reads by`;
  const at: At = list === "links" ? ["links", names[0]!] : [list];
  if (typeof input.id !== "string") return `it is about ${about(answer)}, and the call names no item`;
  const { kind: stated, rest } = splitRef(input.id);
  const named = (!stated || stated === kind) && (normalizeId(kind, rest) === answer.id || (kind === "user" && normalizeId("user", rest) === null));
  if (!named) return `it is about ${about(answer)}, and not about ${input.id}`;
  if (!paging.isTokenOf(paging.describeItemList({ kind, id: answer.id as string, feature_profile: answer.feature_profile as string | undefined }, at), input.continuation)) return `it is a page of ${at.join(" ")} of ${about(answer)}, and not of the list the continuation of the call reads on in`;
  return goesOn(answer, kind, what, at) ?? listsInPlace(answer, kind, what, at, input.continuation);
};

const about = (answer: unknown): string => (isRecord(answer) && typeof answer.kind === "string" && typeof answer.id === "string" ? `the ${answer.kind} ${answer.id}` : "something else");

/**
 * A list of items, with what else the list says. A list that is returned a page at a time, by the operation
 * that is named, says where the next page begins when there is one: a token, after a page that holds
 * something, and the token of this very list, which is the operation with the filters of the call. It is
 * printed for whoever reads on with the same command, and a token of another list would only be refused there.
 */
const listed =
  (paged: string | null, field: string, spec: Record<string, Sort>, what: string, also: Record<string, Sort> = {}): Judge =>
  (answer, input) => {
    const why = carries(answer, "a list", { [field]: each(spec, `a list of ${what}`), ...(paged ? { continuation: optional(TOKEN) } : {}), ...also });
    if (why || !paged || !paging.isPaged(paged)) return why;
    const page = answer as Record<string, unknown>;
    // The list as it was asked for. Whose list it is, where it is a user's own, is not known here.
    const list = paging.describeList(paged, input);
    const goesOn = Object.hasOwn(page, "continuation");
    if (goesOn && (page[field] as unknown[]).length === 0) return `"continuation" of a list says that there is more, after a page that holds nothing`;
    if (goesOn && !paging.isTokenOf(list, page.continuation)) return `"continuation" of a list is not a token of the list that was asked for`;
    return inPlace(list, page[field], goesOn ? page.continuation : paging.ENDS, input.continuation, `"${field}" of a list`);
  };

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
  create_decision: (answer) => summary(answer, ["decision"]),
  update_decision: theItem(["decision"]),
  list_decisions: listed("list_decisions", "decisions", DECISION, "decisions"),
  set_project_status: theItem(["project"]),
  // A list is of whatever the service found for what was asked: which items those are is the service's to say,
  // and the command line, which does not have the plan, holds a list to nothing but that each item is one.
  list_projects: listed("list_projects", "projects", PROJECT, "projects"),
  create_task: (answer) => summary(answer, ["task"]),
  update_task: theItem(["task"]),
  set_task_status: theItem(["task"]),
  list_tasks: listed("list_tasks", "tasks", TASK, "tasks"),
  list_history: listed("list_history", "changes", HISTORY_FEED, "history changes"),
  // Each of them can be started: that is what the list says of them.
  list_next_tasks: listed("list_next_tasks", "tasks", { ...TASK, is_next: exactly(true), priority_path: listOf(NUMBER, "a priority path") }, "tasks that can be started"),
  list_stale_tasks: listed("list_stale_tasks", "claims", { ...TASK, quiet_since: MOMENT, attention_since: MOMENT }, "quiet task claims", { attention_after_hours: exactly(24) }),
  // The item in full, or, to a call with a continuation, the next page of one of its lists.
  get: (answer, input) => (input.continuation === undefined ? inFull(answer, input) : aPage(answer, input)),
  delete: deleted,
  restore: theItem(KINDS),
  override_timestamp: theItem(["project", "task"]),
  add_link: linked({ created: YES_NO }),
  remove_link: linked({ removed: exactly(true) }),
  list_link_types: listed(null, "link_types", { type: TEXT, reverse: TEXT, from: listOf(KIND, "a list of kinds"), to: listOf(KIND, "a list of kinds"), built_in: YES_NO, effect: TEXT }, "link types"),
  create_user: issued(),
  // Who asked is said with the list.
  list_users: listed("list_users", "users", USER, "users", { you: NAME_OF_USER }),
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
