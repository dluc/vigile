import { parentPort, workerData } from "node:worker_threads";
import { holdFile } from "./index.js";

const request = workerData as { file?: unknown; deadline?: unknown };
if (!parentPort || typeof request?.file !== "string" || typeof request.deadline !== "number") throw new Error("An asynchronous lock worker needs a file, deadline and parent port.");
const file = request.file;
const deadline = request.deadline;

parentPort.once("message", (start) => {
  if (start !== "start") {
    if (start === "cancel") parentPort!.postMessage({ held: false });
    return;
  }
  try {
    const release = holdFile(file);
    if (!release) {
      parentPort!.postMessage({ held: false });
    } else if (Date.now() >= deadline) {
      release();
      parentPort!.postMessage({ held: false });
    } else {
      parentPort!.postMessage({ held: true });
      parentPort!.once("message", (message) => {
        if (message !== "release" && message !== "cancel") return;
        try {
          release();
          parentPort!.postMessage({ released: true });
        } catch (error) {
          // holdFile either receives the holder's acknowledgement or stops the holder before throwing. The
          // operating-system lock is therefore gone even when exchange-directory cleanup could not be confirmed.
          parentPort!.postMessage({ released: true, releaseError: (error as Error).message });
        }
      });
    }
  } catch (error) {
    parentPort!.postMessage({ error: (error as Error).message });
  }
});
