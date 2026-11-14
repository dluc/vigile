import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorage } from "@vigile/storage";
import { Engine, GUIDE_EXAMPLES, GUIDE_TOPICS, MemoryKeyStore, OPERATIONS, VigileError, type OperationLog } from "./index.js";

async function setup(storage = new MemoryStorage()) {
  let tick = Date.parse("2026-01-01T00:00:00.000Z");
  const keys = new MemoryKeyStore();
  const log: OperationLog[] = [];
  const engine = await Engine.open({ storage, keys, clock: { now: () => new Date((tick += 1000)) }, onOperation: (e) => log.push(e) });
  const as = (username: string) => (operation: string, input: Record<string, unknown> = {}) => engine.execute(operation, username, input) as Promise<any>;
  return { engine, storage, keys, log, agent: as("agent1"), admin: as("admin"), person: as("user"), as };
}

async function refusal(promise: Promise<unknown>): Promise<ReturnType<VigileError["toJSON"]>> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof VigileError, `expected a VigileError, got ${error}`);
    return error.toJSON();
  }
  assert.fail("expected the operation to be refused");
}

const task = (title: string, extra: Record<string, unknown> = {}) => ({ title, description: `Do ${title}`, ...extra });

/**
 * Data from before a prefix was given only once: a project ABC that has the prefix of one that was deleted for
 * good a minute earlier, whose history was kept then and stands in front of its own.
 */
async function earlierOfTheName() {
  const all = await setup();
  await all.agent("create_project", { title: "Second of the name", prefix: "abc" });
  const second = (await all.agent("get", { id: "ABC" })).created_at as string;
  const first = new Date(Date.parse(second) - 60_000).toISOString();
  const entry = (action: string, at: string, data = {}) => ({ op: "add_history" as const, record: { kind: "project", id: "ABC", at, actor: "3", action, data } });
  const { head, objects } = (await all.storage.load("default"))!;
  await all.storage.commit("default", {
    expectedRevision: head.revision,
    counters: head.counters,
    changes: [
      { op: "delete_object", kind: "project", id: "ABC" },
      entry("created", first, { status: "open" }),
      entry("status_changed", first, { from: "open", to: "broken" }),
      entry("deleted_permanently", first),
      { op: "put_object", record: objects.find((record) => record.kind === "project")!, text: "" },
      entry("created", second, { status: "open" }),
    ],
  });
  await all.engine.reload();
  return { ...all, first, second };
}

describe("dates carried over from another tool", () => {
  /** A task as an import leaves it: created, started and completed within seconds of each other, on the day of the import. */
  async function imported() {
    const all = await setup();
    await all.agent("create_project", { title: "Brought in", prefix: "imp" });
    const created = await all.agent("create_task", task("Finished last spring", { project: "IMP" }));
    await all.agent("set_task_status", { id: created.id, version: 1, status: "in_progress" });
    const done = await all.agent("set_task_status", { id: created.id, version: 2, status: "done" });
    const read = await all.agent("get", { id: created.id });
    const [made, started, completed] = read.timeline.map((e: any) => e.at as string);
    return { ...all, id: created.id as string, version: done.version as number, made: made!, started: started!, completed: completed! };
  }
  /** The moment a number of milliseconds after another. */
  const later = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();

  it("sets when a task was really created and completed, moves what happened in between, and records the change", async () => {
    const { agent, engine, id, version, made, completed } = await imported();
    const before = await agent("get", { id });
    assert.deepEqual([before.created_at, before.completed_at], [made, completed], "an import leaves both dates on the day of the import");
    assert.match(made, /^2026-01-01T/);

    const first = await agent("override_timestamp", { id, version, name: "created_at", value: "2025-03-01T09:00:00Z" });
    assert.equal(first.version, version + 1);
    // A time in another zone is kept as the same moment.
    const second = await agent("override_timestamp", { id, version: first.version, name: "completed_at", value: "2025-04-15T18:30:00+02:00" });
    assert.equal(second.completed_at, "2025-04-15T16:30:00.000Z");

    const after = await agent("get", { id, history: true });
    assert.equal(after.created_at, "2025-03-01T09:00:00.000Z");
    assert.equal(after.completed_at, "2025-04-15T16:30:00.000Z");
    assert.equal(after.status, "done");
    assert.deepEqual(
      after.timeline.map((e: any) => [e.status, e.at]),
      [
        ["open", "2025-03-01T09:00:00.000Z"],
        ["in_progress", "2025-04-15T16:30:00.000Z"],
        ["done", "2025-04-15T16:30:00.000Z"],
      ],
      "the timeline stays in order: the start, stamped by the import, moves back with the completion",
    );
    assert.match(after.updated_at, /^2026-01-01T/, "when the item was last changed is still the service's own record");
    const overrides = after.history.filter((h: any) => h.action === "timestamp_overridden");
    assert.deepEqual(
      overrides.map((h: any) => [h.by, h.at.slice(0, 10), h.data]),
      [
        ["agent1", "2026-01-01", { changes: { created_at: [made, "2025-03-01T09:00:00.000Z"] } }],
        ["agent1", "2026-01-01", { changes: { completed_at: [completed, "2025-04-15T16:30:00.000Z"] }, earlier_changes_moved: 1 }],
      ],
      "the history says who set which date, when, and what it was before",
    );
    assert.deepEqual(engine.checkConsistency(), []);

    // Setting a date to what it already is changes nothing.
    const same = await agent("override_timestamp", { id, version: after.version, name: "created_at", value: "2025-03-01T10:00:00+01:00" });
    assert.equal(same.version, after.version);
  });

  it("takes the last completion of a task that was completed more than once", async () => {
    const { agent, id, version, made, started, completed } = await imported();
    const reopened = await agent("set_task_status", { id, version, status: "open" });
    const again = await agent("set_task_status", { id, version: reopened.version, status: "in_progress" });
    const done = await agent("set_task_status", { id, version: again.version, status: "done" });
    const [, , , opened] = (await agent("get", { id })).timeline.map((e: any) => e.at as string);
    // The second completion is set to half a second after the task was reopened: before its second start was recorded.
    const moment = later(opened!, 500);
    await agent("override_timestamp", { id, version: done.version, name: "completed_at", value: moment });
    const after = await agent("get", { id });
    assert.equal(after.completed_at, moment);
    assert.deepEqual(
      after.timeline.map((e: any) => [e.status, e.at]),
      [
        ["open", made],
        ["in_progress", started],
        ["done", completed],
        ["open", opened],
        ["in_progress", moment],
        ["done", moment],
      ],
      "the first completion and what came before the new date stay as they were",
    );
    // The second completion cannot be dated before the first: the first stays in the timeline as it happened.
    const tooEarly = await refusal(agent("override_timestamp", { id, version: after.version, name: "completed_at", value: later(completed, -500) }));
    assert.equal(tooEarly.rule, "completed_before_earlier_completion");
    assert.equal(tooEarly.message, `Task ${id} cannot have been completed on ${later(completed, -500)}: it was completed once before, on ${completed}, and reopened.`);
  });

  it("sets when a project was created", async () => {
    const { agent } = await imported();
    const project = await agent("get", { id: "IMP" });
    const changed = await agent("override_timestamp", { id: "IMP", version: project.version, name: "created_at", value: "2024-11-05T08:00:00Z" });
    assert.equal(changed.version, project.version + 1);
    assert.equal((await agent("get", { id: "IMP" })).created_at, "2024-11-05T08:00:00.000Z");
    const noCompletion = await refusal(agent("override_timestamp", { id: "IMP", version: changed.version, name: "completed_at", value: "2024-12-01T08:00:00Z" }));
    assert.equal(noCompletion.rule, "not_completed");
    assert.match(noCompletion.message, /only tasks are completed/);
  });

  it("refuses dates that cannot be true, and says what to give instead", async () => {
    const { agent, id, version, made, started, completed } = await imported();
    const call = (name: string, value: string, v = version) => refusal(agent("override_timestamp", { id, version: v, name, value }));

    // Not a date and time with its zone.
    // Nor a date that does not exist: left to itself, the language would take the 30th of February for the 2nd of March.
    for (const value of ["2025-03-01", "last spring", "2025-03-01T09:00:00", "2025-13-40T09:00:00Z", "", "2025-02-30T09:00:00Z", "2025-02-29T09:00:00Z", "2025-04-31T09:00:00+02:00", "2025-03-01T24:00:00Z", "2025-03-01T09:60:00Z", "2025-03-01T09:00:00+15:00"]) {
      const bad = await call("created_at", value);
      assert.equal(bad.code, "invalid_input", value);
      assert.match(bad.actions![0]!, /for example 2026-03-14T09:30:00Z/);
    }
    // The 29th of February of a leap year is a date.
    assert.equal((await agent("override_timestamp", { id, version, name: "created_at", value: "2024-02-29T09:00:00Z" })).version, version + 1);
    await agent("override_timestamp", { id, version: version + 1, name: "created_at", value: made });
    const again = version + 2;
    // In the future.
    const future = await call("completed_at", "2030-01-01T00:00:00Z", again);
    assert.deepEqual([future.code, future.rule], ["rule_violation", "timestamp_in_future"]);
    // Completed before it was created.
    const early = await call("completed_at", "2025-04-15T16:30:00Z", again);
    assert.equal(early.rule, "completed_before_created");
    assert.equal(early.message, `Task ${id} cannot have been completed on 2025-04-15T16:30:00.000Z: it was created on ${made}, after that.`);
    assert.ok(early.actions!.some((a) => /override_timestamp with name "created_at"/.test(a)), "it says to set the creation date first");
    // Created after it was recorded here: what is carried over happened before that.
    const late = await call("created_at", later(started, 500), again);
    assert.equal(late.rule, "created_after_recorded");
    assert.equal(late.message, `Task ${id} cannot have been created on ${later(started, 500)}: it was recorded here on ${made}, before that.`);
    // Before 1970, which no work that is carried over is, and which the service could not write down as it writes dates.
    for (const value of ["0000-01-01T00:00:00+01:00", "0000-02-29T00:00:00Z", "1969-12-31T23:59:59Z", "0096-02-29T00:00:00Z"]) {
      const old = await call("created_at", value, again);
      assert.equal(old.code, "invalid_input", value);
    }
    assert.match((await call("created_at", "1969-12-31T23:59:59Z", again)).message, /is before 1970/);
    // The version that was read is needed, as for every change.
    assert.equal((await call("created_at", "2025-03-01T09:00:00Z", version - 1)).code, "version_conflict");
    // Nothing was changed by any of these.
    const untouched = await agent("get", { id });
    assert.deepEqual([untouched.version, untouched.created_at, untouched.completed_at], [again, made, completed]);

    // Created after something later happened to it: with the completion carried back to the spring, the task
    // cannot have been created in the summer.
    const first = await agent("override_timestamp", { id, version: again, name: "created_at", value: "2025-03-01T09:00:00Z" });
    const second = await agent("override_timestamp", { id, version: first.version, name: "completed_at", value: "2025-04-15T16:30:00Z" });
    const summer = await refusal(agent("override_timestamp", { id, version: second.version, name: "created_at", value: "2025-07-01T09:00:00Z" }));
    assert.equal(summer.rule, "created_after_change");
    assert.equal(summer.message, `Task ${id} cannot have been created on 2025-07-01T09:00:00.000Z: its status changed on 2025-04-15T16:30:00.000Z, before that.`);
  });

  it("takes the moment a project was recorded from its own creation, not from an earlier project that had its prefix", async () => {
    const { agent, second, first } = await earlierOfTheName();
    // Between the two: after the first project was recorded, and before this one was. That is a date this one can have.
    assert.ok(Date.parse(second) > Date.parse(first));
    const between = later(second, -500);
    await agent("override_timestamp", { id: "ABC", version: 1, name: "created_at", value: between });
    assert.equal((await agent("get", { id: "ABC" })).created_at, between);
  });

  it("gives a completion date only to a task that is done", async () => {
    const { agent } = await setup();
    const open = await agent("create_task", task("Not finished"));
    const notDone = await refusal(agent("override_timestamp", { id: open.id, version: 1, name: "completed_at", value: "2025-04-15T16:30:00Z" }));
    assert.equal(notDone.rule, "not_completed");
    assert.match(notDone.message, /its status is open/);
    assert.match(notDone.actions![0]!, /set_task_status/);
    // Its creation date can be set while it is open, and it can be finished afterwards as usual, at the service's own time.
    const moved = await agent("override_timestamp", { id: open.id, version: 1, name: "created_at", value: "2025-03-01T09:00:00Z" });
    const started = await agent("set_task_status", { id: open.id, version: moved.version, status: "in_progress" });
    const done = await agent("set_task_status", { id: open.id, version: started.version, status: "done" });
    assert.match(done.completed_at, /^2026-01-01T/);
    // A deleted item is not changed.
    await agent("delete", { id: open.id, version: done.version });
    assert.equal((await refusal(agent("override_timestamp", { id: open.id, version: done.version + 1, name: "created_at", value: "2025-02-01T09:00:00Z" }))).code, "rule_violation");
  });
});

describe("tenant", () => {
  it("starts with the three built-in users", async () => {
    const { agent } = await setup();
    const { users, you } = await agent("list_users");
    assert.deepEqual(
      users.map((u: any) => [u.id, u.username, u.type, u.built_in]),
      [
        ["USER-001", "admin", "admin", true],
        ["USER-002", "user", "person", true],
        ["USER-003", "agent1", "agent", true],
      ],
    );
    assert.equal(you, "agent1");
  });

  it("keeps its state when the engine is opened again on the same storage", async () => {
    const first = await setup();
    await first.agent("create_project", { title: "Alpha", prefix: "abc" });
    const created = await first.agent("create_task", task("One", { project: "ABC" }));
    await first.agent("set_task_status", { id: created.id, version: 1, status: "in_progress" });

    const second = await setup(first.storage);
    const read = await second.agent("get", { id: "ABC-001" });
    assert.equal(read.status, "in_progress");
    assert.equal(read.description, "Do One");
    assert.deepEqual(read.assigned_to, ["agent1"]);
    assert.deepEqual(read.links["is contained"], [{ kind: "project", id: "ABC", title: "Alpha", status: "open" }]);
    const next = await second.agent("create_task", task("Two", { project: "ABC" }));
    assert.equal(next.id, "ABC-002");
    assert.deepEqual(second.engine.checkConsistency(), []);
  });

  it("refuses an unknown user and an unknown operation", async () => {
    const { as, agent } = await setup();
    assert.equal((await refusal(as("nobody")("list_users"))).code, "unauthorized");
    assert.equal((await refusal(agent("no_such_thing"))).code, "not_found");
  });
});

describe("identifiers", () => {
  it("uses the project prefix and one task counter for the whole tenant", async () => {
    const { agent } = await setup();
    await agent("create_project", { title: "Alpha", prefix: "ABC" });
    await agent("create_project", { title: "Beta", prefix: "xyz" });
    const plain = await agent("create_project", { title: "No prefix" });
    assert.equal(plain.id, "001");
    assert.equal((await agent("create_task", task("a", { project: "ABC" }))).id, "ABC-001");
    assert.equal((await agent("create_task", task("b", { project: "xyz" }))).id, "XYZ-002");
    assert.equal((await agent("create_task", task("c"))).id, "003");
    assert.equal((await agent("create_task", task("d", { project: "project:001" }))).id, "004");
    assert.equal((await agent("create_task", task("e", { parent: "abc-1" }))).id, "ABC-005");
  });

  it("refuses a prefix that is taken, reserved or malformed", async () => {
    const { agent } = await setup();
    await agent("create_project", { title: "Alpha", prefix: "ABC" });
    assert.equal((await refusal(agent("create_project", { title: "Again", prefix: "abc" }))).rule, "prefix_taken");
    assert.equal((await refusal(agent("create_project", { title: "Reserved", prefix: "USER" }))).code, "invalid_input");
    assert.equal((await refusal(agent("create_project", { title: "Short", prefix: "A" }))).code, "invalid_input");
    assert.equal((await refusal(agent("create_project", { title: "Digits", prefix: "AB1" }))).code, "invalid_input");
  });

  it("asks for the kind when a bare number matches a project and a task", async () => {
    const { agent } = await setup();
    await agent("create_project", { title: "Numbered" });
    await agent("create_task", task("Numbered too"));
    const error = await refusal(agent("get", { id: "001" }));
    assert.equal(error.code, "invalid_input");
    assert.match(error.message, /more than one/);
    assert.equal((await agent("get", { id: "task:001" })).kind, "task");
    assert.equal((await agent("get", { kind: "project", id: "1" })).kind, "project");
  });

  it("gives concurrent creates distinct IDs", async () => {
    const { agent } = await setup();
    const created = await Promise.all(Array.from({ length: 20 }, (_, i) => agent("create_task", task(`t${i}`))));
    assert.equal(new Set(created.map((t) => t.id)).size, 20);
  });
});

describe("tasks", () => {
  it("needs a title and a description", async () => {
    const { agent } = await setup();
    assert.equal((await refusal(agent("create_task", { title: "No description" }))).code, "invalid_input");
    assert.equal((await refusal(agent("create_task", { title: "Blank", description: "   " }))).code, "invalid_input");
    assert.equal((await refusal(agent("create_task", { title: "x".repeat(501), description: "d" }))).code, "invalid_input");
    assert.equal((await refusal(agent("create_task", { title: "T", description: "d".repeat(4001) }))).code, "invalid_input");
    assert.equal((await refusal(agent("create_task", { title: "T", description: "d", colour: "red" }))).code, "invalid_input");
  });

  it("refuses text that could not be read back as it was written, or that shows nothing", async () => {
    const { agent } = await setup();
    const message = async (input: Record<string, unknown>) => {
      const error = await refusal(agent("create_task", { title: "T", description: "d", ...input }));
      assert.equal(error.code, "invalid_input", JSON.stringify(input));
      return error.message;
    };
    // A NUL character would cut the text short when it is read from the store; an escape character steers a terminal.
    assert.match(await message({ description: "Step 1.\u0000Step 2, which would be lost." }), /Text cannot contain control characters other than line breaks and tabs/);
    assert.match(await message({ description: "\u001b[2Jcleared" }), /control characters/);
    assert.match(await message({ why: "because\u0007" }), /control characters/);
    assert.match(await message({ title: "ok\u001b[2K fake row" }), /A title is one line of plain text/);
    assert.match(await message({ title: "two\nlines" }), /A title is one line of plain text/);
    // Said once: nothing at all and text that shows nothing are the same mistake, and one message.
    for (const empty of ["", "   ", "\u200b"]) assert.equal((await message({ title: empty })).match(/A title cannot be empty/g)?.length, 1, JSON.stringify(empty));
    assert.equal((await message({ title: "T", why: "  " })).match(/Leave why out instead of sending it empty/g)?.length, 1);
    assert.match(await message({ title: "two\u2028lines" }), /A title is one line of plain text/);
    assert.match(await message({ title: "two\u2029paragraphs" }), /A title is one line of plain text/);
    // Half of a pair: it would come back as another character.
    assert.match(await message({ description: "broken \ud83d" }), /Text cannot contain a broken character/);
    assert.match(await message({ title: "broken \ud83d" }), /A title cannot contain a broken character/);
    // Characters of no width show nothing, so the text is as good as empty.
    assert.match(await message({ title: "\u200b" }), /A title cannot be empty/);
    assert.match(await message({ description: "\u200b\u2060 \u200e" }), /A description cannot be empty/);
    assert.match(await message({ title: "x", description: undefined }), /./);

    // Line breaks and tabs in a description, and any letters, signs and pictures, are fine.
    const fine = await agent("create_task", { title: "Größe prüfen 🚀 ‏עברית", description: "Line one\r\n\tindented\nline three 🚀" });
    assert.equal((await agent("get", { id: fine.id })).description, "Line one\r\n\tindented\nline three 🚀");
    await agent("create_project", { title: "P", prefix: "PPP" });
    assert.equal((await refusal(agent("create_project", { title: "P\u0000", prefix: "QQQ" }))).code, "invalid_input");
    assert.equal((await refusal(agent("update_task", { id: fine.id, version: 1, description: "a\u0000b" }))).code, "invalid_input");
  });

  it("starts open, or as a draft that is never next", async () => {
    const { agent } = await setup();
    const open = await agent("create_task", task("Open"));
    const draft = await agent("create_task", task("Draft", { draft: true }));
    assert.deepEqual([open.status, open.is_next, open.priority], ["open", true, 0]);
    assert.deepEqual([draft.status, draft.is_next], ["draft", false]);
    assert.equal((await refusal(agent("set_task_status", { id: draft.id, version: 1, status: "in_progress" }))).rule, "status_move_not_allowed");
  });

  it("updates fields, bumps the version, and ignores a change to the same values", async () => {
    const { agent } = await setup();
    const created = await agent("create_task", task("Old", { priority: 2 }));
    const updated = await agent("update_task", { id: created.id, version: 1, title: "New", value: 8, description: "Changed" });
    assert.deepEqual([updated.title, updated.value, updated.priority, updated.version], ["New", 8, 2, 2]);
    assert.equal((await agent("get", { id: created.id })).description, "Changed");
    const same = await agent("update_task", { id: created.id, version: 2, title: "New", description: "Changed" });
    assert.equal(same.version, 2);
    const cleared = await agent("update_task", { id: created.id, version: 2, value: null });
    assert.deepEqual([cleared.value, cleared.version], [null, 3]);
  });

  it("refuses a stale version and returns the current item", async () => {
    const { agent } = await setup();
    const created = await agent("create_task", task("T"));
    await agent("update_task", { id: created.id, version: 1, title: "Changed" });
    const error = await refusal(agent("set_task_status", { id: created.id, version: 1, status: "in_progress" }));
    assert.equal(error.code, "version_conflict");
    assert.equal((error.current as any).version, 2);
    assert.equal((error.current as any).title, "Changed");
  });

  it("follows the table of allowed status moves", async () => {
    const { agent } = await setup();
    const t = await agent("create_task", task("T"));
    let version = 1;
    const move = async (status: string) => (version = (await agent("set_task_status", { id: t.id, version, status })).version);
    await move("in_progress");
    await move("paused");
    assert.equal((await refusal(agent("set_task_status", { id: t.id, version, status: "done" }))).rule, "status_move_not_allowed");
    await move("in_progress");
    await move("in_review");
    await move("done");
    assert.equal((await refusal(agent("set_task_status", { id: t.id, version, status: "cancelled" }))).rule, "status_move_not_allowed");
    await move("open");
    await move("cancelled");
    await move("draft");
    const read = await agent("get", { id: t.id });
    assert.deepEqual(
      read.timeline.map((e: any) => e.status),
      ["open", "in_progress", "paused", "in_progress", "in_review", "done", "open", "cancelled", "draft"],
    );
    assert.equal(read.timeline[1].by, "agent1");
  });

  it("refuses a move to the same status, so a task cannot be started twice", async () => {
    const { agent, as } = await setup();
    const t = await agent("create_task", task("T"));
    const started = await agent("set_task_status", { id: t.id, version: 1, status: "in_progress" });
    const error = await refusal(as("user")("set_task_status", { id: t.id, version: started.version, status: "in_progress" }));
    assert.equal(error.rule, "same_status");
  });

  it("assigns an unassigned task to whoever starts it", async () => {
    const { agent, person } = await setup();
    const mine = await agent("create_task", task("Mine"));
    const theirs = await agent("create_task", task("Theirs", { assigned_to: ["user"] }));
    assert.deepEqual((await agent("set_task_status", { id: mine.id, version: 1, status: "in_progress" })).assigned_to, ["agent1"]);
    assert.deepEqual((await person("set_task_status", { id: theirs.id, version: 1, status: "in_progress" })).assigned_to, ["user"]);
  });

  it("records completion time and keeps earlier completions in the timeline", async () => {
    const { agent } = await setup();
    const t = await agent("create_task", task("T"));
    const done = await agent("set_task_status", { id: t.id, version: 1, status: "done" });
    assert.match(done.completed_at, /^2026-01-01T/);
    const reopened = await agent("set_task_status", { id: t.id, version: done.version, status: "open" });
    assert.equal(reopened.completed_at, undefined);
    const again = await agent("set_task_status", { id: t.id, version: reopened.version, status: "done" });
    assert.notEqual(again.completed_at, done.completed_at);
    const read = await agent("get", { id: t.id });
    assert.equal(read.timeline.filter((e: any) => e.status === "done").length, 2);
  });
});

describe("dependencies", () => {
  it("holds a task back until what it depends on is done or cancelled", async () => {
    const { agent } = await setup();
    const a = await agent("create_task", task("A"));
    const b = await agent("create_task", task("B", { depends_on: [a.id] }));
    assert.deepEqual([b.is_waiting, b.is_next, b.waiting_for], [true, false, [a.id]]);

    const start = await refusal(agent("set_task_status", { id: b.id, version: 1, status: "in_progress" }));
    assert.equal(start.rule, "unfinished_dependencies");
    assert.deepEqual(start.blocking, [{ kind: "task", id: a.id, title: "A", status: "open" }]);
    assert.ok(start.actions!.length >= 2);
    assert.equal((await refusal(agent("set_task_status", { id: b.id, version: 1, status: "done" }))).rule, "unfinished_dependencies");

    await agent("set_task_status", { id: a.id, version: 1, status: "done" });
    const ready = await agent("get", { id: b.id });
    assert.deepEqual([ready.is_waiting, ready.is_next], [false, true]);
    await agent("set_task_status", { id: b.id, version: 1, status: "in_progress" });
  });

  it("does not let a cancelled or deleted dependency block", async () => {
    const { agent } = await setup();
    const a = await agent("create_task", task("A"));
    const b = await agent("create_task", task("B"));
    const c = await agent("create_task", task("C", { depends_on: [a.id, b.id] }));
    await agent("set_task_status", { id: a.id, version: 1, status: "cancelled" });
    assert.deepEqual((await agent("get", { id: c.id })).waiting_for, [b.id]);
    await agent("delete", { id: b.id, version: 1 });
    assert.equal((await agent("get", { id: c.id })).is_next, true);
    await agent("restore", { id: b.id });
    assert.equal((await agent("get", { id: c.id })).is_waiting, true);
  });

  it("flags a task that is done while a dependency was reopened", async () => {
    const { agent } = await setup();
    const a = await agent("create_task", task("A"));
    const b = await agent("create_task", task("B", { depends_on: [a.id] }));
    const done = await agent("set_task_status", { id: a.id, version: 1, status: "done" });
    await agent("set_task_status", { id: b.id, version: 1, status: "done" });
    assert.equal((await agent("get", { id: b.id })).has_problems, false);
    await agent("set_task_status", { id: a.id, version: done.version, status: "open" });
    const flagged = await agent("get", { id: b.id });
    assert.equal(flagged.has_problems, true);
    assert.equal(flagged.problems[0].code, "unfinished_dependency");
    assert.deepEqual((await agent("list_tasks", { has_problems: true })).tasks.map((t: any) => t.id), [b.id]);
  });

  it("lets a task depend on a project, across projects", async () => {
    const { agent } = await setup();
    await agent("create_project", { title: "Platform", prefix: "PLT" });
    await agent("create_project", { title: "App", prefix: "APP" });
    const t = await agent("create_task", task("Use the platform", { project: "APP", depends_on: ["PLT"] }));
    assert.deepEqual(t.waiting_for, ["PLT"]);
    await agent("set_project_status", { id: "PLT", version: 1, status: "in_preview" });
    assert.equal((await agent("get", { id: t.id })).is_waiting, true);
    await agent("set_project_status", { id: "PLT", version: 2, status: "ready" });
    assert.equal((await agent("get", { id: t.id })).is_next, true);
    await agent("set_project_status", { id: "PLT", version: 3, status: "broken" });
    const read = await agent("get", { id: t.id });
    assert.equal(read.is_waiting, true);
    assert.equal(read.problems[0].code, "depends_on_broken_project");
  });

  it("does not make contents inherit their container's dependencies", async () => {
    const { agent } = await setup();
    const gate = await agent("create_task", task("Gate"));
    const group = await agent("create_task", task("Group", { depends_on: [gate.id] }));
    const inner = await agent("create_task", task("Inner", { parent: group.id }));
    assert.equal(inner.is_next, true);
    assert.equal((await agent("get", { id: group.id })).is_waiting, true);
  });
});

describe("loops", () => {
  it("refuses a dependency loop, naming the path", async () => {
    const { agent } = await setup();
    const a = await agent("create_task", task("A"));
    const b = await agent("create_task", task("B", { depends_on: [a.id] }));
    const c = await agent("create_task", task("C", { depends_on: [b.id] }));
    const error = await refusal(agent("add_link", { from: a.id, type: "depends on", to: c.id }));
    assert.equal(error.rule, "loop");
    assert.match(error.message, /001 → 003 → 002 → 001/);
    assert.equal((await refusal(agent("add_link", { from: a.id, type: "depends on", to: a.id }))).rule, "self_link");
  });

  it("refuses a containment loop", async () => {
    const { agent } = await setup();
    const a = await agent("create_task", task("A"));
    const b = await agent("create_task", task("B", { parent: a.id }));
    assert.equal((await refusal(agent("add_link", { from: b.id, type: "contains", to: a.id }))).rule, "loop");
  });

  it("refuses a task that depends on the project or parent that contains it", async () => {
    const { agent } = await setup();
    await agent("create_project", { title: "Alpha", prefix: "ABC" });
    const inside = await agent("create_task", task("Inside", { project: "ABC" }));
    assert.equal((await refusal(agent("add_link", { from: inside.id, type: "depends on", to: "ABC" }))).rule, "loop");
    assert.equal((await refusal(agent("create_task", task("Both", { project: "ABC", depends_on: ["ABC"] })))).rule, "loop");
    const outside = await agent("create_task", task("Outside", { depends_on: ["ABC"] }));
    assert.equal((await refusal(agent("add_link", { from: "ABC", type: "contains", to: outside.id }))).rule, "loop");
    const nested = await agent("create_task", task("Nested", { parent: inside.id }));
    assert.equal((await refusal(agent("add_link", { from: nested.id, type: "depends on", to: "ABC" }))).rule, "loop");
  });

  it("refuses a loop that runs through two projects", async () => {
    const { agent } = await setup();
    await agent("create_project", { title: "A", prefix: "AAA" });
    await agent("create_project", { title: "B", prefix: "BBB" });
    await agent("create_task", task("In A, needs B", { project: "AAA", depends_on: ["BBB"] }));
    assert.equal((await refusal(agent("create_task", task("In B, needs A", { project: "BBB", depends_on: ["AAA"] })))).rule, "loop");
  });
});

describe("links", () => {
  it("stores a link once, whichever name the client used", async () => {
    const { agent } = await setup();
    await agent("create_project", { title: "Alpha", prefix: "ABC" });
    const t = await agent("create_task", task("Loose"));
    const added = await agent("add_link", { from: t.id, type: "is contained", to: "ABC" });
    assert.deepEqual(added, { created: true, link: { from: "ABC", type: "contains", to: t.id } });
    const again = await agent("add_link", { from: "abc", type: "Contains", to: t.id });
    assert.equal(again.created, false);
    assert.deepEqual((await agent("get", { id: t.id })).contained_in, ["ABC"]);
    assert.deepEqual((await agent("list_tasks", { project: "ABC" })).tasks.map((x: any) => x.id), [t.id]);

    const removed = await agent("remove_link", { from: t.id, type: "is_contained", to: "ABC" });
    assert.equal(removed.removed, true);
    assert.equal((await refusal(agent("remove_link", { from: "ABC", type: "contains", to: t.id }))).code, "not_found");
  });

  it("explains an unknown type and a wrong kind", async () => {
    const { agent } = await setup();
    await agent("create_project", { title: "Alpha", prefix: "ABC" });
    const t = await agent("create_task", task("T"));
    const unknown = await refusal(agent("add_link", { from: t.id, type: "blocks", to: "ABC" }));
    assert.equal(unknown.code, "invalid_input");
    assert.match(unknown.actions!.join(" "), /depends on/);
    assert.equal((await refusal(agent("add_link", { from: "ABC", type: "depends on", to: t.id }))).code, "not_found");
    assert.equal((await refusal(agent("add_link", { from: t.id, type: "assigned to", to: "ghost" }))).code, "not_found");
  });

  it("lists the link types", async () => {
    const { agent } = await setup();
    const { link_types } = await agent("list_link_types");
    assert.deepEqual(
      link_types.map((t: any) => [t.type, t.reverse]),
      [
        ["contains", "is contained"],
        ["depends on", "is depended on by"],
        ["assigned to", "is assigned"],
      ],
    );
  });

  it("lets a task sit in two projects", async () => {
    const { agent } = await setup();
    await agent("create_project", { title: "A", prefix: "AAA" });
    await agent("create_project", { title: "B", prefix: "BBB" });
    const t = await agent("create_task", task("Shared", { project: "AAA" }));
    await agent("add_link", { from: "BBB", type: "contains", to: t.id });
    assert.deepEqual((await agent("get", { id: t.id })).contained_in, ["AAA", "BBB"]);
    for (const project of ["AAA", "BBB"]) {
      assert.deepEqual((await agent("get", { id: project })).progress, { finished: 0, total: 1 });
    }
  });
});

describe("containers and projects", () => {
  it("refuses to mark a container task done while it holds unfinished tasks", async () => {
    const { agent } = await setup();
    const group = await agent("create_task", task("Group"));
    const inner = await agent("create_task", task("Inner", { parent: group.id }));
    const error = await refusal(agent("set_task_status", { id: group.id, version: 1, status: "done" }));
    assert.equal(error.rule, "unfinished_contents");
    assert.equal(error.blocking![0]!.id, inner.id);
    await agent("set_task_status", { id: inner.id, version: 1, status: "cancelled" });
    await agent("set_task_status", { id: group.id, version: 1, status: "done" });
  });

  it("flags a group that is done but has come to hold unfinished tasks, however that came about", async () => {
    const problems = async (all: Awaited<ReturnType<typeof setup>>, id: string) => ((await all.agent("get", { id })).problems ?? []).map((p: any) => p.code);
    const flagged = async (all: Awaited<ReturnType<typeof setup>>) => (await all.agent("list_tasks", { has_problems: true })).tasks.map((t: any) => t.title);
    /** A group with one task inside, both done. */
    const finished = async () => {
      const all = await setup();
      const group = await all.agent("create_task", task("Group"));
      const inner = await all.agent("create_task", task("Inner", { parent: group.id }));
      await all.agent("set_task_status", { id: inner.id, version: 1, status: "done" });
      await all.agent("set_task_status", { id: group.id, version: 1, status: "done" });
      assert.deepEqual(await problems(all, group.id), []);
      return { ...all, group: group.id as string, inner: inner.id as string };
    };

    // A task inside is reopened.
    const reopened = await finished();
    await reopened.agent("set_task_status", { id: reopened.inner, version: 2, status: "open" });
    const group = await reopened.agent("get", { id: reopened.group });
    assert.deepEqual([group.status, group.has_problems, group.progress], ["done", true, { finished: 0, total: 1 }]);
    assert.equal(group.problems[0].code, "done_with_unfinished_contents");
    assert.equal(group.problems[0].message, `Status is done, but 1 of the tasks it contains is not finished: ${reopened.inner}.`);
    assert.deepEqual(await flagged(reopened), ["Group"]);
    // Finished again, the group is in order again.
    await reopened.agent("set_task_status", { id: reopened.inner, version: 3, status: "cancelled" });
    assert.deepEqual(await problems(reopened, reopened.group), []);

    // A task is created inside the done group.
    const added = await finished();
    await added.agent("create_task", task("Added later", { parent: added.group }));
    assert.deepEqual(await problems(added, added.group), ["done_with_unfinished_contents"]);

    // A task is taken out, the group is marked done, and the task is put back.
    const moved = await setup();
    const outer = await moved.agent("create_task", task("Group"));
    const inside = await moved.agent("create_task", task("Inner", { parent: outer.id }));
    await moved.agent("remove_link", { from: outer.id, type: "contains", to: inside.id });
    await moved.agent("set_task_status", { id: outer.id, version: 1, status: "done" });
    await moved.agent("add_link", { from: outer.id, type: "contains", to: inside.id });
    assert.deepEqual(await problems(moved, outer.id), ["done_with_unfinished_contents"]);

    // A task is deleted, the group is marked done, and the task is restored.
    const restored = await setup();
    const holder = await restored.agent("create_task", task("Group"));
    const gone = await restored.agent("create_task", task("Inner", { parent: holder.id }));
    await restored.agent("delete", { id: gone.id, version: 1 });
    await restored.agent("set_task_status", { id: holder.id, version: 1, status: "done" });
    await restored.agent("restore", { id: gone.id });
    assert.deepEqual(await problems(restored, holder.id), ["done_with_unfinished_contents"]);
  });

  it("looks below sub-groups, also cancelled ones, before a group is marked done", async () => {
    const { agent } = await setup();
    const group = await agent("create_task", task("Group"));
    const sub = await agent("create_task", task("Sub-group", { parent: group.id }));
    const deep = await agent("create_task", task("Deep inside", { parent: sub.id }));
    await agent("set_task_status", { id: sub.id, version: 1, status: "cancelled" });
    const error = await refusal(agent("set_task_status", { id: group.id, version: 1, status: "done" }));
    assert.equal(error.rule, "unfinished_contents");
    assert.deepEqual(error.blocking!.map((b) => b.id), [deep.id]);
    await agent("set_task_status", { id: deep.id, version: 1, status: "cancelled" });
    assert.equal((await agent("set_task_status", { id: group.id, version: 1, status: "done" })).status, "done");
  });

  it("counts progress over everything a project contains, at any depth", async () => {
    const { agent } = await setup();
    await agent("create_project", { title: "Alpha", prefix: "ABC" });
    const group = await agent("create_task", task("Group", { project: "ABC" }));
    const inner = await agent("create_task", task("Inner", { parent: group.id }));
    await agent("create_task", task("Other", { project: "ABC" }));
    await agent("set_task_status", { id: inner.id, version: 1, status: "done" });
    const { projects } = await agent("list_projects");
    assert.deepEqual(projects[0].progress, { finished: 1, total: 3 });
    assert.deepEqual((await agent("list_tasks", { project: "ABC" })).tasks.map((t: any) => t.id), ["ABC-001", "ABC-002", "ABC-003"]);
  });

  it("allows a ready project with unfinished tasks and flags it", async () => {
    const { agent } = await setup();
    await agent("create_project", { title: "Alpha", prefix: "ABC" });
    const t = await agent("create_task", task("Leftover", { project: "ABC" }));
    const ready = await agent("set_project_status", { id: "ABC", version: 1, status: "ready" });
    assert.equal(ready.has_problems, true);
    assert.equal(ready.problems[0].code, "ready_with_unfinished_tasks");
    await agent("create_task", task("Added later", { project: "ABC" }));
    await agent("set_task_status", { id: t.id, version: 1, status: "done" });
    await agent("set_task_status", { id: "ABC-002", version: 1, status: "cancelled" });
    assert.equal((await agent("get", { id: "ABC" })).has_problems, false);
    assert.equal((await refusal(agent("set_project_status", { id: "ABC", version: 2, status: "ready" }))).rule, "same_status");
    assert.deepEqual((await agent("list_projects", { has_problems: true })).projects, []);
  });

  it("flags a broken project and a project holding a task with problems", async () => {
    const { agent } = await setup();
    await agent("create_project", { title: "Alpha", prefix: "ABC" });
    await agent("create_project", { title: "Beta", prefix: "XYZ" });
    const a = await agent("create_task", task("A", { project: "XYZ" }));
    const b = await agent("create_task", task("B", { project: "ABC", depends_on: [a.id] }));
    const done = await agent("set_task_status", { id: a.id, version: 1, status: "done" });
    await agent("set_task_status", { id: b.id, version: 1, status: "in_progress" });
    await agent("set_task_status", { id: a.id, version: done.version, status: "open" });
    assert.deepEqual((await agent("get", { id: "ABC" })).problems.map((p: any) => p.code), ["contains_task_with_problems"]);
    const broken = await agent("set_project_status", { id: "XYZ", version: 1, status: "broken" });
    assert.deepEqual(broken.problems.map((p: any) => p.code), ["project_broken"]);
  });
});

describe("next", () => {
  it("lists startable tasks by priority, leaving out work assigned to someone else", async () => {
    const { agent, person } = await setup();
    const low = await agent("create_task", task("Low"));
    const high = await agent("create_task", task("High", { priority: 5, value: 8, size: 3 }));
    const theirs = await agent("create_task", task("Theirs", { priority: 9, assigned_to: ["user"] }));
    const mine = await agent("create_task", task("Mine", { priority: 5, assigned_to: ["agent1"] }));
    await agent("create_task", task("Waiting", { priority: 9, depends_on: [low.id] }));
    await agent("create_task", task("Draft", { priority: 9, draft: true }));
    const started = await agent("create_task", task("Started", { priority: 9 }));
    await agent("set_task_status", { id: started.id, version: 1, status: "in_progress" });

    assert.deepEqual((await agent("list_next_tasks")).tasks.map((t: any) => t.id), [high.id, mine.id, low.id]);
    assert.deepEqual((await person("list_next_tasks")).tasks.map((t: any) => t.id), [theirs.id, high.id, low.id]);
    assert.deepEqual((await agent("list_tasks", { assigned_to: "user" })).tasks.map((t: any) => t.id), [theirs.id]);
    assert.deepEqual((await agent("list_tasks", { status: "in_progress" })).tasks.map((t: any) => t.id), [started.id]);
  });

  it("returns at most 100 results with a continuation token", async () => {
    const { agent } = await setup();
    for (let i = 0; i < 150; i++) await agent("create_task", task(`t${i}`));
    const first = await agent("list_tasks");
    assert.equal(first.tasks.length, 100);
    assert.equal(first.tasks[99].id, "100");
    const second = await agent("list_tasks", { continuation: first.continuation });
    assert.equal(second.tasks.length, 50);
    assert.equal(second.tasks[0].id, "101");
    assert.equal(second.continuation, undefined);
    assert.equal((await refusal(agent("list_tasks", { continuation: "nonsense" }))).code, "invalid_input");

    const next = await agent("list_next_tasks");
    assert.equal(next.tasks.length, 100);
    await agent("delete", { id: next.tasks[99].id, version: 1 });
    const rest = await agent("list_next_tasks", { continuation: next.continuation });
    assert.equal(rest.tasks.length, 50);
  });

  it("takes a continuation token only for the list it came from", async () => {
    const { agent, person } = await setup();
    await agent("create_project", { title: "P", prefix: "PPP" });
    for (let i = 0; i < 120; i++) await agent("create_task", task(`t${i}`, { project: "PPP" }));
    const tasks = await agent("list_tasks");
    const next = await agent("list_next_tasks");
    const token = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const refused = async (operation: string, input: Record<string, unknown>, as = agent) => {
      const error = await refusal(as(operation, input));
      assert.equal(error.code, "invalid_input", `${operation} ${JSON.stringify(input)}`);
      assert.deepEqual(error.actions, ["Call again without a token to start from the first page."]);
      return error.message;
    };
    // From another operation, with other filters, or asked by someone else.
    assert.match(await refused("list_next_tasks", { continuation: tasks.continuation }), /is not valid|belongs to another list/);
    assert.match(await refused("list_tasks", { continuation: next.continuation }), /is not valid|belongs to another list/);
    assert.match(await refused("list_tasks", { continuation: tasks.continuation, status: "open" }), /belongs to another list/);
    assert.match(await refused("list_tasks", { continuation: tasks.continuation, project: "PPP" }), /belongs to another list/);
    assert.match(await refused("list_next_tasks", { continuation: next.continuation }, person), /belongs to another list/);
    // Made up: with the old shape, with a key of the wrong kind, or not JSON at all.
    for (const made of [token({ k: "050" }), token({ k: 5 }), token({ k: {} }), token({ q: "x", k: [] }), token([1]), token(null), "%%%"]) {
      assert.match(await refused("list_tasks", { continuation: made }), /is not valid|belongs to another list/);
    }
    // The same question with the same token goes on.
    assert.equal((await agent("list_tasks", { continuation: tasks.continuation })).tasks.length, 20);
    const filtered = await agent("list_tasks", { project: "PPP" });
    assert.equal((await agent("list_tasks", { project: "PPP", continuation: filtered.continuation })).tasks.length, 20);
  });
});

describe("delete and restore", () => {
  it("hides a deleted item, refuses changes to it, and brings it back", async () => {
    const { agent } = await setup();
    const t = await agent("create_task", task("T"));
    assert.deepEqual(await agent("delete", { id: t.id, version: 1 }), { deleted: true, permanent: false, kind: "task", id: t.id });
    assert.deepEqual((await agent("list_tasks")).tasks, []);
    const read = await agent("get", { id: t.id });
    assert.ok(read.deleted_at);
    const error = await refusal(agent("set_task_status", { id: t.id, version: read.version, status: "done" }));
    assert.equal(error.rule, "deleted");
    assert.match(error.actions![0]!, /restore/);
    assert.equal((await refusal(agent("delete", { id: t.id, version: read.version }))).rule, "already_deleted");
    const restored = await agent("restore", { id: t.id });
    assert.equal(restored.deleted_at, undefined);
    assert.equal((await refusal(agent("restore", { id: t.id }))).rule, "not_deleted");
  });

  it("refuses to delete a project that still contains tasks", async () => {
    const { agent } = await setup();
    await agent("create_project", { title: "Alpha", prefix: "ABC" });
    const t = await agent("create_task", task("T", { project: "ABC" }));
    const error = await refusal(agent("delete", { id: "ABC", version: 1 }));
    assert.equal(error.rule, "contains_tasks");
    assert.equal(error.blocking![0]!.id, t.id);
    await agent("delete", { id: t.id, version: 1 });
    await agent("delete", { id: "ABC", version: 1 });
    assert.deepEqual((await agent("list_projects")).projects, []);
  });

  it("keeps permanent deletes for admins, and never reuses the number", async () => {
    const { agent, admin, engine } = await setup();
    const a = await agent("create_task", task("A"));
    const b = await agent("create_task", task("B", { depends_on: [a.id] }));
    assert.equal((await refusal(agent("delete", { id: a.id, version: 1, permanent: true }))).code, "forbidden");
    assert.deepEqual(await admin("delete", { id: a.id, version: 1, permanent: true }), { deleted: true, permanent: true, kind: "task", id: a.id });
    assert.equal((await refusal(agent("get", { id: a.id }))).code, "not_found");
    // What stays behind is changed by it: the task that depended on it moves a version on and says what it lost.
    const left = await agent("get", { id: b.id, history: true });
    assert.deepEqual([left.depends_on, left.version], [[], 2]);
    assert.deepEqual(left.history.map((h: any) => [h.action, h.by, h.data.to ?? null]), [
      ["created", "agent1", null],
      ["link_removed", "admin", a.id],
    ]);
    assert.equal((await agent("create_task", task("C"))).id, "003");
    // Its history went with it.
    assert.deepEqual(await engine.history({ kind: "task", id: a.id }), []);
    assert.deepEqual(engine.checkConsistency(), []);
  });

  it("never gives a prefix twice: not after its project was deleted for good, and not after a restart", async () => {
    const { agent, admin, storage } = await setup();
    await agent("create_project", { title: "First of the name", prefix: "abc" });
    const broken = await agent("set_project_status", { id: "ABC", version: 1, status: "broken" });
    // While the project is only hidden, the prefix is its own.
    const hidden = await agent("delete", { id: "ABC", version: broken.version });
    assert.equal(hidden.permanent, false);
    assert.match((await refusal(agent("create_project", { title: "Second of the name", prefix: "abc" }))).message, /already used by a project that is deleted/);
    await admin("delete", { id: "ABC", version: broken.version + 1, permanent: true });

    const again = await refusal(agent("create_project", { title: "Second of the name", prefix: "abc" }));
    assert.equal(again.rule, "prefix_taken");
    assert.equal(again.message, "The prefix ABC was used by a project that has been deleted for good. A prefix is never given twice: the IDs that carried it go on meaning what they meant.");
    assert.deepEqual(again.actions, ["Choose a different prefix."]);
    assert.equal((await refusal(agent("get", { id: "ABC" }))).code, "not_found");

    // It is in what is stored, beside the counters, and the service that starts on that data knows it.
    assert.deepEqual((await storage.load("default"))!.head.counters, { identity: 3, "prefix:ABC": 1 });
    const restarted = await setup(storage);
    assert.equal((await refusal(restarted.agent("create_project", { title: "Second of the name", prefix: "ABC" }))).rule, "prefix_taken");
    assert.equal((await refusal(restarted.admin("create_project", { title: "Second of the name", prefix: "Abc" }))).rule, "prefix_taken");
    // The status counts the prefixes that are used up, and keeps them out of the counters.
    assert.deepEqual([restarted.engine.status().counters, restarted.engine.status().retired_prefixes], [{ identity: 3 }, 1]);
    assert.deepEqual(restarted.engine.checkConsistency(), []);

    // Another prefix is free, and the counters go on from where they were. A project without a prefix has a
    // number, which the project counter never gives again: deleting it for good uses up no prefix.
    assert.equal((await restarted.agent("create_project", { title: "Another", prefix: "abd" })).id, "ABD");
    const numbered = await restarted.agent("create_project", { title: "Numbered" });
    assert.equal(numbered.id, "001");
    await restarted.admin("delete", { id: "project:001", version: 1, permanent: true });
    assert.deepEqual((await storage.load("default"))!.head.counters, { identity: 3, "prefix:ABC": 1, project: 1 });
    assert.equal((await restarted.agent("create_project", { title: "Numbered again" })).id, "002");
  });

  it("refuses a prefix whose project was deleted for good before prefixes were remembered, by the history it left", async () => {
    const { agent, engine, storage } = await setup();
    // As an earlier version left it: the project is gone, nothing beside the counters says so, and its history stayed.
    const entry = (action: string) => ({ op: "add_history" as const, record: { kind: "project", id: "OLD", at: "2025-06-01T00:00:00.000Z", actor: "1", action, data: {} } });
    const { head } = (await storage.load("default"))!;
    await storage.commit("default", { expectedRevision: head.revision, counters: head.counters, changes: [entry("created"), entry("deleted_permanently")] });
    await engine.reload();
    const refusedAs = await refusal(agent("create_project", { title: "New", prefix: "old" }));
    assert.equal(refusedAs.rule, "prefix_taken");
    assert.match(refusedAs.message, /^The prefix OLD was used by a project that has been deleted for good\./);
    assert.deepEqual((await agent("list_projects")).projects, []);
    assert.equal((await agent("create_project", { title: "New", prefix: "new" })).id, "NEW");
  });

  it("shows a project only its own history, where an earlier project of its name left one behind", async () => {
    const { agent, second } = await earlierOfTheName();
    const read = await agent("get", { id: "ABC", history: true });
    assert.deepEqual(read.history.map((h: any) => [h.action, h.at]), [["created", second]]);
    // What happens to it from here on is added to that.
    await agent("set_project_status", { id: "ABC", version: 1, status: "in_preview" });
    assert.deepEqual((await agent("get", { id: "ABC", history: true })).history.map((h: any) => h.action), ["created", "status_changed"]);
  });

  it("takes all that is stored about an item with it when the item is deleted for good: history, description and links", async () => {
    const { agent, admin, engine, storage } = await setup();
    await agent("create_project", { title: "Alpha", prefix: "ABC", description: "What it is for" });
    await agent("set_project_status", { id: "ABC", version: 1, status: "in_preview" });
    const a = await agent("create_task", task("A", { project: "ABC" }));
    const bob = (await admin("create_user", { username: "bob", type: "person" })).user;
    const waiting = await agent("create_task", task("B", { depends_on: [a.id, "ABC"] }));
    // A user can go while a task that is itself deleted is still in its name.
    const hidden = await agent("create_task", task("C", { assigned_to: ["bob"] }));
    await agent("delete", { id: hidden.id, version: 1 });
    await agent("update_task", { id: a.id, version: 1, title: "A, renamed" });
    const stored = async (kind: string, id: string) => [(await storage.readHistory("default", kind, id)).length, await storage.readText("default", kind, id)];
    assert.deepEqual(await stored("project", "ABC"), [4, "What it is for"]);
    assert.deepEqual(await stored("task", a.id), [3, "Do A"]);
    assert.deepEqual(await stored("user", "4"), [1, null]);
    assert.equal((await storage.load("default"))!.links.length, 4);

    await admin("delete", { id: a.id, version: 2, permanent: true });
    await admin("delete", { id: "ABC", version: 2, permanent: true });
    await admin("delete", { id: "bob", version: bob.version, permanent: true });
    for (const [kind, id] of [["project", "ABC"], ["task", a.id], ["user", "4"]] as const) assert.deepEqual(await stored(kind, id), [0, null], kind);
    for (const ref of [{ kind: "project", id: "ABC" }, { kind: "task", id: a.id }, { kind: "user", id: bob.id }] as const) {
      assert.deepEqual(await engine.history(ref), [], ref.kind);
      assert.equal((await refusal(admin("get", { ...ref, history: true }))).code, "not_found", ref.kind);
    }
    // No link to any of the three is left, in memory or in what is stored, and nothing points at what is gone.
    assert.deepEqual((await storage.load("default"))!.links, []);
    const restarted = await setup(storage);
    assert.deepEqual([restarted.engine.status().links, restarted.engine.checkConsistency()], [0, []]);
    // What stays behind keeps its own history, which says what it lost and by whom.
    const left = await restarted.agent("get", { id: waiting.id, history: true });
    assert.deepEqual([left.depends_on, left.version], [[], 3]);
    assert.deepEqual(left.history.map((h: any) => [h.action, h.by, h.data.to ?? null]), [
      ["created", "agent1", null],
      ["link_removed", "admin", a.id],
      ["link_removed", "admin", "ABC"],
    ]);
    const unassigned = await restarted.agent("get", { id: hidden.id, history: true });
    assert.deepEqual([unassigned.assigned_to, unassigned.history.map((h: any) => h.action)], [[], ["created", "deleted", "link_removed"]]);
    // The numbers of the task and of the user are not given again either.
    assert.equal((await restarted.agent("create_task", task("D"))).id, "004");
    assert.equal((await restarted.admin("create_user", { username: "bob", type: "person" })).user.id, "USER-005");
    assert.deepEqual((await restarted.admin("get", { id: "bob", history: true })).history.map((h: any) => h.action), ["created"]);
  });

  it("refuses to delete a project for good while a deleted task is still in it, and says what to do", async () => {
    const { agent, admin, engine } = await setup();
    await agent("create_project", { title: "Alpha", prefix: "ABC" });
    const kept = await agent("create_task", task("Kept", { project: "ABC" }));
    const moved = await agent("create_task", task("Moved", { project: "ABC" }));
    for (const t of [kept, moved]) await agent("delete", { id: t.id, version: 1 });

    const error = await refusal(admin("delete", { id: "ABC", version: 1, permanent: true }));
    assert.equal(error.rule, "contains_deleted_tasks");
    assert.equal(error.message, "Project ABC still contains 2 deleted tasks, which can be restored and would then be in no project.");
    assert.deepEqual(error.blocking!.map((item) => item.id), [kept.id, moved.id]);
    assert.deepEqual(error.actions, ["Delete those tasks permanently first, or call remove_link to move them out of the project."]);
    // Nothing was changed by the refusal: a restored task is in its project.
    assert.deepEqual((await agent("restore", { id: kept.id })).contained_in, ["ABC"]);
    // A task that is not deleted is in the way as it always was, of either kind of delete.
    assert.equal((await refusal(admin("delete", { id: "ABC", version: 1, permanent: true }))).rule, "contains_tasks");
    assert.equal((await refusal(admin("delete", { id: "ABC", version: 1 }))).rule, "contains_tasks");

    // Both ways the refusal names: one task is deleted for good, the other is moved out of the project.
    await agent("delete", { id: kept.id, version: 3 });
    await admin("delete", { id: kept.id, version: 4, permanent: true });
    assert.equal((await refusal(admin("delete", { id: "ABC", version: 1, permanent: true }))).message, "Project ABC still contains 1 deleted task, which can be restored and would then be in no project.");
    await agent("remove_link", { from: "ABC", type: "contains", to: moved.id });
    // With no task left in it, deleted or not, the project goes.
    assert.deepEqual(await admin("delete", { id: "ABC", version: 1, permanent: true }), { deleted: true, permanent: true, kind: "project", id: "ABC" });
    assert.deepEqual(engine.checkConsistency(), []);
  });

  it("hides a project that holds only deleted tasks, as before, and deletes it for good from there once they are gone", async () => {
    const { agent, admin } = await setup();
    await agent("create_project", { title: "Alpha", prefix: "ABC" });
    const t = await agent("create_task", task("T", { project: "ABC" }));
    await agent("delete", { id: t.id, version: 1 });
    assert.equal((await agent("delete", { id: "ABC", version: 1 })).permanent, false);
    // Hidden, it still cannot go for good with the task in it.
    assert.equal((await refusal(admin("delete", { id: "ABC", version: 2, permanent: true }))).rule, "contains_deleted_tasks");
    await admin("delete", { id: t.id, version: 2, permanent: true });
    assert.equal((await admin("delete", { id: "ABC", version: 2, permanent: true })).permanent, true);
    assert.equal((await refusal(agent("create_project", { title: "Again", prefix: "ABC" }))).rule, "prefix_taken");
  });

  it("does not call a plan damaged whose project has a prefix that its own counters say is used up", async () => {
    const { agent, admin, engine, storage } = await setup();
    await agent("create_project", { title: "Alpha", prefix: "ABC" });
    const { head } = (await storage.load("default"))!;
    await storage.commit("default", { expectedRevision: head.revision, counters: { ...head.counters, "prefix:ABC": 1, "prefix:not a prefix": 0 }, changes: [] });
    await engine.reload();
    assert.deepEqual(engine.checkConsistency(), []);
    assert.equal(engine.status().retired_prefixes, 2);
    // The project works as any other, and its prefix is as taken as it was.
    const made = await agent("create_task", task("T", { project: "ABC" }));
    assert.equal(made.id, "ABC-001");
    assert.match((await refusal(agent("create_project", { title: "Again", prefix: "ABC" }))).message, /already used by a project\.$/);
    await admin("delete", { id: made.id, version: 1, permanent: true });
    await admin("delete", { id: "ABC", version: 1, permanent: true });
    assert.equal((await refusal(agent("create_project", { title: "Again", prefix: "ABC" }))).rule, "prefix_taken");
  });
});

describe("users", () => {
  it("lets only an admin create users, and issues a key", async () => {
    const { agent, admin, keys, as, engine } = await setup();
    assert.equal((await refusal(agent("create_user", { username: "agent2", type: "agent" }))).code, "forbidden");
    const created = await admin("create_user", { username: "Agent2", type: "agent" });
    assert.deepEqual([created.user.id, created.user.username, created.user.type], ["USER-004", "agent2", "agent"]);
    assert.match(created.api_key, /^vig_/);
    assert.equal(keys.keys.get("agent2"), created.api_key);
    assert.equal((await as("agent2")("list_users")).you, "agent2");
    assert.equal((await refusal(admin("create_user", { username: "agent2", type: "agent" }))).rule, "username_taken");
    assert.equal((await refusal(admin("create_user", { username: "user-12", type: "agent" }))).code, "invalid_input");
    assert.equal((await refusal(admin("create_user", { username: "boss", type: "admin" }))).code, "invalid_input");

    const reset = await admin("reset_user_key", { user: "agent2" });
    assert.notEqual(reset.api_key, created.api_key);
    assert.equal(keys.keys.get("agent2"), reset.api_key);
    assert.deepEqual(engine.operationsFor("agent").map((o) => o.name).filter((n) => n.includes("user")), ["list_users"]);
    assert.equal(engine.operationsFor("admin").length, 19);
  });

  it("deletes users only for admins, never built-in ones, and not while tasks are assigned", async () => {
    const { agent, admin, keys, as } = await setup();
    await admin("create_user", { username: "agent2", type: "agent" });
    const t = await agent("create_task", task("T", { assigned_to: ["agent2"] }));
    assert.equal((await refusal(agent("delete", { kind: "user", id: "agent2", version: 1 }))).code, "forbidden");
    assert.equal((await refusal(admin("delete", { id: "agent1", version: 1 }))).rule, "built_in");
    const error = await refusal(admin("delete", { id: "USER-004", version: 1 }));
    assert.equal(error.rule, "has_assigned_tasks");
    await agent("remove_link", { from: t.id, type: "assigned to", to: "agent2" });
    await admin("delete", { id: "agent2", version: 1 });
    assert.equal(keys.keys.has("agent2"), false);
    assert.equal((await refusal(as("agent2")("list_users"))).code, "unauthorized");
    assert.equal((await agent("list_users")).users.length, 3);
    assert.equal((await refusal(agent("restore", { id: "agent2" }))).code, "forbidden");
    await admin("restore", { id: "agent2" });
    assert.equal((await agent("list_users")).users.length, 4);
  });
});

describe("history and logging", () => {
  it("records each change once, under the caller, and nothing for a refused change", async () => {
    const { agent, person, engine } = await setup();
    const t = await agent("create_task", task("T"));
    await person("set_task_status", { id: t.id, version: 1, status: "in_progress" });
    await refusal(person("set_task_status", { id: t.id, version: 2, status: "in_progress" }));
    await agent("update_task", { id: t.id, version: 2, priority: 3 });
    const history = await engine.history({ kind: "task", id: t.id });
    assert.deepEqual(history.map((h) => [h.action, h.by]), [
      ["created", "agent1"],
      ["status_changed", "user"],
      ["updated", "agent1"],
    ]);
    assert.deepEqual(history[1]!.data, { from: "open", to: "in_progress", assigned_to: "user" });
    assert.deepEqual(history[2]!.data, { changes: { priority: [0, 3] } });
  });

  it("logs one entry per operation without content", async () => {
    const { agent, log } = await setup();
    await agent("create_task", task("Secret title"));
    await refusal(agent("set_task_status", { id: "001", version: 1, status: "open" }));
    assert.deepEqual(
      log.map((e) => [e.operation, e.caller, e.kind, e.result, e.rule]),
      [
        ["create_task", "agent1", "write", "ok", undefined],
        ["set_task_status", "agent1", "write", "rule_violation", "same_status"],
      ],
    );
    assert.equal(JSON.stringify(log).includes("Secret"), false);
  });

  it("logs a name that is no operation's cut short, and without what could pass for another line of the log", async () => {
    const { agent, log } = await setup();
    await refusal(agent("no_such_thing"));
    await refusal(agent(`get result=ok\nop=delete\ttab \u2028 ${"x".repeat(500)}`));
    assert.deepEqual(log.map((e) => [e.operation, e.result]), [
      ["no_such_thing", "not_found"],
      [`get?result=ok?op=delete?tab???${"x".repeat(34)}`, "not_found"],
    ]);
    assert.equal(log[1]!.operation.length, 64);
  });
});

describe("why", () => {
  it("is optional, shown when a task is read in full, and left out of lists", async () => {
    const { agent } = await setup();
    const plain = await agent("create_task", task("No reason given"));
    const reasoned = await agent("create_task", task("Reasoned", { why: "  Agents keep asking what matters most.\nIt unblocks the import.  " }));
    assert.equal((await agent("get", { id: plain.id })).why, null);
    assert.equal((await agent("get", { id: reasoned.id })).why, "Agents keep asking what matters most.\nIt unblocks the import.");
    assert.equal("why" in reasoned, false);
    assert.equal(JSON.stringify(await agent("list_tasks")).includes("unblocks"), false);
    assert.equal("why" in (await agent("get", { id: "agent1" })), false);
  });

  it("can be changed and cleared, and each change is recorded without the text", async () => {
    const { agent, engine } = await setup();
    const t = await agent("create_task", task("T"));
    const added = await agent("update_task", { id: t.id, version: 1, why: "First reason." });
    assert.equal(added.version, 2);
    const same = await agent("update_task", { id: t.id, version: 2, why: "First reason." });
    assert.equal(same.version, 2);
    const cleared = await agent("update_task", { id: t.id, version: 2, why: null });
    assert.equal(cleared.version, 3);
    assert.equal((await agent("get", { id: t.id })).why, null);
    const history = await engine.history({ kind: "task", id: t.id });
    assert.deepEqual(history.map((h) => h.data), [{ status: "open" }, { changes: { why: { was: null } } }, { changes: { why: { was: "First reason." } } }]);
    // A rewritten description keeps what it was, too.
    await agent("update_task", { id: t.id, version: 3, description: "Second text." });
    await agent("update_task", { id: t.id, version: 4, description: "Third text.", priority: 2 });
    const later = await engine.history({ kind: "task", id: t.id });
    assert.deepEqual(later.slice(3).map((h) => h.data), [{ changes: { description: { was: "Do T" } } }, { changes: { priority: [0, 2], description: { was: "Second text." } } }]);
    assert.equal((await agent("get", { id: t.id })).description, "Third text.");
  });

  it("has a limit and cannot be sent empty", async () => {
    const { agent } = await setup();
    assert.equal((await refusal(agent("create_task", task("T", { why: "x".repeat(1001) })))).code, "invalid_input");
    assert.equal((await refusal(agent("create_task", task("T", { why: "   " })))).code, "invalid_input");
    assert.equal((await agent("create_task", task("T", { why: "x".repeat(1000) }))).status, "open");
  });

  it("is null for tasks stored before the field existed", async () => {
    const first = await setup();
    const t = await first.agent("create_task", task("Old"));
    const snapshot = await first.storage.load("default");
    const record = snapshot!.objects.find((o) => o.kind === "task")!;
    const { why: _dropped, ...data } = record.data;
    await first.storage.commit("default", { expectedRevision: snapshot!.head.revision, counters: snapshot!.head.counters, changes: [{ op: "put_object", record: { ...record, data } }] });
    const second = await setup(first.storage);
    assert.equal((await second.agent("get", { id: t.id })).why, null);
    assert.equal((await second.agent("update_task", { id: t.id, version: 1, why: "Now it has one." })).version, 2);
  });
});

describe("reading an item in full", () => {
  it("returns every recorded change when history is asked for, including link changes", async () => {
    const { agent, person } = await setup();
    const a = await agent("create_task", task("A"));
    const b = await agent("create_task", task("B"));
    await agent("add_link", { from: b.id, type: "depends on", to: a.id });
    await person("update_task", { id: b.id, version: 2, priority: 4 });
    await agent("remove_link", { from: b.id, type: "depends on", to: a.id });
    await person("set_task_status", { id: b.id, version: 4, status: "in_progress" });

    assert.equal("history" in (await agent("get", { id: b.id })), false);
    const { history } = await agent("get", { id: b.id, history: true });
    assert.deepEqual(
      history.map((h: any) => [h.action, h.by]),
      [
        ["created", "agent1"],
        ["link_added", "agent1"],
        ["updated", "user"],
        ["link_removed", "agent1"],
        ["status_changed", "user"],
      ],
    );
    assert.deepEqual(history[1].data, { from: b.id, type: "depends on", to: a.id });
    assert.match(history[0].at, /^2026-01-01T/);
    // The other end of the links says so too, and stays at its version: what it is has not changed.
    const other = await agent("get", { id: a.id, history: true });
    assert.deepEqual([other.version, other.history.map((h: any) => h.action)], [1, ["created", "link_added", "link_removed"]]);
  });

  it("counts a change to a task's links as a change to the task, so a caller that read it earlier is told", async () => {
    const { agent, admin, person } = await setup();
    await agent("create_project", { title: "P", prefix: "PPP" });
    const group = await agent("create_task", task("Group", { project: "PPP" }));
    const t = await agent("create_task", task("Read while it was nobody's", { project: "PPP" }));
    const before = await agent("get", { id: t.id });
    assert.deepEqual([before.version, before.assigned_to], [1, []]);

    // Someone else gives the task to a person. The agent that read it as unassigned can no longer start it unawares.
    await admin("add_link", { from: t.id, type: "assigned to", to: "user" });
    const conflict = await refusal(agent("set_task_status", { id: t.id, version: 1, status: "in_progress" }));
    assert.equal(conflict.code, "version_conflict");
    assert.deepEqual([(conflict.current as any).version, (conflict.current as any).assigned_to], [2, ["user"]]);

    // Each kind of link moves the task it is about, and only that one.
    await person("add_link", { from: group.id, type: "contains", to: t.id });
    await person("add_link", { from: t.id, type: "depends on", to: group.id }).catch(() => {});
    const versions = async () => Promise.all([t.id, group.id, "PPP"].map(async (id) => (await agent("get", { id })).version));
    assert.deepEqual(await versions(), [3, 1, 1], "being put into a group is a change to the task, not to the group");
    await person("remove_link", { from: "PPP", type: "contains", to: t.id });
    await person("remove_link", { from: t.id, type: "assigned to", to: "user" });
    assert.deepEqual(await versions(), [5, 1, 1]);
    // A link that was there already, or one that is refused, changes nothing.
    assert.equal((await person("add_link", { from: group.id, type: "contains", to: t.id })).created, false);
    assert.deepEqual(await versions(), [5, 1, 1]);

    // The task's own history has every move, and so has what it was moved into and out of.
    const moved = await agent("get", { id: t.id, history: true });
    assert.deepEqual(
      moved.history.map((h: any) => [h.action, h.data.type ?? null, h.by]),
      [
        ["created", null, "agent1"],
        ["link_added", "assigned to", "admin"],
        ["link_added", "contains", "user"],
        ["link_removed", "contains", "user"],
        ["link_removed", "assigned to", "user"],
      ],
    );
    const project = await agent("get", { id: "PPP", history: true });
    assert.deepEqual(project.history.map((h: any) => [h.action, h.data.to ?? null]), [
      ["created", null],
      ["link_added", group.id],
      ["link_added", t.id],
      ["link_removed", t.id],
    ]);
    assert.deepEqual((await agent("get", { id: group.id, history: true })).history.map((h: any) => h.action), ["created", "link_added"]);
  });

  it("says whether a task is assigned", async () => {
    const { agent } = await setup();
    const free = await agent("create_task", task("Free"));
    const taken = await agent("create_task", task("Taken", { assigned_to: ["user"] }));
    assert.deepEqual([free.is_assigned, free.assigned_to], [false, []]);
    assert.deepEqual([taken.is_assigned, taken.assigned_to], [true, ["user"]]);
  });
});

describe("task types", () => {
  it("defaults to task, can be set and changed, and filters lists", async () => {
    const { agent, engine } = await setup();
    const plain = await agent("create_task", task("Planned"));
    const bug = await agent("create_task", task("Broken login", { type: "bug" }));
    const incident = await agent("create_task", task("Site is down", { type: "incident" }));
    assert.deepEqual([plain.type, bug.type, incident.type], ["task", "bug", "incident"]);
    assert.deepEqual((await agent("list_tasks", { type: "bug" })).tasks.map((t: any) => t.id), [bug.id]);
    assert.deepEqual((await agent("list_tasks", { type: "task" })).tasks.map((t: any) => t.id), [plain.id]);

    const changed = await agent("update_task", { id: plain.id, version: 1, type: "issue" });
    assert.deepEqual([changed.type, changed.version], ["issue", 2]);
    assert.equal((await agent("update_task", { id: plain.id, version: 2, type: "issue" })).version, 2);
    const history = await engine.history({ kind: "task", id: plain.id });
    assert.deepEqual(history.at(-1)!.data, { changes: { type: ["task", "issue"] } });
    assert.equal((await refusal(agent("create_task", task("X", { type: "epic" })))).code, "invalid_input");
  });

  it("is task for tasks stored before the field existed", async () => {
    const first = await setup();
    const t = await first.agent("create_task", task("Old"));
    const snapshot = await first.storage.load("default");
    const record = snapshot!.objects.find((o) => o.kind === "task")!;
    const { type: _dropped, ...data } = record.data;
    await first.storage.commit("default", { expectedRevision: snapshot!.head.revision, counters: snapshot!.head.counters, changes: [{ op: "put_object", record: { ...record, data } }] });
    const second = await setup(first.storage);
    assert.equal((await second.agent("get", { id: t.id })).type, "task");
  });
});

describe("groups", () => {
  async function plan() {
    const s = await setup();
    const { agent } = s;
    await agent("create_project", { title: "Site", prefix: "WEB" });
    const epic = await agent("create_task", task("Checkout", { project: "WEB" }));
    const feature = await agent("create_task", task("Payments", { parent: epic.id }));
    const a = await agent("create_task", task("Card form", { parent: feature.id }));
    const b = await agent("create_task", task("Receipts", { parent: feature.id, depends_on: [a.id] }));
    const c = await agent("create_task", task("Basket", { parent: epic.id }));
    const loose = await agent("create_task", task("Fix typo", { project: "WEB" }));
    return { ...s, epic, feature, a, b, c, loose };
  }

  it("report how many of their tasks are finished, at any depth", async () => {
    const { agent, epic, feature, a, loose } = await plan();
    assert.deepEqual((await agent("get", { id: epic.id })).progress, { finished: 0, total: 4 });
    assert.deepEqual((await agent("get", { id: feature.id })).progress, { finished: 0, total: 2 });
    assert.equal((await agent("get", { id: loose.id })).progress, undefined);
    await agent("set_task_status", { id: a.id, version: 1, status: "done" });
    assert.deepEqual((await agent("get", { id: epic.id })).progress, { finished: 1, total: 4 });
    assert.deepEqual((await agent("get", { id: feature.id })).progress, { finished: 1, total: 2 });
  });

  it("give a high-level view with top_level, and zoom in with parent", async () => {
    const { agent, epic, feature, a, b, c, loose } = await plan();
    const ids = async (input: Record<string, unknown>) => (await agent("list_tasks", input)).tasks.map((t: any) => t.id);
    assert.deepEqual(await ids({ top_level: true }), [epic.id, loose.id]);
    assert.deepEqual(await ids({ parent: epic.id }), [feature.id, a.id, b.id, c.id]);
    assert.deepEqual(await ids({ parent: feature.id }), [a.id, b.id]);
    assert.deepEqual(await ids({ parent: feature.id, status: "open" }), [a.id, b.id]);
    assert.deepEqual(await ids({ top_level: false, project: "WEB" }), [feature.id, a.id, b.id, c.id]);
    assert.deepEqual((await agent("list_next_tasks", { parent: feature.id })).tasks.map((t: any) => t.id), [a.id]);
    assert.equal((await refusal(agent("list_tasks", { parent: "WEB" }))).code, "not_found");
  });

  it("take the project's prefix through their parent, and can be regrouped with links", async () => {
    const { agent, feature, c, loose } = await plan();
    assert.match(feature.id, /^WEB-/);
    await agent("add_link", { from: feature.id, type: "contains", to: loose.id });
    assert.deepEqual((await agent("get", { id: feature.id })).progress, { finished: 0, total: 3 });
    await agent("remove_link", { from: feature.id, type: "contains", to: loose.id });
    await agent("add_link", { from: loose.id, type: "is contained", to: c.id });
    assert.deepEqual((await agent("get", { id: c.id })).progress, { finished: 0, total: 1 });
    assert.deepEqual((await agent("list_tasks", { top_level: true })).tasks.map((t: any) => t.title), ["Checkout"]);
  });
});

describe("listening for changes", () => {
  it("tells each listener the new revision after every stored change, and nothing after it has left", async () => {
    const { engine, agent } = await setup();
    const heard: number[] = [];
    const others: number[] = [];
    const leave = engine.subscribe((revision) => heard.push(revision));
    engine.subscribe((revision) => others.push(revision));
    const start = engine.currentRevision;

    const created = await agent("create_task", task("One"));
    assert.deepEqual(heard, [start + 1]);
    await agent("list_tasks");
    await refusal(agent("set_task_status", { id: created.id, version: 9, status: "done" }));
    assert.deepEqual(heard, [start + 1], "a read and a refused change are not changes");
    await agent("set_task_status", { id: created.id, version: 1, status: "in_progress" });
    assert.deepEqual(heard, [start + 1, start + 2]);

    leave();
    await agent("create_task", task("Two"));
    assert.deepEqual(heard, [start + 1, start + 2]);
    assert.deepEqual(others, [start + 1, start + 2, start + 3]);
    assert.equal(engine.currentRevision, start + 3);
  });

  it("stores the change even when a listener fails", async () => {
    const { engine, agent } = await setup();
    engine.subscribe(() => {
      throw new Error("listener broke");
    });
    const created = await agent("create_task", task("One"));
    assert.equal((await agent("get", { id: created.id })).title, "One");
  });
});

describe("guide", () => {
  it("answers with the overview by default and lists every topic", async () => {
    const { agent } = await setup();
    const overview = await agent("get_guide");
    assert.equal(overview.topic, "overview");
    assert.deepEqual(overview.topics.map((t: any) => t.topic), [...GUIDE_TOPICS]);
    for (const topic of GUIDE_TOPICS) {
      const part = await agent("get_guide", { topic });
      assert.equal(part.topic, topic);
      assert.ok(part.text.length > 400 && part.text.length < 9000, `${topic} is ${part.text.length} characters: enough to be useful, short enough to read`);
      assert.ok(part.title && part.topics.every((t: any) => t.summary));
    }
    assert.equal((await refusal(agent("get_guide", { topic: "everything" }))).code, "invalid_input");
  });

  it("invites grouping at any depth without requiring it, and says what a good title is", async () => {
    const { agent } = await setup();
    const { text } = await agent("get_guide", { topic: "organising" });
    assert.match(text, /Nothing here is required/);
    assert.match(text, /Nesting has no limit/);
    assert.match(text, /say the outcome, not only the area/);
    assert.match(text, /Things this can be used for/);
  });

  it("names only operations that exist", async () => {
    const { agent } = await setup();
    const names = new Set(OPERATIONS.map((o) => o.name));
    for (const topic of GUIDE_TOPICS) {
      const { text } = await agent("get_guide", { topic });
      for (const word of text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []) {
        if (["in_progress", "in_review", "in_preview", "top_level", "depends_on", "waiting_for", "is_waiting", "assigned_to", "created_at", "completed_at"].includes(word)) continue;
        assert.ok(names.has(word), `${topic} mentions ${word}, which is not an operation`);
      }
    }
  });

  it("shows only examples whose every call works, in order, on a new instance", async () => {
    const { agent: read } = await setup();
    const { text } = await read("get_guide", { topic: "examples" });
    assert.ok(GUIDE_EXAMPLES.length >= 6);
    for (const example of GUIDE_EXAMPLES) {
      assert.ok(text.includes(example.title), `the examples show "${example.title}"`);
      const { agent, engine } = await setup();
      const results: any[] = [];
      for (const call of example.calls) {
        assert.ok(text.includes(`${call.operation} ${JSON.stringify(call.input)}`), "the text shows the call exactly as it is run");
        try {
          results.push(await agent(call.operation, call.input));
        } catch (error) {
          assert.fail(`"${example.title}": ${call.operation} ${JSON.stringify(call.input)} was refused: ${(error as Error).message}`);
        }
        // Where a note names the ID or the version a call returns, the call really returns it.
        const id = /^(?:returns id )?([A-Z]*-?\d{3})\b/.exec(call.note ?? "")?.[1];
        if (id && call.operation === "create_task") assert.equal(results.at(-1).id, id, `"${example.title}": the note of ${call.input.title}`);
        const version = /returns version (\d+)/.exec(call.note ?? "")?.[1];
        if (version) assert.equal(results.at(-1).version, Number(version));
      }
      assert.deepEqual(engine.checkConsistency(), []);
    }
  });

  it("describes the results of its examples truthfully", async () => {
    const run = async (title: string) => {
      const example = GUIDE_EXAMPLES.find((e) => e.title === title)!;
      const { agent } = await setup();
      const results: any[] = [];
      for (const call of example.calls) results.push(await agent(call.operation, call.input));
      return results;
    };
    const list = await run("A plain list");
    assert.deepEqual(list[2].tasks.map((t: any) => t.id), ["002", "001"], "the higher priority comes first");

    const feature = await run("A feature with steps");
    assert.deepEqual(feature[5].tasks.map((t: any) => t.id), ["WEB-002"]);
    assert.deepEqual(feature[6].tasks.map((t: any) => [t.id, t.progress]), [["WEB-001", { finished: 0, total: 3 }]]);

    const epic = await run("An epic with features inside, and steps inside those");
    assert.deepEqual(epic[6].tasks.map((t: any) => [t.id, t.progress]), [["SHOP-001", { finished: 0, total: 4 }]]);
    assert.deepEqual(epic[7].tasks.map((t: any) => t.id).sort(), ["SHOP-003", "SHOP-004"]);

    const launch = await run("A launch that waits for a whole group");
    assert.deepEqual([launch[3].is_waiting, launch[3].waiting_for], [true, ["001"]]);

    const work = await run("Working on a task from start to finish");
    assert.deepEqual([work[3].assigned_to, work[5].status], [["agent1"], "done"]);

    const bug = await run("A bug found on the way");
    assert.deepEqual(bug[2].tasks.map((t: any) => [t.id, t.type]), [["002", "bug"]]);

    const shared = await run("One task in two groups");
    assert.deepEqual(shared[4].tasks.map((t: any) => t.id), ["003"]);
    assert.deepEqual(shared[4].tasks[0].contained_in.sort(), ["001", "002"]);

    const draft = await run("An idea that is not ready yet");
    assert.deepEqual([draft[1].tasks.length, draft[2].is_next], [0, true]);
  });
});
