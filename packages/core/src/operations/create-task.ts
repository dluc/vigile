import { z } from "zod";
import { refused } from "../errors.js";
import { sameRef } from "../graph.js";
import { refText, taskId, taskPrefix } from "../ids.js";
import { ASSIGNED_TO, CONTAINS, DEPENDS_ON } from "../link-types.js";
import { LIMITS, type Node, type TaskNode } from "../model.js";
import { defineWrite } from "../operation.js";
import { describe, errorItem, loopPath, requireLive, resolveRef } from "../rules.js";
import { taskSummary } from "../views.js";
import { linkView } from "./links.js";
import { newLink, parentTask, priority, requiredText, size, statusEntry, taskType, title, unique, value, why } from "./shared.js";

export const createTask = defineWrite({
  name: "create_task",
  description:
    "Create a task. It starts as open, ready to be worked on, unless created as a draft. Say why the work matters when you know. Give the project to place it in, and the tasks or projects it depends on, in the same call. When the work has several steps, consider grouping them: create one task for the feature or epic, then create each step with parent set to it. Grouping is optional. Set type to bug, issue or incident for a problem, so it stands out from planned work. The ID is assigned by the service: the project's prefix followed by a number.",
  access: "all",
  input: z.strictObject({
    title,
    description: requiredText.describe("What needs to be done and how to tell it is finished. Required."),
    why: why.optional(),
    type: taskType.optional(),
    project: z.string().optional().describe("The ID of the project that contains the task."),
    parent: parentTask.optional(),
    priority: priority.optional(),
    value: value.optional(),
    size: size.optional(),
    depends_on: z
      .array(z.string())
      .max(LIMITS.linksPerCreate)
      .optional()
      .describe("IDs of tasks or projects that must be finished before this task can start."),
    assigned_to: z.array(z.string()).max(LIMITS.linksPerCreate).optional().describe("Usernames or IDs of the users who will work on it."),
    draft: z.boolean().optional().describe("true to create it as a draft: not ready to start, and never listed as next."),
  }),
  run(ctx, input) {
    const holders: Node[] = [];
    const project = input.project !== undefined ? resolveRef(ctx.graph, input.project, ["project"]) : undefined;
    const parent = input.parent !== undefined ? resolveRef(ctx.graph, input.parent, ["task"]) : undefined;
    for (const holder of [project, parent]) {
      if (!holder) continue;
      requireLive(holder);
      holders.push(holder);
    }
    const dependencies = unique((input.depends_on ?? []).map((ref) => resolveRef(ctx.graph, ref, ["task", "project"])));
    dependencies.forEach(requireLive);
    const users = unique((input.assigned_to ?? []).map((ref) => resolveRef(ctx.graph, ref, ["user"])));
    users.forEach(requireLive);

    // The task does not exist yet, so a loop can only run from a dependency back to one of its containers.
    for (const holder of holders) {
      for (const dependency of dependencies) {
        const path = sameRef(holder, dependency) ? [holder, dependency] : loopPath(ctx.graph, holder, dependency);
        if (!path) continue;
        throw refused(
          "loop",
          `The task would be inside ${describe(holder)} and also depend on ${describe(dependency)}, which cannot finish before ${describe(holder)} does. Neither could ever finish.`,
          { blocking: [errorItem(holder), errorItem(dependency)], actions: ["Leave out that dependency, or place the task somewhere else."] },
        );
      }
    }

    const prefix = project?.prefix ?? (parent ? taskPrefix(parent.id) : null);
    const status = input.draft ? "draft" : "open";
    const task: TaskNode = {
      kind: "task",
      id: taskId(prefix, ctx.plan.next("task")),
      title: input.title,
      type: input.type ?? "task",
      status,
      priority: input.priority ?? 0,
      value: input.value ?? null,
      size: input.size ?? null,
      why: input.why ?? null,
      timeline: [statusEntry(status, ctx)],
      version: 1,
      created_at: ctx.now,
      created_by: ctx.caller.id,
      updated_at: ctx.now,
      deleted_at: null,
    };
    ctx.plan.put(task, input.description);
    for (const holder of holders) ctx.plan.link(newLink(ctx, holder, CONTAINS, task));
    for (const dependency of dependencies) ctx.plan.link(newLink(ctx, task, DEPENDS_ON, dependency));
    for (const user of users) ctx.plan.link(newLink(ctx, task, ASSIGNED_TO, user));
    ctx.plan.history(task, "created", {
      status,
      ...(task.type !== "task" ? { type: task.type } : {}),
      ...(holders.length ? { contained_in: holders.map(refText) } : {}),
      ...(dependencies.length ? { depends_on: dependencies.map(refText) } : {}),
      ...(users.length ? { assigned_to: users.map((u) => u.username) } : {}),
    });
    // What the task was put into, and what it waits for, say so in their own history.
    for (const holder of holders) ctx.plan.history(holder, "link_added", linkView({ from: holder, type: CONTAINS, to: task }));
    for (const dependency of dependencies) ctx.plan.history(dependency, "link_added", linkView({ from: task, type: DEPENDS_ON, to: dependency }));
    return () => taskSummary(ctx.graph, ctx.graph.get("task", task.id)!);
  },
});
