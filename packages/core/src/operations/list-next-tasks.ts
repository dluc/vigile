import { z } from "zod";
import {
  comparePrioritySegments,
  containedTasks,
  executionPrioritySegment,
  executionRoute,
  priorityPathFrom,
  priorityPathNumbers,
  taskCalc,
  type ExecutionKnown,
  type Known,
  type PriorityPath,
} from "../calc.js";
import { compareTaskIds } from "../ids.js";
import { defineRead } from "../operation.js";
import { resolveRef } from "../rules.js";
import { taskSummary } from "../views.js";
import { describeList } from "../paging.js";
import { continuation, cursor, paginate, type Cursor } from "./shared.js";

/** Shared live path for sorting; plain numbers only when the key crosses the API boundary. */
type SortKey = [path: PriorityPath, id: string];
type TokenKey = [path: number[], id: string];

/**
 * The tokens of a list of tasks that can be started, for the filters it was asked with and for the user who
 * asked: what is next depends on who asks, and a token does not pass from one user to another.
 */
export const nextTasksCursor = (input: Record<string, unknown>, who: string): Cursor<TokenKey> => cursor(describeList("list_next_tasks", input, who));

export const listNextTasks = defineRead({
  name: "list_next_tasks",
  description:
    "List the tasks you can start now: open, with nothing unfinished in the way, inside an active path of projects and groups, and either assigned to you or to nobody. Grouping directs execution: compare priority from the top-level group through each nested group to the task, at the first difference; a group comes before what it contains, and a task in several groups uses its highest active path. Ungrouped tasks use their own priority. Tasks on the same priority path are listed by ID for a stable order; ID is not a priority. Use value and size to choose among them; neither sorts the list. This starts nothing: read the chosen task with get, then call set_task_status with in_progress only when work actually starts.",
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
    const routes: ExecutionKnown = new Map();
    const tasks = all.filter((task) => {
      if (inside && !inside.has(task.id)) return false;
      const calc = taskCalc(ctx.graph, task, known, routes);
      return calc.is_next && (!calc.is_assigned || calc.assigned_to.some((u) => u.id === ctx.caller.id));
    });
    const order = (a: SortKey, b: SortKey) => comparePrioritySegments(a[0], b[0]) || compareTaskIds(a[1], b[1]);
    // Work out each route once. Sorting and finding the continuation compare the shared segments directly; the
    // full array is made only for a key whose serialized length can match a marked token, or one put into a token.
    const ranked = tasks.map((task) => ({ task, key: [executionPrioritySegment(executionRoute(ctx.graph, task, routes))!, task.id] as SortKey }));
    ranked.sort((a, b) => order(a.key, b.key));
    const tokens = nextTasksCursor(input, ctx.caller.id);
    const page = paginate(ranked, (item) => item.key, input.continuation, tokens, {
      compare: order,
      fromToken: ([path, id]) => [priorityPathFrom(path, routes), id] as SortKey,
      toToken: ([path, id]) => [priorityPathNumbers(path), id] as TokenKey,
      tokenLength: ([path, id]) => path.jsonLength + JSON.stringify(id).length + 3,
      identity: ({ task }) => task.id,
    });
    return {
      tasks: page.items.map(({ task, key }) => ({ ...taskSummary(ctx.graph, task, known), priority_path: priorityPathNumbers(key[0]) })),
      ...(page.continuation ? { continuation: page.continuation } : {}),
    };
  },
});
