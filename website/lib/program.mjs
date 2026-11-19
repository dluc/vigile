// The two doors to the product, and the only ones the web site goes through.
//
// The first is the description the program prints of itself: `vigile describe` writes one JSON document with
// the operations and their inputs, the commands, the settings, the errors, the statuses, the limits, the guide
// and what an agent is told over MCP. The reference pages are made from it.
//
// The second is the program itself, run as anyone would run it: `vigile config init`, `vigile serve`, and then
// the HTTP API of that service, on 127.0.0.1 and a free port, with its config and its data in a new temporary
// folder that is removed when the service is stopped.
//
// Nothing here, and nothing else in website/, imports a module of the product or reads a file of its source.
// Were the product written again in another language, the site would still be built and its tests would still
// run, as long as there is a `vigile` program that describes itself and serves.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the program is: the one setting. Unless told otherwise it is `bin/vigile` of the repository the site
 * lives in. The variable VIGILE_BIN names another, and so does `--vigile <path>` of website/build.mjs.
 */
let chosen = process.env.VIGILE_BIN ? resolve(process.env.VIGILE_BIN) : fileURLToPath(new URL("../../bin/vigile", import.meta.url));

/** The path of the program that is run. */
export const programPath = () => chosen;

/** Names another program, for everything that is run after this. */
export function useProgram(path) {
  chosen = resolve(path);
}

/** Ports nothing started here may ever listen on: the ones the pages name, which a real instance may have. */
const NEVER = new Set([8700, 8701, 8710]);

/** What the program is given of this machine: where node is, and a home folder of its own. Nothing of the caller's. */
function environment(home, extra = {}) {
  return { PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: home, LANG: "C.UTF-8", NO_COLOR: "1", ...extra };
}

/**
 * Runs the program once, with these words after its name, and waits for it to end. Answers with its exit
 * code and what it printed. `home` is the folder it takes for its home; `env` adds variables.
 */
export function run(args, { home = tmpdir(), env = {}, within = 30_000 } = {}) {
  return new Promise((done, failed) => {
    const child = spawn(chosen, args, { env: environment(home, env), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), within);
    child.once("error", (error) => {
      clearTimeout(timer);
      failed(new Error(`The program ${chosen} could not be run (${error.message}). Build it first ("pnpm build"), or name another with VIGILE_BIN or --vigile.`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) failed(new Error(`"vigile ${args.join(" ")}" did not end within ${within / 1000} seconds.`));
      else done({ code, out, err });
    });
  });
}

/** The descriptions that were read, by the program they are of: a program says the same of itself each time. */
const descriptions = new Map();

/** What the program says of itself: the document `vigile describe` prints. */
export function describeProgram() {
  if (!descriptions.has(chosen)) {
    descriptions.set(
      chosen,
      (async () => {
        const said = await run(["describe"]);
        if (said.code !== 0) throw new Error(`The site is made from what "vigile describe" prints, and ${chosen} ended with ${said.code}: ${(said.err || said.out).trim().slice(0, 400)}. Build the program first ("pnpm build"), or name another with VIGILE_BIN or --vigile.`);
        let description;
        try {
          description = JSON.parse(said.out);
        } catch (error) {
          throw new Error(`"vigile describe" of ${chosen} did not print JSON (${error.message}).`);
        }
        if (description.format !== 1) throw new Error(`"vigile describe" prints its format ${JSON.stringify(description.format)}, and the site reads format 1. Bring website/lib/facts.mjs to the new format.`);
        return description;
      })(),
    );
  }
  return descriptions.get(chosen);
}

/**
 * Where the ports are taken from. Several processes of the site run at a time, each test file as one and each
 * build as one, and each starts services. A port that is free now can be another process's a moment later, in
 * the time between the look and the start of the service. So each process looks in a stretch of ports of its
 * own, which goes by its number, and no two of them that were started together look in the same one.
 */
const FIRST = 10_240;
const STRETCH = 128;
const STRETCHES = 173;
/** The ports that were given out here, each with when: one is not given out again while its service may be starting. */
const given = new Map();
let turn = 0;

/** Whether nothing listens on this port of 127.0.0.1 at this moment. */
const isFree = (port) =>
  new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });

/** A port that is free at this moment, and none that a page names. */
export async function freePort() {
  const start = FIRST + (process.pid % STRETCHES) * STRETCH;
  for (let tries = 0; tries < STRETCH * 2; tries++) {
    const port = start + (turn++ % STRETCH);
    if (NEVER.has(port) || Date.now() - (given.get(port) ?? 0) < 10_000) continue;
    if (!(await isFree(port))) continue;
    given.set(port, Date.now());
    return port;
  }
  throw new Error(`No port between ${start} and ${start + STRETCH - 1} is free on 127.0.0.1.`);
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** Every service that runs, so that none outlives this process. */
const running = new Set();
process.once("exit", () => {
  for (const service of running) service.end();
});

/** What a service answers when it refuses: thrown by `call`, with the body of the refusal as `refusal`. */
export class Refused extends Error {
  constructor(operation, status, refusal) {
    super(`${operation} was refused: ${refusal?.message ?? `status ${status}`}`);
    this.name = "Refused";
    this.status = status;
    this.refusal = refusal ?? { code: "unknown", message: `The service answered ${status} without saying why.` };
  }
}

/** The name of an operation as the API and the command line have it: hyphens for underscores. */
export const hyphens = (name) => name.replaceAll("_", "-");

/**
 * One service, started through the program on a free port of 127.0.0.1, with a new instance in a temporary
 * folder of its own. It is spoken to over its HTTP API, as any client would.
 */
class Service {
  constructor(folder, config, port, adminKey, child) {
    /** The temporary folder that was made for this service and goes with it, or null when its instance is in a place of the caller's. */
    this.folder = folder;
    this.config = config;
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
    /** The API key of each user that has one here: the admin's from `config init`, the others as they are created. */
    this.keys = new Map([["admin", adminKey]]);
    this.child = child;
    /** When the service was started, and each call that was given a made-up moment: see website/lib/examples.mjs. */
    this.started = Date.now();
    this.moments = [];
    this.last = 0;
  }

  /**
   * Sends one call of an operation and answers with the status and the body, refused or not. `as` is the user
   * who calls: `agent1` is the one a call without a key acts as, anyone else is called with that user's key.
   * `at` is a made-up moment for the call: every date the service gives while it carries the call out is shown
   * as that moment (see `steady`).
   */
  async ask(operation, input = {}, as = "agent1", { at = null } = {}) {
    const headers = { "content-type": "application/json" };
    if (as !== "agent1") {
      if (!this.keys.has(as)) throw new Error(`The user ${as} has no API key in this service: it is called as agent1, without a key, as admin, or as a user that was created here.`);
      headers.authorization = `Bearer ${this.keys.get(as)}`;
    }
    // Two calls never fall into the same millisecond: a date the service gives belongs to one call only.
    while (at !== null && Date.now() <= this.last) await wait(1);
    const sent = Date.now();
    const response = await this.reach(`/api/${hyphens(operation)}`, { method: "POST", headers, body: JSON.stringify(input), redirect: "error" });
    const text = await response.text();
    this.last = Date.now();
    if (at !== null) this.moments.push({ from: sent, to: this.last, at });
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`The service answered ${operation} with what is not JSON (status ${response.status}): ${text.slice(0, 200)}`);
    }
    // A key that was made is kept, so that the user can be called as later.
    if (response.ok && typeof body?.api_key === "string" && typeof body.user?.username === "string") this.keys.set(body.user.username, body.api_key);
    return { ok: response.ok, status: response.status, body };
  }

  /** Sends one request to the service. One that does not get there says where it was going and why it did not arrive. */
  async reach(path, options) {
    try {
      return await fetch(`${this.url}${path}`, options);
    } catch (error) {
      const why = error.cause ? `${error.cause.code ?? ""} ${error.cause.message ?? ""}`.trim() : error.message;
      const state = this.child.exitCode !== null || this.child.signalCode !== null ? `the service has ended (${this.child.exitCode ?? this.child.signalCode})` : "the service is running";
      throw new Error(`The request to ${path} of the service on port ${this.port} did not arrive: ${why}; ${state}.`, { cause: error });
    }
  }

  /** Calls an operation and answers with what it answered. A call that is refused is thrown, as `Refused`. */
  async call(operation, input = {}, as = "agent1", options = {}) {
    const answer = await this.ask(operation, input, as, options);
    if (!answer.ok) throw new Refused(operation, answer.status, answer.body?.error);
    return answer.body;
  }

  /** Calls an operation that is to be refused, and answers with the refusal, or with null when it was not refused. */
  async refusal(operation, input = {}, as = "agent1", options = {}) {
    const answer = await this.ask(operation, input, as, options);
    return answer.ok ? null : (answer.body?.error ?? { code: "unknown", message: `status ${answer.status}` });
  }

  /**
   * Announces a call with a body of so many bytes, and answers with what the service says to that: the status
   * and the error. None of the body is sent. A service that takes no body of that size says so when it has
   * read how large the body is to be, and one that would take it says nothing, which is an error here. Sending
   * such a body whole would race with the service, which ends the connection once it has refused.
   */
  announce(operation, bytes) {
    return new Promise((done, failed) => {
      const sent = request({ host: "127.0.0.1", port: this.port, path: `/api/${hyphens(operation)}`, method: "POST", headers: { "content-type": "application/json", "content-length": bytes } }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => {
          sent.destroy();
          try {
            done({ status: response.statusCode, error: JSON.parse(text).error ?? null });
          } catch {
            failed(new Error(`The service answered a body of ${bytes} bytes that was announced with what is not JSON (status ${response.statusCode}): ${text.slice(0, 200)}`));
          }
        });
      });
      sent.setTimeout(10_000, () => sent.destroy(new Error(`The service said nothing to a body of ${bytes} bytes that was announced and not sent: it waits for it.`)));
      sent.on("error", failed);
      sent.flushHeaders();
    });
  }

  /**
   * The number of the plan as it is stored now, which goes up with every change that is stored: the stream of
   * changes says it to whoever connects.
   */
  async revision() {
    const control = new AbortController();
    const response = await this.reach("/api/events", { signal: control.signal, redirect: "error" });
    const reader = response.body.getReader();
    let text = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString("utf8");
        const hello = /event: hello\ndata: (\{.*\})\n/.exec(text);
        if (hello) return JSON.parse(hello[1]).revision;
      }
    } finally {
      control.abort();
    }
    throw new Error("The stream of changes ended before it said hello.");
  }

  /**
   * A value the service answered with, as it is shown: every date the service made during a call that was
   * given a made-up moment becomes that moment, so that what is shown is the same on every build. A date that
   * is older than the service was sent to it, and stays as it is.
   */
  steady(value, startedAt = "2026-03-02T08:00:00.000Z") {
    return JSON.parse(
      JSON.stringify(value).replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z\b/g, (date) => {
        const moment = Date.parse(date);
        if (moment < this.started) return date;
        const call = this.moments.find((one) => moment >= one.from && moment <= one.to);
        if (call) return new Date(call.at).toISOString();
        // What the service wrote when it started, before any call: the built-in users.
        if (!this.moments.length || moment < this.moments[0].from) return startedAt;
        throw new Error(`The service gave the date ${date}, which is of no call that was given a moment: what is shown would not be the same on every build.`);
      }),
    );
  }

  /** Ends the process at once, without waiting: for when this process ends. */
  end() {
    running.delete(this);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    if (this.folder) rmSync(this.folder, { recursive: true, force: true });
  }

  /** Stops the service, waits until it is gone, and removes its folder. */
  async stop() {
    if (!running.has(this)) return;
    running.delete(this);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const gone = new Promise((done) => this.child.once("exit", done));
      this.child.kill("SIGTERM");
      const timer = setTimeout(() => this.child.kill("SIGKILL"), 5000);
      await gone;
      clearTimeout(timer);
    }
    if (this.folder) rmSync(this.folder, { recursive: true, force: true });
  }
}

/**
 * Starts a service on a new instance: `vigile config init`, then `vigile serve`, and waits until it answers.
 * `settings` are settings for this run, as in { "auth.keyless_user": "" }. The caller stops it with `stop()`.
 *
 * Unless told otherwise the instance is in a temporary folder of its own, on a free port, and the folder is
 * removed when the service is stopped. With `config`, `home` and `port` the instance is made at that config
 * file, in a place the caller made and removes: the terminals of website/lib/terminals.mjs do so. With
 * `adminKey` as well, the instance is one that is there already, and is started as it is.
 */
export async function startService({ name = "site", settings = {}, config: at = null, home = null, port: wanted = null, adminKey: known = null } = {}) {
  let failure = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const folder = at ? null : mkdtempSync(join(tmpdir(), "vigile-site-service-"));
    const config = at ?? join(folder, "instance", "config.toml");
    const port = wanted ?? (await freePort());
    if (NEVER.has(Number(port))) throw new Error(`Port ${port} is one the pages name, which a real instance may have: nothing is started on it.`);
    try {
      let adminKey = known;
      if (adminKey === null) {
        const made = await run(["config", "init", "--config", config, "--name", name, "--port", String(port), "--json"], { home: home ?? folder });
        if (made.code !== 0) throw new Error(`"vigile config init" ended with ${made.code}: ${(made.err || made.out).trim().slice(0, 400)}`);
        adminKey = JSON.parse(made.out).admin_key;
        if (typeof adminKey !== "string") throw new Error('"vigile config init --json" did not print the admin key.');
      }
      // A service in a folder of its own takes no backups: the folder is gone a moment later.
      const options = Object.entries({ ...(folder ? { "backup.enabled": "false" } : {}), ...settings }).flatMap(([key, value]) => [`--${key}`, String(value)]);
      const child = spawn(chosen, ["serve", "--config", config, ...options], { env: environment(home ?? folder), stdio: ["ignore", "pipe", "pipe"] });
      let printed = "";
      child.stdout.on("data", (chunk) => (printed = `${printed}${chunk}`.slice(-4000)));
      child.stderr.on("data", (chunk) => (printed = `${printed}${chunk}`.slice(-4000)));
      // Neither the process nor what it prints keeps this process from ending: `stop` is what ends a service,
      // and one that was forgotten is ended when this process ends.
      child.unref();
      child.stdout.unref?.();
      child.stderr.unref?.();
      const service = new Service(folder, config, port, adminKey, child);
      running.add(service);
      const until = Date.now() + 20_000;
      for (;;) {
        if (child.exitCode !== null || child.signalCode !== null) {
          service.end();
          // Another process took the port between the look for a free one and the start: try another.
          if (/already in use/.test(printed) && !at) throw Object.assign(new Error(printed.trim()), { again: true });
          throw new Error(`"vigile serve" ended instead of serving: ${printed.trim().slice(0, 600)}`);
        }
        try {
          const health = await fetch(`${service.url}/health`, { redirect: "error", signal: AbortSignal.timeout(1000) });
          // What answers at the port is this service only when it knows this instance's admin key: another
          // process may have taken the port a moment before, with a service of the same name.
          if (health.ok && (await health.json()).name === name && (await service.ask("list_users", {}, "admin")).ok) return service;
        } catch {
          // Not yet.
        }
        if (Date.now() > until) {
          service.end();
          throw new Error(`"vigile serve" did not answer within 20 seconds: ${printed.trim().slice(0, 600)}`);
        }
        await wait(15);
      }
    } catch (error) {
      if (folder) rmSync(folder, { recursive: true, force: true });
      failure = error;
      if (!error.again) throw error;
    }
  }
  throw failure;
}
