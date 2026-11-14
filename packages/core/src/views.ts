import { containers, dependencies, groupProgress, projectCalc, taskCalc, type Problem, type Known } from "./calc.js";
import type { GraphView } from "./graph.js";
import { refText } from "./ids.js";
import { LINK_TYPES } from "./link-types.js";
import type { Node, ProjectNode, StatusEntry, TaskNode, UserNode } from "./model.js";
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

export type Detail = Summary & {
  description?: string;
  /** Why the work matters. Tasks only; null when nobody has said. */
  why?: string | null;
  /** Links in both directions, keyed by the name that reads correctly from this item. */
  links: Record<string, LinkedItem[]>;
  timeline?: Array<StatusEntry & { by: string }>;
  created_at: string;
  created_by: string;
  updated_at: string;
  /** Every recorded change, oldest first. Only when asked for. */
  history?: HistoryItem[];
};

const problemViews = (problems: Problem[]): ProblemView[] => problems.map(({ code, message }) => ({ code, message }));

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
    contained_in: containers(graph, task).map(refText),
    depends_on: dependencies(graph, task).map(refText),
    assigned_to: calc.assigned_to.map((u) => u.username),
    is_assigned: calc.is_assigned,
    is_next: calc.is_next,
    is_waiting: calc.is_waiting,
    waiting_for: calc.waiting_for.map(refText),
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

function linkedItem(node: Node): LinkedItem {
  const base = node.kind === "user" ? { kind: node.kind, id: node.id, title: node.username } : { kind: node.kind, id: refText(node), title: node.title, status: node.status };
  return node.deleted_at ? { ...base, deleted: true } : base;
}

const username = (graph: GraphView, id: string): string => graph.get("user", id)?.username ?? id;

export function detail(graph: GraphView, node: Node, text: string | null): Detail {
  const links: Record<string, LinkedItem[]> = {};
  for (const linkType of LINK_TYPES) {
    const forward = graph.out(node, linkType.type).flatMap((l) => graph.node(l.to) ?? []);
    const backward = graph.in(node, linkType.type).flatMap((l) => graph.node(l.from) ?? []);
    if (forward.length) links[linkType.type] = forward.map(linkedItem);
    if (backward.length) links[linkType.reverse] = backward.map(linkedItem);
  }
  return {
    ...summary(graph, node),
    ...(node.kind === "user" ? {} : { description: text ?? "" }),
    ...(node.kind === "task" ? { why: node.why } : {}),
    links,
    ...(node.kind === "user" ? {} : { timeline: node.timeline.map((e) => ({ ...e, by: username(graph, e.by) })) }),
    created_at: node.created_at,
    created_by: username(graph, node.created_by),
    updated_at: node.updated_at,
  };
}
