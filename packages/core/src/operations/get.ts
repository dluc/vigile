import { z } from "zod";
import { KINDS } from "../model.js";
import { defineRead } from "../operation.js";
import { resolveRef } from "../rules.js";
import { detail } from "../views.js";
import { kind } from "./shared.js";

export const get = defineRead({
  name: "get",
  description:
    "Read one project, task or user in full: its description, its links in both directions, its calculated state, its status timeline and its version. Ask for history to also get every recorded change. Deleted items can still be read.",
  access: "all",
  input: z.strictObject({
    kind,
    id: z.string().describe("The item's ID, or a username for a user."),
    history: z.boolean().optional().describe("true to also return every recorded change to the item: when, by whom, and what."),
  }),
  async run(ctx, input) {
    const node = resolveRef(ctx.graph, input.id, input.kind ? [input.kind] : KINDS);
    const item = detail(ctx.graph, node, node.kind === "user" ? null : await ctx.readText(node));
    return input.history ? { ...item, history: await ctx.readHistory(node) } : item;
  },
});
