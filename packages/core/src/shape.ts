import { z } from "zod";
import { USERNAME, normalizeId, prefixProblem } from "./ids.js";
import { PROJECT_STATUSES, TASK_STATUSES, TASK_TYPES, USER_TYPES, type Kind, type Node } from "./model.js";

/**
 * What a stored item has to be for the engine to work with it: the fields it reads, of the kinds it reads them
 * as. Every change goes through an operation, which writes whole records, so an item that does not pass was
 * damaged outside the service: in the data file by hand, or in a backup. Nothing else is asked of an item here;
 * fields the engine does not know are left alone.
 */
/**
 * The rules the fields of a stored item are held to, each said once. The shapes below are made of them, and so
 * is what the command line expects of an answer (`expected.ts` in the command line): the service answers with
 * these fields as they are stored, so that what it may answer is what may be stored, and an answer is never held
 * to a narrower rule than the record it shows.
 */
/** A moment as the engine writes it, which is one it can read again: any text that names a moment. */
export const isMoment = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));
/** A user's ID, which is what "by whom" is stored as. */
export const isWho = (value: unknown): value is string => typeof value === "string" && /^USER-\d+$/.test(value);
/** A number: any that is one, whole or not, above nought or below. */
export const isStoredNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
/** Counted from 1: a change names the version it starts from, and none can name less. */
export const isVersion = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;
export const isUsername = (value: unknown): value is string => typeof value === "string" && USERNAME.test(value);
/** An ID in the one form its kind has: it is by that form that an item is found when it is asked for. */
export const isIdOfKind = (kind: Kind, value: unknown): value is string => typeof value === "string" && normalizeId(kind, value) === value;

const moment = z.custom<string>(isMoment, "not a moment in time");
const who = z.custom<string>(isWho, "not the ID of a user");
const number = z.custom<number>(isStoredNumber, "not a number");
/**
 * The statuses an item has had, the one it was created with first. Every change of status adds an entry, so there
 * is always one, each names a status of the item's kind, and the last is the status the item has: when a task
 * was completed is read from here.
 */
const timeline = (statuses: readonly [string, ...string[]]) => z.array(z.object({ status: z.enum(statuses), at: moment, by: who })).min(1, "empty");
const base = {
  id: z.string(),
  version: z.custom<number>(isVersion, "not a whole number from 1 up"),
  created_at: moment,
  created_by: who,
  updated_at: moment,
  // There, and either nothing or the moment of deletion: an item counts as live only when it says null. One
  // that lacks the field would be neither shown nor in anyone's way.
  deleted_at: moment.nullable(),
};
const SHAPES: Record<string, z.ZodType> = {
  // A prefix is put in front of the IDs of the tasks created in the project: one that could not be given to a
  // new project would make IDs that no task can be asked for by.
  project: z.object({ ...base, prefix: z.string().refine((value) => prefixProblem(value) === null, "not a prefix").nullable(), title: z.string(), status: z.enum(PROJECT_STATUSES), timeline: timeline(PROJECT_STATUSES) }),
  task: z.object({
    ...base,
    title: z.string(),
    type: z.enum(TASK_TYPES),
    status: z.enum(TASK_STATUSES),
    priority: number,
    value: number.nullable(),
    size: number.nullable(),
    why: z.string().nullable(),
    timeline: timeline(TASK_STATUSES),
  }),
  user: z.object({ ...base, username: z.custom<string>(isUsername, "not a username"), type: z.enum(USER_TYPES), built_in: z.boolean(), key_marks: z.array(z.string()).optional() }),
};

/** What is wrong with an item as a record, in a few words, or nothing: the first field that is not what it has to be. */
export function shapeProblem(node: Node): string | null {
  // Only a kind that is listed: "constructor" is a word a damaged record can have for its kind, and every object
  // answers to it with something that is no shape.
  const kind = (node as { kind: string }).kind;
  const shape = Object.hasOwn(SHAPES, kind) ? SHAPES[kind] : undefined;
  if (!shape) return "is of a kind that is not known";
  // An ID in the one form its kind has: it is by that form that an item is found when it is asked for.
  if (!isIdOfKind(kind as Kind, node.id)) return "has an ID that an item of its kind cannot have";
  const result = shape.safeParse(node);
  // A project with a prefix has the prefix for its ID, and one without has a number: the two are told apart by it.
  if (result.success && kind === "project") {
    const { prefix } = node as { prefix: string | null };
    if (prefix === null ? !/^\d+$/.test(node.id) : prefix !== node.id) return "has a prefix that does not go with its ID";
  }
  // The status an item has is the last its timeline tells of. A task that is done with no entry that says so
  // has no moment at which it was completed.
  if (result.success && kind !== "user") {
    const { status, timeline } = node as { status: string; timeline: Array<{ status: string }> };
    if (timeline.at(-1)!.status !== status) return `has the status ${status}, and its timeline ends with ${timeline.at(-1)!.status}`;
  }
  if (result.success) return null;
  const issue = result.error.issues[0]!;
  const field = issue.path.join(".");
  return field ? `${field} is not what it has to be (${issue.message.toLowerCase()})` : `is not a record (${issue.message.toLowerCase()})`;
}
