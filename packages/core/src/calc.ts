import type { GraphView } from "./graph.js";
import { comparePlaces, placeOf, refText } from "./ids.js";
import { ASSIGNED_TO, CONTAINS, DEPENDS_ON } from "./link-types.js";
import {
  PROJECT_FINISHED,
  TASK_ADVANCED,
  TASK_FINISHED,
  type Node,
  type ProjectNode,
  type Ref,
  type TaskNode,
  type UserNode,
} from "./model.js";

/** Everything here is worked out from the graph on each read and never stored. */

export interface Problem {
  code: string;
  message: string;
  items: Ref[];
}

export interface TaskCalc {
  is_waiting: boolean;
  waiting_for: Array<TaskNode | ProjectNode>;
  is_next: boolean;
  is_assigned: boolean;
  assigned_to: UserNode[];
  has_problems: boolean;
  problems: Problem[];
  completed_at: string | null;
}

/** How far along a task that contains others is: finished tasks out of all it contains, at any depth. */
export function groupProgress(graph: GraphView, task: TaskNode): { finished: number; total: number } | null {
  const inside = containedTasks(graph, task);
  if (!inside.length) return null;
  return { finished: inside.filter((t) => TASK_FINISHED.includes(t.status)).length, total: inside.length };
}

/** Whether a task sits inside another task, as opposed to directly in a project or nowhere. */
export const hasParentTask = (graph: GraphView, task: TaskNode): boolean => containers(graph, task).some((c) => c.kind === "task" && isLive(c));

export interface ProjectCalc {
  progress: { finished: number; total: number };
  has_problems: boolean;
  problems: Problem[];
}

export const isLive = (node: Node): boolean => node.deleted_at === null;

/** Whether an item has stopped holding back what depends on it. A soft-deleted item does not block. */
export function isFinished(node: TaskNode | ProjectNode): boolean {
  if (!isLive(node)) return true;
  return node.kind === "task" ? TASK_FINISHED.includes(node.status) : PROJECT_FINISHED.includes(node.status);
}

export function dependencies(graph: GraphView, task: TaskNode): Array<TaskNode | ProjectNode> {
  const found: Array<TaskNode | ProjectNode> = [];
  for (const link of graph.out(task, DEPENDS_ON)) {
    const target = graph.node(link.to);
    if (target && target.kind !== "user") found.push(target);
  }
  return found;
}

export const unfinishedDependencies = (graph: GraphView, task: TaskNode) => dependencies(graph, task).filter((d) => !isFinished(d));

/** The live tasks a container holds: directly, or at any depth. */
export function containedTasks(graph: GraphView, container: ProjectNode | TaskNode, deep = true): TaskNode[] {
  const seen = new Set<string>();
  const found: TaskNode[] = [];
  const queue: Ref[] = [container];
  for (let next = 0; next < queue.length; next++) {
    const current = queue[next]!;
    for (const link of graph.out(current, CONTAINS)) {
      if (seen.has(link.to.id)) continue;
      seen.add(link.to.id);
      const task = graph.get("task", link.to.id);
      if (!task) continue;
      if (isLive(task)) found.push(task);
      if (deep) queue.push(task);
    }
  }
  return found;
}

export function containers(graph: GraphView, task: TaskNode): Array<ProjectNode | TaskNode> {
  const found: Array<ProjectNode | TaskNode> = [];
  for (const link of graph.in(task, CONTAINS)) {
    const node = graph.node(link.from);
    if (node && node.kind !== "user") found.push(node);
  }
  return found;
}

export function assignees(graph: GraphView, task: TaskNode): UserNode[] {
  const found: UserNode[] = [];
  for (const link of graph.out(task, ASSIGNED_TO)) {
    const user = graph.get("user", link.to.id);
    if (user && isLive(user)) found.push(user);
  }
  return found;
}

/** Stable in every store and after every reload: insertion order is not part of an answer. */
const ordered = <T extends Ref>(items: T[]): T[] => [...items].sort((a, b) => comparePlaces(placeOf(a), placeOf(b)));

/** The first few of the items a problem is about, by name: a problem says that there are more, not which. */
const names = (items: Ref[]) => `${items.slice(0, 10).map(refText).join(", ")}${items.length > 10 ? ", …" : ""}`;
/** The same, with how many there are in all, for a message that does not say so itself. */
const namesOfAll = (items: Ref[]) => `${names(items)}${items.length > 10 ? ` (${items.length} in all)` : ""}`;

/**
 * What one reading of the plan has found out so far about which tasks hold unfinished work. A reading that goes
 * through many tasks, as a project's problems or a list does, hands the same one to each: a group is then gone
 * into once, where every task above it asking for itself would go into it again. It lives for that one reading
 * and is never stored: the plan may be another one by the next.
 */
export type Known = Map<string, boolean>;

/**
 * Whether a task holds, at any depth, a task that is not finished. It stops at the first one it finds, remembers
 * in `known` what it learns about every task on the way, and goes by steps of its own and not by calling itself,
 * so that groups nested thousands deep are no trouble.
 */
export function hasUnfinishedInside(graph: GraphView, task: TaskNode, known: Known = new Map()): boolean {
  const before = known.get(task.id);
  if (before !== undefined) return before;
  const inside = (group: TaskNode): TaskNode[] => graph.out(group, CONTAINS).flatMap((link) => graph.get("task", link.to.id) ?? []);
  const way = [{ task, inside: inside(task), next: 0, found: false }];
  const onWay = new Set([task.id]);
  while (way.length) {
    const step = way.at(-1)!;
    if (step.found || step.next >= step.inside.length) {
      known.set(step.task.id, step.found);
      onWay.delete(step.task.id);
      way.pop();
      if (step.found && way.length) way.at(-1)!.found = true;
      continue;
    }
    const child = step.inside[step.next++]!;
    if (isLive(child) && !TASK_FINISHED.includes(child.status)) {
      step.found = true;
      continue;
    }
    const learnt = known.get(child.id);
    if (learnt !== undefined) step.found = learnt;
    // A task already on the way would be a loop, which the rules do not let be made: it is not gone into twice.
    else if (!onWay.has(child.id)) {
      onWay.add(child.id);
      way.push({ task: child, inside: inside(child), next: 0, found: false });
    }
  }
  return known.get(task.id) ?? false;
}

/**
 * One kind of problem a task can have, in two parts. A list that is filtered by problems, and a project that
 * says which of its tasks have some, ask every task whether it has one, and must not pay for the answer in
 * full each time: that is for the tasks that are returned.
 */
interface TaskCheck {
  /** Whether the task has the problem. Cheap, and what it learns about groups on the way is kept in `known`. */
  has(graph: GraphView, task: TaskNode, known: Known): boolean;
  /** The problem in words, with the items it is about. Asked only of a task that has it. */
  describe(graph: GraphView, task: TaskNode): Problem;
}

/** Each check is independent. A new kind of problem is a new entry, with no change to the others. */
const TASK_CHECKS: TaskCheck[] = [
  {
    has: (graph, task) => TASK_ADVANCED.includes(task.status) && unfinishedDependencies(graph, task).length > 0,
    describe: (graph, task) => {
      const open = ordered(unfinishedDependencies(graph, task));
      return {
        code: "unfinished_dependency",
        message: `Status is ${task.status}, but it depends on work that is not finished: ${namesOfAll(open)}.`,
        items: open.map(toRef),
      };
    },
  },
  {
    // Refused at the moment a group is marked done, but it can come about afterwards: a task inside is
    // reopened or restored, or one is put into the group. Whether a group holds unfinished work is found out
    // once for each group in one reading of the plan; which tasks they are is gathered only to say so.
    has: (graph, task, known) => task.status === "done" && hasUnfinishedInside(graph, task, known),
    describe: (graph, task) => {
      const open = ordered(containedTasks(graph, task).filter((t) => !TASK_FINISHED.includes(t.status)));
      return {
        code: "done_with_unfinished_contents",
        message: `Status is done, but ${open.length} of the tasks it contains ${open.length === 1 ? "is" : "are"} not finished: ${names(open)}.`,
        items: open.map(toRef),
      };
    },
  },
  {
    has: (graph, task) => !TASK_FINISHED.includes(task.status) && brokenProjects(graph, task).length > 0,
    describe: (graph, task) => {
      const broken = ordered(brokenProjects(graph, task));
      return { code: "depends_on_broken_project", message: `Depends on a broken project: ${namesOfAll(broken)}.`, items: broken.map(toRef) };
    },
  },
];

const brokenProjects = (graph: GraphView, task: TaskNode): Node[] => dependencies(graph, task).filter((d) => d.kind === "project" && isLive(d) && d.status === "broken");

const toRef = (node: Node): Ref => ({ kind: node.kind, id: node.id });

/** Whether a task has a problem of any kind, without putting any of them into words. */
export function taskHasProblems(graph: GraphView, task: TaskNode, known: Known = new Map()): boolean {
  return isLive(task) && TASK_CHECKS.some((check) => check.has(graph, task, known));
}

/** A task's problems in full. For the tasks that are shown: a list that only asks whether there are any uses `taskHasProblems`. */
export function taskProblems(graph: GraphView, task: TaskNode, known: Known = new Map()): Problem[] {
  if (!isLive(task)) return [];
  return TASK_CHECKS.filter((check) => check.has(graph, task, known)).map((check) => check.describe(graph, task));
}

export function taskCalc(graph: GraphView, task: TaskNode, known: Known = new Map()): TaskCalc {
  const live = isLive(task);
  const waitingFor = live && !TASK_FINISHED.includes(task.status) ? unfinishedDependencies(graph, task) : [];
  const assigned = assignees(graph, task);
  let problems: Problem[] | undefined;
  let completedAt: string | null = null;
  if (task.status === "done") {
    for (const entry of task.timeline) if (entry.status === "done") completedAt = entry.at;
  }
  return {
    is_waiting: waitingFor.length > 0,
    waiting_for: waitingFor,
    is_next: live && task.status === "open" && waitingFor.length === 0,
    is_assigned: assigned.length > 0,
    assigned_to: assigned,
    has_problems: taskHasProblems(graph, task, known),
    // Put into words when they are read, which is for the tasks that are returned: a list goes through many
    // more than it returns, and asks each only whether it has any.
    get problems() {
      return (problems ??= taskProblems(graph, task, known));
    },
    completed_at: completedAt,
  };
}

export function projectCalc(graph: GraphView, project: ProjectNode, known: Known = new Map()): ProjectCalc {
  const tasks = containedTasks(graph, project);
  const finished = tasks.filter((t) => TASK_FINISHED.includes(t.status));
  const problems: Problem[] = [];
  if (isLive(project)) {
    if (project.status === "broken") {
      problems.push({ code: "project_broken", message: "The project is marked broken.", items: [] });
    }
    const open = ordered(tasks.filter((t) => !TASK_FINISHED.includes(t.status)));
    if (project.status === "ready" && open.length) {
      problems.push({
        code: "ready_with_unfinished_tasks",
        message: `The project is marked ready, but ${open.length} of its tasks are not finished: ${names(open)}.`,
        items: open.map(toRef),
      });
    }
    const troubled = ordered(tasks.filter((t) => taskHasProblems(graph, t, known)));
    if (troubled.length) {
      problems.push({
        code: "contains_task_with_problems",
        message: `Contains tasks that have problems: ${names(troubled)}.`,
        items: troubled.map(toRef),
      });
    }
  }
  return { progress: { finished: finished.length, total: tasks.length }, has_problems: problems.length > 0, problems };
}
