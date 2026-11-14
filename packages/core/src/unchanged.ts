import type { GraphView } from "./graph.js";
import { CONTAINS, LINK_TYPES } from "./link-types.js";
import type { Link, Node, Ref } from "./model.js";

const key = (ref: Ref): string => `${ref.kind}:${ref.id}`;

/** The links that say which work is in which, and which work waits for which: what progress and problems are worked out from. */
const SHAPES_WORK = new Set(LINK_TYPES.filter((type) => type.effect === "groups" || type.effect === "holds_back").map((type) => type.type));

/**
 * Since which revision of the plan nothing that `get` shows of an item has changed: what `unchanged_since` says.
 * Two answers about one item that say the same revision show nothing that differs, so their pages can be put
 * side by side; whatever can make an answer differ must therefore move the item's number.
 *
 * What an answer of `get` shows of an item, and what moves the number for each:
 *
 * 1. The item's own fields: title, type, status, priority, value, size, why, description, version, created_at,
 *    updated_at, deleted_at, completed_at, a user's name and type.
 *    Moved by: the item being stored or removed.
 * 2. Its timeline and its history: their entries and how many there are.
 *    Moved by: the item being stored (every entry of the timeline comes with a new version), and a line being
 *    added to its history.
 * 3. Which links it has, in either direction: the lists in `links`, their totals, and `contained_in`,
 *    `depends_on`, `assigned_to`, `waiting_for`.
 *    Moved by: a link coming or going, at both of its ends.
 * 4. What a list shows of the item at the other end of each link: its ID, title, status, and whether it is
 *    deleted; of a user its name. And what is worked out from the items one link away: `is_waiting`, `is_next`
 *    and `waiting_for` from whether each dependency is finished or deleted, `assigned_to` and `is_assigned`
 *    from whether each assignee is deleted, and the problems "depends on work that is not finished" and
 *    "depends on a broken project".
 *    Moved by: an item being stored or removed, for every item it has a link with. This costs one step for
 *    each of the changed item's links: a handful for a task that changes status, 20,000 for a project of
 *    20,000 tasks that is renamed.
 * 5. What is worked out from items any number of links away. Only an item that contains others shows such:
 *    its `progress` counts the tasks inside it at any depth, and its problems ("done, but tasks inside are
 *    not", "ready, but tasks are not finished", "contains tasks that have problems") look at every task inside
 *    it and, for the last, at what each of those waits for. Which items a change reaches that way is not
 *    followed. Instead one number is kept for the whole plan, the revision at which a task or a project was
 *    last stored or removed or a link that shapes work ("contains", "depends on") last came or went, and it
 *    counts for every item that contains something. So the answer about a group or a project says a new
 *    revision after any change to any task: more often than needed, never too seldom.
 * 6. The names of users, where an answer shows who did something: `created_by`, and `by` in the timeline and
 *    in the history. A name is shown as the user's ID once the user is gone for good; nothing else changes a
 *    name. Which answers show a user is not followed either: one number for the whole plan, the revision at
 *    which a user was last removed for good, counts for every item. That is rare.
 *
 * Reading the plan from the store begins anew: every item is then unchanged since the revision that was read.
 * Everything here is one lookup to read and is kept up where a change is taken into memory; no list is gone
 * through to answer.
 *
 * What is kept is bounded by what the plan holds: a number for an item only while the item is in the graph, a
 * count only for an item that has something in it, and two numbers for the plan. An item that is removed for
 * good takes its number with it, and the end of a link that is no item never gets one. A reading that was
 * under way when an item went is thrown away because the plan's revision moved, not because of a number kept
 * for what is gone. An item that has no number is as it was read from the store: should an ID ever be given
 * to a new item, that item gets its number when it is stored, which is later than any its ID had before.
 */
export class Unchanged {
  /** For each item that was touched since the plan was read: the revision that last did (1 to 4 above). */
  private readonly touched = new Map<string, number>();
  /** How many items each item contains, for those that contain any (5). */
  private readonly holding = new Map<string, number>();
  /** The revision at which work was last changed or reshaped anywhere (5). */
  private workChanged = 0;
  /** The revision at which a user was last removed for good (6). */
  private userGone = 0;

  /** For a plan as it was read from the store at a revision, in the graph the engine goes on changing. */
  constructor(
    private readonly graph: GraphView,
    private readonly readAt: number,
  ) {
    for (const link of graph.links()) if (link.type === CONTAINS) this.holding.set(key(link.from), (this.holding.get(key(link.from)) ?? 0) + 1);
  }

  /** How many numbers and counts are kept for single items: never more than twice the items in the graph and the items that links start at. */
  get size(): number {
    return this.touched.size + this.holding.size;
  }

  since(ref: Ref): number {
    const own = this.touched.get(key(ref)) ?? this.readAt;
    return Math.max(own, this.userGone, this.holding.has(key(ref)) ? this.workChanged : 0);
  }

  /** Only an item that is in the graph has a number: what is no item, or no longer one, has none kept for it. */
  private touch(ref: Ref, revision: number): void {
    if (this.graph.node(ref)) this.touched.set(key(ref), revision);
    else this.touched.delete(key(ref));
  }

  /** Every item that an item has a link with. */
  private neighbours(ref: Ref, revision: number): void {
    for (const link of this.graph.out(ref)) this.touch(link.to, revision);
    for (const link of this.graph.in(ref)) this.touch(link.from, revision);
  }

  /** An item is stored: new, or changed. Told once it is in the graph. */
  stored(node: Node, revision: number): void {
    this.touch(node, revision);
    this.neighbours(node, revision);
    if (node.kind !== "user") this.workChanged = revision;
  }

  /**
   * An item is removed for good. The items it has a link with say so; nothing is kept for the item itself from
   * here on, whichever side of its leaving the graph this is told.
   */
  removed(ref: Ref, revision: number): void {
    this.neighbours(ref, revision);
    this.touched.delete(key(ref));
    this.holding.delete(key(ref));
    if (ref.kind === "user") this.userGone = revision;
    else this.workChanged = revision;
  }

  /** A link has come (`by` is 1) or gone (`by` is -1). `changed` says whether the graph has one link more or less for it. */
  linked(link: Pick<Link, "from" | "type" | "to">, by: 1 | -1, changed: boolean, revision: number): void {
    this.touch(link.from, revision);
    this.touch(link.to, revision);
    if (SHAPES_WORK.has(link.type)) this.workChanged = revision;
    if (!changed || link.type !== CONTAINS) return;
    const holds = (this.holding.get(key(link.from)) ?? 0) + by;
    if (holds > 0) this.holding.set(key(link.from), holds);
    else this.holding.delete(key(link.from));
  }

  /** A line is added to an item's history. */
  noted(ref: Ref, revision: number): void {
    this.touch(ref, revision);
  }
}
