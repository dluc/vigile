import { accessSync, constants, existsSync, readFileSync, statfsSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConfigError, checkUsers, isTooOpen, loadConfig, masked, unknownEnvironment, type LoadedConfig } from "@vigile/config";
import { OPERATIONS, VERSION } from "@vigile/core";
import { folderIsHeld, inspectTenantFile, tenantFiles } from "@vigile/storage-sqlite";
import { UsageError, configPath, flag, type Args } from "../args.js";
import { areTexts, isCount, isRecord, keyRefused, oneLine, refusalOf, usersOf } from "../answers.js";
import { ANSWER_WITHIN_MS, NoAnswerError, NotRunningError, baseUrl, clientFor, type ServiceClient } from "../client.js";
import { realPath } from "../paths.js";
import { whoAnswers } from "../reach.js";
import { redirectOf } from "../redirect.js";
import { restoreInterrupted } from "../restore.js";
import { LOCK_FILE, isLoopback } from "../service.js";
import { codeStamp } from "../stamp.js";
import { bold, dim, mark, pad, plural, type Level, type Ui, SYMBOL } from "../ui.js";
import { builtin, given } from "./builtin.js";

interface Check {
  section: "Config" | "Data" | "Service";
  level: Level;
  title: string;
  detail?: string;
  fix?: string;
}

/** What answered a question of the doctor's is not what a Vigile service answers. Says which part of it is not. */
class NotVigile extends Error {}

/** Text that the service sent, as one line of a report: nothing in it steers the terminal, and it has an end. */
const said = (text: string): string => oneLine(text, 200);

/**
 * A request of a check that follows no redirect. One that comes back is a failure that says so: what answers
 * where it points is not the service, and is not asked.
 */
const unredirected: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: "manual" });
  const onward = redirectOf(response);
  if (!onward) return response;
  void response.body?.cancel().catch(() => {});
  throw new Error(`${init?.method ?? "GET"} ${typeof input === "string" ? input : input instanceof URL ? input.href : input.url} was answered with ${onward}`);
};

/** What the doctor reads of the service's status. */
interface Status {
  pid: number;
  uptime_s: number;
  config_path: string;
  data_dir: string;
  /** Absent from a service that does not say: taken as code from before the last change. */
  code_stamp: number | undefined;
  settings: Record<string, unknown> | undefined;
  inconsistencies: string[];
  counts: { project: number; task: number; user: number };
  links: number;
  /** Absent from a service from before it said which keys are in effect: the config's are taken. */
  auth: { keyless_user: string; users_with_keys: string[]; keys_of_someone_else: string[] } | undefined;
  /** Absent from a service from before it said what it is bound to. */
  loopback_only: boolean | undefined;
}

/**
 * The service's status, each field the doctor uses looked at before it is used. A field that an earlier service
 * did not send may be absent, and is then what it always was taken for. One that is there and is of another
 * kind than a Vigile service sends is named: the doctor reads no further in such an answer.
 */
function readStatus(answer: unknown): Status {
  const absent = (value: unknown): value is undefined | null => value === undefined || value === null;
  const wrong = (field: string, should: string): never => {
    throw new NotVigile(`"${field}" is not ${should}`);
  };
  if (!isRecord(answer)) throw new NotVigile("the answer is not an object");
  const number = (from: Record<string, unknown>, field: string, name = field): number => (isCount(from[field]) ? (from[field] as number) : wrong(name, "a number"));
  const text = (from: Record<string, unknown>, field: string, name = field): string => (typeof from[field] === "string" ? (from[field] as string) : wrong(name, "a text"));
  const part = (from: Record<string, unknown>, field: string, name = field): Record<string, unknown> | undefined => (absent(from[field]) ? undefined : isRecord(from[field]) ? (from[field] as Record<string, unknown>) : wrong(name, "an object"));
  const texts = (from: Record<string, unknown>, field: string, name = field): string[] => (areTexts(from[field]) ? (from[field] as string[]) : wrong(name, "a list of texts"));

  const engine = part(answer, "engine");
  const counts = engine ? part(engine, "counts", "engine.counts") : undefined;
  const count = (kind: string): number => (!counts || absent(counts[kind]) ? 0 : number(counts, kind, `engine.counts.${kind}`));
  const auth = part(answer, "auth");
  const listen = part(answer, "listen");
  return {
    pid: number(answer, "pid"),
    uptime_s: number(answer, "uptime_s"),
    config_path: text(answer, "config_path"),
    data_dir: text(answer, "data_dir"),
    code_stamp: absent(answer.code_stamp) ? undefined : number(answer, "code_stamp"),
    settings: part(answer, "settings"),
    inconsistencies: absent(answer.inconsistencies) ? [] : texts(answer, "inconsistencies"),
    counts: { project: count("project"), task: count("task"), user: count("user") },
    links: !engine || absent(engine.links) ? 0 : number(engine, "links", "engine.links"),
    auth: auth && {
      keyless_user: text(auth, "keyless_user", "auth.keyless_user"),
      users_with_keys: texts(auth, "users_with_keys", "auth.users_with_keys"),
      keys_of_someone_else: absent(auth.keys_of_someone_else) ? [] : texts(auth, "keys_of_someone_else", "auth.keys_of_someone_else"),
    },
    loopback_only: !listen || absent(listen.loopback_only) ? undefined : typeof listen.loopback_only === "boolean" ? listen.loopback_only : wrong("listen.loopback_only", "yes or no"),
  };
}

function localAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((entry) => entry.address));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** How many differences are listed. The rest are counted. */
const DIFFERENCES_SHOWN = 5;

function sameSettings(a: unknown, b: unknown): string[] {
  const differences: string[] = [];
  // A value as it is written in the config, or that it is there when it cannot be written out.
  const word = (value: unknown): string => {
    try {
      return JSON.stringify(value) ?? "nothing";
    } catch {
      return "something that cannot be shown";
    }
  };
  // Only what a side has of its own: every object answers to names such as "constructor" with something.
  const at = (side: object, key: string): unknown => (Object.hasOwn(side, key) ? (side as Record<string, unknown>)[key] : undefined);
  const walk = (left: unknown, right: unknown, path: string) => {
    if (path === "auth") return; // Auth is re-read live, so it never needs a restart.
    if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) walk(at(left, key), at(right, key), path ? `${path}.${key}` : key);
    } else if (left !== right) differences.push(said(`${path}: running with ${word(left)}, config says ${word(right)}`));
  };
  walk(a, b, "");
  return differences.length > DIFFERENCES_SHOWN ? [...differences.slice(0, DIFFERENCES_SHOWN), `and ${differences.length - DIFFERENCES_SHOWN} more`] : differences;
}

/**
 * Checks the config and the running service, and changes nothing. Each check is a pass, a warning or a failure;
 * a failure says how to fix it. How long the service is given to answer is a parameter for the tests.
 */
export async function doctor(args: Args, ui: Ui, answerWithinMs = ANSWER_WITHIN_MS): Promise<number> {
  const json = flag(args, "json");
  const path = resolve(configPath(args));
  given(builtin("doctor"), args);
  const checks: Check[] = [];
  let section = "";
  const add = (check: Check) => {
    checks.push(check);
    if (json) return;
    if (check.section !== section) {
      section = check.section;
      ui.out();
      ui.out(`  ${bold(ui, section)}`);
    }
    ui.out(`  ${mark(ui, check.level)} ${pad(check.title, 36)}  ${dim(ui, check.detail ?? "")}`.trimEnd());
    if (check.fix && check.level !== "ok") ui.out(`    ${dim(ui, SYMBOL.fix)} ${check.fix}`);
  };
  if (!json) {
    ui.out();
    ui.out(`  ${bold(ui, "vigile doctor")}`);
  }

  // Config
  let loaded: LoadedConfig | null = null;
  try {
    loaded = loadConfig(path);
    add({ section: "Config", level: "ok", title: "config file passes the check", detail: path });
  } catch (error) {
    const issues = error instanceof ConfigError ? error.issues : [(error as Error).message];
    add({ section: "Config", level: "fail", title: "config file passes the check", detail: path, fix: issues.join("; ") });
  }
  if (existsSync(path)) {
    const open = isTooOpen(path);
    add({
      section: "Config",
      level: open ? "fail" : "ok",
      title: "config file is private",
      detail: open ? "other accounts can read the API keys in it" : "readable by its owner only",
      fix: `chmod 600 ${path}`,
    });
  }
  const strays = unknownEnvironment();
  add({
    section: "Config",
    level: strays.length ? "warn" : "ok",
    title: "environment overrides are known",
    detail: strays.length ? `not settings: ${strays.join(", ")}` : "no stray VIGILE_ variables",
    fix: "Check those names for typos; they are ignored.",
  });

  if (loaded) {
    const { config, dataDir } = loaded;
    const address = config.listen.address;
    const wildcard = address === "0.0.0.0" || address === "::";
    const mine = wildcard || address === "localhost" || localAddresses().includes(address);
    add({
      section: "Config",
      level: isIP(address) === 0 && !mine ? "warn" : mine ? "ok" : "fail",
      title: "listen address is on this machine",
      detail: isIP(address) === 0 && !mine ? `${address} is a name; it could not be checked` : address,
      fix: `This machine has: ${localAddresses().join(", ")}. Set one with: vigile config set listen.address <address>`,
    });

    // Data
    let writable = false;
    if (!existsSync(dataDir)) {
      add({ section: "Data", level: "warn", title: "data folder exists", detail: `${dataDir} is created on first start` });
    } else {
      try {
        accessSync(dataDir, constants.R_OK | constants.W_OK);
        writable = true;
      } catch {
        // Reported below.
      }
      add({ section: "Data", level: writable ? "ok" : "fail", title: "data folder is writable", detail: dataDir, fix: "Give this account read and write access to the folder." });
      try {
        const stats = statfsSync(dataDir);
        const freeMb = Math.floor((Number(stats.bavail) * Number(stats.bsize)) / (1024 * 1024));
        add({
          section: "Data",
          level: freeMb < 100 ? "warn" : "ok",
          title: "disk has free space",
          detail: freeMb >= 1024 ? `${(freeMb / 1024).toFixed(1)} GB free` : `${freeMb} MB free`,
          fix: "Free some space; writes fail when the disk is full.",
        });
      } catch {
        // Not every filesystem reports free space.
      }
      if (restoreInterrupted(dataDir)) {
        add({ section: "Data", level: "fail", title: "no restore is left half-done", detail: "a restore-backup was interrupted", fix: "Start the service, or run restore-backup again: either puts the data in order first, or says what to do by hand if the restore's own note cannot be read." });
      }
      const files = tenantFiles(dataDir);
      if (!files.length) add({ section: "Data", level: "warn", title: "store has data", detail: "no tenant yet; one is created on first start" });
      for (const { tenant, file } of files) {
        let canWrite = true;
        try {
          accessSync(file, constants.R_OK | constants.W_OK);
        } catch {
          canWrite = false;
        }
        add({ section: "Data", level: canWrite ? "ok" : "fail", title: `store "${tenant}" can be written`, detail: file, fix: "Give this account read and write access to the file. Until then every change fails." });
        const report = inspectTenantFile(tenant, file);
        add({
          section: "Data",
          level: report.ok ? "ok" : "fail",
          title: `store "${tenant}" is intact`,
          detail: report.ok ? `format ${report.format}, revision ${report.revision}` : report.messages.join("; "),
          fix: "Stop the service and restore a backup: vigile restore-backup <backup file>",
        });
      }
    }

    // Service
    const base = baseUrl(loaded);
    const lockFile = join(dataDir, LOCK_FILE);
    const lockPid = existsSync(lockFile) ? Number(readFileSync(lockFile, "utf8").trim()) : 0;
    // Whether some process has the data folder is asked of the system. The number in the lock file alone would
    // not do: after a crash it can be the number of a process that has nothing to do with Vigile.
    let held = false;
    try {
      held = existsSync(dataDir) && folderIsHeld(dataDir);
    } catch (error) {
      add({ section: "Data", level: "fail", title: "data folder can be held by one service", detail: (error as Error).message, fix: "Give this account read and write access to the data folder and to vigile.hold in it." });
    }
    // Who answers is asked without a key, and the admin key goes out only to the service of this config.
    const answer = await whoAnswers(loaded, answerWithinMs);
    if (!answer.ok) {
      // Something that takes the connection and says nothing is there, which is not the same as nothing. With
      // nothing holding the data folder on this machine, it is another program.
      const silent = answer.why === "silent";
      const itself = silent && answer.error instanceof NoAnswerError;
      add({
        section: "Service",
        level: "fail",
        title: "service is running",
        detail: answer.why === "other" ? answer.error.message : silent ? `${base} takes the connection and does not answer` : `nothing answers at ${base}`,
        fix:
          answer.why === "other"
            ? answer.error.hints.join(" ")
            : held
              ? lockPid && pidAlive(lockPid)
                ? `A Vigile service (process ${lockPid}) holds the data folder but does not answer at ${base}; stop it, then start it again.`
                : `A process holds the data folder and names no service: a service that is starting, a restore of a backup, or a command that is writing the config. Run the doctor again in a moment; if it stays so, stop that process, then start the service.`
              : itself
                ? "It is reached and does not answer: look at its log on the machine it runs on. If it stays like this, stop it there, then start it again."
                : silent
                  ? "No service holds the data folder, so what has the port is another program. Stop it, or choose another port: vigile config set listen.port <port>"
                  : `Start it: vigile serve --config ${path}`,
      });
    }

    if (answer.ok) {
      const health = { name: said(answer.name), version: said(answer.version).slice(0, 40) };
      let status: Status | null = null;
      let client: ServiceClient | null = null;
      try {
        client = clientFor(loaded, "admin", answerWithinMs);
        status = readStatus(await client.get("/api/admin/status"));
        add({ section: "Service", level: "ok", title: "service is running", detail: `${health.name} ${health.version}, up ${duration(status.uptime_s)}, process ${status.pid}` });
        add({ section: "Service", level: "ok", title: "admin key works" });
      } catch (error) {
        const { reason, actions } = refusalOf(error);
        if (error instanceof NoAnswerError || error instanceof NotRunningError) {
          // A service that answered a moment ago and does not now has not refused the key: a new key would not help.
          add({ section: "Service", level: "ok", title: "service is running", detail: `${health.name} ${health.version} at ${base}` });
          add({ section: "Service", level: "fail", title: "service keeps answering", detail: reason, fix: "Look at the service's log. If it stays like this, stop the service, then start it again." });
        } else if (error instanceof UsageError || keyRefused(error)) {
          // The config has no admin key, or the service answered that it refuses the one it was sent: 401, in
          // its own words. Nothing else is taken for that: the service answers 403 before it looks at a key.
          add({ section: "Service", level: "ok", title: "service is running", detail: `${health.name} ${health.version} at ${base}` });
          add({ section: "Service", level: "fail", title: "admin key works", detail: reason, fix: "Issue a new one: vigile user reset-key admin" });
        } else {
          // What says who it is as the service does, and then not how it is, is not vouched for. Why not is said
          // as it was answered, with what the answer says can be done, and nothing further is asked.
          add({
            section: "Service",
            level: "fail",
            title: "service is running",
            detail: `${health.name} ${health.version} answers at ${base}, and did not give its status: ${error instanceof NotVigile ? `it answered GET /api/admin/status, but not as a Vigile service does: ${reason}` : reason}`,
            fix: actions.length ? actions.join(" ") : "The service and this command line may be different versions: stop the service and start it again. If it stays so, check the service log.",
          });
        }
      }

      if (status && client) {
        // The same config and the same data, by whatever names each side reaches them.
        const samePlace = realPath(status.config_path) === realPath(path) && realPath(status.data_dir) === realPath(dataDir);
        add({
          section: "Service",
          level: samePlace ? "ok" : "fail",
          title: "port belongs to this instance",
          detail: samePlace ? `${base}` : `the service at ${base} uses ${said(status.config_path)}`,
          fix: "Two instances are set to the same address and port. Give each its own listen.port.",
        });
        if (samePlace) {
          const holds = held && lockPid === status.pid;
          add({
            section: "Service",
            level: holds ? "ok" : "fail",
            title: "service holds the data folder",
            detail: holds ? `process ${status.pid}` : held ? `the lock file names process ${lockPid || "none"}, the service is process ${status.pid}` : "nothing holds it: a second service could start on the same data",
            fix: "Restart the service.",
          });
        }
        const onDisk = codeStamp();
        const stale = status.code_stamp === undefined || status.code_stamp < onDisk;
        add({
          section: "Service",
          level: stale ? "fail" : "ok",
          title: "service runs the code on disk",
          detail: stale ? "the code or the page changed after the service started; parts of it may not work" : "started after the last change",
          fix: "Restart the service.",
        });
        const differences = status.settings ? sameSettings(status.settings, masked(config)) : ["the service does not say what settings it runs with"];
        add({
          section: "Service",
          level: differences.length ? "fail" : "ok",
          title: "running settings match the config",
          detail: differences.length ? differences.join("; ") : "no restart needed",
          fix: "Restart the service to apply the change.",
        });
        const broken = status.inconsistencies;
        add({
          section: "Service",
          level: broken.length ? "fail" : "ok",
          title: "graph is consistent",
          detail: broken.length ? broken.slice(0, 3).map(said).join("; ") : `${plural(status.counts.project, "project")}, ${plural(status.counts.task, "task")}, ${plural(status.counts.user, "user")}, ${plural(status.links, "link")}`,
          fix: "The stored graph is damaged. Restore from a backup, or repair the listed items.",
        });

        const liveAuth = status.auth ?? { keyless_user: config.auth.keyless_user, users_with_keys: Object.keys(config.auth.keys), keys_of_someone_else: [] };
        // The questions that follow are each a check of their own: an answer that cannot be used fails its check,
        // with what answered wrongly, and the doctor goes on to the next.
        try {
          const names = usersOf(base, await client.call("list_users")).map((u) => u.username);
          const unknown = checkUsers({ ...config, auth: { keyless_user: liveAuth.keyless_user, keys: Object.fromEntries(liveAuth.users_with_keys.map((n) => [n, "x"])) } }, names);
          add({
            section: "Service",
            // A keyless user that does not exist keeps everyone without a key out. A key for nobody is only clutter.
            level: !unknown.length ? "ok" : unknown.some((issue) => issue.startsWith("auth.keyless_user")) ? "fail" : "warn",
            title: "config users exist",
            detail: unknown.length ? unknown.map(said).join("; ") : `${plural(liveAuth.users_with_keys.length, "user")} with a key`,
            fix: "Remove the stale entries from [auth.keys] in the config file, or create the users.",
          });
        } catch (error) {
          const { reason, actions } = refusalOf(error);
          add({ section: "Service", level: "fail", title: "config users exist", detail: `the users could not be asked for: ${reason}`, fix: actions.length ? actions.join(" ") : "Check the service log." });
        }
        // A key counts only for the user it was issued for: after data was restored from a backup that is older
        // than a key, or a key was put into the file by hand, the key under a user's name is not that user's.
        const others = liveAuth.keys_of_someone_else;
        if (others.length) {
          add({
            section: "Service",
            level: "warn",
            title: "each key is its user's own",
            detail: `the key in the config for ${others.map(said).join(", ")} was not issued for the user as the data has it, and is refused`,
            fix: `Issue a new one: vigile user reset-key ${said(others[0]!)}`,
          });
        }

        // The doctor is the client here, and says its own version: nothing an answer said is sent on.
        const mcp = new Client({ name: "vigile-doctor", version: VERSION });
        try {
          await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { fetch: unredirected, requestInit: { headers: { authorization: `Bearer ${config.auth.keys.admin}` }, redirect: "manual" } }), { timeout: answerWithinMs });
          const listed: unknown = await mcp.listTools(undefined, { timeout: answerWithinMs });
          const tools = isRecord(listed) && Array.isArray(listed.tools) ? listed.tools.length : -1;
          add({
            section: "Service",
            level: tools === OPERATIONS.length ? "ok" : "fail",
            title: "MCP endpoint answers",
            detail: tools < 0 ? `${base}/mcp did not answer with a list of tools` : `${base}/mcp lists ${plural(tools, "tool")}${tools === OPERATIONS.length ? "" : `, expected ${OPERATIONS.length}`}`,
            fix: "The service and this CLI are different versions; restart the service.",
          });
        } catch (error) {
          add({ section: "Service", level: "fail", title: "MCP endpoint answers", detail: refusalOf(error).reason, fix: "Check the service log." });
        } finally {
          await mcp.close().catch(() => {});
        }

        // Only whether the page is there is asked: what comes after the first line of the answer is not waited
        // for. A redirect is not followed: the page of whatever it points to is not this service's page.
        const page = await fetch(`${base}/`, { redirect: "manual", signal: AbortSignal.timeout(answerWithinMs) }).then(
          (response) => {
            void response.body?.cancel().catch(() => {});
            return { status: response.status, onward: redirectOf(response) };
          },
          () => ({ status: 0, onward: null }),
        );
        add({
          section: "Service",
          level: page.status === 200 ? "ok" : "fail",
          title: "web page answers",
          detail: page.status === 200 ? `${base}/` : page.onward ? `${base}/ answers with ${page.onward}` : page.status ? `status ${page.status}` : "no answer",
          fix: "Check the service log.",
        });

        if (liveAuth.keyless_user) {
          // What the service says of the address it is bound to, which is what counts; an older service does not say.
          const open = !(status.loopback_only ?? isLoopback(address));
          add({
            section: "Service",
            level: "warn",
            title: "auth is off for non-admin users",
            detail: `no key needed to act as ${said(liveAuth.keyless_user)}${open ? "; listening beyond this machine" : ""}`,
            fix: 'To require a key from everyone: vigile config set auth.keyless_user ""',
          });
        } else {
          add({ section: "Service", level: "ok", title: "every connection needs a key" });
        }
      }
    }
  }

  const count = (level: Level) => checks.filter((c) => c.level === level).length;
  if (json) {
    ui.out(JSON.stringify({ ok: count("fail") === 0, passed: count("ok"), warnings: count("warn"), failed: count("fail"), checks }, null, 2));
  } else {
    ui.out();
    const parts = [
      ui.paint("green", `${count("ok")} passed`),
      count("warn") ? ui.paint("yellow", plural(count("warn"), "warning")) : null,
      count("fail") ? ui.paint("red", `${count("fail")} failed`) : null,
    ].filter(Boolean);
    ui.out(`  ${parts.join(` ${dim(ui, SYMBOL.dot)} `)}`);
    ui.out();
  }
  return count("fail") === 0 ? 0 : 1;
}

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}
