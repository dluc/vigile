import { z } from "zod";
import { DECISION_STATUSES, type DecisionStatus } from "../model.js";
import { LIMITS, KINDS, PROJECT_STATUSES, TASK_STATUSES, type Kind, type ProjectStatus, type TaskStatus } from "../model.js";
import { isMoment } from "../shape.js";
import { displayId, storageId } from "../records.js";
import { resolveRef } from "../rules.js";
import { describeList } from "../paging.js";
import { defineRead } from "../operation.js";
import { username } from "../views.js";
import { readSteady } from "./steady.js";
import { cursor, continuation, type Cursor } from "./shared.js";

type HistorySortKey = readonly [revision: number, seq: number];

/** The whole input, other than its continuation token, names a History list and its cursor. */
export const historyCursor = (input: Record<string, unknown> = {}): Cursor<HistorySortKey> => cursor(describeList("list_history", input));

const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
const validDateOnly = (value: string): boolean => {
  if (!dateOnly.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const validHistoryBound = (value: string): boolean => (dateOnly.test(value) ? validDateOnly(value) : isMoment(value));
const historyBound = z.string().refine((value) => {
  return validHistoryBound(value);
}, "not a date or moment in time");

const bound = (value: string, endOfDate: boolean): string =>
  dateOnly.test(value) ? `${value}T${endOfDate ? "23:59:59.999" : "00:00:00.000"}Z` : new Date(value).toISOString();

type HistoryStatus = TaskStatus | ProjectStatus | DecisionStatus;
const historyStatuses = [...new Set([...TASK_STATUSES, ...PROJECT_STATUSES, ...DECISION_STATUSES])] as [HistoryStatus, ...HistoryStatus[]];
const historyStatus = z.enum(historyStatuses);

const input = z.strictObject({
  project: z.string().trim().min(1).optional().describe("Only events for this project and items it contains."),
  parent: z.string().trim().min(1).optional().describe("Only events for tasks contained in this group at any depth, not the group itself."),
  text: z.string().trim().min(1).max(128).optional().describe("Only events for items whose ID, current title or username contains this text."),
  kind: z.enum(KINDS).optional().describe("Only events about projects, tasks or users of this kind."),
  actor: z.string().trim().min(1).max(128).optional().describe("Only events recorded by this user's username or ID."),
  action: z.string().trim().min(1).max(64).optional().describe("Only this kind of event, such as status_changed or link_added."),
  status_from: historyStatus.optional().describe("Only status_changed events whose previous status is this task or project status."),
  status_to: historyStatus.optional().describe("Only status_changed events whose new status is this task or project status."),
  from: historyBound.optional().describe("Only events on or after this date or timestamp."),
  to: historyBound.optional().describe("Only events on or before this date or timestamp."),
  continuation,
}).refine((filters) => {
  if (filters.from === undefined || filters.to === undefined || !validHistoryBound(filters.from) || !validHistoryBound(filters.to)) return true;
  return Date.parse(bound(filters.from, false)) <= Date.parse(bound(filters.to, true));
}, {
  path: ["to"],
  message: "The end of the time range cannot be before its start.",
});

export const listHistory = defineRead({
  name: "list_history",
  description:
    "List retained changes across the plan, newest first. Filter by project, group, item ID, current title or username, item kind, actor, action, previous or new task/project status, or time range. A project includes events for items it currently contains, including items in nested groups. A group includes events for tasks it contains at any depth, not the group's own events. Each entry names its item, actor, action and data, and task completion events include elapsed wall-clock duration from creation. Returns at most 100 per call; pass the continuation token unchanged with the same filters to read older changes.",
  access: "all",
  input,
  run(ctx, filters) {
    const tokens = historyCursor(filters);
    const before = filters.continuation === undefined ? undefined : tokens.place(filters.continuation, () => []);
    return readSteady(ctx, async (graph) => {
      const project = filters.project === undefined ? undefined : storageId("project", resolveRef(graph, filters.project, ["project"]).id);
      const parent = filters.parent === undefined ? undefined : storageId("task", resolveRef(graph, filters.parent, ["task"]).id);
      let actor: string | undefined;
      if (filters.actor !== undefined) {
        try {
          actor = storageId("user", resolveRef(graph, filters.actor, ["user"]).id);
        } catch (error) {
          // A permanently deleted actor has no graph node, but their stored USER ID remains a useful history filter.
          const normalized = /^USER-\d+$/i.test(filters.actor) ? filters.actor.toUpperCase().replace(/^USER-0*(?=\d)/, "USER-") : null;
          if (!normalized) throw error;
          actor = storageId("user", normalized);
        }
      }
      const page = await ctx.readHistoryFeedPage({
        ...(project === undefined ? {} : { project }),
        ...(parent === undefined ? {} : { parent }),
        ...(filters.text === undefined ? {} : { text: filters.text }),
        ...(filters.kind === undefined ? {} : { kind: filters.kind }),
        ...(actor === undefined ? {} : { actor }),
        ...(filters.action === undefined ? {} : { action: filters.action }),
        ...(filters.status_from === undefined ? {} : { statusFrom: filters.status_from }),
        ...(filters.status_to === undefined ? {} : { statusTo: filters.status_to }),
        ...(filters.from === undefined ? {} : { from: bound(filters.from, false) }),
        ...(filters.to === undefined ? {} : { to: bound(filters.to, true) }),
        ...(before === undefined ? {} : { before: { revision: before[0], seq: before[1] } }),
        limit: LIMITS.page,
      });
      const changes = page.records.map((record) => {
        const kind = record.kind as Kind;
        const id = displayId(kind, record.id);
        const item = (KINDS as readonly string[]).includes(kind) ? graph.get(kind, id) : undefined;
        const by = username(graph, displayId("user", record.actor));
        const start = item?.kind === "task" ? Date.parse(item.created_at) : NaN;
        const completedAt = Date.parse(record.completion_at ?? record.at);
        const duration_ms = item?.kind === "task" && record.action === "status_changed" && record.data.to === "done" && Number.isFinite(start) && completedAt >= start
          ? completedAt - start
          : undefined;
        return {
          kind: record.kind,
          id,
          title: item ? (item.kind === "user" ? item.username : item.title) : null,
          at: record.at,
          by,
          action: record.action,
          data: record.data,
          ...(duration_ms === undefined ? {} : { duration_ms }),
          place: [record.revision, record.seq] as const,
        };
      });
      const next = page.hasMore && changes.length ? tokens.after(changes.at(-1)!.place) : undefined;
      return {
        stored: true,
        finish: () => ({ changes, ...(next ? { continuation: next } : {}) }),
      };
    });
  },
});
