import { VigileError } from "../errors.js";
import type { GraphView } from "../graph.js";
import type { ReadContext } from "../operation.js";

/** How often something is read without holding anything up, before it is read in its turn among the changes. */
const FREE_TRIES = 2;
/** How many turns among the changes a reading takes before it is given up: only another engine on the same store can overtake it there. */
const TURNS = 3;

/**
 * What one try at a reading found: whether it read anything from the store, and how to put the answer together.
 * `finish` waits for nothing and reads the plan only in the graph the try was given.
 */
export interface Reading<T> {
  /**
   * True when the try read anything from the store: a description, a page of history, a count. That is all a
   * new read from the store has to do to be covered: say so here.
   */
  stored: boolean;
  finish(): T;
}

/**
 * Reads something that takes more than one step, of one revision of the plan: everything the answer shows, of
 * the item it is about, of other items and of users, and what it reads from the store, is taken while the plan
 * stays at the revision it had when the try began. This is what lets an answer say since when its item is
 * unchanged, and lets two answers that say the same be put side by side.
 *
 * `attempt` is given the graph as it is when the try begins and reads the plan in that graph only. The try
 * stands, and its answer is put together with nothing waited for in between, when three things hold at its end:
 * - The plan in memory is at the revision it was at when the try began. Every change this engine takes into
 *   memory moves the revision: to the item, to an item or a user the answer shows, to anything at all. Nothing
 *   narrower is asked, such as whether the item itself has changed: that is implied, and an answer shows more
 *   than its own item.
 * - The graph is still the engine's. When the engine reads the whole plan anew it puts another graph in the
 *   place of this one, and may do so at the same revision; what it then says of the items, such as since when
 *   each is unchanged, is said of the new graph.
 * - If the try read from the store: the store is at that same revision. A change can be in the store and not
 *   in memory, when another engine on the same store has stored it, or this one has and is about to take it
 *   into memory. The revision only goes up, so a store that is still where memory is after the try's reads was
 *   there during every one of them.
 * Otherwise the try is thrown away, with all it read, and the reading begins again in the graph as it is then.
 *
 * Two tries hold nothing up. After that, and at once when the store is ahead of memory, which no try can mend
 * by itself, the reading takes its turn among the changes: the engine first reads the plan anew if the store
 * has moved past it, and nothing this engine does can move the plan while the reading has its turn. Only
 * another engine can overtake it there, by storing a change during the turn. Three such turns in a row, and
 * the reading is refused, as something to ask again: the plan is being changed faster than it can be read.
 * A reading therefore always ends, after five tries at most, with an answer of one revision or with that
 * refusal, and never with an answer made of two.
 */
export async function readSteady<T>(ctx: ReadContext, attempt: (graph: GraphView) => Promise<Reading<T>>): Promise<T> {
  const once = async (): Promise<{ answer: T } | "moved" | "behind"> => {
    const graph = ctx.graph;
    const revision = ctx.revision;
    const { stored, finish } = await attempt(graph);
    if (stored && !(await ctx.storeInStep())) return "behind";
    return ctx.graph === graph && ctx.revision === revision ? { answer: finish() } : "moved";
  };
  for (let tries = 0; tries < FREE_TRIES; tries++) {
    const found = await once();
    if (typeof found === "object") return found.answer;
    if (found === "behind") break;
  }
  for (let turns = 0; turns < TURNS; turns++) {
    const found = await ctx.inTurn(once);
    if (typeof found === "object") return found.answer;
  }
  throw new VigileError("too_many_requests", `The plan is being changed faster than it can be read: ${TURNS} readings in a row were overtaken by a change from another writer.`, {
    actions: ["Read it again."],
  });
}
