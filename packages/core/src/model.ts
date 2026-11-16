import { createHash } from "node:crypto";
import { KINDS } from "./ids.js";

export { KINDS };
export type Kind = (typeof KINDS)[number];

export const TASK_STATUSES = ["draft", "open", "in_progress", "paused", "in_review", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** What a task is: planned work, or one of three kinds of problem that should stand out from it. */
export const TASK_TYPES = ["task", "bug", "issue", "incident"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const PROJECT_STATUSES = ["open", "in_preview", "ready", "broken", "cancelled"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const USER_TYPES = ["admin", "person", "agent"] as const;
export type UserType = (typeof USER_TYPES)[number];

/** Which task statuses each status may move to. Anything absent is refused. */
export const TASK_MOVES: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ["open", "cancelled"],
  open: ["draft", "in_progress", "done", "cancelled"],
  in_progress: ["open", "paused", "in_review", "done", "cancelled"],
  paused: ["open", "in_progress", "cancelled"],
  in_review: ["in_progress", "done", "cancelled"],
  done: ["open"],
  cancelled: ["draft", "open"],
};

/** A task in one of these statuses no longer holds back what depends on it. */
export const TASK_FINISHED: readonly TaskStatus[] = ["done", "cancelled"];
/** A project in one of these statuses no longer holds back what depends on it. */
export const PROJECT_FINISHED: readonly ProjectStatus[] = ["ready", "cancelled"];
/** Statuses that claim the work is under way or complete, and so are suspect while a dependency is unfinished. */
export const TASK_ADVANCED: readonly TaskStatus[] = ["in_progress", "in_review", "done"];

export const LIMITS = {
  title: 500,
  text: 4000,
  why: 1000,
  username: 32,
  page: 100,
  /** How many of the items that are in the way a refusal names. */
  blocking: 20,
  linksPerCreate: 30,
} as const;

export const COUNTERS = {
  project: "project",
  task: "task",
  /** Shared by users, teams and services. */
  identity: "identity",
  /** Shared by facts, ideas and comments. */
  object: "object",
} as const;
export type CounterName = keyof typeof COUNTERS;

/**
 * A prefix whose project was deleted for good is kept beside the counters, under this word and the prefix, so
 * that no later project gets it: the IDs that were given out with it go on meaning what they meant. Like a
 * counter it only ever moves one way, it is stored in the same step as the delete, and it is in every backup.
 * No counter has a colon in its name.
 */
export const RETIRED_PREFIX = "prefix:";

export interface Ref {
  kind: Kind;
  id: string;
}

/**
 * One of the statuses an item has had: which, since when, and who gave it. Together they are the item's
 * timeline, the status it was created with first. The timeline is stored beside the item, an entry for each
 * change, and is not part of the item as the plan in memory has it: it is read when it is asked for.
 */
export interface StatusEntry {
  status: string;
  at: string;
  by: string;
}

interface BaseNode {
  id: string;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ProjectNode extends BaseNode {
  kind: "project";
  prefix: string | null;
  title: string;
  status: ProjectStatus;
}

export interface TaskNode extends BaseNode {
  kind: "task";
  title: string;
  type: TaskType;
  status: TaskStatus;
  priority: number;
  value: number | null;
  size: number | null;
  /** Why the work matters: at least one reason, more if there are several. Optional. */
  why: string | null;
  /**
   * When the task was completed, for a task that is done: the moment of the last entry of its timeline. Null
   * for every other task. It is kept with the task because every list of tasks shows it, and the timeline is
   * not read for a list.
   */
  completed_at: string | null;
}

export interface UserNode extends BaseNode {
  kind: "user";
  username: string;
  type: UserType;
  built_in: boolean;
  /**
   * Marks of the keys that were made for this user: the one issued last, and beside it that of the key that
   * was stored for the user when the last one was issued, which goes on counting when the last one could not be
   * stored. A key that the key store has under this user's name counts
   * only if its mark is here, so a key left over from an earlier user of the same name never does. An empty
   * list is a user no key counts for, as after a restore. Built-in users and users from before marks were kept
   * have none, and any key stored for them counts: their names cannot pass to someone else unnoticed.
   */
  key_marks?: string[];
}

/** Whether what is stored as a user's key marks is what it has to be: nothing at all, or a list of marks. */
export const areKeyMarks = (value: unknown): value is string[] | undefined => value === undefined || (Array.isArray(value) && value.every((mark) => typeof mark === "string"));

/** What is kept of a key with its user: enough to know the key again, not enough to make it. */
export const keyMark = (key: string): string => createHash("sha256").update(key).digest("base64url");

export type Node = ProjectNode | TaskNode | UserNode;
export type NodeOf<K extends Kind> = Extract<Node, { kind: K }>;

export interface Link {
  from: Ref;
  type: string;
  to: Ref;
  created_at: string;
  created_by: string;
}

export const BUILT_IN_USERS: ReadonlyArray<{ username: string; type: UserType }> = [
  { username: "admin", type: "admin" },
  { username: "user", type: "person" },
  { username: "agent1", type: "agent" },
];
