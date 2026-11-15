import { spawn, type ChildProcess } from "node:child_process";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { processIdentity, processIsAlive, stopProcess } from "./stop-process.js";

const [file, answer, released, accepted, disarm, disarmed, heartbeat] = process.argv.slice(2);
const busy = (error: unknown): boolean => (error as { errcode?: number }).errcode === 5 || /database is locked/.test((error as Error).message);
let database: DatabaseSync | null = null;
let watchdog: ChildProcess | null = null;
const owner = process.ppid;
let watchdogExpected = false;
let acquisitionAccepted = false;
let stoppingOwner = false;
const publish = (file: string, value: string): void => {
  const partial = `${file}.partial`;
  writeFileSync(partial, value, { mode: 0o600 });
  renameSync(partial, file);
};

// Group-directed shutdown signals belong to the service. Keep the lock until the parent finishes its orderly
// shutdown and explicitly releases it; an abrupt parent exit closes IPC and releases it here as well.
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});

const finish = (confirm = false): void => {
  watchdogExpected = true;
  watchdog?.kill("SIGKILL");
  if (database) {
    try {
      database.exec("ROLLBACK");
      database.close();
    } catch {
      // The process is ending; the operating system releases anything left.
    }
    database = null;
  }
  if (confirm && released) publish(released, "");
  else if (answer) rmSync(dirname(answer), { recursive: true, force: true });
  process.exit();
};

const startWatchdog = (): void => {
  if (watchdog) return;
  const identities = { owner: processIdentity(owner), holder: processIdentity(process.pid) };
  if (!identities.owner || !identities.holder) throw new Error("The system lock watchdog could not identify its owner and holder processes.");
  writeFileSync(heartbeat!, "", { mode: 0o600 });
  setInterval(() => writeFileSync(heartbeat!, "", { mode: 0o600 }), 500);
  watchdog = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./lock-watchdog.js", import.meta.url)), String(owner), String(process.pid), disarm!, disarmed!, heartbeat!, identities.owner, identities.holder], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    // The watchdog must survive an abrupt holder death on every platform. Windows otherwise tears the child
    // down with the holder; windowsHide keeps the detached helper from opening a console window.
    detached: true,
    windowsHide: true,
  });
  const stopOwnerFailClosed = (): void => {
    if (!acquisitionAccepted) return finish(false);
    if (stoppingOwner) return;
    stoppingOwner = true;
    const retry = (): void => {
      // The holder is now the last protection. Keep SQLite open even when termination fails, and retry until
      // the owner exits and closes this IPC channel; the existing disconnect handler then releases the lock.
      if (!process.connected || process.ppid !== owner) return;
      try {
        stopProcess(owner);
      } catch {}
      if (process.connected && process.ppid === owner) setTimeout(retry, 250);
    };
    retry();
  };
  watchdog.on("error", stopOwnerFailClosed);
  watchdog.on("exit", () => {
    if (!watchdogExpected) stopOwnerFailClosed();
  });
  if (watchdog.pid === undefined) throw new Error("The system lock watchdog could not start.");
};

const finishAfterOwnerStops = (): void => {
  if (!acquisitionAccepted) return finish(false);
  const wait = (): void => {
    // A worker thread can disappear while its process is synchronously busy. Its IPC channel closes first, but
    // releasing here would admit another writer before the owner's fail-closed exit listener can run.
    if (!processIsAlive(owner)) return finish(false);
    setTimeout(wait, 50);
  };
  wait();
};

try {
  if (!file || !answer) throw new Error("A lock file and answer file are required.");
  database = new DatabaseSync(file);
  database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
  publish(answer, JSON.stringify({ held: true }));
  process.on("message", (message) => {
    if (message !== "accept") return finish(true);
    try {
      startWatchdog();
      acquisitionAccepted = true;
      publish(accepted!, "");
    } catch {
      finish(false);
    }
  });
  process.on("disconnect", finishAfterOwnerStops);
} catch (error) {
  if (database) {
    try {
      database.close();
    } catch {
      // The process is ending.
    }
  }
  publish(answer!, JSON.stringify(busy(error) ? { held: false } : { error: (error as Error).message }));
  process.exit();
}
