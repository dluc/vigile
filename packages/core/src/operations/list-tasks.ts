import { z } from "zod";
import { assignees, containedTasks, hasParentTask, isLive, taskCalc, type Known } from "../calc.js";
import { compareTaskIds } from "../ids.js";
import { TASK_STATUSES, TASK_TYPES } from "../model.js";
import { defineRead } from "../operation.js";
import { resolveRef } from "../rules.js";
import { taskSummary } from "../views.js";
import { continuation, isId, paginate } from "./shared.js";

export const listTasks = defineRead({
  name: "list_tasks",
  description:
    "List tasks, without their descriptions, with each one's status, links and calculated state. Filter by project, group, type, status, assignee or problems. For a high-level view ask for top_level, which lists the groups and the ungrouped tasks; a group reports its progress. To zoom into a group pass it as parent. Returns at most 100 per call, ordered by ID. To find work that can start now, use list_next_tasks.",
  access: "all",
  input: z.strictObject({
    project: z.string().optional().describe("Only tasks inside this project, at any depth."),
    parent: z.string().optional().describe("Only tasks inside this task, at any depth. Use it to zoom into one group."),
    top_level: z.boolean().optional().describe("true to list only tasks that are not inside another task: the groups and the ungrouped tasks. Use it for a high-level view."),
    status: z.enum(TASK_STATUSES).optional(),
    type: z.enum(TASK_TYPES).optional().describe("Only tasks of this type: task, bug, issue or incident."),
    assigned_to: z.string().optional().describe("Only tasks assigned to this user: a username or user ID."),
    has_problems: z.boolean().optional().describe("true to list only tasks that have problems."),
    continuation,
  }),
  run(ctx, input) {
    let tasks = input.project !== undefined ? containedTasks(ctx.graph, resolveRef(ctx.graph, input.project, ["project"])) : ctx.graph.all("task").filter(isLive);
    if (input.parent !== undefined) {
      const inside = new Set(containedTasks(ctx.graph, resolveRef(ctx.graph, input.parent, ["task"])).map((t) => t.id));
      tasks = tasks.filter((t) => inside.has(t.id));
    }
    if (input.top_level !== undefined) tasks = tasks.filter((t) => hasParentTask(ctx.graph, t) !== input.top_level);
    if (input.status !== undefined) tasks = tasks.filter((t) => t.status === input.status);
    if (input.type !== undefined) tasks = tasks.filter((t) => t.type === input.type);
    if (input.assigned_to !== undefined) {
      const user = resolveRef(ctx.graph, input.assigned_to, ["user"]);
      tasks = tasks.filter((t) => assignees(ctx.graph, t).some((a) => a.id === user.id));
    }
    // One reading of the plan: what is learnt about a group for one task is not found out again for the next.
    const known: Known = new Map();
    if (input.has_problems !== undefined) tasks = tasks.filter((t) => taskCalc(ctx.graph, t, known).has_problems === input.has_problems);
    tasks.sort((a, b) => compareTaskIds(a.id, b.id));
    const { continuation: token, ...filters } = input;
    const page = paginate(tasks, (t) => t.id, compareTaskIds, token, { question: ["list_tasks", filters], isKey: isId });
    return { tasks: page.items.map((t) => taskSummary(ctx.graph, t, known)), ...(page.continuation ? { continuation: page.continuation } : {}) };
  },
});
