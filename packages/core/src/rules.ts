import { assignees, containedTasks, isLive, unfinishedDependencies } from "./calc.js";
import { VigileError, echo, invalidInput, notFound, refused, type ErrorDetails, type ErrorItem } from "./errors.js";
import { sameRef, type GraphView } from "./graph.js";
import { normalizeId, refText, splitRef } from "./ids.js";
import { ASSIGNED_TO, CONTAINS, DEPENDS_ON, type LinkType } from "./link-types.js";
import { LIMITS, TASK_FINISHED, TASK_MOVES, type Kind, type Node, type NodeOf, type Ref, type TaskNode, type TaskStatus, type UserNode } from "./model.js";
import { shortened, type Summary } from "./views.js";

export function errorItem(node: Node): ErrorItem {
  if (node.kind === "user") return { kind: "user", id: node.id, title: node.username };
  return { kind: node.kind, id: node.id, title: node.title, status: node.status };
}

/**
 * What is in the way, as a refusal names it: the first few, and how many there are in all when those are not
 * every one. A refusal says what to do next; it is not the place to read a list of any length.
 */
export function blockedBy(nodes: Node[]): Pick<ErrorDetails, "blocking" | "blocking_total"> {
  if (nodes.length <= LIMITS.blocking) return { blocking: nodes.map(errorItem) };
  return { blocking: nodes.slice(0, LIMITS.blocking).map(errorItem), blocking_total: nodes.length };
}

/** How many steps of a path a message shows at each of its ends, when the path is too long to show whole. */
const PATH_ENDS = 5;

/** A path as a message shows it: whole when it is short, and otherwise its two ends and how many steps lie between. */
export function pathText(path: Ref[]): string {
  const steps = path.map(refText);
  if (steps.length <= 2 * PATH_ENDS + 1) return steps.join(" → ");
  return [...steps.slice(0, PATH_ENDS), `… ${steps.length - 2 * PATH_ENDS} more …`, ...steps.slice(-PATH_ENDS)].join(" → ");
}

/**
 * Finds the item a client means. A reference is an ID, a username, or either with its kind in front
 * (`task:042`) when a bare number could be a project or a task.
 */
export function resolveRef<K extends Kind>(graph: GraphView, input: string, kinds: readonly K[]): NodeOf<K> {
  const { kind: stated, rest } = splitRef(input);
  if (stated && !(kinds as readonly Kind[]).includes(stated)) {
    throw invalidInput(`"${echo(input)}" is a ${stated}, but a ${list(kinds)} is expected here.`);
  }
  const candidates = stated ? [stated] : kinds;
  const found: Node[] = [];
  for (const kind of candidates) {
    const id = normalizeId(kind, rest);
    const node = id ? graph.get(kind, id) : undefined;
    if (node) found.push(node);
    else if (kind === "user") {
      const user = graph.userByName(rest.toLowerCase());
      if (user) found.push(user);
    }
  }
  if (found.length === 1) return found[0] as NodeOf<K>;
  if (found.length > 1) {
    throw invalidInput(`"${echo(input)}" matches more than one item: ${found.map((n) => `${n.kind}:${n.id}`).join(", ")}.`, [
      `Put the kind in front, as in "${found[0]!.kind}:${found[0]!.id}".`,
    ]);
  }
  const onlyUsers = candidates.length === 1 && candidates[0] === "user";
  throw notFound(`No ${list(candidates)} matches "${echo(input)}".`, [
    onlyUsers ? "Call list_users to see the users." : "Call list_projects or list_tasks to see what exists.",
  ]);
}

/** "project, task or user" */
const list = (words: readonly string[]): string => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`);

export function requireLive(node: Node): void {
  if (isLive(node)) return;
  throw refused("deleted", `${describe(node)} is deleted and cannot be changed.`, {
    blocking: [errorItem(node)],
    actions: [`Call restore with kind "${node.kind}" and id "${node.id}" to bring it back.`],
  });
}

/** Optimistic concurrency: the change is made only if the client saw the latest version. */
export function requireVersion(node: Node, version: number, current: () => Summary): void {
  if (node.version === version) return;
  throw new VigileError(
    "version_conflict",
    `${describe(node)} changed since you read it: it is at version ${node.version}, you sent ${version}.`,
    { current: shortened(current()), actions: ["Check the current item, then repeat the call with its version."] },
  );
}

export const describe = (node: Node): string =>
  node.kind === "user" ? `User ${node.username}` : `${node.kind === "task" ? "Task" : "Project"} ${refText(node)}`;

/** Refuses putting work behind a completed task container; reopening stored status must be an explicit change. */
export function checkContainerAcceptsWork(graph: GraphView, holder: Node): void {
  if (holder.kind !== "task") return;
  const completed: TaskNode[] = [];
  const seen = new Set<string>();
  const queue: TaskNode[] = [holder];
  for (let next = 0; next < queue.length; next++) {
    const current = queue[next]!;
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    if (current.status === "done" && isLive(current)) completed.push(current);
    for (const link of graph.in(current, CONTAINS)) {
      const parent = graph.node(link.from);
      // Deleted groups are transparent to containment: walk through them to the live ancestors above.
      if (parent?.kind === "task") queue.push(parent);
    }
  }
  if (!completed.length) return;
  const first = completed[0]!;
  throw refused("completed_container", `${describe(holder)} cannot receive work because ${completed.length === 1 ? describe(first) : `${completed.length} task containers on its path`} ${completed.length === 1 ? "is" : "are"} done.`, {
    ...blockedBy(completed),
    actions: [`Reopen ${describe(first)} first: call set_task_status with id "${refText(first)}", version ${first.version} and status "open".`],
  });
}

/** Refuses a status change the rules do not allow, saying what is in the way and what can be done. */
export function checkTaskMove(graph: GraphView, task: TaskNode, to: TaskStatus, caller?: UserNode): void {
  if (task.status === to) {
    throw refused("same_status", `${describe(task)} is already ${to}.`, {
      actions: to === "in_progress" ? ["Someone is already working on it. Call list_next_tasks to pick other work."] : undefined,
    });
  }
  // A status that is none of those there are, in a record that was damaged, may move nowhere.
  const allowed = Object.hasOwn(TASK_MOVES, task.status) ? TASK_MOVES[task.status] : [];
  if (!allowed.includes(to)) {
    throw refused("status_move_not_allowed", `A task cannot go from ${task.status} to ${to}.`, {
      actions: [`From ${task.status} a task can go to: ${allowed.join(", ")}.`],
    });
  }
  if (to === "in_progress" || to === "done") {
    const open = unfinishedDependencies(graph, task);
    if (open.length) {
      throw refused(
        "unfinished_dependencies",
        `${describe(task)} cannot be ${to === "done" ? "marked done" : "started"}: it is waiting for ${open.length === 1 ? "a dependency" : `${open.length} dependencies`} to finish.`,
        {
          ...blockedBy(open),
          actions: [
            "Finish or cancel the items it depends on.",
            `Or call remove_link with type "${DEPENDS_ON}" if the dependency no longer applies.`,
            ...(to === "in_progress" ? ["Or call list_next_tasks to pick work that can start now."] : []),
          ],
        },
      );
    }
  }
  if (to === "in_progress" && caller) {
    const assigned = assignees(graph, task);
    if (assigned.length && !assigned.some((user) => user.id === caller.id)) {
      throw refused("assigned_to_other", `${describe(task)} cannot be started by ${describe(caller)}: it is assigned to ${assigned.length === 1 ? describe(assigned[0]!) : `${assigned.length} other users`}.`, {
        ...blockedBy(assigned),
        actions: [
          `Take it over explicitly: call remove_link with from "${refText(task)}", type "${ASSIGNED_TO}" and each current assignee, then call add_link with from "${refText(task)}", type "${ASSIGNED_TO}" and to "${caller.username}" before starting it.`,
          "Or call list_next_tasks to pick work assigned to you or to nobody.",
        ],
      });
    }
  }
  if (to === "done") {
    // At any depth: an unfinished task below a sub-group that is itself cancelled is still unfinished work.
    const open = containedTasks(graph, task).filter((t) => !TASK_FINISHED.includes(t.status));
    if (open.length) {
      throw refused("unfinished_contents", `${describe(task)} cannot be marked done: it contains ${open.length} unfinished task${open.length === 1 ? "" : "s"}.`, {
        ...blockedBy(open),
        actions: ["Finish or cancel the tasks it contains.", `Or call remove_link with type "${CONTAINS}" to move them out.`],
      });
    }
  }
  if (to === "cancelled") {
    const active = containedTasks(graph, task).filter((t) => t.status === "in_progress" || t.status === "in_review");
    if (active.length) {
      throw refused("active_contents", `${describe(task)} cannot be cancelled: it contains ${active.length} active task${active.length === 1 ? "" : "s"}.`, {
        ...blockedBy(active),
        actions: ["Finish the active tasks first.", `Or call remove_link with type "${CONTAINS}" to move them out of the container.`],
      });
    }
  }
}

const blockingTypes = [CONTAINS, DEPENDS_ON];

/**
 * In the "cannot finish before" graph, a container points at its contents and a task at its dependencies.
 * Returns the path from `from` back to itself that a new link `from → to` would close, or `null`.
 */
export function loopPath(graph: GraphView, from: Ref, to: Ref): Ref[] | null {
  if (sameRef(from, to)) return [from, to];
  const key = (r: Ref) => `${r.kind}:${r.id}`;
  const cameFrom = new Map<string, Ref | null>([[key(to), null]]);
  const queue: Ref[] = [to];
  // Read with a counter, not taken off the front: on a long chain that would cost a pass over the rest each time.
  for (let next = 0; next < queue.length; next++) {
    const current = queue[next]!;
    for (const type of blockingTypes) {
      for (const link of graph.out(current, type)) {
        if (cameFrom.has(key(link.to))) continue;
        cameFrom.set(key(link.to), current);
        if (sameRef(link.to, from)) {
          const path: Ref[] = [from];
          let step: Ref | null = current;
          while (step) {
            path.push(step);
            step = cameFrom.get(key(step)) ?? null;
          }
          return [from, ...path.reverse()];
        }
        queue.push(link.to);
      }
    }
  }
  return null;
}

/**
 * The items on a path as a refusal names them: the first few, and how many there are when those are not all. A
 * step that leads through an item that is not there, in data that was damaged, is neither named nor counted:
 * the count is of what could be named.
 */
function between(graph: GraphView, steps: Ref[]): Pick<ErrorDetails, "blocking" | "blocking_total"> {
  return blockedBy(steps.flatMap((ref) => graph.node(ref) ?? []));
}

export function checkNewLink(graph: GraphView, linkType: LinkType, from: Node, to: Node): void {
  if (!linkType.from.includes(from.kind) || !linkType.to.includes(to.kind)) {
    throw invalidInput(
      `"${linkType.type}" goes from a ${linkType.from.join(" or ")} to a ${linkType.to.join(" or ")}, not from a ${from.kind} to a ${to.kind}.`,
      ["Call list_link_types to see what each type connects."],
    );
  }
  if (sameRef(from, to)) throw refused("self_link", `${describe(from)} cannot be linked to itself.`);
  if (linkType.type === CONTAINS) checkContainerAcceptsWork(graph, from);
  if (linkType.effect === "groups" || linkType.effect === "holds_back") {
    const path = loopPath(graph, from, to);
    if (path) {
      throw refused("loop", `This link would create a loop, so none of these could ever finish: ${pathText(path)}.`, {
        // The items between the two ends of the new link.
        ...between(graph, path.slice(1, -1)),
        actions: ["Remove one of the links on that path first, or link different items."],
      });
    }
  }
}
