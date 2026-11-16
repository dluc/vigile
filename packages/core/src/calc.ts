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

/**
 * Whether a task sits inside another task, as opposed to directly in a project or nowhere. A deleted task in
 * between does not take it out: what a task holds through a deleted one is inside it, as its progress counts it.
 */
export const hasParentTask = (graph: GraphView, task: TaskNode): boolean => liveContainers(graph, task).some((c) => c.kind === "task");

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

/**
 * The live projects and tasks that hold a task: its containers that are not deleted and, in the place of each
 * deleted task among them, the live ones that hold that one, however many deleted tasks lie in between. It is
 * `containedTasks` read from the other end, by the same rule: through what is deleted, naming only what is
 * live. Nothing is above a project, so a deleted project leads nowhere. By steps of its own and not by calling
 * itself, so that a long chain of deleted groups is no trouble.
 */
export function liveContainers(graph: GraphView, task: TaskNode): Array<ProjectNode | TaskNode> {
  const found: Array<ProjectNode | TaskNode> = [];
  const seen = new Set<string>();
  const queue: TaskNode[] = [task];
  for (let next = 0; next < queue.length; next++) {
    for (const holder of ordered(containers(graph, queue[next]!))) {
      const key = `${holder.kind}:${holder.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (isLive(holder)) found.push(holder);
      else if (holder.kind === "task") queue.push(holder);
    }
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

/** One priority and the shared path outside it. Nothing copies all the priorities of its ancestors. */
export interface PriorityPath {
  readonly previous: PriorityPath | null;
  readonly priority: number;
  readonly depth: number;
  /** Ancestors 1, 2, 4, … steps away, for comparing paths from their root without materialising them. */
  readonly up: ReadonlyArray<PriorityPath | null>;
  readonly id: number;
  /** Canonical IDs of suffix blocks 1, 2, 4, … priorities long, for exact bounded substring comparisons. */
  readonly blocks: ReadonlyArray<number>;
  /** One value when every priority from the root is that value; otherwise null. */
  readonly uniformPriority: number | null;
  /** The first depth in the final run of equal priorities. */
  readonly uniformSuffixStart: number;
  /** Length of this path's JSON array, maintained while appending so marked cursors can reject other depths cheaply. */
  readonly jsonLength: number;
}

/**
 * The active ways that can still be best for this task or something below it. They are one chain of prefixes:
 * ways that diverge below a lower priority can never win after the same priorities are appended, and are gone.
 * A prefix and its extension are both kept: appending the next priority may make either one win.
 */
export interface ExecutionRoute {
  paths: PathFrontier | null;
  blockers: BlockerRoute | null;
}

/** A lazy union of local blockers and inherited blocker routes. Each graph edge is retained as one pointer. */
export interface BlockerRoute {
  readonly direct: ReadonlyArray<TaskNode | ProjectNode>;
  readonly sources: ReadonlyArray<BlockerRoute>;
}

interface TreeNode<T> {
  readonly key: number | string;
  readonly value: T;
  readonly left: TreeNode<T> | null;
  readonly right: TreeNode<T> | null;
  readonly height: number;
  readonly numericMin: number | null;
  readonly numericMax: number | null;
  /** Greatest common divisor of adjacent numeric-key gaps; zero for a singleton, null for string keys. */
  readonly numericGcd: number | null;
}

/** A persistent ordered set of useful path endpoints. */
export interface PathFrontier {
  readonly root: TreeNode<number>;
  readonly offset: number;
  readonly longest: PriorityPath;
  readonly first: PriorityPath;
  readonly length: number;
}

export type ExecutionKnown = Map<string, ExecutionRoute>;
interface BlockPool {
  priorityBlocks: Map<number, number>;
  blockPairs: Array<Map<number, Map<number, number>>>;
  blockEntries: number;
}
interface PathPool extends BlockPool {
  blockNext: number;
  next: number;
  byPrevious: Map<number, Map<number, PriorityPath>>;
}
interface CandidatePool {
  durable: PathPool;
  byPrevious: Map<number, Map<number, PriorityPath>>;
  /** Candidate-only proof blocks: discarded candidates take these indexes with them. */
  blocks: BlockPool;
  proofRecords: Map<number, { priority: number } | { level: number; left: number; right: number }>;
}
interface FrontierPool {
  nodes: number;
}
const PATH_POOLS = new WeakMap<ExecutionKnown, PathPool>();
const FRONTIER_POOLS = new WeakMap<ExecutionKnown, FrontierPool>();
const PATH_FRONTIERS = new WeakMap<ExecutionKnown, Map<TreeNode<number>, Map<number, WeakMap<PriorityPath, PathFrontier>>>>();
const pathPool = (known: ExecutionKnown): PathPool => {
  let pool = PATH_POOLS.get(known);
  if (!pool) {
    pool = { next: 1, byPrevious: new Map(), blockNext: 1, priorityBlocks: new Map(), blockPairs: [], blockEntries: 0 };
    PATH_POOLS.set(known, pool);
  }
  return pool;
};
const frontierPool = (known: ExecutionKnown): FrontierPool => {
  let pool = FRONTIER_POOLS.get(known);
  if (!pool) {
    pool = { nodes: 0 };
    FRONTIER_POOLS.set(known, pool);
  }
  return pool;
};

/** Gives equivalent wrappers one identity so parent fan-in cannot duplicate a frontier by object allocation. */
function canonicalFrontier(known: ExecutionKnown, frontier: PathFrontier): PathFrontier {
  let byRoot = PATH_FRONTIERS.get(known);
  if (!byRoot) PATH_FRONTIERS.set(known, (byRoot = new Map()));
  let byOffset = byRoot.get(frontier.root);
  if (!byOffset) byRoot.set(frontier.root, (byOffset = new Map()));
  let byLongest = byOffset.get(frontier.offset);
  if (!byLongest) byOffset.set(frontier.offset, (byLongest = new WeakMap()));
  const existing = byLongest.get(frontier.longest);
  if (existing) return existing;
  byLongest.set(frontier.longest, frontier);
  return frontier;
}

function makePriority(pool: PathPool, previous: PriorityPath | null, priority: number, temporary?: CandidatePool): PriorityPath {
  const up: Array<PriorityPath | null> = [previous];
  for (let distance = 1; up[distance - 1]; distance++) up.push(up[distance - 1]!.up[distance - 1] ?? null);
  const uniformPriority = previous === null || previous.uniformPriority === priority ? priority : null;
  const depth = (previous?.depth ?? 0) + 1;
  const uniformSuffixStart = previous?.priority === priority ? previous.uniformSuffixStart : depth;
  const blocksOf = temporary?.blocks ?? pool;
  let first = pool.priorityBlocks.get(priority) ?? blocksOf.priorityBlocks.get(priority);
  if (first === undefined) {
    blocksOf.priorityBlocks.set(priority, (first = pool.blockNext++));
    blocksOf.blockEntries++;
    if (temporary) temporary.proofRecords.set(first, { priority });
  }
  const blocks = [first];
  for (let level = 1, size = 2; size <= depth; level++, size *= 2) {
    const half = size / 2;
    const leftEnd = atDepth(previous!, depth - half)!;
    const left = leftEnd.blocks[level - 1]!;
    const right = blocks[level - 1]!;
    let block = pool.blockPairs[level]?.get(left)?.get(right);
    let byLeft = blocksOf.blockPairs[level]?.get(left);
    if (!byLeft) {
      blocksOf.blockPairs[level] ??= new Map();
      blocksOf.blockPairs[level]!.set(left, (byLeft = new Map()));
    }
    block ??= byLeft.get(right);
    if (block === undefined) {
      byLeft.set(right, (block = pool.blockNext++));
      blocksOf.blockEntries++;
      if (temporary) temporary.proofRecords.set(block, { level, left, right });
    }
    blocks.push(block);
  }
  const priorityLength = JSON.stringify(priority).length;
  const jsonLength = previous ? previous.jsonLength + priorityLength + 1 : priorityLength + 2;
  return { previous, priority, depth, up, id: pool.next++, blocks, uniformPriority, uniformSuffixStart, jsonLength };
}

/** Appends one priority to the durable pool, reusing an identical segment made through another route. */
function appendPriority(known: ExecutionKnown, previous: PriorityPath | null, priority: number, stats?: ExecutionStats): PriorityPath {
  const pool = pathPool(known);
  const before = previous?.id ?? 0;
  let byPriority = pool.byPrevious.get(before);
  if (!byPriority) pool.byPrevious.set(before, (byPriority = new Map()));
  const existing = byPriority.get(priority);
  if (existing) return existing;
  const made = makePriority(pool, previous, priority);
  byPriority.set(priority, made);
  if (stats) stats.retainedSegments = (stats.retainedSegments ?? 0) + 1;
  return made;
}

/**
 * A candidate exists only for this one route calculation. It reuses durable or earlier temporary segments with
 * the same path, but is not put into the durable pool before `usefulPaths` decides that it survives.
 */
function candidatePriority(pool: CandidatePool, previous: PriorityPath | null, priority: number, stats?: ExecutionStats): PriorityPath {
  const before = previous?.id ?? 0;
  const durable = pool.durable.byPrevious.get(before)?.get(priority);
  if (durable) return durable;
  let byPriority = pool.byPrevious.get(before);
  if (!byPriority) pool.byPrevious.set(before, (byPriority = new Map()));
  const existing = byPriority.get(priority);
  if (existing) return existing;
  const made = makePriority(pool.durable, previous, priority, pool);
  byPriority.set(priority, made);
  if (stats) {
    stats.candidateSegments = (stats.candidateSegments ?? 0) + 1;
    stats.peakCandidateProofEntries = Math.max(stats.peakCandidateProofEntries ?? 0, pool.proofRecords.size);
  }
  return made;
}

/** Removes losing temporary endpoints immediately; their ancestor objects then live only if a survivor uses them. */
function discardCandidates(pool: CandidatePool, candidates: PriorityPath[], kept: PriorityPath[]): void {
  const remains = new Set(kept);
  for (const candidate of new Set(candidates)) {
    if (remains.has(candidate)) continue;
    const before = candidate.previous?.id ?? 0;
    const byPriority = pool.byPrevious.get(before);
    if (byPriority?.get(candidate.priority) !== candidate) continue;
    byPriority.delete(candidate.priority);
    if (!byPriority.size) pool.byPrevious.delete(before);
  }
}

/** Releases every temporary lookup after one traversal step has promoted all paths that can survive it. */
function releaseCandidates(pool: CandidatePool): void {
  pool.byPrevious.clear();
  pool.blocks.priorityBlocks.clear();
  pool.blocks.blockPairs.length = 0;
  pool.blocks.blockEntries = 0;
  pool.proofRecords.clear();
}

/** Promotes one surviving temporary path into the durable pool without changing any prefix's identity. */
function retainPriority(known: ExecutionKnown, path: PriorityPath, stats?: ExecutionStats, candidates?: CandidatePool): PriorityPath {
  const durable = pathPool(known);
  const tail: PriorityPath[] = [];
  let at: PriorityPath | null = path;
  while (at && durable.byPrevious.get(at.previous?.id ?? 0)?.get(at.priority) !== at) {
    tail.push(at);
    at = at.previous;
  }
  while (tail.length) {
    const retained = tail.pop()!;
    for (const block of retained.blocks) {
      const record = candidates?.proofRecords.get(block);
      if (!record) continue;
      if ("priority" in record) {
        const existing = durable.priorityBlocks.get(record.priority);
        if (existing !== undefined && existing !== block) throw new Error("Two priority blocks have the same value.");
        durable.priorityBlocks.set(record.priority, block);
      } else {
        let byLeft = durable.blockPairs[record.level]?.get(record.left);
        if (!byLeft) {
          durable.blockPairs[record.level] ??= new Map();
          durable.blockPairs[record.level]!.set(record.left, (byLeft = new Map()));
        }
        const existing = byLeft.get(record.right);
        if (existing !== undefined && existing !== block) throw new Error("Two priority blocks have the same pair.");
        byLeft.set(record.right, block);
      }
      durable.blockEntries++;
      candidates!.proofRecords.delete(block);
    }
    const before = retained.previous?.id ?? 0;
    let byPriority = durable.byPrevious.get(before);
    if (!byPriority) durable.byPrevious.set(before, (byPriority = new Map()));
    const existing = byPriority.get(retained.priority);
    if (existing && existing !== retained) throw new Error("Two priority paths have the same place.");
    if (!existing) {
      byPriority.set(retained.priority, retained);
      if (stats) stats.retainedSegments = (stats.retainedSegments ?? 0) + 1;
    }
  }
  return path;
}

const treeHeight = <T>(node: TreeNode<T> | null): number => node?.height ?? 0;
const treeCompare = (a: number | string, b: number | string): number => (a < b ? -1 : a > b ? 1 : 0);
const gcd = (a: number, b: number): number => {
  for (a = Math.abs(a), b = Math.abs(b); b !== 0; ) [a, b] = [b, a % b];
  return a;
};

function treeNode<T>(pool: { nodes: number }, key: number | string, value: T, left: TreeNode<T> | null, right: TreeNode<T> | null): TreeNode<T> {
  pool.nodes++;
  const numericMin = typeof key === "number" ? (left?.numericMin ?? key) : null;
  const numericMax = typeof key === "number" ? (right?.numericMax ?? key) : null;
  const numericGcd = typeof key === "number"
    ? [left?.numericGcd ?? 0, right?.numericGcd ?? 0, left?.numericMax === null || left?.numericMax === undefined ? 0 : key - left.numericMax, right?.numericMin === null || right?.numericMin === undefined ? 0 : right.numericMin - key].reduce(gcd, 0)
    : null;
  return { key, value, left, right, height: Math.max(treeHeight(left), treeHeight(right)) + 1, numericMin, numericMax, numericGcd };
}

function treeBalance<T>(pool: { nodes: number }, key: number | string, value: T, left: TreeNode<T> | null, right: TreeNode<T> | null): TreeNode<T> {
  if (treeHeight(left) > treeHeight(right) + 1) {
    const high = left!;
    if (treeHeight(high.left) >= treeHeight(high.right)) {
      return treeNode(pool, high.key, high.value, high.left, treeNode(pool, key, value, high.right, right));
    }
    const middle = high.right!;
    return treeNode(pool, middle.key, middle.value, treeNode(pool, high.key, high.value, high.left, middle.left), treeNode(pool, key, value, middle.right, right));
  }
  if (treeHeight(right) > treeHeight(left) + 1) {
    const high = right!;
    if (treeHeight(high.right) >= treeHeight(high.left)) {
      return treeNode(pool, high.key, high.value, treeNode(pool, key, value, left, high.left), high.right);
    }
    const middle = high.left!;
    return treeNode(pool, middle.key, middle.value, treeNode(pool, key, value, left, middle.left), treeNode(pool, high.key, high.value, middle.right, high.right));
  }
  return treeNode(pool, key, value, left, right);
}

function treeSet<T>(pool: { nodes: number }, root: TreeNode<T> | null, key: number | string, value: T): TreeNode<T> {
  if (!root) return treeNode(pool, key, value, null, null);
  const compared = treeCompare(key, root.key);
  if (compared === 0) return root.value === value ? root : treeNode(pool, key, value, root.left, root.right);
  return compared < 0
    ? treeBalance(pool, root.key, root.value, treeSet(pool, root.left, key, value), root.right)
    : treeBalance(pool, root.key, root.value, root.left, treeSet(pool, root.right, key, value));
}

function treeDelete<T>(pool: { nodes: number }, root: TreeNode<T> | null, key: number | string): TreeNode<T> | null {
  if (!root) return null;
  const compared = treeCompare(key, root.key);
  if (compared < 0) return treeBalance(pool, root.key, root.value, treeDelete(pool, root.left, key), root.right);
  if (compared > 0) return treeBalance(pool, root.key, root.value, root.left, treeDelete(pool, root.right, key));
  if (!root.left) return root.right;
  if (!root.right) return root.left;
  let next = root.right;
  while (next.left) next = next.left;
  return treeBalance(pool, next.key, next.value, root.left, treeDelete(pool, root.right, next.key));
}

function treeValues<T>(root: TreeNode<T> | null): T[] {
  const values: T[] = [];
  const stack: TreeNode<T>[] = [];
  let at = root;
  while (at || stack.length) {
    while (at) {
      stack.push(at);
      at = at.left;
    }
    at = stack.pop()!;
    values.push(at.value);
    at = at.right;
  }
  return values;
}

function treeHas<T>(root: TreeNode<T> | null, key: number | string): boolean {
  let at = root;
  while (at) {
    const compared = treeCompare(key, at.key);
    if (compared === 0) return true;
    at = compared < 0 ? at.left : at.right;
  }
  return false;
}

function treeFirst<T>(root: TreeNode<T>): T {
  let at = root;
  while (at.left) at = at.left;
  return at.value;
}

function frontierSegments(frontier: PathFrontier): PriorityPath[] {
  return treeValues(frontier.root).map((depth) => atDepth(frontier.longest, depth + frontier.offset)!);
}

/** Updates the most-overlapping parent set, sharing every untouched tree branch. */
function retainFrontier(known: ExecutionKnown, paths: PriorityPath[], sources: PathFrontier[], stats?: ExecutionStats, candidates?: CandidatePool): PathFrontier {
  const pool = frontierPool(known);
  const retained = paths.map((path) => retainPriority(known, path, stats, candidates));
  const depths = retained.map((path) => path.depth);
  const wanted = new Set(depths);
  for (const source of sources) {
    const before = treeValues(source.root).map((depth) => depth + source.offset);
    if (before.length !== depths.length || !before.length) continue;
    const shift = depths[0]! - before[0]!;
    if (before.every((depth, at) => depth + shift === depths[at])) {
      return canonicalFrontier(known, {
        root: source.root,
        offset: source.offset + shift,
        longest: retained.at(-1)!,
        first: retained[0]!,
        length: retained.length,
      });
    }
  }
  let base: PathFrontier | null = null;
  let baseOffset = 0;
  let overlap = 0;
  for (const source of sources) {
    const stored = treeValues(source.root);
    for (const shift of [0, 1, -1]) {
      const offset = source.offset + shift;
      const count = stored.filter((depth) => wanted.has(depth + offset)).length;
      if (count > overlap) {
        base = source;
        baseOffset = offset;
        overlap = count;
      }
    }
  }
  let root = base?.root ?? null;
  const offset = base ? baseOffset : 0;
  const before = base ? treeValues(base.root).map((depth) => depth + offset) : [];
  for (const depth of before) if (!wanted.has(depth)) root = treeDelete(pool, root, depth - offset);
  const had = new Set(before);
  for (const depth of depths) if (!had.has(depth)) root = treeSet(pool, root, depth - offset, depth - offset);
  return canonicalFrontier(known, { root: root!, offset, longest: retained.at(-1)!, first: retained[0]!, length: retained.length });
}

/** Materializes a frontier only for the current calculation or operation boundary; no route cache retains it. */
export function executionPrioritySegments(route: ExecutionRoute): PriorityPath[] {
  return route.paths ? frontierSegments(route.paths) : [];
}

/** Exact equality of two same-length ranges in one path, in logarithmically many canonical power-of-two blocks. */
function samePriorityRange(path: PriorityPath, a: number, b: number, length: number): boolean {
  while (length > 0) {
    const level = Math.floor(Math.log2(length));
    const size = 2 ** level;
    if (atDepth(path, a + size - 1)!.blocks[level] !== atDepth(path, b + size - 1)!.blocks[level]) return false;
    a += size;
    b += size;
    length -= size;
  }
  return true;
}

/** Whether appending this priority moves every endpoint one level along the same canonical periodic path. */
function frontierShiftsTogether(frontier: PathFrontier, priority: number): boolean {
  if (frontier.length === 1) return true;
  const following = atDepth(frontier.longest, frontier.first.depth + 1);
  if (!following || following.priority !== priority) return false;
  const period = frontier.root.numericGcd ?? 0;
  if (period <= 0) return false;
  const start = frontier.first.depth + 1;
  const length = frontier.longest.depth - start + 1;
  return length <= period || samePriorityRange(frontier.longest, start, start + period, length - period);
}

/** Proves a source's endpoint depths are contained in a larger arithmetic-progression frontier without walking either tree. */
function frontierCoveredBy(source: PathFrontier, covering: PathFrontier): boolean {
  const coveringMin = covering.root.numericMin! + covering.offset;
  const coveringMax = covering.root.numericMax! + covering.offset;
  const sourceMin = source.root.numericMin! + source.offset;
  const sourceMax = source.root.numericMax! + source.offset;
  if (sourceMin < coveringMin || sourceMax > coveringMax) return false;
  if (atDepth(covering.longest, source.longest.depth) !== source.longest) return false;
  const period = covering.root.numericGcd ?? 0;
  if (period <= 0 || (coveringMax - coveringMin) / period + 1 !== covering.length) return false;
  const sourcePeriod = source.root.numericGcd ?? 0;
  if (sourcePeriod !== 0 && sourcePeriod % period !== 0) return false;
  const residue = (value: number) => ((value % period) + period) % period;
  return residue(coveringMin) === residue(sourceMin);
}

/** A divergent lower-priority branch can never win after both branches receive the same suffix. */
function frontierLosesTo(source: PathFrontier, covering: PathFrontier): boolean {
  const common = Math.min(source.first.depth, covering.first.depth);
  if (atDepth(source.first, common) === atDepth(covering.first, common)) return false;
  return comparePrioritySegments(source.first, covering.first) > 0;
}

/** Keeps the highest divergent source and every source whose first path extends the useful prefix chain. */
function usefulFrontiers(sources: PathFrontier[], stats?: ExecutionStats): PathFrontier[] {
  const compared = (a: PathFrontier, b: PathFrontier) => {
    if (stats) stats.pathComparisons++;
    return comparePrioritySegments(a.first, b.first);
  };
  const sorted = [...new Set(sources)].sort(compared);
  if (!sorted.length) return [];
  const kept = [sorted[0]!];
  for (const candidate of sorted.slice(1)) {
    const previous = kept.at(-1)!;
    if (candidate.first === previous.first || (candidate.first.depth > previous.first.depth && atDepth(candidate.first, previous.first.depth) === previous.first)) kept.push(candidate);
  }
  return kept;
}

const blockerKey = (blocker: TaskNode | ProjectNode): string => `${blocker.kind}:${blocker.id}`;

/** A lazy blocker union; a sole inherited route passes through without another wrapper. */
function blockerRoute(blockers: Array<TaskNode | ProjectNode>, sources: BlockerRoute[]): BlockerRoute | null {
  const direct = ordered(uniqueNodes(blockers));
  const inherited = [...new Set(sources)];
  if (!direct.length && inherited.length === 1) return inherited[0]!;
  return direct.length || inherited.length ? { direct, sources: inherited } : null;
}

/** Materializes blockers only when an operation result actually reads them. */
export function executionBlockers(route: ExecutionRoute): Array<TaskNode | ProjectNode> {
  if (!route.blockers) return [];
  const found = new Map<string, TaskNode | ProjectNode>();
  const seen = new Set<BlockerRoute>();
  const pending = [route.blockers];
  while (pending.length) {
    const frontier = pending.pop()!;
    if (seen.has(frontier)) continue;
    seen.add(frontier);
    for (const blocker of frontier.direct) found.set(blockerKey(blocker), blocker);
    pending.push(...frontier.sources);
  }
  return ordered([...found.values()]);
}

/** The segment at a depth counted from the root, without putting the path into an array. */
function atDepth(path: PriorityPath, depth: number): PriorityPath | null {
  if (depth < 1 || depth > path.depth) return null;
  let found: PriorityPath | null = path;
  let climb = path.depth - depth;
  let bit = 0;
  while (climb && found) {
    if (climb & 1) found = found.up[bit] ?? null;
    climb >>>= 1;
    bit++;
  }
  return found;
}

/** High priority first; a container before what is inside it. */
export function comparePrioritySegments(a: PriorityPath, b: PriorityPath): number {
  if (a === b) return 0;
  const common = Math.min(a.depth, b.depth);
  if (atDepth(a, common) === atDepth(b, common)) return a.depth - b.depth;
  let low = 0;
  let high = common;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (atDepth(a, middle) === atDepth(b, middle)) low = middle;
    else high = middle;
  }
  return atDepth(b, high)!.priority - atDepth(a, high)!.priority;
}

/** Removes a path only when a divergent, higher-priority path beats it after every possible suffix. */
export interface ExecutionStats {
  pathComparisons: number;
  candidateSegments?: number;
  peakCandidateProofEntries?: number;
  retainedSegments?: number;
  routeVisits?: number;
  peakPendingPaths?: number;
  peakParentSources?: number;
  peakPendingBlockers?: number;
  peakBlockerSources?: number;
  blockerEntriesVisited?: number;
  blockerPredecessorsVisited?: number;
  blockerProofLookups?: number;
  pathEntriesVisited?: number;
}

/** What the durable cache retains after a route calculation: evidence that memory follows the graph, not its paths. */
export function executionRetained(known: ExecutionKnown): {
  segments: number;
  frontiers: number;
  references: number;
  blockerSets: number;
  blockerIndexEntries: number;
  blockerIndexKeyUnits: number;
  blockerProofEntries: number;
  periodProofEntries: number;
} {
  const pool = PATH_POOLS.get(known);
  let segments = 0;
  for (const byPriority of pool?.byPrevious.values() ?? []) segments += byPriority.size;
  let references = 0;
  for (const route of known.values()) references += route.paths || route.blockers ? 1 : 0;
  const pathNodes = new Set<TreeNode<number>>();
  const blockerRoutes = new Set<BlockerRoute>();
  const collect = <T>(root: TreeNode<T> | null, found: Set<TreeNode<T>>) => {
    if (!root || found.has(root)) return;
    found.add(root);
    collect(root.left, found);
    collect(root.right, found);
  };
  for (const route of known.values()) {
    if (route.paths) collect(route.paths.root, pathNodes);
    if (route.blockers) {
      const pending = [route.blockers];
      while (pending.length) {
        const frontier = pending.pop()!;
        if (blockerRoutes.has(frontier)) continue;
        blockerRoutes.add(frontier);
        pending.push(...frontier.sources);
      }
    }
  }
  const frontiers = pathNodes.size;
  const blockerSets = blockerRoutes.size;
  return { segments, frontiers, references, blockerSets, blockerIndexEntries: 0, blockerIndexKeyUnits: 0, blockerProofEntries: 0, periodProofEntries: pool?.blockEntries ?? 0 };
}

function usefulPaths(paths: PriorityPath[], stats?: ExecutionStats): PriorityPath[] {
  // Under the path order, a prefix comes first and the highest divergent branch follows it first. Therefore the
  // useful alternatives are exactly one prefix chain in this sorted list; everything on a later divergent branch
  // can never win after the same priorities are appended. This is O(paths log paths), not a pairwise O(paths²).
  const compare = (a: PriorityPath, b: PriorityPath) => {
    if (stats) stats.pathComparisons++;
    return comparePrioritySegments(a, b);
  };
  const sorted = [...new Set(paths)].sort(compare);
  if (!sorted.length) return [];
  const kept = [sorted[0]!];
  for (const candidate of sorted.slice(1)) {
    const previous = kept.at(-1)!;
    if (candidate.depth > previous.depth && atDepth(candidate, previous.depth) === previous) kept.push(candidate);
  }
  return kept;
}

/** The path that orders this task itself; arrays exist only at the operation boundary and in its token. */
export function executionPrioritySegment(route: ExecutionRoute): PriorityPath | null {
  return route.paths?.first ?? null; // Useful paths are a chain of prefixes: the shorter one orders this task first.
}

/** Makes the array that crosses the operation boundary or is written into a continuation token. */
export function priorityPathNumbers(path: PriorityPath): number[] {
  const result = new Array<number>(path.depth);
  for (let at: PriorityPath | null = path; at; at = at.previous) result[at.depth - 1] = at.priority;
  return result;
}

export const executionPriorityPath = (route: ExecutionRoute): number[] | null => {
  const path = executionPrioritySegment(route);
  return path ? priorityPathNumbers(path) : null;
};

/** Reads the one array in a continuation token into the same shared segments the live routes use. */
export function priorityPathFrom(numbers: readonly number[], known: ExecutionKnown): PriorityPath {
  let path: PriorityPath | null = null;
  for (const priority of numbers) path = appendPriority(known, path, priority);
  return path!;
}
const EXECUTION_KNOWN = new WeakMap<Known, ExecutionKnown>();
const executionKnown = (known: Known): ExecutionKnown => {
  let found = EXECUTION_KNOWN.get(known);
  if (!found) {
    found = new Map();
    EXECUTION_KNOWN.set(known, found);
  }
  return found;
};

const ACTIVE_GROUP = new Set(["open", "in_progress"]);
/** A priority that damaged data left as something other than a finite number is none. */
const executionPriority = (task: TaskNode): number => (typeof task.priority === "number" && Number.isFinite(task.priority) ? task.priority : 0);

const uniqueNodes = <T extends TaskNode | ProjectNode>(nodes: T[]): T[] => {
  const found = new Map<string, T>();
  for (const node of nodes) found.set(`${node.kind}:${node.id}`, node);
  return [...found.values()];
};

/**
 * How execution reaches `task`. Direct project membership is the root only where no parent task contains it:
 * create_task deliberately links a step both to its project (for its ID and project lists) and to its parent,
 * and that project link must not let it walk around the group. A group is active while open or in progress; a
 * project while it is live and not ready or cancelled. One active path is enough where an item has several.
 *
 * Uses an explicit stack so a plan nested thousands deep costs no call stack. `known` makes a whole list linear
 * in the number of containment links rather than going up every path for every task.
 */
export function executionRoute(graph: GraphView, task: TaskNode, known: ExecutionKnown = new Map(), stats?: ExecutionStats): ExecutionRoute {
  const remembered = known.get(task.id);
  if (remembered) return remembered;
  const candidates: CandidatePool = { durable: pathPool(known), byPrevious: new Map(), blocks: { priorityBlocks: new Map(), blockPairs: [], blockEntries: 0 }, proofRecords: new Map() };
  type Step = {
    task: TaskNode;
    parents: TaskNode[];
    next: number;
    paths: Set<PriorityPath>;
    sources: PathFrontier[];
    blockers: Set<TaskNode | ProjectNode>;
    blockerSources: BlockerRoute[];
  };
  const parentsOf = (item: TaskNode) => containers(graph, item).filter((node): node is TaskNode => node.kind === "task");
  const stack: Step[] = [{ task, parents: parentsOf(task), next: 0, paths: new Set(), sources: [], blockers: new Set(), blockerSources: [] }];
  const measureWorking = () => {
    if (!stats) return;
    const pending = stack.reduce((total, step) => total + step.paths.size, 0);
    const sources = stack.reduce((total, step) => total + step.sources.length, 0);
    const blockers = stack.reduce((total, step) => total + step.blockers.size, 0);
    const blockerSources = stack.reduce((total, step) => total + step.blockerSources.length, 0);
    stats.peakPendingPaths = Math.max(stats.peakPendingPaths ?? 0, pending);
    stats.peakParentSources = Math.max(stats.peakParentSources ?? 0, sources);
    stats.peakPendingBlockers = Math.max(stats.peakPendingBlockers ?? 0, blockers);
    stats.peakBlockerSources = Math.max(stats.peakBlockerSources ?? 0, blockerSources);
  };
  if (stats) stats.routeVisits = (stats.routeVisits ?? 0) + 1;
  const onWay = new Set([task.id]);
  let answer: ExecutionRoute | null = null;
  while (stack.length) {
    const step = stack.at(-1)!;
    if (step.next < step.parents.length) {
      const parent = step.parents[step.next++]!;
      if (!isLive(parent) || !ACTIVE_GROUP.has(parent.status)) {
        step.blockers.add(parent);
        continue;
      }
      const learnt = known.get(parent.id);
      if (learnt) {
        if (learnt.paths) {
          step.sources.push(learnt.paths);
          measureWorking();
        }
        else {
          if (learnt.blockers) step.blockerSources.push(learnt.blockers);
          measureWorking();
        }
        continue;
      }
      // A containment loop is refused when it is made. Damaged data with one cannot offer work through it.
      if (onWay.has(parent.id)) {
        step.blockers.add(parent);
        continue;
      }
      onWay.add(parent.id);
      stack.push({ task: parent, parents: parentsOf(parent), next: 0, paths: new Set(), sources: [], blockers: new Set(), blockerSources: [] });
      if (stats) stats.routeVisits = (stats.routeVisits ?? 0) + 1;
      continue;
    }
    if (!step.parents.length) {
      const projects = containers(graph, step.task).filter((node): node is ProjectNode => node.kind === "project");
      const active = projects.filter((project) => isLive(project) && !PROJECT_FINISHED.includes(project.status));
      if (!projects.length || active.length) step.paths.add(candidatePriority(candidates, null, executionPriority(step.task), stats));
      else for (const project of projects) step.blockers.add(project);
    }
    const priority = executionPriority(step.task);
    // Discard a divergent lower-priority source before choosing a shift base or expanding any endpoints. Its
    // whole frontier loses after every common suffix; prefix-related sources remain because either may win.
    const pathSources = usefulFrontiers(step.sources, stats);
    let directlyShifted: PathFrontier | null = null;
    if (step.paths.size === 0 && pathSources.length) {
      const base = [...pathSources]
        .sort((a, b) => b.longest.depth - a.longest.depth)
        .find((source) => frontierShiftsTogether(source, priority));
      const extras = base ? pathSources.filter((source) => source !== base && !frontierCoveredBy(source, base) && !frontierLosesTo(source, base)) : [];
      if (base && extras.reduce((total, source) => total + source.length, 0) <= pathSources.length * 2) {
        const longest = appendPriority(known, base.longest, priority, stats);
        let root = base.root;
        const offset = base.offset + 1;
        let length = base.length;
        let valid = true;
        for (const source of extras) {
          const inherited = frontierSegments(source);
          if (stats) stats.pathEntriesVisited = (stats.pathEntriesVisited ?? 0) + inherited.length;
          for (const path of inherited) {
            const shifted = appendPriority(known, path, priority, stats);
            if (atDepth(longest, shifted.depth) !== shifted) {
              valid = false;
              break;
            }
            const key = shifted.depth - offset;
            if (!treeHas(root, key)) {
              root = treeSet(frontierPool(known), root, key, key);
              length++;
            }
          }
          if (!valid) break;
        }
        if (valid) {
          const firstDepth = treeFirst(root) + offset;
          directlyShifted = canonicalFrontier(known, { root, offset, longest, first: atDepth(longest, firstDepth)!, length });
        }
      }
    }
    if (!directlyShifted) {
      for (const source of pathSources) {
        const inherited = frontierSegments(source);
        if (stats) stats.pathEntriesVisited = (stats.pathEntriesVisited ?? 0) + inherited.length;
        for (const path of inherited) step.paths.add(candidatePriority(candidates, path, priority, stats));
        measureWorking();
      }
    }
    const blockerSources = [...new Set(step.blockerSources)];
    const expanded = [...step.paths];
    const useful = directlyShifted ? null : expanded.length ? usefulPaths(expanded, stats) : null;
    if (useful) discardCandidates(candidates, expanded, useful);
    const result: ExecutionRoute = {
      paths: directlyShifted ?? (useful ? retainFrontier(known, useful, pathSources, stats, candidates) : null),
      blockers: blockerRoute([...step.blockers], blockerSources),
    };
    releaseCandidates(candidates);
    known.set(step.task.id, result);
    if (step.task === task) answer = result;
    onWay.delete(step.task.id);
    stack.pop();
    if (stack.length) {
      const child = stack.at(-1)!;
      if (result.paths) {
        child.sources.push(result.paths);
        measureWorking();
      }
      else {
        if (result.blockers) child.blockerSources.push(result.blockers);
        measureWorking();
      }
    }
  }
  return answer!;
}

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
  has(graph: GraphView, task: TaskNode, known: Known, route?: ExecutionRoute): boolean;
  /** The problem in words, with the items it is about. Asked only of a task that has it. */
  describe(graph: GraphView, task: TaskNode, known: Known, route?: ExecutionRoute): Problem;
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
    has: (graph, task, known, route) => !TASK_FINISHED.includes(task.status) && (route ?? executionRoute(graph, task, executionKnown(known))).paths === null,
    describe: (graph, task, known, route) => {
      const blocked = executionBlockers(route ?? executionRoute(graph, task, executionKnown(known)));
      return {
        code: "inside_inactive_container",
        message: `Every way into the plan is closed by a container that is not active: ${names(blocked)}.`,
        items: blocked.map(toRef),
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
export function taskHasProblems(graph: GraphView, task: TaskNode, known: Known = new Map(), route?: ExecutionRoute): boolean {
  return isLive(task) && TASK_CHECKS.some((check) => check.has(graph, task, known, route));
}

/** A task's problems in full. For the tasks that are shown: a list that only asks whether there are any uses `taskHasProblems`. */
export function taskProblems(graph: GraphView, task: TaskNode, known: Known = new Map(), route?: ExecutionRoute): Problem[] {
  if (!isLive(task)) return [];
  return TASK_CHECKS.filter((check) => check.has(graph, task, known, route)).map((check) => check.describe(graph, task, known, route));
}

export function taskCalc(graph: GraphView, task: TaskNode, known: Known = new Map(), routes: ExecutionKnown = executionKnown(known)): TaskCalc {
  // A caller that already owns the route cache owns this whole reading. Problem checks and the summaries made
  // after filtering recover routes through `known`, so associate the two caches before any of them run rather
  // than retaining a second copy of every containment path.
  EXECUTION_KNOWN.set(known, routes);
  const live = isLive(task);
  const route = executionRoute(graph, task, routes);
  const unfinished = live && !TASK_FINISHED.includes(task.status) ? unfinishedDependencies(graph, task) : [];
  const isWaiting = unfinished.length > 0 || (live && !TASK_FINISHED.includes(task.status) && route.paths === null);
  const assigned = assignees(graph, task);
  let waitingFor: Array<TaskNode | ProjectNode> | undefined;
  let problems: Problem[] | undefined;
  let completedAt: string | null = null;
  if (task.status === "done") {
    for (const entry of task.timeline) if (entry.status === "done") completedAt = entry.at;
  }
  return {
    is_waiting: isWaiting,
    get waiting_for() {
      return (waitingFor ??= isWaiting ? uniqueNodes([...unfinished, ...(route.paths ? [] : executionBlockers(route))]) : []);
    },
    is_next: live && task.status === "open" && !isWaiting && route.paths !== null,
    is_assigned: assigned.length > 0,
    assigned_to: assigned,
    has_problems: taskHasProblems(graph, task, known, route),
    // Put into words when they are read, which is for the tasks that are returned: a list goes through many
    // more than it returns, and asks each only whether it has any.
    get problems() {
      return (problems ??= taskProblems(graph, task, known, route));
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
