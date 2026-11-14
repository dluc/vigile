import { z } from "zod";
import { invalidInput, refused } from "../errors.js";
import type { StatusEntry } from "../model.js";
import { defineWrite } from "../operation.js";
import { describe, requireLive, requireVersion, resolveRef } from "../rules.js";
import { summary } from "../views.js";
import { touch, version } from "./shared.js";

/** A date and a time, with the zone it is in: 2026-03-14T09:30:00Z or 2026-03-14T10:30:00+01:00. */
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const EXAMPLE = "2026-03-14T09:30:00Z";
const EARLIEST = "1970-01-01T00:00:00.000Z";

/**
 * The moment a text names, as the service writes moments, or null when the text is not a real date and time.
 * The parts are checked one by one: left to itself, the language takes the 30th of February for the 2nd of March.
 */
function moment(value: string): string | null {
  const parts = TIMESTAMP.exec(value);
  if (!parts) return null;
  const [year, month, day, hour, minute, second, zoneHours, zoneMinutes] = parts.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  const days = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  if (month! < 1 || month! > 12 || day! < 1 || day! > days || hour! > 23 || minute! > 59 || second! > 59 || zoneHours! > 14 || zoneMinutes! > 59) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

const before = (a: string, b: string): boolean => Date.parse(a) < Date.parse(b);

export const overrideTimestamp = defineWrite({
  name: "override_timestamp",
  description:
    'For importing work that was created or finished somewhere else: set when a project or task was really created (name "created_at"), or when a task that is done was really completed (name "completed_at"). The service normally records these itself, as the moment of the call; use this only to carry over dates from the tool the work comes from, never to adjust the dates of work done here. The value is a date and time with its zone, such as 2026-03-14T09:30:00Z. It is refused when it is not a real date or is before 1970, when it is in the future, when a completion would come before the creation or before an earlier completion of the same task, when the creation would come after the moment the item was recorded here or after a later status change, and when the task is not done. When both dates are to be set, set created_at first. Setting completed_at earlier also moves the status changes between creation and completion that would otherwise come after it. The change is recorded in the item\'s history with the old and the new value and who made it.',
  access: "all",
  input: z.strictObject({
    kind: z.enum(["project", "task"]).optional().describe('"project" or "task". Needed only when the ID alone is ambiguous.'),
    id: z.string().describe("The ID of the task or project."),
    version,
    name: z.enum(["created_at", "completed_at"]).describe('Which timestamp to set: "created_at", or "completed_at" for a task that is done.'),
    value: z.string().describe(`The date and time it really happened, with its zone, for example ${EXAMPLE}.`),
  }),
  async run(ctx, input) {
    const node = resolveRef(ctx.graph, input.id, input.kind ? [input.kind] : ["project", "task"]);
    requireLive(node);
    requireVersion(node, input.version, () => summary(ctx.graph, node));

    const at = moment(input.value);
    if (at === null) {
      throw invalidInput(`"${input.value}" is not a date and time.`, [`Give a real date, the time and the zone, for example ${EXAMPLE}.`]);
    }
    // The service writes moments in one form, which years before 1970 and after 9999 do not fit; no work that is
    // carried over is that old.
    if (before(at, EARLIEST)) {
      throw invalidInput(`"${input.value}" is before 1970, which is earlier than any date the service keeps.`, ["Give the date and time it really happened."]);
    }
    if (before(ctx.now, at)) {
      throw refused("timestamp_in_future", `${describe(node)} cannot have its ${input.name} set to ${at}: that is in the future. It is now ${ctx.now}.`, {
        actions: ["Give the date and time it really happened."],
      });
    }

    let timeline: StatusEntry[];
    let old: string;
    let moved = 0;
    if (input.name === "created_at") {
      old = node.created_at;
      // What is carried over from another tool happened before the item was recorded here.
      // The last "created" of its history: in data from before a prefix was given only once, an earlier project
      // that was deleted for good may have had the same ID, and its history was kept.
      const recorded = (await ctx.readHistory(node)).findLast((entry) => entry.action === "created")?.at;
      if (recorded !== undefined && before(recorded, at)) {
        throw refused("created_after_recorded", `${describe(node)} cannot have been created on ${at}: it was recorded here on ${recorded}, before that.`, {
          actions: [`Give a creation date at or before ${recorded}.`],
        });
      }
      // Whatever happened to the item happened after it was created.
      const next = node.timeline.slice(1).reduce<string | null>((first, entry) => (first === null || before(entry.at, first) ? entry.at : first), null);
      if (next !== null && before(next, at)) {
        const completed = node.kind === "task" && node.status === "done";
        throw refused("created_after_change", `${describe(node)} cannot have been created on ${at}: its status changed on ${next}, before that.`, {
          actions: [`Give a creation date at or before ${next}.`, ...(completed ? ['If the completion date is wrong too, set this first and "completed_at" after it.'] : [])],
        });
      }
      // The first entry of the timeline is the status the item was created with: it moves with the creation.
      timeline = node.timeline.map((entry, index) => (index === 0 ? { ...entry, at } : entry));
    } else {
      if (node.kind !== "task" || node.status !== "done") {
        throw refused("not_completed", `${describe(node)} has no completion date: ${node.kind === "task" ? `its status is ${node.status}` : "only tasks are completed"}.`, {
          actions: node.kind === "task" ? ["Mark it done with set_task_status first, then set when it was really completed."] : ['Use name "created_at" for a project.'],
        });
      }
      // A task can be completed more than once; the last time is its completion date.
      const last = node.timeline.findLastIndex((entry) => entry.status === "done");
      old = node.timeline[last]!.at;
      if (before(at, node.created_at)) {
        throw refused("completed_before_created", `${describe(node)} cannot have been completed on ${at}: it was created on ${node.created_at}, after that.`, {
          actions: [`Give a completion date at or after ${node.created_at}.`, 'Or set when it was really created first: override_timestamp with name "created_at".'],
        });
      }
      // A task that was completed before, reopened and completed again keeps its earlier completion as it was:
      // the new date cannot come before it.
      const earlier = node.timeline.slice(0, last).findLastIndex((entry) => entry.status === "done");
      if (earlier >= 0 && before(at, node.timeline[earlier]!.at)) {
        throw refused("completed_before_earlier_completion", `${describe(node)} cannot have been completed on ${at}: it was completed once before, on ${node.timeline[earlier]!.at}, and reopened.`, {
          actions: [`Give a completion date at or after ${node.timeline[earlier]!.at}.`],
        });
      }
      // What happened on the way to this completion cannot come after it: an import stamps those steps with the
      // moment of the import, and they move back with it. Nothing up to an earlier completion is touched.
      timeline = node.timeline.map((entry, index) => {
        if (index === last) return { ...entry, at };
        if (index === 0 || index <= earlier || index > last || !before(at, entry.at)) return entry;
        moved++;
        return { ...entry, at };
      });
    }

    if (old !== at) {
      ctx.plan.put(touch(node, ctx, input.name === "created_at" ? { created_at: at, timeline } : { timeline }));
      ctx.plan.history(node, "timestamp_overridden", { changes: { [input.name]: [old, at] }, ...(moved ? { earlier_changes_moved: moved } : {}) });
    }
    return () => summary(ctx.graph, ctx.graph.node(node)!);
  },
});
