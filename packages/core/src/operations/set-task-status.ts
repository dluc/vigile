import { z } from "zod";
import { assignees } from "../calc.js";
import { ASSIGNED_TO } from "../link-types.js";
import { TASK_STATUSES } from "../model.js";
import { defineWrite } from "../operation.js";
import { checkTaskMove, requireLive, requireVersion, resolveRef } from "../rules.js";
import { taskSummary } from "../views.js";
import { newLink, statusEntry, touch, version } from "./shared.js";

export const setTaskStatus = defineWrite({
  name: "set_task_status",
  description:
    "Change a task's status: draft, open, in_progress, paused, in_review, done or cancelled. Use in_progress only while implementation is actively under way. When implementation is complete, use in_review through review, merge, release and post-release verification, including after review ends. Use done only once the outcome is shipped and verified, and paused when work stops unfinished. Moves the rules do not allow are refused, and the error says what is in the way and what to do. A task cannot be started or marked done while something it depends on is unfinished. Starting an unassigned task assigns it to you; only an assignee may start assigned work, so taking it over requires changing its assigned-to link first. A task already in progress cannot be started again, so two agents cannot take the same task.",
  access: "all",
  input: z.strictObject({
    id: z.string().describe("The task's ID."),
    version,
    status: z.enum(TASK_STATUSES),
  }),
  run(ctx, input) {
    const task = resolveRef(ctx.graph, input.id, ["task"]);
    requireLive(task);
    requireVersion(task, input.version, () => taskSummary(ctx.graph, task));
    checkTaskMove(ctx.graph, task, input.status, ctx.caller);

    // The task says what its status is and, when that is done, since when; the timeline gets one entry more.
    // Neither grows with the changes that came before.
    ctx.plan.put(touch(task, ctx, { status: input.status, completed_at: input.status === "done" ? ctx.now : null }));
    ctx.plan.status(task, statusEntry(input.status, ctx));
    const takes = input.status === "in_progress" && assignees(ctx.graph, task).length === 0;
    if (takes) ctx.plan.link(newLink(ctx, task, ASSIGNED_TO, ctx.caller));
    ctx.plan.history(task, "status_changed", { from: task.status, to: input.status, ...(takes ? { assigned_to: ctx.caller.username } : {}) });
    return () => taskSummary(ctx.graph, ctx.graph.get("task", task.id)!);
  },
});
