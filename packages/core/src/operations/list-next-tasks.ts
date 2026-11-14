import { z } from "zod";
import { containedTasks, taskCalc, type Known } from "../calc.js";
import { compareTaskIds } from "../ids.js";
import { defineRead } from "../operation.js";
import { resolveRef } from "../rules.js";
import { taskSummary } from "../views.js";
import { continuation, isId, paginate } from "./shared.js";

/** Highest priority first, then by ID so that paging is stable. */
type SortKey = [priority: number, id: string];

export const listNextTasks = defineRead({
  name: "list_next_tasks",
  description:
    "List the tasks you can start now: open, with nothing unfinished in the way, and either assigned to you or to nobody. Highest priority first; tasks of equal priority come in no meaningful order, so choose among them using value and size. This starts nothing: call set_task_status with in_progress on the task you pick.",
  access: "all",
  input: z.strictObject({
    project: z.string().optional().describe("Only tasks inside this project, at any depth."),
    parent: z.string().optional().describe("Only tasks inside this task, at any depth: what can start now in one group."),
    continuation,
  }),
  run(ctx, input) {
    const all = input.project !== undefined ? containedTasks(ctx.graph, resolveRef(ctx.graph, input.project, ["project"])) : ctx.graph.all("task");
    const inside = input.parent !== undefined ? new Set(containedTasks(ctx.graph, resolveRef(ctx.graph, input.parent, ["task"])).map((t) => t.id)) : null;
    const known: Known = new Map();
    const tasks = all.filter((task) => {
      if (inside && !inside.has(task.id)) return false;
      const calc = taskCalc(ctx.graph, task, known);
      return calc.is_next && (!calc.is_assigned || calc.assigned_to.some((u) => u.id === ctx.caller.id));
    });
    const order = (a: SortKey, b: SortKey) => b[0] - a[0] || compareTaskIds(a[1], b[1]);
    const key = (t: { priority: number; id: string }): SortKey => [t.priority, t.id];
    tasks.sort((a, b) => order(key(a), key(b)));
    const { continuation: token, ...filters } = input;
    const isKey = (k: unknown): k is SortKey => Array.isArray(k) && k.length === 2 && typeof k[0] === "number" && Number.isFinite(k[0]) && isId(k[1]);
    // What is next depends on who asks: a token does not pass from one user to another.
    const page = paginate(tasks, key, order, token, { question: ["list_next_tasks", filters, ctx.caller.id], isKey });
    return { tasks: page.items.map((t) => taskSummary(ctx.graph, t, known)), ...(page.continuation ? { continuation: page.continuation } : {}) };
  },
});
