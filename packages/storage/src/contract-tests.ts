import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CommitTooLargeError,
  FORMAT_VERSION,
  MAX_RECORDS_PER_COMMIT,
  RevisionConflictError,
  type Change,
  type JsonObject,
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
        assert.deepEqual(await store.readTimeline("default", "task", "001", { limit: 10 }), { records: [], total: 0 });
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

    it("reads the tenant's history as one newest-first, cursor-paged feed", () =>
      withStore(async (store) => {
        const project: Change = { op: "put_object", record: { kind: "project", id: "ABC", version: 1, data: { title: "Alpha" } } };
        const contained = (id: string): Change => ({
          op: "put_link",
          record: { fromKind: "project", fromId: "ABC", type: "contains", toKind: "task", toId: id, data: { at: "2026-01-01T00:00:00.000Z", by: "1" } },
        });
        const change = (kind: string, id: string, action: string, at: string): Change => ({
          op: "add_history",
          record: { kind, id, action, at, actor: "1", data: {} },
        });
        await store.commit("default", {
          expectedRevision: null,
          counters: {},
          changes: [
            project,
            task("ABC-001"),
            task("ABC-002"),
            task("OUT-001"),
            task("ABC-003"),
            contained("ABC-001"),
            contained("ABC-002"),
            { op: "put_link", record: { fromKind: "task", fromId: "ABC-001", type: "contains", toKind: "task", toId: "ABC-003", data: { at: "2026-01-01T00:00:04.000Z", by: "1" } } },
            change("project", "ABC", "created", "2026-01-01T00:00:00.000Z"),
            change("task", "ABC-001", "created", "2026-01-01T00:00:01.000Z"),
            change("task", "ABC-002", "created", "2026-01-01T00:00:02.000Z"),
            change("task", "OUT-001", "created", "2026-01-01T00:00:03.000Z"),
            change("task", "ABC-003", "created", "2026-01-01T00:00:04.000Z"),
          ],
        });
        await store.commit("default", {
          expectedRevision: 1,
          counters: {},
          changes: [
            change("task", "ABC-001", "status_changed", "2026-01-02T00:00:00.000Z"),
            change("task", "ABC-002", "updated", "2026-01-02T00:00:01.000Z"),
            change("task", "OUT-001", "updated", "2026-01-02T00:00:02.000Z"),
          ],
        });
        await store.commit("default", {
          expectedRevision: 2,
          counters: {},
          changes: [change("task", "ABC-001", "updated", "2026-01-03T00:00:00.000Z")],
        });

        const read = (store as any).readHistoryFeedPage as (tenant: string, page: { before?: { revision: number; seq: number }; project?: string; text?: string; kind?: string; actor?: string; action?: string; from?: string; to?: string; limit: number }) => Promise<{ records: Array<{ kind: string; id: string; action: string; revision: number; seq: number }>; hasMore: boolean }>;
        const latest = await read.call(store, "default", { limit: 2 });
        assert.deepEqual(latest.records.map(({ kind, id, action, revision, seq }) => [kind, id, action, revision, seq]), [
          ["task", "ABC-001", "updated", 3, 0],
          ["task", "OUT-001", "updated", 2, 2],
        ]);
        assert.equal(latest.hasMore, true);

        const earlier = await read.call(store, "default", { before: { revision: 2, seq: 2 }, limit: 2 });
        assert.deepEqual(earlier.records.map(({ id, action, revision, seq }) => [id, action, revision, seq]), [
          ["ABC-002", "updated", 2, 1],
          ["ABC-001", "status_changed", 2, 0],
        ]);
        assert.equal(earlier.hasMore, true);

        const scoped = await read.call(store, "default", {
          project: "ABC",
          kind: "task",
          actor: "1",
          action: "status_changed",
          from: "2026-01-02T00:00:00.000Z",
          to: "2026-01-02T00:00:00.000Z",
          limit: 10,
        });
        assert.deepEqual(scoped.records.map(({ kind, id, action }) => [kind, id, action]), [["task", "ABC-001", "status_changed"]]);
        assert.equal(scoped.hasMore, false);

        const projectFeed = await read.call(store, "default", { project: "ABC", limit: 10 });
        assert.deepEqual(projectFeed.records.map(({ kind, id, action }) => [kind, id, action]), [
          ["task", "ABC-001", "updated"],
          ["task", "ABC-002", "updated"],
          ["task", "ABC-001", "status_changed"],
          ["task", "ABC-003", "created"],
          ["task", "ABC-002", "created"],
          ["task", "ABC-001", "created"],
          ["project", "ABC", "created"],
        ]);
        assert.equal(projectFeed.hasMore, false);
      }));

    it("filters the history feed by item ID or current title, without changing its order", () =>
      withStore(async (store) => {
        const change = (id: string, action: string, at: string): Change => ({
          op: "add_history",
          record: { kind: "task", id, at, actor: "1", action, data: {} },
        });
        await store.commit("default", {
          expectedRevision: null,
          counters: {},
          changes: [
            task("ABC-001", 1, "Unrelated task"),
            task("ABC-002", 1, "Needle work item"),
            task("UNICODE-001", 1, "École work item"),
            { op: "put_object", record: { kind: "project", id: "001", version: 1, data: { title: "Numbered project" } } },
            { op: "put_object", record: { kind: "user", id: "3", version: 1, data: { username: "Alice" } } },
            change("ABC-001", "created", "2026-01-01T00:00:00.000Z"),
            change("ABC-002", "created", "2026-01-01T00:00:01.000Z"),
            { op: "add_history", record: { kind: "task", id: "UNICODE-001", at: "2026-01-01T00:00:02.000Z", actor: "1", action: "created", data: {} } },
            { op: "add_history", record: { kind: "project", id: "001", at: "2026-01-01T00:00:03.000Z", actor: "1", action: "created", data: {} } },
            { op: "add_history", record: { kind: "user", id: "3", at: "2026-01-01T00:00:03.000Z", actor: "1", action: "created", data: {} } },
          ],
        });
        await store.commit("default", {
          expectedRevision: 1,
          counters: {},
          changes: [change("ABC-002", "status_changed", "2026-01-02T00:00:00.000Z")],
        });
        const read = store.readHistoryFeedPage.bind(store) as unknown as (
          tenant: string,
          page: { text?: string; limit: number },
        ) => Promise<{ records: Array<{ kind: string; id: string; action: string; revision: number; seq: number }>; hasMore: boolean }>;

        const byId = await read("default", { text: "bc-002", limit: 10 });
        assert.deepEqual(byId.records.map(({ id, action }) => [id, action]), [
          ["ABC-002", "status_changed"],
          ["ABC-002", "created"],
        ]);
        const byTitle = await read("default", { text: "NEEDLE WORK", limit: 10 });
        assert.deepEqual(byTitle.records.map(({ id }) => id), ["ABC-002", "ABC-002"]);
        const byPublicUserId = await read("default", { text: "USER-003", limit: 10 });
        assert.deepEqual(byPublicUserId.records.map(({ kind, id }) => [kind, id]), [["user", "3"]]);
        const byPublicProjectId = await read("default", { text: "project:001", limit: 10 });
        assert.deepEqual(byPublicProjectId.records.map(({ kind, id }) => [kind, id]), [["project", "001"]]);
        const byUnicodeTitle = await read("default", { text: "éCOLE", limit: 10 });
        assert.deepEqual(byUnicodeTitle.records.map(({ id }) => id), ["UNICODE-001"]);
      }));

    it("filters status changes by their source and destination statuses", () =>
      withStore(async (store) => {
        const statusChange = (kind: string, id: string, from: string, to: string, at: string): Change => ({
          op: "add_history",
          record: { kind, id, at, actor: "1", action: "status_changed", data: { from, to } },
        });
        await store.commit("default", {
          expectedRevision: null,
          counters: {},
          changes: [
            task("ABC-001", 1, "Transition work"),
            { op: "put_object", record: { kind: "project", id: "P", version: 1, data: { title: "Project transition" } } },
            { op: "add_history", record: { kind: "task", id: "ABC-001", at: "2026-01-01T00:00:00.000Z", actor: "1", action: "created", data: { status: "open" } } },
            { op: "add_history", record: { kind: "project", id: "P", at: "2026-01-01T00:00:00.000Z", actor: "1", action: "created", data: { status: "open" } } },
            statusChange("task", "ABC-001", "open", "in_progress", "2026-01-01T00:00:01.000Z"),
            statusChange("task", "ABC-001", "in_progress", "in_review", "2026-01-01T00:00:02.000Z"),
            statusChange("task", "ABC-001", "in_review", "done", "2026-01-01T00:00:03.000Z"),
            statusChange("project", "P", "open", "ready", "2026-01-01T00:00:04.000Z"),
          ],
        });
        const read = store.readHistoryFeedPage.bind(store) as unknown as (
          tenant: string,
          page: { statusFrom?: string; statusTo?: string; limit: number },
        ) => Promise<{ records: Array<{ kind: string; id: string; data: { from?: string; to?: string } }>; hasMore: boolean }>;

        const toReview = await read("default", { statusTo: "in_review", limit: 10 });
        assert.deepEqual(toReview.records.map(({ kind, id, data }) => [kind, id, data.from, data.to]), [["task", "ABC-001", "in_progress", "in_review"]]);
        const fromReview = await read("default", { statusFrom: "in_review", limit: 10 });
        assert.deepEqual(fromReview.records.map(({ id, data }) => [id, data.from, data.to]), [["ABC-001", "in_review", "done"]]);
        const both = await read("default", { statusFrom: "open", statusTo: "in_review", limit: 10 });
        assert.deepEqual(both.records, []);
        const projectStatus = await read("default", { statusTo: "ready", limit: 10 });
        assert.deepEqual(projectStatus.records.map(({ kind, id, data }) => [kind, id, data.from, data.to]), [["project", "P", "open", "ready"]]);
      }));

    it("scopes the history feed to a group's descendants and intersects the selected project", () =>
      withStore(async (store) => {
        const change = (id: string, at: string): Change => ({
          op: "add_history",
          record: { kind: "task", id, at, actor: "1", action: "created", data: {} },
        });
        const contains = (from: string, to: string): Change => ({
          op: "put_link",
          record: { fromKind: "task", fromId: from, type: "contains", toKind: "task", toId: to, data: {} },
        });
        await store.commit("default", {
          expectedRevision: null,
          counters: {},
          changes: [
            { op: "put_object", record: { kind: "project", id: "ABC", version: 1, data: { title: "Project" } } },
            task("ABC-001", 1, "Outer group"),
            task("ABC-002", 1, "Inner group"),
            task("ABC-003", 1, "Nested task"),
            task("ABC-004", 1, "Other task"),
            task("OUT-001", 1, "Outside task"),
            { op: "put_link", record: { fromKind: "project", fromId: "ABC", type: "contains", toKind: "task", toId: "ABC-001", data: {} } },
            { op: "put_link", record: { fromKind: "project", fromId: "ABC", type: "contains", toKind: "task", toId: "ABC-004", data: {} } },
            contains("ABC-001", "ABC-002"),
            contains("ABC-002", "ABC-003"),
            change("ABC-001", "2026-01-01T00:00:00.000Z"),
            change("ABC-002", "2026-01-01T00:00:01.000Z"),
            change("ABC-003", "2026-01-01T00:00:02.000Z"),
            change("ABC-004", "2026-01-01T00:00:03.000Z"),
            change("OUT-001", "2026-01-01T00:00:04.000Z"),
          ],
        });
        const read = store.readHistoryFeedPage.bind(store) as unknown as (
          tenant: string,
          page: { project?: string; parent?: string; limit: number },
        ) => Promise<{ records: Array<{ id: string }>; hasMore: boolean }>;

        const scoped = await read("default", { project: "ABC", parent: "ABC-001", limit: 10 });
        assert.deepEqual(scoped.records.map(({ id }) => id), ["ABC-003", "ABC-002"]);
        assert.equal(scoped.hasMore, false);
      }));

    it("pairs reopened completion events with their effective timeline timestamps", () =>
      withStore(async (store) => {
        const event = (action: string, data: JsonObject, at: string): Change => ({
          op: "add_history",
          record: { kind: "task", id: "ABC-001", at, actor: "1", action, data },
        });
        const status = (value: string, at: string): Change => ({
          op: "add_timeline",
          record: { kind: "task", id: "ABC-001", data: { status: value, at, by: "1" } },
        });
        await store.commit("default", {
          expectedRevision: null,
          counters: {},
          changes: [task("ABC-001"), event("created", { status: "open" }, "2026-01-01T00:00:00.000Z"), status("open", "2026-01-01T00:00:00.000Z")],
        });
        await store.commit("default", {
          expectedRevision: 1,
          counters: {},
          changes: [event("status_changed", { from: "open", to: "done" }, "2026-01-02T00:00:00.000Z"), status("done", "2026-01-02T00:00:00.000Z")],
        });
        await store.commit("default", {
          expectedRevision: 2,
          counters: {},
          changes: [{ op: "patch_timeline", kind: "task", id: "ABC-001", from: 1, to: 1, data: { at: "2025-04-15T16:30:00.000Z" } }],
        });
        await store.commit("default", {
          expectedRevision: 3,
          counters: {},
          changes: [event("status_changed", { from: "done", to: "open" }, "2026-01-04T00:00:00.000Z"), status("open", "2026-01-04T00:00:00.000Z")],
        });
        await store.commit("default", {
          expectedRevision: 4,
          counters: {},
          changes: [event("status_changed", { from: "open", to: "done" }, "2026-01-05T00:00:00.000Z"), status("done", "2026-01-05T00:00:00.000Z")],
        });

        const page = await store.readHistoryFeedPage("default", { kind: "task", action: "status_changed", limit: 10 });
        assert.deepEqual(page.records.filter((record) => record.data.to === "done").map((record) => record.completion_at), [
          "2026-01-05T00:00:00.000Z",
          "2025-04-15T16:30:00.000Z",
        ]);
      }));

    it("starts each feed entry at the item's latest creation", () =>
      withStore(async (store) => {
        const event = (action: string, at: string): Change => ({
          op: "add_history",
          record: { kind: "task", id: "REUSED-001", action, at, actor: "1", data: {} },
        });
        await store.commit("default", { expectedRevision: null, counters: {}, changes: [event("created", "2026-01-01T00:00:00.000Z"), event("status_changed", "2026-01-01T00:00:01.000Z")] });
        await store.commit("default", { expectedRevision: 1, counters: {}, changes: [event("created", "2026-01-02T00:00:00.000Z"), event("updated", "2026-01-02T00:00:01.000Z")] });
        const read = (store as any).readHistoryFeedPage as (tenant: string, page: { kind: string; limit: number }) => Promise<{ records: Array<{ action: string; at: string }>; hasMore: boolean }>;
        const page = await read.call(store, "default", { kind: "task", limit: 10 });
        assert.deepEqual(page.records.map(({ action, at }) => [action, at]), [
          ["updated", "2026-01-02T00:00:01.000Z"],
          ["created", "2026-01-02T00:00:00.000Z"],
        ]);
        assert.equal(page.hasMore, false);
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

    it("keeps an item's timeline beside it and out of the snapshot, each entry added at the place after the last", () =>
      withStore(async (store) => {
        const entry = (status: string, id = "001") => ({ op: "add_timeline" as const, record: { kind: "task", id, data: { status, at: "t", by: "1" } } });
        assert.deepEqual(await store.readTimeline("default", "task", "001"), { records: [], total: 0 });
        await store.commit("default", { expectedRevision: null, counters: {}, changes: [task("001"), entry("open"), task("002"), entry("draft", "002")] });
        // Two in one step take two places, in the order they were given, among those of another item.
        await store.commit("default", { expectedRevision: 1, counters: {}, changes: [entry("in_progress"), entry("open", "002"), entry("done")] });
        assert.deepEqual(await store.readTimeline("default", "task", "001"), {
          records: [
            { kind: "task", id: "001", place: 0, data: { status: "open", at: "t", by: "1" } },
            { kind: "task", id: "001", place: 1, data: { status: "in_progress", at: "t", by: "1" } },
            { kind: "task", id: "001", place: 2, data: { status: "done", at: "t", by: "1" } },
          ],
          total: 3,
        });
        assert.deepEqual((await store.readTimeline("default", "task", "002")).records.map((r) => [r.place, r.data.status]), [[0, "draft"], [1, "open"]]);
        // The same ID under another kind is another item.
        assert.deepEqual(await store.readTimeline("default", "project", "001"), { records: [], total: 0 });
        const snapshot = await store.load("default");
        assert.deepEqual(snapshot?.objects.map((o) => o.data), [{ title: "A task" }, { title: "A task" }], "the records are what was put, and no more");
        assert.equal(JSON.stringify(snapshot).includes("in_progress"), false);
      }));

    it("returns a long timeline a page at a time, the latest first and each page oldest first, with how many entries there are", () =>
      withStore(async (store) => {
        const entry = (n: number, id = "001") => ({ op: "add_timeline" as const, record: { kind: "task", id, data: { n } } });
        await store.commit("default", { expectedRevision: null, counters: {}, changes: [0, 1, 2, 3, 4, 5, 6].flatMap((n) => [entry(n), entry(100 + n, "002")]) });
        const page = async (request?: { before?: number; limit?: number }) => {
          const { records, total } = await store.readTimeline("default", "task", "001", request);
          // Each entry is at the place it was added at.
          assert.deepEqual(records.map((r) => r.place), records.map((r) => r.data.n));
          return [records.map((r) => r.place).join(""), total];
        };
        assert.deepEqual(await page({ limit: 3 }), ["456", 7]);
        assert.deepEqual(await page({ limit: 3, before: 4 }), ["123", 7]);
        assert.deepEqual(await page({ limit: 3, before: 1 }), ["0", 7]);
        assert.deepEqual(await page({ limit: 3, before: 0 }), ["", 7]);
        // A place beyond the end is the end; a page with room for all of it holds all of it, and so does no limit.
        assert.deepEqual(await page({ limit: 2, before: 1000 }), ["56", 7]);
        assert.deepEqual(await page({ limit: 50 }), ["0123456", 7]);
        assert.deepEqual(await page({ limit: 0 }), ["", 7]);
        assert.deepEqual(await page(), ["0123456", 7]);
        assert.deepEqual(await page({ before: 3 }), ["012", 7]);
      }));

    it("sets fields in timeline stretches conditionally, leaves other fields, and fails when the stretch is missing", () =>
      withStore(async (store) => {
        const entry = (status: string, id = "001") => ({ op: "add_timeline" as const, record: { kind: "task", id, data: { status, at: "then", by: "1" } } });
        await store.commit("default", { expectedRevision: null, counters: {}, changes: [entry("a"), entry("b"), entry("c"), entry("d"), entry("x", "002")] });
        await store.commit("default", { expectedRevision: 1, counters: {}, changes: [{ op: "patch_timeline", kind: "task", id: "001", from: 1, to: 2, data: { at: "earlier", note: { set: true } } }] });
        const read = async (id = "001") => (await store.readTimeline("default", "task", id)).records.map((r) => r.data);
        assert.deepEqual(await read(), [
          { status: "a", at: "then", by: "1" },
          { status: "b", at: "earlier", by: "1", note: { set: true } },
          { status: "c", at: "earlier", by: "1", note: { set: true } },
          { status: "d", at: "then", by: "1" },
        ]);
        assert.deepEqual(await read("002"), [{ status: "x", at: "then", by: "1" }], "the other item's entries are as they were");
        // One entry alone, and a stretch that reaches beyond the end: what is there is set. An entry added in the
        // same step before the change is there for it.
        await store.commit("default", { expectedRevision: 2, counters: {}, changes: [entry("e"), { op: "patch_timeline", kind: "task", id: "001", from: 0, to: 0, data: { at: "first" } }, { op: "patch_timeline", kind: "task", id: "001", from: 4, to: 99, data: { at: "last", note: null } }] });
        assert.deepEqual((await read()).map((data) => data.at), ["first", "earlier", "earlier", "then", "last"]);
        assert.deepEqual((await read())[4], { status: "e", at: "last", by: "1", note: null });
        const times = ["2026-01-03T00:00:00.000Z", "2026-01-01T12:00:00.000Z", "2026-01-03T00:00:00.000Z", "2026-01-01T12:00:00.000Z", "2026-01-04T00:00:00.000Z"];
        await store.commit("default", { expectedRevision: 3, counters: {}, changes: times.map((at, index) => ({ op: "patch_timeline" as const, kind: "task", id: "001", from: index, to: index, data: { at } })) });
        await store.commit("default", { expectedRevision: 4, counters: {}, changes: [{ op: "patch_timeline", kind: "task", id: "001", from: 1, to: 4, when: { at_after: "2026-01-02T00:00:00.000Z" }, data: { at: "2026-01-02T00:00:00.000Z" } }] });
        assert.deepEqual((await read()).map((data) => data.at), [
          "2026-01-03T00:00:00.000Z",
          "2026-01-01T12:00:00.000Z",
          "2026-01-02T00:00:00.000Z",
          "2026-01-01T12:00:00.000Z",
          "2026-01-02T00:00:00.000Z",
        ]);
        await store.commit("default", { expectedRevision: 5, counters: {}, changes: [{ op: "patch_timeline", kind: "task", id: "001", from: 1, to: 4, when: { at_after: "2026-01-03T00:00:00.000Z" }, data: { at: "no match" } }] });
        assert.deepEqual((await read()).map((data) => data.at), [
          "2026-01-03T00:00:00.000Z",
          "2026-01-01T12:00:00.000Z",
          "2026-01-02T00:00:00.000Z",
          "2026-01-01T12:00:00.000Z",
          "2026-01-02T00:00:00.000Z",
        ], "a conditional patch with no matches is a no-op");
        // A stretch with no entry in it changes nothing, and neither does anything else of that commit.
        const nothingThere = { op: "patch_timeline" as const, kind: "task", id: "001", from: 6, to: 9, data: { at: "never" } };
        await assert.rejects(store.commit("default", { expectedRevision: 6, counters: { task: 9 }, changes: [entry("f"), nothingThere] }), /has no entry from place 6 to 9/);
        await assert.rejects(store.commit("default", { expectedRevision: 6, counters: {}, changes: [{ ...nothingThere, id: "003", from: 0, to: 0 }] }), /has no entry/);
        assert.deepEqual([(await store.load("default"))?.head.revision, (await read()).length], [6, 5]);
      }));

    it("deletes an object together with its timeline, and leaves the timelines of others", () =>
      withStore(async (store) => {
        const entry = (id: string, status: string) => ({ op: "add_timeline" as const, record: { kind: "task", id, data: { status } } });
        await store.commit("default", { expectedRevision: null, counters: {}, changes: [task("001"), task("002"), entry("001", "open"), entry("002", "open"), entry("001", "done")] });
        // What is added to the timeline in the step that deletes the object, before it is deleted, goes with the rest.
        await store.commit("default", { expectedRevision: 1, counters: {}, changes: [entry("001", "open"), { op: "delete_object", kind: "task", id: "001" }] });
        assert.deepEqual(await store.readTimeline("default", "task", "001"), { records: [], total: 0 });
        assert.deepEqual((await store.readTimeline("default", "task", "002")).records.map((r) => r.data.status), ["open"]);
        // An object that later gets the same kind and ID starts a timeline of its own, at the first place.
        await store.commit("default", { expectedRevision: 2, counters: {}, changes: [task("001"), entry("001", "draft")] });
        assert.deepEqual(await store.readTimeline("default", "task", "001"), { records: [{ kind: "task", id: "001", place: 0, data: { status: "draft" } }], total: 1 });
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
      await store.commit("default", { expectedRevision: null, counters: { task: 1 }, changes: [task("001"), { op: "add_timeline", record: { kind: "task", id: "001", data: { status: "open" } } }] });
      await store.close();
      const again = await f.reopen();
      try {
        assert.equal(await again.readRevision("default"), 1);
        assert.equal((await again.load("default"))?.head.revision, 1);
        assert.equal(await again.readText("default", "task", "001"), "Description of 001");
        assert.deepEqual((await again.readTimeline("default", "task", "001")).records.map((r) => [r.place, r.data]), [[0, { status: "open" }]]);
      } finally {
        await again.close();
        await f.cleanup?.();
      }
    });
  });
}
