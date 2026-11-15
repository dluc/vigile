import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Worker } from "node:worker_threads";
import { holdFileAsync } from "./index.js";
import { processIdentity, processIsAlive, stopAndConfirm, stopOwnerThenHolder } from "./stop-process.js";

it("confirms process absence only for ESRCH", () => {
  const failingProbe = (code: string): typeof process.kill => () => {
    throw Object.assign(new Error(), { code });
  };

  assert.equal(processIsAlive(101, failingProbe("ESRCH")), false);
  assert.equal(processIsAlive(101, failingProbe("EPERM")), true);
  assert.equal(processIsAlive(101, failingProbe("EACCES")), true);
  assert.equal(processIsAlive(101, failingProbe("EINVAL")), true);
  const noProc = (() => {
    throw Object.assign(new Error(), { code: "ENOENT" });
  }) as typeof readFileSync;
  assert.equal(processIsAlive(101, (() => true) as typeof process.kill, noProc), true, "unavailable procfs is not proof of death");
  if (process.platform === "linux") {
    let probes = 0;
    const exitedBetween = (() => {
      if (probes++ > 0) throw Object.assign(new Error(), { code: "ESRCH" });
      return true;
    }) as typeof process.kill;
    assert.equal(processIsAlive(101, exitedBetween, noProc), false, "ESRCH on the confirming probe proves an exit race");
  }
});

it("signals only the process birth that was originally observed", () => {
  assert.ok(processIdentity(process.pid), "the current platform supplies a process-birth identity");
  const stopped: number[] = [];
  const stop = (pid: number): void => void stopped.push(pid);
  const alive = (): boolean => true;
  assert.equal(stopAndConfirm(101, stop, alive, "birth-a", () => "birth-b"), true, "a reused PID means the original process is gone");
  assert.deepEqual(stopped, [], "the replacement process is not signalled");
  assert.equal(stopAndConfirm(101, stop, alive, "birth-a", () => null), false, "unknown identity remains fail-closed");
  assert.deepEqual(stopped, []);
  let reads = 0;
  assert.equal(stopAndConfirm(101, stop, alive, "birth-a", () => reads++ === 0 ? "birth-a" : null), false, "identity becoming unreadable after a failed stop remains fail-closed");
  let running = true;
  assert.equal(stopAndConfirm(101, () => { running = false; }, () => running, "birth-a", () => "birth-a"), true);
});

it("treats an unreaped Linux zombie as terminated", { skip: process.platform !== "linux" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "vigile-zombie-"));
  const ready = join(directory, "ready");
  const script = `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' }); writeFileSync(process.argv[1], String(child.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);`;
  const parent = spawn(process.execPath, ["-e", script, ready], { stdio: "ignore" });
  try {
    const until = Date.now() + 5_000;
    while (!existsSync(ready) && parent.exitCode === null && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
    const zombie = existsSync(ready) ? Number(readFileSync(ready, "utf8")) : 0;
    assert.ok(Number.isInteger(zombie) && zombie > 0);
    let state = "";
    while (Date.now() < until) {
      const stat = readFileSync(`/proc/${zombie}/stat`, "utf8");
      state = stat[stat.lastIndexOf(") ") + 2]!;
      if (state === "Z") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(state, "Z", "the child remains unreaped while its parent blocks");
    assert.equal(processIsAlive(zombie), false, "a zombie cannot run and does not keep the holder lock");
  } finally {
    if (parent.exitCode === null) parent.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps the holder alive through owner termination failures, then retries holder failures", () => {
  const owner = 101;
  const holder = 202;
  const alive = new Set([owner, holder]);
  const attempts: number[] = [];
  let ownerFailures = 2;
  let holderFailures = 1;
  const stop = (pid: number): void => {
    attempts.push(pid);
    if (pid === owner && ownerFailures-- > 0) throw new Error("owner termination failed");
    if (pid === holder && holderFailures-- > 0) throw new Error("holder termination failed");
    alive.delete(pid);
  };
  const exists = (pid: number): boolean => alive.has(pid);

  assert.equal(stopOwnerThenHolder(owner, holder, stop, exists), false);
  assert.equal(stopOwnerThenHolder(owner, holder, stop, exists), false);
  assert.deepEqual(attempts, [owner, owner], "the holder was never touched while its owner remained alive");
  assert.equal(stopOwnerThenHolder(owner, holder, stop, exists), false);
  assert.deepEqual(attempts, [owner, owner, owner, holder], "the first holder failure remains fail-closed");
  assert.equal(stopOwnerThenHolder(owner, holder, stop, exists), true);
  assert.deepEqual(attempts, [owner, owner, owner, holder, owner, holder], "a later retry confirms both processes gone in order");
});

class TimedOutWorker extends EventEmitter {
  readonly sent: unknown[] = [];
  answerStart = false;
  answerRelease = false;
  postMessage(message: unknown): void {
    this.sent.push(message);
    if (message === "start" && this.answerStart) queueMicrotask(() => this.emit("message", { held: true }));
    if (message === "release" && this.answerRelease) queueMicrotask(() => this.emit("message", { released: true }));
  }
  terminate(): Promise<number> {
    return Promise.resolve(0);
  }
  unref(): void {}
}

it("keeps late worker outcomes handled after acquisition and release timeouts", async (t) => {
  const acquiring = new TimedOutWorker();
  await assert.rejects(holdFileAsync("unused", Date.now() + 20, () => acquiring as unknown as Worker), /did not answer before its deadline/);
  assert.deepEqual(acquiring.sent, ["start", "cancel"]);
  assert.doesNotThrow(() => acquiring.emit("error", new Error("late acquisition failure")));

  const releasing = new TimedOutWorker();
  releasing.answerStart = true;
  const release = await holdFileAsync("unused", Date.now() + 1_000, () => releasing as unknown as Worker);
  assert.ok(release);
  await assert.rejects(release(Date.now() + 20), /did not answer before its deadline/);
  assert.deepEqual(releasing.sent, ["start", "release", "release"]);
  const exit = t.mock.method(process, "exit", (() => {
    throw new Error("a late successful release must make normal worker exit expected");
  }) as typeof process.exit);
  releasing.emit("message", { released: true });
  releasing.emit("exit", 0);
  assert.equal(exit.mock.callCount(), 0);
  assert.doesNotThrow(() => releasing.emit("error", new Error("late release failure")));
});

it("does not treat worker exit after confirmed release cleanup error as lock loss", async (t) => {
  const worker = new TimedOutWorker();
  worker.answerStart = true;
  const release = await holdFileAsync("lock", Date.now() + 1_000, () => worker as unknown as Worker);
  assert.notEqual(release, null);
  const exit = t.mock.method(process, "exit", (() => {
    throw new Error("confirmed release must make worker exit expected despite its cleanup error");
  }) as typeof process.exit);
  const releasing = release!();
  worker.emit("message", { released: true, releaseError: "exchange cleanup failed" });
  await assert.rejects(releasing, /exchange cleanup failed/);
  worker.emit("exit", 0);
  assert.equal(exit.mock.callCount(), 0);
});

it("fails closed if the lock worker exits before its first reply", async (t) => {
  const worker = new TimedOutWorker();
  const exit = t.mock.method(process, "exit", (() => undefined as never) as typeof process.exit);
  const pending = holdFileAsync("lock", Date.now() + 1_000, () => worker as unknown as Worker);
  await new Promise<void>((resolve) => setImmediate(resolve));
  worker.emit("exit", 1);
  await assert.rejects(pending, /stopped before answering/);
  assert.equal(exit.mock.callCount(), 1, "unacknowledged acquisition is treated as possible lock loss");
});

it("accepts a late refusal after acquisition timeout as a safe worker exit", async (t) => {
  const worker = new TimedOutWorker();
  await assert.rejects(holdFileAsync("lock", Date.now() + 20, () => worker as unknown as Worker), /did not answer before its deadline/);
  const exit = t.mock.method(process, "exit", (() => undefined as never) as typeof process.exit);
  worker.emit("message", { held: false });
  worker.emit("exit", 0);
  assert.equal(exit.mock.callCount(), 0);
});

it("answers cancellation received before asynchronous lock acquisition starts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vigile-prestart-cancel-"));
  const worker = new Worker(new URL("./lock-async.js", import.meta.url), { workerData: { file: join(directory, "lock"), deadline: Date.now() + 1_000 } });
  try {
    const answer = new Promise<unknown>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    worker.postMessage("cancel");
    assert.deepEqual(await answer, { held: false });
  } finally {
    await worker.terminate();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("fails closed if the acquired lock worker exits unexpectedly", async (t) => {
  const worker = new TimedOutWorker();
  worker.answerStart = true;
  const release = await holdFileAsync("unused", Date.now() + 1_000, () => worker as unknown as Worker);
  assert.ok(release);

  const exit = t.mock.method(process, "exit", (() => {
    throw new Error("service stopped without its lock");
  }) as typeof process.exit);
  assert.throws(() => worker.emit("exit", 1), /service stopped without its lock/);
  assert.equal(exit.mock.callCount(), 1);
});

it("does not treat a confirmed lock release as an unexpected worker exit", async (t) => {
  const worker = new TimedOutWorker();
  worker.answerStart = true;
  worker.answerRelease = true;
  const release = await holdFileAsync("unused", Date.now() + 1_000, () => worker as unknown as Worker);
  assert.ok(release);
  await release();

  const exit = t.mock.method(process, "exit", (() => {
    throw new Error("service should retain the released lock state");
  }) as typeof process.exit);
  worker.emit("exit", 0);
  assert.equal(exit.mock.callCount(), 0);
});
