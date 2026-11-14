import { containers, dependencies, groupProgress, projectCalc, taskCalc, type Problem, type Known } from "./calc.js";
import type { GraphView } from "./graph.js";
import { comparePlaces, placeOf, refText } from "./ids.js";
import { LIMITS, type Node, type ProjectNode, type StatusEntry, type TaskNode, type UserNode } from "./model.js";
import type { HistoryItem } from "./operation.js";

/** How items are shown to clients. Summaries are compact, for lists; details add text, links and timeline. */

export interface ProblemView {
  code: string;
  message: string;
}

export interface TaskSummary {
  kind: "task";
  id: string;
  title: string;
  /** task, bug, issue or incident. */
  type: string;
  status: string;
  priority: number;
  value: number | null;
  size: number | null;
  version: number;
  contained_in: string[];
  depends_on: string[];
  assigned_to: string[];
  is_assigned: boolean;
  is_next: boolean;
  is_waiting: boolean;
  waiting_for: string[];
  has_problems: boolean;
  problems?: ProblemView[];
  /** Only for a task that contains others: how many of them are finished, at any depth. */
  progress?: { finished: number; total: number };
  completed_at?: string;
  deleted_at?: string;
}

export interface ProjectSummary {
  kind: "project";
  id: string;
  title: string;
  status: string;
  version: number;
  progress: { finished: number; total: number };
  has_problems: boolean;
  problems?: ProblemView[];
  deleted_at?: string;
}

export interface UserView {
  kind: "user";
  id: string;
  username: string;
  type: string;
  built_in: boolean;
  version: number;
  deleted_at?: string;
}

export type Summary = TaskSummary | ProjectSummary | UserView;

export interface LinkedItem {
  kind: string;
  id: string;
  title: string;
  status?: string;
  deleted?: true;
}

/** A list that is not returned whole: how many entries it has, and the token that continues it where it can be continued. */
export interface More {
  total: number;
  continuation?: string;
}

/** The lists of a task's summary: one for each kind of link it has, and what it waits for. */
const SUMMARY_LISTS = ["contained_in", "depends_on", "assigned_to", "waiting_for"] as const;

/** Which lists of an item were cut at the page size. A list that is returned whole is not named here. */
export type MoreLists = Partial<Record<(typeof SUMMARY_LISTS)[number] | "timeline" | "history", More>> & {
  /** By the name the list has in `links`. */
  links?: Record<string, More>;
};

export type Detail = Summary & {
  description?: string;
  /** Why the work matters. Tasks only; null when nobody has said. */
  why?: string | null;
  /** Links in both directions, keyed by the name that reads correctly from this item. At most a page of each, in the order of the IDs. */
  links: Record<string, LinkedItem[]>;
  /** The latest statuses the item went through, at most a page of them, oldest first. */
  timeline?: Array<StatusEntry & { by: string; place: number }>;
  created_at: string;
  created_by: string;
  updated_at: string;
  /**
   * The revision of the plan since which nothing in this answer has changed: the item, its lists, and what they
   * show of other items and of users. Two answers about the item that say the same show nothing that differs,
   * so pages of its lists belong together when they say the same. See `Unchanged`.
   */
  unchanged_since: number;
  /** The latest recorded changes, at most a page of them, oldest first. Only when asked for. */
  history?: Array<HistoryItem & { place: readonly [revision: number, seq: number] }>;
  more?: MoreLists;
};

const problemViews = (problems: Problem[]): ProblemView[] => problems.map(({ code, message }) => ({ code, message }));
/** Stable in every store and after every reload: insertion order is not part of an answer. */
const orderedNodes = <T extends Node>(values: T[]): T[] => values.sort((a, b) => comparePlaces(placeOf(a), placeOf(b)));

export function taskSummary(graph: GraphView, task: TaskNode, known?: Known): TaskSummary {
  const calc = taskCalc(graph, task, known);
  const progress = groupProgress(graph, task);
  return {
    kind: "task",
    id: task.id,
    title: task.title,
    type: task.type,
    status: task.status,
    priority: task.priority,
    value: task.value,
    size: task.size,
    version: task.version,
    contained_in: orderedNodes(containers(graph, task)).map(refText),
    depends_on: orderedNodes(dependencies(graph, task)).map(refText),
    assigned_to: orderedNodes(calc.assigned_to).map((u) => u.username),
    is_assigned: calc.is_assigned,
    is_next: calc.is_next,
    is_waiting: calc.is_waiting,
    waiting_for: orderedNodes(calc.waiting_for).map(refText),
    has_problems: calc.has_problems,
    ...(calc.has_problems ? { problems: problemViews(calc.problems) } : {}),
    ...(progress ? { progress } : {}),
    ...(calc.completed_at ? { completed_at: calc.completed_at } : {}),
    ...(task.deleted_at ? { deleted_at: task.deleted_at } : {}),
  };
}

export function projectSummary(graph: GraphView, project: ProjectNode, known?: Known): ProjectSummary {
  const calc = projectCalc(graph, project, known);
  return {
    kind: "project",
    id: project.id,
    title: project.title,
    status: project.status,
    version: project.version,
    progress: calc.progress,
    has_problems: calc.has_problems,
    ...(calc.has_problems ? { problems: problemViews(calc.problems) } : {}),
    ...(project.deleted_at ? { deleted_at: project.deleted_at } : {}),
  };
}

export function userView(user: UserNode): UserView {
  return {
    kind: "user",
    id: user.id,
    username: user.username,
    type: user.type,
    built_in: user.built_in,
    version: user.version,
    ...(user.deleted_at ? { deleted_at: user.deleted_at } : {}),
  };
}

export function summary(graph: GraphView, node: Node): Summary {
  switch (node.kind) {
    case "task":
      return taskSummary(graph, node);
    case "project":
      return projectSummary(graph, node);
    case "user":
      return userView(node);
  }
}

export function linkedItem(node: Node): LinkedItem {
  const base = node.kind === "user" ? { kind: node.kind, id: node.id, title: node.username } : { kind: node.kind, id: refText(node), title: node.title, status: node.status };
  return node.deleted_at ? { ...base, deleted: true } : base;
}

export const username = (graph: GraphView, id: string): string => graph.get("user", id)?.username ?? id;

/**
 * A summary as it is returned for one item by itself, in full or as what the item is now in a refusal: each of
 * its lists is cut at the page size, and `more` says how many a cut list has. In a list of tasks the summaries
 * are whole: whoever draws the plan from a list needs every link of every task in it.
 */
export function shortened<S extends Summary>(item: S): S & { more?: MoreLists } {
  const cut: Record<string, unknown> = {};
  const more: MoreLists = {};
  for (const name of SUMMARY_LISTS) {
    const list: unknown = name in item ? item[name as keyof S] : undefined;
    if (!Array.isArray(list) || list.length <= LIMITS.page) continue;
    cut[name] = list.slice(0, LIMITS.page);
    more[name] = { total: list.length };
  }
  return Object.keys(more).length ? { ...item, ...cut, more } : item;
}

/** An item in full. Its lists are handed in, a page of each, with what says that there is more of one. */
export function detail(graph: GraphView, node: Node, text: string | null, lists: Pick<Detail, "links" | "timeline" | "history" | "more" | "unchanged_since">): Detail {
  const item = shortened(summary(graph, node));
  const more: MoreLists = { ...item.more, ...lists.more };
  return {
    ...item,
    ...(node.kind === "user" ? {} : { description: text ?? "" }),
    ...(node.kind === "task" ? { why: node.why } : {}),
    links: lists.links,
    ...(lists.timeline ? { timeline: lists.timeline } : {}),
    created_at: node.created_at,
    created_by: username(graph, node.created_by),
    updated_at: node.updated_at,
    unchanged_since: lists.unchanged_since,
    ...(lists.history ? { history: lists.history } : {}),
    ...(Object.keys(more).length ? { more } : {}),
  };
}
