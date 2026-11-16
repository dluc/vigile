import { z } from "zod";
import { refused } from "../errors.js";
import { PROJECT_STATUSES } from "../model.js";
import { defineWrite } from "../operation.js";
import { describe, requireLive, requireVersion, resolveRef } from "../rules.js";
import { projectSummary } from "../views.js";
import { statusEntry, touch, version } from "./shared.js";

export const setProjectStatus = defineWrite({
  name: "set_project_status",
  description:
    "Change a project's status: open, in_preview, ready, broken or cancelled. Any move is allowed. Tasks that depend on the project wait until it is ready or cancelled. Marking a project ready while it holds unfinished tasks is allowed and shows up as a problem on the project.",
  access: "all",
  input: z.strictObject({
    id: z.string().describe("The project's ID."),
    version,
    status: z.enum(PROJECT_STATUSES),
  }),
  run(ctx, input) {
    const project = resolveRef(ctx.graph, input.id, ["project"]);
    requireLive(project);
    requireVersion(project, input.version, () => projectSummary(ctx.graph, project));
    if (project.status === input.status) throw refused("same_status", `${describe(project)} is already ${input.status}.`);
    ctx.plan.put(touch(project, ctx, { status: input.status }));
    ctx.plan.status(project, statusEntry(input.status, ctx));
    ctx.plan.history(project, "status_changed", { from: project.status, to: input.status });
    return () => projectSummary(ctx.graph, ctx.graph.get("project", project.id)!);
  },
});
