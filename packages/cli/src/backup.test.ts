import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, realpathSync, mkdtempSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { NoPlace, createPlainFile, initConfig, loadConfig, placeOf, samePlace, setValue, unsetValue, whereTo } from "@vigile/config";
import { backupTenantFile, holdFile, holdFolder, holdTenantFiles, inspectTenantFile, readTenantFile } from "@vigile/storage-sqlite";
import { UsageError, parseArgs } from "./args.js";
import { BACKUP_TIMES, REMEMBERED_MOST, decodeRemembered, encodeRemembered, isRemembered, rememberedWait, shortened, standing, startBackups, type BackupMemory, type BackupOutcome, type BackupSource, type Remembered } from "./backup-schedule.js";

/** The names of the fields of what a service keeps of its last backup, as it writes them. */
const FIELD_NAMES = ["actions", "at", "ended", "folder", "kind", "said", "version"];
import { BACKUPS_LOCK, BackupRefused, MEMORY_FILE, automaticBackups, backupMemory, backupOperationLock, clearLeftovers, designateBackupFolder, newestWhole, placeRefusal, prepareBackupFolder, prepareCopies, settleCopies, sqliteBackups, takeBackup, type BackupHooks, type BackupPoint } from "./backup.js";
import { config as configCommand } from "./commands/config.js";
import { doctor } from "./commands/doctor.js";
import { StartupError, startService, type Service } from "./service.js";
import type { Ui } from "./ui.js";

// Files are made as an account makes them that lets others read what it writes: that a backup is readable by
// its owner only is then the doing of the code that writes it.
process.umask(0o022);

const BIN = fileURLToPath(new URL("./bin.js", import.meta.url));
const HOUR = 3_600_000;
const MINUTE = 60_000;
/**
 * The moment the clock of a test starts at. The service goes by the clock the test gives it; where the clock of
 * the machine has a say as well, as in what the doctor and the first lines of serve work out, the test starts
 * its clock from the machine's instead, so that no test depends on what day it is run.
 */
const START = Date.parse("2026-11-13T09:00:00.000Z");
const iso = (moment: number): string => new Date(moment).toISOString();

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH ?? "" }, timeout: 30_000 }, (error, out, err) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out, err });
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/** An instance in a folder of its own, with a clock the test moves. */
interface Instance {
  directory: string;
  config: string;
  data: string;
  /** Where its automatic backups go unless the config says otherwise. */
  backups: string;
  /** The clock of the machine, which the test also sets, and the clock that only goes forward. */
  clock: { now: number; mono: number };
  warnings: string[];
  logged: string[];
  service: Service;
  /** Starts the service on what is in the folder. The timers of the schedule never fire unless other times are given: the test looks at the clock itself. */
  start(times?: Partial<typeof BACKUP_TIMES>, hooks?: BackupHooks, environment?: NodeJS.ProcessEnv, options?: Record<string, string>): Promise<Service>;
  /** The names of the automatic backups in a folder, oldest first. */
  automatic(folder?: string): string[];
  /** Lets time pass and has the service look at its clocks. */
  pass(ms: number): Promise<void>;
  post(path: string, body: unknown): Promise<any>;
  /** What the doctor says, as JSON. */
  doctor(): Promise<{ failed: number; checks: Array<{ section: string; title: string; level: string; detail?: string; fix?: string }> }>;
  remove(): Promise<void>;
}

const instances: Instance[] = [];
after(async () => {
  for (const instance of instances) await instance.remove();
});

async function instance(settings: Record<string, string> = {}): Promise<Instance> {
  // By the name the system has for it: where the folder for temporary files is itself reached through a link,
  // the folders a config leads to are named by where they are.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "vigile-backups-")));
  const config = join(directory, "config.toml");
  initConfig(config, { name: "backups", port: await freePort() });
  for (const [key, value] of Object.entries(settings)) setValue(config, key, value);
  let running: Service | undefined;
  const made: Instance = {
    directory,
    config,
    data: join(directory, "data"),
    backups: join(directory, "backups"),
    clock: { now: START, mono: 1_000_000 },
    warnings: [],
    logged: [],
    get service() {
      return running!;
    },
    async start(times = {}, hooks = undefined, environment = {}, options = {}) {
      running = await startService({
        backupHooks: hooks,
        loaded: loadConfig(config, environment, options),
        log: (line) => made.logged.push(line),
        warn: (line) => made.warnings.push(line),
        now: () => made.clock.now,
        monotonic: () => made.clock.mono,
        backupTimes: { firstMs: 1_000_000_000, checkMs: 1_000_000_000, ...times },
      });
      return running;
    },
    automatic: (folder = made.backups) => automaticBackups(folder).sort((a, b) => a.at - b.at).map((backup) => backup.file.slice(folder.length + 1)),
    async pass(ms) {
      // Time passes on both clocks. Less than none is the clock of the machine set back: no time passes then.
      made.clock.now += ms;
      made.clock.mono += Math.max(0, ms);
      await running!.backups.check();
    },
    async post(path, body) {
      const response = await fetch(`${running!.urls.base}/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return response.json();
    },
    async doctor() {
      const lines: string[] = [];
      const ui = { fancy: false, paint: (_style: unknown, text: string) => text, out: (line = "") => void lines.push(line), err: () => {} } as Ui;
      await doctor(parseArgs(["--json", "--config", config]), ui);
      return JSON.parse(lines.join("\n"));
    },
    async remove() {
      await running?.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  instances.push(made);
  return made;
}

/** The name an automatic backup of the tenant has when it is taken at the moment. */
const named = (moment: number, tenant = "default"): string => `${tenant}-${new Date(moment).toISOString().replace(/[-:]/g, "").replace("T", "-").replace(".", "-").replace("Z", "")}-auto.sqlite`;
/** The folder whose marker commits every tenant copy of one automatic backup. */
const setNamed = (moment: number): string => `${new Date(moment).toISOString().replace(/[-:]/g, "").replace("T", "-").replace(".", "-").replace("Z", "")}-auto.set`;

describe("the backups the service takes by itself", () => {
  it("are on, every 24 hours, into backups beside the config, when the config says nothing of them", async () => {
    const one = await instance();
    // An hour ago by the machine's clock, which is what the doctor goes by.
    const begin = Date.now() - HOUR;
    one.clock.now = begin;
    const service = await one.start();
    assert.equal(readFileSync(one.config, "utf8").includes("[backup]"), false);
    assert.deepEqual(service.backups.status(), { enabled: true, every_hours: 24, folder: one.backups, keep: 30, last_at: null, next_due: new Date(begin).toISOString(), running: false, failure: null, outcome: null, unread: null });
    assert.deepEqual(one.automatic(), [], "none is taken before the service looks at its clock, which it first does once it listens");

    const about = async () => (await one.doctor()).checks.filter((check) => /automatic backup/.test(check.title)).map((check) => [check.level, check.title, check.detail]);
    assert.deepEqual(await about(), [
      ["ok", "automatic backups are on", `every 24 hours into ${one.backups}, the newest 30 of a tenant are kept; none taken yet, the first is due when the service runs`],
      ["ok", "last automatic backup worked", `none taken yet; the first is due ${new Date(begin).toISOString()}`],
    ]);

    await one.pass(0);
    assert.deepEqual(one.automatic(), [named(begin)], "with no backup there, one is due at the start");
    assert.deepEqual(await about(), [
      ["ok", "automatic backups are on", `every 24 hours into ${one.backups}, the newest 30 of a tenant are kept; last ${iso(begin)}, next due ${iso(begin + 24 * HOUR)}`],
      ["ok", "last automatic backup worked", `taken ${new Date(begin).toISOString()}; the next is due ${new Date(begin + 24 * HOUR).toISOString()}`],
    ]);
    assert.equal(service.backups.status().last_at, new Date(begin).toISOString());
    assert.equal(service.backups.status().next_due, new Date(begin + 24 * HOUR).toISOString());
    // What holds for a backup taken by hand: readable by its owner only, in a folder that is its owner's only.
    assert.equal(statSync(join(one.backups, named(begin))).mode & 0o777, 0o600);
    assert.equal(statSync(one.backups).mode & 0o777, 0o700);
    const report = inspectTenantFile("default", join(one.backups, named(begin)));
    assert.equal(report.ok, true, report.messages.join("; "));

    await one.pass(24 * HOUR - 1);
    assert.deepEqual(one.automatic(), [named(begin)], "a millisecond short of 24 hours none is due");
    await one.pass(1);
    assert.deepEqual(one.automatic(), [named(begin), named(begin + 24 * HOUR)]);
    await one.pass(3 * 24 * HOUR);
    assert.equal(one.automatic().length, 3, "a machine that slept through three days wakes to one backup, not three");
    assert.equal(service.backups.status().next_due, new Date(begin + 5 * 24 * HOUR).toISOString());
    assert.deepEqual(one.warnings, []);
    assert.equal(one.logged.filter((line) => / backup=automatic result=ok copies=1 kb=\d+ removed=0 ms=\d+ folder=/.test(line)).length, 3, "each one is a line in the log");
    // The admin status says the same, for the doctor.
    const status: any = await (await fetch(`${service.urls.base}/api/admin/status`, { headers: { authorization: `Bearer ${loadConfig(one.config, {}).config.auth.keys.admin}` } })).json();
    assert.deepEqual(status.backups, service.backups.status());
    assert.deepEqual(status.settings.backup, { enabled: true, every_hours: 24, folder: "backups", keep: 30 });
  });

  it("are not taken when backup.enabled is false, and nothing is made for them", async () => {
    const one = await instance({ "backup.enabled": "false" });
    const service = await one.start();
    assert.deepEqual(service.backups.status(), { enabled: false, every_hours: 24, folder: one.backups, keep: 30, last_at: null, next_due: null, running: false, failure: null, outcome: null, unread: null });
    await one.pass(0);
    await one.pass(100 * 24 * HOUR);
    assert.equal(existsSync(one.backups), false);
    assert.deepEqual(one.warnings, []);
    const report = await one.doctor();
    assert.deepEqual(report.checks.find((check) => check.title === "automatic backups"), { section: "Data", level: "ok", title: "automatic backups", detail: "off: backup.enabled is false; take backups with vigile backup <folder>" });
    assert.equal(report.checks.some((check) => check.title === "last automatic backup worked"), false);
  });

  it("are taken as often as backup.every_hours says: every 4 hours, and every half hour", async () => {
    const four = await instance({ "backup.every_hours": "4" });
    await four.start();
    await four.pass(0);
    await four.pass(4 * HOUR - 1);
    assert.deepEqual(four.automatic(), [named(START)]);
    await four.pass(1);
    await four.pass(3 * HOUR);
    await four.pass(HOUR);
    assert.deepEqual(four.automatic(), [named(START), named(START + 4 * HOUR), named(START + 8 * HOUR)]);
    assert.equal(four.service.backups.status().every_hours, 4);
    assert.equal(four.service.backups.status().next_due, new Date(START + 12 * HOUR).toISOString());

    const half = await instance({ "backup.every_hours": "0.5" });
    await half.start();
    await half.pass(0);
    await half.pass(29 * MINUTE);
    assert.deepEqual(half.automatic(), [named(START)]);
    await half.pass(MINUTE);
    assert.deepEqual(half.automatic(), [named(START), named(START + 30 * MINUTE)]);
  });

  it("go by the moment in the name of the newest one, so that a start neither takes one each time nor puts the next one off", async () => {
    const one = await instance();
    await one.start();
    await one.pass(0);
    await one.service.stop();

    // A fresh one is there: a start ten hours later takes none, and the next is due when that one is a day old.
    one.clock.now = START + 10 * HOUR;
    await one.start();
    assert.equal(one.service.backups.status().last_at, new Date(START).toISOString());
    assert.equal(one.service.backups.status().next_due, new Date(START + 24 * HOUR).toISOString());
    await one.pass(0);
    assert.deepEqual(one.automatic(), [named(START)]);
    await one.service.stop();
    // Restarts in between do not put it off.
    one.clock.now = START + 23 * HOUR;
    await one.start();
    await one.pass(0);
    assert.deepEqual(one.automatic(), [named(START)]);
    await one.pass(HOUR);
    assert.deepEqual(one.automatic(), [named(START), named(START + 24 * HOUR)]);
    await one.service.stop();

    // An old one is there: one is due at the start.
    one.clock.now = START + 24 * HOUR + 25 * HOUR;
    await one.start();
    assert.equal(one.service.backups.status().next_due, new Date(START + 49 * HOUR + 10 * MINUTE).toISOString(), "due, but not before ten elapsed minutes after the preceding attempt");
    await one.pass(0);
    assert.deepEqual(one.automatic(), [named(START), named(START + 24 * HOUR)]);
    await one.pass(10 * MINUTE);
    assert.deepEqual(one.automatic(), [named(START), named(START + 24 * HOUR), named(START + 49 * HOUR + 10 * MINUTE)]);
    await one.service.stop();

    // A backup taken by hand is not one of the service's own, also in the same folder: it does not put the
    // next automatic one off, and the service does not count it.
    const other = await instance();
    await other.start();
    const byHand = await run(["backup", other.backups, "--json", "--config", other.config]);
    assert.equal(byHand.code, 0, byHand.err);
    assert.equal(other.service.backups.status().last_at, null);
    await other.service.stop();
    await other.start();
    assert.equal(other.service.backups.status().last_at, null);
    await other.pass(0);
    assert.deepEqual(other.automatic(), [named(START)]);
    assert.equal(readdirSync(other.backups).filter((name) => name.endsWith(".sqlite")).length, 2, "the one taken by hand is there as well");
  });

  it("keep the newest of each tenant, as many as backup.keep says, and never remove a file the service did not write as one", async () => {
    const one = await instance({ "backup.keep": "3" });
    mkdirSync(one.backups, { recursive: true });
    // What a person may have in the folder: a backup taken by hand, files of their own, a copy of an automatic
    // backup under another name, something that is not a file under an automatic backup's name.
    const foreign: Record<string, string> = {
      "default-20200101-000000-000.sqlite": "a backup taken by hand",
      "default-20200101-000000.sqlite": "a backup from an earlier version",
      "notes.txt": "mine",
      "default-20200101-000000-000-auto.sqlite.bak": "a copy",
      "copy of default-20200101-000000-000-auto.sqlite": "another copy",
      "default-20200101-000000-000-auto.sqlite.partial.txt": "not a working file",
      "default-20200101-000000-000.sqlite.partial": "the working file of a backup by hand",
    };
    for (const [name, content] of Object.entries(foreign)) writeFileSync(join(one.backups, name), content);
    mkdirSync(join(one.backups, "default-20200102-000000-000-auto.sqlite"));
    symlinkSync(join(one.backups, "notes.txt"), join(one.backups, "default-20200103-000000-000-auto.sqlite"));
    // An automatic backup of a tenant that is not among the data any more is not this tenant's to count.
    writeFileSync(join(one.backups, "archive-20200101-000000-000-auto.sqlite"), "of another tenant");

    await one.start();
    for (let i = 0; i < 5; i++) await one.pass(i === 0 ? 0 : 24 * HOUR);
    assert.deepEqual(one.automatic().filter((name) => name.startsWith("default-")), [named(START + 2 * 24 * HOUR), named(START + 3 * 24 * HOUR), named(START + 4 * 24 * HOUR)]);
    assert.equal(one.logged.filter((line) => line.includes("backup=automatic") && line.includes(" removed=1 ")).length, 2);
    for (const [name, content] of Object.entries(foreign)) assert.equal(readFileSync(join(one.backups, name), "utf8"), content, name);
    assert.equal(statSync(join(one.backups, "default-20200102-000000-000-auto.sqlite")).isDirectory(), true);
    assert.equal(readFileSync(join(one.backups, "default-20200103-000000-000-auto.sqlite"), "utf8"), "mine");
    assert.equal(readFileSync(join(one.backups, "archive-20200101-000000-000-auto.sqlite"), "utf8"), "of another tenant");
    assert.deepEqual(one.warnings, []);
  });

  it("say in the log why one failed and what to do, tell the doctor, leave the service answering, and are tried again ten minutes later", async () => {
    const one = await instance();
    // Something else stands where the folder would be made.
    writeFileSync(one.backups, "in the way");
    const service = await one.start();
    await one.pass(0);
    assert.equal(one.warnings.length, 1, one.warnings.join("\n"));
    assert.match(one.warnings[0]!, /^The automatic backup into .*backups failed: .*backups is not a folder: it is a file\. Move it away, or name another folder for the backups\. It is tried again at 2026-11-13T09:10:00\.000Z; the service goes on meanwhile\.$/);
    const failure = service.backups.status().failure!;
    assert.equal(failure.at, new Date(START).toISOString());
    assert.equal(failure.retry_at, new Date(START + 10 * MINUTE).toISOString());
    assert.equal(service.backups.status().next_due, failure.retry_at);
    assert.equal((await fetch(`${service.urls.base}/health`)).status, 200);
    assert.equal((await one.post("create-project", { title: "Goes on", prefix: "GON" })).id, "GON");

    const failed = (await one.doctor()).checks.find((check) => check.title === "last automatic backup worked")!;
    assert.equal(failed.level, "fail");
    assert.equal(failed.detail, `failed at ${failure.at}: ${failure.reason}`);
    assert.match(failed.fix!, /^Move it away, or name another folder for the backups\. The service tries again at 2026-11-13T09:10:00\.000Z\.$/);

    // Not in a tight loop: nothing is tried before the ten minutes are over, and each failure is said once.
    await one.pass(10 * MINUTE - 1);
    assert.equal(one.warnings.length, 1);
    await one.pass(1);
    assert.equal(one.warnings.length, 2);
    assert.equal(service.backups.status().failure!.retry_at, new Date(START + 20 * MINUTE).toISOString());

    // Once the folder can be made, the next try works, and the doctor has nothing to report.
    rmSync(one.backups);
    await one.pass(10 * MINUTE);
    assert.deepEqual(one.automatic(), [named(START + 20 * MINUTE)]);
    assert.equal(service.backups.status().failure, null);
    assert.equal(service.backups.status().next_due, new Date(START + 20 * MINUTE + 24 * HOUR).toISOString());
    assert.equal(one.warnings.length, 3);
    assert.match(one.warnings[2]!, /^Automatic backups work again/);
    const worked = (await one.doctor()).checks.find((check) => check.title === "last automatic backup worked")!;
    assert.deepEqual([worked.level, worked.detail], ["ok", `taken ${new Date(START + 20 * MINUTE).toISOString()}; the next is due ${new Date(START + 20 * MINUTE + 24 * HOUR).toISOString()}`]);
  });

  it("say that the folder cannot be written when it cannot, with what to do, and leave nothing behind there", async () => {
    // Someone who may write into every folder, as root may, cannot see this happen.
    if (process.getuid?.() === 0) return;
    const one = await instance();
    mkdirSync(one.backups, { mode: 0o700 });
    writeFileSync(join(one.backups, "mine.txt"), "mine");
    chmodSync(one.backups, 0o500);
    try {
      await one.start();
      await one.pass(0);
      assert.equal(one.warnings.length, 1, one.warnings.join("\n"));
      assert.match(one.warnings[0]!, /failed: The backup folder .*backups cannot be taken for this service: .*\. Give the account the service runs as read and write access to the folder, or choose another: vigile config set backup\.folder <folder>, then restart the service\. It is tried again at /);
      assert.deepEqual(readdirSync(one.backups), ["mine.txt"]);
      assert.equal((await fetch(`${one.service.urls.base}/health`)).status, 200);
    } finally {
      chmodSync(one.backups, 0o700);
    }
    await one.pass(10 * MINUTE);
    assert.deepEqual(one.automatic(), [named(START + 10 * MINUTE)]);
    assert.equal(one.service.backups.status().failure, null);
  });

  it("fail when something stands where a copy would be written, leave no copy of any tenant, and leave the thing that stood there", async () => {
    const one = await instance();
    await one.start();
    await one.pass(0);
    // Whoever runs this, a folder cannot be opened as a new file.
    const inTheWay = join(one.backups, named(START + 24 * HOUR));
    mkdirSync(inTheWay);
    await one.pass(24 * HOUR);
    assert.equal(one.warnings.length, 1, one.warnings.join("\n"));
    assert.match(one.warnings[0]!, /failed: .*-auto\.sqlite is in the way: this backup would be written there, and nothing but this backup may have that name\. Move it away, or remove it if it is nothing you need\. It is tried again at /);
    assert.deepEqual(one.automatic(), [named(START)]);
    assert.equal(statSync(inTheWay).isDirectory(), true);
    assert.equal(one.service.backups.status().last_at, iso(START));
  });

  describe("the schedule, with a store that says how each backup ended", () => {
    const WRITTEN = { copies: 2, bytes: 2048 };
    /** A schedule over a store that ends each backup the way the test says next. */
    function scheduled(everyHours = 24) {
      const lines: string[] = [];
      const taken: number[] = [];
      const state = { clock: START, next: { kind: "complete", ...WRITTEN, removed: 0 } as BackupOutcome | Error, newest: null as number | null | Error };
      const source: BackupSource = {
        // The backups there are: the ones that were taken, and one that was there before when the test says so.
        moments: () => {
          if (state.newest instanceof Error) throw state.newest;
          return state.newest === null ? [...taken] : [state.newest, ...taken];
        },
        take: (at) => {
          const next = state.next;
          if (!(next instanceof Error) && next.kind !== "incomplete") taken.push(at);
          return { done: next instanceof Error ? Promise.reject(next) : Promise.resolve(next), cancel: async () => {} };
        },
        close: async () => {},
      };
      const schedule = startBackups({ everyHours, folder: "/b", keep: 1, source, now: () => state.clock, monotonic: () => state.clock, times: { ...BACKUP_TIMES, firstMs: 1_000_000_000, checkMs: 1_000_000_000 }, log: (line) => lines.push(`log ${line}`), warn: (line) => lines.push(`warn ${line}`) });
      return { schedule, state, lines, taken };
    }

    it("with an interval shorter than ten minutes would be tried again after the interval: never later than the next would be due", async () => {
      // The shortest interval the config takes is longer than the retry.
      const { schedule, state, lines } = scheduled(0.1);
      state.next = { kind: "incomplete", reason: "no room", actions: [] };
      await schedule.check();
      assert.equal(schedule.status().failure!.reason, "no room.");
      assert.equal(schedule.status().failure!.retry_at, iso(START + 6 * MINUTE));
      state.clock += 6 * MINUTE;
      await schedule.check();
      assert.equal(lines.length, 2);
      await schedule.stop();
    });

    it("take one at the start when how old the newest is cannot be known, and say what the store says is to be done", async () => {
      const { schedule, state, lines, taken } = scheduled();
      state.newest = new Error("the folder cannot be read");
      state.next = { kind: "incomplete", reason: "The folder is someone else's.", actions: ["Choose another."] };
      assert.equal(schedule.status().next_due, iso(START));
      await schedule.check();
      assert.deepEqual(lines, ["warn The automatic backup into /b failed: The folder is someone else's. Choose another. It is tried again at 2026-11-13T09:10:00.000Z; the service goes on meanwhile."]);
      assert.deepEqual(schedule.status().failure, { at: iso(START), reason: "The folder is someone else's.", actions: ["Choose another."], retry_at: iso(START + 10 * MINUTE) });
      assert.deepEqual(schedule.status().outcome, { at: iso(START), kind: "incomplete", said: "The folder is someone else's." });
      // A store that fails outright, where it should say how the backup ended, has taken none either.
      state.next = Object.assign(new Error("the store broke"), { hints: ["Mend it."] });
      state.clock += 10 * MINUTE;
      await schedule.check();
      assert.equal(lines[1], "warn The automatic backup into /b failed: the store broke. Mend it. It is tried again at 2026-11-13T09:20:00.000Z; the service goes on meanwhile.");
      state.next = { kind: "complete", ...WRITTEN, removed: 1 };
      state.clock += 10 * MINUTE;
      await schedule.check();
      assert.deepEqual(taken, [START + 20 * MINUTE]);
      assert.match(lines[2]!, /^log .* backup=automatic result=ok copies=2 kb=2 removed=1 ms=\d+ folder=\/b$/);
      assert.equal(lines[3], "warn Automatic backups work again: one was taken into /b.");
      assert.equal(lines.length, 4);
      assert.deepEqual([schedule.status().failure, schedule.status().outcome], [null, { at: iso(START + 20 * MINUTE), kind: "complete", said: null }]);
      await schedule.stop();
    });

    it("uses a remembered successful backup when the folder cannot be scanned after restart", async () => {
      let attempts = 0;
      const source: BackupSource = {
        moments: () => {
          throw new Error("the backup volume is unavailable");
        },
        take: () => (attempts++, { done: Promise.resolve({ kind: "complete", copies: 1, bytes: 1, removed: 0 }), cancel: async () => {} }),
        close: async () => {},
      };
      const memory: BackupMemory = {
        read: () => ({ folder: "/b", at: START, ended: START, kind: "complete", said: null, actions: [] }),
        write: () => {},
      };
      const now = START + HOUR;
      const schedule = startBackups({ everyHours: 24, folder: "/b", keep: 1, source, memory, now: () => now, monotonic: () => now, times: { ...BACKUP_TIMES, firstMs: 1_000_000_000, checkMs: 1_000_000_000 }, log: () => {}, warn: () => {} });

      assert.deepEqual([schedule.status().last_at, schedule.status().next_due], [iso(START), iso(START + 24 * HOUR)]);
      await schedule.check();
      assert.equal(attempts, 0, "the remembered successful backup still has 23 hours left");
      await schedule.stop();
    });

    it("go by every backup that is whole and in place, whatever else is said of it, and say exactly that: only one of which nothing remains has failed", async () => {
      const { schedule, state, lines, taken } = scheduled();
      const ends: Array<[BackupOutcome, result: string, said: string]> = [
        [
          { kind: "complete_retention_failed", ...WRITTEN, removed: 0, notRemoved: ["/b/old: EACCES"] },
          "retention_failed",
          "The automatic backup was taken, but an older one could not be removed: /b/old: EACCES. Remove them by hand, or give the account the service runs as write access to /b.",
        ],
        [
          { kind: "complete_unconfirmed", ...WRITTEN, reason: "What was written to /b is in place, but the system could not confirm that it will survive a power cut: EIO" },
          "unconfirmed",
          "The automatic backup into /b was taken and is whole, but it is not confirmed: What was written to /b is in place, but the system could not confirm that it will survive a power cut: EIO. Older backups were not removed this time.",
        ],
        [
          { kind: "complete_unreported", ...WRITTEN, reason: null },
          "unreported",
          "The automatic backup into /b is whole and in place, but what wrote it ended without reporting how it went. Whether older backups were removed is not known; the next backup removes them.",
        ],
        [
          { kind: "complete_unreported", ...WRITTEN, reason: "out of memory." },
          "unreported",
          "The automatic backup into /b is whole and in place, but what wrote it ended without reporting how it went (out of memory). Whether older backups were removed is not known; the next backup removes them.",
        ],
      ];
      for (const [i, [end, result, said]] of ends.entries()) {
        const at = START + i * 24 * HOUR;
        state.clock = at;
        state.next = end;
        lines.length = 0;
        await schedule.check();
        assert.match(lines[0]!, new RegExp(`^log .* backup=automatic result=${result} copies=2 kb=2 removed=0 ms=\\d+ folder=/b$`));
        assert.deepEqual(lines.slice(1), [`warn ${said}`], end.kind);
        // Taken: it is the last backup, the next is due an interval later and not after the shorter while of a failure.
        assert.deepEqual(schedule.status(), { enabled: true, every_hours: 24, folder: "/b", keep: 1, last_at: iso(at), next_due: iso(at + 24 * HOUR), running: false, failure: null, outcome: { at: iso(at), kind: end.kind, said }, unread: null }, end.kind);
        state.clock += 10 * MINUTE;
        await schedule.check();
        assert.equal(lines.length, 2, "nothing is tried again ten minutes later");
      }
      assert.equal(taken.length, 4);
      await schedule.stop();
    });
  });

  it("wait for a backup that is being taken by hand, say so when it does not finish, and answer requests all the while", async () => {
    const one = await instance();
    const service = await one.start();
    // What vigile backup and restore-backup hold while they work.
    const release = holdTenantFiles(one.data)!;
    let answered = 0;
    let over = false;
    const tried = one.pass(0).then(() => (over = true));
    while (!over) {
      assert.equal((await fetch(`${service.urls.base}/health`)).status, 200);
      if (!over) answered++;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await tried;
    assert.ok(answered >= 3, `the service answered ${answered} times while the backup waited`);
    assert.equal(one.warnings.length, 1);
    assert.match(one.warnings[0]!, /failed: A restore, or another backup, is at work in .*data\. Let it finish; the service will try again\. It is tried again at /);
    assert.deepEqual(one.automatic(), []);
    release();
    await one.pass(10 * MINUTE);
    assert.deepEqual(one.automatic(), [named(START + 10 * MINUTE)]);
  });

  it("are taken by themselves, a little after the service listens and whenever one has become due", async () => {
    const one = await instance();
    const service = await one.start({ firstMs: 150, checkMs: 40 });
    assert.deepEqual(one.automatic(), [], "none yet when the service has just started");
    const appear = async (count: number) => {
      for (let attempt = 0; attempt < 800 && one.automatic().length < count; attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
      return one.automatic();
    };
    assert.deepEqual(await appear(1), [named(START)]);
    // The copy has its name before the backup is over: a day goes by once it is.
    for (let attempt = 0; attempt < 800 && service.backups.status().outcome === null; attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
    // Nobody tells the service to look: it looks at its clock every so often, and finds a day gone.
    one.clock.now += 24 * HOUR;
    one.clock.mono += 24 * HOUR;
    assert.deepEqual(await appear(2), [named(START), named(START + 24 * HOUR)]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (let attempt = 0; attempt < 800 && service.backups.status().running; attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(one.automatic().length, 2, "and takes no further one while none is due");
    assert.equal(service.backups.status().running, false);
  });
});

describe("two services whose automatic backups go into one folder", () => {
  it("do not both write there: the second says that the folder is another service's, and writes nothing", async () => {
    const first = await instance();
    const second = await instance();
    setValue(second.config, "backup.folder", first.backups);
    await first.start();
    await first.pass(0);
    await second.start();
    assert.equal(second.service.backups.status().next_due, new Date(START).toISOString(), "the first one's backup is not taken for the second one's own");
    second.clock.now = START + HOUR;
    await second.pass(0);
    assert.equal(second.warnings.length, 1);
    assert.match(second.warnings[0]!, /failed: Another Vigile service takes its automatic backups into .*backups\. Give each instance a backup folder of its own: vigile config set backup\.folder <folder>, then restart the service\./);
    const failed = (await second.doctor()).checks.find((check) => check.title === "last automatic backup worked")!;
    assert.equal(failed.level, "fail");
    assert.match(failed.detail!, /Another Vigile service takes its automatic backups into/);
    assert.deepEqual(first.automatic(), [named(START)], "what the first one wrote is as it was");
    // The first one goes on taking its own.
    await first.pass(24 * HOUR);
    assert.deepEqual(first.automatic(), [named(START), named(START + 24 * HOUR)]);
    assert.deepEqual(first.warnings, []);
  });

  it("nor into the data folder of another instance, which would take the backup for a tenant", async () => {
    const first = await instance();
    const second = await instance();
    await first.start();
    assert.throws(() => takeBackup({ dataDir: second.data, folder: first.data, at: new Date(START) }), (error: unknown) => error instanceof BackupRefused && /is the data folder of a Vigile instance/.test(error.message));
    assert.deepEqual(readdirSync(first.data).filter((name) => /auto|backups/.test(name)), []);
  });
});

it("does not turn an unreadable backup folder into a startup refusal", async () => {
  const one = await instance();
  mkdirSync(one.backups, { recursive: true, mode: 0o700 });
  chmodSync(one.backups, 0o111);
  try {
    assert.equal(placeRefusal(one.data, one.backups), null);
  } finally {
    chmodSync(one.backups, 0o700);
  }
});

describe("an automatic backup taken while changes are stored", () => {
  it("is the plan as it was at one revision, and restore-backup puts it in the place of the data", async () => {
    const one = await instance({ "backup.every_hours": "1" });
    const service = await one.start();
    await one.post("create-project", { title: "Busy", prefix: "BSY" });
    const before = inspectTenantFile("default", join(one.data, "default.sqlite")).revision!;
    // Tasks are stored one after another, without a pause, while backups are taken.
    let writing = true;
    let stored = 0;
    const writer = (async () => {
      while (writing) {
        const task = await one.post("create-task", { title: `Task ${stored + 1}`, description: "x".repeat(500), project: "BSY" });
        assert.equal(task.id, `BSY-${String(stored + 1).padStart(3, "0")}`);
        stored++;
      }
    })();
    for (let i = 0; i < 6; i++) await one.pass(HOUR);
    writing = false;
    await writer;
    const backups = one.automatic();
    assert.equal(backups.length, 6);
    const revisions: number[] = [];
    for (const name of backups) {
      const file = join(one.backups, name);
      const report = inspectTenantFile("default", file);
      assert.equal(report.ok, true, report.messages.join("; "));
      // Each task is one revision: a backup at a revision holds exactly the tasks stored up to it, the last one whole.
      const tasks = readTenantFile(file)!.objects.filter((record) => record.kind === "task").map((record) => record.id);
      assert.deepEqual(tasks, Array.from({ length: report.revision! - before }, (_, i) => `BSY-${String(i + 1).padStart(3, "0")}`).sort());
      revisions.push(report.revision!);
    }
    assert.ok(revisions.at(-1)! > revisions[0]!, `changes were stored between the backups: revisions ${revisions.join(", ")}`);
    assert.ok(revisions.at(-1)! <= before + stored);

    // The backup in the middle is restored, by its name alone, and the service starts on it.
    const middle = 3;
    await service.stop();
    const restored = await run(["restore-backup", join(one.backups, backups[middle]!), "--json", "--config", one.config]);
    assert.equal(restored.code, 0, restored.err);
    assert.deepEqual([JSON.parse(restored.out).tenant, JSON.parse(restored.out).revision], ["default", revisions[middle]]);
    await one.start();
    const tasks = one.service.engine.status().counts.task!;
    assert.equal(tasks, revisions[middle]! - before);
    assert.equal((await one.post("create-task", { title: "After the restore", description: "d", project: "BSY" })).id, `BSY-${String(tasks + 1).padStart(3, "0")}`);
  });
});

describe("an automatic backup of a large plan", () => {
  let one: Instance;

  // The plan is made once, which takes seconds. Each test then starts from the same place, whatever ran before
  // it: the service just started on that plan, the clock at its start, and no backup taken yet.
  before(async () => {
    one = await instance();
    const { engine } = await one.start();
    await engine.execute("create_project", "agent1", { title: "Large", prefix: "LRG" });
    for (let i = 0; i < 20_000; i++) await engine.execute("create_task", "agent1", { project: "LRG", title: `Task number ${i} of a large plan`, description: "What there is to do, in a few sentences, as tasks have it. ".repeat(40) });
  });
  beforeEach(async () => {
    await one.service.stop();
    rmSync(one.backups, { recursive: true, force: true });
    rmSync(join(one.data, MEMORY_FILE), { force: true });
    one.clock.now = START;
    one.warnings.length = 0;
    await one.start();
  });

  it("does not hold up the service: requests are answered while it is written", async () => {
    let answered = 0;
    let over = false;
    const taken = one.pass(0).then(() => (over = true));
    while (!over) {
      assert.equal((await fetch(`${one.service.urls.base}/health`)).status, 200);
      if (!over) answered++;
    }
    await taken;
    const [name] = one.automatic();
    assert.equal(name, named(START));
    backupTenantFile(join(one.data, "default.sqlite"), join(one.directory, "copied-here.sqlite"));
    assert.equal(statSync(join(one.backups, name!)).size, statSync(join(one.directory, "copied-here.sqlite")).size, "the same copy as the store makes of it");
    assert.ok(answered >= 3, `${answered} requests were answered while the backup was written`);

    // And with nothing else to do, the service's thread is idle for most of the time a backup takes: the copy
    // is made elsewhere. Had the thread made it, it would have been at work all the while. This is a share of
    // the time, not a length of it, so it holds on a machine of any speed.
    const before = performance.eventLoopUtilization();
    await one.pass(24 * HOUR);
    const { utilization } = performance.eventLoopUtilization(before);
    assert.deepEqual(one.automatic(), [named(START), named(START + 24 * HOUR)]);
    assert.ok(utilization < 0.5, `the service's thread was at work for ${(utilization * 100).toFixed(0)}% of the time the backup took`);
    assert.deepEqual(one.warnings, []);
  });

  it("leaves nothing half-written when the service stops while it is written, and lets go of the data", async () => {
    const taken = one.service.backups.check();
    // Until the copy is under way: its private set directory exists, but its complete marker does not. Stop at
    // that unpublished boundary rather than waiting for the old per-file `.partial` name.
    for (const end = Date.now() + 10_000; Date.now() < end && (!existsSync(one.backups) || !readdirSync(one.backups).some((name) => name.endsWith("-auto.set") && !existsSync(join(one.backups, name, "complete.json")))); ) await new Promise((resolve) => setImmediate(resolve));
    await one.service.stop();
    await taken;
    assert.equal(existsSync(join(one.data, MEMORY_FILE)), true, "a backup that the stop cut short keeps its begun time for restart throttling");
    const left = readdirSync(one.backups).filter((name) => name.endsWith(".sqlite") || name.includes(".partial"));
    assert.ok(left.length === 0 || (left.length === 1 && left[0] === named(START) && inspectTenantFile("default", join(one.backups, left[0])).ok), `what is left is nothing, or the whole backup: ${left.join(", ")}`);
    assert.deepEqual(one.warnings, [], "a backup that the stop cut short has not failed");
    // Neither the tenants' files nor the folders are still held by the backup that was cut short.
    const release = holdTenantFiles(one.data);
    assert.notEqual(release, null);
    release!();
    one.clock.now = START + 24 * HOUR;
    await one.start();
    await one.pass(0);
    assert.deepEqual(one.automatic(), [], "the restart does not immediately repeat the interrupted attempt");
    assert.equal(one.service.backups.status().next_due, new Date(START + 24 * HOUR + 10 * MINUTE).toISOString());
    await one.pass(10 * MINUTE);
    assert.deepEqual(one.automatic().slice(-1), [named(START + 24 * HOUR + 10 * MINUTE)]);
  });

  it("clears only identity-recorded crash work and preserves legacy partial names that prove no ownership", async () => {
    await one.pass(0);
    await one.service.stop();
    const unproved = ["default-20261101-000000-000-auto.sqlite.partial", "default-20261101-000000-000-auto.sqlite.partial-journal"];
    const otherNames = ["default-20261101-000000-000.sqlite.partial", "default-20261101-000000-000-auto.sqlite.partial.kept"];
    const vigileNames = [".vigile-default-20261101-000000-000.sqlite.partial", ".vigile-default-20261101-000000-000-auto.sqlite.partial-wal"];
    for (const name of [...unproved, ...otherNames, ...vigileNames]) writeFileSync(join(one.backups, name), "half");
    const guarded = named(START - HOUR);
    const guardedFile = join(one.backups, guarded);
    writeFileSync(guardedFile, "an interrupted guarded copy");
    const guardedStats = lstatSync(guardedFile);
    writeFileSync(`${guardedFile}.copying`, JSON.stringify({ version: 1, device: String(guardedStats.dev), inode: String(guardedStats.ino) }));
    await one.start();
    assert.deepEqual(readdirSync(one.backups).filter((name) => name.includes(".partial")).sort(), [...unproved, ...otherNames].sort());
    assert.equal(vigileNames.every((name) => !existsSync(join(one.backups, name))), true, "reserved Vigile transient names are reclaimed by name");
    assert.equal(existsSync(guardedFile) || existsSync(`${guardedFile}.copying`), false, "a guarded final inode recorded by an interrupted backup is reclaimed");
    assert.deepEqual(one.automatic(), [named(START)], "what was left is no backup, and is not counted as one");
  });
});

/** An instance whose data has two tenants, not running. */
async function twoTenants(settings: Record<string, string> = {}): Promise<Instance> {
  const one = await instance(settings);
  await one.start();
  await one.service.stop();
  backupTenantFile(join(one.data, "default.sqlite"), join(one.data, "second.sqlite"));
  return one;
}
const tenants = ["default", "second"];
/** The copies in a folder, under backup names and under working names, and what lies beside them. */
const backupsIn = (folder: string): string[] => (existsSync(folder) ? readdirSync(folder).filter((name) => name.includes(".sqlite")).sort() : []);
/** A backup as the service takes one, taken here and now on this thread. */
const automatic = (one: Instance, at: number, how: Parameters<typeof takeBackup>[1] = {}, step?: Parameters<typeof takeBackup>[0]["step"], keep = 30) => takeBackup({ dataDir: one.data, folder: one.backups, at: new Date(at), automatic: { keep }, step }, how);

it("does not block the service thread while the backup-folder lock helper fails", async () => {
  const one = await twoTenants();
  mkdirSync(one.backups, { recursive: true });
  let fail!: (error: Error) => void;
  const waiting = new Promise<never>((_resolve, reject) => (fail = reject));
  void waiting.catch(() => {});
  const source = sqliteBackups({ dataDir: one.data, folder: one.backups, keep: 30, hooks: { hold: async () => waiting } });
  const ready = source.ready?.(false);
  const began = performance.now();
  assert.deepEqual(source.moments(), []);
  assert.ok(performance.now() - began < 50, "the first status reading returns while acquisition is pending");
  assert.match((await source.take(START).done as { reason: string }).reason, /is still being taken/, "no backup starts before the asynchronous lock is held");
  assert.deepEqual(backupsIn(one.backups), []);
  fail(new Error("the asynchronous helper stopped before answering"));
  await ready;
  assert.throws(() => source.moments(), /asynchronous helper stopped before answering/);
  await source.close();
});

it("caches a scan-worker construction failure instead of rejecting readiness", async () => {
  const one = await twoTenants();
  mkdirSync(one.backups, { recursive: true });
  const source = sqliteBackups({
    dataDir: one.data,
    folder: one.backups,
    keep: 30,
    hooks: { folderWorker: (request, start) => {
      if ((request as { action?: string }).action === "scan") throw new Error("no worker thread is available for the scan");
      return start();
    } },
  });

  await assert.doesNotReject(source.ready!(false));
  assert.throws(() => source.moments(), /no worker thread is available for the scan/);
  await source.close();
});

it("does not let late readiness start folder work after shutdown has closed the source", async () => {
  const one = await twoTenants();
  const actions: string[] = [];
  const source = sqliteBackups({
    dataDir: one.data,
    folder: one.backups,
    keep: 30,
    hooks: { folderWorker: (request, start) => (actions.push(String((request as { action?: string }).action)), start()) },
  });

  await source.close();
  await source.ready!(false);
  assert.deepEqual(actions, []);
  assert.equal(existsSync(one.backups), false);
});

it("refuses a backup folder replaced while its asynchronous lock is being acquired", async () => {
  const one = await twoTenants();
  mkdirSync(one.backups, { recursive: true });
  let acquired!: (release: () => Promise<void>) => void;
  let lockAsked!: () => void;
  let released = false;
  const waiting = new Promise<() => Promise<void>>((resolve) => (acquired = resolve));
  const asked = new Promise<void>((resolve) => (lockAsked = resolve));
  const source = sqliteBackups({ dataDir: one.data, folder: one.backups, keep: 30, hooks: { hold: async () => (lockAsked(), waiting) } });
  const ready = source.ready?.(false);
  assert.deepEqual(source.moments(), [], "status remains nonblocking while acquisition is pending");
  await asked;
  const original = `${one.backups}.moved`;
  renameSync(one.backups, original);
  mkdirSync(one.backups);
  writeFileSync(join(one.backups, "foreign.txt"), "untouched");
  acquired(async () => void (released = true));
  await ready;

  assert.throws(() => source.moments(), /moved or replaced after this service took it/);
  assert.equal(released, true, "the lock on the original folder is released");
  assert.equal(readFileSync(join(one.backups, "foreign.txt"), "utf8"), "untouched", "the replacement is never scanned or cleaned");
  await source.close();
});

it("does not reclaim a reserved transient name while a manual backup or restore holds the tenant files", async () => {
  const one = await instance();
  await one.start();
  await one.service.stop();
  mkdirSync(one.backups, { recursive: true });
  const transient = join(one.backups, ".vigile-default-20261113-090000-000.sqlite.partial");
  writeFileSync(transient, "still being written");
  const release = holdTenantFiles(one.data)!;

  await one.start();
  assert.equal(readFileSync(transient, "utf8"), "still being written");
  release();
  await one.service.stop();
  await one.start();
  assert.equal(existsSync(transient), false, "the abandoned reserved name is reclaimed once no writer holds the tenant files");
});

it("does not reclaim a manual backup from another data folder while that writer holds the destination", async () => {
  const one = await instance();
  await one.start();
  await one.service.stop();
  mkdirSync(one.backups, { recursive: true });
  const transient = join(one.backups, ".vigile-other-20261113-090000-000.sqlite.partial");
  writeFileSync(transient, "another data folder's live backup");
  const release = holdFile(backupOperationLock(one.backups))!;

  await one.start();
  assert.equal(readFileSync(transient, "utf8"), "another data folder's live backup");
  release();
  await one.service.stop();
  await one.start();
  assert.equal(existsSync(transient), false, "recovery reclaims the reserved name only after the destination writer leaves");
});

describe("one backup of several tenants", () => {
  it("discovers a timestamped set only after its complete marker names every ordinary tenant file", async () => {
    const one = await twoTenants();
    const at = START + 3 * HOUR;
    mkdirSync(one.backups);
    const set = join(one.backups, setNamed(at));
    mkdirSync(set);
    for (const tenant of tenants) backupTenantFile(join(one.data, `${tenant}.sqlite`), join(one.backups, named(at, tenant)));

    assert.deepEqual(automaticBackups(one.backups), [], "flat files at a set's moment are incomplete without its marker");
    const records = tenants.map((tenant) => {
      const stats = statSync(join(one.backups, named(at, tenant)));
      return { tenant, device: String(stats.dev), inode: String(stats.ino) };
    });
    const setStats = statSync(set);
    const directory = { device: String(setStats.dev), inode: String(setStats.ino) };
    writeFileSync(join(set, "complete.json"), JSON.stringify({ version: 1, directory, files: [...records].reverse() }));
    assert.deepEqual(automaticBackups(one.backups), [], "a marker whose tenant list is not canonical commits nothing");
    writeFileSync(join(set, "complete.json"), JSON.stringify({ version: 1, directory, files: records }));
    assert.deepEqual(automaticBackups(one.backups).map(({ tenant, at: moment }) => [tenant, moment]), tenants.map((tenant) => [tenant, at]));
    for (const tenant of tenants) assert.equal(inspectTenantFile(tenant, join(one.backups, named(at, tenant))).ok, true, tenant);

    const movedSet = `${set}.moved`;
    renameSync(set, movedSet);
    mkdirSync(set);
    writeFileSync(join(set, "complete.json"), readFileSync(join(movedSet, "complete.json")));
    assert.deepEqual(automaticBackups(one.backups), [], "a marker copied into a replacement set directory commits nothing");
    rmSync(set, { recursive: true });
    renameSync(movedSet, set);

    rmSync(join(one.backups, named(at, "second")));
    assert.deepEqual(automaticBackups(one.backups), [], "a marker cannot commit a set that is missing one tenant file");
  });

  it("never discovers flat files at a moment claimed by a non-directory set entry", async () => {
    const one = await twoTenants();
    mkdirSync(one.backups, { recursive: true });
    for (const tenant of tenants) backupTenantFile(join(one.data, `${tenant}.sqlite`), join(one.backups, named(START, tenant)));
    writeFileSync(join(one.backups, setNamed(START)), "not a set directory");

    assert.deepEqual(automaticBackups(one.backups), [], "every matching set entry suppresses legacy discovery at its moment");
  });

  it("recovers an incomplete set only through its recorded identities and preserves a foreign replacement", async () => {
    const one = await twoTenants();
    mkdirSync(one.backups, { recursive: true });
    const copies = prepareCopies(one.data, one.backups, new Date(START), true);
    renameSync(copies[0]!.working, copies[0]!.file);
    rmSync(copies[1]!.working);
    writeFileSync(copies[1]!.working, "a foreign replacement");
    const unrecordedMarker = join(one.backups, setNamed(START), "complete.json.partial");
    writeFileSync(unrecordedMarker, "an unrecorded marker replacement");

    await one.start();
    assert.equal(existsSync(copies[0]!.file), false, "the final name recorded with the prepared inode is reclaimed");
    assert.equal(readFileSync(copies[1]!.working, "utf8"), "a foreign replacement", "a replacement inode under a recorded name is preserved");
    assert.equal(readFileSync(unrecordedMarker, "utf8"), "an unrecorded marker replacement", "recovery never removes a marker partial whose identity was not recorded");
    assert.equal(existsSync(join(one.backups, setNamed(START))), true, "the set tombstone remains so the foreign replacement cannot be mistaken for a legacy backup");
    assert.deepEqual(automaticBackups(one.backups), [], "the preserved foreign file is no backup");
  });

  it("recovers artifacts left before preparation could finish its identity manifest", async () => {
    const one = await twoTenants();
    mkdirSync(one.backups, { recursive: true });
    const set = join(one.backups, setNamed(START));
    mkdirSync(set);
    const identity = lstatSync(set);
    const files = tenants.map((tenant) => named(START, tenant)).sort();
    const directories = tenants.map((tenant) => ({ name: `${tenant}.staging`, file: "copy.sqlite" })).sort((a, b) => a.name.localeCompare(b.name));
    writeFileSync(join(set, "preparing.json"), `${JSON.stringify({ version: 1, directory: { device: String(identity.dev), inode: String(identity.ino) }, files, directories })}\n`);
    for (const name of files) writeFileSync(join(one.backups, name), "interrupted");
    for (const entry of directories) {
      mkdirSync(join(set, entry.name));
      writeFileSync(join(set, entry.name, entry.file), "interrupted staging");
    }

    await one.start();
    assert.equal(existsSync(set), false);
    assert.equal(files.some((name) => existsSync(join(one.backups, name))), false);
  });

  it("recovers its own crash while the complete marker is being written", async () => {
    const one = await twoTenants();
    mkdirSync(one.backups, { recursive: true });
    const copies = prepareCopies(one.data, one.backups, new Date(START), true);
    writeFileSync(copies[0]!.set!.complete, '{"version":1');

    await one.start();
    assert.equal(existsSync(copies[0]!.set!.directory), false, "the torn marker and its identity-recorded set are reclaimed");
    await one.pass(0);
    assert.deepEqual(backupsIn(one.backups), tenants.map((tenant) => named(START, tenant)).sort(), "the same timestamp can be backed up after recovery");
  });

  it("recovers a valid-JSON completion marker that has no record shape", async () => {
    const one = await twoTenants();
    mkdirSync(one.backups, { recursive: true });
    const copies = prepareCopies(one.data, one.backups, new Date(START), true);
    writeFileSync(copies[0]!.set!.complete, "null");

    clearLeftovers(one.backups);

    assert.equal(existsSync(copies[0]!.set!.directory), false, "the malformed incomplete set is reclaimed");
    assert.deepEqual(automaticBackups(one.backups), []);
  });

  it("keeps recovery ownership when parent settlement sees a worker's torn completion marker", async () => {
    const one = await twoTenants();
    mkdirSync(one.backups, { recursive: true });
    const copies = prepareCopies(one.data, one.backups, new Date(START), true);
    writeFileSync(copies[0]!.set!.complete, '{"version":1');

    assert.equal(settleCopies(copies), false);
    assert.equal(existsSync(copies[0]!.set!.pending), true, "the pending identity record survives with the unrecognized marker");
    await one.start();
    assert.equal(existsSync(copies[0]!.set!.directory), false, "startup uses that record to reclaim the interrupted publication");
  });

  it("recovers a registered SQLite staging directory left by an interrupted worker", async () => {
    const one = await twoTenants();
    mkdirSync(one.backups, { recursive: true });
    const copies = prepareCopies(one.data, one.backups, new Date(START), true);
    const staging = copies[0]!.stagingDirectory!;
    const staged = copies[0]!.stagingFile!;
    writeFileSync(staged, Buffer.alloc(1024 * 1024, 7));
    const replacement = copies[1]!.stagingFile!;
    rmSync(replacement);
    writeFileSync(replacement, "a foreign replacement staging file");

    await one.start();
    assert.equal(existsSync(staged), false, "the database-sized transient copy is reclaimed");
    assert.equal(existsSync(staging), false, "its identity-registered private directory is reclaimed");
    assert.equal(readFileSync(replacement, "utf8"), "a foreign replacement staging file", "an unrecognized staging inode is preserved");
    assert.equal(existsSync(copies[1]!.set!.directory), true, "its set tombstone remains while the replacement does");
    assert.deepEqual(automaticBackups(one.backups), []);
  });

  it("preserves a committed set when its completion metadata cannot be read", async () => {
    const one = await twoTenants();
    automatic(one, START);
    const before = backupsIn(one.backups);
    const cannotRead = (): never => { throw Object.assign(new Error("the completion metadata cannot be read"), { code: "EIO" }); };

    assert.throws(() => clearLeftovers(one.backups, cannotRead), /completion metadata cannot be read/);

    assert.deepEqual(backupsIn(one.backups), before, "recovery removes nothing from the committed set");
    assert.equal(automaticBackups(one.backups).length, tenants.length, "the set remains complete and discoverable");
  });

  it("continues short completion-marker reads without treating a committed set as interrupted", async () => {
    const one = await twoTenants();
    automatic(one, START);
    const before = backupsIn(one.backups);
    const shortRead = (file: number, buffer: Buffer, offset: number, length: number, position: number | null): number => readSync(file, buffer, offset, Math.min(length, 7), position);

    assert.equal(automaticBackups(one.backups, shortRead).length, tenants.length);
    clearLeftovers(one.backups, shortRead);

    assert.deepEqual(backupsIn(one.backups), before, "recovery preserves the committed set after short reads");
  });

  it("recovers a registered SQLite staging directory left by an interrupted manual backup", async () => {
    const one = await instance();
    await one.start();
    await one.service.stop();
    mkdirSync(one.backups, { recursive: true });
    const copies = prepareCopies(one.data, one.backups, new Date(START), false);
    const copy = copies[0]!;
    assert.equal(basename(copy.stagingFile!), ".vigile-copy.sqlite", "the staging copy itself has an unmistakably reserved name");
    writeFileSync(copy.stagingFile!, Buffer.alloc(1024 * 1024, 7));

    clearLeftovers(one.backups);

    assert.equal(existsSync(copy.stagingFile!), false, "the database-sized transient copy is reclaimed");
    assert.equal(existsSync(copy.stagingDirectory!), false, "its identity-registered private directory is reclaimed");
    assert.equal(existsSync(copy.stagingRecord!), false, "the durable ownership record is reclaimed with it");
    assert.equal(existsSync(copy.working), false, "the interrupted manual backup remains undiscoverable");
  });

  it("preserves a replacement inside a manual backup's recorded staging directory", async () => {
    const one = await instance();
    await one.start();
    await one.service.stop();
    mkdirSync(one.backups, { recursive: true });
    const copy = prepareCopies(one.data, one.backups, new Date(START), false)[0]!;
    const replacement = `${copy.stagingFile}.replacement`;
    writeFileSync(replacement, "a replacement staging file");
    rmSync(copy.stagingFile!);
    renameSync(replacement, copy.stagingFile!);

    clearLeftovers(one.backups);

    assert.equal(readFileSync(copy.stagingFile!, "utf8"), "a replacement staging file");
    assert.equal(existsSync(copy.stagingRecord!), true, "the ownership record remains for inspection");
  });

  it("preserves a replacement inode when preparation fails after an owned file is substituted", async () => {
    const one = await twoTenants();
    mkdirSync(one.backups, { recursive: true });
    let replaced = "";
    assert.throws(
      () => prepareCopies(one.data, one.backups, new Date(START), false, (from) => {
        replaced = String(from);
        rmSync(from);
        writeFileSync(from, "a replacement made during setup");
        throw Object.assign(new Error("the link probe failed"), { code: "EIO" });
      }),
      /the link probe failed/,
    );
    assert.equal(readFileSync(replaced, "utf8"), "a replacement made during setup");
    assert.deepEqual(readdirSync(one.backups), [basename(replaced)], "other files still owned by the failed preparation are removed");
  });

  it("keeps the set tombstone when a final name is claimed during automatic preparation", async () => {
    const one = await twoTenants();
    mkdirSync(one.backups, { recursive: true });
    let claimed = "";
    assert.throws(
      () => prepareCopies(one.data, one.backups, new Date(START), true, linkSync, (path) => {
        if (!claimed) {
          claimed = path;
          writeFileSync(path, "a foreign file that won the final name");
        }
        return createPlainFile(path);
      }),
      /EEXIST/,
    );
    assert.equal(readFileSync(claimed, "utf8"), "a foreign file that won the final name");
    assert.equal(existsSync(join(one.backups, setNamed(START))), true, "the durable set tombstone still hides the occupied moment");
    assert.deepEqual(automaticBackups(one.backups), [], "the foreign final name is never a legacy backup");
  });

  it("does not trust a pending manifest that names a file outside its exact backup set", async () => {
    const one = await twoTenants();
    mkdirSync(one.backups, { recursive: true });
    const copies = prepareCopies(one.data, one.backups, new Date(START), true);
    const set = copies[0]!.set!;
    const foreign = join(one.backups, "keep-me.txt");
    writeFileSync(foreign, "foreign");
    const [directory, file] = [statSync(set.directory), statSync(foreign)];
    writeFileSync(set.pending, JSON.stringify({
      version: 1,
      directory: { device: String(directory.dev), inode: String(directory.ino) },
      files: [{ name: basename(foreign), device: String(file.dev), inode: String(file.ino) }],
    }));

    await one.start();
    assert.equal(readFileSync(foreign, "utf8"), "foreign");
    assert.ok(copies.every(({ file }) => existsSync(file)), "an invalid ownership manifest authorizes no cleanup");
    assert.equal(existsSync(set.pending), true, "the invalid manifest is preserved for diagnosis");
  });

  it("refuses an automatic set whose durable manifests cannot fit before any tenant is copied", async () => {
    const one = await twoTenants();
    for (let i = 0; i < 900; i++) writeFileSync(join(one.data, `tenant-${String(i).padStart(4, "0")}.sqlite`), "");
    mkdirSync(one.backups, { recursive: true });

    assert.throws(() => prepareCopies(one.data, one.backups, new Date(START), true), /too many tenant files/);
    assert.deepEqual(readdirSync(one.backups), [], "rejection leaves neither copies nor an oversized set marker");
  });

  it("orders every durable manifest by code units, independently of the process locale", async () => {
    const one = await instance();
    await one.start();
    await one.service.stop();
    for (const tenant of ["j", "y"]) backupTenantFile(join(one.data, "default.sqlite"), join(one.data, `${tenant}.sqlite`));
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error("locale ordering was used");
    };
    try {
      automatic(one, START);
    } finally {
      String.prototype.localeCompare = original;
    }
    assert.deepEqual(automaticBackups(one.backups).map(({ tenant }) => tenant), ["default", "j", "y"]);
  });

  it("is every tenant's copy under its name, each as large as it says, when nothing goes wrong", async () => {
    const one = await twoTenants();
    const said: string[] = [];
    const taken = automatic(one, START, {}, (point, tenant) => void said.push(tenant ? `${point} ${tenant}` : point));
    assert.deepEqual(backupsIn(one.backups), [named(START), named(START, "second")]);
    assert.deepEqual(taken.files, tenants.map((tenant) => ({ tenant, file: join(one.backups, named(START, tenant)), bytes: statSync(join(one.backups, named(START, tenant))).size })));
    assert.ok(taken.files.every((file) => file.bytes > 0));
    const marker = JSON.parse(readFileSync(join(one.backups, setNamed(START), "complete.json"), "utf8"));
    assert.deepEqual(marker.files.map((file: any) => file.tenant), tenants, "one marker commits the complete tenant set");
    assert.ok(marker.files.every((file: any) => typeof file.device === "string" && typeof file.inode === "string"), "the marker identifies every file retention may remove");
    assert.ok(typeof marker.directory.device === "string" && typeof marker.directory.inode === "string", "the marker identifies the set directory retention may remove");
    // Every copy is written and on the disk before the first one gets its name.
    assert.deepEqual(said, ["start", "copy default", "copied default", "flushed default", "copy second", "copied second", "flushed second", "name default", "name second", "named", "retention"]);
    assert.deepEqual(backupsIn(one.backups).filter((name) => name.includes(".partial")), []);
    assert.equal(newestWhole(one.backups, tenants, START + 100 * HOUR), START);
  });

  it("does not publish a set when a flushed tenant copy is changed before publication", async () => {
    const one = await twoTenants();
    let changed = false;
    assert.throws(() => automatic(one, START, {}, (point) => {
      if (point === "name" && !changed) {
        changed = true;
        writeFileSync(join(one.backups, named(START)), "changed after it was flushed");
      }
    }), /not the file that was made for this copy/);
    assert.deepEqual(automaticBackups(one.backups), []);
  });

  it("publishes automatic copies through the set marker without trying hard links, and settlement owns every file", async () => {
    const one = await twoTenants();
    mkdirSync(one.backups);
    const unsupported = () => {
      throw Object.assign(new Error("hard links are unsupported"), { code: "EPERM" });
    };
    const interrupted = prepareCopies(one.data, one.backups, new Date(START), true, unsupported);
    assert.ok(interrupted.every((copy) => copy.publication === "set" && !copy.guard && existsSync(copy.file)), "automatic preparation does not need hard links or per-file guards");
    writeFileSync(interrupted[1]!.file, "an interrupted final copy");
    assert.deepEqual(automaticBackups(one.backups), [], "final names are not backups before the set marker exists");
    assert.equal(settleCopies(interrupted), false);
    assert.deepEqual(backupsIn(one.backups), [], "the parent recognizes and removes its unpublished final copies");

    const copies = prepareCopies(one.data, one.backups, new Date(START + HOUR), true, unsupported);
    const taken = takeBackup({ dataDir: one.data, folder: one.backups, at: new Date(START + HOUR), automatic: { keep: 30 }, copies });
    assert.equal(taken.files.length, 2);
    assert.ok(copies.every((copy) => inspectTenantFile(copy.tenant, copy.file).ok), "each final inode is complete before the set marker publishes it");
    assert.deepEqual(automaticBackups(one.backups).map((backup) => backup.tenant).sort(), tenants);
    assert.equal(settleCopies(copies), true, "settlement recognizes the published copy inodes after the worker finishes");

    if (process.platform !== "win32") {
      const replaced = prepareCopies(one.data, one.backups, new Date(START + 2 * HOUR), true, unsupported);
      rmSync(replaced[0]!.file);
      execFileSync("mkfifo", [replaced[0]!.file]);
      const began = Date.now();
      assert.throws(() => takeBackup({ dataDir: one.data, folder: one.backups, at: new Date(START + 2 * HOUR), automatic: { keep: 30 }, copies: replaced }), /ENXIO|not the (?:file that was reserved|empty file that was made for this copy)/);
      assert.ok(Date.now() - began < 2_000, "a replacement FIFO is refused without waiting for a reader");
      assert.equal(lstatSync(replaced[0]!.file).isFIFO(), true, "the foreign replacement is left alone");
      rmSync(replaced[0]!.file);
    }
  });

  it("publishes none of a set when something takes its complete-marker name, and preserves that foreign file", async () => {
    const one = await twoTenants();
    automatic(one, START - HOUR);
    const before = backupsIn(one.backups);
    const marker = join(one.backups, setNamed(START), "complete.json");
    assert.throws(
      () =>
        automatic(one, START, {}, (point, tenant) => {
          if (point === "name" && tenant === "second") writeFileSync(marker, "someone else's marker");
        }),
      /complete\.json is in the way/,
    );
    assert.deepEqual(backupsIn(one.backups), before, "nothing of the backup that failed is left, under any name, and the earlier one is as it was");
    assert.equal(readFileSync(marker, "utf8"), "someone else's marker");
    assert.equal(newestWhole(one.backups, tenants, START + 100 * HOUR), START - HOUR);
  });

  it("preserves a replacement pending marker after publishing the complete set and reports it unconfirmed", async () => {
    const one = await twoTenants();
    const pending = join(one.backups, setNamed(START), "pending.json");
    const taken = automatic(one, START, {}, (point, tenant) => {
      if (point !== "name" || tenant !== "second") return;
      rmSync(pending);
      writeFileSync(pending, "someone else's pending marker");
    });
    assert.match(taken.unconfirmed!, /pending\.json is not the pending marker made for this backup set/);
    assert.equal(readFileSync(pending, "utf8"), "someone else's pending marker");
    assert.equal(newestWhole(one.backups, tenants, START + HOUR), START, "the durable complete marker still publishes the set");
  });

  it("never publishes a working file that was substituted after it was flushed", async () => {
    const one = await twoTenants();
    automatic(one, START - HOUR, {}, undefined, 1);
    const working = join(one.backups, named(START));
    assert.throws(
      () =>
        automatic(one, START, {}, (point, tenant) => {
          if (point !== "name" || tenant !== "default") return;
          rmSync(working);
          writeFileSync(working, "someone else's substituted file");
        }, 1),
      /is not the file that was made for this copy/,
    );
    assert.equal(readFileSync(working, "utf8"), "someone else's substituted file", "settlement leaves the foreign replacement alone");
    assert.equal(newestWhole(one.backups, tenants, START + HOUR), START - HOUR, "the substitution is not discoverable and cannot remove the last good backup");
  });

  it("is none of them when the size of a copy cannot be read: no copy has got its name by then", async () => {
    const one = await twoTenants();
    const renamed: string[] = [];
    assert.throws(
      () =>
        automatic(one, START, { rename: (from, to) => (renamed.push(to), renameSync(from, to)) }, (point, tenant) => {
          // The second tenant's copy goes missing when it has been written, before it is measured.
          if (point === "copied" && tenant === "second") rmSync(join(one.backups, named(START, "second")));
        }),
      /ENOENT/,
    );
    assert.deepEqual(renamed, []);
    assert.deepEqual(backupsIn(one.backups), []);
  });

  it("is not begun when something has one of its names already, and that thing is left as it is, whatever else lies there", async () => {
    const one = await twoTenants();
    mkdirSync(one.backups);
    // What lies beside backups is not claimed merely because it resembles an old staging name.
    const others = [`${named(START + HOUR)}.partial`, `${named(START - HOUR)}.partial-journal`];
    for (const name of others) writeFileSync(join(one.backups, name), "not this backup's");
    // Each final tenant name, then the set directory name, taken in turn by something else.
    const names = [...tenants.map((tenant) => named(START, tenant)), setNamed(START)];
    for (const [i, name] of names.entries()) {
      const inTheWay = join(one.backups, name);
      if (i % 3 === 0) writeFileSync(inTheWay, "someone else's");
      else if (i % 3 === 1) mkdirSync(inTheWay);
      else symlinkSync(join(one.backups, "nowhere"), inTheWay);
      assert.throws(() => automatic(one, START), (error: unknown) => error instanceof BackupRefused && error.message.startsWith(`${inTheWay} is in the way: `), name);
      assert.deepEqual(backupsIn(one.backups), name.endsWith("-auto.set") ? others.sort() : [...others, name].sort(), `${name}: no tenant file of the backup was made`);
      assert.notEqual(lstatSync(inTheWay, { throwIfNoEntry: false }), undefined, `${name}: the thing in the way is still there`);
      if (i % 3 === 0) assert.equal(readFileSync(inTheWay, "utf8"), "someone else's");
      rmSync(inTheWay, { recursive: true });
    }
    for (const name of others) assert.equal(readFileSync(join(one.backups, name), "utf8"), "not this backup's", name);
    // Sidecars under similar names are not claimed or removed: SQLite writes in private staging, so these are
    // somebody else's regardless of whether the backup succeeds.
    const sidecars = tenants.flatMap((tenant) => ["-journal", "-wal", "-shm"].map((suffix) => `${named(START, tenant)}.partial${suffix}`));
    for (const name of sidecars) writeFileSync(join(one.backups, name), "someone else's sidecar");
    // With every owned name free it is taken.
    assert.equal(automatic(one, START).files.length, 2);
    for (const name of sidecars) assert.equal(readFileSync(join(one.backups, name), "utf8"), "someone else's sidecar", name);
  });

  it("uses Vigile's reserved namespace for a backup by hand's transient files", async () => {
    const one = await instance();
    await one.start();
    await one.service.stop();
    mkdirSync(one.backups, { recursive: true });
    const copies = prepareCopies(one.data, one.backups, new Date(START), false);
    assert.equal(copies.every((copy) => basename(copy.working).startsWith(".vigile-") && basename(copy.working).endsWith(".sqlite.partial")), true);
    settleCopies(copies);
  });

  it("is whole and in place when its folder cannot be flushed, says that it is not confirmed, and removes no older one for it", async () => {
    const one = await twoTenants();
    automatic(one, START - 2 * HOUR, {}, undefined, 1);
    const unconfirmed = `What was written to ${one.backups} is in place, but the system could not confirm that it will survive a power cut: no`;
    const taken = automatic(
      one,
      START,
      {
        flush: () => {
          throw new Error(unconfirmed);
        },
      },
      undefined,
      1,
    );
    assert.equal(taken.unconfirmed, unconfirmed);
    assert.deepEqual(taken.files.map((file) => file.tenant), tenants);
    assert.deepEqual([taken.removed, taken.notRemoved], [[], []]);
    assert.deepEqual(backupsIn(one.backups), [named(START - 2 * HOUR), named(START), named(START - 2 * HOUR, "second"), named(START, "second")].sort());
    for (const tenant of tenants) assert.equal(inspectTenantFile(tenant, join(one.backups, named(START, tenant))).ok, true);
    assert.equal(newestWhole(one.backups, tenants, START), START);
  });

  it("is taken also when the older ones cannot be removed afterwards, and says which", async () => {
    const one = await twoTenants();
    automatic(one, START - 2 * HOUR);
    automatic(one, START - HOUR);
    const taken = takeBackup(
      { dataDir: one.data, folder: one.backups, at: new Date(START), automatic: { keep: 1 } },
      {
        remove: (file) => {
          throw new Error(`cannot remove ${file}`);
        },
      },
    );
    assert.deepEqual(taken.files.map((file) => file.tenant), tenants);
    assert.deepEqual(taken.removed, []);
    assert.equal(taken.notRemoved.length, 2, "retention reports one failure for each complete set, not one per tenant");
    assert.match(taken.notRemoved[0]!, /-auto\.set: cannot remove .*?complete\.json/);
    assert.equal(backupsIn(one.backups).length, 6);
    assert.equal(newestWhole(one.backups, tenants, START + 100 * HOUR), START);
    // The next one removes them.
    assert.equal(takeBackup({ dataDir: one.data, folder: one.backups, at: new Date(START + HOUR), automatic: { keep: 1 } }).removed.length, 6);
    assert.deepEqual(backupsIn(one.backups), [named(START + HOUR), named(START + HOUR, "second")]);
    assert.deepEqual(readdirSync(one.backups).filter((name) => name.endsWith("-auto.set")), [setNamed(START + HOUR)], "retention removes each expired marker directory with its tenant files");
  });

  it("bounds all complete sets globally when every tenant in older sets has since been removed", async () => {
    const one = await twoTenants();
    automatic(one, START - 3 * HOUR, {}, undefined, 3);
    automatic(one, START - 2 * HOUR, {}, undefined, 3);
    renameSync(join(one.data, "default.sqlite"), join(one.data, "third.sqlite"));
    rmSync(join(one.data, "second.sqlite"));

    automatic(one, START - HOUR, {}, undefined, 1);

    assert.equal(existsSync(join(one.backups, setNamed(START - 3 * HOUR))), false, "the oldest tenant-only set is retired");
    assert.equal(existsSync(join(one.backups, setNamed(START - 2 * HOUR))), false, "the other tenant-only set does not receive a separate retention quota");
    assert.equal(existsSync(join(one.backups, setNamed(START - HOUR))), true, "the current tenant's new set remains published");
  });

  it("resumes an interrupted retirement from its durable identities at the next successful backup", async () => {
    const one = await twoTenants();
    automatic(one, START - HOUR);
    const oldSet = join(one.backups, setNamed(START - HOUR));
    const taken = takeBackup(
      { dataDir: one.data, folder: one.backups, at: new Date(START), automatic: { keep: 1 } },
      {
        remove: (path) => {
          if (path === join(one.backups, named(START - HOUR, "second"))) throw new Error("retirement was interrupted");
          rmSync(path);
        },
      },
    );
    assert.equal(taken.notRemoved.length, 1);
    assert.equal(existsSync(join(oldSet, "complete.json")), false, "the old set is unpublished first");
    assert.equal(existsSync(join(oldSet, "pending.json")), true, "its durable ownership record remains");
    assert.equal(existsSync(join(one.backups, named(START - HOUR, "second"))), true, "the file after the interruption remains for recovery");

    takeBackup({ dataDir: one.data, folder: one.backups, at: new Date(START + HOUR), automatic: { keep: 1 } });
    assert.equal(existsSync(oldSet), false, "the next retention pass resumes and completes retirement");
    assert.deepEqual(automaticBackups(one.backups).map(({ at }) => at), tenants.map(() => START + HOUR));
  });

  it("keeps recovery metadata when settlement cannot remove an owned incomplete copy", async () => {
    const one = await twoTenants();
    mkdirSync(one.backups, { recursive: true });
    const copies = prepareCopies(one.data, one.backups, new Date(START), true);
    const blocked = copies[0]!.file;
    assert.equal(settleCopies(copies, (path) => {
      if (path === blocked) throw new Error("cannot remove the owned copy");
      rmSync(path, { force: true });
    }), false);
    assert.equal(existsSync(copies[0]!.set!.pending), true);
    assert.equal(existsSync(copies[0]!.set!.directory), true, "the set tombstone still suppresses legacy discovery");
    assert.deepEqual(automaticBackups(one.backups), []);

    await one.start();
    assert.equal(existsSync(blocked), false, "startup retries cleanup from the preserved identities");
    assert.equal(existsSync(copies[0]!.set!.directory), false);
  });

  it("preserves a foreign entry inside an expired set while retiring every owned part of that set", async () => {
    const one = await twoTenants();
    automatic(one, START - HOUR);
    const foreign = join(one.backups, setNamed(START - HOUR), "keep-me.txt");
    writeFileSync(foreign, "not part of the backup");

    const taken = automatic(one, START, {}, undefined, 1);
    assert.deepEqual(taken.removed, [], "a set directory left by a foreign entry is reported as not fully removed");
    assert.equal(taken.notRemoved.length, 1);
    assert.match(taken.notRemoved[0]!, /-auto\.set: /);
    assert.equal(readFileSync(foreign, "utf8"), "not part of the backup");
    assert.deepEqual(automaticBackups(one.backups).map(({ at }) => at), tenants.map(() => START), "the expired set is no longer discoverable after all of its owned files and marker are removed");
  });

  it("does not count any tenant from an incomplete set, and reclaims its owned files at the next start", async () => {
    const one = await twoTenants();
    automatic(one, START - 48 * HOUR);
    // An hour ago a backup was killed after the first copy had got its name and before the set marker committed it.
    const interrupted = prepareCopies(one.data, one.backups, new Date(START - HOUR), true);
    renameSync(interrupted[0]!.working, interrupted[0]!.file);
    assert.equal(newestWhole(one.backups, tenants, START + 100 * HOUR), START - 48 * HOUR);
    assert.equal(newestWhole(one.backups, ["default"], START), START - 48 * HOUR, "the set boundary applies even when only one tenant is asked about");

    await one.start();
    assert.equal(one.service.backups.status().last_at, iso(START - 48 * HOUR), "the moment that lacks a tenant's copy is no backup of the data");
    assert.equal(one.service.backups.status().next_due, iso(START - 24 * HOUR), "so one has been due for a day");
    assert.deepEqual(backupsIn(one.backups), [named(START - 48 * HOUR), named(START - 48 * HOUR, "second")].sort(), "every owned artifact of the incomplete set is reclaimed");
    assert.match((await one.doctor()).checks.find((check) => check.title === "automatic backups are on")!.detail!, new RegExp(`; last ${iso(START - 48 * HOUR).replace(".", "\\.")}, next due `));
    await one.pass(0);
    assert.deepEqual(backupsIn(one.backups), [named(START - 48 * HOUR), named(START), named(START - 48 * HOUR, "second"), named(START, "second")].sort());
    assert.equal(one.service.backups.status().last_at, iso(START));
    assert.deepEqual(one.warnings, []);
  });
});

/**
 * Every place at which a backup's thread can be ended or can die, with what of the backup is in the folder at
 * that instant. The thread is stopped exactly there: it says that it got there, and goes no further.
 */
const working = (tenant: string): string => named(START, tenant);
const PLACES: Array<{ when: string; point: BackupPoint; tenant?: string; there: string[]; whole: boolean }> = [
  { when: "before it has written anything", point: "start", there: [working("default"), working("second")], whole: false },
  { when: "between the making of the first working file and the first write to it", point: "copy", tenant: "default", there: [working("default"), working("second")], whole: false },
  { when: "during the copying, with one tenant's copy written and the next not begun", point: "copy", tenant: "second", there: [working("default"), working("second")], whole: false },
  { when: "after the last copy is written and before it is flushed", point: "copied", tenant: "second", there: [working("default"), working("second")], whole: false },
  { when: "after the last flush, before any copy has its name", point: "flushed", tenant: "second", there: [working("default"), working("second")], whole: false },
  { when: "before the set marker is published", point: "name", tenant: "second", there: [named(START), named(START, "second")], whole: false },
  { when: "after the last copy got its name, before it has said so", point: "named", there: [named(START), named(START, "second")], whole: true },
  { when: "while it removes older backups", point: "retention", there: [named(START), named(START, "second")], whole: true },
];

describe("a backup whose thread is ended or dies", () => {
  /** The files of the backup of the moment the tests take one at, as they lie in a folder. */
  const ofTheBackup = (names: string[]): string[] => names.filter((name) => tenants.some((tenant) => name.startsWith(named(START, tenant)))).sort();
  /** Waits until the thread says it has got to the place it stops at. */
  async function reached(flag: Int32Array): Promise<void> {
    for (const until = Date.now() + 30_000; Atomics.load(flag, 0) !== 1; ) {
      if (Date.now() > until) assert.fail("the backup's thread did not get to the place it was to stop at");
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  /** An instance with two tenants and two earlier backups, of which the next one keeps one. */
  async function prepared(): Promise<Instance> {
    const one = await twoTenants({ "backup.keep": "2" });
    automatic(one, START - 72 * HOUR);
    automatic(one, START - 48 * HOUR);
    return one;
  }
  const earlier = [named(START - 72 * HOUR), named(START - 48 * HOUR), named(START - 72 * HOUR, "second"), named(START - 48 * HOUR, "second")].sort();

  for (const place of PLACES) {
    it(`ended ${place.when}: the folder stays the service's past its stop, until the backup's files are settled, and the service that waited for the folder finds ${place.whole ? "the whole backup" : "nothing of the backup"}`, async () => {
      const first = await prepared();
      const second = await instance();
      setValue(second.config, "backup.folder", first.backups);
      const flag = new Int32Array(new SharedArrayBuffer(4));
      // The end of the thread takes as long as the test says: longer than the stop waits for it.
      let end!: () => void;
      const ended = new Promise<void>((resolve) => (end = resolve));
      await first.start({ stopMs: 20 }, { pause: { point: place.point, tenant: place.tenant, then: "wait", reached: flag.buffer as SharedArrayBuffer }, ending: () => ended });
      const attempt = first.service.backups.check();
      await reached(flag);
      assert.deepEqual(ofTheBackup(readdirSync(first.backups)), [...place.there].sort(), "what there is of the backup at that instant");

      await first.service.stop();
      assert.deepEqual(ofTheBackup(readdirSync(first.backups)), [...place.there].sort(), "the stop has returned at its deadline, and the backup is not over");

      // The second service wants the folder, and does not get it: it clears nothing in it and writes nothing to it.
      const found: string[][] = [];
      await second.start({}, { taken: (names) => found.push(names) });
      second.clock.now = START + HOUR;
      await second.pass(0);
      assert.equal(second.warnings.length, 1, second.warnings.join("\n"));
      assert.match(second.warnings[0]!, /failed: Another Vigile service takes its automatic backups into /);
      assert.equal(found.length, 0, "the folder was not the second one's at any time so far");
      assert.deepEqual(ofTheBackup(readdirSync(first.backups)), [...place.there].sort());
      // What the working file of another backup under way would look like. The first one's settling goes by
      // the files of its own backup, and does not touch it.
      const anothers = join(first.backups, `.vigile-${named(START + 5 * HOUR)}.partial`);
      writeFileSync(anothers, "not the first one's");

      // The thread's end is over. The first service settles the backup's files, and only then lets the folder go.
      end();
      await attempt;
      assert.equal(readFileSync(anothers, "utf8"), "not the first one's");
      assert.deepEqual(first.warnings, [], "a backup that the stop cut short has not failed");
      // How it ended is what the settling found: whole and unreported, or nothing left of it.
      const ending = first.service.backups.status().outcome!;
      assert.deepEqual([ending.at, ending.kind], [iso(START), place.whole ? "complete_unreported" : "incomplete"]);
      assert.equal(first.service.backups.status().last_at, iso(place.whole ? START : START - 48 * HOUR));

      // Now the second one gets the folder. What it finds there at that moment, before it has cleared or written anything:
      // A backup of the first one's that is whole is the newest in the folder for the second as well: the second
      // takes its own when that one is a day old.
      await second.pass(place.whole ? 24 * HOUR : 10 * MINUTE);
      assert.equal(found.length, 1);
      assert.deepEqual(ofTheBackup(found[0]!), place.whole ? [named(START), named(START, "second")] : [], place.whole ? "the backup, whole" : "nothing of the backup that was cut short");
      assert.deepEqual(found[0]!.filter((name) => name.endsWith("-auto.sqlite") && !ofTheBackup([name]).length).sort(), earlier, "and the earlier backups, all of them");
      // And what it then writes is its own, and stays.
      const own = named(START + HOUR + (place.whole ? 24 * HOUR : 10 * MINUTE));
      assert.deepEqual(second.automatic(first.backups).filter((name) => !earlier.includes(name) && !ofTheBackup([name]).length), [own]);
      assert.equal(second.service.backups.status().failure, null);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(inspectTenantFile("default", join(first.backups, own)).ok, true);
      assert.deepEqual(backupsIn(first.backups).filter((name) => name.includes(".partial")), [], "no working file of anyone's is left");
    });
  }

  for (const place of PLACES) {
    it(`dies ${place.when}: ${place.whole ? "the backup is whole and stays, and the log and the doctor say that it is in place and was not reported" : "nothing of the backup is left, and the log and the doctor say that it failed"}, and the folder is still the service's`, async () => {
      const one = await prepared();
      const other = await instance();
      setValue(other.config, "backup.folder", one.backups);
      const flag = new Int32Array(new SharedArrayBuffer(4));
      await one.start({}, { pause: { point: place.point, tenant: place.tenant, then: "die", reached: flag.buffer as SharedArrayBuffer } });
      await one.pass(0);
      assert.equal(Atomics.load(flag, 0), 1, "the thread got to the place it died at");
      assert.deepEqual(backupsIn(one.backups), [...earlier, ...(place.whole ? [named(START), named(START, "second")] : [])].sort());
      const status = one.service.backups.status();
      const doctor = (await one.doctor()).checks.find((check) => check.title === "last automatic backup worked")!;
      if (place.whole) {
        // The backup is whole and in place, and nobody said so: that is what is said, and it has not failed.
        const said = `The automatic backup into ${one.backups} is whole and in place, but what wrote it ended without reporting how it went. Whether older backups were removed is not known; the next backup removes them.`;
        assert.deepEqual(one.warnings, [said]);
        assert.equal(one.logged.filter((line) => / backup=automatic result=unreported copies=2 kb=\d+ removed=0 ms=\d+ folder=/.test(line)).length, 1);
        assert.deepEqual(status, { enabled: true, every_hours: 24, folder: one.backups, keep: 2, last_at: iso(START), next_due: iso(START + 24 * HOUR), running: false, failure: null, outcome: { at: iso(START), kind: "complete_unreported", said }, unread: null });
        assert.deepEqual([doctor.level, doctor.detail, doctor.fix], ["warn", `taken ${iso(START)}; the next is due ${iso(START + 24 * HOUR)}. ${said}`, "The backup itself is in place. If this is said again of the next one, look at the service's log."]);
      } else {
        // Nothing of it remains, and that it did not become whole is what is said.
        const reason = "The thread that wrote the backup ended before the backup was whole, and without saying why.";
        assert.equal(one.warnings.length, 1, one.warnings.join("\n"));
        assert.match(one.warnings[0]!, new RegExp(`^The automatic backup into ${one.backups} failed: ${reason.replace(".", "\\.")} Check that .* It is tried again at ${iso(START + 10 * MINUTE).replace(".", "\\.")}; the service goes on meanwhile\\.$`));
        assert.equal(one.logged.filter((line) => line.includes("backup=automatic")).length, 0);
        assert.deepEqual([status.last_at, status.next_due, status.outcome], [iso(START - 48 * HOUR), iso(START + 10 * MINUTE), { at: iso(START), kind: "incomplete", said: reason }]);
        assert.deepEqual([status.failure!.at, status.failure!.reason, status.failure!.retry_at], [iso(START), reason, iso(START + 10 * MINUTE)]);
        assert.deepEqual([doctor.level, doctor.detail], ["fail", `failed at ${iso(START)}: ${reason}`]);
      }
      // The folder is still held by the service, which runs: another one does not get it.
      await other.start();
      await other.pass(0);
      assert.match(other.warnings[0]!, /failed: Another Vigile service takes its automatic backups into /);
      await other.service.stop();
      // The thread that died held the tenants' files: they are free, and the next backup is taken.
      await one.service.stop();
      await one.start();
      // Started again, the service knows how its last backup ended, and waits as it would have.
      assert.deepEqual(one.service.backups.status().outcome, status.outcome);
      assert.deepEqual(one.service.backups.status().failure, status.failure);
      assert.equal(one.service.backups.status().last_at, iso(place.whole ? START : START - 48 * HOUR));
      await one.pass(0);
      assert.deepEqual(backupsIn(one.backups), [...earlier, ...(place.whole ? [named(START), named(START, "second")] : [])].sort(), "not tried again at the start");
      await one.pass(place.whole ? 24 * HOUR : 10 * MINUTE);
      assert.equal(one.service.backups.status().failure, null);
      assert.deepEqual(backupsIn(one.backups).filter((name) => name.includes(".partial")), []);
      assert.equal(one.service.backups.status().last_at, iso(place.whole ? START + 24 * HOUR : START + 10 * MINUTE));
    });
  }
});

describe("the clock of the machine, moved", () => {
  it("back a month, with a backup dated ahead of it: one is taken at once, and restarts every ten hours do not put the next one off", async () => {
    const one = await instance();
    const ahead = START + 30 * 24 * HOUR;
    one.clock.now = ahead;
    await one.start();
    await one.pass(0);
    await one.service.stop();

    // The clock is set back thirty days. The backup dated ahead of it says nothing of when the last one was:
    // one is due now. The run before ended a backup at a date that now lies ahead, so how long ago that was is
    // not known: this run waits the ten minutes it waits after any backup, and no longer.
    one.clock.now = START - 10 * MINUTE;
    await one.start();
    assert.deepEqual([one.service.backups.status().last_at, one.service.backups.status().next_due], [null, iso(START)]);
    await one.pass(0);
    assert.deepEqual(one.automatic(), [named(ahead)]);
    await one.pass(10 * MINUTE);
    assert.deepEqual(one.automatic(), [named(START), named(ahead)]);
    // Restarted every ten hours, the next one stays due a day after that one, by the file that says so.
    for (const hours of [10, 20]) {
      await one.service.stop();
      one.clock.mono += 10 * HOUR;
      one.clock.now = START + hours * HOUR;
      await one.start();
      assert.deepEqual([one.service.backups.status().last_at, one.service.backups.status().next_due], [iso(START), iso(START + 24 * HOUR)], `after ${hours} hours`);
      await one.pass(0);
      assert.deepEqual(one.automatic(), [named(START), named(ahead)], `after ${hours} hours`);
    }
    await one.service.stop();
    one.clock.mono += 10 * HOUR;
    one.clock.now = START + 30 * HOUR;
    await one.start();
    assert.equal(one.service.backups.status().next_due, iso(START + 24 * HOUR), "due for six hours by the time of the third restart");
    await one.pass(0);
    assert.deepEqual(one.automatic(), [named(START), named(START + 30 * HOUR), named(ahead)]);
    assert.deepEqual(one.warnings, []);
    assert.match((await one.doctor()).checks.find((check) => check.title === "last automatic backup worked")!.detail!, new RegExp(`^taken ${iso(START + 30 * HOUR).replace(".", "\\.")}; `));
  });

  it("back a month, with a month of backups dated ahead of it and the usual thirty kept: the ones taken since are kept, and the ones dated ahead make room", async () => {
    const one = await instance();
    await one.start();
    await one.service.stop();
    // Thirty daily backups of a clock that ran a month ahead, at noon where the ones to come are at midnight.
    const ahead = Array.from({ length: 30 }, (_, i) => START + (i + 1) * 24 * HOUR + 12 * HOUR);
    for (const at of ahead) automatic(one, at);
    assert.equal(one.automatic().length, 30);

    await one.start();
    assert.equal(one.service.backups.status().last_at, null);
    const since: number[] = [];
    for (let day = 0; day < 10; day++) {
      await one.pass(day === 0 ? 0 : 24 * HOUR);
      since.push(START + day * 24 * HOUR);
      const have = one.automatic();
      assert.equal(have.length, 30, `day ${day}`);
      assert.deepEqual(have.filter((name) => since.some((at) => name === named(at))), since.map((at) => named(at)), `day ${day}: every backup taken since the clock was set back is there`);
      assert.equal(one.service.backups.status().last_at, iso(START + day * 24 * HOUR));
    }
    // What made room were backups dated ahead of the clock, never one taken since.
    assert.equal(one.automatic().filter((name) => ahead.some((at) => name === named(at))).length, 20);
    assert.equal(one.logged.filter((line) => line.includes("backup=automatic") && line.includes(" removed=1 ")).length, 10);
    assert.deepEqual(one.warnings, []);
  });

  it("while the service runs: back past the last backup makes none due before an earlier one is a day old, forward by any length makes one due, and the time zone changes nothing", async () => {
    const one = await instance();
    await one.start();
    await one.pass(0);
    await one.pass(24 * HOUR);
    await one.pass(24 * HOUR);
    const taken = [named(START), named(START + 24 * HOUR), named(START + 48 * HOUR)];
    assert.deepEqual(one.automatic(), taken);

    // Back twelve hours, across the last backup: the one before it is the last now, and is twelve hours old.
    await one.pass(-12 * HOUR);
    // The next is not due when that one is a day old: by then the one dated ahead counts again, and is new.
    assert.deepEqual([one.service.backups.status().last_at, one.service.backups.status().next_due], [iso(START + 24 * HOUR), iso(START + 72 * HOUR)]);
    assert.deepEqual(one.automatic(), taken);
    // Back onto the very moment of a backup: that one is the last, taken just now, and nothing is due.
    one.clock.now = START + 24 * HOUR;
    await one.pass(0);
    assert.deepEqual(one.automatic(), taken);
    // Back before every backup there is: one is due now. It is not begun within ten minutes of the last one,
    // however the clock stands, and is taken once those have passed; and not again at the next look.
    one.clock.now = START - 5 * HOUR - 10 * MINUTE;
    await one.pass(0);
    assert.deepEqual(one.automatic(), taken);
    assert.deepEqual([one.service.backups.status().last_at, one.service.backups.status().next_due], [null, iso(START - 5 * HOUR)]);
    await one.pass(10 * MINUTE);
    assert.deepEqual(one.automatic(), [named(START - 5 * HOUR), ...taken]);
    await one.pass(MINUTE);
    await one.pass(HOUR);
    assert.equal(one.automatic().length, 4, "no further one before that one is a day old");
    // The next is due a day after the newest of the three that lie ahead: each of them counts when the clock has come to it.
    assert.equal(one.service.backups.status().next_due, iso(START + 72 * HOUR));
    // As the clock goes on, it comes to the backups that were dated ahead of it: each counts again from its own
    // moment on, as it would at a start, and none is taken while one of them is less than a day old.
    await one.pass(23 * HOUR - MINUTE);
    assert.deepEqual(one.automatic(), [named(START - 5 * HOUR), ...taken]);
    assert.deepEqual([one.service.backups.status().last_at, one.service.backups.status().next_due], [iso(START), iso(START + 72 * HOUR)]);
    await one.pass(5 * HOUR);
    await one.pass(24 * HOUR);
    assert.deepEqual(one.automatic(), [named(START - 5 * HOUR), ...taken]);
    await one.pass(24 * HOUR);
    assert.deepEqual(one.automatic(), [named(START - 5 * HOUR), ...taken, named(START + 72 * HOUR)]);
    // Forward a year: one backup, not one for each day.
    await one.pass(365 * 24 * HOUR);
    assert.equal(one.automatic().length, 6);
    assert.equal(one.service.backups.status().last_at, iso(START + 72 * HOUR + 365 * 24 * HOUR));

    // The moment in a name is in UTC wherever the machine thinks it is.
    const zone = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati";
      await one.pass(24 * HOUR);
      const at = START + 72 * HOUR + 366 * 24 * HOUR;
      assert.equal(one.automatic().at(-1), `default-${iso(at).replace(/[-:]/g, "").replace("T", "-").replace(".", "-").replace("Z", "")}-auto.sqlite`);
      assert.equal(automaticBackups(one.backups).some((backup) => backup.at === at), true);
      process.env.TZ = "America/Los_Angeles";
      await one.pass(24 * HOUR - 1);
      assert.equal(one.automatic().length, 7, "a change of time zone makes none due");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
    assert.deepEqual(one.warnings, []);
  });

});

describe("the clock of the machine set back before any backup of this run was taken", () => {
  it("before the first look, with no backup there: the first backup is taken at the first look, not when the clock has caught up", async () => {
    const one = await instance();
    await one.start();
    assert.equal(one.service.backups.status().next_due, iso(START));
    // Thirty days back, before the service has looked once.
    one.clock.now = START - 30 * 24 * HOUR;
    assert.equal(one.service.backups.status().next_due, iso(START - 30 * 24 * HOUR), "due now, as the clock now stands");
    await one.pass(0);
    assert.deepEqual(one.automatic(), [named(START - 30 * 24 * HOUR)]);
    assert.deepEqual(one.warnings, []);
  });

  it("while a backup that failed waits to be tried again: it is tried after ten minutes that have passed, and the status says when by the clock as it stands", async () => {
    const one = await instance();
    writeFileSync(one.backups, "in the way");
    await one.start();
    await one.pass(0);
    assert.equal(one.warnings.length, 1);
    assert.deepEqual([one.service.backups.status().failure!.retry_at, one.service.backups.status().next_due], [iso(START + 10 * MINUTE), iso(START + 10 * MINUTE)]);
    // Four minutes pass, and the clock is set back thirty days.
    await one.pass(4 * MINUTE);
    const back = START + 4 * MINUTE - 30 * 24 * HOUR;
    one.clock.now = back;
    assert.deepEqual([one.service.backups.status().failure!.retry_at, one.service.backups.status().next_due], [iso(back + 6 * MINUTE), iso(back + 6 * MINUTE)], "six minutes are left, whatever the date");
    await one.pass(6 * MINUTE - 1);
    assert.equal(one.warnings.length, 1, "not before the ten minutes have passed");
    await one.pass(1);
    assert.equal(one.warnings.length, 2, "tried again, ten minutes after it failed");
    assert.match(one.warnings[1]!, new RegExp(`It is tried again at ${iso(back + 16 * MINUTE).replace(".", "\\.")};`));
    // Set forward a year meanwhile, it is not tried sooner either; and once the folder can be made it is taken.
    rmSync(one.backups);
    one.clock.now += 365 * 24 * HOUR;
    await one.pass(0);
    assert.equal(existsSync(one.backups), false);
    await one.pass(10 * MINUTE);
    assert.deepEqual(one.automatic(), [named(back + 16 * MINUTE + 365 * 24 * HOUR)]);
    assert.equal(one.service.backups.status().failure, null);
  });
});

describe("the clock of the machine set back while a backup that failed waits, to where an earlier backup is fresh", () => {
  it("has the status and the doctor give the time at which that backup is a day old, and that is when the next try comes", async () => {
    const one = await instance();
    one.clock.now = START - 30 * HOUR;
    await one.start();
    await one.pass(0);
    assert.deepEqual(one.automatic(), [named(START - 30 * HOUR)]);
    // Thirty hours on one is due, and fails: something stands where its copy would be written.
    mkdirSync(join(one.backups, named(START)));
    await one.pass(30 * HOUR);
    assert.equal(one.warnings.length, 1, one.warnings.join("\n"));
    assert.match(one.warnings[0]!, new RegExp(`is in the way: .* It is tried again at ${iso(START + 10 * MINUTE).replace(".", "\\.")}; `));
    assert.deepEqual([one.service.backups.status().failure!.retry_at, one.service.backups.status().next_due], [iso(START + 10 * MINUTE), iso(START + 10 * MINUTE)]);

    // The clock is set back twenty hours. The backup that is there is ten hours old now: no try is due before
    // it is a day old, which is long after the ten minutes are over, and that is the time everything gives.
    one.clock.now = START - 20 * HOUR;
    const then = iso(START - 6 * HOUR);
    const status = one.service.backups.status();
    assert.deepEqual([status.last_at, status.next_due, status.failure!.at, status.failure!.retry_at], [iso(START - 30 * HOUR), then, iso(START), then]);
    const doctor = (await one.doctor()).checks.find((check) => check.title === "last automatic backup worked")!;
    assert.deepEqual([doctor.level, doctor.detail, doctor.fix], ["fail", `failed at ${iso(START)}: ${status.failure!.reason}`, `${status.failure!.actions.join(" ")} The service tries again at ${then}.`]);
    // Ten minutes on, the wait is over, and it is still that time: none is tried.
    await one.pass(10 * MINUTE);
    assert.equal(one.service.backups.status().failure!.retry_at, then);
    assert.equal(one.warnings.length, 1);
    // A millisecond before it none is tried, and at it one is, and is taken.
    await one.pass(14 * HOUR - 10 * MINUTE - 1);
    assert.deepEqual([one.automatic(), one.service.backups.status().failure!.retry_at], [[named(START - 30 * HOUR)], then]);
    await one.pass(1);
    assert.deepEqual(one.automatic(), [named(START - 30 * HOUR), named(START - 6 * HOUR)]);
    assert.deepEqual([one.service.backups.status().failure, one.service.backups.status().next_due], [null, iso(START + 18 * HOUR)]);
  });
});

describe("the schedule as a machine of two clocks", () => {
  it("caps a restored remaining wait at the configured retry pause", () => {
    const kept: Remembered = { folder: "/b", at: START, ended: START, steady: 100, wait: 1e308, kind: "incomplete", said: "failed", actions: [] };
    assert.equal(rememberedWait(kept, "/b", START, 200, 10 * MINUTE), 10 * MINUTE - 100);
  });

  /** A step: what moves, what the store then does, and what the schedule is to make of it at its next look. */
  interface Step {
    /** Time that passes: on both clocks. */
    pass?: number;
    /** The clock of the machine set, forward or back, with no time passing. */
    set?: number;
    /** Time that passes without the clock of the machine moving. */
    monoOnly?: number;
    /** The machine restarted and its uptime began again at this value. */
    reboot?: number;
    /** From here on the store fails, or works again. */
    store?: "fails" | "works";
    /** A new run of the service on the same folder, with what the run before kept. */
    restart?: true;
    /** What the run before kept, in place of what it did keep: nothing, something that cannot be read, or a backup begun at a time from the start of the test and never ended. */
    kept?: "nothing" | "unreadable" | { begun: number };
    /** What the schedule warns of at this step, when it warns. */
    warns?: RegExp;
    /** A backup that someone removes from the folder: the newest there is, or the oldest. */
    gone?: "newest" | "oldest";
    /** A backup that someone puts into the folder, dated so long after the start of the test. */
    put?: number;
    /** Whether a backup is begun at this look. */
    tries: boolean;
    /** When the next is due after the look, and when a failed one is tried again, from the start of the test on the machine's clock. */
    due?: number;
    retry?: number | null;
  }
  const DAY = 24 * HOUR;
  const CASES: Array<{ name: string; have?: number[]; every?: number; steps: Step[] }> = [
    {
      name: "the clock set back before the first look, with nothing there: the first look takes one",
      steps: [{ set: -30 * DAY, tries: true, due: -29 * DAY }, { pass: MINUTE, tries: false }, { pass: DAY, tries: true }],
    },
    {
      name: "the clock set back before the first look, behind the only backup: the first look takes one",
      have: [-HOUR],
      // The one that is there is dated an hour ahead now, and counts again in an hour: the next is due a day after it.
      steps: [{ set: -2 * HOUR, tries: true, due: 23 * HOUR }],
    },
    {
      name: "a first look with a fresh backup there takes none, and one when that is a day old",
      have: [-HOUR],
      steps: [{ tries: false, due: 23 * HOUR }, { pass: 23 * HOUR - 1, tries: false }, { pass: 1, tries: true, due: 47 * HOUR }],
    },
    {
      name: "the clock set back while one that failed waits: tried when ten minutes have passed, whatever the date",
      steps: [
        { store: "fails", tries: true, due: 10 * MINUTE, retry: 10 * MINUTE },
        { pass: 5 * MINUTE, tries: false, retry: 10 * MINUTE },
        { set: -30 * DAY, tries: false, due: -30 * DAY + 5 * MINUTE, retry: -30 * DAY + 5 * MINUTE },
        { pass: 5 * MINUTE - 1, tries: false },
        { pass: 1, tries: true, retry: -30 * DAY + 15 * MINUTE },
        { store: "works", pass: 10 * MINUTE, tries: true, retry: null, due: -29 * DAY + 15 * MINUTE },
      ],
    },
    {
      name: "the clock set back, while one that failed waits, to where an earlier backup is fresh: tried again when that one is a day old, and that is the time given",
      have: [-30 * HOUR],
      steps: [
        { store: "fails", tries: true, due: 10 * MINUTE, retry: 10 * MINUTE },
        // Twenty hours back: the backup of thirty hours ago is ten hours old, and no try is due before it is a day old.
        { set: -20 * HOUR, tries: false, due: -6 * HOUR, retry: -6 * HOUR },
        { pass: 10 * MINUTE, tries: false, due: -6 * HOUR, retry: -6 * HOUR },
        { set: -6 * HOUR - 1, monoOnly: HOUR, tries: false, retry: -6 * HOUR },
        { pass: 1, tries: true, retry: -6 * HOUR + 10 * MINUTE },
      ],
    },
    {
      name: "the clock set back, while one that failed waits, to where an earlier backup is fresh for less than the wait: tried again when the wait is over",
      have: [-30 * HOUR],
      steps: [
        { store: "fails", tries: true, retry: 10 * MINUTE },
        // Back to five minutes before that backup is a day old: the wait of ten minutes is the longer.
        { set: -6 * HOUR - 5 * MINUTE, tries: false, due: -6 * HOUR + 5 * MINUTE, retry: -6 * HOUR + 5 * MINUTE },
        { pass: 10 * MINUTE - 1, tries: false },
        { pass: 1, tries: true },
      ],
    },
    {
      name: "the backup before the last one was removed to make room, and the clock is set back between the two: none counts, and one is taken",
      steps: [
        { tries: true },
        { pass: DAY, tries: true },
        // The one that makes room for the second removes the first.
        { gone: "oldest", pass: HOUR, tries: false, due: 2 * DAY },
        // Back to twelve hours after the first, which is not there any more: the one that is there is dated ahead.
        { set: 12 * HOUR, tries: true, due: 2 * DAY },
        { pass: 12 * HOUR - 1, tries: false },
      ],
    },
    {
      name: "a backup removed by hand between two looks is no backup at the next: one is due, and is taken when ten minutes have passed since the last",
      steps: [{ tries: true }, { gone: "newest", pass: MINUTE, tries: false, due: 10 * MINUTE }, { pass: 9 * MINUTE, tries: true, due: DAY + 10 * MINUTE }],
    },
    {
      name: "a backup put into the folder by someone else counts from its own moment: none is taken while it is fresh",
      have: [-30 * HOUR],
      steps: [{ put: -HOUR, tries: false, due: 23 * HOUR }, { gone: "newest", tries: true }, { put: 12 * HOUR, pass: HOUR, tries: false, due: 36 * HOUR }],
    },
    {
      name: "the clock set forward while one that failed waits: not tried before the ten minutes have passed",
      steps: [
        { store: "fails", tries: true, retry: 10 * MINUTE },
        { set: 30 * DAY, tries: false, retry: 30 * DAY + 10 * MINUTE },
        { store: "works", pass: 10 * MINUTE - 1, tries: false },
        { pass: 1, tries: true, retry: null },
      ],
    },
    {
      name: "ten minutes pass with the clock of the machine standing still: one that failed is tried again",
      steps: [{ store: "fails", tries: true }, { monoOnly: 10 * MINUTE - 1, tries: false }, { monoOnly: 1, tries: true }],
    },
    {
      name: "the clock set back after a backup was taken, to where an earlier one is fresh: none, until that one is a day old",
      have: [-12 * HOUR - DAY],
      steps: [{ tries: true }, { pass: HOUR, tries: false }, { set: -DAY, tries: false, due: -12 * HOUR }, { pass: 12 * HOUR - 1, tries: false }, { pass: 1, tries: true }],
    },
    {
      name: "the clock set back after a backup was taken, behind every backup: one, once ten minutes have passed since the last",
      steps: [{ tries: true }, { set: -10 * DAY, tries: false, due: -10 * DAY + 10 * MINUTE }, { pass: 10 * MINUTE - 1, tries: false }, { pass: 1, tries: true, due: -9 * DAY + 10 * MINUTE }, { pass: HOUR, tries: false }],
    },
    {
      name: "the clock set forward, a month: one backup, and the next a day after it",
      have: [-HOUR],
      steps: [{ set: 30 * DAY, tries: true, due: 31 * DAY }, { pass: HOUR, tries: false }, { pass: 23 * HOUR, tries: true }],
    },
    {
      name: "the clock set back and forth, again and again: a backup for each place that has none, never two within ten minutes",
      steps: [
        { tries: true },
        { pass: 10 * MINUTE, tries: false },
        { set: -10 * DAY, tries: true },
        { set: 10 * MINUTE, tries: false },
        { set: -10 * DAY, tries: false },
        { set: -20 * DAY, tries: false },
        { pass: 10 * MINUTE, tries: true },
        { set: -10 * DAY + HOUR, tries: false },
        { set: HOUR, tries: false },
        { pass: DAY, tries: true },
      ],
    },
    {
      name: "the clock set back at every look, each time behind every backup: one backup in ten minutes, not one a look",
      steps: [{ tries: true }, ...Array.from({ length: 9 }, (_, i): Step => ({ set: -(i + 1) * DAY, pass: undefined, monoOnly: MINUTE, tries: false })), { set: -20 * DAY, monoOnly: MINUTE, tries: true }],
    },
    {
      name: "a machine that slept: both clocks jump, or only the machine's, and one backup is taken",
      have: [-HOUR],
      steps: [{ pass: 8 * HOUR, tries: false }, { pass: 15 * HOUR, tries: true }, { set: 23 * HOUR + 30 * HOUR, tries: false }, { monoOnly: 10 * MINUTE, tries: true }, { pass: 90 * DAY, tries: true }, { pass: MINUTE, tries: false }],
    },
    {
      name: "a restart with a fresh backup there takes none, and one when that is a day old",
      steps: [{ tries: true }, { restart: true, pass: 10 * HOUR, tries: false, due: DAY }, { restart: true, pass: 10 * HOUR, tries: false, due: DAY }, { restart: true, pass: 10 * HOUR, tries: true, due: 30 * HOUR + DAY }],
    },
    {
      name: "restarted every minute while the store fails: a try every ten minutes, as without the restarts, and the failure is still the failure",
      steps: [
        { store: "fails", tries: true, retry: 10 * MINUTE },
        ...Array.from({ length: 9 }, (_, i): Step => ({ restart: true, pass: MINUTE, tries: false, retry: 10 * MINUTE, due: 10 * MINUTE })),
        { restart: true, pass: MINUTE, tries: true, retry: 20 * MINUTE },
        ...Array.from({ length: 9 }, (): Step => ({ restart: true, pass: MINUTE, tries: false, retry: 20 * MINUTE })),
        { restart: true, pass: MINUTE, store: "works", tries: true, retry: null },
        { restart: true, pass: MINUTE, tries: false },
      ],
    },
    {
      name: "restarted right after a backup was taken, with the clock set back behind every backup: none within ten minutes of that one",
      steps: [{ tries: true }, { restart: true, set: -10 * DAY, tries: false, due: -10 * DAY + 10 * MINUTE }, { pass: 10 * MINUTE - 1, tries: false }, { pass: 1, tries: true }],
    },
    {
      name: "restarted with the clock set back while one that failed waits: only elapsed time remains",
      steps: [
        { store: "fails", tries: true },
        { pass: 9 * MINUTE, tries: false },
        { restart: true, set: -30 * DAY, tries: false, retry: -30 * DAY + MINUTE },
        { pass: MINUTE - 1, tries: false },
        { pass: 1, tries: true },
      ],
    },
    {
      name: "restarted with the clock set forward while one that failed waits: wall time alone does not end the pause",
      steps: [{ store: "fails", tries: true }, { restart: true, set: 30 * DAY, tries: false, retry: 30 * DAY + 10 * MINUTE }, { pass: 10 * MINUTE, tries: true }],
    },
    {
      name: "a reboot and backward wall clock reanchor one pause instead of restarting it at every service restart",
      steps: [
        { store: "fails", tries: true, retry: 10 * MINUTE },
        { set: -HOUR, reboot: 100, restart: true, tries: false, retry: -HOUR + 10 * MINUTE },
        { pass: 4 * MINUTE, restart: true, tries: false, retry: -HOUR + 10 * MINUTE },
        { pass: 6 * MINUTE, store: "works", tries: true, due: -HOUR + 10 * MINUTE + DAY },
      ],
    },
    {
      name: "a reboot partway through a pause preserves its deadline across another service restart",
      steps: [
        { store: "fails", tries: true, retry: 10 * MINUTE },
        { pass: 5 * MINUTE, reboot: 100, restart: true, tries: false, retry: 10 * MINUTE },
        { pass: 2 * MINUTE, restart: true, tries: false, retry: 10 * MINUTE },
        { pass: 3 * MINUTE, store: "works", tries: true, due: 10 * MINUTE + DAY },
      ],
    },
    {
      name: "a service killed when it had begun a backup: the next run waits what is left of ten minutes since, then tries",
      steps: [{ restart: true, kept: { begun: -4 * MINUTE }, tries: false, due: 6 * MINUTE }, { pass: 6 * MINUTE - 1, tries: false }, { pass: 1, tries: true }],
    },
    {
      name: "a service killed when its backup was whole and it had not yet kept that: the next run goes by the backup, which is fresh",
      have: [-4 * MINUTE],
      steps: [{ restart: true, kept: { begun: -4 * MINUTE }, tries: false, due: DAY - 4 * MINUTE }, { pass: 10 * MINUTE, tries: false }, { pass: DAY, tries: true }],
    },
    {
      name: "a service killed long ago when it had begun a backup: the next run tries at once",
      steps: [{ restart: true, kept: { begun: -DAY }, tries: true }],
    },
    {
      name: "what was kept cannot be read: the recovery pause is kept across restarts and does not postpone the next attempt",
      steps: [
        { restart: true, kept: "unreadable", tries: false, due: 10 * MINUTE, warns: /^What the service kept of its last automatic backup cannot be read: it is not what the service writes there\. No backup is begun before 2026-11-13T09:10:00\.000Z, as after one that has just ended; the pause is kept anew\.$/ },
        { restart: true, pass: 3 * MINUTE, tries: false, due: 10 * MINUTE },
        { restart: true, pass: 3 * MINUTE, tries: false, due: 10 * MINUTE },
        { restart: true, pass: 4 * MINUTE, store: "fails", tries: true },
        { restart: true, pass: MINUTE, tries: false, retry: 20 * MINUTE },
      ],
    },
    {
      name: "nothing was kept, as after an upgrade or when the file was removed: the run begins as if none had been begun",
      steps: [{ store: "fails", tries: true }, { restart: true, kept: "nothing", pass: MINUTE, tries: true }],
    },
    {
      name: "a store that fails for a day, looked at every half minute: a try every ten minutes of time that passes, and no more",
      steps: [{ store: "fails", tries: true }, ...Array.from({ length: 60 }, (_, i): Step => ({ pass: MINUTE / 2, tries: (i + 1) % 20 === 0 }))],
    },
    {
      name: "every quarter of an hour: tried again after ten minutes when it fails, taken every fifteen when it works",
      every: 0.25,
      steps: [{ tries: true, due: 15 * MINUTE }, { pass: 15 * MINUTE - 1, tries: false }, { pass: 1, store: "fails", tries: true, retry: 25 * MINUTE }, { pass: 10 * MINUTE, store: "works", tries: true, due: 40 * MINUTE }],
    },
    {
      name: "every six minutes, less than any config takes: one that failed is tried again after the six, not the ten",
      every: 0.1,
      steps: [{ store: "fails", tries: true, retry: 6 * MINUTE }, { pass: 6 * MINUTE - 1, tries: false }, { pass: 1, tries: true }],
    },
  ];

  /** A folder of backups, a store that works or fails, two clocks, and what a run keeps for the next: all that a schedule goes by. */
  function world(have: number[], every: number) {
    /** The moments of the whole backups in the folder, which outlive a run. */
    const folder = have.map((offset) => START + offset);
    const state = { wall: START, mono: 5_000, fails: false, tries: 0, kept: null as Remembered | null | "unreadable" };
    const warned: string[] = [];
    /** What a run keeps for the next, as the data folder would hold it. */
    const memory: BackupMemory = {
      read: () => {
        if (state.kept === "unreadable") throw new Error("it is not what the service writes there");
        return state.kept;
      },
      write: (remembered) => void (state.kept = remembered),
    };
    const source: BackupSource = {
      moments: () => [...folder],
      take: (at) => {
        state.tries++;
        if (!state.fails) folder.push(at);
        const ended: BackupOutcome = state.fails ? { kind: "incomplete", reason: "no room", actions: [] } : { kind: "complete", copies: 1, bytes: 1, removed: 0 };
        return { done: Promise.resolve(ended), cancel: async () => {} };
      },
      close: async () => {},
    };
    const run = () => startBackups({ everyHours: every, folder: "/b", keep: 30, source, now: () => state.wall, monotonic: () => state.mono, memory, times: { ...BACKUP_TIMES, firstMs: 1_000_000_000, checkMs: 1_000_000_000 }, log: () => {}, warn: (line) => warned.push(line) });
    return { state, warned, folder, run, schedule: run() };
  }
  type World = ReturnType<typeof world>;
  /** The newest backup in the folder that is not dated after now, which is the last one there is. */
  const lastThere = (of: World): string | null => {
    const counted = of.folder.filter((at) => at <= of.state.wall);
    return counted.length ? iso(Math.max(...counted)) : null;
  };
  /** Does what a step says, has the schedule look, and says whether a backup was begun. */
  async function take(of: World, step: Omit<Step, "tries">, i: number): Promise<boolean> {
    const { state } = of;
    if (step.store) state.fails = step.store === "fails";
    if (step.set !== undefined) state.wall = START + step.set;
    if (step.pass !== undefined) {
      state.wall += step.pass;
      state.mono += step.pass;
    }
    if (step.monoOnly !== undefined) state.mono += step.monoOnly;
    if (step.reboot !== undefined) state.mono = step.reboot;
    if (step.gone && of.folder.length) of.folder.splice(of.folder.indexOf(step.gone === "newest" ? Math.max(...of.folder) : Math.min(...of.folder)), 1);
    if (step.put !== undefined && !of.folder.includes(START + step.put)) of.folder.push(START + step.put);
    of.warned.length = 0;
    if (step.restart) {
      await of.schedule.stop();
      if (step.kept === "nothing") state.kept = null;
      else if (step.kept === "unreadable") state.kept = "unreadable";
      else if (step.kept) state.kept = { folder: "/b", at: START + step.kept.begun, ended: START + step.kept.begun, kind: "begun", said: null, actions: [] };
      // The monotonic source is machine uptime, so it remains comparable across process restarts.
      of.schedule = of.run();
    }
    // Before it looks and after: the last backup it gives is the last one that is in the folder at that instant.
    assert.equal(of.schedule.status().last_at, lastThere(of), `step ${i + 1}, before the look`);
    const before = state.tries;
    await of.schedule.check();
    assert.equal(of.schedule.status().last_at, lastThere(of), `step ${i + 1}, after the look`);
    return state.tries > before;
  }
  /**
   * What is reported is what is done: after these steps, the instant the schedule gives for the next backup,
   * or for the next try of one that failed, is the first at which a look begins one, with both clocks going on
   * together and the backups as they are. A millisecond before it, a look begins none; at it, a look begins one.
   */
  async function reportedIsDone(have: number[], every: number, steps: Array<Omit<Step, "tries">>, what: string): Promise<void> {
    const again = world(have, every);
    for (const [i, step] of steps.entries()) await take(again, step, i);
    const { state, schedule } = again;
    const status = schedule.status();
    const reported = Date.parse(status.failure ? status.failure.retry_at : status.next_due!);
    // The schedule has just looked: whatever it reports now lies ahead, and one that failed is not said to be tried before the next is due.
    assert.ok(reported > state.wall, `${what}: the instant reported, ${iso(reported)}, lies after now, ${iso(state.wall)}`);
    if (status.failure) assert.ok(Date.parse(status.failure.retry_at) >= Date.parse(status.next_due!), `${what}: a try is not said to come before the next is due`);
    const until = reported - state.wall;
    state.wall += until - 1;
    state.mono += until - 1;
    const before = state.tries;
    await schedule.check();
    assert.equal(state.tries - before, 0, `${what}: a millisecond before ${iso(reported)}, no backup is begun`);
    assert.equal(Date.parse(schedule.status().failure ? schedule.status().failure!.retry_at : schedule.status().next_due!), reported, `${what}: and the instant reported is still the same`);
    state.wall += 1;
    state.mono += 1;
    await schedule.check();
    assert.equal(state.tries - before, 1, `${what}: at ${iso(reported)}, a backup is begun`);
    await schedule.stop();
  }

  for (const { name, have = [], every = 24, steps } of CASES) {
    it(name, async () => {
      const of = world(have, every);
      for (const [i, step] of steps.entries()) {
        const at = `step ${i + 1}: ${JSON.stringify(step)}`;
        assert.equal(await take(of, step, i), step.tries, at);
        const status = of.schedule.status();
        if (step.due !== undefined) assert.equal(status.next_due, iso(START + step.due), at);
        if (step.retry !== undefined) assert.equal(status.failure?.retry_at ?? null, step.retry === null ? null : iso(START + step.retry), at);
        if (step.warns) assert.match(of.warned[0] ?? "nothing was said", step.warns, at);
        else assert.deepEqual(of.warned.filter((line) => !line.startsWith("The automatic backup into /b failed: ") && !line.startsWith("Automatic backups work again")), [], at);
        // And what it reports at this point is what it then does.
        await reportedIsDone(have, every, steps.slice(0, i + 1), at);
      }
      await of.schedule.stop();
    });
  }

  it("reports, after any steps of clocks set back and forth, time passing on one clock or both, a store that fails or works, and restarts, the instant at which it then begins a backup", async () => {
    let seed = 600_000;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = <T>(from: readonly T[]): T => from[Math.floor(next() * from.length)]!;
    const SPANS = [0, 1, MINUTE, 5 * MINUTE, 10 * MINUTE - 1, 10 * MINUTE, HOUR, 6 * HOUR, DAY - 1, DAY, 3 * DAY, 30 * DAY];
    let failing = 0;
    let ahead = 0;
    for (let sequence = 0; sequence < 250; sequence++) {
      const every = pick([24, 24, 4, 1, 0.25]);
      const have = Array.from({ length: Math.floor(next() * 4) }, () => Math.round((next() - 0.7) * 3 * DAY));
      // Every other one begins with a store that fails.
      const steps: Array<Omit<Step, "tries">> = next() < 0.5 ? [{ store: "fails" }] : [];
      let wall = 0;
      for (let i = 1 + Math.floor(next() * 6); i > 0; i--) {
        const step: Omit<Step, "tries"> = {};
        const kind = next();
        if (kind < 0.3) step.pass = pick(SPANS);
        else if (kind < 0.55) step.set = wall + Math.round((next() - 0.5) * 2 * pick(SPANS));
        else if (kind < 0.65) step.monoOnly = pick(SPANS);
        else if (kind < 0.75) step.store = pick(["fails", "works"] as const);
        else if (kind < 0.82) step.gone = pick(["newest", "oldest"] as const);
        else if (kind < 0.88) step.put = wall + Math.round((next() - 0.5) * 2 * pick(SPANS));
        else if (kind < 0.96) step.restart = true;
        else Object.assign(step, { restart: true, kept: "nothing" });
        if (next() < 0.3) step.pass = (step.pass ?? 0) + pick(SPANS);
        wall = (step.set ?? wall) + (step.pass ?? 0);
        steps.push(step);
      }
      const what = `${JSON.stringify({ every, have })} ${JSON.stringify(steps)}`;
      await reportedIsDone(have, every, steps, what);
      // How many of them end with a failure that waits, and with a backup dated ahead of the clock.
      const of = world(have, every);
      for (const [i, step] of steps.entries()) await take(of, step, i);
      if (of.schedule.status().failure) failing++;
      if (have.some((offset) => START + offset > of.state.wall)) ahead++;
      await of.schedule.stop();
    }
    assert.ok(failing > 40 && ahead > 40, `${failing} of them end with one that failed, ${ahead} with a backup dated ahead`);
  });

  it("stands, at any instant, where its two clocks, its backups and its wait put it: what may be begun, since when one is due, and the earliest instant one would be begun", () => {
    const stands = (wall: number, moments: number[], wait: number | null, everyMs = DAY) => standing({ wall: START + wall, mono: 0, moments: moments.map((offset) => START + offset), notBefore: wait, everyMs });
    const at = (offset: number): number => START + offset;
    // None there: due now, begun now, or when the wait is over.
    assert.deepEqual(stands(0, [], null), { last: null, due: true, waitMs: 0, mayAttempt: true, dueWall: at(0), startWall: at(0) });
    assert.deepEqual(stands(0, [], 10 * MINUTE), { last: null, due: true, waitMs: 10 * MINUTE, mayAttempt: false, dueWall: at(0), startWall: at(10 * MINUTE) });
    // A fresh one: the next when it is a day old, however short the wait.
    assert.deepEqual(stands(0, [-10 * HOUR], 10 * MINUTE), { last: at(-10 * HOUR), due: false, waitMs: 10 * MINUTE, mayAttempt: false, dueWall: at(14 * HOUR), startWall: at(14 * HOUR) });
    // An old one: due since it was a day old, begun now or when the wait is over.
    assert.deepEqual(stands(0, [-30 * HOUR], null), { last: at(-30 * HOUR), due: true, waitMs: 0, mayAttempt: true, dueWall: at(-6 * HOUR), startWall: at(0) });
    assert.deepEqual(stands(0, [-30 * HOUR], 10 * MINUTE), { last: at(-30 * HOUR), due: true, waitMs: 10 * MINUTE, mayAttempt: false, dueWall: at(-6 * HOUR), startWall: at(10 * MINUTE) });
    // One dated ahead does not count now, and does when the clock has come to it: none is begun within a day after it.
    assert.deepEqual(stands(0, [HOUR], null), { last: null, due: true, waitMs: 0, mayAttempt: true, dueWall: at(0), startWall: at(0) });
    assert.deepEqual(stands(0, [5 * MINUTE], 10 * MINUTE), { last: null, due: true, waitMs: 10 * MINUTE, mayAttempt: false, dueWall: at(0), startWall: at(5 * MINUTE + DAY) });
    assert.deepEqual(stands(0, [-10 * HOUR, 12 * HOUR, 30 * HOUR, 100 * HOUR], null).startWall, at(54 * HOUR), "from one to the next that counts by then, as long as each is less than a day after the one before");
    // A wait that is over, and a clock that only goes forward and has gone further.
    assert.equal(standing({ wall: at(0), mono: 500, moments: [], notBefore: 400, everyMs: DAY }).mayAttempt, true);
    assert.equal(standing({ wall: at(0), mono: 500, moments: [], notBefore: 501, everyMs: DAY }).startWall, at(1));

    // And for any of them: the instant given is the first at which one may be begun, with both clocks going on together.
    let seed = 8640;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < 5000; i++) {
      const everyMs = [DAY, 4 * HOUR, 15 * MINUTE][Math.floor(next() * 3)]!;
      const moments = Array.from({ length: Math.floor(next() * 6) }, () => START + Math.round((next() - 0.6) * 4 * everyMs));
      const [wall, mono] = [START + Math.round((next() - 0.5) * everyMs), Math.round(next() * HOUR)];
      const notBefore = next() < 0.4 ? null : mono + Math.round((next() - 0.3) * 20 * MINUTE);
      const now = standing({ wall, mono, moments, notBefore, everyMs });
      const later = (by: number) => standing({ wall: wall + by, mono: mono + by, moments, notBefore, everyMs });
      const what = JSON.stringify({ wall, mono, moments, notBefore, everyMs });
      assert.equal(now.mayAttempt, now.startWall === wall, what);
      assert.ok(now.startWall >= wall + now.waitMs && now.startWall >= wall, what);
      assert.equal(now.mayAttempt, now.due && now.waitMs === 0, what);
      if (now.startWall > wall) assert.equal(later(now.startWall - wall - 1).mayAttempt, false, `${what}: not a millisecond before`);
      assert.equal(later(now.startWall - wall).mayAttempt, true, `${what}: at the instant given`);
      // Nowhere between now and then either, looked at where it could: when the wait ends, and when each backup counts or comes of age.
      for (const moment of [wall + now.waitMs, ...moments, ...moments.map((one) => one + everyMs)]) {
        if (moment >= wall && moment < now.startWall) assert.equal(later(moment - wall).mayAttempt, false, `${what}: not at ${moment}`);
      }
      assert.equal(later(now.startWall - wall).startWall, now.startWall, what);
    }
  });
});


describe("the place a path leads to", () => {
  let root: string;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "vigile-place-"));
    mkdirSync(join(root, "real", "data"), { recursive: true });
    mkdirSync(join(root, "other"));
    writeFileSync(join(root, "real", "file"), "one file");
    linkSync(join(root, "real", "file"), join(root, "other", "the-same-file"));
    symlinkSync(join(root, "real"), join(root, "alias"));
    symlinkSync("real", join(root, "alias-written-from-here"));
    symlinkSync(join(root, "alias"), join(root, "alias-of-alias"));
    symlinkSync(join(root, "real", "data"), join(root, "other", "deep"));
    symlinkSync(join(root, "nowhere"), join(root, "dangling"));
    symlinkSync(join(root, "round-2"), join(root, "round-1"));
    symlinkSync(join(root, "round-1"), join(root, "round-2"));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  /** Two paths, written from the folder of the test, and whether they are one place. */
  const PAIRS: Array<[what: string, a: string, b: string, same: boolean]> = [
    ["the same name", "real/data", "real/data", true],
    ["a dot on the way", "real/./data", "real/data", true],
    ["a slash at the end", "real/data/", "real/data", true],
    ["out of a folder and back in", "real/data/../data", "real/data", true],
    ["out of a folder that is not there", "real/not-there/../data", "real/data", true],
    ["a link as the last name", "alias", "real", true],
    ["a link written from its own folder", "alias-written-from-here/data", "real/data", true],
    ["a link to a link", "alias-of-alias/data", "real/data", true],
    ["a link above something that is not there", "alias/new", "real/new", true],
    ["a link to a link above something that is not there, some way down", "alias-of-alias/new/deeper/leaf", "real/new/deeper/leaf", true],
    ["out of a link's folder: the folder the link leads to, not the one it lies in", "other/deep/..", "real", true],
    ["out of a link's folder, then into something that is not there", "other/deep/../new", "real/new", true],
    ["a link that leads nowhere, and where it leads", "dangling", "nowhere", true],
    ["under a link that leads nowhere", "dangling/new", "nowhere/new", true],
    ["two names of one file, with no link between them", "real/file", "other/the-same-file", true],

    ["two things that are not there, side by side", "real/new", "real/newer", false],
    ["two things that are not there, in different folders", "real/new", "other/new", false],
    ["a folder inside the data folder", "real/data/backups", "real/data", false],
    ["the folder the data folder is in", "real", "real/data", false],
    ["a link, taken as it is written: not the folder it lies in", "other/deep/..", "other", false],
    ["a link that leads nowhere, and a folder that is there", "dangling", "real", false],
  ];
  for (const [what, a, b, same] of PAIRS) {
    it(`${same ? "is one" : "is not one"} for ${what}: ${a} and ${b}`, () => {
      // As they are written, with nothing worked out beforehand.
      const [first, second] = [`${root}/${a}`, `${root}/${b}`];
      assert.equal(samePlace(first, second), same);
      assert.equal(samePlace(second, first), same);
      // Written from the folder the process is in, a path leads where it leads when written out in full.
      assert.equal(samePlace(`${relative(process.cwd(), root)}/${a}`, second), same);
      const [led, other] = [whereTo(first), whereTo(second)];
      assert.equal(led.ok && other.ok && led.place === other.place, same && what !== "two names of one file, with no link between them");
    });
  }

  it("is a name without links, with what is not there as it is written, and the same however often it is asked for", () => {
    const real = placeOf(join(root, "real"));
    assert.equal(placeOf(join(root, "alias", "new", "leaf")), join(real, "new", "leaf"));
    assert.equal(placeOf(placeOf(`${root}/alias-of-alias/x/../new`)), join(real, "new"));
    assert.equal(placeOf(`${root}/dangling/a/../b`), join(placeOf(root), "nowhere", "b"));
  });

  it("is what vigile backup goes by: the data folder is refused through a link in the folder above it, also before it is there, and a folder inside it is not", async () => {
    const one = await instance();
    await one.start();
    await one.service.stop();
    symlinkSync(one.directory, join(one.directory, "the-same-folder"));
    for (const folder of [one.data, join(one.directory, "the-same-folder", "data"), join(one.directory, "the-same-folder", "x", "..", "data")]) {
      const refused = await run(["backup", folder, "--config", one.config]);
      assert.equal(refused.code, 1, folder);
      assert.match(refused.err, /A backup cannot go into the data folder itself\./);
    }
    assert.deepEqual(readdirSync(one.data).filter((name) => /^default-\d/.test(name)), []);
    // Inside the data folder is as it was: taken, and the service takes what is in there for no tenant.
    const keptHere = join(one.data, "kept-here");
    assert.equal((await run(["backup", keptHere, "--config", one.config])).code, 0);
    assert.equal(readdirSync(keptHere).filter((name) => name.endsWith(".sqlite")).length, 1);
    assert.equal(existsSync(backupOperationLock(keptHere)), true, "the destination keeps its coordination lock");
    await one.start();
    assert.equal((await one.doctor()).failed, 0);
  });
});

describe("where the automatic backups may go", () => {
  /** Runs `vigile config …` here, and says whether it was refused and with what. */
  async function configure(config: string, ...words: string[]): Promise<{ refused: string | null; out: string }> {
    const lines: string[] = [];
    const ui = { fancy: false, paint: (_style: unknown, text: string) => text, out: (line = "") => void lines.push(line), err: (line = "") => void lines.push(line) } as Ui;
    try {
      await configCommand(parseArgs([...words, "--config", config]), ui);
      return { refused: null, out: lines.join("\n") };
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      return { refused: [error.message, ...error.hints].join(" "), out: lines.join("\n") };
    }
  }
  /** A config in a folder of its own, with a data folder, another name for it, and the data folder of another instance beside it. */
  function folder(): { directory: string; config: string } {
    const directory = mkdtempSync(join(tmpdir(), "vigile-places-"));
    const config = join(directory, "config.toml");
    // No service is started on this config: the port is only a number in the file.
    initConfig(config, { name: "places", port: 8799 });
    mkdirSync(join(directory, "data"));
    mkdirSync(join(directory, "store"));
    symlinkSync(join(directory, "data"), join(directory, "data-by-another-name"));
    // A folder and another name for it, with nothing in it yet.
    mkdirSync(join(directory, "real"));
    symlinkSync(join(directory, "real"), join(directory, "alias"));
    mkdirSync(join(directory, "another-instance", "data"), { recursive: true });
    writeFileSync(join(directory, "another-instance", "data", "vigile.lock"), "");
    return { directory, config };
  }
  const made: string[] = [];
  after(() => {
    for (const directory of made) rmSync(directory, { recursive: true, force: true });
  });

  const INTO_DATA = /^A backup cannot go into the data folder itself\. .* Nothing was changed\. Give the backups a folder of their own first: vigile config set backup\.folder <folder>\. Or turn them off: vigile config set backup\.enabled false$/;
  const ANOTHERS = /is the data folder of a Vigile instance: a backup written there would be taken for a tenant of that instance\. .* Nothing was changed\./;
  /** What the config says before the change, set as a hand would write it; the change; and whether it is refused. */
  const TRANSITIONS: Array<{ name: string; before?: Array<[string, string]>; change: string[]; refused?: RegExp }> = [
    { name: "the backup folder named as the data folder", change: ["set", "backup.folder", "data"], refused: INTO_DATA },
    { name: "the backup folder named as the data folder, by its whole path", change: ["set", "backup.folder", "{dir}/data"], refused: INTO_DATA },
    { name: "the backup folder named as the data folder, by a way round", change: ["set", "backup.folder", "store/../data"], refused: INTO_DATA },
    { name: "the backup folder named as the data folder, through a link", change: ["set", "backup.folder", "data-by-another-name"], refused: INTO_DATA },
    { name: "the data folder moved into the backup folder", change: ["set", "data_dir", "backups"], refused: INTO_DATA },
    { name: "the data folder moved into the backup folder, by a way round", change: ["set", "data_dir", "./store/../backups"], refused: INTO_DATA },
    { name: "the data folder moved into a backup folder that was named", before: [["backup.folder", "store"]], change: ["set", "data_dir", "store"], refused: INTO_DATA },
    { name: "the data folder moved onto a link to the backup folder", before: [["backup.folder", "data"], ["data_dir", "store"]], change: ["set", "data_dir", "data-by-another-name"], refused: INTO_DATA },
    { name: "backups turned on when their folder was made the data folder while they were off", before: [["backup.enabled", "false"], ["backup.folder", "data"]], change: ["set", "backup.enabled", "true"], refused: INTO_DATA },
    { name: "backups back to their default, on, when their folder was made the data folder while they were off", before: [["backup.enabled", "false"], ["backup.folder", "data"]], change: ["unset", "backup.enabled"], refused: INTO_DATA },
    { name: "backups turned on when the data folder was moved into their folder while they were off", before: [["backup.enabled", "false"], ["data_dir", "backups"]], change: ["set", "backup.enabled", "true"], refused: INTO_DATA },
    { name: "the data folder back to its default, which is where the backups go", before: [["data_dir", "store"], ["backup.folder", "data"]], change: ["unset", "data_dir"], refused: INTO_DATA },
    { name: "the backup folder back to its default, which is where the data is", before: [["backup.folder", "store"], ["data_dir", "backups"]], change: ["unset", "backup.folder"], refused: INTO_DATA },
    { name: "the backup folder named as the data folder that is not there yet, through a link in the folder above it", before: [["data_dir", "real/data"]], change: ["set", "backup.folder", "alias/data"], refused: INTO_DATA },
    { name: "the data folder that is not there yet moved into the backup folder, through a link in the folder above it", before: [["backup.folder", "real/kept"]], change: ["set", "data_dir", "alias/kept"], refused: INTO_DATA },
    { name: "backups turned on when their folder is the data folder that is not there yet, through a link above it", before: [["backup.enabled", "false"], ["data_dir", "real/data"], ["backup.folder", "alias/sub/../data"]], change: ["set", "backup.enabled", "true"], refused: INTO_DATA },
    { name: "the backup folder named as the data folder of another instance", change: ["set", "backup.folder", "another-instance/data"], refused: ANOTHERS },
    { name: "backups turned on when their folder is the data folder of another instance", before: [["backup.enabled", "false"], ["backup.folder", "another-instance/data"]], change: ["set", "backup.enabled", "true"], refused: ANOTHERS },

    { name: "the backup folder made the data folder while backups are off", before: [["backup.enabled", "false"]], change: ["set", "backup.folder", "data"] },
    { name: "the data folder moved into the backup folder while backups are off", before: [["backup.enabled", "false"]], change: ["set", "data_dir", "backups"] },
    { name: "backups turned off when their folder is the data folder", before: [["backup.folder", "data"]], change: ["set", "backup.enabled", "false"] },
    { name: "the backup folder moved out of the data folder", before: [["backup.folder", "data"]], change: ["set", "backup.folder", "store"] },
    { name: "the backup folder back to its default, out of the data folder", before: [["backup.folder", "data"]], change: ["unset", "backup.folder"] },
    { name: "the data folder moved away from the backup folder", before: [["backup.folder", "data"]], change: ["set", "data_dir", "store"] },
    { name: "backups turned on with a folder of their own", before: [["backup.enabled", "false"], ["backup.folder", "store"]], change: ["set", "backup.enabled", "true"] },
    { name: "the backup folder put inside the data folder, as vigile backup takes one", change: ["set", "backup.folder", "data/backups"] },
    { name: "the data folder put inside the backup folder", change: ["set", "data_dir", "backups/data"] },
    { name: "the backup folder beside a data folder that is not there yet, under a link to the folder above both", before: [["data_dir", "real/data"]], change: ["set", "backup.folder", "alias/backups"] },
    { name: "a setting that places nothing, while the backup folder is the data folder", before: [["backup.folder", "data"]], change: ["set", "log_level", "debug"] },
    { name: "how often, while the backup folder is the data folder", before: [["backup.folder", "data"]], change: ["set", "backup.every_hours", "4"], refused: INTO_DATA },
  ];

  for (const { name, before = [], change, refused } of TRANSITIONS) {
    it(`config ${change.slice(0, 2).join(" ")} is ${refused ? "refused, and nothing is written" : "taken"}: ${name}`, async () => {
      const { directory, config } = folder();
      made.push(directory);
      // As a hand writes them, without the check: the config may say anything before the change.
      for (const [key, value] of before) setValue(config, key, value.replace("{dir}", directory));
      const was = readFileSync(config, "utf8");
      const result = await configure(config, ...change.map((word) => word.replace("{dir}", directory)));
      if (refused) {
        assert.match(result.refused ?? "it was taken", refused);
        assert.equal(readFileSync(config, "utf8"), was);
      } else {
        assert.equal(result.refused, null);
        assert.notEqual(readFileSync(config, "utf8"), was);
        if (change[0] === "set") assert.equal(String(change[1]!.split(".").reduce<any>((value, part) => value?.[part], loadConfig(config, {}).config)), change[2]);
      }
    });
  }

  it("is asked of the config a service is started with, the file with the environment and the options of the run over it, and a config that has them go into the data does not start it", async () => {
    const refusedAtStart = async (one: Instance, environment: NodeJS.ProcessEnv, options: Record<string, string>, says: RegExp, what: string) => {
      await assert.rejects(one.start({}, undefined, environment, options), (error: unknown) => error instanceof StartupError && says.test([error.message, ...error.hints].join(" ")), what);
      assert.equal(existsSync(join(one.directory, "data", "vigile.lock")), false, `${what}: nothing was started`);
    };
    const INTO = /^The automatic backups cannot go where the config has them go\. A backup cannot go into the data folder itself\. The backups would go to .* \(backup\.folder\), and the data is in .* \(data_dir\)\. Give the backups a folder of their own: vigile config set backup\.folder <folder>\. Or turn them off: vigile config set backup\.enabled false$/;

    const one = await instance();
    await refusedAtStart(one, {}, { "backup.folder": "data" }, INTO, "an option to serve");
    await refusedAtStart(one, { VIGILE_BACKUP_FOLDER: "data" }, {}, INTO, "the environment");
    await refusedAtStart(one, {}, { data_dir: "backups" }, INTO, "the data folder moved for this run");
    await refusedAtStart(one, { VIGILE_DATA_DIR: join(one.directory, "store", "..", "backups") }, {}, INTO, "the data folder moved for this run, by a way round");
    mkdirSync(one.data);
    symlinkSync(one.data, join(one.directory, "data-by-another-name"));
    await refusedAtStart(one, {}, { "backup.folder": "data-by-another-name" }, INTO, "through a link");
    // Neither folder is there yet, and a link in the folder above them leads from the one name to the other.
    mkdirSync(join(one.directory, "real"));
    symlinkSync(join(one.directory, "real"), join(one.directory, "alias"));
    await refusedAtStart(one, {}, { data_dir: "real/data", "backup.folder": "alias/data" }, INTO, "through a link in the folder above, with nothing there yet");
    await refusedAtStart(one, { VIGILE_DATA_DIR: "alias/x/../data", VIGILE_BACKUP_FOLDER: join(one.directory, "real", "data") }, {}, INTO, "the same by a way round");
    assert.deepEqual(readdirSync(join(one.directory, "real")), [], "nothing was made there");
    const serve = await run(["serve", "--backup.folder", "data", "--config", one.config]);
    assert.equal(serve.code, 1);
    assert.match(serve.err, /The automatic backups cannot go where the config has them go\. A backup cannot go into the data folder itself\./);

    // In the file, off, with the folder in the data: it starts. Turned on for one run, it does not.
    setValue(one.config, "backup.enabled", "false");
    setValue(one.config, "backup.folder", "data");
    await refusedAtStart(one, {}, { "backup.enabled": "true" }, INTO, "turned on for this run");
    await refusedAtStart(one, { VIGILE_BACKUP_ENABLED: "true" }, {}, INTO, "turned on for this run, by the environment");
    await one.start();
    assert.equal(one.service.backups.status().enabled, false);
    await one.service.stop();
    // In the file, on: it does not start. Turned off for one run, or sent elsewhere, it does.
    unsetValue(one.config, "backup.enabled");
    await refusedAtStart(one, {}, {}, INTO, "in the file");
    await one.start({}, undefined, { VIGILE_BACKUP_ENABLED: "false" });
    await one.service.stop();
    await one.start({}, undefined, {}, { "backup.folder": "elsewhere" });
    await one.pass(0);
    assert.deepEqual(one.automatic(join(one.directory, "elsewhere")), [named(START)]);
    await one.service.stop();

    // The data folder of another instance.
    const other = await instance();
    await other.start();
    await refusedAtStart(one, {}, { "backup.folder": other.data }, /^The automatic backups cannot go where the config has them go\. .* is the data folder of a Vigile instance: /, "another instance's data");
    assert.deepEqual(readdirSync(other.data).filter((name) => /auto|backups/.test(name)), []);
  });

  describe("a config from before automatic backups, whose data folder is where they would go", () => {
    /** The four settings of backups, each with the value it has by default. */
    const BY_DEFAULT: Array<[key: string, value: string, variable: string]> = [
      ["backup.enabled", "true", "VIGILE_BACKUP_ENABLED"],
      ["backup.every_hours", "24", "VIGILE_BACKUP_EVERY_HOURS"],
      ["backup.folder", "backups", "VIGILE_BACKUP_FOLDER"],
      ["backup.keep", "30", "VIGILE_BACKUP_KEEP"],
    ];
    const REFUSED = /^The automatic backups cannot go where the config has them go\. A backup cannot go into the data folder itself\./;
    const refusedAtStart = (one: Instance, environment: NodeJS.ProcessEnv, options: Record<string, string>, what: string) =>
      assert.rejects(one.start({}, undefined, environment, options), (error: unknown) => error instanceof StartupError && REFUSED.test(error.message), what);

    it("starts when the file says nothing of backups: none is taken, and that is said", async () => {
      // Nothing of backups in the file, and the data in a folder called backups, as it was before the service took any.
      const one = await instance({ data_dir: "backups" });
      assert.equal(readFileSync(one.config, "utf8").includes("[backup]"), false);
      await one.start();
      await one.pass(0);
      assert.equal(one.warnings.length, 1, one.warnings.join("\n"));
      assert.match(one.warnings[0]!, /failed: A backup cannot go into the data folder itself\. Choose a folder outside it\. It is tried again at /);
      assert.deepEqual(readdirSync(one.backups).filter((name) => /auto|partial|vigile-backups\.hold/.test(name)), [], "nothing was written among the data");
      assert.equal((await fetch(`${one.service.urls.base}/health`)).status, 200);
      const checks = (await one.doctor()).checks;
      const place = checks.find((check) => check.title === "automatic backups have their own folder")!;
      assert.equal(place.level, "fail");
      assert.match(place.detail!, /A backup cannot go into the data folder itself\. No automatic backup is taken\.$/);
      assert.match(place.fix!, /vigile config set backup\.folder <folder>\. Or turn them off: vigile config set backup\.enabled false/);
      assert.equal(checks.find((check) => check.title === "last automatic backup worked")!.level, "fail");
    });

    // Every way of writing some of the four into the file, each with the very value it has when left out: what
    // counts is that a setting is written, not what it says.
    for (let written = 0; written < 16; written++) {
      const settings = BY_DEFAULT.filter((_, i) => written & (1 << i));
      it(`${written === 0 ? "starts" : "does not start"} with ${settings.length ? settings.map(([key, value]) => `${key} = ${value}`).join(", ") : "none of the four"} written in the file`, async () => {
        const one = await instance({ data_dir: "backups", ...Object.fromEntries(settings.map(([key, value]) => [key, value])) });
        const loaded = loadConfig(one.config, {});
        assert.deepEqual(loaded.config.backup, { enabled: true, every_hours: 24, folder: "backups", keep: 30 }, "the values are the same, whichever are written");
        assert.deepEqual(BY_DEFAULT.map(([key]) => loaded.sources[key]), BY_DEFAULT.map((_, i) => (written & (1 << i) ? "file" : "default")));
        if (written === 0) {
          await one.start();
          assert.equal(one.service.backups.status().enabled, true);
        } else {
          await refusedAtStart(one, {}, {}, "written in the file");
          assert.equal(existsSync(join(one.backups, "vigile.lock")), false);
        }
      });
    }

    it("does not start when a setting of backups is given for the run, in the environment or as an option, with the value it has by default", async () => {
      const one = await instance({ data_dir: "backups" });
      for (const [key, value, variable] of BY_DEFAULT) {
        await refusedAtStart(one, { [variable]: value }, {}, variable);
        await refusedAtStart(one, {}, { [key]: value }, `--${key}`);
      }
      // Nor when the data folder is not the file's own, but moved for the run.
      const moved = await instance();
      await refusedAtStart(moved, { VIGILE_DATA_DIR: "backups" }, {}, "VIGILE_DATA_DIR");
      await refusedAtStart(moved, {}, { data_dir: "backups" }, "--data_dir");
    });

    it("starts with backups turned off, in the file or for the run, wherever their folder would be: there is nothing to refuse", async () => {
      const inFile = await instance({ data_dir: "backups", "backup.enabled": "false", "backup.keep": "5" });
      await inFile.start();
      assert.equal(inFile.service.backups.status().enabled, false);
      await inFile.pass(24 * HOUR);
      assert.deepEqual(inFile.warnings, []);
      const forTheRun = await instance({ data_dir: "backups" });
      await forTheRun.start({}, undefined, { VIGILE_BACKUP_ENABLED: "false" });
      await forTheRun.service.stop();
      await forTheRun.start({}, undefined, {}, { "backup.enabled": "false" });
      assert.equal(forTheRun.service.backups.status().enabled, false);
    });
  });
});


describe("the system's lock on the backup folder, as another process finds it", () => {
  const store = import.meta.resolve("@vigile/storage-sqlite");
  /**
   * Whether the lock is free, asked by a process of its own that tries to take it as a service would, and lets
   * go at once if it gets it. Not a service's word for it: the lock itself.
   */
  function lock(folder: string): "taken" | "free" {
    const script = `import { holdFile } from ${JSON.stringify(store)}; const release = holdFile(process.argv[1]); process.stdout.write(release ? "free" : "taken"); if (release) release();`;
    return execFileSync(process.execPath, ["--input-type=module", "-e", script, join(folder, BACKUPS_LOCK)], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", timeout: 30_000 }) as "taken" | "free";
  }
  const ofTheBackup = (names: string[]): string[] => names.filter((name) => tenants.some((tenant) => name.startsWith(named(START, tenant)))).sort();

  for (const place of PLACES) {
    it(`is taken while a backup that was ended ${place.when} is not over: before the stop, after the stop has returned, and while its files are settled; and free only after`, async () => {
      const one = await twoTenants();
      const flag = new Int32Array(new SharedArrayBuffer(4));
      let end!: () => void;
      const ended = new Promise<void>((resolve) => (end = resolve));
      /** What another process finds, and what of the backup is in the folder, when the settling begins and when it is done. */
      const settling: Array<[when: string, lock: string, files: string[]]> = [];
      await one.start(
        { stopMs: 20 },
        {
          pause: { point: place.point, tenant: place.tenant, then: "wait", reached: flag.buffer as SharedArrayBuffer },
          ending: () => ended,
          settling: (when) => settling.push([when, lock(one.backups), ofTheBackup(readdirSync(one.backups))]),
        },
      );
      const attempt = one.service.backups.check();
      for (const until = Date.now() + 30_000; Atomics.load(flag, 0) !== 1; ) {
        if (Date.now() > until) assert.fail("the backup's thread did not get to the place it was to stop at");
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(lock(one.backups), "taken", "while the backup is written");

      await one.service.stop();
      assert.deepEqual(ofTheBackup(readdirSync(one.backups)), [...place.there].sort(), "the stop has returned, and the backup's files are as they were");
      assert.equal(lock(one.backups), "taken", "after the stop has returned at its deadline");
      assert.deepEqual(settling, []);

      end();
      await attempt;
      assert.deepEqual(settling, [
        ["before", "taken", [...place.there].sort()],
        ["after", "taken", place.whole ? [named(START), named(START, "second")] : []],
      ]);
      assert.equal(lock(one.backups), "free", "once the backup is over");
    });
  }

  it("is free when a service with no backup under way has stopped, and taken for as long as one runs", async () => {
    const one = await instance();
    await one.start();
    await one.pass(0);
    assert.equal(lock(one.backups), "taken");
    await one.service.stop();
    assert.equal(lock(one.backups), "free");
  });
});

describe("a process whose service has stopped while a backup is not over", () => {
  const dist = (file: string): string => new URL(file, import.meta.url).href;
  /**
   * What the process runs. It starts the service, has a backup begun whose thread stops before its first write,
   * and stops the service with a wait of 20 ms for that backup. The end of the backup's thread is then held
   * until the file the test names is there, by a look that does not keep the process alive. After the stop it
   * does what it is told: nothing more, so that it ends when nothing keeps it; or what `serve` does on a signal.
   */
  const script = `
import { existsSync } from "node:fs";
import { loadConfig } from ${JSON.stringify(import.meta.resolve("@vigile/config"))};
import { startService } from ${JSON.stringify(dist("./service.js"))};
import { stopAndSettle } from ${JSON.stringify(dist("./commands/serve.js"))};
const [config, released, how] = process.argv.slice(2);
const reached = new Int32Array(new SharedArrayBuffer(4));
const held = () => new Promise((resolve) => {
  const look = setInterval(() => existsSync(released) && (clearInterval(look), resolve()), 5);
  look.unref();
});
const service = await startService({
  loaded: loadConfig(config, {}),
  log: () => {},
  warn: (line) => console.log("warned " + line),
  backupTimes: { firstMs: 1e9, checkMs: 1e9, stopMs: 20 },
  backupHooks: { pause: { point: "copy", then: "wait", reached: reached.buffer }, ending: held },
});
void service.backups.check();
while (Atomics.load(reached, 0) !== 1) await new Promise((resolve) => setTimeout(resolve, 2));
if (how === "as serve does") {
  await stopAndSettle(service, (line) => console.log("stopped: " + line));
  console.log("settled");
  process.exit(0);
}
await service.stop();
console.log("stopped: and nothing more is asked of this process");
`;

  for (const how of ["by itself, when nothing keeps it", "as serve does"]) {
    it(`does not end ${how} before the backup's files are settled: until then it lives and the folder's lock is taken, then it ends and the lock is free`, async () => {
      const one = await instance();
      await one.start();
      await one.service.stop();
      const file = join(one.directory, "process.mjs");
      const released = join(one.directory, "released");
      writeFileSync(file, script);
      const child = spawn(process.execPath, [file, one.config, released, how], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
      let printed = "";
      child.stdout.on("data", (chunk: Buffer) => (printed += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (printed += chunk.toString()));
      let ended: number | null | undefined;
      const exited = new Promise<void>((resolve) => child.once("exit", (code) => ((ended = code), resolve())));
      try {
        // Until the service in the process has stopped, with the backup not over.
        for (const until = Date.now() + 30_000; !printed.includes("stopped: ") && ended === undefined; ) {
          if (Date.now() > until) assert.fail(`the process did not get to its stop: ${printed}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.match(printed, /stopped: /, printed);
        if (how === "as serve does") assert.match(printed, /stopped: The service has stopped\. Process \d+ stays until the backup that was under way has ended and its files are settled, so that nobody else takes the backup folder before; send the signal again to end it now\./);
        // The service has stopped: the data folder is free. The process is to live on all the same, for as long
        // as the test holds the end of the backup: a process that ended by itself would be gone in this time.
        const working = named(Date.parse(automaticMoment(one.backups)));
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 500))]);
        assert.equal(ended, undefined, `the process has not ended: ${printed}`);
        assert.equal(holdFile(join(one.backups, BACKUPS_LOCK)), null, "from this process, the lock on the backup folder is taken");
        assert.deepEqual(readdirSync(one.backups).filter((name) => name.includes(".sqlite")), [working], "the files of the backup are not settled");
        assert.doesNotMatch(printed, /^settled$/m);

        writeFileSync(released, "");
        await exited;
        assert.equal(ended, 0, printed);
        assert.deepEqual(readdirSync(one.backups).filter((name) => name.includes(".sqlite")), [], "the files of the backup are settled: nothing of it is left");
        const free = holdFile(join(one.backups, BACKUPS_LOCK));
        assert.notEqual(free, null, "and the lock is free");
        free!();
        if (how === "as serve does") assert.match(printed, /settled\n$/);
        assert.doesNotMatch(printed, /warned/);
      } finally {
        child.kill("SIGKILL");
      }
    });
  }

  /** The moment of the backup that is being written in a folder, from its private set directory. */
  function automaticMoment(folder: string): string {
    const [name] = readdirSync(folder).filter((file) => file.endsWith("-auto.set"));
    const stamp = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})-auto\.set$/.exec(name ?? "");
    assert.ok(stamp, `a set directory is there: ${readdirSync(folder).join(", ")}`);
    return `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}.${stamp[7]}Z`;
  }
});

it("keeps an active backup folder from being taken as another service's data folder", async () => {
  const one = await instance();
  await one.start();
  await one.pass(0);
  assert.equal(holdFolder(one.backups), null, "the shared folder-ownership locks exclude a data service");
  await one.service.stop();
});

it("makes the backup-folder discriminator durable only while shared ownership excludes data services", async () => {
  const one = await twoTenants();
  const identity = prepareBackupFolder(one.data, one.backups, true);
  assert.ok(identity);
  assert.equal(existsSync(join(one.backups, BACKUPS_LOCK)), false, "preparation does not mark a folder that is not held");
  const source = sqliteBackups({ dataDir: one.data, folder: one.backups, keep: 30 });
  await source.ready!(false);
  assert.equal(lstatSync(join(one.backups, BACKUPS_LOCK)).isFile(), true, "designation is durable once the shared folder lock is held");
  assert.equal(holdFolder(one.backups), null, "a data service remains excluded while the marker is published");
  assert.deepEqual(source.moments(), [], "the marker is recognized as backup history, not data-folder history");
  await source.close();
});

it("does not designate a destination restored after preparation", async () => {
  const one = await twoTenants();
  const identity = prepareBackupFolder(one.data, one.backups, true)!;
  backupTenantFile(join(one.data, "default.sqlite"), join(one.backups, "default.sqlite"));
  const release = holdFolder(one.backups);
  assert.ok(release, "the destination is held while its role is revalidated");
  try {
    assert.throws(() => designateBackupFolder(one.data, one.backups, identity), /is the data folder of a Vigile instance/);
    assert.equal(existsSync(join(one.backups, BACKUPS_LOCK)), false, "restored tenant data is never marked as a backup folder");
  } finally {
    release();
  }
});

describe("why a backup folder is refused", () => {
  /** An instance beside another one that has run, so that the other's data folder is one. */
  async function beside(): Promise<{ one: Instance; other: Instance }> {
    const other = await instance();
    await other.start();
    await other.post("create-project", { title: "Existing data", prefix: "EX" });
    assert.equal(existsSync(join(other.data, "default.sqlite")), true);
    await other.service.stop();
    assert.equal(existsSync(join(other.data, "default.sqlite")), true);
    const one = await instance();
    assert.equal(placeRefusal(one.data, other.data)?.code, "data_folder_of_another_instance");
    return { one, other };
  }
  const SAME = /A backup cannot go into the data folder itself\./;
  const ANOTHERS = /is the data folder of a Vigile instance: a backup written there would be taken for a tenant of that instance\./;
  const startOf = async (one: Instance): Promise<string> => {
    try {
      await one.start();
      return "started";
    } catch (error) {
      if (!(error instanceof StartupError)) throw error;
      return [error.message, ...error.hints].join(" ");
    }
  };
  /** What the doctor says of where the backups go. */
  const doctorOf = async (one: Instance) => (await one.doctor()).checks.find((check) => check.title === "automatic backups have their own folder");

  /**
   * Each reason, reached by the folder's own name and through links, with a config that says nothing of
   * backups and with one that says something. Only one row starts: the data folder of this instance, with
   * nothing said. `arrange` makes the folders and says what the config has; what is written of backups, if
   * anything, has the value it has by default.
   */
  const ROWS: Array<{ name: string; arrange(one: Instance, other: Instance): Record<string, string>; said: boolean; reason: "same" | "another"; starts: boolean }> = [];
  for (const said of [false, true]) {
    const says = said ? "a config that says how many backups are kept" : "a config that says nothing of backups";
    const written: Record<string, string> = said ? { "backup.keep": "30" } : {};
    ROWS.push(
      { name: `${says}, the data in the folder the backups go to by default`, arrange: () => ({ data_dir: "backups", ...written }), said, reason: "same", starts: !said },
      {
        name: `${says}, the data in a link to the folder the backups go to by default`,
        arrange: (one) => {
          mkdirSync(one.backups);
          symlinkSync(one.backups, join(one.directory, "data-link"));
          return { data_dir: "data-link", ...written };
        },
        said,
        reason: "same",
        starts: !said,
      },
      {
        name: `${says}, the folder the backups go to by default being a link to the data folder that is not there yet`,
        arrange: (one) => {
          mkdirSync(join(one.directory, "real"));
          symlinkSync(join(one.directory, "real"), one.backups);
          return { data_dir: "real", ...written };
        },
        said,
        reason: "same",
        starts: !said,
      },
      {
        name: `${says}, the folder the backups go to by default being a link to another instance's data folder`,
        arrange: (one, other) => {
          symlinkSync(other.data, one.backups);
          return written;
        },
        said,
        reason: "another",
        starts: false,
      },
      {
        name: `${says}, the folder the backups go to by default being a link to a link to another instance's data folder`,
        arrange: (one, other) => {
          symlinkSync(other.data, join(one.directory, "theirs"));
          symlinkSync(join(one.directory, "theirs"), one.backups);
          return written;
        },
        said,
        reason: "another",
        starts: false,
      },
      {
        name: `${says}, the folder the backups go to by default being another instance's data folder under a link to that instance`,
        arrange: (one, other) => {
          symlinkSync(other.directory, join(one.directory, "their-instance"));
          symlinkSync(join(one.directory, "their-instance", "data"), one.backups);
          return written;
        },
        said,
        reason: "another",
        starts: false,
      },
    );
  }

  for (const row of ROWS) {
    it(`${row.starts ? "does not keep the service from starting" : "keeps the service from starting"}: ${row.name}`, async () => {
      const { one, other } = await beside();
      for (const [key, value] of Object.entries(row.arrange(one, other))) setValue(one.config, key, value);
      const loaded = loadConfig(one.config, {});
      const theirs = readdirSync(other.data).sort();

      // The doctor, with no service: which reason it is, in its words.
      const check = (await doctorOf(one))!;
      assert.equal(check.level, "fail");
      assert.match(check.detail!, row.reason === "same" ? /^backup\.folder leads to .*, which is the data folder \(data_dir\): A backup cannot go into the data folder itself\. No automatic backup is taken\.$/ : /^backup\.folder leads to the data folder of another instance: .* is the data folder of a Vigile instance: .* No automatic backup is taken\.$/);
      assert.match(check.fix!, row.reason === "same" ? /^Give the backups a folder of their own: / : /^Name a folder that is no instance's data folder: /);

      // The start.
      const start = await startOf(one);
      if (row.starts) {
        assert.equal(start, "started");
        await one.pass(0);
        assert.equal(one.warnings.length, 1, one.warnings.join("\n"));
        assert.match(one.warnings[0]!, /failed: A backup cannot go into the data folder itself\. Choose a folder outside it\. It is tried again at /);
        assert.deepEqual(readdirSync(loaded.dataDir).filter((name) => /-auto\.sqlite|partial|vigile-backups\.hold/.test(name)), [], "nothing was written among the data");
      } else {
        assert.match(start, /^The automatic backups cannot go where the config has them go\. /);
        assert.match(start, row.reason === "same" ? SAME : ANOTHERS);
        assert.equal(existsSync(join(loaded.dataDir, "vigile.lock")), false, "nothing was started");
      }
      // A backup by hand into the same folder is refused for the same reason, whatever the config says.
      mkdirSync(loaded.dataDir, { recursive: true });
      assert.throws(() => takeBackup({ dataDir: loaded.dataDir, folder: join(one.directory, "backups"), at: new Date(START) }), (error: unknown) => error instanceof BackupRefused && (row.reason === "same" ? SAME : ANOTHERS).test(error.message));
      assert.deepEqual(readdirSync(other.data).sort(), theirs, "the other instance's data folder is as it was");
    });
  }

  it("is told apart by config set as well: the data folder of this instance, and the data folder of another, each with what to do", async () => {
    const { one, other } = await beside();
    symlinkSync(other.data, join(one.directory, "theirs"));
    const before = readFileSync(one.config, "utf8");
    const same = await run(["config", "set", "backup.folder", "data", "--json", "--config", one.config]);
    assert.deepEqual(JSON.parse(same.err).error, {
      code: "usage",
      message: "A backup cannot go into the data folder itself.",
      actions: [
        `With backup.folder = "data", the automatic backups would go to ${one.data} (backup.folder) and the data is in ${one.data} (data_dir). Nothing was changed.`,
        "Give the backups a folder of their own first: vigile config set backup.folder <folder>. Or turn them off: vigile config set backup.enabled false",
      ],
    });
    const anothers = await run(["config", "set", "backup.folder", "theirs", "--json", "--config", one.config]);
    assert.deepEqual(JSON.parse(anothers.err).error, {
      code: "usage",
      message: `${other.data} is the data folder of a Vigile instance: a backup written there would be taken for a tenant of that instance.`,
      actions: [
        `With backup.folder = "theirs", the automatic backups would go to ${other.data} (backup.folder) and the data is in ${one.data} (data_dir). Nothing was changed.`,
        "Name a folder that is no instance's data folder: vigile config set backup.folder <folder>. Or turn them off: vigile config set backup.enabled false",
      ],
    });
    assert.equal(readFileSync(one.config, "utf8"), before);
  });
});

describe("a folder named in the config, by whatever way round", () => {
  /**
   * Ways of writing one folder, from the folder of the config: through links, links to links, `..` out of the
   * folder a link leads to, and with the last names not there yet. Each leads to `real/kept/backups`.
   */
  function ways(directory: string): string[] {
    mkdirSync(join(directory, "real", "deep"), { recursive: true });
    mkdirSync(join(directory, "elsewhere"));
    symlinkSync(join(directory, "real"), join(directory, "alias"));
    symlinkSync("alias", join(directory, "alias-of-alias"));
    symlinkSync(join(directory, "real", "deep"), join(directory, "elsewhere", "down"));
    return [
      "real/kept/backups",
      "./real/./kept/backups/",
      "real/not-there/../kept/backups",
      "alias/kept/backups",
      "alias-of-alias/kept/backups",
      "alias-of-alias/deep/../kept/backups",
      // Out of the folder the link leads to, which is `real`: struck out as written, this would be `elsewhere/kept/backups`.
      "elsewhere/down/../kept/backups",
      "elsewhere/down/../../alias/kept/x/../backups",
      `${directory}/elsewhere/down/../kept/backups`,
    ];
  }

  it("is one place for everything that shows it, checks it, makes it, writes to it and looks into it: the automatic backups", async () => {
    const probe = await instance();
    const count = ways(probe.directory).length;
    for (let i = 0; i < count; i++) {
      const one = await instance();
      const way = ways(one.directory)[i]!;
      const place = join(one.directory, "real", "kept", "backups");
      const wrong = join(one.directory, "elsewhere", "kept");
      const set = await run(["config", "set", "backup.folder", way, "--config", one.config]);
      assert.equal(set.code, 0, `${way}: ${set.err}`);

      // What the config is loaded as, and what config show prints.
      assert.equal(loadConfig(one.config, {}).backupDir, place, way);
      assert.equal(JSON.parse((await run(["config", "show", "--json", "--config", one.config])).out).backup_folder, place, way);
      // The service: what it says, and where it writes.
      await one.start();
      assert.equal(one.service.backups.status().folder, place, way);
      await one.pass(0);
      assert.deepEqual(one.warnings, [], way);
      assert.deepEqual(readdirSync(place).filter((name) => name.endsWith(".sqlite")), [named(START)], way);
      assert.equal(existsSync(join(place, BACKUPS_LOCK)), true, way);
      assert.equal(existsSync(wrong), false, `${way}: nothing was made where the path leads when it is struck out as written`);
      assert.match(one.logged.find((line) => line.includes("backup=automatic"))!, new RegExp(` folder=${place}$`), way);
      // The doctor, with the service and without.
      const checks = (await one.doctor()).checks;
      assert.match(checks.find((check) => check.title === "automatic backups are on")!.detail!, new RegExp(`^every 24 hours into ${place}, .*; last ${iso(START).replace(".", "\\.")}, `), way);
      assert.equal(checks.find((check) => check.title === "running settings match the config")!.level, "ok", way);
      await one.service.stop();
      // The first lines of serve.
      const child = spawn(process.execPath, [BIN, "serve", "--config", one.config], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
      let printed = "";
      child.stdout.on("data", (chunk: Buffer) => (printed += chunk.toString()));
      for (const until = Date.now() + 15_000; Date.now() < until && !/Auth is off|connection needs/.test(printed); ) await new Promise((resolve) => setTimeout(resolve, 25));
      const gone = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await gone;
      assert.match(printed, new RegExp(`Backups +every 24 hours into ${place}; `), way);
      // And a backup by hand, given the same words from the same folder, goes to the same place and says so.
      const byHand = JSON.parse((await run(["backup", way.startsWith("/") ? way : `${one.directory}/${way}`, "--json", "--config", one.config])).out);
      assert.equal(byHand.folder, place, way);
      assert.equal(readdirSync(place).filter((name) => /^default-\d{8}-\d{6}-\d{3}\.sqlite$/.test(name)).length, 1, way);
      assert.equal(statSync(byHand.files[0].file).ino, statSync(join(place, readdirSync(place).find((name) => /^default-\d{8}-\d{6}-\d{3}\.sqlite$/.test(name))!)).ino, way);
      assert.equal(existsSync(wrong), false, way);
    }
  });

  it("is one place for everything that shows it, makes it, holds it and reads it: the data", async () => {
    const probe = await instance();
    const count = ways(probe.directory).length;
    for (let i = 0; i < count; i++) {
      const one = await instance();
      const way = ways(one.directory)[i]!;
      const place = join(one.directory, "real", "kept", "backups");
      setValue(one.config, "data_dir", way);
      setValue(one.config, "backup.folder", "kept-elsewhere");
      assert.equal(loadConfig(one.config, {}).dataDir, place, way);
      await one.start();
      assert.deepEqual(readdirSync(place).filter((name) => name === "default.sqlite" || name === "vigile.lock").sort(), ["default.sqlite", "vigile.lock"], way);
      assert.equal(existsSync(join(one.directory, "elsewhere", "kept")), false, way);
      await one.pass(0);
      assert.deepEqual(one.automatic(join(one.directory, "kept-elsewhere")), [named(START)], way);
      const report = await one.doctor();
      assert.equal(report.failed, 0, way);
      assert.equal(report.checks.find((check) => check.title === "data folder is writable")!.detail, place, way);
      assert.equal(report.checks.find((check) => check.title === "port belongs to this instance")!.level, "ok", way);
      await one.service.stop();
      // The backups may not go there, by any of the ways of writing it.
      for (const other of ["real/kept/backups", "alias/kept/backups", "elsewhere/down/../kept/x/../backups"]) {
        const refused = await run(["config", "set", "backup.folder", other, "--config", one.config]);
        assert.equal(refused.code, 1, `${way} and ${other}`);
        assert.match(refused.err, /A backup cannot go into the data folder itself\./);
        const byHand = await run(["backup", `${one.directory}/${other}`, "--config", one.config]);
        assert.equal(byHand.code, 1, `${way} and ${other}`);
        assert.match(byHand.err, /A backup cannot go into the data folder itself\./);
      }
      // A backup taken by hand, named by a way round, is restored from by any other.
      const taken = JSON.parse((await run(["backup", `${one.directory}/elsewhere/down/../by-hand`, "--json", "--config", one.config])).out);
      assert.equal(taken.folder, join(one.directory, "real", "by-hand"), way);
      const name = taken.files[0].file.slice(taken.folder.length + 1);
      const restored = await run(["restore-backup", `${one.directory}/alias-of-alias/deep/../by-hand/${name}`, "--json", "--config", one.config]);
      assert.equal(restored.code, 0, `${way}: ${restored.err}`);
      assert.deepEqual([JSON.parse(restored.out).from, JSON.parse(restored.out).file], [taken.files[0].file, join(place, "default.sqlite")], way);
    }
  });

  it("the reviewer's case: a backup by hand into a link's folder and out of it again goes where the system goes, and says so", async () => {
    const one = await instance();
    await one.start();
    await one.service.stop();
    mkdirSync(join(one.directory, "far", "away"), { recursive: true });
    symlinkSync(join(one.directory, "far", "away"), join(one.directory, "alias"));
    // `alias/..` is `far`, the folder above the one the link leads to: not the folder the link lies in.
    const taken = await run(["backup", `${one.directory}/alias/..`, "--json", "--config", one.config]);
    assert.equal(taken.code, 0, taken.err);
    const answer = JSON.parse(taken.out);
    assert.equal(answer.folder, join(one.directory, "far"));
    assert.equal(readdirSync(join(one.directory, "far")).filter((name) => name.endsWith(".sqlite")).length, 1);
    assert.equal(answer.files[0].file.startsWith(`${join(one.directory, "far")}/default-`), true);
    assert.deepEqual(readdirSync(one.directory).filter((name) => name.endsWith(".sqlite")), [], "nothing was written into the folder the link lies in");
    // And the data folder is refused that way too: `alias/../../data` is the data folder.
    const refused = await run(["backup", `${one.directory}/alias/../../data`, "--config", one.config]);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /A backup cannot go into the data folder itself\./);
  });
});

describe("what a service keeps of its last backup for the next start", () => {
  const kept = (one: Instance): any => JSON.parse(readFileSync(join(one.data, MEMORY_FILE), "utf8"));
  /** Stops the service, lets a minute pass, and starts it again. */
  async function restartedAMinuteLater(one: Instance): Promise<void> {
    await one.service.stop();
    one.clock.now += MINUTE;
    one.clock.mono += MINUTE;
    await one.start();
  }
  const NEVER_WRITABLE = "in the way";

  it("is not tried at every start when it fails: restarted every minute, a backup into a folder that cannot be made is tried every ten minutes", async () => {
    const one = await instance();
    writeFileSync(one.backups, NEVER_WRITABLE);
    await one.start();
    await one.pass(0);
    assert.equal(one.warnings.length, 1);
    const failure = one.service.backups.status().failure!;
    assert.deepEqual([failure.at, failure.retry_at], [iso(START), iso(START + 10 * MINUTE)]);
    for (let minute = 1; minute <= 25; minute++) {
      await restartedAMinuteLater(one);
      // Started again, it knows of the failure, says so to the doctor, and waits what is left.
      const warned: number = one.warnings.length;
      const last = one.service.backups.status().failure!;
      if (minute % 10 !== 0) assert.equal(last.retry_at, iso(START + Math.ceil(minute / 10) * 10 * MINUTE), `minute ${minute}`);
      await one.pass(0);
      assert.equal(one.warnings.length - warned, minute % 10 === 0 ? 1 : 0, `minute ${minute}`);
    }
    assert.equal(one.warnings.length, 3, "at the start, and after ten and twenty minutes: not at each of twenty-five starts");
    const doctor = (await one.doctor()).checks.find((check) => check.title === "last automatic backup worked")!;
    assert.equal(doctor.level, "fail");
    assert.match(doctor.detail!, new RegExp(`^failed at ${iso(START + 20 * MINUTE).replace(".", "\\.")}: `));
    assert.match(doctor.fix!, new RegExp(`The service tries again at ${iso(START + 30 * MINUTE).replace(".", "\\.")}\\.$`));

    // Once the folder can be made, the next try works, and what is kept says so.
    rmSync(one.backups);
    await restartedAMinuteLater(one);
    await one.pass(4 * MINUTE);
    assert.deepEqual(one.automatic(), [named(START + 30 * MINUTE)]);
    assert.deepEqual([kept(one).kind, kept(one).at, kept(one).folder], ["complete", START + 30 * MINUTE, one.backups]);
    await restartedAMinuteLater(one);
    assert.deepEqual([one.service.backups.status().failure, one.service.backups.status().outcome], [null, { at: iso(START + 30 * MINUTE), kind: "complete", said: null }]);
  });

  it("is a file in the data folder, private, no tenant and no backup: a backup by hand does not copy it, and the doctor finds nothing wrong with it", async () => {
    const one = await instance();
    writeFileSync(one.backups, NEVER_WRITABLE);
    await one.start();
    await one.pass(0);
    const file = join(one.data, MEMORY_FILE);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(kept(one)).sort(), ["actions", "at", "ended", "folder", "kind", "said", "steady", "version"]);
    assert.deepEqual([kept(one).version, kept(one).kind, kept(one).folder, kept(one).at], [2, "incomplete", one.backups, START]);
    assert.deepEqual(readdirSync(one.data).filter((name) => name.includes("vigile-backups")), [MEMORY_FILE], "written as a whole: no working file is left");
    const byHand = JSON.parse((await run(["backup", join(one.directory, "by-hand"), "--json", "--config", one.config])).out);
    assert.deepEqual(readdirSync(byHand.folder).filter((name) => !/^default-\d/.test(name)), [".vigile-backup-operation.hold"]);
    assert.deepEqual((await one.doctor()).checks.filter((check) => check.title.startsWith("store ")).map((check) => [check.title, check.level]), [['store "default" can be written', "ok"], ['store "default" is intact', "ok"]], "it is no tenant");
    assert.deepEqual(backupMemory(one.data).read(), { folder: one.backups, at: START, ended: START, steady: 1_000_000, kind: "incomplete", said: kept(one).said, actions: kept(one).actions });
  });

  it("was begun and never ended, when the service was killed: the next start waits what is left of ten minutes, and goes by a backup that is there all the same", async () => {
    // Killed after it had kept that a backup was begun, and before anything of the backup was whole.
    const one = await instance();
    await one.start();
    await one.service.stop();
    await backupMemory(one.data).write({ folder: one.backups, at: START - 3 * MINUTE, ended: START - 3 * MINUTE, kind: "begun", said: null, actions: [] });
    await one.start();
    assert.deepEqual([one.service.backups.status().failure, one.service.backups.status().outcome, one.service.backups.status().next_due], [null, null, iso(START + 7 * MINUTE)]);
    await one.pass(7 * MINUTE - 1);
    assert.deepEqual(one.automatic(), []);
    await one.pass(1);
    assert.deepEqual(one.automatic(), [named(START + 7 * MINUTE)]);
    assert.deepEqual(one.warnings, []);

    // Killed when the backup was whole, before it had kept how the backup ended: the backup is there, and counts.
    const other = await instance();
    await other.start();
    await other.service.stop();
    takeBackup({ dataDir: other.data, folder: other.backups, at: new Date(START - 3 * MINUTE), automatic: { keep: 30 } });
    await backupMemory(other.data).write({ folder: other.backups, at: START - 3 * MINUTE, ended: START - 3 * MINUTE, kind: "begun", said: null, actions: [] });
    await other.start();
    assert.deepEqual([other.service.backups.status().last_at, other.service.backups.status().next_due], [iso(START - 3 * MINUTE), iso(START - 3 * MINUTE + 24 * HOUR)]);
    await other.pass(HOUR);
    assert.deepEqual(other.automatic(), [named(START - 3 * MINUTE)]);
  });

  it("holds for elapsed time between two starts even when the wall clock is moved back or forward", async () => {
    const back = await instance();
    writeFileSync(back.backups, NEVER_WRITABLE);
    await back.start();
    await back.pass(0);
    await back.service.stop();
    back.clock.now = START - 30 * 24 * HOUR;
    await back.start();
    assert.equal(back.service.backups.status().failure!.retry_at, iso(START - 30 * 24 * HOUR + 10 * MINUTE));
    await back.pass(10 * MINUTE - 1);
    assert.equal(back.warnings.length, 1);
    await back.pass(1);
    assert.equal(back.warnings.length, 2, "ten minutes after the start, not thirty days");

    const forward = await instance();
    writeFileSync(forward.backups, NEVER_WRITABLE);
    await forward.start();
    await forward.pass(0);
    await forward.service.stop();
    forward.clock.now = START + 30 * 24 * HOUR;
    await forward.start();
    await forward.pass(0);
    assert.equal(forward.warnings.length, 1, "a wall-clock jump alone does not end the pause");
    await forward.pass(10 * MINUTE);
    assert.equal(forward.warnings.length, 2, "tried after ten minutes of elapsed time");
  });

  it("is each service's own: of two whose backups go to one folder, the one that is refused waits over its restarts, and the other is not held up by it", async () => {
    const first = await instance();
    const second = await instance();
    setValue(second.config, "backup.folder", first.backups);
    await first.start();
    await first.pass(0);
    await second.start();
    await second.pass(0);
    assert.equal(second.warnings.length, 1);
    assert.match(second.warnings[0]!, /failed: Another Vigile service takes its automatic backups into /);
    for (let minute = 1; minute < 10; minute++) {
      await restartedAMinuteLater(second);
      await second.pass(0);
    }
    assert.equal(second.warnings.length, 1, "restarted nine times in nine minutes, it has not tried again");
    assert.deepEqual([kept(first).kind, kept(first).folder], ["complete", first.backups]);
    assert.deepEqual([kept(second).kind, kept(second).folder], ["incomplete", first.backups]);
    await first.pass(24 * HOUR);
    assert.deepEqual(first.automatic(), [named(START), named(START + 24 * HOUR)]);
    assert.deepEqual(first.warnings, []);
  });

  it("is left alone while backups are off, counts again when they are on, and says nothing of a backup into another folder", async () => {
    const one = await instance();
    writeFileSync(one.backups, NEVER_WRITABLE);
    await one.start();
    await one.pass(0);
    const was = readFileSync(join(one.data, MEMORY_FILE), "utf8");
    // Off: nothing is read, shown or written.
    setValue(one.config, "backup.enabled", "false");
    await restartedAMinuteLater(one);
    assert.equal(one.service.backups.status().failure, null);
    await one.pass(HOUR);
    assert.equal(readFileSync(join(one.data, MEMORY_FILE), "utf8"), was);
    // On again, an hour later: the failure is still the last that is known, and it is tried at the first look.
    unsetValue(one.config, "backup.enabled");
    await restartedAMinuteLater(one);
    assert.equal(one.service.backups.status().failure!.at, iso(START));
    await one.pass(0);
    assert.equal(one.warnings.length, 2);
    // Sent to another folder a minute later: what is kept is of the old one, and the new one is tried at once.
    setValue(one.config, "backup.folder", "elsewhere");
    await restartedAMinuteLater(one);
    assert.deepEqual([one.service.backups.status().failure, one.service.backups.status().outcome], [null, null]);
    await one.pass(0);
    assert.deepEqual(one.automatic(join(one.directory, "elsewhere")), [named(one.clock.now)]);
    assert.equal(kept(one).folder, join(one.directory, "elsewhere"));
  });
});

describe("a path that leads nowhere", () => {
  let root: string;
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "vigile-nowhere-")));
    mkdirSync(join(root, "real"));
    writeFileSync(join(root, "real", "file"), "a file");
    symlinkSync("itself", join(root, "itself"));
    symlinkSync(join(root, "round-2"), join(root, "round-1"));
    symlinkSync(join(root, "round-1"), join(root, "round-2"));
    symlinkSync(join(root, "itself"), join(root, "to-a-circle"));
    mkdirSync(join(root, "locked", "inside"), { recursive: true });
    // What each of them would be if `..` were struck out together with the name before it: a folder that is there.
    mkdirSync(join(root, "backups"));
    writeFileSync(join(root, "backups", "sentinel"), "as it was");
  });
  after(() => {
    chmodSync(join(root, "locked"), 0o700);
    rmSync(root, { recursive: true, force: true });
  });

  /** A path from the folder of the test, why it leads nowhere, and whether only an account that is kept out of folders can see it. */
  const NOWHERE: Array<[what: string, path: string, cause: RegExp, needsToBeKeptOut?: true]> = [
    ["a link to itself", "itself", /\/itself: its links go round in a circle$/],
    ["two links that lead to each other", "round-1", /\/round-1: its links go round in a circle$/],
    ["a link to a circle of links", "to-a-circle", /\/to-a-circle: its links go round in a circle$/],
    ["into a circle of links", "round-2/data", /\/round-2: its links go round in a circle$/],
    ["out of a circle of links again", "itself/../backups", /\/itself: its links go round in a circle$/],
    ["out of two links that lead to each other", "round-1/../backups", /\/round-1: its links go round in a circle$/],
    ["through a circle of links, a long way round", "real/../round-1/x/../../backups", /\/round-1: its links go round in a circle$/],
    ["through a file", "real/file/data", /\/real\/file\/data: something on the way is not a folder, and the path goes on through it$/],
    ["into a file and out of it again", "real/file/../../backups", /\/real\/file\/\.\.: something on the way is not a folder, and the path goes on through it$/],
    ["a file with a dot after it", "real/file/.", /\/real\/file\/\.: something on the way is not a folder, and the path goes on through it$/],
    ["a file with a separator after it", "real/file/", /\/real\/file\/: something on the way is not a folder, and the path goes on through it$/],
    ["into a folder this account may not go through", "locked/inside", /\/locked\/inside: this account may not go through a folder on the way$/, true],
    ["into a folder this account may not go through, and out of it again", "locked/../backups", /\/locked\/\.\.: this account may not go through a folder on the way$/, true],
    ["a character that no path can have", "real/da\0ta", /it has a character that no path can have$/],
  ];

  for (const [what, path, cause, needsToBeKeptOut] of NOWHERE) {
    it(`is said to, with why, and is made into no other path: ${what}`, () => {
      // Someone who may go through every folder, as root may, is not kept out of one.
      if (needsToBeKeptOut && process.getuid?.() === 0) return;
      if (needsToBeKeptOut) chmodSync(join(root, "locked"), 0o000);
      try {
        const written = `${root}/${path}`;
        const led = whereTo(written);
        assert.equal(led.ok, false, JSON.stringify(led));
        if (led.ok) return;
        // The path in full, exactly as it was written: nothing struck out of it, nothing put in its place.
        assert.equal(led.written, written);
        assert.match(led.cause, cause);
        assert.throws(() => placeOf(written), (error: unknown) => error instanceof NoPlace && error.written === written && error.message === `${written} leads nowhere: ${led.cause}`);
        // It is no place, so it is the same place as nothing: not as itself, and not as what it would be struck out.
        assert.equal(samePlace(written, written), false);
        assert.equal(samePlace(written, join(root, "backups")), false);
        assert.equal(samePlace(join(root, "backups"), written), false);
        // Written from the folder the process is in, it is the same path in full, with nothing struck out.
        const fromHere = whereTo(`${relative(process.cwd(), root)}/${path}`);
        assert.equal(fromHere.ok, false);
        if (!fromHere.ok) assert.equal(fromHere.written, `${process.cwd()}/${relative(process.cwd(), root)}/${path}`);
      } finally {
        if (needsToBeKeptOut) chmodSync(join(root, "locked"), 0o700);
      }
    });
  }

  it("is no path at all when it is empty, and a path that only has what is not there yet leads somewhere", () => {
    assert.deepEqual(whereTo(""), { ok: false, written: `${process.cwd()}/`, cause: "it is empty" });
    assert.deepEqual(whereTo(`${root}/real/not/there/yet`), { ok: true, place: join(root, "real", "not", "there", "yet") });
    // A link that leads nowhere yet is followed to where it leads: that is where the system would make the folder.
    symlinkSync(join(root, "to-be-made"), join(root, "dangling"));
    assert.deepEqual(whereTo(`${root}/dangling/data`), { ok: true, place: join(root, "to-be-made", "data") });
    // A file as the last name is a place: what is made of it is for whoever goes there.
    assert.deepEqual(whereTo(`${root}/real/file`), { ok: true, place: join(root, "real", "file") });
  });

  /** The paths that would be the folder with the sentinel, were `..` struck out as written. */
  const INTO_THE_SENTINEL: Array<[what: string, path: string, needsToBeKeptOut?: true]> = [
    ["out of a link to itself", "itself/../backups"],
    ["out of two links that lead to each other", "round-1/../backups"],
    ["out of a file", "real/file/../../backups"],
    ["out of a folder this account may not go through", "locked/../backups", true],
  ];
  for (const [what, path, needsToBeKeptOut] of INTO_THE_SENTINEL) {
    it(`is refused by everything that would read or write there, and the folder it would be struck out to is not touched: ${what}`, async () => {
      if (needsToBeKeptOut && process.getuid?.() === 0) return;
      const one = await instance();
      await one.start();
      await one.pass(0);
      await one.service.stop();
      const written = `${root}/${path}`;
      const sentinel = join(root, "backups");
      // A backup that the path would lead to, struck out: restored from, it would be the wrong file.
      const lure = join(sentinel, named(START));
      if (!existsSync(lure)) writeFileSync(lure, readFileSync(join(one.backups, named(START))));
      const untouched = () => readdirSync(sentinel).sort().map((name) => [name, statSync(join(sentinel, name)).size, statSync(join(sentinel, name)).mtimeMs]);
      const was = untouched();
      const config = readFileSync(one.config, "utf8");
      if (needsToBeKeptOut) chmodSync(join(root, "locked"), 0o000);
      try {
        const NOWHERE_SAID = /leads nowhere: /;
        // The config commands, for the backups and for the data.
        for (const key of ["backup.folder", "data_dir"]) {
          const set = await run(["config", "set", key, written, "--config", one.config]);
          assert.equal(set.code, 1, key);
          assert.match(set.err, new RegExp(`${key.replace(".", "\\.")}: .* leads nowhere: `));
        }
        assert.equal(readFileSync(one.config, "utf8"), config, "nothing was written to the config");
        // Given for one run, in the environment or as an option: the config does not load, so nothing starts.
        for (const [environment, options] of [[{ VIGILE_BACKUP_FOLDER: written }, {}], [{}, { "backup.folder": written }], [{ VIGILE_DATA_DIR: written }, {}], [{}, { data_dir: written }]] as Array<[NodeJS.ProcessEnv, Record<string, string>]>) {
          await assert.rejects(one.start({}, undefined, environment, options), (error: unknown) => error instanceof Error && error.name === "ConfigError" && NOWHERE_SAID.test(error.message), JSON.stringify([environment, options]));
        }
        const served = await run(["serve", "--backup.folder", written, "--config", one.config]);
        assert.equal(served.code, 1);
        assert.match(served.err, /backup\.folder: .* leads nowhere: /);
        // Written into the file by hand: the doctor says what is wrong with the config, and asks no further.
        writeFileSync(one.config, `${config}\n[backup]\nfolder = ${JSON.stringify(written)}\n`);
        const report = await one.doctor();
        const check = report.checks.find((found) => found.title === "config file passes the check")!;
        assert.equal(check.level, "fail");
        assert.match(check.fix!, /backup\.folder: .* leads nowhere: .*\. Name a folder that the path leads to$/);
        assert.equal(report.checks.some((found) => found.section !== "Config"), false);
        writeFileSync(one.config, config);
        // A backup by hand, and a restore from the file the path would lead to if it were struck out.
        const byHand = await run(["backup", written, "--json", "--config", one.config]);
        assert.equal(byHand.code, 1);
        assert.deepEqual([JSON.parse(byHand.err).error.code, NOWHERE_SAID.test(JSON.parse(byHand.err).error.message)], ["usage", true], byHand.err);
        assert.throws(() => takeBackup({ dataDir: one.data, folder: written, at: new Date(START) }), (error: unknown) => error instanceof BackupRefused && error.message.startsWith(`${written} leads nowhere: `));
        const restored = await run(["restore-backup", `${written}/${named(START)}`, "--config", one.config]);
        assert.equal(restored.code, 1);
        assert.match(restored.err, /leads nowhere: /);
        assert.match(restored.err, /Give the backup file by a path that leads to it\./);
      } finally {
        if (needsToBeKeptOut) chmodSync(join(root, "locked"), 0o700);
      }
      assert.deepEqual(untouched(), was, "the folder the path would be struck out to is as it was");
      assert.equal(readFileSync(join(sentinel, "sentinel"), "utf8"), "as it was");
      // And the data is the data it was: nothing was restored over it.
      await one.start();
      assert.equal((await one.doctor()).failed, 0);
    });
  }
});

describe("what is read of the file a service keeps of its last backup", () => {
  const SOUND = { version: 1, folder: "/b", at: START, ended: START + 5, kind: "incomplete", said: "It failed.", actions: ["Mend it."] };
  const without = (name: string): Record<string, unknown> => Object.fromEntries(Object.entries(SOUND).filter(([key]) => key !== name));

  it("is what the service wrote, or nothing: every part of it has to be what the service writes", () => {
    assert.deepEqual(decodeRemembered(JSON.stringify(SOUND)), { folder: "/b", at: START, ended: START + 5, kind: "incomplete", said: "It failed.", actions: ["Mend it."] });
    // As far as a date goes, and no further: of a moment beyond that no date can be written out.
    for (const moment of [8.64e15, -8.64e15, 0]) assert.equal(decodeRemembered(JSON.stringify({ ...SOUND, at: moment }))!.at, moment);
    assert.doesNotThrow(() => new Date(decodeRemembered(JSON.stringify({ ...SOUND, at: 8.64e15 }))!.at).toISOString());
    // The end may lie before the beginning: a clock that was set back while the backup was written.
    assert.notEqual(decodeRemembered(JSON.stringify({ ...SOUND, ended: START - HOUR })), null);
    // A name given twice counts by the last, as JSON has it.
    assert.equal(decodeRemembered(JSON.stringify(SOUND).replace('"kind":"incomplete"', '"kind":"nonsense","kind":"begun"'))!.kind, "begun");
    assert.equal(decodeRemembered(JSON.stringify(SOUND).replace(`"at":${START}`, '"at":1,"at":1e20')), null);
    assert.equal(decodeRemembered(JSON.stringify(SOUND).replace(`"at":${START}`, '"at":1e20,"at":1'))!.at, 1);

    const NOT_IT: Array<[what: string, text: string]> = [
      ["a moment that is finite and no date: 1e20", JSON.stringify({ ...SOUND, at: 1e20 })],
      ["an end that is finite and no date: -1e20", JSON.stringify({ ...SOUND, ended: -1e20 })],
      ["a moment one millisecond past what a date holds", JSON.stringify({ ...SOUND, at: 8.64e15 + 2 })],
      ["a moment that is no whole number", JSON.stringify({ ...SOUND, at: START + 0.5 })],
      ["a moment as text", JSON.stringify({ ...SOUND, at: "2026-11-13T09:00:00.000Z" })],
      ["a moment that is nothing", JSON.stringify({ ...SOUND, ended: null })],
      ["a number too large to be one", JSON.stringify(SOUND).replace(`"at":${START}`, '"at":1e999')],
      ["a kind there is none of", JSON.stringify({ ...SOUND, kind: "done" })],
      ["a kind that every object answers to", JSON.stringify({ ...SOUND, kind: "constructor" })],
      ["a kind that is no text", JSON.stringify({ ...SOUND, kind: ["incomplete"] })],
      ["another version", JSON.stringify({ ...SOUND, version: 2 })],
      ["a version as text", JSON.stringify({ ...SOUND, version: "1" })],
      ["no folder", JSON.stringify({ ...SOUND, folder: "" })],
      ["a folder that is a list", JSON.stringify({ ...SOUND, folder: ["/b"] })],
      ["a folder longer than any path", JSON.stringify({ ...SOUND, folder: "/".padEnd(5000, "b") })],
      ["what was said, as a number", JSON.stringify({ ...SOUND, said: 5 })],
      ["what is to be done, as a text", JSON.stringify({ ...SOUND, actions: "Mend it." })],
      ["what is to be done, with something that is no text in it", JSON.stringify({ ...SOUND, actions: ["Mend it.", null] })],
      ["more to be done than the service ever says", JSON.stringify({ ...SOUND, actions: Array.from({ length: 17 }, () => "x") })],
      ["a field too many", JSON.stringify({ ...SOUND, more: true })],
      ["a field under a name every object has", JSON.stringify(SOUND).replace("{", '{"__proto__":{"at":1},')],
      ...FIELD_NAMES.map((name): [string, string] => [`no ${name}`, JSON.stringify(without(name))]),
      ["a list", JSON.stringify([SOUND])],
      ["a text", JSON.stringify(JSON.stringify(SOUND))],
      ["a number", "5"],
      ["yes", "true"],
      ["nothing", "null"],
      ["an empty file", ""],
      ["something that is no JSON", "{ version: 1 }"],
      ["JSON cut short", JSON.stringify(SOUND).slice(0, -5)],
      ["an object nested deeper than anything reads", `${"[".repeat(50_000)}${"]".repeat(50_000)}`],
      ["more than the service writes", JSON.stringify({ ...SOUND, said: "x".repeat(70_000) })],
    ];
    for (const [what, text] of NOT_IT) assert.equal(decodeRemembered(text), null, what);
  });

  it("never fails, whatever the text and whatever the value: thousands of them, made from a seed", () => {
    // The same values at every run: a generator that needs no clock and no chance.
    let seed = 20261113;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = <T>(from: readonly T[]): T => from[Math.floor(next() * from.length)]!;
    const NUMBERS = [0, -0, 1, -1, 0.5, START, START + 0.25, 1e20, -1e20, 8.64e15, 8.64e15 + 2, -8.64e15 - 2, 1e308, -1e308, 5e-324, 2 ** 53, Number.MAX_SAFE_INTEGER];
    const TEXTS = ["", "/b", "begun", "incomplete", "complete", "complete_unreported", "constructor", "__proto__", "toString", "hasOwnProperty", "1", "null", "x".repeat(9000), "\u0000", "\ud800"];
    const NAMES = [...FIELD_NAMES, "__proto__", "constructor", "toString", "length", "more", ""];
    const value = (depth: number): unknown => {
      const kind = Math.floor(next() * (depth > 3 ? 5 : 8));
      if (kind === 0) return pick(NUMBERS);
      if (kind === 1) return pick(TEXTS);
      if (kind === 2) return null;
      if (kind === 3) return next() < 0.5;
      if (kind === 4) return next() * 1e17 - 5e16;
      if (kind === 5) return Array.from({ length: Math.floor(next() * 4) }, () => value(depth + 1));
      // An object: sometimes what the service writes, with some of its parts turned into something else.
      const made: Record<string, unknown> = next() < 0.7 ? { ...SOUND } : {};
      for (let i = Math.floor(next() * 4); i > 0; i--) {
        const name = pick(NAMES);
        if (next() < 0.2) delete made[name];
        else Object.defineProperty(made, name, { value: value(depth + 1), enumerable: true, configurable: true, writable: true });
      }
      return made;
    };
    let sound = 0;
    for (let i = 0; i < 5000; i++) {
      const made = value(0);
      const text = next() < 0.9 ? JSON.stringify(made) : JSON.stringify(made).slice(0, Math.floor(next() * 40));
      let decoded: ReturnType<typeof decodeRemembered>;
      assert.doesNotThrow(() => (decoded = decodeRemembered(text)), text.slice(0, 200));
      assert.doesNotThrow(() => isRemembered(made));
      if (decoded! === null) continue;
      sound++;
      // What comes through is what the service keeps: dates can be written of its moments, and the schedule starts on it.
      assert.doesNotThrow(() => [new Date(decoded!.at).toISOString(), new Date(decoded!.ended).toISOString()], text.slice(0, 200));
      assert.deepEqual(Object.keys(decoded!).sort(), FIELD_NAMES.filter((name) => name !== "version"));
    }
    assert.ok(sound > 50, `${sound} of the 5000 came through as what the service keeps`);

    // Values that are no JSON at all, which a store could hand over, are answered as well.
    const trap = new Proxy({}, { get: () => assert.fail("looked into"), ownKeys: () => assert.fail("listed"), has: () => assert.fail("asked") });
    const thrower = Object.defineProperty({ ...SOUND }, "at", { get: () => assert.fail("read"), enumerable: true });
    for (const odd of [undefined, 5n, Symbol("x"), () => SOUND, new Date(START), new Map(), trap, thrower, Object.create(SOUND), Object.assign(Object.create(null), SOUND), NaN, Infinity]) {
      assert.doesNotThrow(() => isRemembered(odd));
    }
    assert.equal(isRemembered(Object.create(SOUND)), false, "what it has from elsewhere is not its own");
    assert.equal(isRemembered(trap), false);
    assert.equal(isRemembered(thrower), false);
    assert.equal(isRemembered(Object.assign(Object.create(null), SOUND)), true);
  });

  it("does not keep the schedule from starting, whatever a store hands it: said once, a wait of ten minutes, written anew", async () => {
    const ODD: unknown[] = [
      { ...SOUND, at: 1e20 },
      { ...SOUND, ended: -1e20 },
      { ...SOUND, at: NaN },
      { ...SOUND, ended: Infinity },
      { ...SOUND, kind: "constructor" },
      { unreadable: 5 },
      { unreadable: "x".repeat(100_000) },
      "text",
      5,
      [],
      new Proxy({}, { get: () => assert.fail("looked into") }),
    ];
    for (const [i, odd] of [...ODD.entries(), [ODD.length, "throws"] as const]) {
      const warned: string[] = [];
      const written: Array<Remembered | null> = [];
      const memory: BackupMemory = {
        read: () => {
          if (odd === "throws") throw new Error("the disk does not answer");
          return odd as Remembered;
        },
        write: (remembered) => void written.push(remembered),
      };
      let clock = START;
      const source: BackupSource = { moments: () => [], take: () => ({ done: Promise.resolve({ kind: "complete", copies: 1, bytes: 1, removed: 0 }), cancel: async () => {} }), close: async () => {} };
      let schedule!: ReturnType<typeof startBackups>;
      assert.doesNotThrow(() => (schedule = startBackups({ everyHours: 24, folder: "/b", keep: 30, source, memory, now: () => clock, monotonic: () => clock, times: { ...BACKUP_TIMES, firstMs: 1_000_000_000, checkMs: 1_000_000_000 }, log: () => {}, warn: (line) => warned.push(line) })), `value ${i}`);
      assert.equal(warned.length, 1, `value ${i}`);
      assert.match(warned[0]!, /^What the service kept of its last automatic backup cannot be read: .{1,520} No backup is begun before 2026-11-13T09:10:00\.000Z, as after one that has just ended; the pause is kept anew\.$/s);
      assert.doesNotThrow(() => schedule.status());
      assert.deepEqual([schedule.status().failure, schedule.status().outcome, schedule.status().next_due], [null, null, iso(START + 10 * MINUTE)]);
      await schedule.check();
      assert.deepEqual(written.map((kept) => kept?.kind), ["begun"], "only the durable recovery-pause anchor is written within the ten minutes");
      clock += 10 * MINUTE;
      await schedule.check();
      assert.deepEqual(written.map((kept) => kept?.kind), ["begun", "begun", "complete"]);
      assert.equal(written.every(isRemembered), true);
      assert.equal(warned.length, 1);
      await schedule.stop();
    }
  });

  it("does not keep the service from starting or from answering: the file as it may be found, each one said once and written anew", async () => {
    const FOUND: Array<[what: string, make: (file: string) => void, says: RegExp]> = [
      ["a moment that is finite and no date", (file) => writeFileSync(file, JSON.stringify({ ...SOUND, at: 1e20 })), /is not what the service writes there\./],
      ["an end that is finite and no date", (file) => writeFileSync(file, JSON.stringify({ ...SOUND, ended: -1e20 })), /is not what the service writes there\./],
      ["a moment a day past what a date holds", (file) => writeFileSync(file, JSON.stringify({ ...SOUND, at: 8.64e15 + 86_400_000 })), /is not what the service writes there\./],
      ["something that is no JSON", (file) => writeFileSync(file, "not json at all"), /is not what the service writes there\./],
      ["an empty object", (file) => writeFileSync(file, "{}"), /is not what the service writes there\./],
      ["another version", (file) => writeFileSync(file, JSON.stringify({ ...SOUND, version: 2 })), /is not what the service writes there\./],
      ["a kind that every object answers to", (file) => writeFileSync(file, JSON.stringify({ ...SOUND, kind: "constructor" })), /is not what the service writes there\./],
      ["a list", (file) => writeFileSync(file, "[]"), /is not what the service writes there\./],
      ["nothing", (file) => writeFileSync(file, "null"), /is not what the service writes there\./],
      ["an empty file", (file) => writeFileSync(file, ""), /is not what the service writes there\./],
      ["a megabyte, of which nothing is read", (file) => writeFileSync(file, `{"said":"${"x".repeat(1_000_000)}"}`), /is larger than anything the service writes there\./],
      ["what the service writes, with a megabyte after it", (file) => writeFileSync(file, JSON.stringify(SOUND) + " ".repeat(1_000_000)), /is larger than anything the service writes there\./],
      ["a folder under its name", (file) => mkdirSync(file), /is not what the service writes there: it is a folder, not a file\./],
    ];
    for (const [what, make, says] of FOUND) {
      const one = await instance();
      mkdirSync(one.data);
      const file = join(one.data, MEMORY_FILE);
      make(file);
      if (what === "something that is no JSON") {
        const stopped = await one.doctor();
        assert.equal(stopped.checks.find((check) => check.title === "automatic backup state is readable")?.level, "fail");
        assert.match(stopped.checks.find((check) => check.title === "automatic backups are on")?.detail ?? "", /none taken yet, the first is due \d{4}-/);
      }
      // The service starts and listens, whatever the file.
      await one.start();
      assert.equal(one.warnings.length, what === "a folder under its name" ? 2 : 1, `${what}: ${one.warnings.join("\n")}`);
      assert.match(one.warnings[0]!, new RegExp(`^What the service kept of its last automatic backup cannot be read: ${file.replaceAll(".", "\\.")} `), what);
      assert.match(one.warnings[0]!, says, what);
      assert.match(one.warnings[0]!, new RegExp(`No backup is begun before ${iso(START + 10 * MINUTE).replace(".", "\\.")}, as after one that has just ended; the pause is kept anew\\.$`), what);
      assert.equal((await fetch(`${one.service.urls.base}/health`)).status, 200, what);
      assert.doesNotThrow(() => one.service.backups.status(), what);
      assert.equal((await one.doctor()).checks.find((check) => check.title === "last automatic backup worked")!.level, "ok", what);
      await one.pass(10 * MINUTE - 1);
      assert.deepEqual(one.automatic(), [], what);
      // A folder under the file's name cannot be written over: that is said once, and the backup is taken all the same.
      await one.pass(1);
      assert.deepEqual(one.automatic(), [named(START + 10 * MINUTE)], what);
      if (what === "a folder under its name") {
        assert.equal(one.warnings.length, 2, one.warnings.join("\n"));
        assert.match(one.warnings[1]!, /^What the service keeps of its last automatic backup could not be written: /);
      } else {
        assert.equal(one.warnings.length, 1, what);
        assert.equal(JSON.parse(readFileSync(file, "utf8")).kind, "complete", what);
        assert.equal(decodeRemembered(readFileSync(file, "utf8"))!.at, START + 10 * MINUTE, what);
      }
    }
  });
});

describe("a path, as the system itself walks it", () => {
  /** Whether the test runs as an account that no folder keeps out. */
  const everywhere = process.getuid?.() === 0;

  it("refuses an original spelling that exceeds the system path limit before shortening it", { skip: process.platform === "win32" }, () => {
    const root = mkdtempSync(join(tmpdir(), "vigile-long-path-"));
    try {
      const led = whereTo(`${root}/${"./".repeat(2_200)}backups`);
      assert.equal(led.ok, false);
      if (!led.ok) assert.match(led.cause, /name is too long/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  /**
   * A small tree with one of everything: folders, files, links to each, links whose words end in a separator,
   * links to nothing, links in a circle, and a folder nobody may go through. Made anew wherever it is asked for.
   */
  function tree(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vigile-walk-")));
    mkdirSync(join(root, "d", "e"), { recursive: true });
    writeFileSync(join(root, "f"), "file");
    writeFileSync(join(root, "d", "g"), "file");
    symlinkSync("d", join(root, "to-d"));
    symlinkSync("d/", join(root, "to-d-slash"));
    symlinkSync(join(root, "d", "e"), join(root, "to-e"));
    symlinkSync("f", join(root, "to-f"));
    symlinkSync("f/", join(root, "to-f-slash"));
    symlinkSync("../f", join(root, "d", "up-to-f"));
    symlinkSync("nothing", join(root, "to-nothing"));
    symlinkSync("nothing/", join(root, "to-nothing-slash"));
    symlinkSync("to-nothing", join(root, "to-to-nothing"));
    symlinkSync("round", join(root, "round"));
    symlinkSync("round-b", join(root, "round-a"));
    symlinkSync("round-a", join(root, "round-b"));
    mkdirSync(join(root, "shut", "in"), { recursive: true });
    if (!everywhere) chmodSync(join(root, "shut"), 0o000);
    return root;
  }
  const made: string[] = [];
  const fresh = (): string => {
    const root = tree();
    made.push(root);
    return root;
  };
  after(() => {
    for (const root of made) {
      try {
        chmodSync(join(root, "shut"), 0o700);
      } catch {
        // Gone already.
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
  const somethingThere = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  const NAMES = ["d", "e", "f", "g", "to-d", "to-d-slash", "to-e", "to-f", "to-f-slash", "up-to-f", "to-nothing", "to-nothing-slash", "to-to-nothing", "round", "round-a", "shut", "in", "new", "newer", ".", ".."];
  /** What the system says of a path: what it leads to, or the reason it gives for leading nowhere. */
  const system = (path: string): { place: string; folder: boolean } | { code: string } => {
    try {
      const stats = statSync(path);
      return { place: realpathSync.native(path), folder: stats.isDirectory() };
    } catch (error) {
      return { code: (error as NodeJS.ErrnoException).code ?? "?" };
    }
  };

  it("leads nowhere through a file that has a separator after it, written in the path or in what a link says, as the system has it", () => {
    const root = fresh();
    // The reviewer's two: a file with a separator after it, and a link whose words end in one.
    for (const [path, says] of [
      ["f/", /\/f\/: something on the way is not a folder, and the path goes on through it$/],
      ["f//", /something on the way is not a folder/],
      ["d/g/", /something on the way is not a folder/],
      ["to-f/", /something on the way is not a folder/],
      ["to-f-slash", /something on the way is not a folder/],
      ["to-f-slash/x", /something on the way is not a folder/],
      ["d/up-to-f/", /something on the way is not a folder/],
    ] as const) {
      const written = `${root}/${path}`;
      assert.deepEqual(system(written), { code: "ENOTDIR" }, path);
      const led = whereTo(written);
      assert.equal(led.ok, false, `${path}: ${JSON.stringify(led)}`);
      if (!led.ok) assert.match(led.cause, says, path);
    }
    // The same with a folder, or with nothing there yet, leads somewhere: to the folder, or to where it will be.
    for (const [path, place] of [
      ["d/", "d"],
      ["d//e///", "d/e"],
      ["to-d/", "d"],
      ["to-d-slash", "d"],
      ["to-d-slash/e/", "d/e"],
      ["f", "f"],
      ["to-f", "f"],
      ["new/", "new"],
      ["d/new//", "d/new"],
      ["to-nothing-slash", "nothing"],
      ["to-nothing-slash/x/", "nothing/x"],
    ] as const) {
      assert.deepEqual(whereTo(`${root}/${path}`), { ok: true, place: join(root, place) }, path);
    }
  });

  it("agrees with the system on every path made of these names, dots and separators: where it leads, or that it leads nowhere", () => {
    const root = fresh();
    let seed = 86400;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = <T>(from: readonly T[]): T => from[Math.floor(next() * from.length)]!;
    const counted = { there: 0, nowhere: 0, notYet: 0 };
    const notYet: string[] = [];
    for (let i = 0; i < 4000; i++) {
      const names = Array.from({ length: 1 + Math.floor(next() * 5) }, () => pick(NAMES));
      const path = `${root}${names.map((name) => `${next() < 0.15 ? "//" : "/"}${name}`).join("")}${next() < 0.25 ? "/" : ""}`;
      const says = system(path);
      const led = whereTo(path);
      if ("place" in says) {
        // There: the same place, by the same name.
        counted.there++;
        assert.deepEqual(led, { ok: true, place: says.place }, path);
      } else if (says.code === "ENOENT") {
        // Not there yet, or a link to nothing: checked below, on a tree of its own, by making it.
        if (led.ok) notYet.push(path.slice(root.length));
        else assert.match(led.cause, /not a folder|in a circle|may not go through/, `${path}: ${led.cause}`);
      } else {
        // The system does not walk it: neither does this, and for the same reason.
        counted.nowhere++;
        assert.equal(led.ok, false, `${path}: the system says ${says.code}, and this says ${JSON.stringify(led)}`);
        if (!led.ok) assert.match(led.cause, says.code === "ENOTDIR" ? /not a folder/ : says.code === "ELOOP" ? /in a circle/ : /may not go through/, path);
      }
      // Whatever it is, the path in full is the path as it was written, and asking again says the same.
      if (!led.ok) assert.equal(led.written, path);
      else assert.deepEqual(whereTo(led.place), led, `${path}: the place leads to itself`);
    }
    assert.ok(counted.there > 200 && counted.nowhere > 500 && notYet.length > 300, JSON.stringify({ ...counted, notYet: notYet.length }));

    // What is not there yet: the place is where the system finds the path once the folders are made. Each on a
    // tree of its own, made as the system makes them, name by name, by its own mkdir.
    let made = 0;
    let agreed = 0;
    for (const rest of notYet.filter((_, i) => i % 3 === 0).slice(0, 150)) {
      const scratch = fresh();
      const path = `${scratch}${rest}`;
      const led = whereTo(path);
      assert.equal(led.ok, true, path);
      if (!led.ok) continue;
      try {
        execFileSync("mkdir", ["-p", path], { stdio: "ignore" });
      } catch {
        // The system's own mkdir does not go through a link to nothing, and makes no folder where a file is.
        // Made by the place, then, where there is nothing yet.
        if (!somethingThere(led.place)) mkdirSync(led.place, { recursive: true });
      }
      made++;
      const now = system(path);
      if ("place" in now) {
        agreed++;
        assert.equal(now.place, led.place, `${rest}: made, it is where it was said to be`);
      }
      assert.equal(realpathSync.native(led.place), led.place, `${rest}: the place is a name without links`);
    }
    assert.ok(made > 100 && agreed > 80, `${agreed} of ${made} were found by the system where they were said to be`);
  });

  it("is what a folder for backups and a backup to restore from are held to: a folder or nothing yet for the one, a file for the other", async () => {
    const one = await instance();
    await one.start();
    await one.pass(0);
    await one.service.stop();
    const root = fresh();
    const backup = join(one.backups, named(START));
    // A folder for backups: a file under the name, with or without a separator after it, is refused, and nothing is written.
    for (const [path, says] of [
      [`${root}/f`, /is not a folder: it is a file\./],
      [`${root}/f/`, /leads nowhere: .*something on the way is not a folder/],
      [`${root}/to-f-slash`, /leads nowhere: .*something on the way is not a folder/],
      [`${root}/to-f`, /is not a folder: it is a file\./],
    ] as const) {
      const refused = await run(["backup", path, "--config", one.config]);
      assert.equal(refused.code, 1, path);
      assert.match(refused.err, says, path);
    }
    assert.equal(readFileSync(join(root, "f"), "utf8"), "file");
    for (const path of [`${root}/d/`, `${root}/to-d-slash`, `${root}/new/kept/`]) {
      const taken = await run(["backup", path, "--json", "--config", one.config]);
      assert.equal(taken.code, 0, `${path}: ${taken.err}`);
      assert.equal(JSON.parse(taken.out).folder, path.includes("new") ? join(root, "new", "kept") : join(root, "d"));
    }
    // A backup to restore from: a folder, or a file with a separator after it, is refused before it is opened.
    symlinkSync(backup, join(root, "to-backup"));
    symlinkSync(`${backup}/`, join(root, "to-backup-slash"));
    for (const [path, says] of [
      [`${backup}/`, /leads nowhere: .*something on the way is not a folder/],
      [`${root}/to-backup-slash`, /leads nowhere: .*something on the way is not a folder/],
      [`${root}/d`, /is not a file: it is a folder\./],
      [`${root}/to-d-slash`, /is not a file: it is a folder\./],
    ] as const) {
      const refused = await run(["restore-backup", path, "--tenant", "default", "--config", one.config]);
      assert.equal(refused.code, 1, path);
      assert.match(refused.err, says, path);
    }
    const restored = await run(["restore-backup", `${root}/to-backup`, "--tenant", "default", "--json", "--config", one.config]);
    assert.equal(restored.code, 0, restored.err);
    assert.equal(JSON.parse(restored.out).from, backup);
  });
});

describe("something that is no plain file, where the service reads or writes one", () => {
  const mkfifo = (path: string): void => void execFileSync("mkfifo", [path]);
  /** Whether this machine can make a pipe with a name. Where it cannot, there is nothing to plant. */
  const pipes = (() => {
    try {
      const probe = mkdtempSync(join(tmpdir(), "vigile-pipe-"));
      mkfifo(join(probe, "pipe"));
      rmSync(probe, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  })();

  /**
   * What a process of its own does with an instance: it starts the service, asks it over HTTP whether it
   * answers, has it look whether a backup is due, lets ten minutes pass and has it look again, stops it, and
   * prints what happened. A process of its own, and under a time limit: reading or writing a pipe that nobody
   * is at the other end of does not come back, and would take the test with it.
   */
  const script = `
import { loadConfig } from ${JSON.stringify(import.meta.resolve("@vigile/config"))};
import { startService } from ${JSON.stringify(new URL("./service.js", import.meta.url).href)};
const [config] = process.argv.slice(2);
const warned = [];
const clock = { now: ${START}, mono: 1000 };
const service = await startService({ loaded: loadConfig(config, {}), log: () => {}, warn: (line) => warned.push(line), now: () => clock.now, monotonic: () => clock.mono, backupTimes: { firstMs: 1e9, checkMs: 1e9 } });
const answers = async () => (await fetch(service.urls.base + "/health")).status;
const first = await answers();
await service.backups.check();
const afterFirst = { status: service.backups.status(), answers: await answers() };
clock.now += 600000; clock.mono += 600000;
await service.backups.check();
const afterSecond = { status: service.backups.status(), answers: await answers() };
await service.stop();
console.log(JSON.stringify({ first, afterFirst, afterSecond, warned }));
`;
  interface Told {
    first: number;
    afterFirst: { status: ReturnType<Service["backups"]["status"]>; answers: number };
    afterSecond: { status: ReturnType<Service["backups"]["status"]>; answers: number };
    warned: string[];
  }
  /** Runs it, and fails when it does not come back in time. */
  function inAProcess(one: Instance): Promise<Told> {
    const file = join(one.directory, "process.mjs");
    writeFileSync(file, script);
    return new Promise((resolve, reject) => {
      execFile(process.execPath, [file, one.config], { env: { PATH: process.env.PATH ?? "" }, timeout: 20_000, killSignal: "SIGKILL" }, (error, out, err) => {
        if (error) return reject(new Error(`the process did not come back with an answer within 20 seconds, or failed: ${error.message}\n${out}\n${err}`));
        resolve(JSON.parse(out) as Told);
      });
    });
  }
  /** An instance that has run once, so that its data folder is there, with nothing kept and no backup taken. */
  async function ran(): Promise<Instance> {
    const one = await instance();
    await one.start();
    await one.service.stop();
    rmSync(join(one.data, MEMORY_FILE), { force: true });
    return one;
  }
  /** Something in the folder of the instance that must come through untouched. */
  function sentinel(one: Instance): { path: string; untouched(): void } {
    const path = join(one.directory, "sentinel");
    writeFileSync(path, "as it was");
    const was = statSync(path);
    return {
      path,
      untouched: () => {
        assert.equal(readFileSync(path, "utf8"), "as it was");
        assert.deepEqual([statSync(path).size, statSync(path).mtimeMs, statSync(path).ino], [was.size, was.mtimeMs, was.ino]);
      },
    };
  }
  const NOT_A_FILE = (kind: string) => new RegExp(`^What the service kept of its last automatic backup cannot be read: .*vigile-backups\\.json is not what the service writes there: it is a ${kind}, not a file\\. No backup is begun before `);

  /** What may stand where the service keeps what it knows of its last backup, and what the service says of it. */
  const KEPT: Array<[what: string, plant: (file: string, one: Instance) => void, says: RegExp, needsPipes?: true]> = [
    ["a pipe that nobody writes to", (file) => mkfifo(file), NOT_A_FILE("pipe"), true],
    [
      "a link to a pipe that nobody writes to",
      (file, one) => {
        mkfifo(join(one.directory, "pipe"));
        symlinkSync(join(one.directory, "pipe"), file);
      },
      NOT_A_FILE("link"),
      true,
    ],
    ["a link to a file that would read as sound", (file, one) => (writeFileSync(join(one.directory, "sound.json"), JSON.stringify({ version: 1, folder: one.backups, at: START, ended: START, kind: "incomplete", said: "It failed.", actions: [] })), symlinkSync(join(one.directory, "sound.json"), file)), NOT_A_FILE("link")],
    ["a link to a device that never ends", (file) => symlinkSync("/dev/zero", file), NOT_A_FILE("link")],
    ["a link to nothing", (file) => symlinkSync("nothing-there", file), NOT_A_FILE("link")],
    ["a folder", (file) => mkdirSync(file), NOT_A_FILE("folder")],
  ];
  for (const [what, plant, says, needsPipes] of KEPT) {
    it(`does not hold the service up when it is where the service keeps what it knows of its last backup: ${what}`, async () => {
      if (needsPipes && !pipes) return;
      const one = await ran();
      const kept = sentinel(one);
      const file = join(one.data, MEMORY_FILE);
      plant(file, one);
      const told = await inAProcess(one);
      // It started, answered throughout, said once what it found, and waited as after a backup that had just ended.
      assert.deepEqual([told.first, told.afterFirst.answers, told.afterSecond.answers], [200, 200, 200]);
      assert.match(told.warned[0]!, says);
      assert.equal(told.afterFirst.status.last_at, null, "no backup is begun within ten minutes");
      // Then the backup is taken, and what is kept is written anew as a file of the service's own, in the place of
      // whatever had the name: nothing is written to it or through it. A folder cannot be replaced: that is said.
      assert.equal(told.afterSecond.status.last_at, iso(START + 10 * MINUTE));
      if (what === "a folder") {
        assert.equal(told.warned.length, 2, told.warned.join("\n"));
        assert.match(told.warned[1]!, /^What the service keeps of its last automatic backup could not be written: /);
        assert.equal(lstatSync(file).isDirectory(), true);
      } else {
        assert.equal(told.warned.length, 1, told.warned.join("\n"));
        assert.equal(lstatSync(file).isFile(), true, "a plain file now");
        assert.equal(decodeRemembered(readFileSync(file, "utf8"))!.kind, "complete");
      }
      assert.deepEqual(readdirSync(one.data).filter((name) => name.endsWith(".tmp")), []);
      kept.untouched();
      if (existsSync(join(one.directory, "sound.json"))) assert.equal(JSON.parse(readFileSync(join(one.directory, "sound.json"), "utf8")).kind, "incomplete", "what the link led to is as it was");
      if (existsSync(join(one.directory, "pipe"))) assert.equal(lstatSync(join(one.directory, "pipe")).isFIFO(), true, "the pipe the link led to is still there, and was not opened");
    });
  }

  /** What may stand under the name the service writes that file under before it gives it its name. */
  const WORKING: Array<[what: string, plant: (working: string, one: Instance, kept: string) => void, written: boolean, needsPipes?: true]> = [
    ["a pipe that nobody reads", (working) => mkfifo(working), true, true],
    ["a link to a pipe that nobody reads", (working, one) => (mkfifo(join(one.directory, "pipe")), symlinkSync(join(one.directory, "pipe"), working)), true, true],
    ["a link to a file of someone's", (working, _one, kept) => symlinkSync(kept, working), true],
    ["a second name of a file of someone's", (working, _one, kept) => linkSync(kept, working), true],
    ["a file left from before", (working) => writeFileSync(working, "left"), true],
    ["a link to nothing", (working) => symlinkSync("nothing-there", working), true],
    ["a folder with something in it", (working) => (mkdirSync(working), writeFileSync(join(working, "theirs"), "theirs")), false],
  ];
  for (const [what, plant, written, needsPipes] of WORKING) {
    it(`does not hold the service up when it is under the name that file is written under: ${what}`, async () => {
      if (needsPipes && !pipes) return;
      const one = await ran();
      const kept = sentinel(one);
      const working = join(one.data, `${MEMORY_FILE}.tmp`);
      plant(working, one, kept.path);
      const told = await inAProcess(one);
      assert.deepEqual([told.first, told.afterFirst.answers, told.afterSecond.answers], [200, 200, 200]);
      // The backup is taken at the first look, whatever becomes of what is kept of it.
      assert.equal(told.afterFirst.status.last_at, iso(START));
      assert.deepEqual(one.automatic(), [named(START)]);
      kept.untouched();
      if (written) {
        // The entry under the name was taken away, as the entry it was, and a file of the service's own made.
        assert.deepEqual(told.warned, []);
        assert.equal(decodeRemembered(readFileSync(join(one.data, MEMORY_FILE), "utf8"))!.kind, "complete");
        assert.equal(lstatSync(join(one.data, MEMORY_FILE)).nlink, 1, "a file of its own, with one name");
        assert.equal(existsSync(working) || lstatSync(working, { throwIfNoEntry: false }) !== undefined, false);
      } else {
        // A folder is not taken away, with what is in it: that is said once, and the service goes on.
        assert.equal(told.warned.length, 1, told.warned.join("\n"));
        assert.match(told.warned[0]!, /^What the service keeps of its last automatic backup could not be written: /);
        assert.equal(readFileSync(join(working, "theirs"), "utf8"), "theirs");
        assert.equal(existsSync(join(one.data, MEMORY_FILE)), false);
      }
      if (existsSync(join(one.directory, "pipe"))) assert.equal(lstatSync(join(one.directory, "pipe")).isFIFO(), true);
    });
  }

  /** What may stand in the backup folder under the names the service uses there, and what the backup fails with. */
  const IN_THE_FOLDER: Array<[what: string, plant: (one: Instance) => void, says: RegExp, needsPipes?: true, onlyThatMoment?: true]> = [
    ["a pipe as the folder itself", (one) => mkfifo(one.backups), /failed: .*backups is not a folder: it is a pipe\. Move it away, or name another folder for the backups\./, true],
    ["a pipe as the lock of the folder", (one) => (mkdirSync(one.backups), mkfifo(join(one.backups, BACKUPS_LOCK))), /failed: .*vigile-backups\.hold is not a lock file of Vigile\. Remove it while no vigile command and no service is running\./, true],
    ["a link to a pipe as the lock of the folder", (one) => (mkdirSync(one.backups), mkfifo(join(one.directory, "pipe")), symlinkSync(join(one.directory, "pipe"), join(one.backups, BACKUPS_LOCK))), /vigile-backups\.hold is not a lock file of Vigile\./, true],
    ["a folder as the lock of the folder", (one) => mkdirSync(join(one.backups, BACKUPS_LOCK), { recursive: true }), /vigile-backups\.hold is not a lock file of Vigile\./],
    ["a link to a file of someone's as the lock of the folder", (one) => (mkdirSync(one.backups), symlinkSync(join(one.directory, "sentinel"), join(one.backups, BACKUPS_LOCK))), /vigile-backups\.hold is not a lock file of Vigile\./],
    ["a pipe under the name of the backup", (one) => (mkdirSync(one.backups), mkfifo(join(one.backups, named(START)))), /-auto\.sqlite is in the way: /, true, true],
    ["a link to a file of someone's under the name of the backup", (one) => (mkdirSync(one.backups), symlinkSync(join(one.directory, "sentinel"), join(one.backups, named(START)))), /-auto\.sqlite is in the way: /, undefined, true],
    ["a pipe as the lock on the tenants' files, in the data folder", (one) => (rmSync(join(one.data, "vigile.files"), { force: true }), mkfifo(join(one.data, "vigile.files"))), /failed: .*vigile\.files is not a lock file of Vigile\./, true],
  ];
  for (const [what, plant, says, needsPipes, onlyThatMoment] of IN_THE_FOLDER) {
    it(`fails the backup with what it is, and does not hold the service up: ${what}`, async () => {
      if (needsPipes && !pipes) return;
      const one = await ran();
      const kept = sentinel(one);
      plant(one);
      /** What stands in the folder that is not a plain file or the folder's own lock, by its kind. */
      const planted = (): string[] => (!existsSync(one.backups) ? [] : lstatSync(one.backups).isDirectory() ? readdirSync(one.backups).filter((name) => !name.endsWith("-auto.set") && !lstatSync(join(one.backups, name)).isFile()).map((name) => `${name}: ${lstatSync(join(one.backups, name)).isFIFO() ? "pipe" : lstatSync(join(one.backups, name)).isSymbolicLink() ? "link" : "folder"}`) : ["the folder itself is none"]);
      const was = planted();
      const told = await inAProcess(one);
      assert.deepEqual([told.first, told.afterFirst.answers, told.afterSecond.answers], [200, 200, 200]);
      assert.match(told.warned[0]!, says);
      assert.equal(told.afterFirst.status.failure!.at, iso(START));
      if (onlyThatMoment) {
        // The name of that one moment is taken: ten minutes later the backup has another, and is taken.
        assert.deepEqual(told.warned.slice(1), [`Automatic backups work again: one was taken into ${one.backups}.`]);
        assert.deepEqual(one.automatic(), [named(START + 10 * MINUTE)]);
      } else {
        assert.equal(told.warned.length, 2, told.warned.join("\n"));
        assert.match(told.warned[1]!, says);
        assert.equal(told.afterSecond.status.failure!.at, iso(START + 10 * MINUTE));
        if (existsSync(one.backups) && lstatSync(one.backups).isDirectory()) assert.deepEqual(one.automatic(), [], "none was written");
      }
      // What stood there stands there, as what it was: not removed, not opened, not written through.
      assert.deepEqual(planted(), was);
      kept.untouched();
      if (existsSync(join(one.directory, "pipe"))) assert.equal(lstatSync(join(one.directory, "pipe")).isFIFO(), true);
      // A backup by hand into the same folder comes back as well. It takes no lock on the folder and has another
      // name: only what keeps every backup out keeps it out.
      const byHand = await new Promise<{ code: number; err: string }>((resolve) => {
        execFile(process.execPath, [BIN, "backup", one.backups, "--config", one.config], { env: { PATH: process.env.PATH ?? "" }, timeout: 20_000, killSignal: "SIGKILL" }, (error, _out, err) => resolve({ code: error ? ((error as { code?: number }).code ?? 99) : 0, err }));
      });
      if (/as the folder itself|in the data folder/.test(what)) {
        assert.equal(byHand.code, 1, `${what}: ${byHand.err}`);
        assert.match(byHand.err, /is not a folder: it is a pipe|is not a lock file of Vigile/);
      } else assert.equal(byHand.code, 0, `${what}: ${byHand.err}`);
      assert.deepEqual(planted(), was);
      kept.untouched();
    });
  }

  it("is refused as the backup to restore from without being opened: a pipe, a link to one, a folder", async () => {
    if (!pipes) return;
    const one = await ran();
    mkfifo(join(one.directory, "default-20261113-090000-000.sqlite"));
    symlinkSync(join(one.directory, "default-20261113-090000-000.sqlite"), join(one.directory, "default-20261113-090000-001.sqlite"));
    mkdirSync(join(one.directory, "default-20261113-090000-002.sqlite"));
    for (const [name, kind] of [["default-20261113-090000-000.sqlite", "pipe"], ["default-20261113-090000-001.sqlite", "pipe"], ["default-20261113-090000-002.sqlite", "folder"]] as const) {
      const refused = await new Promise<{ code: number; err: string }>((resolve) => {
        execFile(process.execPath, [BIN, "restore-backup", join(one.directory, name), "--config", one.config], { env: { PATH: process.env.PATH ?? "" }, timeout: 20_000, killSignal: "SIGKILL" }, (error, _out, err) => resolve({ code: error ? ((error as { code?: number }).code ?? 99) : 0, err }));
      });
      assert.equal(refused.code, 1, `${name}: ${refused.err}`);
      assert.match(refused.err, new RegExp(`is not a file: it is a ${kind}\\.`), name);
    }
    await one.start();
    assert.equal((await one.doctor()).failed, 0, "the data is as it was");
  });
});

describe("the backups in the folder, which are what there is", () => {
  it("are no more than is there: with one kept, the one before the last is removed, and a clock set back between the two finds no backup that counts", async () => {
    const one = await instance({ "backup.keep": "1" });
    await one.start();
    await one.pass(0);
    await one.pass(24 * HOUR);
    assert.deepEqual(one.automatic(), [named(START + 24 * HOUR)], "the first made room for the second");
    // Back to twelve hours after the first, which is not there: the one that is there is dated twelve hours ahead.
    one.clock.now = START + 12 * HOUR;
    const status = one.service.backups.status();
    // No backup that is not there is given as the last. One is due, and is begun ten minutes after the last one ended.
    assert.deepEqual([status.last_at, status.next_due], [null, iso(START + 12 * HOUR + 10 * MINUTE)]);
    assert.match((await one.doctor()).checks.find((check) => check.title === "last automatic backup worked")!.detail!, /^none taken yet; the first is due /);
    await one.pass(10 * MINUTE - 1);
    assert.deepEqual(one.automatic(), [named(START + 24 * HOUR)]);
    await one.pass(1);
    // With one kept, the one dated ahead makes room for it.
    const taken = START + 12 * HOUR + 10 * MINUTE;
    assert.deepEqual(one.automatic(), [named(taken)]);
    assert.deepEqual([one.service.backups.status().last_at, one.service.backups.status().next_due], [iso(taken), iso(taken + 24 * HOUR)]);
    assert.deepEqual(one.warnings, []);
  });

  it("cannot always be looked at: then the service goes by the one backup it took last itself, and says so, to the doctor as well", async () => {
    const one = await instance();
    await one.start();
    await one.pass(0);
    assert.deepEqual([one.service.backups.status().last_at, one.service.backups.status().unread], [iso(START), null]);
    // The folder is moved away and something that is no folder stands in its place.
    renameSync(one.backups, join(one.directory, "moved-away"));
    writeFileSync(one.backups, "no folder");
    await one.service.backups.ready();
    const status = one.service.backups.status();
    assert.equal(status.last_at, iso(START), "the one it took itself");
    assert.equal(status.next_due, iso(START + 24 * HOUR));
    assert.match(status.unread!, /backup folder .*backups was moved or replaced after this service took it\.$/);
    const check = (await one.doctor()).checks.find((found) => found.title === "last automatic backup worked")!;
    assert.equal(check.level, "warn");
    assert.match(check.detail!, new RegExp(`^taken ${iso(START).replace(".", "\\.")}; the next is due ${iso(START + 24 * HOUR).replace(".", "\\.")}\\. The service could not look at the backups there are \\(The backup folder .*backups was moved or replaced after this service took it\\): this goes by the last one it took itself\\.$`));
    assert.equal(check.fix, "Check that the backup folder is there and that the account the service runs as can read it.");
    // None is taken while that one is fresh, and none is given that was never there.
    await one.pass(HOUR);
    assert.deepEqual(one.warnings, []);
    // The folder is back: what is in it is what there is, and nothing more is said.
    rmSync(one.backups);
    renameSync(join(one.directory, "moved-away"), one.backups);
    await one.service.backups.ready();
    assert.deepEqual([one.service.backups.status().last_at, one.service.backups.status().unread], [iso(START), null]);
    assert.equal((await one.doctor()).checks.find((found) => found.title === "last automatic backup worked")!.level, "ok");
  });

  it("with a store that cannot say what there is: the schedule goes by the backup it took, says that it could not look, and by the store again once it can", async () => {
    const lines: string[] = [];
    const state = { clock: START, there: [] as number[], fails: false };
    const source: BackupSource = {
      moments: () => {
        if (state.fails) throw new Error("the folder cannot be read");
        return [...state.there];
      },
      take: (at) => (state.there.push(at), { done: Promise.resolve({ kind: "complete", copies: 1, bytes: 1, removed: 0 }), cancel: async () => {} }),
      close: async () => {},
    };
    const schedule = startBackups({ everyHours: 24, folder: "/b", keep: 1, source, now: () => state.clock, monotonic: () => state.clock, times: { ...BACKUP_TIMES, firstMs: 1_000_000_000, checkMs: 1_000_000_000 }, log: () => {}, warn: (line) => lines.push(line) });
    await schedule.check();
    assert.deepEqual([schedule.status().last_at, schedule.status().unread], [iso(START), null]);
    // The store cannot say: the one that was taken is what is known, and that is said.
    state.fails = true;
    state.clock += HOUR;
    assert.deepEqual([schedule.status().last_at, schedule.status().next_due, schedule.status().unread], [iso(START), iso(START + 24 * HOUR), "the folder cannot be read."]);
    await schedule.check();
    assert.deepEqual(state.there, [START]);
    // It can say again, and what it took is gone: none is given as the last, and one is taken.
    state.fails = false;
    state.there.length = 0;
    assert.deepEqual([schedule.status().last_at, schedule.status().unread], [null, null]);
    await schedule.check();
    assert.deepEqual(state.there, [START + HOUR]);
    // A store that could never say, in a run that has taken none: nothing is known, a backup is due, and it is said.
    const blind = startBackups({ everyHours: 24, folder: "/b", keep: 1, source: { ...source, moments: () => assert.fail("it cannot be looked at") }, now: () => state.clock, monotonic: () => state.clock, times: { ...BACKUP_TIMES, firstMs: 1_000_000_000, checkMs: 1_000_000_000 }, log: () => {}, warn: () => {} });
    assert.deepEqual([blind.status().last_at, blind.status().next_due, blind.status().unread], [null, iso(START + HOUR), "it cannot be looked at."]);
    assert.deepEqual(lines, []);
    await schedule.stop();
    await blind.stop();
  });
});

describe("what a service writes of its last backup, and reads again", () => {
  const KEPT: Remembered = { folder: "/b", at: START, ended: START + 5, kind: "complete_retention_failed", said: "It was taken.", actions: ["Remove them."] };

  it("is no longer than what is read again, whatever was said: shortened the same way each time, with how much was left out, and the rest as it was", () => {
    // A text within what is read is written as it is.
    assert.deepEqual(decodeRemembered(encodeRemembered(KEPT)!), KEPT);
    assert.equal(shortened("short", 100), "short");
    // A longer one: its beginning, and how many characters were left out.
    const long = "x".repeat(20_000);
    const cut = shortened(long, REMEMBERED_MOST.text);
    assert.equal(cut.length, REMEMBERED_MOST.text);
    assert.match(cut, /^x+… \(11833 more characters\)$/);
    assert.equal(cut.match(/^x+/)![0].length + 11833, 20_000);
    assert.equal(shortened(long, REMEMBERED_MOST.text), cut, "the same each time");
    // A character that is written as two is not cut in half.
    const pairs = "😀".repeat(5000);
    const cutPairs = shortened(pairs, 101);
    assert.equal(/[\ud800-\udbff](?![\udc00-\udfff])/.test(cutPairs), false, cutPairs.slice(-40));
    assert.ok(cutPairs.length <= 101);

    // The reviewer's case: older backups that could not be removed, under long paths.
    const paths = Array.from({ length: 3 }, (_, i) => `/${"deep/".repeat(790)}default-2026111${i}-090000-000-auto.sqlite: EACCES: permission denied, unlink`);
    const said = `The automatic backup was taken, but 3 older ones could not be removed: ${paths.join("; ")}. Remove them by hand.`;
    assert.ok(said.length > REMEMBERED_MOST.text);
    const text = encodeRemembered({ ...KEPT, said, actions: [said, ...paths] })!;
    const read = decodeRemembered(text)!;
    assert.notEqual(read, null, "what it writes, it reads again");
    assert.deepEqual([read.folder, read.at, read.ended, read.kind], ["/b", START, START + 5, "complete_retention_failed"]);
    assert.equal(read.said, shortened(said, REMEMBERED_MOST.text));
    assert.match(read.said!, /^The automatic backup was taken, but 3 older ones could not be removed: \/deep\/.*… \(\d+ more characters\)$/);
    assert.equal(read.actions.length, 4);
    assert.ok(Buffer.byteLength(text) <= REMEMBERED_MOST.bytes);
    // More to be done than is ever read: the first of them, and how many more.
    const many = decodeRemembered(encodeRemembered({ ...KEPT, actions: Array.from({ length: 40 }, (_, i) => `Do ${i}.`) })!)!;
    assert.deepEqual([many.actions.length, many.actions[14], many.actions[15]], [16, "Do 14.", "(25 more)"]);
    // Characters that take up much room when written: shortened further, until the whole is no more than is written.
    const wide = decodeRemembered(encodeRemembered({ ...KEPT, said: "\u0000".repeat(8000), actions: Array.from({ length: 16 }, () => "\u0001".repeat(8000)) })!)!;
    assert.ok(wide.said!.length < 8000 && wide.said!.startsWith("\u0000"));
    assert.equal(wide.kind, "complete_retention_failed");

    // What cannot be written in a form that is read again is not written: which backup it was has to be there.
    assert.equal(encodeRemembered({ ...KEPT, folder: "/".padEnd(5000, "x") }), null);
    assert.equal(encodeRemembered({ ...KEPT, folder: "" }), null);
    assert.equal(encodeRemembered({ ...KEPT, at: 1e20 }), null);
    assert.equal(encodeRemembered({ ...KEPT, ended: Number.NaN }), null);
    assert.equal(encodeRemembered({ ...KEPT, kind: "done" as Remembered["kind"] }), null);
  });

  it("reads whatever it writes: thousands of things said, long, wide and odd, made from a seed, each written and read again with the backup it is about unchanged", () => {
    let seed = 8192;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = <T>(from: readonly T[]): T => from[Math.floor(next() * from.length)]!;
    const PIECES = ["a", "é", "😀", "\ud800", "\udfff", "\u0000", "\u001b[2J", '"', "\\", "\n", "/very/long/path/", "界", "\u2028", " ", "x".repeat(997)];
    const text = (most: number): string => {
      let made = "";
      for (const length = Math.floor(next() ** 3 * most); made.length < length; ) made += pick(PIECES);
      return made;
    };
    const KINDS = ["begun", "incomplete", "complete", "complete_retention_failed", "complete_unconfirmed", "complete_unreported"] as const;
    let shortenedOnes = 0;
    let largest = 0;
    for (let i = 0; i < 3000; i++) {
      const remembered: Remembered = {
        folder: `/${text(3000)}` || "/b",
        at: Math.round((next() - 0.5) * 2 * 8.64e15),
        ended: Math.round((next() - 0.5) * 2 * 8.64e15),
        kind: pick(KINDS),
        said: next() < 0.1 ? null : text(60_000),
        actions: Array.from({ length: Math.floor(next() ** 2 * 40) }, () => text(30_000)),
      };
      const written = encodeRemembered(remembered);
      assert.notEqual(written, null, `value ${i}`);
      const bytes = Buffer.byteLength(written!, "utf8");
      largest = Math.max(largest, bytes);
      assert.ok(bytes <= REMEMBERED_MOST.bytes, `value ${i}: ${bytes} bytes`);
      const read = decodeRemembered(written!);
      assert.notEqual(read, null, `value ${i}: what was written is read again`);
      // The backup it is about is what it was: where to, when, how it ended.
      assert.deepEqual([read!.folder, read!.at, read!.ended, read!.kind], [remembered.folder, remembered.at, remembered.ended, remembered.kind], `value ${i}`);
      // What was said is what was said, or its beginning with how much was left out; never something else.
      if (remembered.said === null) assert.equal(read!.said, null);
      else if (read!.said !== remembered.said) {
        shortenedOnes++;
        const kept = /^([^]*)… \((\d+) more characters\)$/.exec(read!.said!);
        if (kept) {
          assert.equal(remembered.said.startsWith(kept[1]!), true, `value ${i}`);
          assert.equal(kept[1]!.length + Number(kept[2]), remembered.said.length, `value ${i}`);
        } else assert.equal(remembered.said.startsWith(read!.said!), true, `value ${i}`);
      }
      assert.ok(read!.actions.length <= REMEMBERED_MOST.actions);
      // Written again, what was read is written the same: nothing is shortened twice.
      assert.equal(encodeRemembered(read!), written, `value ${i}`);
      assert.equal(encodeRemembered(remembered), written, `value ${i}: the same each time`);
    }
    assert.ok(shortenedOnes > 300 && largest > REMEMBERED_MOST.bytes / 2, `${shortenedOnes} were shortened, the largest written was ${largest} bytes`);
  });

  it("is written by the service in that form: a backup with much said of it is known again after a restart, and one that cannot be kept at all is said once", async () => {
    const data = realpathSync(mkdtempSync(join(tmpdir(), "vigile-kept-")));
    try {
      const paths = Array.from({ length: 3 }, (_, i) => `/${"deep/".repeat(790)}default-2026111${i}-090000-000-auto.sqlite: EACCES: permission denied, unlink`);
      const warned: string[] = [];
      let clock = START;
      const there: number[] = [];
      const ends: BackupOutcome[] = [
        { kind: "complete_retention_failed", copies: 1, bytes: 1, removed: 0, notRemoved: paths },
        { kind: "incomplete", reason: `no room ${"at all ".repeat(20_000)}`, actions: Array.from({ length: 30 }, (_, i) => `Free some ${"room ".repeat(3000)}${i}.`) },
      ];
      for (const end of ends) {
        const source: BackupSource = { moments: () => [...there], take: (at) => (end.kind === "incomplete" || there.push(at), { done: Promise.resolve(end), cancel: async () => {} }), close: async () => {} };
        const run = (folder = "/b") => startBackups({ everyHours: 24, folder, keep: 1, source, memory: backupMemory(data), now: () => clock, monotonic: () => clock, times: { ...BACKUP_TIMES, firstMs: 1_000_000_000, checkMs: 1_000_000_000 }, log: () => {}, warn: (line) => warned.push(line) });
        warned.length = 0;
        clock += 2 * 24 * HOUR;
        const first = run();
        await first.check();
        // All of it is said in the log, however long.
        assert.equal(warned.length, 1);
        assert.ok(warned[0]!.length > 10_000, `${warned[0]!.length} characters`);
        const said = first.status().outcome!.said!;
        await first.stop();
        // What was written is what the service reads: no more than it reads, and sound.
        const file = join(data, MEMORY_FILE);
        assert.ok(statSync(file).size <= REMEMBERED_MOST.bytes);
        const kept = decodeRemembered(readFileSync(file, "utf8"))!;
        assert.notEqual(kept, null);
        assert.deepEqual([kept.kind, kept.at, kept.folder], [end.kind, clock, "/b"]);
        // Started again a minute later, the service knows its last backup: nothing is unreadable, and it waits.
        warned.length = 0;
        clock += MINUTE;
        const second = run();
        assert.deepEqual(warned, [], "its own file is not said to be unreadable");
        assert.deepEqual([second.status().outcome!.kind, second.status().outcome!.at], [end.kind, iso(clock - MINUTE)]);
        // What was said, or its beginning with how much was left out: as much of it as the whole had room for.
        const again = second.status().outcome!.said!;
        assert.equal([8192, 4096, 2048, 1024, 512].some((most) => again === shortened(said, most)), true, again.slice(-60));
        assert.match(again, /… \(\d+ more characters\)$/);
        if (end.kind === "incomplete") {
          assert.equal(second.status().failure!.reason, again);
          assert.equal(second.status().failure!.actions.length, REMEMBERED_MOST.actions);
          assert.equal(second.status().failure!.retry_at, iso(clock + 9 * MINUTE));
        }
        await second.stop();
      }
      // A folder whose path is longer than any path cannot be kept in a form that is read again: said once, and the backup is taken.
      warned.length = 0;
      clock += 2 * 24 * HOUR;
      const was = readFileSync(join(data, MEMORY_FILE), "utf8");
      const source: BackupSource = { moments: () => [], take: () => ({ done: Promise.resolve({ kind: "complete", copies: 1, bytes: 1, removed: 0 }), cancel: async () => {} }), close: async () => {} };
      const odd = startBackups({ everyHours: 24, folder: "/".padEnd(5000, "x"), keep: 1, source, memory: backupMemory(data), now: () => clock, monotonic: () => clock, times: { ...BACKUP_TIMES, firstMs: 1_000_000_000, checkMs: 1_000_000_000 }, log: () => {}, warn: (line) => warned.push(line) });
      await odd.check();
      assert.equal(odd.status().outcome!.kind, "complete");
      assert.equal(warned.length, 1, warned.join("\n").slice(0, 300));
      assert.match(warned[0]!, /^What the service keeps of its last automatic backup could not be written: .*vigile-backups\.json cannot hold it in the form the service reads again\. A service started again soon may try a backup sooner than it should\.$/);
      assert.equal(readFileSync(join(data, MEMORY_FILE), "utf8"), was, "what was there is as it was");
      assert.deepEqual(readdirSync(data), [MEMORY_FILE]);
      await odd.stop();
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });
});

describe("at the command line", () => {
  /** Starts `vigile serve` and answers with what it printed up to the end of its first lines. */
  async function served(config: string, ...options: string[]): Promise<string> {
    const child = spawn(process.execPath, [BIN, "serve", "--config", config, ...options], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
    let printed = "";
    child.stdout.on("data", (chunk: Buffer) => (printed += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (printed += chunk.toString()));
    try {
      for (const end = Date.now() + 15_000; Date.now() < end && !/connection|Auth is off/.test(printed); ) await new Promise((resolve) => setTimeout(resolve, 25));
      return printed;
    } finally {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      assert.equal(await exited, 0, "the service stops, with the timers of its backups waiting");
    }
  }

  it("serve says in its first lines whether backups are taken, how often, where, when the last was and when the next is due", async () => {
    const one = await instance();
    assert.match(await served(one.config), new RegExp(`Backups +every 24 hours into ${one.backups}; none taken yet, next due now\n`));
    assert.match(await served(one.config, "--backup.enabled", "false"), /Backups +off \(backup\.enabled is false\)\n/);
    assert.equal(existsSync(one.backups), false, "a service that ran for a moment took none");

    // With one taken half an hour ago, and the setting that the instances get.
    one.clock.now = Math.floor(Date.now() - 30 * MINUTE);
    await one.start();
    await one.pass(0);
    await one.service.stop();
    const taken = new Date(one.clock.now).toISOString();
    assert.match(await served(one.config, "--backup.every_hours", "4"), new RegExp(`Backups +every 4 hours into ${one.backups}; last ${taken}, next due ${new Date(one.clock.now + 4 * HOUR).toISOString()}\n`));
    assert.match(await served(one.config, "--backup.every_hours", "0.25"), new RegExp(`Backups +every 0.25 hours into ${one.backups}; last ${taken}, next due now\n`));
    assert.deepEqual(one.automatic(), [named(one.clock.now)]);
  });

  it("config show lists the settings, config set changes them for the next start, and the doctor says that a restart is needed", async () => {
    const one = await instance();
    await one.start();
    await one.pass(0);
    const shown = await run(["config", "show", "--config", one.config]);
    assert.match(shown.out, new RegExp(`Backups +${one.backups}\n`));
    for (const line of [/backup\.enabled +true +default/, /backup\.every_hours +24 +default/, /backup\.folder +"backups" +default/, /backup\.keep +30 +default/]) assert.match(shown.out, line);
    const asJson = JSON.parse((await run(["config", "show", "--json", "--config", one.config])).out);
    assert.equal(asJson.backup_folder, one.backups);
    assert.deepEqual(asJson.config.backup, { enabled: true, every_hours: 24, folder: "backups", keep: 30 });

    const set = await run(["config", "set", "backup.every_hours", "4", "--config", one.config]);
    assert.equal(set.code, 0, set.err);
    assert.match(set.out, /backup\.every_hours = 4\n.*Restart the service for this to take effect\./);
    assert.match((await run(["config", "show", "--config", one.config])).out, /backup\.every_hours +4 +file/);
    // The running service goes on as it was started, and the doctor says so.
    assert.equal(one.service.backups.status().every_hours, 24);
    const stale = (await one.doctor()).checks.find((check) => check.title === "running settings match the config")!;
    assert.deepEqual([stale.level, stale.detail], ["fail", "backup.every_hours: running with 24, config says 4"]);
    await one.pass(4 * HOUR);
    assert.deepEqual(one.automatic(), [named(START)]);
    // Started again, it goes by the new setting, from the backup that is there.
    await one.service.stop();
    await one.start();
    assert.equal(one.service.backups.status().next_due, new Date(START + 4 * HOUR).toISOString());
    await one.pass(0);
    assert.deepEqual(one.automatic(), [named(START), named(START + 4 * HOUR)]);
    assert.equal((await one.doctor()).checks.find((check) => check.title === "running settings match the config")!.level, "ok");

    // The data folder is refused as the folder of the backups, whichever of the two settings would make it so.
    const before = readFileSync(one.config, "utf8");
    for (const [key, value] of [["backup.folder", "data"], ["backup.folder", one.data], ["data_dir", "backups"]] as const) {
      const refused = await run(["config", "set", key, value, "--config", one.config]);
      assert.equal(refused.code, 1, `${key} ${value}`);
      assert.match(refused.err, /A backup cannot go into the data folder itself\./);
    }
    assert.equal(readFileSync(one.config, "utf8"), before);
    const off = await run(["config", "set", "backup.enabled", "false", "--json", "--config", one.config]);
    assert.deepEqual(JSON.parse(off.out), { "backup.enabled": false });
    assert.equal((await run(["config", "set", "data_dir", "backups", "--config", one.config])).code, 0, "with automatic backups off, the folder is like any other");
  });

  it("vigile backup works as before beside a service that takes its own into the same folder, and leaves no working file", async () => {
    const one = await instance();
    await one.start();
    await one.pass(0);
    const byHand = await run(["backup", one.backups, "--json", "--config", one.config]);
    assert.equal(byHand.code, 0, byHand.err);
    const { folder, files } = JSON.parse(byHand.out);
    assert.equal(folder, one.backups);
    assert.deepEqual(Object.keys(JSON.parse(byHand.out)), ["folder", "files"]);
    assert.match(files[0].file, /backups\/default-\d{8}-\d{6}-\d{3}\.sqlite$/);
    assert.equal(files[0].bytes, statSync(files[0].file).size);
    assert.equal(statSync(files[0].file).mode & 0o777, 0o600);
    assert.equal(inspectTenantFile("default", files[0].file).ok, true);
    assert.deepEqual(readdirSync(one.backups).filter((name) => name.includes(".partial")), []);
    // It is not one of the service's own: it is not counted, and never removed.
    assert.deepEqual(one.automatic(), [named(START)]);
    assert.equal(one.service.backups.status().last_at, new Date(START).toISOString());
  });
});
