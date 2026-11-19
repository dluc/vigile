import { z } from "zod";
import { notFound } from "../errors.js";
import { defineWrite } from "../operation.js";
import { describe } from "../rules.js";
import { LINK_INPUT_HELP, linkView, recordLinkChanges, resolveLink } from "./links.js";

export const removeLink = defineWrite({
  name: "remove_link",
  description: `Remove a link between two items. ${LINK_INPUT_HELP} Removing a "contains" link takes a task out of a project or parent task; removing a "depends on" link stops the task waiting for that item. The task the link was about moves one version on.`,
  access: "all",
  input: z.strictObject({
    from: z.string().describe("The ID of the item the link starts at."),
    type: z.string().describe('The link type, for example "depends on".'),
    to: z.string().describe("The ID of the item the link points at; a username works for a user."),
  }),
  run(ctx, input) {
    const { linkType, from, to } = resolveLink(ctx.graph, input, ctx.features);
    const link = ctx.graph.findLink({ from, type: linkType.type, to });
    if (!link) {
      throw notFound(`There is no "${linkType.type}" link from ${describe(from)} to ${describe(to)}.`, [
        "Call get on either item to see the links it has.",
      ]);
    }
    ctx.plan.unlink(link);
    recordLinkChanges(ctx, "link_removed", [link]);
    return () => ({ removed: true, link: linkView(link) });
  },
});
