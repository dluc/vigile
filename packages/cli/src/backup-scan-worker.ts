import { lstatSync, readdirSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { holdFile, holdTenantFiles } from "@vigile/storage-sqlite";
import { BackupRefused, backupOperationLock, clearLeftovers, designateBackupFolder, prepareBackupFolder, settleCopies, tenantsIn, wholeMoments, type PlannedCopy } from "./backup.js";
import { FILES_WAIT_MS } from "./restore.js";

type Request =
  | { action: "prepare"; dataDir: string; folder: string; create: boolean }
  | { action: "designate"; dataDir: string; folder: string; expected: { device: number; inode: number } }
  | { action: "scan" | "recover"; dataDir: string; folder: string; expected: { device: number; inode: number } }
  | { action: "settle"; dataDir: string; folder: string; expected: { device: number; inode: number }; copies: PlannedCopy[] };

const request = workerData as Request;

try {
  if (request.action === "prepare") {
    const identity = prepareBackupFolder(request.dataDir, request.folder, request.create);
    parentPort!.postMessage({ ok: true, identity });
  } else if (request.action === "designate") {
    const identity = designateBackupFolder(request.dataDir, request.folder, request.expected);
    parentPort!.postMessage({ ok: true, identity });
  } else {
    const found = lstatSync(request.folder, { throwIfNoEntry: false });
    if (!found?.isDirectory() || found.dev !== request.expected.device || found.ino !== request.expected.inode) {
      throw new BackupRefused(`The backup folder ${request.folder} was moved or replaced after this service took it.`, ["Put the folder back, or restart the service after choosing a stable backup folder."]);
    }
    const before = request.action === "recover" ? readdirSync(request.folder) : undefined;
    if (request.action === "recover") {
      // A manual backup holds this lock while its reserved transient names are live. Recovery must not infer
      // from their names that they were abandoned until no backup or restore can still be writing them.
      const release = holdTenantFiles(request.dataDir, FILES_WAIT_MS);
      if (!release) throw new BackupRefused(`A restore, or another backup, is at work in ${request.dataDir}.`, ["Let it finish; the service will try again."]);
      let destination: (() => void) | null = null;
      try {
        destination = holdFile(backupOperationLock(request.folder));
        if (!destination) throw new BackupRefused(`Another backup is writing in ${request.folder}.`, ["Let it finish; the service will try again."]);
        clearLeftovers(request.folder);
      } finally {
        destination?.();
        release();
      }
    }
    const whole = request.action === "settle" ? settleCopies(request.copies) : undefined;
    const bytes = request.action === "settle" && whole ? request.copies.reduce((sum, copy) => sum + (lstatSync(copy.file, { throwIfNoEntry: false })?.size ?? 0), 0) : undefined;
    let moments: number[] | undefined;
    let scanError: string | undefined;
    try { moments = wholeMoments(request.folder, tenantsIn(request.dataDir)); }
    catch (error) { scanError = error instanceof Error ? error.message : String(error); }
    if (scanError && request.action !== "settle") throw new Error(scanError);
    parentPort!.postMessage({ ok: true, identity: request.expected, moments, before, whole, bytes, scanError });
  }
} catch (error) {
  parentPort!.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error), hints: error instanceof BackupRefused ? error.hints : [], refused: error instanceof BackupRefused });
}
