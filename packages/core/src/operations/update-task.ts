import { z } from "zod";
import type { TaskNode } from "../model.js";
import { defineWrite } from "../operation.js";
import { requireLive, requireVersion, resolveRef } from "../rules.js";
import { taskSummary } from "../views.js";
import { priority, requiredText, size, taskType, title, touch, value, version, why } from "./shared.js";

export const updateTask = defineWrite({
  name: "update_task",
  description:
    "Change a task's title, type, description, reason (why), priority, value or size. Send only the fields to change. To change the status use set_task_status; to change what it depends on, which group or project contains it, or who it is assigned to, use add_link and remove_link.",
  access: "all",
  input: z.strictObject({
    id: z.string().describe("The task's ID."),
    version,
    title: title.optional(),
    type: taskType.optional(),
    description: requiredText.optional(),
    why: why.nullable().optional().describe("Why this work matters: at least one reason, more if there are several. null clears it."),
    priority: priority.optional(),
    value: value.nullable().optional().describe("null clears the value."),
    size: size.nullable().optional().describe("null clears the size."),
  }),
  async run(ctx, input) {
    const task = resolveRef(ctx.graph, input.id, ["task"]);
    requireLive(task);
    requireVersion(task, input.version, () => taskSummary(ctx.graph, task));

    const changes: Partial<TaskNode> = {};
    const record: Record<string, unknown> = {};
    for (const field of ["title", "type", "priority", "value", "size"] as const) {
      const next = input[field];
      if (next === undefined || next === task[field]) continue;
      (changes as Record<string, unknown>)[field] = next;
      record[field] = [task[field], next];
    }
    // Of a text that is rewritten the history keeps what it was: the new text is on the task itself, and the
    // old one would otherwise be gone.
    if (input.why !== undefined && input.why !== task.why) {
      changes.why = input.why;
      record.why = { was: task.why };
    }
    let description: string | undefined;
    if (input.description !== undefined) {
      const was = await ctx.readText(task);
      if (input.description !== was) {
        description = input.description;
        record.description = { was };
      }
    }
    if (Object.keys(record).length) {
      ctx.plan.put(touch(task, ctx, changes), description);
      ctx.plan.history(task, "updated", { changes: record });
    }
    return () => taskSummary(ctx.graph, ctx.graph.get("task", task.id)!);
  },
});
