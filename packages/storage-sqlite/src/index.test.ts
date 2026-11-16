import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runStorageContractTests } from "@vigile/storage/contract-tests";
import { SqliteStorage, backupTenantFile, flushFolder, folderIsHeld, holdFile, holdFolder, holdTenantFiles, needSqlite } from "./index.js";
import { stopProcess } from "./stop-process.js";

it("does not follow a replacement link when SQLite opens a prepared backup destination", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "vigile-backup-destination-"));
  try {
    const source = join(directory, "source.sqlite");
    const database = new DatabaseSync(source);
    database.exec("CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ('tenant data')");
    database.close();
    const working = join(directory, "copy.partial");
    writeFileSync(working, "", { mode: 0o600 });
    const prepared = lstatSync(working);
    const target = join(directory, "someone-elses-file");
    writeFileSync(target, "untouched");
    rmSync(working);
    symlinkSync(target, working);

    assert.throws(() => backupTenantFile(source, working, { device: prepared.dev, inode: prepared.ino }));
    assert.equal(readFileSync(target, "utf8"), "untouched");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("stops the lock owner if its holder dies unexpectedly", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vigile-lost-holder-"));
  const ready = join(directory, "ready");
  const module = new URL("./index.js", import.meta.url).href;
  const parent = spawn(
    process.execPath,
    ["--no-warnings", "--input-type=module", "--eval", `import { writeFileSync } from 'node:fs'; import { holdFile } from ${JSON.stringify(module)}; const release = holdFile(process.argv[1]); writeFileSync(process.argv[2], String(release.holderPid)); for (;;) {}`, join(directory, "lock"), ready],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  parent.stderr!.setEncoding("utf8").on("data", (text) => (stderr += text));
  try {
    const until = Date.now() + 5_000;
    while (!existsSync(ready) && parent.exitCode === null && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    const holderPid = existsSync(ready) ? Number(readFileSync(ready, "utf8")) : 0;
    assert.ok(Number.isInteger(holderPid) && holderPid > 0, `holder pid was not published: ${stderr}`);
    const ended = once(parent, "exit");
    stopProcess(holderPid);
    const [code, signal] = await Promise.race([ended, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the watchdog did not stop the busy lock owner")), 10_000))]);
    assert.ok(code === 1 || signal === "SIGKILL", `code ${code}, signal ${signal}: ${stderr}`);
  } finally {
    if (parent.exitCode === null) parent.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps an async worker's lock while its live owner is synchronously busy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vigile-lost-worker-"));
  const ready = join(directory, "ready");
  const lock = join(directory, "lock");
  const module = new URL("./index.js", import.meta.url).href;
  const workerCode = `const { parentPort } = require('node:worker_threads'); parentPort.once('message', async (message) => { if (message !== 'start') return; const { holdFile } = await import(${JSON.stringify(module)}); const release = holdFile(${JSON.stringify(lock)}, true); parentPort.postMessage({ held: Boolean(release) }); setTimeout(() => process.exit(0), 100); });`;
  const script = `import { writeFileSync } from 'node:fs'; import { Worker } from 'node:worker_threads'; import { holdFileAsync } from ${JSON.stringify(module)}; const worker = new Worker(${JSON.stringify(workerCode)}, { eval: true, execArgv: [] }); const release = await holdFileAsync(process.argv[1], Date.now() + 5000, () => worker); if (!release) process.exit(2); writeFileSync(process.argv[2], ''); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);`;
  const owner = spawn(process.execPath, ["--no-warnings", "--input-type=module", "--eval", script, lock, ready], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  owner.stderr!.setEncoding("utf8").on("data", (text) => (stderr += text));
  try {
    const until = Date.now() + 5_000;
    while (!existsSync(ready) && owner.exitCode === null && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(ready), true, `the async lock was not acquired: ${stderr}`);
    // The worker exits after 100 ms while its owner's main thread cannot process the exit event for 1.5 s.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const escaped = holdFile(lock);
    escaped?.();
    assert.equal(escaped, null, "the holder keeps the OS lock until the synchronously busy owner stops");
    const [code, signal] = await Promise.race([once(owner, "exit"), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the owner did not fail closed after its worker exited")), 5_000))]);
    assert.deepEqual([code, signal], [1, null], stderr);
    let release: (() => void) | null = null;
    const freeBy = Date.now() + 5_000;
    while (!release && Date.now() < freeBy) {
      release = holdFile(lock);
      if (!release) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(release, "the holder releases after the owner has stopped");
    release();
  } finally {
    if (owner.exitCode === null) owner.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

it("stops a stalled holder after its owner is gone, so the lock can be taken again", { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "vigile-stalled-holder-"));
  const ready = join(directory, "ready");
  const lock = join(directory, "lock");
  const module = new URL("./index.js", import.meta.url).href;
  const owner = spawn(
    process.execPath,
    ["--no-warnings", "--input-type=module", "--eval", `import { writeFileSync } from 'node:fs'; import { holdFile } from ${JSON.stringify(module)}; const release = holdFile(process.argv[1]); writeFileSync(process.argv[2], String(release.holderPid)); for (;;) {}`, lock, ready],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let holderPid = 0;
  try {
    const until = Date.now() + 5_000;
    while (!existsSync(ready) && owner.exitCode === null && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    holderPid = existsSync(ready) ? Number(readFileSync(ready, "utf8")) : 0;
    assert.ok(Number.isInteger(holderPid) && holderPid > 0);
    const ended = once(owner, "exit");
    process.kill(holderPid, "SIGSTOP");
    await Promise.race([ended, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the watchdog did not stop the owner of the stalled holder")), 10_000))]);
    let release: (() => void) | null = null;
    const freeBy = Date.now() + 5_000;
    while (!release && Date.now() < freeBy) {
      release = holdFile(lock);
      if (!release) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(release, "the stalled holder was stopped after its owner, releasing the SQLite lock");
    release();
  } finally {
    if (owner.exitCode === null) owner.kill("SIGKILL");
    if (holderPid > 0) {
      try {
        process.kill(holderPid, "SIGKILL");
      } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps a folder excluded through one holder's death", { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "vigile-dual-holder-"));
  const ready = join(directory, "ready");
  const module = new URL("./index.js", import.meta.url).href;
  const owner = spawn(
    process.execPath,
    ["--no-warnings", "--input-type=module", "--eval", `import { writeFileSync } from 'node:fs'; import { holdFolder } from ${JSON.stringify(module)}; const release = holdFolder(process.argv[1]); writeFileSync(process.argv[2], JSON.stringify(release.holderPids)); for (;;) {}`, directory, ready],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let surviving = 0;
  let freed: (() => void) | null = null;
  try {
    const until = Date.now() + 5_000;
    while (!existsSync(ready) && owner.exitCode === null && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    const holders = existsSync(ready) ? JSON.parse(readFileSync(ready, "utf8")) as number[] : [];
    assert.equal(holders.length, 2);
    const [current, legacy] = holders;
    assert.ok(current! > 0 && legacy! > 0 && current !== legacy);
    surviving = legacy!;
    // Keep the independent legacy holder from processing owner disconnect, then kill the current holder. Its
    // watchdog may stop the owner, but the surviving process continues to hold the second exclusion lock.
    process.kill(surviving, "SIGSTOP");
    stopProcess(current!);
    const currentFile = join(directory, "vigile.owner");
    const legacyFile = join(directory, "vigile.hold");
    const freeBy = Date.now() + 5_000;
    while (!freed && Date.now() < freeBy) {
      freed = holdFile(currentFile);
      if (!freed) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(freed, "the killed holder's individual lock is free");
    assert.equal(holdFile(legacyFile), null, "the independent surviving holder still excludes another folder owner");
    assert.equal(holdFolder(directory), null, "a current service cannot acquire the folder with only one lock free");
  } finally {
    freed?.();
    if (owner.exitCode === null) owner.kill("SIGKILL");
    if (surviving > 0) {
      try {
        process.kill(surviving, "SIGKILL");
      } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

it("does not keep an otherwise finished lock owner alive", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vigile-unref-holder-"));
  const file = join(directory, "lock");
  const module = new URL("./index.js", import.meta.url).href;
  const owner = spawn(process.execPath, ["--no-warnings", "--input-type=module", "--eval", `import { holdFile } from ${JSON.stringify(module)}; holdFile(process.argv[1]);`, file], { stdio: "ignore" });
  try {
    const [code, signal] = await Promise.race([once(owner, "exit"), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the lock holder kept its finished owner alive")), 5_000))]);
    assert.deepEqual([code, signal], [0, null]);
    let release: (() => void) | null = null;
    const until = Date.now() + 5_000;
    while (!release && Date.now() < until) {
      release = holdFile(file);
      if (!release) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(release, "the holder released the lock when its owner exited");
    release();
  } finally {
    if (owner.exitCode === null) owner.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps a folder held when this process inspects the lock file", () => {
  const directory = mkdtempSync(join(tmpdir(), "vigile-hold-"));
  const release = holdFolder(directory);
  try {
    assert.ok(release);
    const module = new URL("./index.js", import.meta.url).href;
    const probe = (what: string) => {
      assert.equal(folderIsHeld(directory), true, `${what}: diagnostic inspection sees the holder`);
      const current = spawnSync(process.execPath, ["--input-type=module", "--eval", `import { holdFolder } from ${JSON.stringify(module)}; process.exit(holdFolder(process.argv[1]) ? 1 : 0)`, directory]);
      assert.equal(current.status, 0, `${what}: another current process took the folder: ${current.stderr}`);
      for (const file of ["vigile.owner", "vigile.hold"]) {
        const exact = spawnSync(process.execPath, ["--input-type=module", "--eval", `import { holdFile } from ${JSON.stringify(module)}; import { join } from 'node:path'; process.exit(holdFile(join(process.argv[1], process.argv[2])) ? 1 : 0)`, directory, file]);
        assert.equal(exact.status, 0, `${what}: another process took ${file}: ${exact.stderr}`);
      }
    };
    probe("before raw reads");
    readFileSync(join(directory, "vigile.owner"));
    probe("after reading the current lock");
    readFileSync(join(directory, "vigile.hold"));
    probe("after reading both locks");
    readFileSync(join(directory, "vigile.owner"));
    probe("after reading the current lock again");
  } finally {
    release?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

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

it("takes nothing but a plain file for a lock: a folder, a link, or a pipe under a lock's name is said to be none, and is not opened", () => {
  const directory = mkdtempSync(join(tmpdir(), "vigile-lock-kind-"));
  const NONE = /is not a lock file of Vigile\. Remove it while no vigile command and no service is running\.$/;
  try {
    const kept = join(directory, "someone's");
    writeFileSync(kept, "as it was");
    const plant: Array<[what: string, make: (file: string) => void]> = [
      ["a folder", (file) => mkdirSync(file)],
      ["a link to a file of someone's", (file) => symlinkSync(kept, file)],
      ["a link to nothing", (file) => symlinkSync(join(directory, "nothing-there"), file)],
    ];
    try {
      if (process.platform === "win32") throw new Error("Windows named pipes do not have POSIX FIFO cleanup semantics");
      execFileSync("mkfifo", [join(directory, "probe")]);
      plant.push(["a pipe", (file) => void execFileSync("mkfifo", [file])], ["a link to a pipe", (file) => symlinkSync(join(directory, "probe"), file)]);
    } catch {
      // A machine that cannot make a pipe with a name has none to find.
    }
    for (const [what, make] of plant) {
      const file = join(directory, `lock for ${what}`);
      make(file);
      assert.throws(() => holdFile(file), NONE, what);
      // The lock on the tenants' files and the lock on a data folder are taken the same way.
      const data = join(directory, `data for ${what}`);
      mkdirSync(data);
      make(join(data, "vigile.files"));
      assert.throws(() => holdTenantFiles(data), NONE, what);
      make(join(data, "vigile.hold"));
      assert.throws(() => holdFolder(data), NONE, what);
      if (what !== "a link to nothing") assert.throws(() => folderIsHeld(data), NONE, what);
    }
    assert.equal(readFileSync(kept, "utf8"), "as it was");
    assert.deepEqual(readdirSync(directory).filter((name) => name === "nothing-there"), [], "nothing was made where a link leads");
    // A plain file, or nothing yet, is a lock.
    const release = holdFile(join(directory, "a lock"));
    assert.notEqual(release, null);
    assert.equal(holdFile(join(directory, "a lock")), null);
    execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync(process.argv[1]);
       try { db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE"); process.exitCode = 1; }
       catch (error) { if (!/database is locked/.test(error.message)) throw error; }
       finally { db.close(); }`,
      join(directory, "a lock"),
    ]);
    release!();
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
