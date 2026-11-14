import { containedTasks, isLive, unfinishedDependencies } from "./calc.js";
import { VigileError, invalidInput, notFound, refused, type ErrorItem } from "./errors.js";
import { sameRef, type GraphView } from "./graph.js";
import { normalizeId, refText, splitRef } from "./ids.js";
import { CONTAINS, DEPENDS_ON, type LinkType } from "./link-types.js";
import { TASK_FINISHED, TASK_MOVES, type Kind, type Node, type NodeOf, type Ref, type TaskNode, type TaskStatus } from "./model.js";

export function errorItem(node: Node): ErrorItem {
  if (node.kind === "user") return { kind: "user", id: node.id, title: node.username };
  return { kind: node.kind, id: node.id, title: node.title, status: node.status };
}

/**
 * Finds the item a client means. A reference is an ID, a username, or either with its kind in front
 * (`task:042`) when a bare number could be a project or a task.
 */
export function resolveRef<K extends Kind>(graph: GraphView, input: string, kinds: readonly K[]): NodeOf<K> {
  const { kind: stated, rest } = splitRef(input);
  if (stated && !(kinds as readonly Kind[]).includes(stated)) {
    throw invalidInput(`"${input}" is a ${stated}, but a ${list(kinds)} is expected here.`);
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
    throw invalidInput(`"${input}" matches more than one item: ${found.map((n) => `${n.kind}:${n.id}`).join(", ")}.`, [
      `Put the kind in front, as in "${found[0]!.kind}:${found[0]!.id}".`,
    ]);
  }
  const onlyUsers = candidates.length === 1 && candidates[0] === "user";
  throw notFound(`No ${list(candidates)} matches "${input}".`, [
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
export function requireVersion(node: Node, version: number, current: () => unknown): void {
  if (node.version === version) return;
  throw new VigileError(
    "version_conflict",
    `${describe(node)} changed since you read it: it is at version ${node.version}, you sent ${version}.`,
    { current: current(), actions: ["Check the current item, then repeat the call with its version."] },
  );
}

export const describe = (node: Node): string =>
  node.kind === "user" ? `User ${node.username}` : `${node.kind === "task" ? "Task" : "Project"} ${refText(node)}`;

/** Refuses a status change the rules do not allow, saying what is in the way and what can be done. */
export function checkTaskMove(graph: GraphView, task: TaskNode, to: TaskStatus): void {
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
          blocking: open.map(errorItem),
          actions: [
            "Finish or cancel the items it depends on.",
            `Or call remove_link with type "${DEPENDS_ON}" if the dependency no longer applies.`,
            ...(to === "in_progress" ? ["Or call list_next_tasks to pick work that can start now."] : []),
          ],
        },
      );
    }
  }
  if (to === "done") {
    // At any depth: an unfinished task below a sub-group that is itself cancelled is still unfinished work.
    const open = containedTasks(graph, task).filter((t) => !TASK_FINISHED.includes(t.status));
    if (open.length) {
      throw refused("unfinished_contents", `${describe(task)} cannot be marked done: it contains ${open.length} unfinished task${open.length === 1 ? "" : "s"}.`, {
        blocking: open.map(errorItem),
        actions: ["Finish or cancel the tasks it contains.", `Or call remove_link with type "${CONTAINS}" to move them out.`],
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

export function checkNewLink(graph: GraphView, linkType: LinkType, from: Node, to: Node): void {
  if (!linkType.from.includes(from.kind) || !linkType.to.includes(to.kind)) {
    throw invalidInput(
      `"${linkType.type}" goes from a ${linkType.from.join(" or ")} to a ${linkType.to.join(" or ")}, not from a ${from.kind} to a ${to.kind}.`,
      ["Call list_link_types to see what each type connects."],
    );
  }
  if (sameRef(from, to)) throw refused("self_link", `${describe(from)} cannot be linked to itself.`);
  if (linkType.effect === "groups" || linkType.effect === "holds_back") {
    const path = loopPath(graph, from, to);
    if (path) {
      throw refused("loop", `This link would create a loop, so none of these could ever finish: ${path.map(refText).join(" → ")}.`, {
        blocking: path.slice(1, -1).flatMap((ref) => {
          const node = graph.node(ref);
          return node ? [errorItem(node)] : [];
        }),
        actions: ["Remove one of the links on that path first, or link different items."],
      });
    }
  }
}
