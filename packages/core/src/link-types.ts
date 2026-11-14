import type { Kind } from "./model.js";

/**
 * What the product does because a link exists. Behaviour is attached to effects, never to a type's name,
 * so a type without an effect only relates two items.
 */
export type LinkEffect = "groups" | "holds_back" | "assigns";

export interface LinkType {
  type: string;
  reverse: string;
  from: readonly Kind[];
  to: readonly Kind[];
  built_in: boolean;
  effect: LinkEffect | null;
  description: string;
}

export const LINK_TYPES: readonly LinkType[] = [
  {
    type: "contains",
    reverse: "is contained",
    from: ["project", "task"],
    to: ["task"],
    built_in: true,
    effect: "groups",
    description:
      "Groups tasks under a project or another task. A task can be contained more than once. A link that would create a loop is rejected.",
  },
  {
    type: "depends on",
    reverse: "is depended on by",
    from: ["task"],
    to: ["task", "project"],
    built_in: true,
    effect: "holds_back",
    description:
      "The first task waits until the second item is finished: a task that is done or cancelled, or a project that is ready or cancelled. A link that would create a loop is rejected.",
  },
  {
    type: "assigned to",
    reverse: "is assigned",
    from: ["task"],
    to: ["user"],
    built_in: true,
    effect: "assigns",
    description: "Says who works on a task. A task can be assigned to several users.",
  },
];

const clean = (name: string) => name.trim().toLowerCase().replace(/[\s_-]+/g, " ");

export interface ResolvedLinkType {
  linkType: LinkType;
  /** True when the client used the reverse name, so the two ends must be swapped before storing. */
  reversed: boolean;
}

/** Finds a link type by its forward or reverse name. */
export function findLinkType(name: string): ResolvedLinkType | null {
  const wanted = clean(name);
  for (const linkType of LINK_TYPES) {
    if (clean(linkType.type) === wanted) return { linkType, reversed: false };
    if (clean(linkType.reverse) === wanted) return { linkType, reversed: true };
  }
  return null;
}

export function linkTypeByEffect(effect: LinkEffect): LinkType {
  const found = LINK_TYPES.find((t) => t.effect === effect);
  if (!found) throw new Error(`No link type has the effect ${effect}`);
  return found;
}

export const CONTAINS = linkTypeByEffect("groups").type;
export const DEPENDS_ON = linkTypeByEffect("holds_back").type;
export const ASSIGNED_TO = linkTypeByEffect("assigns").type;
