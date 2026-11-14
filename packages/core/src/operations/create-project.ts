import { z } from "zod";
import { isLive } from "../calc.js";
import { echo, invalidInput, refused } from "../errors.js";
import { formatNumber, prefixProblem } from "../ids.js";
import type { ProjectNode } from "../model.js";
import { defineWrite } from "../operation.js";
import { projectSummary } from "../views.js";
import { statusEntry, text, title } from "./shared.js";

export const createProject = defineWrite({
  name: "create_project",
  description:
    "Create a project, which groups tasks. A prefix of 2 to 8 letters becomes the project's ID and is put in front of the IDs of tasks created in it, as in ABC-042. The prefix cannot be changed later, and no other project can ever have it, also after this one is deleted. Without a prefix the project gets a number as its ID. A new project starts as open.",
  access: "all",
  input: z.strictObject({
    title,
    description: text.optional().describe("What the project is for."),
    prefix: z.string().trim().optional().describe("2 to 8 letters, unique in the tenant, for example ABC."),
  }),
  async run(ctx, input) {
    let prefix: string | null = null;
    if (input.prefix !== undefined && input.prefix !== "") {
      prefix = input.prefix.toUpperCase();
      const problem = prefixProblem(prefix);
      if (problem) throw invalidInput(`"${echo(input.prefix)}" cannot be a prefix. ${problem}`);
      const existing = ctx.graph.get("project", prefix);
      if (existing) {
        throw refused("prefix_taken", `The prefix ${prefix} is already used by a project${isLive(existing) ? "" : " that is deleted"}.`, {
          actions: ["Choose a different prefix."],
        });
      }
      // A prefix is given once. A project that was deleted for good left its prefix beside the counters; one
      // that was deleted before prefixes were remembered left its history, which was kept then. Whether there
      // is any is asked of a page of it: however long it is, it is not read to find out that it is there.
      if (ctx.plan.isRetired(prefix) || (await ctx.readHistoryPage({ kind: "project", id: prefix })).total > 0) {
        throw refused("prefix_taken", `The prefix ${prefix} was used by a project that has been deleted for good. A prefix is never given twice: the IDs that carried it go on meaning what they meant.`, {
          actions: ["Choose a different prefix."],
        });
      }
    }
    const project: ProjectNode = {
      kind: "project",
      id: prefix ?? formatNumber(ctx.plan.next("project")),
      prefix,
      title: input.title,
      status: "open",
      timeline: [statusEntry("open", ctx)],
      version: 1,
      created_at: ctx.now,
      created_by: ctx.caller.id,
      updated_at: ctx.now,
      deleted_at: null,
    };
    ctx.plan.put(project, input.description ?? "");
    ctx.plan.history(project, "created", { status: project.status });
    return () => projectSummary(ctx.graph, ctx.graph.get("project", project.id)!);
  },
});
