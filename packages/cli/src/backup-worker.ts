import { parentPort, workerData } from "node:worker_threads";
import { BackupRefused, takeBackup, type BackupPoint, type WorkerAnswer, type WorkerRequest } from "./backup.js";

/** Takes one backup for the service, on a thread of its own, and says how it went. See `sqliteBackups`. */
const request = workerData as WorkerRequest;

/** For the tests: stops at the place that was asked for, and says so first. */
const { pause } = request;
const step = pause
  ? (point: BackupPoint, tenant?: string): void => {
      if (point !== pause.point || (pause.tenant !== undefined && tenant !== pause.tenant)) return;
      const reached = new Int32Array(pause.reached);
      Atomics.store(reached, 0, 1);
      if (pause.then === "die") process.exit(1);
      Atomics.wait(reached, 0, 1);
    }
  : undefined;

let answer: WorkerAnswer;
try {
  answer = { ok: true, result: takeBackup({ dataDir: request.dataDir, folder: request.folder, at: new Date(request.at), automatic: request.automatic, copies: request.copies, folderIdentity: request.folderIdentity, step }) };
} catch (error) {
  answer = { ok: false, message: error instanceof Error ? error.message : String(error), hints: error instanceof BackupRefused ? error.hints : null };
}
parentPort!.postMessage(answer);
