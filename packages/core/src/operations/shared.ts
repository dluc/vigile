import { z } from "zod";
import { invalidInput } from "../errors.js";
import { sameRef } from "../graph.js";
import { KINDS, LIMITS, TASK_TYPES, type Link, type Node, type Ref, type StatusEntry } from "../model.js";
import type { ReadContext } from "../operation.js";
import { NotAList, namesPlace, openToken, questionMark, tokenAfter, tokenOf, type ListDescriptor, type OpenToken } from "../paging.js";

/** Characters that steer a screen or a store instead of showing something. Line breaks and tabs are not among them. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const LINE_BREAK_OR_TAB = /[\t\n\r\u2028\u2029]/;
/** Whether anything of a text can be seen: spaces, marks of direction and joiners of no width alone show nothing. */
const shows = (value: string): boolean => value.replace(/[\s\p{Cf}\p{Cc}]/gu, "").length > 0;
/** Half of a pair of code units cannot be stored and read back as it was. */
const whole = (value: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);

export const title = z
  .string()
  .trim()
  .min(1, "A title cannot be empty.")
  .max(LIMITS.title, `A title has at most ${LIMITS.title} characters.`)
  // Text that shows nothing is as empty as none. With nothing at all the rule about length has said so already.
  .refine((value) => value.length === 0 || shows(value), "A title cannot be empty.")
  .refine((value) => !CONTROL.test(value) && !LINE_BREAK_OR_TAB.test(value), "A title is one line of plain text: it cannot contain line breaks, tabs or control characters.")
  .refine(whole, "A title cannot contain a broken character.");

export const text = z
  .string()
  .max(LIMITS.text, `Text has at most ${LIMITS.text} characters.`)
  .refine((value) => !CONTROL.test(value), "Text cannot contain control characters other than line breaks and tabs.")
  .refine(whole, "Text cannot contain a broken character.");

export const requiredText = text.refine(shows, "A description cannot be empty.");

export const version = z.number().int().min(1).describe("The version of the item you last read. The call fails with a conflict if the item changed since.");

export const kind = z.enum(KINDS).optional().describe('The kind of item: "project", "task" or "user". Needed only when the ID alone is ambiguous.');

export const continuation = z.string().optional().describe("The continuation token from the previous page. Return it unchanged to the same operation with the same filters; stop when no token is returned.");

export const number = z.number().finite();

/** A changed copy of a node: one version further, updated now. Nodes in the graph are never edited in place. */
export function touch<N extends Node>(node: N, ctx: ReadContext, changes: Partial<N> = {}): N {
  return { ...node, ...changes, version: node.version + 1, updated_at: ctx.now };
}

/**
 * What a caller is told with a key that is stored and works, but that the key store could not vouch for:
 * the key is theirs to use, and worth issuing again once the cause is put right.
 */
export const unconfirmed = (why: string): string => `This key is in place and works, but it may not survive a power cut: ${why} If it stops working after one, issue a new key with reset_user_key.`;

export const statusEntry = (status: string, ctx: ReadContext): StatusEntry => ({ status, at: ctx.now, by: ctx.caller.id });

export interface Page<T> {
  items: T[];
  continuation?: string;
}

/**
 * Continuation tokens. A token is made and read by one list of one operation: the operation, its filters and
 * whatever else decides what is listed, which is the list's question, and for a list that depends on who asks,
 * who that is. To everyone else a token is a word to hand back as it came.
 *
 * What a token is made of, and what each list is (what it was asked for, what its sort key looks like, what
 * order it is in), is said once, in `paging.ts`, for the service and for everything that follows a token. Here
 * every token is made and read by the `Cursor` of its list, which is built from the list's descriptor. A cursor hands out a token only after reading it back itself and finding the
 * key it put in, so whatever the service gives as a token it takes back, for the same place in the list.
 */

const refuseToken = (why: string) => invalidInput(`The continuation token ${why}.`, ["Call again without a token to start from the first page."]);

/** A token that continues none of the lists it could: it came from another operation, other filters or another item. */
const tokenOfAnotherList = () => refuseToken("belongs to another list: the same operation and the same filters must be sent with it");

/** The tokens of one list: the one place that makes them and the one that reads them. */
export interface Cursor<K> {
  /** The list, which says what it was asked for, whose it is, what its sort key looks like and what order it is in. */
  readonly list: ListDescriptor<K>;
  /**
   * The token that continues the list after the item with this sort key. There is one for every key of the
   * list, of any length: a key that would make the token longer than a token is, is named by its mark.
   * Nothing only for what is no key of the list at all.
   */
  after(key: unknown): string | undefined;
  /**
   * The sort key of the place a token names. A token of another list, of another user's list or one that was
   * made up is refused. `keys` gives the sort keys the list has now: a token that names its place by a mark
   * names the key among them that has it, and is refused, as something to start again from, when the entry is
   * no longer there. The keys are gone through only for such a token.
   */
  place(token: string, keys: () => Iterable<K>): K;
  /** Whether a token says that it continues this list. */
  owns(token: string): boolean;
}

export function cursor<K>(list: ListDescriptor<K>): Cursor<K> {
  const q = questionMark(list.question);
  const place = (token: string, keys: () => Iterable<K>): K => {
    let says: OpenToken;
    try {
      says = tokenOf(list, token);
    } catch (error) {
      throw error instanceof NotAList && /another list/.test(error.why) ? tokenOfAnotherList() : refuseToken("is not valid");
    }
    if (says.x === undefined) return says.k as K;
    for (const key of keys()) if (namesPlace(says, key)) return key;
    throw refuseToken("names an entry that is no longer in the list");
  };
  return {
    list,
    place,
    owns: (token) => openToken(token)?.q === q,
    after(key) {
      const token = tokenAfter(list, key);
      // Read back by what will read it: only a token that names the key again is handed out.
      try {
        return token !== undefined && JSON.stringify(place(token, () => [key as K])) === JSON.stringify(key) ? token : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Which of several lists a token continues, where one operation returns more than one: the token says so
 * itself, and nothing else has to. A token of none of them is refused, and so is something that is no token.
 */
export function listOf<L extends { cursor: Cursor<any> }>(token: string, lists: L[]): L {
  if (!openToken(token)) throw refuseToken("is not valid");
  const list = lists.find((candidate) => candidate.cursor.owns(token));
  if (!list) throw tokenOfAnotherList();
  return list;
}

/**
 * Cuts one page out of a sorted list: at most `LIMITS.page` items, whatever they are. The token names the sort
 * key of the last item returned, so the next page starts right after it even if items were added or removed in
 * between. It also says which question it continues: the operation, its filters and whatever else decides what
 * is listed.
 *
 * The order has to put no two items in the same place: the next page begins after everything that is not
 * after the key. There is a token after every item: one whose key is too long to be written into a token, an
 * ID that damage left, is named by the mark of its key, and the next page finds it by that.
 */
export function paginate<T, K>(sorted: T[], sortKey: (item: T) => K, token: string | undefined, list: Cursor<K>): Page<T> {
  let start = 0;
  if (token !== undefined) {
    const last = list.place(token, function* () {
      for (const item of sorted) yield sortKey(item);
    });
    start = sorted.findIndex((item) => list.list.compare(sortKey(item), last) > 0);
    if (start < 0) start = sorted.length;
  }
  const items = sorted.slice(start, start + LIMITS.page);
  if (items.length === 0 || start + items.length >= sorted.length) return { items };
  const next = list.after(sortKey(items.at(-1)!));
  // Every item of a list has a key of the list: one that has none is no item of it, and the list is not cut short without a word.
  if (next === undefined) throw new Error(`No continuation token names the place of ${JSON.stringify(sortKey(items.at(-1)!))?.slice(0, 200)}.`);
  return { items, continuation: next };
}

/**
 * The first few of a list in its order, from the start or after a given place, found in one pass: a list of
 * thousands is not put in order whole to return a page of it. What is kept at any moment is the few that are
 * first so far.
 */
export function firstFew<T>(items: Iterable<T>, few: number, compare: (a: T, b: T) => number, after?: T): T[] {
  const found: T[] = [];
  for (const item of items) {
    if (after !== undefined && compare(item, after) <= 0) continue;
    if (found.length === few && compare(item, found[few - 1]!) >= 0) continue;
    let low = 0;
    let high = found.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (compare(found[middle]!, item) <= 0) low = middle + 1;
      else high = middle;
    }
    found.splice(low, 0, item);
    if (found.length > few) found.pop();
  }
  return found;
}


export const why = z
  .string()
  .trim()
  .min(1, "Leave why out instead of sending it empty.")
  .max(LIMITS.why, `Why has at most ${LIMITS.why} characters.`)
  .refine((value) => value.length === 0 || shows(value), "Leave why out instead of sending it empty.")
  .refine((value) => !CONTROL.test(value), "Why cannot contain control characters other than line breaks and tabs.")
  .refine(whole, "Why cannot contain a broken character.")
  .describe("Why this work matters. Give at least one reason; add more if there are several. Optional, but it helps whoever picks the task up decide and prioritise.");

export const taskType = z
  .enum(TASK_TYPES)
  .describe(
    "What this is. task: planned work (the default). bug: something that should work and does not. issue: a problem or open question that needs attention. incident: something is failing right now and needs urgent action. Bugs, issues and incidents are shown apart from planned work.",
  );

export const parentTask = z
  .string()
  .describe(
    "The ID of a task that contains this one. Use it to group work: create one task for a feature or epic, then create its steps with parent set to it. Groups can hold sub-groups. A group shows how many of its tasks are finished.",
  );

export const priority = number.describe("The higher, the more important. Not set means 0.");
export const value = number.describe("How valuable the task is; the higher, the more. Helps choose among tasks of equal priority.");
export const size = number.describe("How large the task is; the higher, the larger. Helps choose among tasks of equal priority.");

export const newLink = (ctx: ReadContext, from: Ref, type: string, to: Ref): Link => ({
  from: { kind: from.kind, id: from.id },
  type,
  to: { kind: to.kind, id: to.id },
  created_at: ctx.now,
  created_by: ctx.caller.id,
});

export function unique<N extends Node>(nodes: N[]): N[] {
  return nodes.filter((node, index) => nodes.findIndex((other) => sameRef(other, node)) === index);
}
