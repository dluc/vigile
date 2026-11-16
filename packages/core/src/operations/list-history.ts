import { z } from "zod";
import { LIMITS, KINDS, type Kind } from "../model.js";
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

const input = z.strictObject({
  project: z.string().trim().min(1).optional().describe("Only events for this project and items it contains."),
  kind: z.enum(KINDS).optional().describe("Only events about projects, tasks or users of this kind."),
  actor: z.string().trim().min(1).max(128).optional().describe("Only events recorded by this user's username or ID."),
  action: z.string().trim().min(1).max(64).optional().describe("Only this kind of event, such as status_changed or link_added."),
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
    "List retained changes across the plan, newest first. Filter by project, item kind, actor, action or time range. A project includes events for items it currently contains, including items in nested groups. Each entry names its item, actor, action and data. Returns at most 100 per call; pass the continuation token unchanged with the same filters to read older changes.",
  access: "all",
  input,
  run(ctx, filters) {
    const tokens = historyCursor(filters);
    const before = filters.continuation === undefined ? undefined : tokens.place(filters.continuation, () => []);
    return readSteady(ctx, async (graph) => {
      const project = filters.project === undefined ? undefined : storageId("project", resolveRef(graph, filters.project, ["project"]).id);
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
        ...(filters.kind === undefined ? {} : { kind: filters.kind }),
        ...(actor === undefined ? {} : { actor }),
        ...(filters.action === undefined ? {} : { action: filters.action }),
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
        return {
          kind: record.kind,
          id,
          title: item ? (item.kind === "user" ? item.username : item.title) : null,
          at: record.at,
          by,
          action: record.action,
          data: record.data,
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
