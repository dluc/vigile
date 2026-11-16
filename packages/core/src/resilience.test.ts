import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorage, type CommitRequest, type Head, type JsonObject, type Snapshot, type StorageAdapter } from "@vigile/storage";
import { Engine, MemoryKeyStore, VigileError, type KeyStore, type OperationLog } from "./index.js";

const task = (title: string, extra: Record<string, unknown> = {}) => ({ title, description: `Do ${title}`, ...extra });

/** A store that can be told to fail a commit, either before writing or after the write went through. */
class FlakyStorage extends MemoryStorage {
  fail: "no" | "before" | "after" = "no";

  override async commit(tenant: string, request: CommitRequest): Promise<Head> {
    const mode = this.fail;
    this.fail = "no";
    if (mode === "before") throw new Error("disk unavailable");
    const head = await super.commit(tenant, request);
    if (mode === "after") throw new Error("connection lost after the write");
    return head;
  }
}

const ids = async (engine: Engine) => ((await engine.execute("list_tasks", "agent1", {})) as any).tasks.map((t: any) => t.id);

async function failure(promise: Promise<unknown>): Promise<VigileError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof VigileError);
    return error;
  }
  assert.fail("expected a failure");
}

describe("storage failures", () => {
  it("leaves memory untouched when a write is not stored, and carries on", async () => {
    const storage = new FlakyStorage();
    const engine = await Engine.open({ storage });
    await engine.execute("create_task", "agent1", task("Kept"));

    storage.fail = "before";
    const error = await failure(engine.execute("create_task", "agent1", task("Lost")));
    assert.equal(error.code, "internal");
    assert.equal(error.message.includes("disk"), false, "internal details are not shown to clients");
    assert.deepEqual(await ids(engine), ["001"]);

    const next = (await engine.execute("create_task", "agent1", task("After"))) as any;
    assert.equal(next.id, "002");
    assert.deepEqual(engine.checkConsistency(), []);
  });

  it("tells the service's log what went wrong, and only the log", async () => {
    const storage = new FlakyStorage();
    const log: OperationLog[] = [];
    const engine = await Engine.open({ storage, onOperation: (entry) => log.push(entry) });
    storage.fail = "before";
    const error = await failure(engine.execute("create_task", "agent1", task("Lost")));
    assert.equal(JSON.stringify(error.toJSON()).includes("disk"), false);
    const entry = log.at(-1)!;
    assert.deepEqual([entry.operation, entry.result], ["create_task", "internal"]);
    assert.equal((entry.cause as Error).message, "disk unavailable");
    // A refusal is the caller's doing and has no cause to report; nor has a call that went well.
    await failure(engine.execute("get", "agent1", { id: "999" }));
    await engine.execute("create_task", "agent1", task("Kept"));
    assert.deepEqual(log.slice(-2).map((e) => [e.result, "cause" in e]), [["not_found", false], ["ok", false]]);
  });

  it("does not fail an operation because its line in the log could not be written", async () => {
    const engine = await Engine.open({
      storage: new MemoryStorage(),
      onOperation: () => {
        throw new Error("no space left on device");
      },
    });
    const made = (await engine.execute("create_task", "agent1", task("Stored all the same"))) as any;
    assert.equal(made.id, "001");
    assert.deepEqual(await ids(engine), ["001"]);
    // A refusal stays the refusal it was.
    assert.equal((await failure(engine.execute("get", "agent1", { id: "999" }))).code, "not_found");
  });

  it("reloads from storage when the outcome of a write is unknown, so memory never drifts", async () => {
    const storage = new FlakyStorage();
    const engine = await Engine.open({ storage });
    storage.fail = "after";
    await failure(engine.execute("create_task", "agent1", task("Stored, but the reply was lost")));

    assert.deepEqual(await ids(engine), ["001"], "the write went through, and memory shows it");
    const again = await Engine.open({ storage });
    assert.deepEqual(await ids(again), ["001"]);
    assert.equal(((await engine.execute("create_task", "agent1", task("Next"))) as any).id, "002");
    assert.equal(engine.status().revision, (await storage.load("default"))!.head.revision);
  });

  it("keeps the status of a task when its change could not be stored", async () => {
    const storage = new FlakyStorage();
    const engine = await Engine.open({ storage });
    await engine.execute("create_task", "agent1", task("T"));
    storage.fail = "before";
    await failure(engine.execute("set_task_status", "agent1", { id: "001", version: 1, status: "in_progress" }));
    const read = (await engine.execute("get", "agent1", { id: "001", history: true })) as any;
    assert.deepEqual([read.status, read.version, read.assigned_to, read.history.length], ["open", 1, [], 1]);
  });
});

describe("a store of keys that fails", () => {
  /** Keys that cannot be written, as when the config file's folder is read-only. */
  const broken: KeyStore = {
    create: () => "vig_made-but-never-stored-0123456789",
    stored: () => undefined,
    put: async () => Promise.reject(new Error("EACCES: config.toml")),
    revoke: async () => Promise.reject(new Error("EACCES: config.toml")),
  };

  it("says what is stored and what is not, instead of 'not confirmed'", async () => {
    const log: OperationLog[] = [];
    const keys = { ...broken };
    const engine = await Engine.open({ storage: new MemoryStorage(), keys, onOperation: (entry) => log.push(entry) });
    const created = await failure(engine.execute("create_user", "admin", { username: "bob", type: "agent" }));
    assert.equal(created.code, "internal");
    assert.equal(created.message, "User bob was created, but its API key could not be stored, so it cannot connect yet.");
    assert.match(created.toJSON().actions![0]!, /^Call reset_user_key for bob/);
    assert.equal(created.message.includes("EACCES"), false, "what went wrong inside stays inside");
    assert.equal((log.at(-1)!.cause as Error).message, "EACCES: config.toml", "and is in the log");
    const users = ((await engine.execute("list_users", "admin", {})) as any).users.map((u: any) => u.username);
    assert.ok(users.includes("bob"), "the user is there, as the message says");

    const reset = await failure(engine.execute("reset_user_key", "admin", { user: "bob" }));
    assert.equal(reset.message, "No new API key could be stored for bob. The key it had, if any, still works.");

    const deleted = await failure(engine.execute("delete", "admin", { id: "bob", version: 2 }));
    assert.match(deleted.message, /^User bob was deleted, but its API key could not be removed/);
    // Advice that can be followed: what restoring does, and the other thing that could not be changed with the key.
    assert.deepEqual(deleted.toJSON().actions, [
      "The cause is in the service's log. Restoring the user cancels the key.",
      "If auth.keyless_user in the config file is bob, set it to nothing: the service does not start while it names a user that is deleted.",
    ]);
    assert.notEqual(((await engine.execute("get", "admin", { id: "bob" })) as any).deleted_at, null);

    // Restored, the user gets no key back: what could not be cancelled then is cancelled now.
    let cancelled = "";
    keys.revoke = async (username: string) => {
      cancelled = username;
    };
    await engine.execute("restore", "admin", { id: "bob" });
    assert.equal(cancelled, "bob");
  });

  it("runs an operation as the user that was let in, not as whoever has the name when its turn comes", async () => {
    const engine = await Engine.open({ storage: new MemoryStorage(), keys: new MemoryKeyStore() });
    await engine.execute("create_user", "admin", { username: "bob", type: "agent" });
    const was = { username: "bob", id: engine.user("bob")!.id };
    await engine.execute("create_task", was, { title: "By the bob that is", description: "d" });

    // Three changes wait for their turn, in this order: bob is deleted for good, the name is given to someone
    // else, and a change that was let in as the first bob. Who it runs as is asked when its turn comes.
    const deleted = engine.execute("delete", "admin", { id: "bob", version: 1, permanent: true });
    const created = engine.execute("create_user", "admin", { username: "bob", type: "person" });
    const late = failure(engine.execute("create_task", was, { title: "By the bob that was", description: "d" }));
    await Promise.all([deleted, created]);
    const refused = await late;
    assert.equal(refused.code, "unauthorized");
    assert.match(refused.message, /The user "bob" this request was let in as has been deleted since, and the name belongs to someone else now/);
    // The same for a read, and for the name alone nothing changes: it means whoever has it.
    assert.equal((await failure(engine.execute("list_tasks", was, {}))).code, "unauthorized");
    const now = { username: "bob", id: engine.user("bob")!.id };
    assert.notEqual(now.id, was.id, "the new bob is another user");
    const titles = ((await engine.execute("list_tasks", now, {})) as { tasks: Array<{ title: string }> }).tasks.map((task) => task.title);
    assert.deepEqual(titles, ["By the bob that is"]);
    await engine.execute("create_task", "bob", { title: "By the name alone", description: "d" });
  });

  it("counts a key only for the user it was made for, whoever has the name later", async () => {
    const keys = new MemoryKeyStore();
    const storage = new MemoryStorage();
    const engine = await Engine.open({ storage, keys });
    const first = (await engine.execute("create_user", "admin", { username: "bob", type: "agent" })) as { api_key: string };
    assert.equal(engine.keyIsTheirs("bob", first.api_key), true);
    assert.equal(engine.keyIsTheirs("bob", "vig_some-other-key-0123456789abcd"), false);
    assert.equal("key_marks" in ((await engine.execute("get", "admin", { id: "bob" })) as object), false, "the marks are the engine's own business");

    // The user is deleted for good, and its key stays where keys are kept: the removal failed, or it was put back by hand.
    await engine.execute("delete", "admin", { id: "bob", version: 1, permanent: true });
    keys.keys.set("bob", first.api_key);
    assert.equal(engine.keyIsTheirs("bob", first.api_key), false, "there is no such user");
    // Someone else is given the name, and their own key cannot be stored. The key under the name is not theirs.
    const real = keys.put.bind(keys);
    keys.put = async () => Promise.reject(new Error("EACCES"));
    await failure(engine.execute("create_user", "admin", { username: "bob", type: "person" }));
    assert.equal(keys.keys.get("bob"), first.api_key, "the old key is still there");
    assert.equal(engine.keyIsTheirs("bob", first.api_key), false, "and does not count for the new bob");
    // Nor when a new key for the new bob cannot be stored either: the key under the name is not taken over.
    await failure(engine.execute("reset_user_key", "admin", { user: "bob" }));
    assert.equal(engine.keyIsTheirs("bob", first.api_key), false, "also after a failed reset");
    assert.equal((await Engine.open({ storage, keys })).keyIsTheirs("bob", first.api_key), false, "and after a restart");
    keys.put = real;

    // A key that is replaced: when the new one cannot be stored, the one the user has goes on counting.
    const alice = (await engine.execute("create_user", "admin", { username: "alice", type: "agent" })) as { api_key: string };
    keys.put = async () => Promise.reject(new Error("EACCES"));
    const failed = await failure(engine.execute("reset_user_key", "admin", { user: "alice" }));
    assert.match(failed.message, /The key it had, if any, still works/);
    assert.equal(engine.keyIsTheirs("alice", alice.api_key), true, "as the answer says");
    // Again and again: the key it has is still the one that is stored, and still counts.
    for (let attempt = 0; attempt < 3; attempt++) await failure(engine.execute("reset_user_key", "admin", { user: "alice" }));
    assert.equal(engine.keyIsTheirs("alice", alice.api_key), true, "after four failed resets in a row");
    assert.equal((await Engine.open({ storage, keys })).keyIsTheirs("alice", alice.api_key), true, "and after a restart");
    keys.put = real;
    const replaced = (await engine.execute("reset_user_key", "admin", { user: "alice" })) as { api_key: string };
    assert.equal(engine.keyIsTheirs("alice", alice.api_key), true, "the one before it still has its mark, and is no longer stored anywhere");
    assert.equal(engine.keyIsTheirs("alice", replaced.api_key), true);
    assert.equal(keys.keys.get("alice"), replaced.api_key);

    // Restored, a user is one no key counts for until one is issued, also the key it had.
    const before = (await engine.execute("get", "admin", { id: "alice" })) as { version: number };
    await engine.execute("delete", "admin", { id: "alice", version: before.version });
    keys.keys.set("alice", replaced.api_key);
    await engine.execute("restore", "admin", { id: "alice" });
    keys.keys.set("alice", replaced.api_key);
    assert.equal(engine.keyIsTheirs("alice", replaced.api_key), false);
    const again = (await engine.execute("reset_user_key", "admin", { user: "alice" })) as { api_key: string };
    assert.deepEqual([engine.keyIsTheirs("alice", again.api_key), engine.keyIsTheirs("alice", replaced.api_key)], [true, false]);

    // The built-in users are not bound: their names cannot pass to anyone, and the admin key is made by the command line.
    assert.equal(engine.keyIsTheirs("admin", "vig_whatever-the-config-file-has-0123"), true);
    await engine.execute("reset_user_key", "admin", { user: "admin" });
    assert.equal(engine.keyIsTheirs("admin", "vig_whatever-the-config-file-has-0123"), true);
  });

  it("gives out a key that is stored and works although it could not be confirmed to last, with a warning", async () => {
    const keys = new MemoryKeyStore();
    const store = keys.put.bind(keys);
    // The key store has the key and says it could not make sure of it: a config that was replaced, in a folder that would not be flushed.
    keys.put = async (username: string, key: string) => {
      await store(username, key);
      return "the folder could not be flushed (EIO).";
    };
    const engine = await Engine.open({ storage: new MemoryStorage(), keys });
    const made = (await engine.execute("create_user", "admin", { username: "bob", type: "agent" })) as { api_key: string; warning?: string };
    assert.equal(keys.keys.get("bob"), made.api_key, "the key is the one that is stored");
    assert.equal(engine.keyIsTheirs("bob", made.api_key), true);
    assert.equal(made.warning, "This key is in place and works, but it may not survive a power cut: the folder could not be flushed (EIO). If it stops working after one, issue a new key with reset_user_key.");
    const reset = (await engine.execute("reset_user_key", "admin", { user: "bob" })) as { api_key: string; warning?: string };
    assert.equal(keys.keys.get("bob"), reset.api_key, "the new key is handed over, not withheld");
    assert.match(reset.warning!, /^This key is in place and works/);
    // With nothing to warn of, the answer has no such field.
    keys.put = store;
    assert.equal("warning" in ((await engine.execute("reset_user_key", "admin", { user: "bob" })) as object), false);
  });

  it("says of a restored user's old key that it no longer counts, when it cannot be removed", async () => {
    const keys = new MemoryKeyStore();
    const engine = await Engine.open({ storage: new MemoryStorage(), keys });
    const made = (await engine.execute("create_user", "admin", { username: "bob", type: "agent" })) as { api_key: string };
    await engine.execute("delete", "admin", { id: "bob", version: 1 });
    keys.keys.set("bob", made.api_key);
    keys.revoke = async () => Promise.reject(new Error("EACCES"));
    const error = await failure(engine.execute("restore", "admin", { id: "bob" }));
    assert.equal(error.message, "User bob was restored. The key it had before no longer counts for it, but could not be removed from where keys are kept.");
    assert.match(error.toJSON().actions![0]!, /^Call reset_user_key for bob/);
    assert.equal(engine.keyIsTheirs("bob", made.api_key), false, "as the message says");
  });

  it("issues a key for a user called constructor whose first key could not be stored", async () => {
    const keys = new MemoryKeyStore();
    const real = keys.put.bind(keys);
    keys.put = async () => Promise.reject(new Error("EACCES"));
    const engine = await Engine.open({ storage: new MemoryStorage(), keys });
    await failure(engine.execute("create_user", "admin", { username: "constructor", type: "agent" }));
    keys.put = real;
    const reset = (await engine.execute("reset_user_key", "admin", { user: "constructor" })) as { api_key: string };
    assert.equal(engine.keyIsTheirs("constructor", reset.api_key), true);
  });

  it("takes marks that are not a list, in data that was damaged, for the marks of no key, and writes them anew with the next key", async () => {
    const snapshot = await snapshotOf(async (engine) => {
      await engine.execute("create_user", "admin", { username: "bob", type: "agent" });
    });
    const bob = snapshot.objects.find((record) => record.kind === "user" && record.data.username === "bob")!;
    for (const damaged of [7, null, "a word", [1, 2], { a: 1 }]) {
      bob.data.key_marks = damaged as never;
      const log: OperationLog[] = [];
      const engine = await Engine.open({ storage: fixed(snapshot), onOperation: (entry) => log.push(entry) });
      assert.equal(engine.keyIsTheirs("bob", "vig_whatever-key-is-stored-0123456"), false, JSON.stringify(damaged));
      // A new key gets as far as being stored, which this store refuses: it did not stumble over the marks.
      await failure(engine.execute("reset_user_key", "admin", { user: "bob" }));
      assert.equal((log.at(-1)!.cause as Error).message, "read-only", JSON.stringify(damaged));
    }
  });

  it("knows a user by name without going through the plan, however the users come and go", async () => {
    const keys = new MemoryKeyStore();
    const engine = await Engine.open({ storage: new MemoryStorage(), keys });
    const first = (await engine.execute("create_user", "admin", { username: "bob", type: "agent" })) as { api_key: string; user: { id: string } };
    assert.equal(engine.user("bob")?.id, first.user.id);
    // Deleted, there is no such user to act as; the name is still taken until the user is deleted for good.
    await engine.execute("delete", "admin", { id: "bob", version: 1 });
    assert.equal(engine.user("bob"), undefined);
    assert.match((await failure(engine.execute("create_user", "admin", { username: "bob", type: "agent" }))).message, /bob/);
    await engine.execute("restore", "admin", { id: "bob" });
    assert.equal(engine.user("bob")?.id, first.user.id);
    // Deleted for good, the name is free, and whoever has it next is the one that is found.
    const now = (await engine.execute("get", "admin", { id: "bob" })) as { version: number };
    await engine.execute("delete", "admin", { id: "bob", version: now.version, permanent: true });
    assert.equal(engine.user("bob"), undefined);
    const second = (await engine.execute("create_user", "admin", { username: "bob", type: "person" })) as { api_key: string; user: { id: string } };
    assert.notEqual(second.user.id, first.user.id);
    assert.equal(engine.user("bob")?.id, second.user.id);
    assert.deepEqual([engine.keyIsTheirs("bob", second.api_key), engine.keyIsTheirs("bob", first.api_key)], [true, false]);

    // In a plan of many tasks, asking who someone is costs the same as in a small one: it is asked for every request.
    const snapshot = await snapshotOf(async (small) => {
      await small.execute("create_task", "agent1", task("One of many"));
    });
    const template = snapshot.objects.find((record) => record.kind === "task")!;
    // The tasks come before the users, as they do in a store, which reads records in the order of their kinds.
    const many = Array.from({ length: 59_999 }, (_, n) => ({ ...template, id: String(n + 2).padStart(3, "0") }));
    snapshot.objects = [...many, ...snapshot.objects];
    snapshot.head.counters.task = 60_000;
    const large = await Engine.open({ storage: fixed(snapshot) });
    const began = performance.now();
    let known = 0;
    for (let n = 0; n < 20_000; n++) if (large.user("agent1") && large.keyIsTheirs("agent1", "vig_any-key-at-all-0123456789abcd")) known++;
    const took = performance.now() - began;
    assert.equal(known, 20_000);
    assert.ok(took < 1000, `20,000 lookups among 60,000 tasks took ${took.toFixed(0)} ms`);
  });

  it("keeps a user's marks across a restart", async () => {
    const storage = new MemoryStorage();
    const keys = new MemoryKeyStore();
    const engine = await Engine.open({ storage, keys });
    const made = (await engine.execute("create_user", "admin", { username: "bob", type: "agent" })) as { api_key: string };
    const again = await Engine.open({ storage, keys });
    assert.deepEqual([again.keyIsTheirs("bob", made.api_key), again.keyIsTheirs("bob", "vig_another-key-altogether-012345")], [true, false]);
  });
});

describe("a second writer on the same store", () => {
  it("never overwrites what it has not seen: it reloads and tries again", async () => {
    const storage = new MemoryStorage();
    const first = await Engine.open({ storage });
    const second = await Engine.open({ storage });

    assert.equal(((await first.execute("create_task", "agent1", task("From the first"))) as any).id, "001");
    assert.equal(((await second.execute("create_task", "agent1", task("From the second"))) as any).id, "002");
    assert.equal(((await first.execute("create_task", "agent1", task("First again"))) as any).id, "003");
    assert.deepEqual(await ids(second), ["001", "002"], "a read may be stale until the next write");
    await second.reload();
    assert.deepEqual(await ids(second), ["001", "002", "003"]);
    assert.equal((await storage.load("default"))!.objects.filter((o) => o.kind === "task").length, 3);
  });

  it("checks the rules again against the fresh graph before it writes", async () => {
    const storage = new MemoryStorage();
    const first = await Engine.open({ storage });
    await first.execute("create_task", "agent1", task("A"));
    await first.execute("create_task", "agent1", task("B"));
    const second = await Engine.open({ storage });

    await first.execute("add_link", "agent1", { from: "001", type: "depends on", to: "002" });
    // The second engine has not seen that link. Without the revision check it would store a loop.
    const error = await failure(second.execute("add_link", "agent1", { from: "002", type: "depends on", to: "001" }));
    assert.equal(error.details.rule, "loop");
    assert.equal((await storage.load("default"))!.links.length, 1);

    await first.execute("set_task_status", "agent1", { id: "002", version: 1, status: "in_progress" });
    const stale = await failure(second.execute("set_task_status", "agent1", { id: "002", version: 1, status: "cancelled" }));
    assert.equal(stale.code, "version_conflict");
  });
});

/** The timelines of a store, each under the kind and ID of its item as they are stored. */
type Timelines = Record<string, JsonObject[]>;

/** A read-only store that serves one fixed snapshot, and the timelines that go with it when they are given. */
function fixed(snapshot: Snapshot, timelines: Timelines = {}): StorageAdapter {
  return {
    load: async () => structuredClone(snapshot),
    commit: async () => {
      throw new Error("read-only");
    },
    readRevision: async () => snapshot.head.revision,
    readText: async () => null,
    readHistory: async () => [],
    readHistoryPage: async () => ({ records: [], total: 0 }),
    readHistoryFeedPage: async () => ({ records: [], hasMore: false }),
    readTimeline: async (_tenant, kind, id, page = {}) => {
      const all = Object.hasOwn(timelines, `${kind} ${id}`) ? timelines[`${kind} ${id}`]! : [];
      const end = Math.min(page.before ?? all.length, all.length);
      const start = page.limit === undefined ? 0 : Math.max(0, end - page.limit);
      return { records: all.slice(start, end).map((data, index) => ({ kind, id, place: start + index, data })), total: all.length };
    },
    close: async () => {},
  };
}

async function snapshotOf(build: (engine: Engine) => Promise<void>): Promise<Snapshot> {
  const storage = new MemoryStorage();
  const engine = await Engine.open({ storage });
  await build(engine);
  return (await storage.load("default"))!;
}

/** The same, with the timeline of each project and task, which a snapshot does not hold. */
async function storedOf(build: (engine: Engine) => Promise<void>): Promise<{ snapshot: Snapshot; timelines: Timelines }> {
  const storage = new MemoryStorage();
  const engine = await Engine.open({ storage });
  await build(engine);
  const snapshot = (await storage.load("default"))!;
  const timelines: Timelines = {};
  for (const { kind, id } of snapshot.objects) {
    if (kind !== "user") timelines[`${kind} ${id}`] = (await storage.readTimeline("default", kind, id)).records.map((record) => record.data);
  }
  return { snapshot, timelines };
}

describe("a damaged or foreign store", () => {
  it("refuses data written in a newer format", async () => {
    const snapshot = await snapshotOf(async () => {});
    snapshot.head.format = 99;
    await assert.rejects(Engine.open({ storage: fixed(snapshot) }), /data format 99.*Upgrade the service/);
  });

  it("refuses data of an earlier format that the store has not brought to the present one", async () => {
    // In format 1 the statuses an item has had are a list in its record. Read as it is, every timeline would be
    // taken for empty and no task for completed.
    const snapshot = await snapshotOf(async (engine) => {
      await engine.execute("create_task", "agent1", task("A"));
    });
    snapshot.head.format = 1;
    await assert.rejects(Engine.open({ storage: fixed(snapshot) }), /is in data format 1, which the store has not brought to format 2/);
  });

  it("reports a healthy graph as consistent", async () => {
    const snapshot = await snapshotOf(async (engine) => {
      await engine.execute("create_project", "agent1", { title: "P", prefix: "ABC" });
      await engine.execute("create_task", "agent1", task("A", { project: "ABC" }));
      await engine.execute("create_task", "agent1", task("B", { project: "ABC", depends_on: ["ABC-001"], assigned_to: ["user"] }));
    });
    assert.deepEqual((await Engine.open({ storage: fixed(snapshot) })).checkConsistency(), []);
  });

  it("loads a large plan and checks it in time that grows with its size, not with its square", async () => {
    const small = await snapshotOf(async (engine) => {
      await engine.execute("create_project", "agent1", { title: "Big", prefix: "BIG" });
      await engine.execute("create_task", "agent1", task("First", { project: "BIG" }));
    });
    const template = small.objects.find((o) => o.kind === "task")!;
    const project = small.objects.find((o) => o.kind === "project")!;
    /** One project with that many tasks, each depending on the one before it: the two shapes that used to be slow. */
    const plan = (tasks: number): Snapshot => {
      const snapshot = structuredClone(small);
      const data = { at: "2026-01-01T00:00:00.000Z", by: "1" };
      for (let n = 2; n <= tasks; n++) {
        const id = `BIG-${String(n).padStart(3, "0")}`;
        snapshot.objects.push({ ...template, id });
        snapshot.links.push({ fromKind: "project", fromId: project.id, type: "contains", toKind: "task", toId: id, data });
        if (n > 2) snapshot.links.push({ fromKind: "task", fromId: id, type: "depends on", toKind: "task", toId: `BIG-${String(n - 1).padStart(3, "0")}`, data });
      }
      snapshot.head.counters.task = tasks;
      return snapshot;
    };
    const timed = async (tasks: number) => {
      const storage = fixed(plan(tasks));
      let best = Infinity;
      let found: string[] = [];
      for (let round = 0; round < 3; round++) {
        const began = performance.now();
        const engine = await Engine.open({ storage });
        found = engine.checkConsistency();
        best = Math.min(best, performance.now() - began);
      }
      return { ms: best, found };
    };
    const few = await timed(4000);
    const many = await timed(16000);
    assert.deepEqual(many.found, [], "a long chain is not a loop");
    // Four times the tasks. In step with the size that is four times the time; with its square, sixteen times.
    assert.ok(many.ms < Math.max(8 * few.ms, 500), `4,000 tasks took ${few.ms.toFixed(0)} ms, 16,000 took ${many.ms.toFixed(0)} ms`);
  });

  it("reads a project of groups nested deep in time that grows with its size, not with its square", async () => {
    const small = await snapshotOf(async (engine) => {
      await engine.execute("create_project", "agent1", { title: "Deep", prefix: "DEEP" });
      await engine.execute("create_task", "agent1", task("Outermost", { project: "DEEP" }));
    });
    const template = small.objects.find((o) => o.kind === "task")!;
    const project = small.objects.find((o) => o.kind === "project")!;
    /** Finished groups one inside the other, that many deep, with one open task in the innermost when asked for. */
    const plan = (depth: number, open: boolean): Snapshot => {
      const snapshot = structuredClone(small);
      const data = { at: "2026-01-01T00:00:00.000Z", by: "1" };
      const id = (n: number) => `DEEP-${String(n).padStart(3, "0")}`;
      const done = { ...template.data, status: "done" };
      snapshot.objects = snapshot.objects.filter((o) => o.kind !== "task");
      snapshot.links = snapshot.links.filter((l) => l.toKind !== "task");
      for (let n = 1; n <= depth; n++) {
        snapshot.objects.push({ ...template, id: id(n), data: n === depth && open ? template.data : done });
        snapshot.links.push({ fromKind: "project", fromId: project.id, type: "contains", toKind: "task", toId: id(n), data });
        if (n > 1) snapshot.links.push({ fromKind: "task", fromId: id(n - 1), type: "contains", toKind: "task", toId: id(n), data });
      }
      snapshot.head.counters.task = depth;
      return snapshot;
    };
    const timed = async (depth: number) => {
      const engine = await Engine.open({ storage: fixed(plan(depth, false)) });
      let best = Infinity;
      let found: unknown[] = [];
      for (let round = 0; round < 3; round++) {
        const began = performance.now();
        const projects = (await engine.execute("list_projects", "agent1", {})) as { projects: Array<{ has_problems: boolean }> };
        found = [projects.projects[0]!.has_problems, ((await engine.execute("list_tasks", "agent1", { has_problems: true })) as { tasks: unknown[] }).tasks.length];
        best = Math.min(best, performance.now() - began);
      }
      return { ms: best, found };
    };
    const few = await timed(1500);
    const many = await timed(6000);
    assert.deepEqual(many.found, [false, 0], "finished groups that hold finished groups are in order");
    assert.ok(many.ms < Math.max(8 * few.ms, 500), `1,500 deep took ${few.ms.toFixed(0)} ms, 6,000 deep took ${many.ms.toFixed(0)} ms`);

    // The worst case for telling who has a problem: one open task at the bottom, so that every group above it
    // has one. Asking each of them costs no more than once down the chain, and only the page that is returned
    // has its problems put into words.
    const flaggedIn = async (depth: number) => {
      const engine = await Engine.open({ storage: fixed(plan(depth, true)) });
      let best = Infinity;
      let found: unknown[] = [];
      for (let round = 0; round < 3; round++) {
        const began = performance.now();
        const page = (await engine.execute("list_tasks", "agent1", { has_problems: true })) as { tasks: Array<{ problems: Array<{ code: string }> }> };
        const projects = (await engine.execute("list_projects", "agent1", { has_problems: true })) as { projects: unknown[] };
        found = [page.tasks.length, page.tasks[0]!.problems[0]!.code, projects.projects.length];
        best = Math.min(best, performance.now() - began);
      }
      return { ms: best, found };
    };
    const fewFlagged = await flaggedIn(1500);
    const manyFlagged = await flaggedIn(6000);
    assert.deepEqual(manyFlagged.found, [100, "done_with_unfinished_contents", 1]);
    assert.ok(manyFlagged.ms < Math.max(8 * fewFlagged.ms, 500), `with every group flagged: 1,500 deep took ${fewFlagged.ms.toFixed(0)} ms, 6,000 deep took ${manyFlagged.ms.toFixed(0)} ms`);

    // The same depth with one open task at the bottom: every group above it is flagged, and it is still found.
    const engine = await Engine.open({ storage: fixed(plan(300, true)) });
    const flagged = ((await engine.execute("list_tasks", "agent1", { has_problems: true })) as { tasks: Array<{ id: string }> }).tasks;
    assert.equal(flagged.length, 100, "a page of the 299 groups that are done above an open task");
    assert.equal(((await engine.execute("list_projects", "agent1", { has_problems: true })) as { projects: unknown[] }).projects.length, 1);
  });

  it("answers get, a refused loop and a refused start with the same few kilobytes whatever the size of the plan", async () => {
    const small = await snapshotOf(async (engine) => {
      await engine.execute("create_project", "agent1", { title: "Big", prefix: "BIG" });
      await engine.execute("create_task", "agent1", task("First", { project: "BIG" }));
    });
    const template = small.objects.find((o) => o.kind === "task")!;
    const person = small.objects.find((o) => o.kind === "user" && o.data.username === "user")!;
    /**
     * A plan in which everything that `get` lists grows with the number of tasks: one project that holds them
     * all, one user who has them all, a first task that waits for every other and has changed status as often
     * as there are tasks, and each further task waiting for the one before it. The history of every item is as
     * long as the plan too.
     */
    const plan = (tasks: number): StorageAdapter => {
      const snapshot = structuredClone(small);
      const data = { at: "2026-01-01T00:00:00.000Z", by: "1" };
      const id = (n: number) => `BIG-${String(n).padStart(3, "0")}`;
      const timelines = { [`task ${id(1)}`]: Array.from({ length: tasks }, (_, n) => ({ status: n % 2 ? "draft" : "open", at: new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString(), by: "1" })) };
      snapshot.links.push({ fromKind: "task", fromId: id(1), type: "assigned to", toKind: "user", toId: person.id, data });
      for (let n = 2; n <= tasks; n++) {
        snapshot.objects.push({ ...template, id: id(n) });
        snapshot.links.push({ fromKind: "project", fromId: "BIG", type: "contains", toKind: "task", toId: id(n), data });
        snapshot.links.push({ fromKind: "task", fromId: id(1), type: "depends on", toKind: "task", toId: id(n), data });
        snapshot.links.push({ fromKind: "task", fromId: id(n), type: "assigned to", toKind: "user", toId: person.id, data });
        if (n > 2) snapshot.links.push({ fromKind: "task", fromId: id(n), type: "depends on", toKind: "task", toId: id(n - 1), data });
      }
      snapshot.head.counters.task = tasks;
      return {
        ...fixed(snapshot, timelines),
        // One entry for each revision from 1 to the number of tasks, of which a page is the latest before a given one.
        readHistoryPage: async (_tenant, kind, item, page) => {
          const end = page.before ? page.before.revision - 1 : tasks;
          const records = [];
          for (let revision = Math.max(1, end - page.limit + 1); revision <= end; revision++) records.push({ kind, id: item, at: data.at, actor: "1", action: "updated", data: { changes: { priority: [1, 2] } }, revision, seq: 0 });
          return { records, total: tasks };
        },
      };
    };
    /** The longest list anywhere in an answer. */
    const longest = (value: unknown): number => {
      if (Array.isArray(value)) return Math.max(value.length, ...value.map(longest));
      if (value && typeof value === "object") return Math.max(0, ...Object.values(value).map(longest));
      return 0;
    };
    const answers = async (tasks: number) => {
      const engine = await Engine.open({ storage: plan(tasks) });
      const get = (input: Record<string, unknown>) => engine.execute("get", "agent1", input) as Promise<any>;
      const project = await get({ id: "BIG", history: true });
      const first = await get({ id: "BIG-001", history: true });
      const user = await get({ kind: "user", id: "user", history: true });
      const all: Record<string, unknown> = {
        "the project": project,
        "the next page of what the project contains": await get({ id: "BIG", continuation: project.more.links.contains.continuation }),
        "the task that waits for every other": first,
        "the next page of what it depends on": await get({ id: "BIG-001", continuation: first.more.links["depends on"].continuation }),
        "the timeline before the latest": await get({ id: "BIG-001", continuation: first.more.timeline.continuation }),
        "the history before the latest": await get({ id: "BIG-001", continuation: first.more.history.continuation }),
        "the user who has every task": user,
        "the next page of what the user has": await get({ kind: "user", id: "user", continuation: user.more.links["is assigned"].continuation }),
        "a refused loop": (await failure(engine.execute("add_link", "agent1", { from: "BIG-002", type: "depends on", to: `BIG-${tasks}` }))).toJSON(),
        "a refused start": (await failure(engine.execute("set_task_status", "agent1", { id: "BIG-001", version: 1, status: "in_progress" }))).toJSON(),
      };
      // What each answer counts is the whole, of which it returns a part.
      assert.deepEqual(
        [project.more.links.contains.total, project.more.history.total, first.more.links["depends on"].total, first.more.depends_on.total, first.more.waiting_for.total, first.more.timeline.total, user.more.links["is assigned"].total, (all["a refused loop"] as any).blocking_total, (all["a refused start"] as any).blocking_total],
        [tasks, tasks, tasks - 1, tasks - 1, tasks - 1, tasks, tasks, tasks - 2, tasks - 1],
      );
      return Object.entries(all).map(([what, answer]) => ({ what, bytes: JSON.stringify(answer).length, longest: longest(answer) }));
    };
    const few = await answers(400);
    const many = await answers(4000);
    for (const [index, answer] of many.entries()) {
      assert.ok(answer.longest <= 100, `${answer.what}: no list in it is longer than 100, the longest has ${answer.longest}`);
      // Ten times the plan. The answer gains the digits its counts gain, and those of the places of its hundred
      // changes, each of which is a revision of a plan that has had ten times as many: nothing else.
      assert.ok(answer.bytes <= few[index]!.bytes + 300, `${answer.what}: ${few[index]!.bytes} bytes for 400 tasks, ${answer.bytes} for 4,000`);
      assert.ok(answer.bytes < 40_000, `${answer.what}: ${answer.bytes} bytes`);
    }
  });

  it("fills the pages of a list of links from the links that lead somewhere, counts those, and goes once through a list that mostly leads nowhere", async () => {
    const small = await snapshotOf(async (engine) => {
      await engine.execute("create_task", "agent1", task("Waits for what is partly gone"));
      await engine.execute("create_task", "agent1", task("Holds what is partly gone"));
      await engine.execute("create_task", "agent1", task("First of a chain"));
    });
    const template = small.objects.find((o) => o.kind === "task")!;
    const id = (n: number) => String(n).padStart(3, "0");
    const letters = (n: number) => Array.from({ length: 5 }, (_, place) => String.fromCharCode(65 + (Math.floor(n / 26 ** place) % 26))).join("");
    /**
     * A plan as damage leaves it. Task 001 depends on that many projects that are not there, which stand before
     * every task in the order of a list, and on five tasks that are. Task 002 holds 150 tasks that are there and,
     * before them, 50 that are not. Tasks 501 to 530 each wait for the next, and five of them are not there.
     */
    const plan = (gone: number): Snapshot => {
      const snapshot = structuredClone(small);
      const data = { at: "2026-01-01T00:00:00.000Z", by: "1" };
      const link = (fromId: string, type: string, toKind: string, toId: string) => snapshot.links.push({ fromKind: "task", fromId, type, toKind, toId, data });
      const there = (n: number) => snapshot.objects.push({ ...template, id: id(n) });
      for (let n = 0; n < gone; n++) link("001", "depends on", "project", `G${letters(n)}`);
      for (let n = 11; n <= 15; n++) (there(n), link("001", "depends on", "task", id(n)));
      for (let n = 50; n < 100; n++) link("002", "contains", "task", id(n));
      for (let n = 100; n < 250; n++) (there(n), link("002", "contains", "task", id(n)));
      for (let n = 501; n <= 530; n++) {
        if (n < 504 || n > 508) there(n);
        if (n < 530) link(id(n), "depends on", "task", id(n + 1));
      }
      snapshot.head.counters.task = 600;
      return snapshot;
    };
    const engine = await Engine.open({ storage: fixed(plan(100)) });
    const get = (input: Record<string, unknown>) => engine.execute("get", "agent1", input) as Promise<any>;
    const ids = (items: Array<{ id: string }>) => items.map((item) => item.id);

    // A hundred links that lead nowhere stand before the five that lead somewhere: the first page is those five,
    // not an empty page with more behind it that nobody could ask for.
    const waits = await get({ id: "001" });
    assert.deepEqual([ids(waits.links["depends on"]), waits.depends_on, "more" in waits], [["011", "012", "013", "014", "015"], ["011", "012", "013", "014", "015"], false]);
    // What a list counts is what its pages hold: 150, in two pages, and none of the 50 that are not there.
    const holds = await get({ id: "002" });
    assert.deepEqual([ids(holds.links.contains).slice(0, 2), holds.links.contains.length, holds.more.links.contains.total], [["100", "101"], 100, 150]);
    const rest = await get({ id: "002", continuation: holds.more.links.contains.continuation });
    assert.deepEqual([ids(rest.links.contains).at(0), ids(rest.links.contains).at(-1), rest.links.contains.length, "more" in rest], ["200", "249", 50, false]);
    // A token that names a place among the links that lead nowhere goes on from there to those that lead somewhere.
    const { q } = JSON.parse(Buffer.from(holds.more.links.contains.continuation, "base64url").toString("utf8")) as { q: string };
    const from = await get({ id: "002", continuation: Buffer.from(JSON.stringify({ q, k: "task:060" }), "utf8").toString("base64url") });
    assert.deepEqual([ids(from.links.contains).at(0), from.links.contains.length, from.more.links.contains.total], ["100", 100, 150]);
    // The damage is said where damage is said: to whoever checks the plan.
    assert.equal(engine.checkConsistency().filter((problem) => /^Link points at an item that does not exist/.test(problem)).length, 100 + 50 + 6);

    // A refused loop that runs through items that are not there names and counts the items that are: 29 steps
    // lie between the two ends of the new link, 24 of them are there, 20 are named.
    const loop = (await failure(engine.execute("add_link", "agent1", { from: "530", type: "depends on", to: "501" }))).toJSON();
    assert.deepEqual([loop.rule, loop.blocking!.length, loop.blocking_total, loop.blocking!.map((item) => item.id).slice(0, 4)], ["loop", 20, 24, ["501", "502", "503", "509"]]);

    // However many links lead nowhere, one reading goes through the item's links once: ten times as many take
    // about ten times as long, and the answer is the same.
    const timed = async (gone: number) => {
      const large = await Engine.open({ storage: fixed(plan(gone)) });
      let best = Infinity;
      let answer = "";
      for (let round = 0; round < 5; round++) {
        const began = performance.now();
        answer = JSON.stringify(((await large.execute("get", "agent1", { id: "001" })) as any).links);
        best = Math.min(best, performance.now() - began);
      }
      return { ms: best, answer };
    };
    const few = await timed(10_000);
    const many = await timed(100_000);
    assert.equal(many.answer, JSON.stringify(waits.links));
    assert.ok(many.ms < Math.max(30 * few.ms, 250), `10,000 links to nothing took ${few.ms.toFixed(1)} ms, 100,000 took ${many.ms.toFixed(1)} ms`);
  });

  it("finds loops, links to nothing, unknown link types, counters that fell behind and missing built-in users", async () => {
    const snapshot = await snapshotOf(async (engine) => {
      await engine.execute("create_task", "agent1", task("A"));
      await engine.execute("create_task", "agent1", task("B", { depends_on: ["001"] }));
    });
    const link = (fromId: string, type: string, toId: string) => ({ fromKind: "task", fromId, type, toKind: "task", toId, data: { at: "2026-01-01T00:00:00.000Z", by: "1" } });
    snapshot.links.push(link("001", "depends on", "002"), link("001", "depends on", "404"), link("001", "blocks", "002"));
    snapshot.head.counters.task = 1;
    snapshot.objects = snapshot.objects.filter((o) => !(o.kind === "user" && o.data.username === "agent1"));

    const engine = await Engine.open({ storage: fixed(snapshot) });
    const found = engine.checkConsistency();
    assert.ok(found.some((p) => p.startsWith("Loop: ")), found.join("\n"));
    assert.ok(found.some((p) => p.includes("does not exist") && p.includes("task:404")));
    assert.ok(found.some((p) => p.includes("unknown type") && p.includes("blocks")));
    assert.ok(found.some((p) => p.includes("task counter is at 1, behind the highest ID in use (2)")));
    assert.ok(found.some((p) => p.includes('built-in user "agent1" is missing')));
  });

  it("finds items whose fields are not what the engine reads them as, and finds nothing wrong with those it wrote", async () => {
    const { snapshot: whole, timelines } = await storedOf(async (engine) => {
      await engine.execute("create_project", "agent1", { title: "P", prefix: "abc" });
      const inProject = (await engine.execute("create_task", "agent1", task("In a project", { project: "ABC", why: "because", value: 3, size: 2 }))) as { id: string };
      const bug = (await engine.execute("create_task", "agent1", task("A bug", { type: "bug" }))) as { id: string };
      await engine.execute("set_task_status", "agent1", { id: inProject.id, version: 1, status: "in_progress" });
      await engine.execute("create_user", "admin", { username: "bob", type: "person" });
      await engine.execute("delete", "admin", { id: bug.id, version: 1 });
      const finished = (await engine.execute("create_task", "agent1", task("Finished"))) as { id: string };
      await engine.execute("set_task_status", "agent1", { id: finished.id, version: 1, status: "done" });
    });
    const sound = await Engine.open({ storage: fixed(whole, timelines) });
    assert.deepEqual([sound.checkConsistency(), await sound.checkTimelines()], [[], []], "what the operations write passes");

    const damaged = (change: (snapshot: Snapshot) => void) => {
      const snapshot = structuredClone(whole);
      change(snapshot);
      return Engine.open({ storage: fixed(snapshot) }).then((engine) => engine.checkConsistency());
    };
    const of = (snapshot: Snapshot, kind: string) => snapshot.objects.find((record) => record.kind === kind)!;
    // A task that does not say when it was completed is what breaks every list of tasks: the completion date is
    // read from the task, for every task that is done.
    assert.match((await damaged((s) => delete of(s, "task").data.completed_at)).join("\n"), /The task \S+ is damaged: completed_at is not what it has to be/);
    assert.match((await damaged((s) => (of(s, "task").data.completed_at = "last week"))).join("\n"), /completed_at is not what it has to be \(not a moment in time\)/);
    assert.match((await damaged((s) => (of(s, "task").data.status = "sideways"))).join("\n"), /The task \S+ is damaged: status is not what it has to be/);
    // A task says when it was completed exactly while it is done: one that is done and does not say when has no
    // moment at which it was completed, and one that says when and is not done would show a date nobody set.
    assert.match((await damaged((s) => (of(s, "task").data.status = "done"))).join("\n"), /The task \S+ is damaged: has the status done, and nothing that says when it was completed/);
    assert.match((await damaged((s) => (of(s, "task").data.completed_at = "2026-01-01T00:00:00.000Z"))).join("\n"), /The task \S+ is damaged: says when it was completed, and has the status in_progress/);
    assert.match((await damaged((s) => (of(s, "task").data.priority = "high"))).join("\n"), /priority is not what it has to be/);
    assert.match((await damaged((s) => delete of(s, "project").data.title)).join("\n"), /The project \S+ is damaged: title is not what it has to be/);
    assert.match((await damaged((s) => (of(s, "user").data.built_in = "yes"))).join("\n"), /The user \S+ is damaged: built_in is not what it has to be/);
    assert.match((await damaged((s) => (of(s, "user").data.key_marks = 7 as never))).join("\n"), /key_marks is not what it has to be/);
    assert.match((await damaged((s) => (of(s, "project").kind = "gizmo"))).join("\n"), /The gizmo \S+ is damaged: is of a kind that is not known/);
    // A kind that is a word every object answers to is as unknown as any other, and the check says so and goes on.
    assert.match((await damaged((s) => (of(s, "project").kind = "constructor"))).join("\n"), /The constructor \S+ is damaged: is of a kind that is not known/);
    // Every item says whether it is deleted: only one that says it is not counts as live.
    for (const kind of ["task", "project", "user"]) {
      assert.match((await damaged((s) => delete of(s, kind).data.deleted_at)).join("\n"), new RegExp(`The ${kind} \\S+ is damaged: deleted_at is not what it has to be`), kind);
    }
    assert.match((await damaged((s) => delete of(s, "task").data.value)).join("\n"), /value is not what it has to be/);
    assert.match((await damaged((s) => delete of(s, "project").data.prefix)).join("\n"), /prefix is not what it has to be/);
    // A prefix that could be given to a new project, and that is the project's ID: the IDs of its tasks are made with it.
    assert.match((await damaged((s) => (of(s, "project").data.prefix = "bad prefix"))).join("\n"), /The project \S+ is damaged: prefix is not what it has to be \(not a prefix\)/);
    assert.match((await damaged((s) => (of(s, "project").data.prefix = "USER"))).join("\n"), /prefix is not what it has to be/);
    assert.match((await damaged((s) => (of(s, "project").data.prefix = "XYZ"))).join("\n"), /The project ABC is damaged: has a prefix that does not go with its ID/);
    assert.match((await damaged((s) => (of(s, "project").data.prefix = null))).join("\n"), /has a prefix that does not go with its ID/);
    // An ID in the form its kind has, or the item cannot be asked for; a version from 1 up, or no change can name it.
    assert.match((await damaged((s) => (of(s, "task").id = "garbage"))).join("\n"), /The task garbage is damaged: has an ID that an item of its kind cannot have/);
    assert.match((await damaged((s) => (of(s, "user").id = "none"))).join("\n"), /The user \S+ is damaged: has an ID that an item of its kind cannot have/);
    for (const version of [0, -3, 1.5]) assert.match((await damaged((s) => (of(s, "task").version = version))).join("\n"), /version is not what it has to be/, String(version));
    // Moments that are moments, people that are users, names that are names, and one user to a name.
    assert.match((await damaged((s) => (of(s, "task").data.created_at = "the other day"))).join("\n"), /created_at is not what it has to be \(not a moment in time\)/);
    assert.match((await damaged((s) => (of(s, "task").data.created_by = "somebody"))).join("\n"), /created_by is not what it has to be/);
    assert.match((await damaged((s) => (s.objects.find((r) => r.kind === "user" && r.data.username === "bob")!.data.username = "Bob Smith"))).join("\n"), /username is not what it has to be \(not a username\)/);
    assert.match((await damaged((s) => (s.objects.find((r) => r.kind === "user" && r.data.username === "bob")!.data.username = "agent1"))).join("\n"), /Two users are called "agent1"/);
    // An item stored under an ID the store would not write looks right in the plan, and every change to it
    // would go past what is stored: the number of a user with a nought before it, for the user and for a link to it.
    const bobs = (s: Snapshot) => s.objects.find((r) => r.kind === "user" && r.data.username === "bob")!;
    assert.match((await damaged((s) => (bobs(s).id = `0${bobs(s).id}`))).join("\n"), /The user is stored under "0\d+", where the store writes "\d+": a change to it would miss what is stored/);
    assert.match(
      (await damaged((s) => s.links.push({ fromKind: "task", fromId: of(s, "task").id, type: "assigned to", toKind: "user", toId: `0${bobs(s).id}`, data: { at: "2026-01-01T00:00:00.000Z", by: "1" } }))).join("\n"),
      /The user at one end of a link is stored under "0\d+", where the store writes "\d+"/,
    );
    // A built-in user is what it was made as: an admin that is an agent leaves nobody who can do an admin's work.
    assert.match((await damaged((s) => (s.objects.find((r) => r.kind === "user" && r.data.username === "admin")!.data.type = "agent"))).join("\n"), /The built-in user "admin" is of type agent, not admin/);
  });

  it("finds timelines that are not what the engine reads them as: empty, of statuses the kind does not have, or not ending with the status the item has", async () => {
    const { snapshot: whole, timelines: sound } = await storedOf(async (engine) => {
      await engine.execute("create_project", "agent1", { title: "P", prefix: "abc" });
      const started = (await engine.execute("create_task", "agent1", task("Started", { project: "ABC" }))) as { id: string };
      await engine.execute("set_task_status", "agent1", { id: started.id, version: 1, status: "in_progress" });
      const finished = (await engine.execute("create_task", "agent1", task("Finished", { project: "ABC" }))) as { id: string };
      await engine.execute("set_task_status", "agent1", { id: finished.id, version: 1, status: "done" });
    });
    const damaged = async (change: (timelines: Timelines, snapshot: Snapshot) => void) => {
      const snapshot = structuredClone(whole);
      const timelines = structuredClone(sound);
      change(timelines, snapshot);
      const engine = await Engine.open({ storage: fixed(snapshot, timelines) });
      // The records themselves are sound in each of these: what is wrong is beside them.
      assert.deepEqual(engine.checkConsistency(), []);
      return (await engine.checkTimelines()).join("\n");
    };
    const record = (snapshot: Snapshot, kind: string, id: string) => snapshot.objects.find((r) => r.kind === kind && r.id === id)!;
    // Every change of status adds an entry, the status an item is created with being the first: there is always one.
    assert.match(await damaged((t) => delete t["task ABC-001"]), /^The task ABC-001 is damaged: timeline is not what it has to be \(empty\)$/);
    assert.match(await damaged((t) => (t["project ABC"] = [])), /^The project ABC is damaged: timeline is not what it has to be \(empty\)$/);
    // Each entry names a status of the item's kind, a moment and a user.
    assert.match(await damaged((t) => (t["task ABC-001"]![0] = { status: "open" })), /The task ABC-001 is damaged: timeline\.0\.at is not what it has to be/);
    assert.match(await damaged((t) => (t["task ABC-001"]![0]!.status = "sideways")), /timeline\.0\.status is not what it has to be/);
    assert.match(await damaged((t) => (t["task ABC-001"]![1]!.by = "somebody")), /timeline\.1\.by is not what it has to be \(not the id of a user\)/);
    assert.match(await damaged((t) => (t["project ABC"]![0]!.status = "in_progress")), /The project ABC is damaged: timeline\.0\.status is not what it has to be/);
    assert.match(await damaged((t) => (t["task ABC-002"]![1] = 7 as never)), /The task ABC-002 is damaged: timeline\.1\.status is not what it has to be/);
    // The last entry is the status the item has: the next change would otherwise start from a status it never took.
    assert.match(await damaged((_, s) => (record(s, "task", "ABC-001").data.status = "paused")), /^The task ABC-001 is damaged: has the status paused, and its timeline ends with in_progress$/);
    assert.match(await damaged((_, s) => (record(s, "project", "ABC").data.status = "ready")), /^The project ABC is damaged: has the status ready, and its timeline ends with open$/);
    assert.match(await damaged((t) => t["task ABC-002"]!.pop()), /^The task ABC-002 is damaged: has the status done, and its timeline ends with open$/);
    // And for a task that is done, the moment of that entry is when the task says it was completed.
    assert.match(await damaged((t) => (t["task ABC-002"]![1]!.at = "2020-01-01T00:00:00.000Z")), /^The task ABC-002 is damaged: says it was completed on 2026-\S+, and its timeline on 2020-01-01T00:00:00.000Z$/);
    // An entry far from the end of a long timeline is found too, and of several the earliest is the one named.
    const long = (bad: number[]) => (t: Timelines) => {
      t["task ABC-001"] = Array.from({ length: 1201 }, (_, place) => ({ status: bad.includes(place) ? "sideways" : place % 2 ? "in_progress" : "open", at: "2026-01-01T00:00:00.000Z", by: "3" }));
      t["task ABC-001"]!.push({ status: "in_progress", at: "2026-01-01T00:00:00.000Z", by: "3" });
    };
    assert.equal(await damaged(long([])), "");
    assert.match(await damaged(long([3])), /^The task ABC-001 is damaged: timeline\.3\.status is not what it has to be/);
    assert.match(await damaged(long([1100, 640, 7])), /^The task ABC-001 is damaged: timeline\.7\.status is not what it has to be/);
    // The check stops at the first few items it finds damaged: it says that the data is damaged, not all of how.
    assert.equal((await damaged((t) => Object.keys(t).forEach((key) => (t[key] = [])))).split("\n").length, 3);
  });
});
