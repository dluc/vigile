import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { holdFile } from "@vigile/storage-sqlite";
import {
  ConfigBusy,
  ConfigError,
  LiveAuth,
  checkUsers,
  identify,
  initConfig,
  isTooOpen,
  keyOf,
  loadConfig,
  masked,
  nameNew,
  readRaw,
  removeKey,
  setKey,
  setKeyWhileServing,
  setValue,
  UnconfirmedWrite,
  unknownEnvironment,
  unsetValue,
  validateConfig,
  writeRaw,
} from "./index.js";

const KEY = "vig_0123456789abcdefghij";
const OTHER = "vig_zyxwvutsrqponmlkjihg";

let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "vigile-config-"));
  path = join(directory, "config.toml");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const issues = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected a ConfigError, got ${error}`);
    return error.issues;
  }
  assert.fail("expected the config to be refused");
};

describe("validation", () => {
  it("fills in defaults", () => {
    const config = validateConfig({ auth: { keys: { admin: KEY } } });
    assert.deepEqual(config, {
      name: "vigile",
      data_dir: "data",
      log_level: "info",
      listen: { address: "127.0.0.1", port: 8700 },
      auth: { keyless_user: "agent1", keys: { admin: KEY } },
    });
  });

  it("names every unknown setting", () => {
    const found = issues(() => validateConfig({ colour: "red", listen: { prot: 1 }, auth: { keys: { admin: KEY } } }));
    assert.deepEqual(found.sort(), ["colour: is not a setting", "listen.prot: is not a setting"]);
  });

  it("refuses bad values", () => {
    const base = { auth: { keys: { admin: KEY } } };
    assert.match(issues(() => validateConfig({ ...base, listen: { port: 70000 } }))[0]!, /^listen\.port:/);
    assert.match(issues(() => validateConfig({ ...base, listen: { port: "8700" } }))[0]!, /^listen\.port:/);
    assert.match(issues(() => validateConfig({ ...base, listen: { address: "not an address" } }))[0]!, /^listen\.address:/);
    assert.match(issues(() => validateConfig({ ...base, log_level: "loud" }))[0]!, /^log_level:/);
    assert.match(issues(() => validateConfig({ auth: { keys: { admin: "short" } } }))[0]!, /^auth\.keys\.admin:/);
    assert.match(issues(() => validateConfig({ auth: { keys: { admin: KEY, "Bad Name": OTHER } } }))[0]!, /^auth\.keys/);
  });

  it("requires an admin key, distinct keys, and a keyless user other than admin", () => {
    assert.match(issues(() => validateConfig({}))[0]!, /admin user must have an API key/);
    assert.match(issues(() => validateConfig({ auth: { keys: { admin: KEY, agent2: KEY } } }))[0]!, /same key as admin/);
    assert.match(issues(() => validateConfig({ auth: { keyless_user: "admin", keys: { admin: KEY } } }))[0]!, /cannot be the keyless user/);
    assert.equal(validateConfig({ auth: { keyless_user: "", keys: { admin: KEY } } }).auth.keyless_user, "");
  });

  it("checks that the users named in the config exist", () => {
    const config = validateConfig({ auth: { keyless_user: "agent9", keys: { admin: KEY, ghost: OTHER } } });
    assert.deepEqual(checkUsers(config, ["admin", "user", "agent1"]), [
      "auth.keys.ghost: there is no user called ghost",
      "auth.keyless_user: there is no user called agent9",
    ]);
    assert.deepEqual(checkUsers(validateConfig({ auth: { keys: { admin: KEY } } }), ["admin", "user", "agent1"]), []);
  });
});

describe("the file", () => {
  it("is created private, with a new admin key, and never overwritten", () => {
    const { config, adminKey } = initConfig(path, { name: "one", port: 8123 });
    assert.match(adminKey, /^vig_[A-Za-z0-9_-]{32}$/);
    assert.equal(config.auth.keys.admin, adminKey);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(isTooOpen(path), false);
    chmodSync(path, 0o644);
    assert.equal(isTooOpen(path), true);
    assert.match(issues(() => initConfig(path))[0]!, /already exists/);
    assert.equal(loadConfig(path, {}).config.auth.keys.admin, adminKey);
  });

  it("puts a new config in place only where there is none, also when another was created in the same moment", () => {
    const { adminKey } = initConfig(path);
    const before = readFileSync(path, "utf8");
    // The file came into being after the look that found none: giving the new one its name fails, and the first stays.
    assert.throws(() => writeRaw(path, { ...readRaw(path), name: "second" }, "create"), /a config file already exists; it was left untouched/);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(loadConfig(path, {}).config.auth.keys.admin, adminKey);
    assert.deepEqual(readdirSync(directory).filter((file) => file.endsWith(".tmp")), [], "and nothing unfinished is left");
  });

  it("never writes over a config when it creates one, also where the file system has no second names for a file", () => {
    const finished = join(directory, "finished.tmp");
    writeFileSync(finished, "whole\n");
    const noSecondNames = () => {
      throw Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" });
    };
    // The name is free: the file is created under it, with all of the content.
    nameNew(finished, path, noSecondNames);
    assert.equal(readFileSync(path, "utf8"), "whole\n");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    // The name was taken in the moment between: it is refused, and what is there stays, by either way.
    writeFileSync(finished, "another\n");
    for (const link of [noSecondNames, undefined]) {
      assert.throws(() => nameNew(finished, path, link), /a config file already exists; it was left untouched/);
      assert.equal(readFileSync(path, "utf8"), "whole\n");
    }
  });

  it("says of a link that leads nowhere that it is one, not that a config exists", () => {
    symlinkSync(join(directory, "kept-elsewhere.toml"), path);
    assert.throws(() => initConfig(path), /is a link to a file that does not exist/);
    assert.equal(lstatSync(path).isSymbolicLink(), true, "the link is left as it was");
    assert.deepEqual(readdirSync(directory), ["config.toml"], "and nothing was written beside it");
  });

  it("says which file cannot be changed, and why, when the lock beside it cannot be made", async () => {
    // Someone who may write anywhere, as root may, cannot see this happen.
    if (process.getuid?.() === 0) return;
    initConfig(path);
    const says = /config\.toml cannot be changed: the lock file .*config\.toml\.hold, which is made beside it, cannot be made or opened \(.+\)\. Give this account write access to the folder of the config\./;
    // The folder of the config cannot be written, so no lock can be made in it.
    chmodSync(directory, 0o500);
    try {
      assert.throws(() => setValue(path, "name", "x"), says);
      assert.throws(() => setKey(path, "agent2", OTHER), says);
      await assert.rejects(setKeyWhileServing(path, "agent2", OTHER), says);
    } finally {
      chmodSync(directory, 0o700);
    }
    // Something that cannot be a lock stands under its name: a folder.
    mkdirSync(`${path}.hold`);
    assert.throws(() => setValue(path, "name", "x"), says);
    rmSync(`${path}.hold`, { recursive: true });
    assert.equal(setValue(path, "name", "now").name, "now", "and with the folder writable again the change is made");
  });

  it("says that there is no config, and how to make one, when a change is asked of a path that has none", async () => {
    // In a folder that is there, and in one that is not: the answer is about the config, not about a lock.
    for (const missing of [join(directory, "config.toml"), join(directory, "no-such-folder", "config.toml")]) {
      const says = new RegExp(`there is no config file here; create one with "vigile config init --config ${missing.replaceAll(".", "\\.")}"`);
      assert.throws(() => setValue(missing, "name", "demo"), (error: unknown) => error instanceof ConfigError && says.test(error.message), missing);
      assert.throws(() => setKey(missing, "agent2", OTHER), says);
      await assert.rejects(setKeyWhileServing(missing, "agent2", OTHER), says);
    }
    assert.deepEqual(readdirSync(directory), [], "and nothing is left behind: no lock file, no folder");
  });

  it("has no default location: a missing file is an error that says how to create one", () => {
    assert.match(issues(() => loadConfig(path, {}))[0]!, /vigile config init/);
  });

  it("reports TOML that does not parse", () => {
    writeFileSync(path, "name = \n");
    assert.match(issues(() => loadConfig(path, {}))[0]!, /not valid TOML/);
  });

  it("resolves data_dir from the config file's folder", () => {
    initConfig(path);
    assert.equal(loadConfig(path, {}).dataDir, join(directory, "data"));
    setValue(path, "data_dir", "/var/lib/vigile");
    assert.equal(loadConfig(path, {}).dataDir, "/var/lib/vigile");
  });

  it("sets and unsets one value, and leaves the file untouched when the value is refused", () => {
    initConfig(path);
    assert.equal(setValue(path, "listen.port", "8701").listen.port, 8701);
    const before = readFileSync(path, "utf8");
    assert.match(issues(() => setValue(path, "listen.port", "99999"))[0]!, /^listen\.port:/);
    assert.match(issues(() => setValue(path, "listen.port", "eighty"))[0]!, /whole number/);
    assert.match(issues(() => setValue(path, "listen.prot", "1"))[0]!, /is not a setting/);
    assert.match(issues(() => setValue(path, "auth.keys.admin", KEY))[0]!, /managed with "vigile user"/);
    assert.match(issues(() => setValue(path, "auth.keyless_user", "admin"))[0]!, /cannot be the keyless user/);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(unsetValue(path, "listen.port").listen.port, 8700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it("applies environment variables over the file, and options over both", () => {
    initConfig(path, { port: 8100 });
    const fromFile = loadConfig(path, {});
    assert.deepEqual([fromFile.config.listen.port, fromFile.sources["listen.port"], fromFile.sources.log_level], [8100, "file", "file"]);
    const fromEnv = loadConfig(path, { VIGILE_LISTEN_PORT: "8200", VIGILE_NAME: "from-env" });
    assert.deepEqual([fromEnv.config.listen.port, fromEnv.sources["listen.port"], fromEnv.config.name], [8200, "environment", "from-env"]);
    const fromOption = loadConfig(path, { VIGILE_LISTEN_PORT: "8200" }, { "listen.port": "8300" });
    assert.deepEqual([fromOption.config.listen.port, fromOption.sources["listen.port"]], [8300, "option"]);
    assert.match(issues(() => loadConfig(path, { VIGILE_LISTEN_PORT: "many" }))[0]!, /whole number/);
    assert.equal(readFileSync(path, "utf8").includes("8200"), false, "overrides are never written back");
  });

  it("spots VIGILE_ variables that match no setting", () => {
    assert.deepEqual(unknownEnvironment({ VIGILE_CONFIG: "x", VIGILE_LISTEN_PORT: "1", VIGILE_PORT: "2", VIGILE_NAMES: "y", PATH: "/bin" }), ["VIGILE_NAMES", "VIGILE_PORT"]);
  });

  it("masks keys for display", () => {
    const { config, adminKey } = initConfig(path);
    const shown = JSON.stringify(masked(config));
    assert.equal(shown.includes(adminKey), false);
    assert.match(masked(config).auth.keys.admin!, /^vig_.{4}…$/);
  });

  it("adds and removes keys, clearing the keyless user when that user's key is removed", () => {
    initConfig(path);
    setKey(path, "agent2", OTHER);
    setValue(path, "auth.keyless_user", "agent2");
    const after = removeKey(path, "agent2");
    assert.equal(after.auth.keys.agent2, undefined);
    assert.equal(after.auth.keyless_user, "");
  });
});

describe("identity", () => {
  const auth = { keyless_user: "agent1", keys: { admin: KEY, agent2: OTHER } };

  it("finds the user a key belongs to", () => {
    assert.deepEqual(identify(auth, `Bearer ${KEY}`), { ok: true, username: "admin", keyless: false });
    assert.deepEqual(identify(auth, `bearer   ${OTHER} `), { ok: true, username: "agent2", keyless: false });
    assert.deepEqual(identify(auth, OTHER), { ok: true, username: "agent2", keyless: false });
  });

  it("treats no key as the keyless user, or refuses when there is none", () => {
    assert.deepEqual(identify(auth, undefined), { ok: true, username: "agent1", keyless: true });
    assert.deepEqual(identify({ ...auth, keyless_user: "" }, undefined), { ok: false, reason: "key_required" });
  });

  it("refuses a wrong key instead of falling back to the keyless user", () => {
    assert.deepEqual(identify(auth, "Bearer vig_wrongwrongwrongwrong"), { ok: false, reason: "invalid_key" });
    assert.deepEqual(identify(auth, `Bearer ${KEY}x`), { ok: false, reason: "invalid_key" });
  });
});

describe("live auth", () => {
  const touch = (offset: number) => utimesSync(path, new Date(), new Date(Date.now() + offset));

  it("issues and revokes keys in the file, and they apply at once", async () => {
    const { config, adminKey } = initConfig(path);
    const live = new LiveAuth(path, config.auth);
    const key = await live.issue("agent2");
    assert.deepEqual(live.identify(`Bearer ${key}`), { ok: true, username: "agent2", keyless: false });
    assert.equal(loadConfig(path, {}).config.auth.keys.agent2, key);
    const replaced = await live.issue("agent2");
    assert.equal(live.identify(`Bearer ${key}`).ok, false);
    assert.equal(live.identify(`Bearer ${replaced}`).ok, true);
    await live.revoke("agent2");
    assert.equal(live.identify(`Bearer ${replaced}`).ok, false);
    assert.equal(live.identify(`Bearer ${adminKey}`).ok, true);
  });

  it("picks up a change made to the file by someone else", () => {
    const { config } = initConfig(path);
    const live = new LiveAuth(path, config.auth);
    setKey(path, "agent2", OTHER);
    touch(5000);
    assert.deepEqual(live.identify(`Bearer ${OTHER}`), { ok: true, username: "agent2", keyless: false });
  });

  it("hands over a key that is in the file although the folder would not be flushed, and says that it may not last", async () => {
    // Someone who may read anywhere, as root may, cannot see this happen.
    if (process.getuid?.() === 0) return;
    const { config } = initConfig(path);
    const problems: string[] = [];
    const live = new LiveAuth(path, config.auth, (message) => problems.push(message));
    // A folder that can be written to and not opened for reading: the config is replaced, the flush after it fails.
    chmodSync(directory, 0o300);
    let warning: string | undefined;
    const key = live.create();
    try {
      warning = await live.put("agent2", key);
    } finally {
      chmodSync(directory, 0o700);
    }
    assert.match(warning ?? "", /is in place, but the system could not confirm that it will survive a power cut/);
    assert.deepEqual(live.identify(`Bearer ${key}`), { ok: true, username: "agent2", keyless: false }, "the key works: it is in the file");
    assert.equal(loadConfig(path, {}).config.auth.keys.agent2, key);
    assert.equal(problems.length, 1, "and the service's log has it too");
    // A log that cannot be written does not turn a key that is in place into one that was not stored.
    const mute = new LiveAuth(path, config.auth, () => {
      throw new Error("ENOSPC: the log is full");
    });
    chmodSync(directory, 0o300);
    const other = mute.create();
    try {
      assert.match((await mute.put("agent3", other)) ?? "", /could not confirm that it will survive a power cut/);
    } finally {
      chmodSync(directory, 0o700);
    }
    assert.deepEqual(mute.identify(`Bearer ${other}`), { ok: true, username: "agent3", keyless: false });
    // Nor does it turn a broken edit of the file into a request that fails: the last settings that passed stay.
    const whole = readFileSync(path, "utf8");
    writeFileSync(path, "this is = not [valid");
    assert.deepEqual(mute.identify(`Bearer ${other}`), { ok: true, username: "agent3", keyless: false });
    writeFileSync(path, whole);
    // The same for a change from the command line: it is in place, and the command says that it could not make sure.
    chmodSync(directory, 0o300);
    try {
      assert.throws(() => setValue(path, "name", "unconfirmed"), UnconfirmedWrite);
    } finally {
      chmodSync(directory, 0o700);
    }
    assert.equal(loadConfig(path, {}).config.name, "unconfirmed");
  });

  it("has no key for a user whose name every object answers to, until one is stored", async () => {
    const { config } = initConfig(path);
    const live = new LiveAuth(path, config.auth);
    // "constructor" is a name a user can have. Nothing is stored for it, and nothing is what is found.
    assert.equal(live.stored("constructor"), undefined);
    assert.equal(keyOf(config.auth, "constructor"), undefined);
    assert.equal(keyOf(config.auth, "admin"), config.auth.keys.admin);
    const key = await live.issue("constructor");
    assert.equal(live.stored("constructor"), key);
    assert.deepEqual(live.identify(`Bearer ${key}`), { ok: true, username: "constructor", keyless: false });
    await live.revoke("constructor");
    assert.equal(live.stored("constructor"), undefined);
    assert.equal(loadConfig(path, {}).config.auth.keys.admin, config.auth.keys.admin, "and the rest of the file is as it was");
  });

  it("reads the file at its first look: what changed between the start reading the config and the service taking it up counts", () => {
    const { config } = initConfig(path);
    // The start has read the config. Before the service is up, the command line turns connections without a key off.
    setValue(path, "auth.keyless_user", "");
    const live = new LiveAuth(path, config.auth);
    assert.deepEqual(live.identify(undefined), { ok: false, reason: "key_required" });
  });

  it("takes up a change that someone else makes right after its own, before it has got back to its work", async () => {
    const { config } = initConfig(path);
    const live = new LiveAuth(path, config.auth);
    assert.equal(live.identify(undefined).ok, true, "connections without a key are let in, as a new config has it");
    // The service's change is written by the time this call returns; what follows it in the service has not run yet.
    const own = live.put("agent2", OTHER);
    // In that moment the command line turns connections without a key off, and replaces the admin key.
    setValue(path, "auth.keyless_user", "");
    setKey(path, "admin", KEY);
    await own;
    assert.deepEqual(live.identify(undefined), { ok: false, reason: "key_required" }, "what the command line wrote holds, not what the service's own change returned");
    assert.equal(live.identify(`Bearer ${config.auth.keys.admin}`).ok, false, "the admin key that was replaced is refused");
    assert.deepEqual(live.identify(`Bearer ${KEY}`), { ok: true, username: "admin", keyless: false });
    assert.deepEqual(live.identify(`Bearer ${OTHER}`), { ok: true, username: "agent2", keyless: false }, "and the service's own change is there too");
  });

  it("keeps what the run was started with when the file is read again", async () => {
    // The file lets agent1 in without a key; this run was started to want a key from everyone.
    const { config } = initConfig(path);
    assert.equal(config.auth.keyless_user, "agent1");
    const live = new LiveAuth(path, { ...config.auth, keyless_user: "" }, () => {}, { keyless_user: "" });
    assert.deepEqual(live.identify(undefined), { ok: false, reason: "key_required" });
    // A key is issued, one is revoked, and someone else changes the file: each reads the file again.
    const key = await live.issue("agent2");
    assert.deepEqual(live.identify(undefined), { ok: false, reason: "key_required" }, "after a key was issued");
    assert.equal(live.identify(`Bearer ${key}`).ok, true);
    await live.revoke("agent2");
    assert.deepEqual(live.identify(undefined), { ok: false, reason: "key_required" }, "after a key was revoked");
    setKey(path, "agent2", OTHER);
    touch(5000);
    assert.deepEqual(live.identify(undefined), { ok: false, reason: "key_required" }, "after the file changed");
    assert.equal(live.identify(`Bearer ${OTHER}`).ok, true, "while the rest of the file does apply");
    assert.equal(live.current().keyless_user, "");
  });

  it("keeps the last good settings when the file stops passing the check, and says so once", () => {
    const { config, adminKey } = initConfig(path);
    const problems: string[] = [];
    const live = new LiveAuth(path, config.auth, (message) => problems.push(message));
    writeFileSync(path, "this is not = = toml");
    touch(5000);
    assert.equal(live.identify(`Bearer ${adminKey}`).ok, true);
    assert.equal(live.identify(undefined).ok, true);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /keeping the previous auth settings/);
  });
});

describe("changes to the file from several places", () => {
  it("keeps every change when the command line and the service write at the same moment", async () => {
    initConfig(path);
    const index = fileURLToPath(new URL("./index.js", import.meta.url));
    // Six writers at once, each a process of its own, as the command line beside the running service is.
    const writer = (name: string, body: string) =>
      new Promise<void>((resolve, reject) => {
        const script = `import(${JSON.stringify(index)}).then(async (config) => { ${body} });`;
        execFile(process.execPath, ["-e", script], (error, _out, err) => (error ? reject(new Error(`${name}: ${err}`)) : resolve()));
      });
    const key = (who: number, n: number) => `vig_writer${who}key${String(n).padStart(4, "0")}abcdefgh`;
    // Some of them reach the file by another name, through a link: they still wait for the others.
    const link = join(directory, "by-another-name.toml");
    symlinkSync(path, link);
    await Promise.all([
      ...[0, 1, 2].map((who) => writer(`keys ${who}`, `for (let n = 0; n < 12; n++) config.setKey(${JSON.stringify(path)}, "user${who}x" + n, "vig_writer${who}key" + String(n).padStart(4, "0") + "abcdefgh");`)),
      // One of them as the running service changes it, waiting its turn without stopping.
      writer("service", `for (let n = 0; n < 12; n++) await config.setKeyWhileServing(${JSON.stringify(link)}, "user3x" + n, "vig_writer3key" + String(n).padStart(4, "0") + "abcdefgh");`),
      writer("name", `for (let n = 0; n < 12; n++) config.setValue(${JSON.stringify(link)}, "name", "name" + n);`),
      writer("level", `for (let n = 0; n < 12; n++) config.setValue(${JSON.stringify(path)}, "log_level", n % 2 ? "quiet" : "debug");`),
    ]);
    const { config } = loadConfig(path, {});
    for (const who of [0, 1, 2, 3]) for (let n = 0; n < 12; n++) assert.equal(config.auth.keys[`user${who}x${n}`], key(who, n), `the key of user${who}x${n}`);
    assert.equal(Object.keys(config.auth.keys).length, 49);
    assert.equal(config.name, "name11");
    assert.deepEqual(readdirSync(directory).filter((file) => file.endsWith(".tmp")), [], "no unfinished file is left behind");
    assert.equal(existsSync(`${link}.hold`), false, "and no lock was ever made under the other name: the lock is the file's own");
    assert.equal(existsSync(`${path}.hold`), true);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
  });

  it("is not kept out by a lock file that was left behind, whenever it is from, nor by one of an earlier kind", () => {
    initConfig(path);
    // The lock is held by the system for as long as its holder lives. A file that is merely there holds nothing:
    // one left by a process that died, or one dated in the future.
    for (const [name, offset] of [["after", -60_000], ["later", 3600_000]] as const) {
      writeFileSync(`${path}.hold`, "");
      utimesSync(`${path}.hold`, new Date(Date.now() + offset), new Date(Date.now() + offset));
      assert.equal(setValue(path, "name", name).name, name);
    }
    // A lock file as an earlier version wrote it, under the name it had then, is nothing to this one.
    writeFileSync(`${path}.lock`, "999999.dead");
    assert.equal(setValue(path, "name", "beside").name, "beside");
    assert.deepEqual(readdirSync(directory).filter((file) => file.endsWith(".tmp")), []);
  });

  it("does not take apart something else that stands where its lock belongs, and says what to do", () => {
    initConfig(path);
    // Two who each put such a file out of the way at the same moment could both end up holding a lock of their own.
    writeFileSync(`${path}.hold`, "this is not a lock");
    assert.throws(() => setValue(path, "name", "never"), /config\.toml\.hold is not a lock file of Vigile\. Remove it while no vigile command and no service is running/);
    assert.equal(readFileSync(`${path}.hold`, "utf8"), "this is not a lock", "it is left as it was");
    assert.equal(loadConfig(path, {}).config.name, "vigile");
    rmSync(`${path}.hold`);
    assert.equal(setValue(path, "name", "now").name, "now");
  });

  it("waits for a change that is under way, says so when it does not finish, and goes ahead once it has", async () => {
    initConfig(path);
    // Someone holds the lock right now, as a change that is under way does.
    const release = holdFile(`${path}.hold`);
    assert.ok(release);
    const began = Date.now();
    let turns = 0;
    const pulse = setInterval(() => turns++, 5);
    try {
      await assert.rejects(setKeyWhileServing(path, "agent2", OTHER), /another change to the config file is under way/);
    } finally {
      clearInterval(pulse);
    }
    assert.ok(Date.now() - began >= 4500, "it waited for its turn first");
    assert.ok(turns > 100, `the running service kept its event loop while waiting: ${turns} turns`);
    assert.equal(loadConfig(path, {}).config.auth.keys.agent2, undefined);
    // Not a config that is wrong: one that is busy, and as it was.
    assert.throws(() => setValue(path, "name", "meanwhile"), (error: unknown) => error instanceof ConfigBusy && !(error instanceof ConfigError) && /another change to the config file is under way/.test(error.message));
    release();
    assert.equal((await setKeyWhileServing(path, "agent2", OTHER)).auth.keys.agent2, OTHER);
  });

  it("writes through a link to a file kept elsewhere, and leaves the link a link", () => {
    const real = join(directory, "kept-elsewhere.toml");
    initConfig(real);
    symlinkSync(real, path);
    setValue(path, "name", "linked");
    setKey(path, "agent2", OTHER);
    assert.equal(lstatSync(path).isSymbolicLink(), true);
    assert.equal(loadConfig(real, {}).config.name, "linked");
    assert.equal(loadConfig(real, {}).config.auth.keys.agent2, OTHER);
    assert.equal(statSync(real).mode & 0o777, 0o600);
  });
});
