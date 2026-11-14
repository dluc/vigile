import { echo, invalidInput } from "../errors.js";
import type { GraphView } from "../graph.js";
import { refText } from "../ids.js";
import { sameRef } from "../graph.js";
import { CONTAINS, LINK_TYPES, findLinkType, type LinkType } from "../link-types.js";
import type { Link, Node, Ref } from "../model.js";
import type { WriteContext } from "../operation.js";
import { resolveRef } from "../rules.js";
import { touch } from "./shared.js";

export interface LinkEnds {
  linkType: LinkType;
  from: Node;
  to: Node;
}

/**
 * Works out the link a client means. Either name of a type is accepted; with the reverse name the two ends
 * are swapped, so every link has exactly one stored form.
 */
export function resolveLink(graph: GraphView, input: { from: string; type: string; to: string }): LinkEnds {
  const found = findLinkType(input.type);
  if (!found) {
    throw invalidInput(`"${echo(input.type)}" is not a link type.`, [
      `Use one of: ${LINK_TYPES.map((t) => `"${t.type}" (or its reverse, "${t.reverse}")`).join(", ")}.`,
      "Call list_link_types to see what each one connects and does.",
    ]);
  }
  const { linkType, reversed } = found;
  const [fromInput, toInput] = reversed ? [input.to, input.from] : [input.from, input.to];
  return {
    linkType,
    from: resolveRef(graph, fromInput, linkType.from),
    to: resolveRef(graph, toInput, linkType.to),
  };
}

export const linkView = (link: Pick<Link, "from" | "type" | "to">) => ({ from: refText(link.from), type: link.type, to: refText(link.to) });

type Ends = Pick<Link, "from" | "type" | "to">;

/**
 * The end of a link whose own record the link is part of: the task that is contained, that depends, that is
 * assigned. Its version covers what it is in, what it waits for and who has it, so a change to one of these
 * links is a change to that task. What the other end shows of the link, its progress or what waits for it, is
 * worked out on reading, as when a task inside it changes status, and is not a change to it.
 */
export const linkOwner = (link: Ends): Ref => (link.type === CONTAINS ? link.to : link.from);

/**
 * Records that links were added or removed, in one step of one operation: each item that owns one of them
 * moves one version on, once, and both ends of each link get a line in their history. Users keep no history
 * of the tasks they are given.
 */
export function recordLinkChanges(ctx: WriteContext, action: "link_added" | "link_removed", links: Ends[], except?: Ref): void {
  const owners = new Map<string, Node>();
  for (const link of links) {
    const owner = ctx.graph.node(linkOwner(link));
    if (owner && !(except && sameRef(owner, except))) owners.set(refText(owner), owner);
    for (const end of [link.from, link.to]) {
      if (end.kind === "user" || (except && sameRef(end, except))) continue;
      ctx.plan.history(end, action, linkView(link));
    }
  }
  for (const owner of owners.values()) ctx.plan.put(touch(owner, ctx));
}

export const LINK_INPUT_HELP =
  'The type is one returned by list_link_types. Built in: "contains" (a project or task groups a task), "depends on" (a task waits for a task or project) and "assigned to" (a task has a user working on it). Either the forward or the reverse name works: "A is contained B" is stored as "B contains A".';
