import { lstatSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { BackupRefused, prepareCopies } from "./backup.js";

const request = workerData as { dataDir: string; folder: string; at: number; expected: { device: number; inode: number } };

try {
  const found = lstatSync(request.folder, { throwIfNoEntry: false });
  if (!found?.isDirectory() || found.dev !== request.expected.device || found.ino !== request.expected.inode) {
    throw new BackupRefused(`The backup folder ${request.folder} was moved or replaced after this service took it.`, ["Put the folder back, or restart the service after choosing a stable backup folder."]);
  }
  parentPort!.postMessage({ ok: true, copies: prepareCopies(request.dataDir, request.folder, new Date(request.at), true) });
} catch (error) {
  parentPort!.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error), hints: error instanceof BackupRefused ? error.hints : [] });
}
