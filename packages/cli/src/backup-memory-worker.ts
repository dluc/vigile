import { closeSync, fsyncSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { createPlainFile } from "@vigile/config";
import { flushFolder } from "@vigile/storage-sqlite";

const { dataDir, name, text } = workerData as { dataDir: string; name: string; text: string | null };
const file = join(dataDir, name);

try {
  if (text === null) rmSync(file, { force: true });
  else {
    const working = `${file}.tmp`;
    rmSync(working, { force: true });
    const handle = createPlainFile(working);
    try {
      writeFileSync(handle, text);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    try {
      renameSync(working, file);
    } catch (error) {
      rmSync(working, { force: true });
      throw error;
    }
    flushFolder(dataDir);
  }
  parentPort!.postMessage({ ok: true });
} catch (error) {
  parentPort!.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
}
