import type { DecisionNode, ProjectNode, TaskNode } from "./model.js";
import type { ReadContext, TimelinePage } from "./operation.js";

export type { TimelinePage };

/**
 * One page of the statuses an item went through: the latest ones, or the ones before a place in the timeline,
 * oldest first. An entry's place is its number counted from the item's first status, which stays the same while
 * new statuses are added after it.
 *
 * This is the one place that reads a timeline for showing it. The entries are stored beside the item, one for
 * each change of status, and a page is read from there: neither the item's record nor the plan in memory holds
 * them, so that a change of status costs the same however many came before it.
 */
export function timelinePage(ctx: ReadContext, node: ProjectNode | TaskNode | DecisionNode, before?: number): Promise<TimelinePage> {
  return ctx.readTimelinePage(node, before);
}
