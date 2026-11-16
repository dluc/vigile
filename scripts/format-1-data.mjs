// Writes packages/cli/src/format-1-data.ts: a data file as the last version that wrote data format 1 leaves it,
// and what that version answers when asked for everything in it. The tests bring the file to the present format
// and hold the present version to those answers.
//
// It has to run on a built checkout of the last version that wrote data format 1:
//
//   cd <format-1-checkout> && pnpm install --frozen-lockfile && pnpm build
//   node scripts/format-1-data.mjs <format-1-checkout> > packages/cli/src/format-1-data.ts
//
// The plan it makes holds what a timeline can be: of one entry and of more than a page, of a task completed once,
// completed twice, completed and reopened, with dates carried over that moved the changes before them, of items
// that are deleted, and of one that was deleted for good and left only its prefix behind.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
if (!root) throw new Error("Give the folder of a built checkout of the version that wrote data format 1.");
const { Engine, MemoryKeyStore } = await import(pathToFileURL(resolve(root, "packages/core/dist/index.js")).href);
const { SqliteStorage } = await import(pathToFileURL(resolve(root, "packages/storage-sqlite/dist/index.js")).href);

const directory = mkdtempSync(join(tmpdir(), "vigile-format-1-"));
// A second passes with every look at the clock while the plan is made; afterwards the clock moves only when told.
let tick = Date.parse("2026-02-01T08:00:00.000Z");
let passes = 1000;
const clock = { now: () => new Date((tick += passes)) };
const keys = new MemoryKeyStore();
// A key that is the same each time this is run, so that the file is.
let made = 0;
keys.create = () => `vig_fixture_${++made}`;
const engine = await Engine.open({ storage: new SqliteStorage({ directory }), clock, keys });
const as = (username) => (operation, input = {}) => engine.execute(operation, username, input);
const agent = as("agent1");
const admin = as("admin");
const person = as("user");
const task = (title, extra = {}) => ({ title, description: `Do: ${title}`, ...extra });
/** Moves a task through statuses, one after the other, from the version it is at. */
async function through(id, statuses, by = agent) {
  let { version } = await agent("get", { kind: "task", id });
  for (const status of statuses) ({ version } = await by("set_task_status", { id, version, status }));
  return version;
}
const later = (at, ms) => new Date(Date.parse(at) + ms).toISOString();
const timelineOf = async (id) => (await agent("get", { kind: "task", id })).timeline;

await admin("create_user", { username: "bob", type: "person" });
await admin("create_user", { username: "carol", type: "agent" });
await admin("delete", { kind: "user", id: "carol", version: 1 });

// Projects: one that went through every status and had its creation carried over, one without a prefix that
// has only the status it was created with, and one that was deleted for good.
await agent("create_project", { title: "Imported work", description: "Brought in from the old tracker.", prefix: "abc" });
let version = 1;
for (const status of ["in_preview", "ready", "broken", "open", "ready"]) ({ version } = await person("set_project_status", { id: "ABC", version, status }));
await agent("override_timestamp", { kind: "project", id: "ABC", version, name: "created_at", value: "2025-01-10T12:00:00+01:00" });
const numbered = await agent("create_project", { title: "No prefix" });
await agent("override_timestamp", { kind: "project", id: numbered.id, version: 1, name: "created_at", value: "2025-06-01T00:00:00Z" });
await agent("create_project", { title: "Gone", prefix: "xyz" });
const gone = await agent("set_project_status", { id: "XYZ", version: 1, status: "broken" });
await admin("delete", { kind: "project", id: "XYZ", version: gone.version, permanent: true });

// Completed once, as an import leaves it; then both dates carried over, which moves the start with the completion.
const once = await agent("create_task", task("Finished last spring", { project: "ABC", why: "It was promised.", value: 3, size: 2 }));
version = await through(once.id, ["in_progress", "done"]);
({ version } = await agent("override_timestamp", { id: once.id, version, name: "created_at", value: "2025-03-01T09:00:00Z" }));
await agent("override_timestamp", { id: once.id, version, name: "completed_at", value: "2025-04-15T18:30:00+02:00" });

// Completed, reopened and completed again. The second completion is set to just after the reopening, which moves
// the three changes on the way to it and none from before; then set later, which moves only itself.
const twice = await agent("create_task", task("Done twice", { project: "ABC", priority: 2 }));
version = await through(twice.id, ["in_progress", "in_review", "done", "open", "in_progress", "paused", "in_progress", "done"], person);
const reopened = (await timelineOf(twice.id))[4].at;
({ version } = await agent("override_timestamp", { id: twice.id, version, name: "completed_at", value: later(reopened, 500) }));
await agent("override_timestamp", { id: twice.id, version, name: "completed_at", value: later(reopened, 1500) });

// More changes of status than a page holds.
const busy = await agent("create_task", task("Back and forth", { project: "ABC" }));
await through(busy.id, Array.from({ length: 105 }, (_, n) => (n % 2 ? "open" : "draft")));

// Started, which assigns it, paused, and deleted.
const aside = await agent("create_task", task("Set aside", { project: "ABC" }));
version = await through(aside.id, ["in_progress", "paused"]);
await agent("delete", { id: aside.id, version });

// In no project: cancelled, and taken up again as a draft.
const loose = await agent("create_task", task("Loose end"));
await through(loose.id, ["cancelled", "draft"]);

// A group that is done, with one task done and one cancelled inside.
const group = await agent("create_task", task("A group", { project: "ABC" }));
const inside = await agent("create_task", task("Inside, done", { parent: group.id }));
const dropped = await agent("create_task", task("Inside, dropped", { parent: group.id }));
await through(inside.id, ["done"]);
await through(dropped.id, ["cancelled"]);
await through(group.id, ["in_progress", "done"]);

// A bug, created as a draft, assigned, waiting for another task, and changed afterwards.
const bug = await agent("create_task", task("A bug", { project: "ABC", type: "bug", draft: true, assigned_to: ["bob"], depends_on: [busy.id] }));
await agent("update_task", { id: bug.id, version: 1, title: "A bug, renamed", priority: 5 });

// Created and deleted for good: nothing of it stays.
const never = await agent("create_task", task("Never mind", { project: "ABC" }));
await admin("delete", { id: never.id, version: 1, permanent: true });

// Completed and reopened: it has a completion in its timeline and is not done.
const again = await agent("create_task", task("Completed, then reopened", { project: "ABC" }));
await through(again.id, ["done", "open"]);

// Completed, with the completion set to a later moment than the service recorded.
const late = await agent("create_task", task("Completed later than recorded", { project: numbered.id }));
version = await through(late.id, ["in_progress", "in_review", "done"]);
await agent("override_timestamp", { id: late.id, version, name: "completed_at", value: later((await timelineOf(late.id))[3].at, 800) });

// Deleted and brought back, done all the while.
const back = await agent("create_task", task("Deleted and restored"));
version = await through(back.id, ["done"]);
await agent("delete", { id: back.id, version });
await agent("restore", { id: back.id });

// What the version that wrote the file answers: every item in full, and every list to its end.
async function all(operation, field, input = {}) {
  const found = [];
  let continuation;
  do {
    const page = await agent(operation, { ...input, ...(continuation ? { continuation } : {}) });
    found.push(...page[field]);
    continuation = page.continuation;
  } while (continuation);
  return found;
}
const db = new DatabaseSync(join(directory, "default.sqlite"));
const items = db.prepare("SELECT kind, id FROM objects ORDER BY kind, id").all();
const answers = { get: {}, lists: {} };
for (const { kind, id } of items) {
  const shown = kind === "user" ? `USER-${String(id).padStart(3, "0")}` : id;
  answers.get[`${kind} ${shown}`] = await agent("get", { kind, id: shown, history: true });
}
answers.lists.tasks = await all("list_tasks", "tasks");
answers.lists.done = await all("list_tasks", "tasks", { status: "done" });
answers.lists.projects = await all("list_projects", "projects");
answers.lists.next = await all("list_next_tasks", "tasks");
answers.lists.users = (await agent("list_users")).users;

// The file, as the statements that make it again: its tables as it defines them, and every row of each.
const quoted = (value) => (value === null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`);
const sql = db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all().map((row) => row.sql);
for (const table of ["head", "objects", "links", "history"]) {
  for (const row of db.prepare(`SELECT * FROM ${table}`).all()) sql.push(`INSERT INTO ${table} VALUES (${Object.values(row).map(quoted).join(", ")})`);
}
db.close();

// What the version that wrote the file does next with it, call by call, a minute apart: changes of status, dates
// carried over and the refusals of both, deletes for good. The present version, started on the file, has to do
// the same with the same calls.
tick = Date.parse("2026-03-01T00:00:00.000Z");
passes = 0;
const then = [];
async function step(username, operation, input) {
  tick += 60_000;
  try {
    const answer = await engine.execute(operation, username, input);
    then.push({ as: username, operation, input, answer });
    return answer;
  } catch (error) {
    then.push({ as: username, operation, input, refusal: error.toJSON() });
    return undefined;
  }
}
const read = (kind, id) => step("agent1", "get", { kind, id, history: true });
const at = (ms) => new Date(tick + ms).toISOString();
const versionOf = async (kind, id) => (await agent("get", { kind, id })).version;
const override = async (kind, id, name, value) => step("agent1", "override_timestamp", { kind, id, version: await versionOf(kind, id), name, value });
const status = async (id, to, username = "agent1") => step(username, "set_task_status", { id, version: await versionOf("task", id), status: to });

// One more change on the task with the long timeline.
await status(busy.id, "open");
await read("task", busy.id);
// The task that was completed twice: its second completion cannot go before the first, can go to the very
// moment of the first, which moves everything since, and its creation cannot go after its first change.
const first = (await timelineOf(twice.id))[3].at;
await override("task", twice.id, "completed_at", later(first, -1));
await override("task", twice.id, "completed_at", first);
await read("task", twice.id);
await override("task", twice.id, "created_at", later((await timelineOf(twice.id))[1].at, 1));
await override("task", twice.id, "created_at", "2025-12-24T10:00:00-05:00");
await override("task", twice.id, "completed_at", "2025-12-24T09:59:59-05:00");
await override("task", twice.id, "completed_at", at(60_001));
await override("task", twice.id, "completed_at", "2026-02-30T00:00:00Z");
await read("task", twice.id);
// Reopened once more and completed a third time: only what led to the third completion moves with it.
await status(twice.id, "open", "user");
await override("task", twice.id, "completed_at", at(0));
await status(twice.id, "in_progress", "user");
await status(twice.id, "in_review", "user");
await status(twice.id, "done", "user");
await override("task", twice.id, "completed_at", at(-150_000));
await read("task", twice.id);
// The task that was completed and reopened has no completion to set, until it is done again.
await override("task", again.id, "completed_at", at(-1000));
await status(again.id, "in_progress");
await status(again.id, "done");
await override("task", again.id, "completed_at", later((await timelineOf(again.id))[1].at, -1));
await override("task", again.id, "completed_at", at(-90_000));
await override("task", again.id, "created_at", at(0));
await read("task", again.id);
// The task completed once: its creation cannot go after the moment it was recorded here, nor after its first change.
await override("task", once.id, "created_at", "2026-02-10T00:00:00Z");
await override("task", once.id, "created_at", "2025-05-01T00:00:00Z");
await override("task", once.id, "completed_at", "2025-02-28T00:00:00Z");
await override("task", once.id, "created_at", "2025-02-01T00:00:00Z");
await override("task", once.id, "completed_at", "2025-02-28T00:00:00Z");
await read("task", once.id);
// Projects: a creation after a later change of status is refused, and a project has no completion.
await override("project", "ABC", "created_at", "2026-02-01T09:00:00Z");
await override("project", "ABC", "completed_at", "2025-01-01T00:00:00Z");
await override("project", "ABC", "created_at", "2024-12-31T23:59:59.5Z");
await step("user", "set_project_status", { id: "ABC", version: await versionOf("project", "ABC"), status: "cancelled" });
await step("user", "set_project_status", { id: "ABC", version: await versionOf("project", "ABC"), status: "cancelled" });
await read("project", "ABC");
await override("project", numbered.id, "created_at", "2025-05-01T00:00:00Z");
await read("project", numbered.id);
// The draft in no project is taken up, which assigns it, and finished.
await status(loose.id, "open");
await status(loose.id, "in_progress", "user");
await status(loose.id, "done", "user");
await read("task", loose.id);
// Deleted for good: the task that was set aside, with everything stored under its ID. The prefix that was
// used up before stays used up.
await step("admin", "delete", { id: aside.id, version: await versionOf("task", aside.id), permanent: true });
await read("task", aside.id);
await step("agent1", "create_project", { title: "Again", prefix: "xyz" });
await step("agent1", "create_task", task("Made afterwards", { project: "ABC", draft: true }));
for (const { kind, id } of items) if (kind !== "user" && id !== aside.id && id !== busy.id) await read(kind, id);
await step("agent1", "list_tasks", {});
await step("agent1", "list_projects", {});
await engine.close();
rmSync(directory, { recursive: true, force: true });

const entries = (record) => Object.entries(record).map(([name, value]) => `    ${JSON.stringify(name)}: ${JSON.stringify(value)},`);
const lines = [
  "/**",
  " * A data file as the last version that wrote data format 1 left it, as the statements that make it again, and",
  " * it again, and what that version answered when it was asked for everything in the file. Written by",
  " * scripts/format-1-data.mjs, which says what the plan in it holds; not to be changed by hand.",
  " */",
  "export const FORMAT_1_SQL: readonly string[] = [",
  ...sql.map((statement) => `  ${JSON.stringify(statement)},`),
  "];",
  "",
  "/** What the version that wrote the file answered: `get` with its history for each item, and each list to its end. */",
  "export const FORMAT_1_ANSWERS: { get: Record<string, any>; lists: Record<string, any[]> } = {",
  "  get: {",
  ...entries(answers.get),
  "  },",
  "  lists: {",
  ...entries(answers.lists),
  "  },",
  "};",
  "",
  "/**",
  " * What that version did next with the file, call by call: who called, what, with which input, and the answer or",
  " * the refusal. The clock stood at the first moment below before the first call and moved on by a minute before",
  " * each call.",
  " */",
  `export const FORMAT_1_THEN_FROM = ${JSON.stringify("2026-03-01T00:00:00.000Z")};`,
  "export const FORMAT_1_THEN: ReadonlyArray<{ as: string; operation: string; input: Record<string, unknown>; answer?: any; refusal?: any }> = [",
  ...then.map((call) => `  ${JSON.stringify(call)},`),
  "];",
  "",
];
process.stdout.write(lines.join("\n"));
