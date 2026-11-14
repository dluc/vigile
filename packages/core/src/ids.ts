import type { Kind, Ref } from "./model.js";

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
  const m = /^(project|task|user):(.*)$/i.exec(input.trim());
  return m ? { kind: m[1]!.toLowerCase() as Kind, rest: m[2]! } : { kind: null, rest: input.trim() };
}

/**
 * How a reference is written for a reader. A project numbered `042` is written `project:042`,
 * because a task can carry the same bare number.
 */
export function refText(ref: Ref): string {
  return ref.kind === "project" && DIGITS.test(ref.id) ? `project:${ref.id}` : ref.id;
}

function taskParts(id: string): [string, number] {
  const m = TASK_ID.exec(id);
  return m ? [m[1] ?? "", Number(m[2])] : [id, 0];
}

/** Orders task IDs by prefix, then by number. */
export function compareTaskIds(a: string, b: string): number {
  const [pa, na] = taskParts(a);
  const [pb, nb] = taskParts(b);
  return pa < pb ? -1 : pa > pb ? 1 : na - nb;
}

/** Orders project IDs: prefixes alphabetically, then numbered projects by number. */
export function compareProjectIds(a: string, b: string): number {
  const da = DIGITS.test(a);
  const db = DIGITS.test(b);
  if (da && db) return Number(a) - Number(b);
  if (da !== db) return da ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}
