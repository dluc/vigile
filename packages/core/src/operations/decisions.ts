import { z } from "zod";
import { isLive } from "../calc.js";
import { taskId } from "../ids.js";
import { DECISION_STATUSES, type DecisionNode } from "../model.js";
import { defineRead, defineWrite } from "../operation.js";
import { describeList } from "../paging.js";
import { requireLive, requireVersion, resolveRef } from "../rules.js";
import { summary } from "../views.js";
import { continuation, cursor, paginate, requiredText, statusEntry, title, touch, version, why } from "./shared.js";

export const createDecision = defineWrite({
  name: "create_decision", access: "all",
  description: "Record a standalone decision. Choose proposed or active explicitly. A project supplies only an ID prefix; it does not determine what the decision affects.",
  input: z.strictObject({ title, description: requiredText, status: z.enum(["proposed", "active"]), project: z.string().optional(), why: why.optional() }),
  run(ctx, input) {
    const project = input.project === undefined ? undefined : resolveRef(ctx.graph, input.project, ["project"]);
    if (project) requireLive(project);
    const node: DecisionNode = { kind: "decision", id: taskId(project?.prefix ?? null, ctx.plan.next("task")), version: 1,
      title: input.title, status: input.status, why: input.why ?? null, created_at: ctx.now, updated_at: ctx.now, created_by: ctx.caller.id, deleted_at: null };
    ctx.plan.put(node, input.description);
    ctx.plan.status(node, statusEntry(node.status, ctx));
    ctx.plan.history(node, "created", { status: node.status });
    return () => summary(ctx.graph, ctx.graph.get("decision", node.id)!);
  },
});

export const updateDecision = defineWrite({
  name: "update_decision", access: "all",
  description: "Amend a decision or explicitly change its status. Withdrawn records remain readable. Changing a decision never changes another item's state.",
  input: z.strictObject({ id: z.string(), version, title: title.optional(), description: requiredText.optional(), why: why.nullable().optional(), status: z.enum(DECISION_STATUSES).optional() }),
  async run(ctx, input) {
    const node = resolveRef(ctx.graph, input.id, ["decision"]);
    requireLive(node);
    requireVersion(node, input.version, () => summary(ctx.graph, node));
    const next = touch(node, ctx, {});
    const changes: Record<string, unknown> = {};
    for (const field of ["title", "why", "status"] as const) {
      const value = input[field];
      if (value !== undefined && value !== node[field]) { Object.assign(next, { [field]: value }); changes[field] = [node[field], value]; }
    }
    let text: string | undefined;
    if (input.description !== undefined) {
      const was = await ctx.readText(node);
      if (input.description !== was) { text = input.description; changes.description = { was }; }
    }
    if (Object.keys(changes).length) {
      ctx.plan.put(next, text);
      ctx.plan.history(node, "updated", { changes });
      if (node.status !== next.status) {
        ctx.plan.status(node, statusEntry(next.status, ctx));
        ctx.plan.history(node, "status_changed", { from: node.status, to: next.status });
      }
    }
    return () => summary(ctx.graph, ctx.graph.get("decision", node.id)!);
  },
});

export const listDecisions = defineRead({
  name: "list_decisions", access: "all", description: "List decisions by ID, optionally filtered by status. Includes standalone decisions and withdrawn records. Returns at most 100 per call.",
  input: z.strictObject({ status: z.enum(DECISION_STATUSES).optional(), continuation }),
  run(ctx, input) {
    const tokens = cursor<string>(describeList("list_decisions", input));
    const nodes = ctx.graph.all("decision").filter(n => isLive(n) && (!input.status || n.status === input.status)).sort((a,b) => tokens.list.compare(a.id,b.id));
    const page = paginate(nodes, n => n.id, input.continuation, tokens);
    return { decisions: page.items.map(n => summary(ctx.graph,n)), ...(page.continuation ? { continuation: page.continuation } : {}) };
  },
});
