import { z } from "zod";
import { isLive, projectCalc, type Known } from "../calc.js";
import { defineRead } from "../operation.js";
import { projectSummary } from "../views.js";
import { describeList } from "../paging.js";
import { continuation, cursor, paginate, type Cursor } from "./shared.js";

/** The tokens of a list of projects, for the filters it was asked with. The list is in the order of the IDs, and a token carries the ID of the last project returned. */
export const projectsCursor = (input: Record<string, unknown> = {}): Cursor<string> => cursor(describeList("list_projects", input));

export const listProjects = defineRead({
  name: "list_projects",
  description:
    "List the projects, with each one's status, progress (finished tasks out of all tasks it contains) and problems. Returns at most 100 per call.",
  access: "all",
  input: z.strictObject({
    has_problems: z.boolean().optional().describe("true to list only projects that have problems."),
    continuation,
  }),
  run(ctx, input) {
    let projects = ctx.graph.all("project").filter(isLive);
    const known: Known = new Map();
    if (input.has_problems !== undefined) projects = projects.filter((p) => projectCalc(ctx.graph, p, known).has_problems === input.has_problems);
    const tokens = projectsCursor(input);
    projects.sort((a, b) => tokens.list.compare(a.id, b.id));
    const page = paginate(projects, (p) => p.id, input.continuation, tokens);
    return { projects: page.items.map((p) => projectSummary(ctx.graph, p, known)), ...(page.continuation ? { continuation: page.continuation } : {}) };
  },
});
