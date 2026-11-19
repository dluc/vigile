import type { Kind, Ref } from "./model.js";

/**
 * This file uses nothing but the language, and is handed to the browser as it is compiled, beside `paging.ts`:
 * the page puts IDs in order by these rules and by none of its own.
 */

/** The kinds of item there are. */
export const KINDS = ["project", "task", "user", "decision"] as const;

/** Words that introduce a kind of object in an ID, and so can never be a project prefix. */
export const RESERVED_PREFIXES = ["USER", "TEAM", "SVC", "OBJ", "COMMENT"] as const;

const PREFIX = /^[A-Z]{2,8}$/;
const DIGITS = /^\d+$/;
const TASK_ID = /^(?:([A-Z]{2,8})-)?(\d+)$/;
const USER_ID = /^USER-(\d+)$/;
export const USERNAME = /^[a-z][a-z0-9_-]{0,31}$/;

/** Numbers in IDs have at least three digits. */
export const formatNumber = (n: number): string => String(n).padStart(3, "0");

export const userId = (n: number): string => `USER-${formatNumber(n)}`;

/** The number behind `USER-003`; only the number is stored. */
export function userNumber(id: string): number {
  const m = USER_ID.exec(id);
  if (!m) throw new Error(`Not a user ID: ${id}`);
  return Number(m[1]);
}

export const taskId = (prefix: string | null, n: number): string => (prefix ? `${prefix}-${formatNumber(n)}` : formatNumber(n));

export function taskPrefix(id: string): string | null {
  return TASK_ID.exec(id)?.[1] ?? null;
}

/** Why a prefix is not acceptable, or `null` when it is. */
export function prefixProblem(prefix: string): string | null {
  if (!PREFIX.test(prefix)) return "A prefix has 2 to 8 letters and nothing else.";
  if ((RESERVED_PREFIXES as readonly string[]).includes(prefix)) {
    return `${prefix} is reserved. Reserved words: ${RESERVED_PREFIXES.join(", ")}.`;
  }
  return null;
}

/** The stored form of an ID as a client typed it, or `null` when it cannot be an ID of that kind. */
export function normalizeId(kind: Kind, input: string): string | null {
  const text = input.trim().toUpperCase();
  switch (kind) {
    case "project":
      if (PREFIX.test(text)) return text;
      return DIGITS.test(text) ? formatNumber(Number(text)) : null;
    case "decision":
    case "task": {
      const m = TASK_ID.exec(text);
      return m ? taskId(m[1] ?? null, Number(m[2])) : null;
    }
    case "user": {
      const m = USER_ID.exec(text);
      return m ? userId(Number(m[1])) : null;
    }
  }
}

/** Splits `task:042` into its kind and the rest. A bare reference has no kind. */
export function splitRef(input: string): { kind: Kind | null; rest: string } {
  const m = /^(project|task|user|decision):(.*)$/i.exec(input.trim());
  return m ? { kind: m[1]!.toLowerCase() as Kind, rest: m[2]! } : { kind: null, rest: input.trim() };
}

/**
 * How a reference is written for a reader. A project numbered `042` is written `project:042`,
 * because a task can carry the same bare number.
 */
export function refText(ref: Ref): string {
  return ref.kind === "project" && DIGITS.test(ref.id) ? `project:${ref.id}` : ref.id;
}

/**
 * The ID of an item whose reference is written as `refText` writes it: the way back, digit for digit. A
 * project that is written `project:042` has the ID `042`; anything else is written as its ID. Two projects
 * that damage left with the IDs `042` and `project:042` are written alike, and are one to whoever reads them.
 */
export function refId(kind: string, text: string): string {
  return kind === "project" && /^project:\d+$/.test(text) ? text.slice("project:".length) : text;
}

/**
 * Compares two whole numbers as they are written in digits, exactly and however long they are. The number in
 * an ID is compared this way and never as a JavaScript number, which cannot tell 9007199254740993 from
 * 9007199254740992. No digits at all come before any number.
 */
export function compareNumerals(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, "");
  const y = b.replace(/^0+(?=\d)/, "");
  return x.length - y.length || byText(x, y);
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The prefix and the number of a task's ID, the number as its digits. An ID that is none of a task is all prefix. */
function taskParts(id: string): [prefix: string, digits: string] {
  const m = TASK_ID.exec(id);
  return m ? [m[1] ?? "", m[2]!] : [id, ""];
}

/** Where an item stands among all items: by kind, then as the IDs of its kind are ordered, then by the ID as it is written. */
export type Place = readonly [kind: number, prefix: string, digits: string, id: string];

/**
 * An item's place, worked out once for each item: a list of thousands is then put in order by comparing
 * places, without reading each ID again for every comparison. Projects come first, in the order of
 * `compareProjectIds`, then tasks in that of `compareTaskIds`, then users in that of `compareUserIds`. An ID
 * that is not one of its kind, in data that was damaged, has a place too, and no two IDs have the same.
 */
export function placeOf(ref: Ref): Place {
  if (ref.kind === "project") return DIGITS.test(ref.id) ? [0, "\uFFFF", ref.id, ref.id] : [0, ref.id, "", ref.id];
  if (ref.kind === "task") return [1, ...taskParts(ref.id), ref.id];
  if (ref.kind === "decision") return [3, ...taskParts(ref.id), ref.id];
  return [2, "", /(\d+)$/.exec(ref.id)?.[1] ?? "", ref.id];
}

export const comparePlaces = (a: Place, b: Place): number => a[0] - b[0] || byText(a[1], b[1]) || compareNumerals(a[2], b[2]) || byText(a[3], b[3]);

/**
 * Orders task IDs by prefix, then by number. Two IDs are in the same place only when they are the same: two
 * that say the same number in another way, as damage leaves them, follow each other as they are written, so
 * that a list in this order can be gone through a page at a time and none is passed over.
 */
export function compareTaskIds(a: string, b: string): number {
  const [pa, na] = taskParts(a);
  const [pb, nb] = taskParts(b);
  return byText(pa, pb) || compareNumerals(na, nb) || byText(a, b);
}

/** Orders project IDs: prefixes alphabetically, then numbered projects by number. No two IDs are in the same place. */
export function compareProjectIds(a: string, b: string): number {
  const da = DIGITS.test(a);
  const db = DIGITS.test(b);
  if (da && db) return compareNumerals(a, b) || byText(a, b);
  if (da !== db) return da ? 1 : -1;
  return byText(a, b);
}

/** Orders user IDs by number. An ID that is none of a user, in data that was damaged, has a place too, and no two IDs have the same. */
export function compareUserIds(a: string, b: string): number {
  return compareNumerals(/(\d+)$/.exec(a)?.[1] ?? "", /(\d+)$/.exec(b)?.[1] ?? "") || byText(a, b);
}
