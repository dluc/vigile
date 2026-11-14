import { z } from "zod";
import { defineWrite } from "../operation.js";
import { checkNewLink, requireLive } from "../rules.js";
import { LINK_INPUT_HELP, linkView, recordLinkChanges, resolveLink } from "./links.js";
import { newLink } from "./shared.js";

export const addLink = defineWrite({
  name: "add_link",
  description: `Link two items. ${LINK_INPUT_HELP} Use "contains" to put a task into a group (a parent task for a feature or epic) or into another project; a task can be in several. A link that would create a loop is refused. Adding a link that already exists changes nothing. A new link is a change to the task it is about (the one that is contained, depends or is assigned): that task's version goes up.`,
  access: "all",
  input: z.strictObject({
    from: z.string().describe("The ID of the item the link starts at."),
    type: z.string().describe('The link type, for example "depends on".'),
    to: z.string().describe("The ID of the item the link points at; a username works for a user."),
  }),
  run(ctx, input) {
    const { linkType, from, to } = resolveLink(ctx.graph, input);
    const link = newLink(ctx, from, linkType.type, to);
    const existing = ctx.graph.findLink(link);
    if (existing) return () => ({ created: false, link: linkView(existing) });

    requireLive(from);
    requireLive(to);
    checkNewLink(ctx.graph, linkType, from, to);
    ctx.plan.link(link);
    recordLinkChanges(ctx, "link_added", [link]);
    return () => ({ created: true, link: linkView(link) });
  },
});
