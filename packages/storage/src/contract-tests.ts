import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CommitTooLargeError,
  FORMAT_VERSION,
  MAX_RECORDS_PER_COMMIT,
  RevisionConflictError,
  type Change,
  type StorageAdapter,
} from "./types.js";

export interface AdapterFactory {
  /** A new, empty store. */
  create(): Promise<StorageAdapter>;
  /** Opens the same store again after `close()`. Omit for adapters that keep nothing once closed. */
  reopen?(): Promise<StorageAdapter>;
  cleanup?(): Promise<void>;
}

const task = (id: string, version = 1, title = "A task"): Change => ({
  op: "put_object",
  record: { kind: "task", id, version, data: { title } },
  text: `Description of ${id}`,
});

/** The behaviour every storage adapter must have. Run it once per adapter. */
export function runStorageContractTests(name: string, factory: () => AdapterFactory): void {
  describe(`storage contract: ${name}`, () => {
    const withStore = async (fn: (store: StorageAdapter, f: AdapterFactory) => Promise<void>) => {
      const f = factory();
      const store = await f.create();
      try {
        await fn(store, f);
      } finally {
        await store.close().catch(() => {});
        await f.cleanup?.();
      }
    };

    it("returns null for a tenant that does not exist", () =>
      withStore(async (store) => {
        assert.equal(await store.load("default"), null);
        assert.equal(await store.readText("default", "task", "001"), null);
        assert.deepEqual(await store.readHistory("default", "task", "001"), []);
        assert.deepEqual(await store.readHistoryPage("default", "task", "001", { limit: 10 }), { records: [], total: 0 });
        assert.equal(await store.readRevision("default"), null);
      }));

    it("says which revision a tenant is at without reading anything else: after each commit, not after one that was refused, and whatever is read meanwhile", () =>
      withStore(async (store) => {
        await store.commit("default", { expectedRevision: null, counters: { task: 1 }, changes: [task("001")] });
        assert.equal(await store.readRevision("default"), 1);
        await store.commit("default", { expectedRevision: 1, counters: { task: 2 }, changes: [task("002"), { op: "add_history", record: { kind: "task", id: "002", at: "t", actor: "1", action: "created", data: {} } }] });
        assert.equal(await store.readRevision("default"), 2);
        await assert.rejects(store.commit("default", { expectedRevision: 1, counters: {}, changes: [task("003")] }), RevisionConflictError);
        await store.readText("default", "task", "001");
        await store.readHistoryPage("default", "task", "002", { limit: 5 });
        await store.load("default");
        assert.equal(await store.readRevision("default"), 2);
        assert.equal(await store.readRevision("another"), null);
      }));

    it("creates a tenant at revision 1 and loads it back", () =>
      withStore(async (store) => {
        const head = await store.commit("default", { expectedRevision: null, counters: { task: 1 }, changes: [task("001")] });
        assert.deepEqual(head, { format: FORMAT_VERSION, revision: 1, counters: { task: 1 } });
        const snapshot = await store.load("default");
        assert.deepEqual(snapshot?.head, head);
        assert.deepEqual(snapshot?.objects, [{ kind: "task", id: "001", version: 1, data: { title: "A task" } }]);
        assert.deepEqual(snapshot?.links, []);
      }));

    it("keeps long text out of the snapshot and returns it on demand", () =>
      withStore(async (store) => {
        await store.commit("default", { expectedRevision: null, counters: {}, changes: [task("001")] });
        assert.equal(await store.readText("default", "task", "001"), "Description of 001");
        const snapshot = await store.load("default");
        assert.equal(JSON.stringify(snapshot).includes("Description of 001"), false);
      }));

    it("keeps the stored text when an object is put without text", () =>
      withStore(async (store) => {
        await store.commit("default", { expectedRevision: null, counters: {}, changes: [task("001")] });
        await store.commit("default", {
          expectedRevision: 1,
          counters: {},
          changes: [{ op: "put_object", record: { kind: "task", id: "001", version: 2, data: { title: "Renamed" } } }],
        });
        assert.equal(await store.readText("default", "task", "001"), "Description of 001");
        const snapshot = await store.load("default");
        assert.deepEqual(snapshot?.objects[0], { kind: "task", id: "001", version: 2, data: { title: "Renamed" } });
      }));

    it("replaces the stored text when one is given, including an empty one", () =>
      withStore(async (store) => {
        await store.commit("default", { expectedRevision: null, counters: {}, changes: [task("001")] });
        await store.commit("default", {
          expectedRevision: 1,
          counters: {},
          changes: [{ op: "put_object", record: { kind: "task", id: "001", version: 2, data: {} }, text: "" }],
        });
        assert.equal(await store.readText("default", "task", "001"), "");
      }));

    it("rejects a commit made against a stale revision and writes nothing", () =>
      withStore(async (store) => {
        await store.commit("default", { expectedRevision: null, counters: {}, changes: [task("001")] });
        await assert.rejects(
          store.commit("default", { expectedRevision: 0, counters: { task: 9 }, changes: [task("002")] }),
          RevisionConflictError,
        );
        await assert.rejects(
          store.commit("default", { expectedRevision: null, counters: {}, changes: [task("002")] }),
          RevisionConflictError,
        );
        const snapshot = await store.load("default");
        assert.equal(snapshot?.head.revision, 1);
        assert.equal(snapshot?.objects.length, 1);
      }));

    it("rejects a commit to a missing tenant unless it expects none", () =>
      withStore(async (store) => {
        await assert.rejects(store.commit("default", { expectedRevision: 3, counters: {}, changes: [] }), RevisionConflictError);
        assert.equal(await store.load("default"), null);
      }));

    it("stores each link once and deletes it by key", () =>
      withStore(async (store) => {
        const key = { fromKind: "project", fromId: "ABC", type: "contains", toKind: "task", toId: "ABC-001" };
        await store.commit("default", {
          expectedRevision: null,
          counters: {},
          changes: [
            { op: "put_link", record: { ...key, data: { by: "1" } } },
            { op: "put_link", record: { ...key, data: { by: "2" } } },
          ],
        });
        assert.deepEqual((await store.load("default"))?.links, [{ ...key, data: { by: "2" } }]);
        await store.commit("default", { expectedRevision: 1, counters: {}, changes: [{ op: "delete_link", key }] });
        assert.deepEqual((await store.load("default"))?.links, []);
      }));

    it("deletes an object together with its text", () =>
      withStore(async (store) => {
        await store.commit("default", { expectedRevision: null, counters: {}, changes: [task("001"), task("002")] });
        await store.commit("default", { expectedRevision: 1, counters: {}, changes: [{ op: "delete_object", kind: "task", id: "001" }] });
        const snapshot = await store.load("default");
        assert.deepEqual(snapshot?.objects.map((o) => o.id), ["002"]);
        assert.equal(await store.readText("default", "task", "001"), null);
      }));

    it("returns an item's history oldest first, with the revision that wrote it", () =>
      withStore(async (store) => {
        const entry = (action: string, id = "001") => ({
          op: "add_history" as const,
          record: { kind: "task", id, at: "2026-01-01T00:00:00.000Z", actor: "3", action, data: { n: 1 } },
        });
        await store.commit("default", { expectedRevision: null, counters: {}, changes: [entry("created"), entry("created", "002")] });
        await store.commit("default", { expectedRevision: 1, counters: {}, changes: [entry("status_changed"), entry("updated")] });
        const history = await store.readHistory("default", "task", "001");
        assert.deepEqual(
          history.map((h) => [h.revision, h.seq, h.action]),
          [
            [1, 0, "created"],
            [2, 0, "status_changed"],
            [2, 1, "updated"],
          ],
        );
        assert.deepEqual(history[0]?.data, { n: 1 });
        assert.equal(history[0]?.actor, "3");
      }));

    it("returns a long history a page at a time, the latest first and each page oldest first, with how many entries there are", () =>
      withStore(async (store) => {
        const entry = (action: string, id = "001") => ({ op: "add_history" as const, record: { kind: "task", id, at: "t", actor: "1", action, data: {} } });
        // Seven entries of one task in four revisions, among those of another task.
        await store.commit("default", { expectedRevision: null, counters: {}, changes: [entry("a"), entry("other", "002")] });
        await store.commit("default", { expectedRevision: 1, counters: {}, changes: [entry("b"), entry("other", "002"), entry("c")] });
        await store.commit("default", { expectedRevision: 2, counters: {}, changes: [entry("d"), entry("e"), entry("f")] });
        await store.commit("default", { expectedRevision: 3, counters: {}, changes: [entry("other", "002"), entry("g")] });
        const page = async (limit: number, before?: { revision: number; seq: number }) => {
          const { records, total } = await store.readHistoryPage("default", "task", "001", { before, limit });
          return { actions: records.map((h) => h.action).join(""), total, first: records[0] && { revision: records[0].revision, seq: records[0].seq } };
        };
        const latest = await page(3);
        assert.deepEqual(latest, { actions: "efg", total: 7, first: { revision: 3, seq: 1 } });
        // The page before starts where the last one began, also in the middle of a revision.
        const middle = await page(3, latest.first);
        assert.deepEqual(middle, { actions: "bcd", total: 7, first: { revision: 2, seq: 0 } });
        assert.deepEqual(await page(3, middle.first), { actions: "a", total: 7, first: { revision: 1, seq: 0 } });
        assert.deepEqual(await page(3, { revision: 1, seq: 0 }), { actions: "", total: 7, first: undefined });
        // A page with room for all of it holds all of it, and one entry is whole: what it says and who wrote it.
        assert.deepEqual(await page(50), { actions: "abcdefg", total: 7, first: { revision: 1, seq: 0 } });
        assert.deepEqual(await page(7), { actions: "abcdefg", total: 7, first: { revision: 1, seq: 0 } });
        const { records } = await store.readHistoryPage("default", "task", "002", { limit: 1 });
        assert.deepEqual(records, [{ kind: "task", id: "002", at: "t", actor: "1", action: "other", data: {}, revision: 4, seq: 0 }]);
        assert.deepEqual(await store.readHistoryPage("default", "task", "003", { limit: 5 }), { records: [], total: 0 });
      }));

    it("returns and counts only what follows the last entry of an action, when asked: where an item's history begins", () =>
      withStore(async (store) => {
        const entry = (action: string, id = "001") => ({ op: "add_history" as const, record: { kind: "task", id, at: "t", actor: "1", action, data: {} } });
        // An earlier item of the same kind and ID left three entries; the one that is there now has six, in the
        // middle of a revision and after it.
        await store.commit("default", { expectedRevision: null, counters: {}, changes: [entry("created"), entry("a"), entry("created", "002")] });
        await store.commit("default", { expectedRevision: 1, counters: {}, changes: [entry("b"), entry("created"), entry("c")] });
        await store.commit("default", { expectedRevision: 2, counters: {}, changes: [entry("d"), entry("x", "002"), entry("e")] });
        await store.commit("default", { expectedRevision: 3, counters: {}, changes: [entry("f"), entry("g")] });
        const page = async (limit: number, before?: { revision: number; seq: number }, sinceLast: string | null = "created") => {
          const { records, total } = await store.readHistoryPage("default", "task", "001", { before, limit, ...(sinceLast === null ? {} : { sinceLast }) });
          return { actions: records.map((h) => (h.action === "created" ? "+" : h.action)).join(""), total, first: records[0] && { revision: records[0].revision, seq: records[0].seq } };
        };
        // Whether the beginning is among the latest entries or far before them, nothing from before it is returned or counted.
        assert.deepEqual(await page(50), { actions: "+cdefg", total: 6, first: { revision: 2, seq: 1 } });
        assert.deepEqual(await page(6), { actions: "+cdefg", total: 6, first: { revision: 2, seq: 1 } });
        assert.deepEqual(await page(7), { actions: "+cdefg", total: 6, first: { revision: 2, seq: 1 } });
        const latest = await page(2);
        assert.deepEqual(latest, { actions: "fg", total: 6, first: { revision: 4, seq: 0 } });
        const middle = await page(2, latest.first);
        assert.deepEqual(middle, { actions: "de", total: 6, first: { revision: 3, seq: 0 } });
        // The page before ends at the beginning, although the store holds more before it.
        assert.deepEqual(await page(2, middle.first), { actions: "+c", total: 6, first: { revision: 2, seq: 1 } });
        assert.deepEqual(await page(5, middle.first), { actions: "+c", total: 6, first: { revision: 2, seq: 1 } });
        assert.deepEqual(await page(2, { revision: 2, seq: 1 }), { actions: "", total: 6, first: undefined });
        // A place before the beginning, which no page ever gave out, leads to nothing of what was there before.
        assert.deepEqual(await page(5, { revision: 2, seq: 0 }), { actions: "", total: 6, first: undefined });
        assert.deepEqual(await page(5, { revision: 1, seq: 1 }), { actions: "", total: 6, first: undefined });
        // Not asked to begin anywhere, or asked for an action there is none of, the store returns and counts everything.
        assert.deepEqual(await page(50, undefined, null), { actions: "+ab+cdefg", total: 9, first: { revision: 1, seq: 0 } });
        assert.deepEqual(await page(2, { revision: 2, seq: 1 }, null), { actions: "ab", total: 9, first: { revision: 1, seq: 1 } });
        assert.deepEqual(await page(3, undefined, "never"), { actions: "efg", total: 9, first: { revision: 3, seq: 2 } });
        assert.deepEqual(await page(50, undefined, "never"), { actions: "+ab+cdefg", total: 9, first: { revision: 1, seq: 0 } });
        // The other item's beginning is its own.
        assert.deepEqual(await store.readHistoryPage("default", "task", "002", { limit: 1, sinceLast: "created" }).then((found) => [found.records.map((h) => h.action), found.total]), [["x"], 2]);
      }));

    it("deletes an object together with its history, and leaves the history of others", () =>
      withStore(async (store) => {
        const entry = (id: string, action: string) => ({ op: "add_history" as const, record: { kind: "task", id, at: "t", actor: "1", action, data: {} } });
        await store.commit("default", { expectedRevision: null, counters: {}, changes: [task("001"), task("002"), entry("001", "created"), entry("002", "created")] });
        // What is written about the object in the step that deletes it, before it is deleted, goes with the rest.
        await store.commit("default", { expectedRevision: 1, counters: {}, changes: [entry("001", "updated"), { op: "delete_object", kind: "task", id: "001" }] });
        assert.deepEqual(await store.readHistory("default", "task", "001"), []);
        assert.deepEqual(await store.readHistoryPage("default", "task", "001", { limit: 5, sinceLast: "created" }), { records: [], total: 0 }, "a page of it is empty, and nothing is counted");
        assert.deepEqual((await store.readHistory("default", "task", "002")).map((h) => h.action), ["created"]);
        assert.equal((await store.readHistoryPage("default", "task", "002", { limit: 5 })).total, 1);
        // An object that later gets the same kind and ID starts with a history of its own.
        await store.commit("default", { expectedRevision: 2, counters: {}, changes: [task("001"), entry("001", "created")] });
        assert.deepEqual((await store.readHistory("default", "task", "001")).map((h) => [h.revision, h.action]), [[3, "created"]]);
        const again = await store.readHistoryPage("default", "task", "001", { limit: 5, sinceLast: "created" });
        assert.deepEqual([again.records.map((h) => [h.revision, h.action]), again.total], [[[3, "created"]], 1]);
      }));

    it("applies a failed commit not at all", () =>
      withStore(async (store) => {
        await store.commit("default", { expectedRevision: null, counters: { task: 1 }, changes: [task("001")] });
        const tooMany = Array.from({ length: MAX_RECORDS_PER_COMMIT }, (_, i) => task(String(i + 100)));
        await assert.rejects(store.commit("default", { expectedRevision: 1, counters: { task: 200 }, changes: tooMany }), CommitTooLargeError);
        const snapshot = await store.load("default");
        assert.deepEqual(snapshot?.head, { format: FORMAT_VERSION, revision: 1, counters: { task: 1 } });
        assert.equal(snapshot?.objects.length, 1);
      }));

    it("accepts a commit of exactly the maximum size", () =>
      withStore(async (store) => {
        const changes = Array.from({ length: MAX_RECORDS_PER_COMMIT - 1 }, (_, i) => task(String(i + 100)));
        await store.commit("default", { expectedRevision: null, counters: {}, changes });
        assert.equal((await store.load("default"))?.objects.length, MAX_RECORDS_PER_COMMIT - 1);
      }));

    it("keeps tenants apart", () =>
      withStore(async (store) => {
        await store.commit("one", { expectedRevision: null, counters: { task: 1 }, changes: [task("001")] });
        await store.commit("two", { expectedRevision: null, counters: { task: 5 }, changes: [task("005")] });
        assert.deepEqual((await store.load("one"))?.objects.map((o) => o.id), ["001"]);
        assert.deepEqual((await store.load("two"))?.head.counters, { task: 5 });
        assert.equal(await store.readText("two", "task", "001"), null);
      }));

    it("refuses tenant names that could escape the store", () =>
      withStore(async (store) => {
        await assert.rejects(store.commit("../evil", { expectedRevision: null, counters: {}, changes: [] }));
        await assert.rejects(store.load("UPPER"));
      }));

    it("preserves values exactly, including unicode and nested data", () =>
      withStore(async (store) => {
        const data = { title: "Città — 東京 \u{1F600}", nested: { list: [1, "two", null, true], n: -0.5 } };
        await store.commit("default", {
          expectedRevision: null,
          counters: {},
          changes: [{ op: "put_object", record: { kind: "task", id: "001", version: 1, data }, text: "riga 1\nriga 2 ’quoted’" }],
        });
        assert.deepEqual((await store.load("default"))?.objects[0]?.data, data);
        assert.equal(await store.readText("default", "task", "001"), "riga 1\nriga 2 ’quoted’");
      }));

    it("still has confirmed writes after the store is closed and opened again", async () => {
      const f = factory();
      if (!f.reopen) return;
      const store = await f.create();
      await store.commit("default", { expectedRevision: null, counters: { task: 1 }, changes: [task("001")] });
      await store.close();
      const again = await f.reopen();
      try {
        assert.equal(await again.readRevision("default"), 1);
        assert.equal((await again.load("default"))?.head.revision, 1);
        assert.equal(await again.readText("default", "task", "001"), "Description of 001");
      } finally {
        await again.close();
        await f.cleanup?.();
      }
    });
  });
}
