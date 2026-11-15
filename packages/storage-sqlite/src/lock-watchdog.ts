import { existsSync, statSync, writeFileSync } from "node:fs";
import { processIsAlive, stopOwnerThenHolder } from "./stop-process.js";

const owner = Number(process.argv[2]);
const holder = Number(process.argv[3]);
const [disarm, disarmed, heartbeat, ownerIdentity, holderIdentity] = process.argv.slice(4);
let safe = false;
let stopping = false;
let lastHeartbeat: number | null = null;
let unchangedHeartbeats = 0;

process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});

if (!Number.isInteger(owner) || owner <= 0 || !Number.isInteger(holder) || holder <= 0 || !disarm || !disarmed || !heartbeat || !ownerIdentity || !holderIdentity) process.exit(2);
const holderIsAlive = (): boolean => processIsAlive(holder);

const stopOwner = (): void => {
  if (stopping || safe || existsSync(disarm)) return;
  stopping = true;
  // The holder may be alive but stalled. Its lock remains until the owner is confirmed gone on every platform;
  // a failed owner or holder termination returns false and is retried on the next observation.
  if (!stopOwnerThenHolder(owner, holder, undefined, undefined, { owner: ownerIdentity!, holder: holderIdentity! })) {
    stopping = false;
    return;
  }
  process.exit();
};

setInterval(() => {
  if (safe) return;
  if (existsSync(disarm)) {
    safe = true;
    writeFileSync(disarmed, "", { mode: 0o600 });
  } else {
    const beat = statSync(heartbeat, { throwIfNoEntry: false });
    if (beat && beat.mtimeMs !== lastHeartbeat) {
      lastHeartbeat = beat.mtimeMs;
      unchangedHeartbeats = 0;
    } else {
      unchangedHeartbeats++;
    }
    // Count observations rather than wall time: after a suspended machine resumes, the holder gets several
    // chances to write before anything is stopped. A dead or hung holder cannot advance the mark.
    if (!holderIsAlive() || unchangedHeartbeats >= 20) stopOwner();
  }
}, 250);

process.on("disconnect", () => {
  if (safe || existsSync(disarm)) {
    if (!safe) writeFileSync(disarmed, "", { mode: 0o600 });
    return process.exit();
  }
  stopOwner();
});
