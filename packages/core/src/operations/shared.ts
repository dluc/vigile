import { createHash } from "node:crypto";
import { z } from "zod";
import { invalidInput } from "../errors.js";
import { sameRef } from "../graph.js";
import { KINDS, LIMITS, TASK_TYPES, type Link, type Node, type Ref, type StatusEntry } from "../model.js";
import type { ReadContext } from "../operation.js";

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

export const continuation = z.string().optional().describe("The continuation token from the previous page, to get the next one.");

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

/** What a list was asked for, in a few characters: a token belongs to that question and to no other. */
const questionOf = (question: unknown): string => createHash("sha256").update(JSON.stringify(question)).digest("base64url").slice(0, 12);

/**
 * Cuts one page out of a sorted list. The token carries the sort key of the last item returned, so the next page
 * starts right after it even if items were added or removed in between. It also carries which question it
 * continues: the operation, its filters and whatever else decides what is listed. A token from another question,
 * or one that was made up, is refused; it would otherwise give some page of something, without a word.
 */
export function paginate<T, K>(
  sorted: T[],
  sortKey: (item: T) => K,
  compare: (a: K, b: K) => number,
  token: string | undefined,
  about: { question: unknown; isKey(key: unknown): key is K },
): Page<T> {
  const question = questionOf(about.question);
  const refuse = (why: string) => invalidInput(`The continuation token ${why}.`, ["Call again without a token to start from the first page."]);
  let start = 0;
  if (token !== undefined) {
    let read: { q?: unknown; k?: unknown };
    try {
      read = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { q?: unknown; k?: unknown };
    } catch {
      throw refuse("is not valid");
    }
    if (typeof read !== "object" || read === null || !about.isKey(read.k)) throw refuse("is not valid");
    if (read.q !== question) throw refuse("belongs to another list: the same operation and the same filters must be sent with it");
    const last = read.k;
    start = sorted.findIndex((item) => compare(sortKey(item), last) > 0);
    if (start < 0) start = sorted.length;
  }
  const items = sorted.slice(start, start + LIMITS.page);
  if (start + items.length >= sorted.length || items.length === 0) return { items };
  const next = Buffer.from(JSON.stringify({ q: question, k: sortKey(items[items.length - 1]!) }), "utf8").toString("base64url");
  return { items, continuation: next };
}

/** The sort key of the lists that are in the order of their IDs. */
export const isId = (key: unknown): key is string => typeof key === "string" && key.length > 0 && key.length <= 64;

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
