import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { isIP } from "node:net";
import { join } from "node:path";
import { LiveAuth, masked, staleKeys, type LoadedConfig } from "@vigile/config";
import { Engine, VERSION, VigileError, type OperationLog } from "@vigile/core";
import { createApiHandler, sendError } from "@vigile/http-api";
import { createMcpHandler } from "@vigile/mcp";
import { SqliteStorage, everHeld, holdFolder } from "@vigile/storage-sqlite";
import { serveWeb } from "@vigile/web";
import { recoverAtStart } from "./restore.js";
import { codeStamp } from "./stamp.js";

/** Says which process has the data folder. See `takeLock`. */
export const LOCK_FILE = "vigile.lock";

export interface Service {
  engine: Engine;
  storage: SqliteStorage;
  server: Server;
  /** The addresses people and agents use to reach the service. */
  urls: { base: string; mcp: string; web: string };
  /** Whether the address it is bound to is this machine talking to itself, however the config writes it. */
  loopbackOnly: boolean;
  stop(): Promise<void>;
}

export interface ServiceOptions {
  loaded: LoadedConfig;
  log(line: string): void;
  warn(line: string): void;
  /** Other limits than the usual ones, for tests that cannot wait half a minute. */
  limits?: Partial<typeof LIMITS>;
}

/**
 * What one client may hold of the service. Without them a client could open connections without end, or send
 * requests and never finish them: each unfinished request keeps what it has sent so far in memory.
 */
export const LIMITS = {
  /** How long a request may take to arrive in full, headers and body. The answer may take longer: a stream of changes stays open. */
  requestMs: 30_000,
  /** How long the headers alone may take. */
  headersMs: 15_000,
  /** How often connections are looked at for having taken too long. */
  checkMs: 5_000,
  /** How many connections may be open at once. Further ones are refused until some close. */
  connections: 1024,
};

/**
 * A second service on the same data folder would hold its own copy of the graph, so only one may run. The
 * folder is held through a lock that the system keeps for the life of the process. The lock file beside it
 * only says which process that is, for people and for the doctor: after a crash it may name a process that is
 * gone, or a number that something else has since been given, and that keeps nobody out.
 */
/**
 * The process of a service from before the data folder was held by a lock of the system, if one may be running.
 * Such a service wrote its number into `vigile.lock` and nothing else, so the lock of the system does not know
 * of it: taking that lock would let a second service, or a restore, work on data that is in use. This is asked
 * only in a folder that has never been held the new way, which is the one moment an earlier service can be
 * there; afterwards a number in that file keeps nobody out, whatever process has it by then.
 */
export function earlierService(dataDir: string): number | null {
  if (everHeld(dataDir)) return null;
  let pid: number;
  try {
    pid = Number(readFileSync(join(dataDir, LOCK_FILE), "utf8").trim());
  } catch {
    return null;
  }
  if (!(pid > 0) || pid === process.pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? pid : null;
  }
}

/** What to say when a service from before may be running in the folder. */
export const earlierServiceRuns = (dataDir: string, pid: number): StartupError =>
  new StartupError(`A Vigile service from before this version may be using ${dataDir} (process ${pid}).`, [
    "Stop that service first.",
    `If no such service is running, the file ${join(dataDir, LOCK_FILE)} was left behind by one that was killed: remove it.`,
  ]);

function takeLock(dataDir: string): () => void {
  const file = join(dataDir, LOCK_FILE);
  const earlier = earlierService(dataDir);
  if (earlier) throw earlierServiceRuns(dataDir, earlier);
  let release: (() => void) | null;
  try {
    release = holdFolder(dataDir);
  } catch (error) {
    throw new StartupError(`The data folder ${dataDir} cannot be taken for this service: ${(error as Error).message}.`, ["Give this account read and write access to the folder and to what is in it."]);
  }
  if (!release) {
    // A service says which process it is in the lock file, and nothing else writes there. With a live process
    // named, it is a service that has the folder. With none, it may be a service that has not written it yet,
    // a restore of a backup, or a command that writes the config while no service runs: not called a service.
    let pid = 0;
    try {
      pid = Number(readFileSync(file, "utf8").trim());
    } catch {
      // Nobody has written it.
    }
    let alive = false;
    try {
      alive = pid > 0 && (process.kill(pid, 0), true);
    } catch (error) {
      alive = (error as NodeJS.ErrnoException).code === "EPERM";
    }
    if (alive) throw new StartupError(`Another Vigile service (process ${pid}) is already using ${dataDir}.`, ["Stop that service first, or point this one at a different data_dir."]);
    throw new StartupError(`Another Vigile process is using ${dataDir}: a service that is starting, a restore of a backup, or a command that is writing the config while no service runs.`, [
      "A command is done in a moment: start the service again.",
      "If it stays so, a service or a restore has the folder: stop it or let it finish first, or point this service at a different data_dir.",
    ]);
  }
  const held = release;
  try {
    writeFileSync(file, `${process.pid}\n`);
  } catch (error) {
    held();
    throw new StartupError(`${file} cannot be written: ${(error as Error).message}.`, ["Give this account read and write access to the data folder."]);
  }
  return () => {
    try {
      if (Number(readFileSync(file, "utf8").trim()) === process.pid) rmSync(file);
    } catch {
      // Already gone.
    }
    held();
  };
}

export class StartupError extends Error {
  constructor(
    message: string,
    readonly hints: string[] = [],
  ) {
    super(message);
    this.name = "StartupError";
  }
}

function unauthorized(reason: "invalid_key" | "key_required"): VigileError {
  return reason === "invalid_key"
    ? new VigileError("unauthorized", "The API key is not valid.", {
        actions: ["Check the key in the Authorization header. An admin can issue a new one with reset_user_key."],
      })
    : new VigileError("unauthorized", "This service needs an API key.", {
        actions: ['Send it as "Authorization: Bearer <key>". An admin creates users and keys with create_user.'],
      });
}

/** An error as the log says it: what it is and where it was thrown. Never what the caller sent. */
const explain = (error: unknown): string => (error instanceof Error ? (error.stack ?? error.message) : String(error));

function formatLog(entry: OperationLog): string {
  const parts = [
    new Date().toISOString(),
    `op=${entry.operation}`,
    `caller=${entry.caller}`,
    `kind=${entry.kind}`,
    `ms=${entry.duration_ms}`,
    `result=${entry.result}`,
  ];
  if (entry.rule) parts.push(`rule=${entry.rule}`);
  return parts.join(" ");
}

const hostFor = (address: string): string => (isIP(address) === 6 ? `[${address}]` : address);

/**
 * Whether an address is this machine talking to itself, however it is written: in capitals, in brackets, with
 * a dot at the end, the long way round (0:0:0:0:0:0:0:1), or as an IPv4 address inside an IPv6 one
 * (::ffff:127.0.0.1). An address that is taken for another kind here would leave the checks that go with
 * listening on this machine only switched off.
 */
export function isLoopback(address: string): boolean {
  // An IPv6 address may name the interface it belongs to after a percent sign (fe80::1%eth0). That says where
  // the address lives, not what it is, and is left out.
  const name = address.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "").replace(/%.*$/, "");
  if (name === "localhost") return true;
  if (isIP(name) === 4) return name.startsWith("127.");
  if (isIP(name) !== 6) return false;
  // Written the one way an IPv6 address has when it is written out in full and shortened by the rules.
  let written: string;
  try {
    written = new URL(`http://[${name}]`).hostname.slice(1, -1);
  } catch {
    return false;
  }
  return written === "::1" || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(written);
}

/**
 * Whether a request names the service by a name that is not this machine's own, while the service listens on
 * this machine only. Nothing but a browser that was told a foreign name points here sends such a request: a
 * site can point a name of its own at 127.0.0.1, and its page then counts as the service's own page. A service
 * that listens on another address is reached by whatever names its owner gives it, and accepts them all.
 */
export function namedFromOutside(request: Pick<IncomingMessage, "headers">, loopbackOnly: boolean, configured: string): string | null {
  const host = request.headers.host;
  if (!loopbackOnly || !host) return null;
  const plain = (name: string) => name.toLowerCase().replace(/\.$/, "");
  let name: string;
  try {
    // As a name is written in full it may end in a dot: "localhost." is localhost.
    name = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return host;
  }
  // The name the config gives the service is its own as well: a name of this machine's that leads to it, which
  // is how the service prints its address and how the command line reaches it.
  return isLoopback(name) || plain(name) === plain(configured) ? null : name;
}

/**
 * Whether a browser sent the request on behalf of a page that the service did not serve. Such a page must not
 * act through the browser of someone who can reach the service: without a key it would act as the keyless user.
 * Programs that are not browsers send neither header, and the service's own page names the service as its origin.
 */
function fromAnotherSite(request: IncomingMessage): boolean {
  // Browsers of today say themselves where the page that asks is from, in a header a page cannot set or change.
  // That is taken at its word, also behind a proxy that puts the service's own address in place of the name the
  // browser used, where comparing the two names below would refuse the service's own page.
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined) return site !== "same-origin" && site !== "none";
  const origin = request.headers.origin;
  if (origin === undefined) return false;
  try {
    return new URL(origin).host.toLowerCase() !== request.headers.host?.toLowerCase();
  } catch {
    // "null", which is what a page opened from a file or held in a sandbox sends.
    return true;
  }
}

/** Builds the whole service from a checked config and starts listening. */
export async function startService(options: ServiceOptions): Promise<Service> {
  const { loaded } = options;
  // What is said to the log is said if it can be. A log that cannot be written, a full disk or a reader that
  // went away, is the log's trouble: it stops neither the start, nor a request, nor the answer to one, and
  // never the service.
  const told =
    (sink: (line: string) => void) =>
    (line: string): void => {
      try {
        sink(line);
      } catch {
        // Not said.
      }
    };
  const log = told(options.log);
  const warn = told(options.warn);
  const { config, dataDir } = loaded;
  const started = Date.now();
  const startedCode = codeStamp();

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const releaseLock = takeLock(dataDir);
  // A restore that was killed half-way may have left a tenant without its file. Opened like that, the tenant
  // would be begun anew, empty. The folder is this service's now, so it is put in order first.
  try {
    const recovered = recoverAtStart(dataDir);
    if (recovered) warn(recovered);
  } catch (error) {
    releaseLock();
    throw new StartupError((error as Error).message);
  }
  const storage = new SqliteStorage({ directory: dataDir });
  // What this run was started with, in the environment or as an option, holds for the whole run: the file is read
  // again when it changes, and must not undo it.
  const fixed = loaded.sources["auth.keyless_user"] === "environment" || loaded.sources["auth.keyless_user"] === "option" ? { keyless_user: config.auth.keyless_user } : {};
  const auth = new LiveAuth(loaded.path, config.auth, warn, fixed);

  let engine: Engine;
  try {
    engine = await Engine.open({
      storage,
      keys: auth,
      onOperation: (entry) => {
        // What went wrong inside the service is said whatever the log level: the caller is told only that it did.
        if (entry.cause !== undefined) warn(`${entry.operation} failed unexpectedly: ${explain(entry.cause)}`);
        if (config.log_level === "quiet") return;
        if (config.log_level === "info" && entry.kind === "read" && entry.result === "ok") return;
        log(formatLog(entry));
      },
    });
    const users = (await engine.execute("list_users", "admin", {})) as { users: Array<{ username: string }> };
    const usernames = users.users.map((u) => u.username);
    // A key for a user that does not exist lets nobody in: said, and no reason not to start. A keyless user that
    // does not exist would have every connection without a key refused, which is a mistake in the config.
    for (const username of staleKeys(config, usernames)) {
      warn(`auth.keys.${username}: there is no user called ${username}; the key lets nobody in. Remove the line from the config file.`);
    }
    // A key counts only for the user it was issued for. One that is under a user's name and is not that user's
    // own is refused: data restored from a backup taken before the key was issued, or a key put in by hand.
    for (const username of notTheirOwn(config.auth.keys)) {
      warn(`auth.keys.${username}: this key was not issued for the user ${username} as the data has it, and lets nobody in. Issue a new one: vigile user reset-key ${username}`);
    }
    if (config.auth.keyless_user && !usernames.includes(config.auth.keyless_user)) {
      throw new StartupError("The config names a user that does not exist.", [
        `auth.keyless_user: there is no user called ${config.auth.keyless_user}`,
        'Set it to a user that exists, or to nothing: vigile config set auth.keyless_user ""',
      ]);
    }
  } catch (error) {
    await storage.close();
    releaseLock();
    throw error;
  }

  /** The users that exist and whose key in the config is not their own: such a key is refused. */
  function notTheirOwn(keys: Record<string, string>): string[] {
    return Object.entries(keys)
      .filter(([username, key]) => engine.user(username) && !engine.keyIsTheirs(username, key))
      .map(([username]) => username)
      .sort();
  }

  const caller = (request: IncomingMessage) => {
    const identity = auth.identify(request.headers.authorization);
    if (!identity.ok) throw unauthorized(identity.reason);
    const user = engine.user(identity.username);
    if (!user) {
      throw new VigileError(
        "unauthorized",
        identity.keyless ? `A connection without a key acts as "${identity.username}" here, but there is no such user.` : `The key belongs to "${identity.username}", but there is no such user.`,
        { actions: [identity.keyless ? 'Send an API key as "Authorization: Bearer <key>", or ask an admin to set auth.keyless_user to a user that exists.' : "Ask an admin to run the doctor on the service."] },
      );
    }
    // A key under a user's name counts only when it was made for that user. A name can pass to someone else,
    // and a key left behind under it does not pass with it.
    const presented = request.headers.authorization?.replace(/^Bearer\s+/i, "").trim();
    if (!identity.keyless && presented && !engine.keyIsTheirs(identity.username, presented)) throw unauthorized("invalid_key");
    // Which user it is goes with the name: what the request then does, it does as this user, and not as whoever
    // has the name by the time it has sent all it has to say.
    return { username: identity.username, id: user.id, keyless: identity.keyless };
  };

  const instance = () => ({ name: config.name, version: VERSION });
  const api = createApiHandler({
    engine,
    caller,
    instance,
    onUnexpected: (error) => warn(`A request to the API failed unexpectedly: ${explain(error)}`),
    adminStatus: () => ({
      pid: process.pid,
      uptime_s: Math.round((Date.now() - started) / 1000),
      code_stamp: startedCode,
      config_path: loaded.path,
      data_dir: dataDir,
      settings: masked(config),
      auth: { keyless_user: auth.current().keyless_user, users_with_keys: Object.keys(auth.current().keys).sort(), keys_of_someone_else: notTheirOwn(auth.current().keys) },
      listen: { loopback_only: loopbackOnly },
    }),
  });
  const mcp = createMcpHandler({ engine, caller, onUnexpected: (error) => warn(`A request to /mcp failed unexpectedly: ${explain(error)}`) });

  const base = `http://${hostFor(config.listen.address)}:${config.listen.port}`;
  const limits = { ...LIMITS, ...options.limits };
  // Set once the service listens, from the address it is then bound to. The config may write a loopback address
  // in a way that does not look like one (127.1, a name of the machine's own): the address bound is what counts.
  let loopbackOnly = isLoopback(config.listen.address);
  const server = createServer({ requestTimeout: limits.requestMs, headersTimeout: Math.min(limits.headersMs, limits.requestMs), connectionsCheckingInterval: limits.checkMs }, (request, response) => {
    // Whatever is answered is what its type says it is, whichever part of the service answers.
    response.setHeader("x-content-type-options", "nosniff");
    // Everything a request can set off happens in here, so that nothing it throws ends the service.
    const handled = (async () => {
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://vigile.invalid");
      } catch {
        return void sendError(response, new VigileError("invalid_input", "The address of the request is not valid."));
      }
      const guarded = url.pathname === "/mcp" || url.pathname.startsWith("/api/");
      const outside = guarded ? namedFromOutside(request, loopbackOnly, config.listen.address) : null;
      if (outside !== null) {
        return void sendError(
          response,
          new VigileError("forbidden", `This service listens on this machine only, and the request calls it "${outside.slice(0, 80)}".`, {
            actions: [`Reach it as ${base}.`],
          }),
        );
      }
      if (guarded && fromAnotherSite(request)) {
        return void sendError(
          response,
          new VigileError("forbidden", "This request comes from a page of another site, which may not use the service.", {
            actions: ["Open the page at the service's own address, or call the service from a program."],
          }),
        );
      }
      if (url.pathname === "/mcp") return mcp(request, response);
      if (url.pathname === "/health" || guarded) return api(request, response, url);
      if ((request.method === "GET" || request.method === "HEAD") && serveWeb(response, url.pathname, request.method === "HEAD", (error) => warn(`The page's file ${url.pathname} could not be read: ${explain(error)}`))) return;
      sendError(response, new VigileError("not_found", `Nothing is served at ${url.pathname}.`));
    })();
    handled.catch((error: unknown) => {
      warn(`${request.method} ${request.url} failed unexpectedly: ${explain(error)}`);
      // Nothing may leave this place: there is nobody left to catch it, and it would end the service.
      try {
        if (!response.headersSent) sendError(response, new Error("unexpected"));
        else response.end();
      } catch {
        response.destroy();
      }
    });
  });

  server.maxConnections = limits.connections;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.listen.port, config.listen.address, () => {
        server.off("error", reject);
        const bound = server.address();
        if (bound && typeof bound === "object") loopbackOnly = isLoopback(bound.address);
        resolve();
      });
    });
  } catch (error) {
    await storage.close();
    releaseLock();
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      throw new StartupError(`Port ${config.listen.port} on ${config.listen.address} is already in use.`, [
        "Stop whatever is using it, or choose another: vigile config set listen.port <port>",
      ]);
    }
    if (code === "EADDRNOTAVAIL") {
      throw new StartupError(`This machine has no address ${config.listen.address}.`, ["Check listen.address in the config."]);
    }
    throw error;
  }

  let stopping: Promise<void> | null = null;
  return {
    engine,
    storage,
    server,
    urls: { base, mcp: `${base}/mcp`, web: `${base}/` },
    loopbackOnly,
    stop: () =>
      (stopping ??= (async () => {
        // A page that listens for changes holds its connection open for as long as it likes: end those first.
        api.close();
        await new Promise<void>((resolve) => {
          // A connection that has not sent a request yet, such as the ones a browser opens in advance, is not
          // idle, and would keep the service from stopping for minutes. Requests in flight get a second to finish.
          const rest = setTimeout(() => server.closeAllConnections(), 1000);
          server.close(() => {
            clearTimeout(rest);
            resolve();
          });
          server.closeIdleConnections();
        });
        // Waits for the write in flight before the store is closed.
        await engine.close();
        releaseLock();
      })()),
  };
}
