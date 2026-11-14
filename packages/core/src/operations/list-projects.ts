import { z } from "zod";
import { isLive, projectCalc, type Known } from "../calc.js";
import { compareProjectIds } from "../ids.js";
import { defineRead } from "../operation.js";
import { projectSummary } from "../views.js";
import { continuation, isId, paginate } from "./shared.js";

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
    projects.sort((a, b) => compareProjectIds(a.id, b.id));
    const { continuation: token, ...filters } = input;
    const page = paginate(projects, (p) => p.id, compareProjectIds, token, { question: ["list_projects", filters], isKey: isId });
    return { projects: page.items.map((p) => projectSummary(ctx.graph, p, known)), ...(page.continuation ? { continuation: page.continuation } : {}) };
  },
});
