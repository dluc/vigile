import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { runStorageContractTests } from "@vigile/storage/contract-tests";
import { SqliteStorage, flushFolder, needSqlite } from "./index.js";

it("says so when a folder cannot be flushed although the system offers it, and says nothing where it does not", () => {
  const directory = mkdtempSync(join(tmpdir(), "vigile-flush-"));
  const failing = (code: string) => () => {
    throw Object.assign(new Error(`${code}: could not`), { code });
  };
  try {
    assert.doesNotThrow(() => flushFolder(directory), "a folder that can be flushed is");
    // A flush that fails for a reason of its own: what was written may not last, and that is not passed off as done.
    for (const code of ["EIO", "ENOSPC", "EACCES"]) {
      assert.throws(() => flushFolder(directory, failing(code)), new RegExp(`is in place, but the system could not confirm that it will survive a power cut: ${code}`), code);
    }
    // A system that has no way to flush a folder at all: nothing more can be done there.
    for (const code of ["EINVAL", "ENOTSUP", "EISDIR", "EPERM"]) assert.doesNotThrow(() => flushFolder(directory, failing(code)), code);
    assert.throws(() => flushFolder(join(directory, "not-there")), /could not confirm/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("names the data file that cannot be opened, also when it is no file at all", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vigile-noopen-"));
  try {
    // Something else stands under the tenant's name: a folder.
    mkdirSync(join(directory, "default.sqlite"));
    const storage = new SqliteStorage({ directory });
    await assert.rejects(storage.load("default"), (error: Error) => error.message.includes(join(directory, "default.sqlite")) && /cannot be written \(unable to open database file\)/.test(error.message));
    await storage.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("says which Node.js it needs when the one it runs on has no SQLite built in", () => {
  assert.throws(() => needSqlite(() => undefined), /Vigile needs Node\.js 22\.13 or later.*This is Node\.js \d+\./);
  assert.ok(needSqlite().DatabaseSync);
});

runStorageContractTests("sqlite", () => {
  const directory = mkdtempSync(join(tmpdir(), "vigile-sqlite-"));
  return {
    create: async () => new SqliteStorage({ directory }),
    reopen: async () => new SqliteStorage({ directory }),
    cleanup: async () => rmSync(directory, { recursive: true, force: true }),
  };
});

it("sqlite: keeps one file per tenant, checks integrity and writes a backup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vigile-sqlite-"));
  const store = new SqliteStorage({ directory });
  try {
    await store.commit("default", {
      expectedRevision: null,
      counters: { task: 1 },
      changes: [{ op: "put_object", record: { kind: "task", id: "001", version: 1, data: {} }, text: "text" }],
    });
    assert.deepEqual(store.listTenants(), ["default"]);
    assert.equal(existsSync(join(directory, "default.sqlite")), true);
    assert.deepEqual(store.integrity("default"), { ok: true, messages: ["ok"] });

    const copy = join(directory, "copy.sqlite");
    store.backup("default", copy);
    assert.equal(existsSync(copy), true);
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
