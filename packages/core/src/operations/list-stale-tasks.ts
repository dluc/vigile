import { z } from "zod";
import { assignees, containedTasks, isLive, type Known } from "../calc.js";
import { describeList } from "../paging.js";
import { defineRead } from "../operation.js";
import { resolveRef } from "../rules.js";
import { taskSummary } from "../views.js";
import { continuation, cursor, paginate, type Cursor } from "./shared.js";

/** A claim is brought to attention after a full day without a recorded change; it is never released by time. */
export const STALE_CLAIM_MS = 24 * 60 * 60 * 1000;

/** Oldest activity first, then by ID so paging is stable. */
type SortKey = [quietSince: string, id: string];

export const staleTasksCursor = (input: Record<string, unknown> = {}): Cursor<SortKey> => cursor(describeList("list_stale_tasks", input));

export const listStaleTasks = defineRead({
  name: "list_stale_tasks",
  description:
    "List assigned tasks that are still in progress after 24 hours without a recorded change to the task. Oldest activity comes first. This only brings a quiet claim to attention: it never releases or reassigns work. A takeover still requires explicit assigned-to link changes. Each entry says quiet_since, the last recorded task change, and attention_since, when the 24-hour threshold passed. Returns at most 100 per call; pass the continuation token unchanged with the same filters to read on.",
  access: "all",
  input: z.strictObject({
    project: z.string().optional().describe("Only quiet claims inside this project, at any depth."),
    parent: z.string().optional().describe("Only quiet claims inside this task, at any depth."),
    continuation,
  }),
  run(ctx, input) {
    const now = Date.parse(ctx.now);
    const cutoff = now - STALE_CLAIM_MS;
    const all = input.project !== undefined ? containedTasks(ctx.graph, resolveRef(ctx.graph, input.project, ["project"])) : ctx.graph.all("task");
    const inside = input.parent !== undefined ? new Set(containedTasks(ctx.graph, resolveRef(ctx.graph, input.parent, ["task"])).map((task) => task.id)) : null;
    const tasks = all.filter((task) => isLive(task) && (!inside || inside.has(task.id)) && task.status === "in_progress" && assignees(ctx.graph, task).length > 0 && Date.parse(task.updated_at) <= cutoff);
    const key = (task: { updated_at: string; id: string }): SortKey => [task.updated_at, task.id];
    const tokens = staleTasksCursor(input);
    tasks.sort((a, b) => tokens.list.compare(key(a), key(b)));
    const page = paginate(tasks, key, input.continuation, tokens);
    const known: Known = new Map();
    return {
      attention_after_hours: STALE_CLAIM_MS / (60 * 60 * 1000),
      claims: page.items.map((task) => ({
        ...taskSummary(ctx.graph, task, known),
        quiet_since: task.updated_at,
        attention_since: new Date(Date.parse(task.updated_at) + STALE_CLAIM_MS).toISOString(),
      })),
      ...(page.continuation ? { continuation: page.continuation } : {}),
    };
  },
});
