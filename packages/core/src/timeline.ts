import { LIMITS, type ProjectNode, type StatusEntry, type TaskNode } from "./model.js";
import type { ReadContext } from "./operation.js";

export interface TimelinePage {
  /** Oldest first. */
  entries: StatusEntry[];
  /** How many statuses the item went through in all. */
  total: number;
  /** The place in the timeline of the first entry of this page. Above 0, there are entries before it. */
  from: number;
}

/**
 * One page of the statuses an item went through: the latest ones, or the ones before a place in the timeline,
 * oldest first. An entry's place is its number counted from the item's first status, which stays the same while
 * new statuses are added after it.
 *
 * This is the one place that reads a timeline for showing it, and whoever asks waits for the answer: where the
 * entries are kept can change without a change to those who ask.
 */
export async function timelinePage(_ctx: ReadContext, node: ProjectNode | TaskNode, before?: number): Promise<TimelinePage> {
  const total = node.timeline.length;
  const end = Math.min(before ?? total, total);
  const from = Math.max(0, end - LIMITS.page);
  return { entries: node.timeline.slice(from, end), total, from };
}
