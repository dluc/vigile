import { z } from "zod";
import { containedTasks, taskCalc, type Known } from "../calc.js";
import { defineRead } from "../operation.js";
import { resolveRef } from "../rules.js";
import { taskSummary } from "../views.js";
import { describeList } from "../paging.js";
import { continuation, cursor, paginate, type Cursor } from "./shared.js";

/** Highest priority first, then by ID so that paging is stable. */
type SortKey = [priority: number, id: string];

/**
 * The tokens of a list of tasks that can be started, for the filters it was asked with and for the user who
 * asked: what is next depends on who asks, and a token does not pass from one user to another.
 */
export const nextTasksCursor = (input: Record<string, unknown>, who: string): Cursor<SortKey> => cursor(describeList("list_next_tasks", input, who));

export const listNextTasks = defineRead({
  name: "list_next_tasks",
  description:
    "List the tasks you can start now: open, with nothing unfinished in the way, and either assigned to you or to nobody. Highest priority first; tasks of equal priority come in no meaningful order, so choose among them using value and size. This starts nothing: read the chosen task with get, then call set_task_status with in_progress only when work actually starts.",
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
    // A priority is a number. One that damage left as something else is taken for none, so that the task has a place.
    const key = (t: { priority: number; id: string }): SortKey => [typeof t.priority === "number" && Number.isFinite(t.priority) ? t.priority : 0, t.id];
    const tokens = nextTasksCursor(input, ctx.caller.id);
    tasks.sort((a, b) => tokens.list.compare(key(a), key(b)));
    const page = paginate(tasks, key, input.continuation, tokens);
    return { tasks: page.items.map((t) => taskSummary(ctx.graph, t, known)), ...(page.continuation ? { continuation: page.continuation } : {}) };
  },
});
