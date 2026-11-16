import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { whereTo } from "./paths.js";
import { flushFolder, holdFile, holdFileAsync, type AsyncRelease } from "@vigile/storage-sqlite";
import { parse, stringify } from "smol-toml";
import { ConfigError, KEY_PREFIX, SETTINGS, findSetting, validateConfig, type Config } from "./schema.js";

export type Source = "default" | "file" | "environment" | "option";

export interface LoadedConfig {
  /** The absolute path of the config file. */
  path: string;
  config: Config;
  /** `data_dir` as the one name of the place it leads to: see `placeOf`. */
  dataDir: string;
  /** `backup.folder`, likewise. */
  backupDir: string;
  /** Where each setting's value came from. */
  sources: Record<string, Source>;
}

type Raw = Record<string, unknown>;

export const generateKey = (): string => `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;

function getPath(raw: Raw, key: string): unknown {
  let current: unknown = raw;
  for (const part of key.split(".")) {
    // Only what the data itself has: "constructor" is a name a user can have, and every object answers to it.
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, part)) return undefined;
    current = (current as Raw)[part];
  }
  return current;
}

function setPath(raw: Raw, key: string, value: unknown): void {
  const parts = key.split(".");
  let current = raw;
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(current, part) || typeof current[part] !== "object" || current[part] === null) current[part] = {};
    current = current[part] as Raw;
  }
  current[parts.at(-1)!] = value;
}

function deletePath(raw: Raw, key: string): void {
  const parts = key.split(".");
  let current: unknown = raw;
  for (const part of parts.slice(0, -1)) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, part)) return;
    current = (current as Raw)[part];
  }
  if (typeof current === "object" && current !== null) delete (current as Raw)[parts.at(-1)!];
}

/**
 * Says so when there is no config at the path, with how to make one. Asked before a change takes its lock: the
 * lock is a file beside the config, and where there is no config, nor even its folder, there is nothing to lock
 * and nothing to leave a lock file beside.
 */
function thereIsOne(path: string): void {
  if (!existsSync(path)) throw new ConfigError([`there is no config file here; create one with "vigile config init --config ${path}"`], path);
}

/** Reads the file as plain data, without defaults. A missing file is an error: there is no default location. */
export function readRaw(path: string): Raw {
  thereIsOne(path);
  try {
    return parse(readFileSync(path, "utf8")) as Raw;
  } catch (error) {
    throw new ConfigError([`is not valid TOML: ${(error as Error).message.split("\n")[0]}`], path);
  }
}

/**
 * Checks the data, then replaces the file in one step, readable by its owner only.
 * A config that fails the check is never written.
 */
export function writeRaw(path: string, raw: Raw, only: "replace" | "create" = "replace"): Config {
  const config = validateConfig(raw, path);
  mkdirSync(dirname(path), { recursive: true });
  // A config that is a link to a file kept elsewhere stays one: the file it points to is the one replaced.
  const target = existsSync(path) ? realpathSync(path) : path;
  const temporary = `${target}.${process.pid}.tmp`;
  // On the disk before it takes the file's place, and the folder after: a key that was confirmed to someone is
  // not lost to a power cut, and the file is never found empty.
  try {
    const handle = openSync(temporary, "w", 0o600);
    try {
      // All of it, however many writes that takes: a file cut short must never take the place of a whole one.
      writeFileSync(handle, stringify(raw) + "\n");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    chmodSync(temporary, 0o600);
    if (only === "create") {
      nameNew(temporary, target);
      rmSync(temporary, { force: true });
    } else {
      renameSync(temporary, target);
    }
  } catch (error) {
    // The unfinished file holds every key: it does not stay behind.
    rmSync(temporary, { force: true });
    throw error;
  }
  // The new file has the config's name only once its folder says so. Where that cannot be confirmed although
  // the system offers it, the change is in place, and is told apart from one that was not made at all.
  try {
    flushFolder(dirname(target));
  } catch (error) {
    throw new UnconfirmedWrite(config, (error as Error).message);
  }
  return config;
}

/**
 * Gives a finished file a name that nothing has yet, and fails when the name is taken: of two that create a
 * config at the same moment one is told that there is one already, where a rename would put the second over
 * the first, with its admin key. Never by a way that could write over a file:
 * - a second name for the finished file, which the system refuses when the name exists. The file is there whole
 *   or not at all;
 * - on a file system that has no second names, a new file created under the name, which the system also refuses
 *   when the name exists, with the content copied into it. Should that be cut short, what is left is a config
 *   that does not pass the check, and never one that was there before.
 */
export function nameNew(finished: string, target: string, link: (from: string, to: string) => void = linkSync): void {
  const taken = () => new ConfigError(["a config file already exists; it was left untouched"], target);
  try {
    return link(finished, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw taken();
  }
  let handle: number;
  try {
    handle = openSync(target, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw taken();
    throw error;
  }
  try {
    writeFileSync(handle, readFileSync(finished));
    fsyncSync(handle);
  } catch (error) {
    // The name was free and is this call's own: what could not be written whole does not keep it.
    rmSync(target, { force: true });
    throw error;
  } finally {
    closeSync(handle);
  }
}

/**
 * The config was replaced, and the system could not confirm that the new one will survive a power cut. Not the
 * same as a write that failed: what was written is what is read from now on, so whoever asked for it must be
 * told that it stands, and that it may not last.
 */
export class UnconfirmedWrite extends Error {
  constructor(
    readonly config: Config,
    message: string,
  ) {
    super(message);
    this.name = "UnconfirmedWrite";
  }
}

/** How long a change waits for another one to finish. */
const LOCK_WAIT_MS = 5000;
/** What the lock file beside a config is called: the config's own name with this after it. */
export const LOCK_SUFFIX = ".hold";

/**
 * Tries once to take the lock that makes reading, changing and writing the file one step. Returns what lets go
 * of it, or nothing when someone else has it. The lock is on a file beside the config and is held by the
 * operating system for as long as the holder lives: a holder that dies lets go by dying, so no one ever has to
 * judge whether a lock is stale and take it from someone who may still be at work.
 */
function tryLock(path: string): (() => void) | null {
  const lock = `${path}${LOCK_SUFFIX}`;
  try {
    return holdFile(lock);
  } catch (error) {
    // Something else under the lock's name says so itself, with what to do.
    if (/is not a lock file of Vigile/.test((error as Error).message)) throw error;
    // The lock is a file in the config's folder. Where it cannot be made or opened, the change cannot be made
    // either, and the reason is the folder, not the database the lock happens to be kept in.
    throw new Error(`${path} cannot be changed: the lock file ${lock}, which is made beside it, cannot be made or opened (${(error as Error).message}). Give this account write access to the folder of the config.`, { cause: error });
  }
}

/** The nonblocking form for a running service; the absolute deadline follows the helper wait. */
async function tryLockAsync(path: string, deadline: number): Promise<AsyncRelease | null> {
  const lock = `${path}${LOCK_SUFFIX}`;
  try {
    return await holdFileAsync(lock, deadline);
  } catch (error) {
    if (Date.now() >= deadline || (error as Error).message === "The asynchronous lock helper did not answer before its deadline.") return null;
    if (/is not a lock file of Vigile/.test((error as Error).message)) throw error;
    throw new Error(`${path} cannot be changed: the lock file ${lock}, which is made beside it, cannot be made or opened (${(error as Error).message}). Give this account write access to the folder of the config.`, { cause: error });
  }
}

/**
 * The file a config path leads to. A config may be a link to a file kept elsewhere, and two writers may reach
 * that file by different names: the lock and the change belong to the file itself, so that they meet.
 */
const whereItIs = (path: string): string => (existsSync(path) ? realpathSync(path) : path);

/** Another change to the config file is under way and did not finish in the time this one waited. The file is as it was. */
export class ConfigBusy extends Error {
  constructor(readonly path: string) {
    super(`${path}: another change to the config file is under way and does not finish.`);
    this.name = "ConfigBusy";
  }
}

const lockTimeout = (path: string) => new ConfigBusy(path);
const pause = () => 10 + Math.floor(Math.random() * 20);

/**
 * Reads the file, changes it and writes it back, as one step that no other change can fall into. The command
 * line and the running service both change this file: without this, each would write back what it had read,
 * and a key issued in between would be gone.
 */
function change(given: string, edit: (raw: Raw) => void, check?: (resulting: ResultingConfig) => void): Config {
  const path = whereItIs(given);
  thereIsOne(path);
  const end = Date.now() + LOCK_WAIT_MS;
  let release = tryLock(path);
  while (!release) {
    if (Date.now() > end) throw lockTimeout(path);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause());
    release = tryLock(path);
  }
  let written: Config | undefined;
  let failed: unknown;
  try {
    const raw = readRaw(path);
    edit(raw);
    // What the file would say once this is written, looked at as a whole before it is: a rule that spans
    // several settings is asked of the config that results, whichever of them the change is to. Asked under
    // the lock, so it is asked of what is then written.
    if (check) check(folders(resolve(given), validateConfig(raw, path)));
    written = writeRaw(path, raw);
  } catch (error) {
    failed = error;
  }
  try {
    release();
  } catch (error) {
    if (written) throw new UnconfirmedWrite(written, `The config was written, but its lock could not be confirmed released: ${(error as Error).message}`);
    if (failed instanceof UnconfirmedWrite) throw new UnconfirmedWrite(failed.config, `${failed.message} Its lock also could not be confirmed released: ${(error as Error).message}`);
    if (!failed) throw error;
  }
  if (failed) throw failed;
  return written!;
}

/** The same for the running service, which must go on answering while it waits its turn. */
async function changeWhileServing(given: string, edit: (raw: Raw) => void): Promise<Config> {
  const path = whereItIs(given);
  thereIsOne(path);
  const end = Date.now() + LOCK_WAIT_MS;
  let release = await tryLockAsync(path, end);
  while (!release) {
    if (Date.now() > end) throw lockTimeout(path);
    await new Promise((resolve) => setTimeout(resolve, pause()));
    release = await tryLockAsync(path, end);
  }
  let written: Config | undefined;
  let failed: unknown;
  try {
    const raw = readRaw(path);
    edit(raw);
    written = writeRaw(path, raw);
  } catch (error) {
    failed = error;
  }
  try {
    await release(Date.now() + LOCK_WAIT_MS);
  } catch (error) {
    if (written) throw new UnconfirmedWrite(written, `The config was written, but its lock could not be confirmed released: ${(error as Error).message}`);
    if (failed instanceof UnconfirmedWrite) throw new UnconfirmedWrite(failed.config, `${failed.message} Its lock also could not be confirmed released: ${(error as Error).message}`);
    if (!failed) throw error;
  }
  if (failed) throw failed;
  return written!;
}

/**
 * Whether a loaded config says nothing of a part of the settings: no setting of that part is written in the
 * file, set in the environment or given as an option. This is asked of where each value came from, never of
 * the value: a setting written out with the value it has by default is said, and one left out is not.
 */
export function saidNothingOf(loaded: Pick<LoadedConfig, "sources">, part: string): boolean {
  return SETTINGS.filter((setting) => setting.key === part || setting.key.startsWith(`${part}.`)).every((setting) => loaded.sources[setting.key] === "default");
}

/** A config with its folders worked out: relative ones start at the config file's folder. */
export type ResultingConfig = Pick<LoadedConfig, "path" | "config" | "dataDir" | "backupDir">;

function folders(absolute: string, config: Config): ResultingConfig {
  // Each folder as the one name of the place it leads to (`placeOf`), from here on and for everyone: whoever
  // shows it, checks it, makes it, locks it, writes to it or looks into it uses this name as it is. A relative
  // one starts at the config file's folder, and is walked from there as it is written, `..` and links included.
  // A path that leads nowhere, as one whose links go round in a circle, is no folder a config can have: it is
  // refused here, by its setting, and never made into some other path that could be written to.
  const fromConfig = (key: string, folder: string): string => {
    const led = whereTo(isAbsolute(folder) ? folder : `${dirname(absolute)}${sep}${folder}`);
    if (!led.ok) throw new ConfigError([`${key}: ${JSON.stringify(folder)} leads nowhere: ${led.cause}. Name a folder that the path leads to`], absolute);
    return led.place;
  };
  return { path: absolute, config, dataDir: fromConfig("data_dir", config.data_dir), backupDir: fromConfig("backup.folder", config.backup.folder) };
}

function parseValue(key: string, value: string): string | number | boolean {
  const setting = findSetting(key);
  if (!setting) {
    const hint = key.startsWith("auth.keys") ? ' API keys are managed with "vigile user".' : "";
    throw new ConfigError([`${key}: is not a setting.${hint} Settings: ${SETTINGS.map((s) => s.key).join(", ")}`]);
  }
  if (setting.type === "number") {
    if (!/^-?\d+$/.test(value.trim())) throw new ConfigError([`${key}: must be a whole number`]);
    return Number(value);
  }
  if (setting.type === "decimal") {
    if (!/^\d+(\.\d+)?$/.test(value.trim())) throw new ConfigError([`${key}: must be a number, such as 4 or 0.5`]);
    return Number(value);
  }
  if (setting.type === "boolean") {
    if (value !== "true" && value !== "false") throw new ConfigError([`${key}: must be true or false`]);
    return value === "true";
  }
  return value;
}

/**
 * Loads the file, then applies environment variables and command options on top.
 * Order, lowest to highest: defaults, file, environment, options.
 */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env, options: Record<string, string> = {}): LoadedConfig {
  const absolute = resolve(path);
  const raw = readRaw(absolute);
  const sources: Record<string, Source> = {};
  for (const setting of SETTINGS) sources[setting.key] = getPath(raw, setting.key) === undefined ? "default" : "file";
  for (const setting of SETTINGS) {
    const fromEnv = env[setting.env];
    if (fromEnv !== undefined) {
      setPath(raw, setting.key, parseValue(setting.key, fromEnv));
      sources[setting.key] = "environment";
    }
    const fromOption = options[setting.key];
    if (fromOption !== undefined) {
      setPath(raw, setting.key, parseValue(setting.key, fromOption));
      sources[setting.key] = "option";
    }
  }
  return { ...folders(absolute, validateConfig(raw, absolute)), sources };
}

/** `VIGILE_` variables that match no setting, which usually means a typo. */
export function unknownEnvironment(env: NodeJS.ProcessEnv = process.env): string[] {
  const known = new Set([...SETTINGS.map((s) => s.env), "VIGILE_CONFIG"]);
  return Object.keys(env)
    .filter((name) => name.startsWith("VIGILE_") && !known.has(name))
    .sort();
}

export interface InitOptions {
  name?: string;
  address?: string;
  port?: number;
}

/**
 * Writes a starter config with a fresh admin key. Refuses to overwrite an existing file. A `warning` says that
 * the file is written but could not be confirmed to survive a power cut: the key in it is the admin key all
 * the same, and is returned.
 */
export function initConfig(path: string, options: InitOptions = {}): { config: Config; adminKey: string; warning?: string } {
  const absolute = resolve(path);
  if (existsSync(absolute)) throw new ConfigError(["a config file already exists; it was left untouched"], absolute);
  if (lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new ConfigError(["is a link to a file that does not exist; remove the link, or create the config where it leads and point the link at it afterwards"], absolute);
  }
  const adminKey = generateKey();
  const raw: Raw = {
    name: options.name ?? "vigile",
    data_dir: "data",
    log_level: "info",
    listen: { address: options.address ?? "127.0.0.1", port: options.port ?? 8700 },
    auth: { keyless_user: "agent1", keys: { admin: adminKey } },
  };
  try {
    return { config: writeRaw(absolute, raw, "create"), adminKey };
  } catch (error) {
    if (!(error instanceof UnconfirmedWrite)) throw error;
    return { config: error.config, adminKey, warning: error.message };
  }
}

/**
 * Sets one value. `check` is given the config as it would be with the value set, before it is written, and
 * refuses it by throwing: nothing is written then.
 */
export function setValue(path: string, key: string, value: string, check?: (resulting: ResultingConfig) => void): Config {
  const parsed = parseValue(key, value);
  return change(path, (raw) => setPath(raw, key, parsed), check);
}

/** Removes one value, so that its default applies. `check` as for `setValue`: the config as it would be without the value. */
export function unsetValue(path: string, key: string, check?: (resulting: ResultingConfig) => void): Config {
  if (!findSetting(key)) parseValue(key, "");
  return change(path, (raw) => deletePath(raw, key), check);
}

const putKey = (username: string, key: string) => (raw: Raw) => setPath(raw, `auth.keys.${username}`, key);
const dropKey = (username: string) => (raw: Raw) => {
  deletePath(raw, `auth.keys.${username}`);
  if (getPath(raw, "auth.keyless_user") === username) setPath(raw, "auth.keyless_user", "");
};

export function setKey(path: string, username: string, key: string): Config {
  return change(path, putKey(username, key));
}

/** Removes a user's key. If that user was the keyless user, keyless connections are refused from then on. */
export function removeKey(path: string, username: string): Config {
  return change(path, dropKey(username));
}

/** `setKey` and `removeKey` for the running service: they wait their turn without holding everything else up. */
export const setKeyWhileServing = (path: string, username: string, key: string): Promise<Config> => changeWhileServing(path, putKey(username, key));
export const removeKeyWhileServing = (path: string, username: string): Promise<Config> => changeWhileServing(path, dropKey(username));

/** Whether anyone but the owner can read the file, which holds API keys. */
export function isTooOpen(path: string): boolean {
  return (statSync(path).mode & 0o077) !== 0;
}

/** The config as it can be shown: API keys masked. */
export function masked(config: Config): Config {
  const keys = Object.fromEntries(Object.entries(config.auth.keys).map(([user, key]) => [user, `${key.slice(0, 8)}…`]));
  return { ...config, auth: { ...config.auth, keys } };
}
