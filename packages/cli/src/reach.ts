import { lookup } from "node:dns/promises";
import { accessSync, constants, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { LoadedConfig } from "@vigile/config";
import { folderIsHeld, holdFolder } from "@vigile/storage-sqlite";
import { ANSWER_WITHIN_MS, NoAnswerError, NotRunningError, baseUrl, clientFor, howItFailed, noAnswer, type ServiceClient } from "./client.js";
import { printable } from "./render.js";
import { LOCK_FILE, earlierService, isLoopback } from "./service.js";

/**
 * The service of this config was not reached, and there is more to say than that nothing answers: something
 * else has the address, what is there does not answer as the service of this config would, or nothing answers
 * while a process holds the data. Nothing was sent but a question that carries no key.
 * This is not a service that is not running, and is not a kind of `NotRunningError`: code that acts in the
 * service's place when none runs must not take this for that. What is done in the service's place is done through
 * `inTheServicesPlace`, which takes the data folder for as long as it takes.
 */
export class NotReachedError extends Error {
  constructor(
    readonly base: string,
    message: string,
    readonly hints: string[],
    /** What a script is told: that nothing of this config answers, or that another thing answers in its place. */
    readonly code: "not_running" | "not_this_service",
  ) {
    super(message);
    this.name = "NotReachedError";
  }
}

/** A Vigile service says who it is in a hundred characters or so. What goes on beyond this is not one. */
const LONGEST_ANSWER = 16 * 1024;

type Health = { is: "nothing" } | { is: "silent"; how: "not in time" | "ended first" } | { is: "other"; how: string } | { is: "vigile"; name: string; version: string };

/** A word that whatever answers chose, as one short line that steers no terminal. */
const shown = (text: string): string => printable(text).replace(/\s+/g, " ").slice(0, 80);

/**
 * Asks what is at the address who it is, without a key. Whatever comes back is taken for nothing more than it
 * is: an answer that is not JSON, that has another shape, that sends the caller elsewhere or that never ends
 * is the answer of something else.
 */
async function askHealth(base: string, waitMs: number): Promise<Health> {
  let text = "";
  try {
    // A redirect is not followed: where it leads is not the address the config names.
    const response = await fetch(`${base}/health`, { redirect: "manual", signal: AbortSignal.timeout(waitMs) });
    if (response.status !== 200) {
      const onward = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      await response.body?.cancel().catch(() => {});
      return { is: "other", how: onward ? `it sends GET /health on to ${shown(onward)}` : `it answers GET /health with status ${response.status}` };
    }
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    for (;;) {
      const part = await reader?.read();
      if (!part || part.done) break;
      size += part.value.length;
      if (size > LONGEST_ANSWER) {
        await reader?.cancel().catch(() => {});
        return { is: "other", how: "its answer to GET /health goes on where that of a Vigile service ends" };
      }
      text += decoder.decode(part.value, { stream: true });
    }
  } catch (error) {
    // Read as every request of the command line is: no connection was to be had, what answered did not speak
    // HTTP, or a connection was there and the answer did not come.
    const how = howItFailed(error);
    if (how === "never connected") return { is: "nothing" };
    if (how === "not HTTP") return { is: "other", how: "its answer to GET /health is not HTTP" };
    return { is: "silent", how };
  }
  let said: unknown;
  try {
    said = JSON.parse(text);
  } catch {
    return { is: "other", how: "its answer to GET /health is not JSON" };
  }
  const health = said as { status?: unknown; name?: unknown; version?: unknown } | null;
  if (typeof health !== "object" || health === null || health.status !== "ok" || typeof health.name !== "string" || typeof health.version !== "string") {
    return { is: "other", how: "its answer to GET /health is not the one a Vigile service gives" };
  }
  return { is: "vigile", name: health.name, version: health.version };
}

/** An IP address written the one way it has, so that two spellings of one address are equal. */
function written(address: string): string {
  const plain = address.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (isIP(plain) !== 6) return plain;
  try {
    const short = new URL(`http://[${plain}]`).hostname.slice(1, -1);
    // An IPv4 address inside an IPv6 one is that IPv4 address.
    const inside = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(short);
    if (!inside) return short;
    const high = parseInt(inside[1]!, 16);
    const low = parseInt(inside[2]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  } catch {
    return plain;
  }
}

/** Whether an IP address is one of this machine's: every address, this machine talking to itself, or an address of one of its interfaces. */
function isMine(address: string): boolean {
  const ip = written(address);
  if (ip === "0.0.0.0" || ip === "::" || isLoopback(ip)) return true;
  return Object.values(networkInterfaces()).some((list) => (list ?? []).some((entry) => written(entry.address) === ip));
}

/**
 * Whether the address the config names is on this machine, so that a program on this machine could listen
 * there. A name is asked of the system, as the connection will ask it. A name that leads nowhere cannot be
 * reached either; it is taken for this machine, which is the careful side.
 */
export async function onThisMachine(address: string, whenNotFound = true): Promise<boolean> {
  if (isLoopback(address)) return true;
  const plain = address.trim().replace(/^\[|\]$/g, "");
  if (isIP(plain) !== 0) return isMine(plain);
  try {
    const found = await lookup(plain, { all: true });
    return found.length === 0 ? whenNotFound : found.some((entry) => isMine(entry.address));
  } catch {
    return whenNotFound;
  }
}

/**
 * Whether a service runs on the data of this config: a live process holds the data folder, which the system
 * says and no file does. In a folder that was never held that way, a service from before may run. When the
 * folder cannot be looked into, that is said: it is not the same as nobody holding it.
 */
function serviceHolds(dataDir: string): { held: boolean; unknown?: string } {
  try {
    accessSync(dataDir, constants.R_OK | constants.X_OK);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { held: false } : { held: false, unknown: (error as Error).message };
  }
  try {
    return { held: folderIsHeld(dataDir) || earlierService(dataDir) !== null };
  } catch (error) {
    return { held: false, unknown: (error as Error).message };
  }
}

/** The service of this config, as it names itself; or why it was not reached: nothing answers at all, or something that is not taken for it. */
export type Reached =
  | { ok: true; name: string; version: string }
  | { ok: false; why: "nothing"; error: NotRunningError | NotReachedError }
  | { ok: false; why: "silent"; error: NoAnswerError | NotReachedError }
  | { ok: false; why: "other"; error: NotReachedError };

/**
 * Finds out whether what answers at the config's address is the service of this config, before anything is
 * sent there. The command line takes its keys from the config file, and the address alone proves nothing:
 * while the service is down, any program on this machine can listen on its port, and would be handed the admin
 * key by the next command. So two things are asked first, and neither with a key. A service runs on this
 * config's data: a live process holds the data folder. And what answers is a Vigile service that goes by the
 * name this config gives its service.
 * An address of another machine is one that no program on this machine can listen on, and there is no data
 * folder here to look at: the answer is then all there is to go by.
 */
export async function whoAnswers(loaded: LoadedConfig, waitMs = ANSWER_WITHIN_MS, local: (address: string) => Promise<boolean> = onThisMachine): Promise<Reached> {
  const { config, dataDir, path } = loaded;
  const base = baseUrl(loaded);
  const here = await local(config.listen.address);
  const holds = here ? serviceHolds(dataDir) : { held: false };
  const health = await askHealth(base, waitMs);
  const not = (message: string, hints: string[], code: "not_running" | "not_this_service"): NotReachedError => new NotReachedError(base, message, hints, code);
  const other = (...told: Parameters<typeof not>): Reached => ({ ok: false, why: "other", error: not(...told) });
  const unsent = "Nothing was sent to it, and no key.";

  if (health.is === "nothing") {
    // Nothing answers, and nothing holds the data here, or the data is another machine's to hold: the service is
    // not there. While a process holds the data, or that cannot be told, a service may well run, at another
    // address than the config names or not listening yet: that is said, and is not a service that is not running.
    if (!here || (!holds.held && holds.unknown === undefined)) return { ok: false, why: "nothing", error: new NotRunningError(base) };
    return {
      ok: false,
      why: "nothing",
      error: not(
        holds.held
          ? `No Vigile service answers at ${base}, and a process holds the data folder ${dataDir}: the service of this config runs at another address than the config names, or has not begun to listen.`
          : `No Vigile service answers at ${base}, and whether one runs on this config's data cannot be told: the data folder ${dataDir} cannot be looked into (${holds.unknown}).`,
        holds.held
          ? [`vigile doctor --config ${path} says which process holds the folder.`, "Run this command with the settings the service was started with (VIGILE_LISTEN_PORT, VIGILE_LISTEN_ADDRESS), or stop the service and start it again on this config."]
          : ["Run the command from the account that runs the service, which can read the data folder."],
        "not_running",
      ),
    };
  }
  if (here && !holds.held) {
    const what =
      health.is === "vigile" ? `A Vigile service that calls itself "${shown(health.name)}" answers` : health.is === "silent" ? "Something takes the connection and does not answer" : "Something that is not a Vigile service answers";
    const error =
      holds.unknown !== undefined
        ? not(
            `${what} at ${base}, and whether it is the service of this config cannot be told: the data folder ${dataDir} cannot be looked into (${holds.unknown}). ${unsent}`,
            ["Run the command from the account that runs the service, which can read the data folder."],
            "not_this_service",
          )
        : not(
            `${what} at ${base}, and it is not the service of this config: no service holds the data folder ${dataDir}. ${unsent}`,
            [
              // A service that was started on another data folder is, to a command that goes by the config, a service of other data.
              ...(health.is === "vigile"
                ? ["If it is this config's service, it runs on another data folder: data_dir was changed after it started, or given for one run (serve --data_dir, VIGILE_DATA_DIR). Stop it and start it again, or run this command with the same VIGILE_DATA_DIR."]
                : []),
              `${health.is === "vigile" ? "If not, stop" : "Stop"} the program that has the port, or choose another port: vigile config set listen.port <port>`,
              `Then start the service: vigile serve --config ${path}`,
            ],
            "not_running",
          );
    return health.is === "silent" ? { ok: false, why: "silent", error } : { ok: false, why: "other", error };
  }
  if (health.is === "silent") {
    // The service of this config runs, here where it holds its data or on the machine the config names, and what
    // has its address took the connection and gave no answer: said as of any request that gets none, with the
    // exit code that has. Nothing was asked of it but who it is, so nothing can have been changed.
    return { ok: false, why: "silent", error: new NoAnswerError(base, `${noAnswer(base, health.how, waitMs)} It was asked who it is, and nothing else was sent to it.`, false) };
  }
  if (health.is === "other") {
    return other(
      `What answers at ${base} is not a Vigile service: ${health.how}. ${unsent}`,
      here
        ? [
            "The service of this config is running, so it listens somewhere else: it was started with another address or port (an option of serve, or VIGILE_LISTEN_PORT), or the config was changed since.",
            "Stop it and start it again on this config.",
          ]
        : ["Check listen.address and listen.port: vigile config show"],
      "not_this_service",
    );
  }
  if (health.name !== config.name) {
    return other(
      `The Vigile service at ${base} calls itself "${shown(health.name)}", and this config calls its service "${config.name}". ${unsent}`,
      [
        "If the name was changed after the service started (vigile config set name), or given for one run (serve --name, VIGILE_NAME), stop the service and start it again, or run this command with the same VIGILE_NAME.",
        "If not, another instance has the port: give each its own listen.port.",
      ],
      "not_this_service",
    );
  }
  return { ok: true, name: health.name, version: health.version };
}

/**
 * A client that acts as a user of this instance, once what answers at its address is known to be its service.
 * Every command that calls the service gets its client here, so that no key leaves for anything else.
 */
export async function connect(loaded: LoadedConfig, as = "admin", answerWithinMs = ANSWER_WITHIN_MS): Promise<ServiceClient> {
  // Whether the config has a key for the user is said first: it needs no service.
  const client = clientFor(loaded, as, answerWithinMs);
  // Who is there is given the time that every answer is given.
  const reached = await whoAnswers(loaded, answerWithinMs);
  if (!reached.ok) throw reached.error;
  return client;
}

/**
 * Does, in the service's place, what the command line would otherwise ask of it: writes a key, or a setting that
 * the service would check. That is done in one case only, and for as long as it is done the case has to hold: no
 * service runs on the data of this config. So the command line does not look whether the data folder's lock is
 * free. It takes it, as the service does at its start, does what it does with the lock held, and lets go. A
 * service that is started meanwhile is refused as by any other holder, and starts once the command is done, on
 * what the command wrote.
 *
 * It is done only after a call that failed with nothing sent to anyone (nothing answered, or what answered was
 * not taken for the service), and only where the address is this machine's: the lock of a folder here says
 * nothing of a service on another machine. A service from before the folder was held by a lock of the system is
 * not kept out by that lock: it is looked for first, as the service's own start does. If the lock is not to be
 * had, a process holds the data, and nothing is written. Everything else that is not "no service runs here", a
 * name that does not match, a service that does not answer, is never passed to this: it is thrown on as it is.
 *
 * The order of the locks. The data folder's lock is taken first, and the lock of the config file second, inside
 * `act`, by the write itself. That is the order of the service too: it holds the folder for as long as it runs,
 * and takes the config file's lock for each of its own writes. Nothing takes the config file's lock and then
 * waits for the folder: a command that only writes the config never takes the folder, and the folder is never
 * waited for, it is had within a moment or the command is refused. So no two can wait for each other. The one
 * wait there is, for the config file, ends by itself: the write gives up after a few seconds.
 *
 * The lock is let go in every outcome: when the write fails, here; when the process is ended, by the system,
 * which holds the lock for the process and for no longer. What is left behind is what a first start of the
 * service leaves: the data folder, if it was not there, and the two empty files its lock and parent guard use. A folder that only a
 * service from before the locks has worked in is thereby held the new way from now on, as after a start of the
 * service or a restore, both of which look for such a service first as this does.
 *
 * `taken` is for the tests: it is called with the lock held, before anything is written.
 */
export async function inTheServicesPlace<T>(loaded: LoadedConfig, error: unknown, act: () => T, taken?: () => unknown): Promise<T> {
  if (!(error instanceof NotRunningError) && !(error instanceof NotReachedError)) throw error;
  // A name that leads nowhere is not known to be this machine: here that is the careful side.
  if (!(await onThisMachine(loaded.config.listen.address, false))) throw error;
  const { dataDir, path } = loaded;
  const not = (message: string, hints: string[]): NotReachedError => new NotReachedError(baseUrl(loaded), `${message} Nothing was written in the service's place.`, hints, "not_running");
  const cannot = (why: unknown): NotReachedError =>
    not(`Whether a service runs on this config's data cannot be told: the data folder ${dataDir} cannot be taken (${(why as Error).message}).`, ["Run the command from the account that runs the service, which can read and write the data folder."]);
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch (why) {
    throw cannot(why);
  }
  const earlier = earlierService(dataDir);
  if (earlier) {
    throw not(`A Vigile service from before this version may be using ${dataDir} (process ${earlier}).`, [
      "Stop that service first.",
      `If no such service is running, the file ${join(dataDir, LOCK_FILE)} was left behind by one that was killed: remove it.`,
    ]);
  }
  let release: (() => void) | null;
  try {
    release = holdFolder(dataDir);
  } catch (why) {
    throw cannot(why);
  }
  if (!release) {
    // What answered and was not taken for the service, while a process held the data, has said the more of it.
    if (error instanceof NotReachedError && error.code === "not_this_service") throw error;
    throw not(`A process holds the data folder ${dataDir}: the service of this config runs at another address than the config names or is starting, or a backup is being restored.`, [
      `vigile doctor --config ${path} says what holds the folder.`,
      "If it is the service, run this command with the settings it was started with (VIGILE_LISTEN_PORT, VIGILE_LISTEN_ADDRESS), or stop it and start it again on this config.",
    ]);
  }
  try {
    await taken?.();
    return act();
  } finally {
    release();
  }
}
