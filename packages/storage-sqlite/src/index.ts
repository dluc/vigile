import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { DatabaseSync as Database } from "node:sqlite";
import {
  FORMAT_VERSION,
  RevisionConflictError,
  assertCommitSize,
  assertTenantName,
  isTenantName,
  type CommitRequest,
  type Head,
  type HistoryPage,
  type HistoryPageRequest,
  type HistoryPlace,
  type HistoryRecord,
  type JsonObject,
  type LinkRecord,
  type ObjectRecord,
  type Snapshot,
  type StorageAdapter,
} from "@vigile/storage";

/** Node 22 still marks its SQLite module experimental and warns on first load; that warning is not actionable for users. */
function loadSqlite(): typeof import("node:sqlite") {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes("SQLite is an experimental feature")) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return process.getBuiltinModule?.("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
}

/** The first Node.js that has SQLite built in without being asked for it. */
export const NODE_NEEDED = "22.13";

/**
 * The SQLite that comes with Node.js, or a plain word about why there is none. Asked for when a store is first
 * opened and not when this file is loaded, so that on a Node.js that is too old the command can still say so,
 * and `--version` and `help` still work.
 */
export function needSqlite(load: () => typeof import("node:sqlite") | undefined = loadSqlite): typeof import("node:sqlite") {
  const found = load();
  if (!found?.DatabaseSync) throw new Error(`Vigile needs Node.js ${NODE_NEEDED} or later, which has SQLite built in. This is Node.js ${process.versions.node}.`);
  return found;
}

let found: typeof import("node:sqlite") | undefined;
/** Opens a database file. */
function openDatabase(file: string, options?: { readOnly?: boolean }): Database {
  const { DatabaseSync } = (found ??= needSqlite());
  return options ? new DatabaseSync(file, options) : new DatabaseSync(file);
}

interface ReadOnlyConnection {
  db: Database;
  close(): void;
}

/** A read-only maintenance connection can proceed when only the optional folder lock is unwritable. */
function folderLockIsReadOnly(error: unknown): boolean {
  const failure = error as NodeJS.ErrnoException & { errcode?: number };
  const sqliteCode = failure.errcode ?? 0;
  return ["EACCES", "EPERM", "EROFS"].includes(failure.code ?? "") || (sqliteCode & 0xff) === 8 || /read.?only|permission denied|unable to open database file/i.test(failure.message ?? "");
}

/**
 * Read-only maintenance resolves symlinks before checking WAL sidecars. For a stopped Vigile data folder, hold
 * the folder for the connection's lifetime before using immutable mode; this excludes a service starting during
 * the read. If a service already holds the folder, use ordinary SQLite read-only WAL handling. A timestamped final
 * backup name is published only after its content is complete, so it is also safe to read immutably.
 */
function openReadOnlyDatabase(file: string): ReadOnlyConnection {
  const resolved = realpathSync(file);
  const directory = dirname(resolved);
  const hasOwner = existsSync(join(directory, OWNER_FILE));
  const hasLegacyHolder = existsSync(join(directory, HOLD_FILE));
  const isDataFolder = hasOwner || hasLegacyHolder;
  // Avoid creating the other generation's lock file as a side effect of reading an old or partial folder. If
  // existing markers are readable but unwritable, preserve ordinary read-only WAL access instead of failing the
  // inspection; immutable mode still requires a successfully acquired lock.
  let releaseFolder: (() => void) | null = null;
  if (hasOwner && hasLegacyHolder) {
    try {
      // Maintenance should not wait behind an active service: one lock attempt is enough to choose between
      // immutable access with exclusion and normal read-only WAL access.
      releaseFolder = tryHoldFolder(directory);
    } catch (error) {
      if (!folderLockIsReadOnly(error)) throw error;
    }
  }
  const sidecars = ["-wal", "-shm", "-journal"].map((suffix) => `${resolved}${suffix}`);
  let before: Map<string, { dev: number; ino: number } | null>;
  try {
    before = new Map(sidecars.map((path) => {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      return [path, stat?.isFile() ? { dev: stat.dev, ino: stat.ino } : null] as const;
    }));
  } catch (error) {
    // The scan precedes opening SQLite, so there is no connection cleanup to release a lock if metadata fails.
    releaseFolder?.();
    throw error;
  }
  const committedBackup = /^[a-z][a-z0-9-]{0,62}-\d{8}-\d{6}-\d{3}(?:-auto)?\.sqlite$/.test(basename(resolved));
  const immutable = !sidecars.some((path) => before.get(path) !== null) && (releaseFolder !== null || (!isDataFolder && committedBackup));
  const created = new Map<string, { dev: number; ino: number }>();
  const recordCreated = () => {
    if (!releaseFolder) return;
    for (const path of sidecars) {
      if (before.get(path) !== null || created.has(path)) continue;
      const current = lstatSync(path, { throwIfNoEntry: false });
      if (current?.isFile()) created.set(path, { dev: current.dev, ino: current.ino });
    }
  };
  const cleanup = () => {
    if (!releaseFolder) return;
    for (const [path, expected] of created) {
      const current = lstatSync(path, { throwIfNoEntry: false });
      if (current?.isFile() && current.dev === expected.dev && current.ino === expected.ino) rmSync(path);
    }
  };
  let db: Database | undefined;
  try {
    if (immutable) {
      const uri = pathToFileURL(resolved);
      uri.searchParams.set("mode", "ro");
      uri.searchParams.set("immutable", "1");
      db = openDatabase(uri.href, { readOnly: true });
    } else db = openDatabase(resolved, { readOnly: true });
    recordCreated();
  } catch (error) {
    try { db?.close(); } finally {
      try { cleanup(); } finally { releaseFolder?.(); }
    }
    throw error;
  }
  const opened = db;
  if (!opened) throw new Error("The read-only database was not opened");
  let closed = false;
  return {
    db: opened,
    close() {
      if (closed) return;
      closed = true;
      try { opened.close(); } finally {
        try { cleanup(); } finally { releaseFolder?.(); }
      }
    },
  };
}
/** SQLite's code for "another connection has the lock". */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS head (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  format INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  counters TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS objects (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  text TEXT,
  PRIMARY KEY (kind, id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS links (
  from_kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  type TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_id TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (from_kind, from_id, type, to_kind, to_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS history (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (kind, id, revision, seq)
) STRICT, WITHOUT ROWID;
`;

export interface SqliteStorageOptions {
  /** The folder that holds one `<tenant>.sqlite` file per tenant. */
  directory: string;
}

export interface IntegrityReport {
  ok: boolean;
  messages: string[];
}

/** One SQLite file per tenant, so a query can never cross tenants. */
export class SqliteStorage implements StorageAdapter {
  private readonly directory: string;
  private readonly open = new Map<string, Database>();
  private closed = false;

  constructor(options: SqliteStorageOptions) {
    this.directory = options.directory;
    mkdirSync(this.directory, { recursive: true });
  }

  tenantFile(tenant: string): string {
    assertTenantName(tenant);
    return join(this.directory, `${tenant}.sqlite`);
  }

  listTenants(): string[] {
    return readdirSync(this.directory)
      .filter((f) => f.endsWith(".sqlite"))
      .map((f) => f.slice(0, -".sqlite".length))
      .filter(isTenantName)
      .sort();
  }

  private db(tenant: string): Database {
    if (this.closed) throw new Error("The store is closed");
    let db = this.open.get(tenant);
    if (!db) {
      const file = this.tenantFile(tenant);
      let opened: Database | undefined;
      try {
        // Opening is in here too: a file that cannot be opened at all, a folder under its name for instance, is
        // named like one that cannot be written.
        opened = openDatabase(file);
        db = opened;
        // WAL with synchronous=FULL: a confirmed write survives a power cut.
        db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
        db.exec(SCHEMA);
        // A file that can be read and not written would let the service start and then fail every change.
        // Better to hear it now, by its name.
        db.exec("BEGIN IMMEDIATE; UPDATE head SET revision = revision WHERE 0; ROLLBACK");
      } catch (error) {
        opened?.close();
        if (/readonly|unable to open/i.test((error as Error).message)) {
          throw new Error(`The data file ${file} cannot be written (${(error as Error).message}). Give this account write access to it and to the files beside it.`, { cause: error });
        }
        throw error;
      }
      this.open.set(tenant, db);
    }
    return db;
  }

  /** Reads never bootstrap a tenant: only a commit may create its file. */
  private existingDb(tenant: string): Database | null {
    if (this.closed) throw new Error("The store is closed");
    const opened = this.open.get(tenant);
    if (opened) return opened;
    return existsSync(this.tenantFile(tenant)) ? this.db(tenant) : null;
  }

  private head(db: Database): Head | null {
    return headIn(db);
  }

  async load(tenant: string): Promise<Snapshot | null> {
    const db = this.existingDb(tenant);
    if (!db) return null;
    db.exec("BEGIN");
    try {
      return snapshotIn(db);
    } finally {
      db.exec("COMMIT");
    }
  }

  async commit(tenant: string, request: CommitRequest): Promise<Head> {
    assertTenantName(tenant);
    assertCommitSize(request);
    const db = this.db(tenant);
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.head(db);
      const actual = current ? current.revision : null;
      if (actual !== request.expectedRevision) throw new RevisionConflictError(tenant, request.expectedRevision, actual);
      const head: Head = {
        format: current?.format ?? FORMAT_VERSION,
        revision: (current?.revision ?? 0) + 1,
        counters: { ...request.counters },
      };
      let seq = 0;
      for (const change of request.changes) {
        switch (change.op) {
          case "put_object": {
            const { kind, id, version, data } = change.record;
            if (change.text === undefined) {
              db.prepare(
                `INSERT INTO objects (kind, id, version, data) VALUES (?, ?, ?, ?)
                 ON CONFLICT (kind, id) DO UPDATE SET version = excluded.version, data = excluded.data`,
              ).run(kind, id, version, JSON.stringify(data));
            } else {
              db.prepare(
                `INSERT INTO objects (kind, id, version, data, text) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (kind, id) DO UPDATE SET version = excluded.version, data = excluded.data, text = excluded.text`,
              ).run(kind, id, version, JSON.stringify(data), change.text);
            }
            break;
          }
          case "delete_object":
            db.prepare("DELETE FROM objects WHERE kind = ? AND id = ?").run(change.kind, change.id);
            db.prepare("DELETE FROM history WHERE kind = ? AND id = ?").run(change.kind, change.id);
            break;
          case "put_link": {
            const r = change.record;
            db.prepare(
              `INSERT INTO links (from_kind, from_id, type, to_kind, to_id, data) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (from_kind, from_id, type, to_kind, to_id) DO UPDATE SET data = excluded.data`,
            ).run(r.fromKind, r.fromId, r.type, r.toKind, r.toId, JSON.stringify(r.data));
            break;
          }
          case "delete_link": {
            const k = change.key;
            db.prepare("DELETE FROM links WHERE from_kind = ? AND from_id = ? AND type = ? AND to_kind = ? AND to_id = ?").run(
              k.fromKind,
              k.fromId,
              k.type,
              k.toKind,
              k.toId,
            );
            break;
          }
          case "add_history": {
            const h = change.record;
            db.prepare("INSERT INTO history (kind, id, revision, seq, at, actor, action, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
              h.kind,
              h.id,
              head.revision,
              seq++,
              h.at,
              h.actor,
              h.action,
              JSON.stringify(h.data),
            );
            break;
          }
        }
      }
      db.prepare(
        `INSERT INTO head (id, format, revision, counters) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET format = excluded.format, revision = excluded.revision, counters = excluded.counters`,
      ).run(head.format, head.revision, JSON.stringify(head.counters));
      db.exec("COMMIT");
      return head;
    } catch (error) {
      // What went wrong is what the caller must hear. When the store has already given the step up by itself,
      // as it does when the disk is full, there is nothing to undo, and saying so must not take its place.
      try {
        db.exec("ROLLBACK");
      } catch {
        // Nothing was open any more.
      }
      throw error;
    }
  }

  async readRevision(tenant: string): Promise<number | null> {
    const db = this.existingDb(tenant);
    if (!db) return null;
    const row = db.prepare("SELECT revision FROM head WHERE id = 1").get() as { revision: number } | undefined;
    return row?.revision ?? null;
  }

  async readText(tenant: string, kind: string, id: string): Promise<string | null> {
    const db = this.existingDb(tenant);
    if (!db) return null;
    const row = db.prepare("SELECT text FROM objects WHERE kind = ? AND id = ?").get(kind, id) as
      | { text: string | null }
      | undefined;
    return row?.text ?? null;
  }

  async readHistory(tenant: string, kind: string, id: string): Promise<HistoryRecord[]> {
    const db = this.existingDb(tenant);
    if (!db) return [];
    const rows = db
      .prepare("SELECT kind, id, revision, seq, at, actor, action, data FROM history WHERE kind = ? AND id = ? ORDER BY revision, seq")
      .all(kind, id) as unknown as Array<Omit<HistoryRecord, "data"> & { data: string }>;
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) as JsonObject }));
  }

  async readHistoryPage(tenant: string, kind: string, id: string, page: HistoryPageRequest): Promise<HistoryPage> {
    const db = this.existingDb(tenant);
    if (!db) return { records: [], total: 0 };
    const { before, sinceLast } = page;
    const columns = "SELECT kind, id, revision, seq, at, actor, action, data FROM history WHERE kind = ? AND id = ?";
    const latest = "ORDER BY revision DESC, seq DESC LIMIT ?";
    let rows = (
      before ? db.prepare(`${columns} AND (revision, seq) < (?, ?) ${latest}`).all(kind, id, before.revision, before.seq, page.limit) : db.prepare(`${columns} ${latest}`).all(kind, id, page.limit)
    ) as unknown as Array<Omit<HistoryRecord, "data"> & { data: string }>;
    // The latest of all that are fewer than were asked for are all that is stored for the item.
    let whole = !before && rows.length < page.limit;
    let begins: HistoryPlace | undefined;
    if (sinceLast !== undefined) {
      // Where the history begins. Among the latest entries of all, the last of that action is the last there
      // is, and what follows it is the whole history. Otherwise it is looked for from the end backwards, which
      // stops at it: what was stored before it is never gone through.
      const among = before ? undefined : rows.find((row) => row.action === sinceLast);
      if (among) whole = true;
      begins =
        among ??
        (whole
          ? undefined
          : (db.prepare("SELECT revision, seq FROM history WHERE kind = ? AND id = ? AND action = ? ORDER BY revision DESC, seq DESC LIMIT 1").get(kind, id, sinceLast) as HistoryPlace | undefined));
      const from = begins;
      if (from) rows = rows.filter((row) => row.revision > from.revision || (row.revision === from.revision && row.seq >= from.seq));
    }
    // Otherwise the entries are counted where they lie, one after the other under the item's kind and ID, from
    // where the history begins, without reading what each one says.
    const counted = (): number => {
      const count = "SELECT COUNT(*) AS entries FROM history WHERE kind = ? AND id = ?";
      const found = begins ? db.prepare(`${count} AND (revision, seq) >= (?, ?)`).get(kind, id, begins.revision, begins.seq) : db.prepare(count).get(kind, id);
      return (found as { entries: number }).entries;
    };
    return { records: rows.reverse().map((r) => ({ ...r, data: JSON.parse(r.data) as JsonObject })), total: whole ? rows.length : counted() };
  }

  /** SQLite's own consistency check of a tenant file. */
  integrity(tenant: string): IntegrityReport {
    const rows = this.db(tenant).prepare("PRAGMA integrity_check").all() as unknown as Array<{ integrity_check: string }>;
    const messages = rows.map((r) => r.integrity_check);
    return { ok: messages.length === 1 && messages[0] === "ok", messages };
  }

  /** Writes a consistent copy of a tenant to `destination` while the store stays in use. */
  backup(tenant: string, destination: string): void {
    this.db(tenant).prepare("VACUUM INTO ?").run(destination);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const db of this.open.values()) db.close();
    this.open.clear();
  }
}

/** The file whose lock says that a service has the data folder. It holds nothing; only its lock matters. */
const HOLD_FILE = "vigile.hold";
/** The current lock, owned by its holder child and inspected only by a separate checker process. */
const OWNER_FILE = "vigile.owner";
/** Two starts at the same moment can refuse each other. Each tries again a few times, after a pause of its own. */
const HOLD_TRIES = 4;

/**
 * Starts a holder child for each generation of the folder lock. Diagnostics inspect both through a separate
 * checker process, so on POSIX this process never opens either record-locked file and cannot release a holder's
 * lock by closing another descriptor. Holding both keeps older and current services and commands out.
 */
function tryHoldFolder(directory: string): (() => void) | null {
  needSqlite();
  const releaseOwner = holdFile(join(directory, OWNER_FILE));
  if (!releaseOwner) return null;
  try {
    const releaseLegacy = holdFile(join(directory, HOLD_FILE));
    if (!releaseLegacy) {
      releaseOwner();
      return null;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      let first: unknown;
      try {
        releaseLegacy();
      } catch (error) {
        first = error;
      }
      try {
        releaseOwner();
      } catch (error) {
        if (first) throw new AggregateError([first, error], "The data-folder locks could not both be confirmed released.");
        throw error;
      }
      if (first) throw first;
    };
    type HeldRelease = (() => void) & { holderPid: number };
    Object.defineProperty(release, "holderPids", { value: [(releaseOwner as HeldRelease).holderPid, (releaseLegacy as HeldRelease).holderPid] });
    return release;
  } catch (error) {
    releaseOwner();
    throw error;
  }
}

interface HeldLock {
  child: ChildProcess;
  release(): void;
}

/** Refuses anything but an ordinary lock file without opening a descriptor in this process. */
function mustBePlain(file: string): void {
  const stats = lstatSync(file, { throwIfNoEntry: false });
  if (stats && !stats.isFile()) throw new Error(`${file} is not a lock file of Vigile. Remove it while no vigile command and no service is running.`);
}

function tryHoldFile(file: string, keepUntilOwnerStops = false): HeldLock | null {
  needSqlite();
  mustBePlain(file);
  const exchange = mkdtempSync(join(tmpdir(), "vigile-lock-"));
  const answer = join(exchange, "answer.json");
  const released = join(exchange, "released");
  const accepted = join(exchange, "accepted");
  const disarm = join(exchange, "disarm");
  const disarmed = join(exchange, "disarmed");
  const heartbeat = join(exchange, "heartbeat");
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./lock-holder.js", import.meta.url)), file, answer, released, accepted, disarm, disarmed, heartbeat, keepUntilOwnerStops ? "owner" : "disconnect"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let spawnError: Error | null = null;
  child.on("error", (error) => {
    spawnError = error;
  });
  if (child.pid === undefined) {
    rmSync(exchange, { recursive: true, force: true });
    throw new Error(`The system lock helper could not start for ${file}.`);
  }
  let keepExchange = false;
  let expectedExit = false;
  let acceptSent = false;
  const forceStop = (): void => {
    if (child.exitCode !== null) return;
    if (!acceptSent) return child.kill("SIGKILL"), undefined;
    writeFileSync(disarm, "", { mode: 0o600 });
    const until = Date.now() + 10_000;
    while (!existsSync(disarmed) && child.exitCode === null && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    if (!existsSync(disarmed)) {
      process.stderr.write(`The system lock watchdog could not be disarmed for ${file}. Stopping rather than risking loss of exclusion.\n`);
      process.exit(1);
    }
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  try {
    const until = Date.now() + 10_000;
    while (!existsSync(answer)) {
      if (spawnError || child.exitCode !== null || Date.now() >= until) throw new Error(`The system lock helper did not answer for ${file}.`, spawnError ? { cause: spawnError } : undefined);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    const result = JSON.parse(readFileSync(answer, "utf8")) as { held?: boolean; error?: string };
    if (result.error) throw new Error(result.error);
    if (!result.held) {
      expectedExit = true;
      child.kill("SIGKILL");
      return null;
    }
    if (child.exitCode !== null || !child.connected) throw new Error(`The system lock helper stopped before ${file} was accepted.`);
    acceptSent = true;
    child.send("accept");
    const acceptUntil = Date.now() + 10_000;
    while (!existsSync(accepted)) {
      if (spawnError || child.exitCode !== null || Date.now() >= acceptUntil) {
        expectedExit = true;
        if (child.exitCode === null && child.connected) child.send("cancel");
        const cancelUntil = Date.now() + 10_000;
        while (!existsSync(released) && child.exitCode === null && Date.now() < cancelUntil) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        if (!existsSync(released)) forceStop();
        throw new Error(`The system lock helper did not confirm acceptance of ${file}.`, spawnError ? { cause: spawnError } : undefined);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    keepExchange = true;
    let done = false;
    child.on("exit", () => {
      if (!expectedExit) {
        rmSync(exchange, { recursive: true, force: true });
        process.stderr.write(`The process holding the system lock on ${file} ended unexpectedly. Stopping rather than continuing without exclusion.\n`);
        process.exit(1);
      }
    });
    // The operating-system lock and the listeners remain; neither the child handle nor its IPC channel should
    // keep an otherwise finished command alive merely because it holds a process-lifetime lock.
    child.unref();
    child.channel?.unref();
    const release = () => {
      if (done) return;
      done = true;
      expectedExit = true;
      if (child.exitCode === null && child.connected) child.send("release");
      const until = Date.now() + 10_000;
      while (!existsSync(released) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      const confirmed = existsSync(released);
      if (!confirmed) forceStop();
      rmSync(exchange, { recursive: true, force: true });
      if (!confirmed) throw new Error(`The system lock helper did not confirm release of ${file}.`);
    };
    Object.defineProperty(release, "holderPid", { value: child.pid });
    return {
      child,
      release,
    };
  } catch (error) {
    expectedExit = true;
    if (!existsSync(released)) forceStop();
    throw error;
  } finally {
    if (!keepExchange) rmSync(exchange, { recursive: true, force: true });
  }
}

/** What a system answers when it has no way to flush a folder at all. Anything else is a flush that failed. */
const CANNOT_FLUSH_FOLDERS = new Set(["EINVAL", "ENOTSUP", "ENOSYS", "EISDIR", "EPERM", "EBADF"]);

/**
 * Has the system write down what a folder holds: a file that was created, moved or renamed in it is there after
 * a power cut only once the folder itself has been flushed, however well the file was. Some systems have no way
 * to flush a folder, and there nothing more can be done. A flush that the system does offer and that fails is
 * said: what was just written is in place, but nobody may be told that it will last.
 */
export function flushFolder(folder: string, flush: (handle: number) => void = fsyncSync): void {
  let handle: number;
  try {
    handle = openSync(folder, "r");
  } catch (error) {
    if (CANNOT_FLUSH_FOLDERS.has((error as NodeJS.ErrnoException).code ?? "")) return;
    throw notFlushed(folder, error);
  }
  try {
    flush(handle);
  } catch (error) {
    if (CANNOT_FLUSH_FOLDERS.has((error as NodeJS.ErrnoException).code ?? "")) return;
    throw notFlushed(folder, error);
  } finally {
    closeSync(handle);
  }
}

const notFlushed = (folder: string, error: unknown): Error =>
  new Error(`What was written to ${folder} is in place, but the system could not confirm that it will survive a power cut: ${(error as Error).message}`, { cause: error });

/**
 * Takes a file as a lock, once: returns what lets go of it, or null when another process, or another taker in
 * this one, has it. The lock is held by the operating system and not by what the file says, so it ends with
 * the process however the process ends, and nobody has to decide whether a lock was left behind by someone who
 * died. The file itself stays; it holds nothing.
 */
export function holdFile(file: string, keepUntilOwnerStops = false): (() => void) | null {
  let holder: HeldLock | null;
  try {
    holder = tryHoldFile(file, keepUntilOwnerStops);
  } catch (error) {
    // Something else stands under that name. It is not put out of the way here: two who did that at the same
    // moment could each end up holding a file of their own. Whoever runs this removes it, with nothing running.
    if (/not a database/i.test((error as Error).message)) {
      throw new Error(`${file} is not a lock file of Vigile. Remove it while no vigile command and no service is running.`, { cause: error });
    }
    throw error;
  }
  if (!holder) return null;
  return holder.release;
}

export type AsyncRelease = (deadline?: number) => Promise<void>;

/**
 * Takes a file lock without blocking this thread while the helper answers. `deadline` is an absolute time and
 * is carried through every helper wait; null means that another process holds the lock. The returned release
 * is asynchronous for the same reason.
 */
export async function holdFileAsync(file: string, deadline: number, startWorker: () => Worker = () => new Worker(new URL("./lock-async.js", import.meta.url), { workerData: { file, deadline } })): Promise<AsyncRelease | null> {
  const worker = startWorker();
  // Until the first answer, the worker may already have acquired the OS lock while this thread was busy. An
  // unexplained exit in that interval is possible lock loss and must fail closed.
  let ownsLock = true;
  let expectedExit = false;
  // A timed-out wait deliberately leaves the helper alive long enough to cancel or release its lock. Keep one
  // listener for that whole lifetime: the temporary listener below rejects an active wait, while this one keeps
  // a later failure from becoming an uncaught error after the caller has already handled the timeout.
  worker.on("error", () => {});
  // A release can succeed after its caller's deadline. This lifetime listener records that success even after
  // the temporary wait listener is gone, so the worker's subsequent normal exit is not treated as lock loss.
  worker.on("message", (message) => {
    if (message?.released === true || message?.held === false || typeof message?.error === "string") {
      ownsLock = false;
      expectedExit = true;
    } else if (message?.held === true) {
      ownsLock = true;
    }
  });
  worker.on("exit", () => {
    if (ownsLock && !expectedExit) process.exit(1);
  });
  const wait = <T>(read: (message: any) => T | undefined, until: number): Promise<T> =>
    new Promise((resolve, reject) => {
      let finished = false;
      const done = (action: () => void): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        worker.off("message", message);
        worker.off("error", failed);
        worker.off("exit", exited);
        action();
      };
      const message = (value: any): void => {
        const answer = read(value);
        if (answer !== undefined) done(() => resolve(answer));
      };
      const failed = (error: Error): void => done(() => reject(error));
      const exited = (code: number): void => done(() => reject(new Error(`The asynchronous lock helper stopped before answering (${code}).`)));
      const timer = setTimeout(() => done(() => reject(new Error(`The asynchronous lock helper did not answer before its deadline.`))), Math.max(0, until - Date.now()));
      worker.on("message", message);
      worker.once("error", failed);
      worker.once("exit", exited);
    });
  try {
    // Let synchronous work already following this asynchronous request finish its turn first. In particular,
    // two back-to-back command-line config changes must not be split by a service worker that can acquire the
    // lock off-thread while the main thread is between those calls; the main thread could then only block the
    // continuation that would release it. Acquisition remains asynchronous and never holds up the service.
    setImmediate(() => worker.postMessage("start"));
    const answer = await wait<{ held: boolean; error?: string }>((message) => {
      if (typeof message?.held === "boolean") {
        ownsLock = message.held;
        if (!message.held) expectedExit = true;
        return message;
      }
      if (typeof message?.error === "string") {
        expectedExit = true;
        return message;
      }
      return undefined;
    }, deadline);
    if (answer.error) throw new Error(answer.error);
    if (!answer.held) {
      expectedExit = true;
      await worker.terminate();
      return null;
    }
    let released = false;
    return async (releaseDeadline = Date.now() + 10_000): Promise<void> => {
      if (released) return;
      released = true;
      worker.postMessage("release");
      try {
        const result = await wait<{ released?: boolean; releaseError?: string }>((message) => {
          if (message?.released === true) {
            ownsLock = false;
            expectedExit = true;
            return message;
          }
          return typeof message?.releaseError === "string" ? message : undefined;
        }, releaseDeadline);
        if (result.releaseError) throw new Error(result.releaseError);
        await worker.terminate();
      } catch (error) {
        try {
          worker.postMessage("release");
        } catch {}
        worker.unref();
        throw error;
      }
    };
  } catch (error) {
    try {
      worker.postMessage("cancel");
    } catch {}
    worker.unref();
    throw error;
  }
}

/**
 * Takes a data folder for the lifetime of this process, so that no second service works on the same data from a
 * copy of its own. Dedicated child processes own the current and legacy system locks for the protected lifetime,
 * so closing any descriptor in this process cannot release either POSIX lock. When this process ends, however it
 * ends, its IPC channels close and the lock holders release both locks.
 * Returns what lets go of the folder, or null when another process has it.
 */
export function holdFolder(directory: string): (() => void) | null {
  for (let attempt = 0; attempt < HOLD_TRIES; attempt++) {
    const release = tryHoldFolder(directory);
    if (release) return release;
    if (attempt < HOLD_TRIES - 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 + Math.floor(Math.random() * 80));
  }
  return null;
}

/** Asynchronously takes the same current and legacy folder locks as `holdFolder`. */
export async function holdFolderAsync(directory: string, deadline: number): Promise<AsyncRelease | null> {
  needSqlite();
  const owner = await holdFileAsync(join(directory, OWNER_FILE), deadline);
  if (!owner) return null;
  let legacy: AsyncRelease | null = null;
  try {
    legacy = await holdFileAsync(join(directory, HOLD_FILE), deadline);
    if (!legacy) {
      await owner();
      return null;
    }
    let released = false;
    return async (releaseDeadline = Date.now() + 10_000): Promise<void> => {
      if (released) return;
      released = true;
      const failures: unknown[] = [];
      await legacy!(releaseDeadline).catch((error) => failures.push(error));
      await owner(releaseDeadline).catch((error) => failures.push(error));
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "The folder locks could not both be confirmed released.");
    };
  } catch (error) {
    if (!legacy) await owner().catch(() => {});
    throw error;
  }
}

const FILES_HOLD = "vigile.files";

/**
 * Takes the files of the tenants in a data folder, for whoever moves them and for whoever copies them: a
 * restore, the recovery of one, and a backup. Not the running service, which holds the folder itself and never
 * moves a file, so a backup can still be taken beside it. Without this, a restore could move a tenant's file
 * and what lies beside it away under a backup that has it open, and the backup would leave out what it had not
 * read yet and say that all is well.
 * Waits up to `waitMs` for whoever has them. Returns what lets go, or null when they did not come free.
 */
export function holdTenantFiles(directory: string, waitMs = 0): (() => void) | null {
  const end = Date.now() + waitMs;
  for (;;) {
    const release = holdFile(join(directory, FILES_HOLD));
    if (release || Date.now() >= end) return release;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 + Math.floor(Math.random() * 40));
  }
}

/**
 * Whether the folder has ever been held the way it is held now. A folder that has not is one that only an
 * earlier version has worked in, or nobody.
 */
export const everHeld = (directory: string): boolean => existsSync(join(directory, HOLD_FILE));

/** Whether a process has the data folder right now. Only looks: it takes nothing and creates nothing. */
export function folderIsHeld(directory: string): boolean {
  needSqlite();
  const [owner, legacy] = [join(directory, OWNER_FILE), join(directory, HOLD_FILE)];
  mustBePlain(owner);
  mustBePlain(legacy);
  const checked = spawnSync(process.execPath, ["--no-warnings", fileURLToPath(new URL("./lock-checker.js", import.meta.url)), owner, legacy], { encoding: "utf8" });
  if (checked.error) throw checked.error;
  if (checked.status !== 0) throw new Error(checked.stderr.trim() || "The process that inspected the data-folder locks failed.");
  const answer = JSON.parse(checked.stdout) as { held: boolean };
  return answer.held;
}

export interface TenantFileReport {
  tenant: string;
  file: string;
  ok: boolean;
  messages: string[];
  format: number | null;
  revision: number | null;
}

/** The tenant files in a data folder, without opening them. */
export function tenantFiles(directory: string): Array<{ tenant: string; file: string }> {
  return readdirSync(directory)
    .filter((f) => f.endsWith(".sqlite"))
    .sort()
    .map((f) => ({ tenant: f.slice(0, -".sqlite".length), file: join(directory, f) }))
    .filter(({ tenant }) => isTenantName(tenant));
}

/**
 * Checks a tenant file through a read-only connection, so it is safe while a service has the file open
 * and never changes it.
 */
export function inspectTenantFile(tenant: string, file: string): TenantFileReport {
  const report: TenantFileReport = { tenant, file, ok: false, messages: [], format: null, revision: null };
  let connection: ReadOnlyConnection | undefined;
  try {
    connection = openReadOnlyDatabase(file);
    const { db } = connection;
    const rows = db.prepare("PRAGMA integrity_check").all() as unknown as Array<{ integrity_check: string }>;
    report.messages = rows.map((r) => r.integrity_check);
    const head = db.prepare("SELECT format, revision FROM head WHERE id = 1").get() as { format: number; revision: number } | undefined;
    if (head) {
      report.format = head.format;
      report.revision = head.revision;
    } else report.messages.push("the tenant has no head record");
    // A sound database is not yet a plan: what is in it must read as one, or the service would not start on it.
    const wrong = head && head.format <= FORMAT_VERSION ? unreadable(db) : null;
    if (wrong) report.messages.push(wrong);
    report.ok = report.messages.length === 1 && report.messages[0] === "ok" && report.format !== null && report.format <= FORMAT_VERSION;
    if (report.format !== null && report.format > FORMAT_VERSION) {
      report.messages.push(`data format ${report.format} is newer than this version understands (${FORMAT_VERSION})`);
    }
  } catch (error) {
    report.messages.push((error as Error).message);
  } finally {
    connection?.close();
  }
  return report;
}

function headIn(db: Database): Head | null {
  const row = db.prepare("SELECT format, revision, counters FROM head WHERE id = 1").get() as { format: number; revision: number; counters: string } | undefined;
  return row ? { format: row.format, revision: row.revision, counters: JSON.parse(row.counters) } : null;
}

/** Everything a tenant holds except long text and history, as the service reads it when it starts. */
function snapshotIn(db: Database): Snapshot | null {
  const head = headIn(db);
  if (!head) return null;
  const objects = (db.prepare("SELECT kind, id, version, data FROM objects ORDER BY kind, id").all() as unknown as Array<{
    kind: string;
    id: string;
    version: number;
    data: string;
  }>).map((r): ObjectRecord => ({ kind: r.kind, id: r.id, version: r.version, data: JSON.parse(r.data) as JsonObject }));
  const links = (db
    .prepare("SELECT from_kind, from_id, type, to_kind, to_id, data FROM links ORDER BY from_kind, from_id, type, to_kind, to_id")
    .all() as unknown as Array<{ from_kind: string; from_id: string; type: string; to_kind: string; to_id: string; data: string }>).map(
    (r): LinkRecord => ({
      fromKind: r.from_kind,
      fromId: r.from_id,
      type: r.type,
      toKind: r.to_kind,
      toId: r.to_id,
      data: JSON.parse(r.data) as JsonObject,
    }),
  );
  return { head, objects, links };
}

/** The tables of a tenant file. */
const TABLES = ["head", "objects", "links", "history"];

interface Column {
  name: string;
  type: string;
  notnull: number;
  /** The column's place in the table's key, or 0 when it is not part of it. */
  pk: number;
}

const columnsOf = (db: Database, table: string): Column[] =>
  (db.prepare(`PRAGMA table_xinfo(${table})`).all() as unknown as Column[]).map(({ name, type, notnull, pk }) => ({ name, type: String(type).toUpperCase(), notnull, pk }));

/** The tables as the store makes them, read from a database made from `SCHEMA`, so that the two cannot drift apart. */
let made: Map<string, Column[]> | undefined;
function asMade(): Map<string, Column[]> {
  if (made) return made;
  const db = openDatabase(":memory:");
  try {
    db.exec(SCHEMA);
    made = new Map(TABLES.map((table) => [table, columnsOf(db, table)]));
    return made;
  } finally {
    db.close();
  }
}

/**
 * How a file's tables differ from the ones the store works with, in words, or nothing. The store reads and
 * writes every column by name, and writes by each table's key: a table without a column fails every read of
 * it, and one without its key fails every write.
 */
function lacking(db: Database): string | null {
  for (const [table, wanted] of asMade()) {
    const has = columnsOf(db, table);
    if (!has.length) return `it has no table "${table}"`;
    const missing = wanted.filter((column) => !has.some((other) => other.name === column.name)).map((column) => column.name);
    if (missing.length) return `its table "${table}" has no column "${missing.join('", "')}"`;
    const key = (columns: Column[]) => columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name).join(", ");
    if (key(has) !== key(wanted)) return `its table "${table}" does not have the key the store writes by (${key(wanted)})`;
    const odd = wanted.find((column) => {
      const other = has.find((candidate) => candidate.name === column.name)!;
      return other.type !== column.type || other.notnull !== column.notnull;
    });
    if (odd) return `the column "${odd.name}" of its table "${table}" is not what the store makes it`;
    const extra = has.find((column) => !wanted.some((other) => other.name === column.name));
    if (extra) return `its table "${table}" has a column "${extra.name}" that the store does not make and would not fill`;
  }
  // And everything else that is defined in the file, to the letter: a default, a check, a trigger, an index or a
  // view the store does not make can each turn a write away. A backup is a copy of a file the store made, and
  // has exactly what the store makes.
  const defined = definedIn(db);
  const wanted = asDefined();
  const unknown = defined.find((entry) => !wanted.some((other) => other.type === entry.type && other.name === entry.name));
  if (unknown) return `it has ${/^[aeiou]/.test(unknown.type) ? "an" : "a"} ${unknown.type} "${unknown.name}" that the store does not make`;
  const changed = defined.find((entry) => wanted.find((other) => other.type === entry.type && other.name === entry.name)?.sql !== entry.sql);
  if (changed) return `its ${changed.type} "${changed.name}" is not defined the way the store defines it`;
  return null;
}

interface Defined {
  type: string;
  name: string;
  sql: string;
}

/** What a database defines, each definition with its spacing evened out. What SQLite makes for itself is left out. */
const definedIn = (db: Database): Defined[] =>
  // By the first seven letters as they are written: in LIKE the underscore stands for any letter, which would
  // leave out a trigger called "sqliteX_…" as well.
  (db.prepare("SELECT type, name, sql FROM sqlite_master WHERE lower(substr(name, 1, 7)) <> 'sqlite_' ORDER BY type, name").all() as unknown as Array<{ type: string; name: string; sql: string | null }>).map(
    ({ type, name, sql }) => ({ type, name, sql: (sql ?? "").replace(/\s+/g, " ").trim() }),
  );

let definitions: Defined[] | undefined;
function asDefined(): Defined[] {
  if (definitions) return definitions;
  const db = openDatabase(":memory:");
  try {
    db.exec(SCHEMA);
    definitions = definedIn(db);
    return definitions;
  } finally {
    db.close();
  }
}

const isRecord = (value: unknown): boolean => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What is wrong with a tenant's data as the service would read it, in words, or nothing. SQLite's own check
 * says that the file is a sound database; this says that what is in it is a plan: the tables are there, every
 * record reads as what it has to be, and the counters are numbers.
 */
function unreadable(db: Database): string | null {
  const lacks = lacking(db);
  if (lacks) return lacks;
  let snapshot: Snapshot | null;
  try {
    snapshot = snapshotIn(db);
  } catch (error) {
    return `what is stored in it cannot be read: ${(error as Error).message}`;
  }
  if (!snapshot) return null;
  const { counters } = snapshot.head;
  if (!isRecord(counters) || !Object.values(counters).every((value) => Number.isSafeInteger(value) && (value as number) >= 0)) return "its counters are not numbers";
  const object = snapshot.objects.find((record) => !isRecord(record.data) || !Number.isSafeInteger(record.version));
  if (object) return `the record of ${object.kind} ${object.id} is not a record`;
  const link = snapshot.links.find((record) => !isRecord(record.data));
  if (link) return `the link from ${link.fromKind} ${link.fromId} to ${link.toKind} ${link.toId} is not a record`;
  // The history is not read at the start, and is read whenever an item is opened with it: an entry that is not a
  // record would fail that. Asked of the database itself, which goes through the entries without handing them over.
  const entry = db.prepare("SELECT kind, id, revision FROM history WHERE NOT json_valid(data) OR json_type(data) <> 'object' LIMIT 1").get() as { kind: string; id: string; revision: number } | undefined;
  if (entry) return `an entry in the history of ${entry.kind} ${entry.id}, at revision ${entry.revision}, is not a record`;
  // Every change is written to the history at the revision it makes. A history that goes on after the revision
  // the file says it is at would have the next change written where an entry already is. Both numbers are read
  // in one statement, so that a change stored in between cannot come between them.
  const at = db.prepare("SELECT (SELECT revision FROM head WHERE id = 1) AS head, (SELECT max(revision) FROM history) AS latest").get() as { head: number | null; latest: number | null };
  if (at.head !== null && at.latest !== null && at.latest > at.head) return `its history goes on to revision ${at.latest}, after revision ${at.head}, which it says it is at`;
  return null;
}

/**
 * The items that have history in a tenant file, as they are stored. The history is not read at the start: this
 * is for whoever checks a file before it takes the place of the data.
 */
export function historyOwners(file: string): Array<{ kind: string; id: string }> {
  const connection = openReadOnlyDatabase(file);
  try {
    return connection.db.prepare("SELECT DISTINCT kind, id FROM history").all() as unknown as Array<{ kind: string; id: string }>;
  } finally {
    connection.close();
  }
}

/**
 * Reads a tenant file as the service would at its start, without changing it and without the service: for
 * whoever has to know that a file will open as a plan before it is put in the place of the data.
 */
export function readTenantFile(file: string): Snapshot | null {
  const connection = openReadOnlyDatabase(file);
  try {
    return snapshotIn(connection.db);
  } finally {
    connection.close();
  }
}

/** Writes a consistent copy of a tenant file, through a read-only connection, while a service may be using it. */
export function backupTenantFile(file: string, destination: string, expected?: { device: number; inode: number; staging?: { directory: string; file: string; device: number; inode: number; fileDevice: number; fileInode: number } }): void {
  const connection = openReadOnlyDatabase(file);
  const { db } = connection;
  let handle: number | null = null;
  let staged: number | null = null;
  let staging: string | null = null;
  let stagedPath: string | null = null;
  let stagingIdentity: { device: number; inode: number } | null = null;
  let stagedIdentity: { device: number; inode: number } | null = null;
  let cleanupError: unknown;
  try {
    if (expected) {
      handle = openSync(destination, constants.O_RDWR | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
      const actual = fstatSync(handle);
      if (actual.dev !== expected.device || actual.ino !== expected.inode) throw new Error(`${destination} is not the file prepared for this backup`);
      // SQLite needs a name that does not exist for VACUUM INTO. Keep the private transient copy on the chosen
      // backup volume, then copy through the already-open destination descriptor. This avoids requiring a
      // second database-sized allocation on the system temporary volume.
      staging = expected.staging?.directory ?? mkdtempSync(join(dirname(destination), ".vigile-backup-copy-"));
      const madeStaging = lstatSync(staging, { throwIfNoEntry: false });
      stagingIdentity = expected.staging ? { device: expected.staging.device, inode: expected.staging.inode } : madeStaging ? { device: madeStaging.dev, inode: madeStaging.ino } : null;
      if (!madeStaging?.isDirectory() || !stagingIdentity || madeStaging.dev !== stagingIdentity.device || madeStaging.ino !== stagingIdentity.inode) throw new Error(`${staging} is not the private staging directory made for this backup`);
      stagedPath = expected.staging?.file ?? join(staging, "copy.sqlite");
      if (!expected.staging) {
        const reserved = openSync(stagedPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
        const identity = fstatSync(reserved);
        stagedIdentity = { device: identity.dev, inode: identity.ino };
        closeSync(reserved);
      }
      const preparedStaging = lstatSync(stagedPath, { throwIfNoEntry: false });
      if (expected.staging && (!preparedStaging?.isFile() || preparedStaging.size !== 0 || preparedStaging.dev !== expected.staging.fileDevice || preparedStaging.ino !== expected.staging.fileInode)) throw new Error(`${stagedPath} is not the empty staging file prepared for this backup`);
      if (!expected.staging && (!preparedStaging?.isFile() || preparedStaging.size !== 0 || preparedStaging.dev !== stagedIdentity?.device || preparedStaging.ino !== stagedIdentity.inode)) throw new Error(`${stagedPath} is not the empty staging file reserved for this backup`);
      db.prepare("VACUUM INTO ?").run(stagedPath);
      staged = openSync(stagedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stillStaging = lstatSync(staging, { throwIfNoEntry: false });
      const stagedFile = fstatSync(staged);
      const recordedStaging = expected.staging ? { device: expected.staging.fileDevice, inode: expected.staging.fileInode } : stagedIdentity;
      if (!stillStaging?.isDirectory() || stillStaging.dev !== stagingIdentity.device || stillStaging.ino !== stagingIdentity.inode || !stagedFile.isFile() || !recordedStaging || stagedFile.dev !== recordedStaging.device || stagedFile.ino !== recordedStaging.inode) throw new Error(`${stagedPath} is not the staging file prepared for this backup`);
      stagedIdentity = recordedStaging;
      ftruncateSync(handle, 0);
      const buffer = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const read = readSync(staged, buffer, 0, buffer.length, null);
        if (!read) break;
        let written = 0;
        while (written < read) written += writeSync(handle, buffer, written, read - written);
      }
      fsyncSync(handle);
    } else db.prepare("VACUUM INTO ?").run(destination);
  } finally {
    try {
      if (staged !== null) closeSync(staged);
      if (handle !== null) closeSync(handle);
      if (staging !== null && stagingIdentity !== null) {
        const directory = lstatSync(staging, { throwIfNoEntry: false });
        // Never recursively remove a name that now belongs to another directory. Inside the same private
        // directory, remove only the one staging file this backup created; foreign entries keep the directory.
        if (directory?.isDirectory() && directory.dev === stagingIdentity.device && directory.ino === stagingIdentity.inode) {
          if (stagedPath !== null) {
            const file = lstatSync(stagedPath, { throwIfNoEntry: false });
            const expectedFile = expected?.staging;
            if (file?.isFile() && (expectedFile ? file.dev === expectedFile.fileDevice && file.ino === expectedFile.fileInode : stagedIdentity !== null && file.dev === stagedIdentity.device && file.ino === stagedIdentity.inode)) rmSync(stagedPath);
          }
          try { rmdirSync(staging); } catch (error) {
            if (expected?.staging) cleanupError = error;
            // A foreign entry appeared in the private directory; leave it and the directory alone.
          }
        }
      }
    } finally {
      connection.close();
    }
    if (cleanupError) throw cleanupError;
  }
}
