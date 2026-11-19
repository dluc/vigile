// Types the commands of the site's pages into real terminals, as a reader would: each terminal a page names is
// a shell of its own that starts with nothing but what the page says it starts with, the blocks are typed in
// the order of the page, and a command that fails, or that cannot be typed because the terminal is taken by a
// service that is still running in it, is a broken page.
//
// Everything happens in a throwaway home folder. The command is where the pages say it is, ~/code/vigile/bin/vigile:
// a file of one line that runs the program the site describes (website/lib/program.mjs), whichever that is. A
// service never listens on the ports the pages name: where a page writes 8700, 8701 or 8710, the port given
// here is typed instead, and a page that starts from nothing gets its port from the environment variable the
// product has for that. Nothing else of what a page says is changed.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { replayPlan } from "./examples.mjs";
import { freePort, programPath, startService } from "./program.mjs";

/** The ports the pages name, in the order of the ports that are used in their place. */
const NAMED = ["8700", "8701", "8710"];
/** Ports nothing started here may ever listen on, whatever a page says. */
const NEVER = new Set([8700, 8701]);

/** Ports that are free at this moment, none of them one a page names. */
export async function freePorts(count) {
  const found = [];
  while (found.length < count) {
    const port = await freePort();
    if (!NEVER.has(port) && !NAMED.includes(String(port)) && !found.includes(port)) found.push(port);
  }
  return found;
}

/** A block as it is typed: with the ports the pages name replaced. Refuses to type one that still names a port of a real instance. */
export function typed(text, ports, keys = {}) {
  let out = text;
  NAMED.forEach((named, index) => (out = out.replace(new RegExp(`(?<![0-9])${named}(?![0-9])`, "g"), String(ports[index]))));
  for (const [stands, key] of Object.entries(keys)) out = out.replaceAll(stands, key);
  if (/(?<![0-9])870[01](?![0-9])/.test(out)) throw new Error(`A block of commands would use a port of a real instance:\n${out}`);
  return out;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until something answers as a service does at this port, or says that nothing did. */
async function answers(port, within = 15_000) {
  const end = Date.now() + within;
  while (Date.now() < end) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { redirect: "error", signal: AbortSignal.timeout(1000) });
      if (response.ok) return true;
    } catch {
      // Not yet.
    }
    await wait(60);
  }
  return false;
}

/** One terminal: a shell that takes what is typed into it, and says how each block ended. */
class Terminal {
  constructor(name, home, env) {
    this.name = name;
    this.output = "";
    this.blocks = 0;
    this.taken = null;
    // A group of its own, so that everything started in it can be stopped with it.
    this.child = spawn("bash", ["--noprofile", "--norc"], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.child.stdout.on("data", (chunk) => (this.output += chunk));
    this.child.stderr.on("data", (chunk) => (this.output += chunk));
    this.ended = new Promise((resolve) => this.child.once("exit", resolve));
    // What a command says on its error output comes through the same pipe as the rest, as a terminal shows it:
    // through a pipe of its own it could arrive after the mark that ends the block, and be missed.
    this.child.stdin.write("exec 2>&1\n");
    // A command that fails is remembered until the block is over: every line of a block has to work.
    this.child.stdin.write("trap '__failed=\"$__failed $BASH_COMMAND;\"' ERR\n");
  }

  /** Types a block and waits for it to end. Returns what it printed; throws when a command of it failed. */
  async type(text, { within = 30_000 } = {}) {
    if (this.taken) throw new Error(`The ${this.name} terminal is taken by a command that is still running in it, so nothing more can be typed there:\n${this.taken}`);
    const mark = `__vigile_docs_${++this.blocks}__`;
    const from = this.output.length;
    this.child.stdin.write(`__failed=\n${text}\nprintf '\\n${mark} [%s]\\n' "$__failed"\n`);
    const end = Date.now() + within;
    for (;;) {
      const found = new RegExp(`\\n${mark} \\[(.*)\\]\\n`).exec(this.output.slice(from));
      if (found) {
        const printed = this.output.slice(from, from + found.index);
        if (found[1].trim()) throw new Error(`In the ${this.name} terminal a command failed:${found[1]}\n\nThe block:\n${text}\n\nIt printed:\n${printed}`);
        return printed;
      }
      if (this.child.exitCode !== null) throw new Error(`The ${this.name} terminal ended in the middle of:\n${text}\n\nIt printed:\n${this.output.slice(from)}`);
      if (Date.now() > end) throw new Error(`In the ${this.name} terminal this block did not end within ${within / 1000} seconds:\n${text}\n\nIt printed:\n${this.output.slice(from)}`);
      await wait(25);
    }
  }

  /**
   * Types a block whose last command keeps running, and waits until it is under way: until it has printed
   * something, and, when what it printed is the addresses of a service, until that service answers.
   */
  async start(text, { within = 20_000 } = {}) {
    if (this.taken) throw new Error(`The ${this.name} terminal is taken by a command that is still running in it:\n${this.taken}`);
    const from = this.output.length;
    this.taken = text;
    this.child.stdin.write(`${text}\n`);
    const end = Date.now() + within;
    for (;;) {
      const printed = this.output.slice(from);
      const service = /Web\s+http:\/\/127\.0\.0\.1:(\d+)\//.exec(printed);
      if (service) {
        if (NEVER.has(Number(service[1]))) throw new Error(`A service was started on port ${service[1]}, which is a real instance's.`);
        if (!(await answers(Number(service[1])))) throw new Error(`The service that the ${this.name} terminal started does not answer:\n${printed}`);
        return printed;
      }
      // Anything else that keeps running: it is under way once it has said something and gone quiet for a moment.
      if (printed.trim() && !/vigile\s+serve/.test(text)) {
        await wait(300);
        return this.output.slice(from);
      }
      if (this.child.exitCode !== null) throw new Error(`The ${this.name} terminal ended instead of going on running:\n${text}\n\nIt printed:\n${printed}`);
      if (Date.now() > end) throw new Error(`In the ${this.name} terminal this was to keep running, and nothing came of it within ${within / 1000} seconds:\n${text}\n\nIt printed:\n${printed}`);
      await wait(25);
    }
  }

  /** Whether anything that was started in this terminal still runs: the shell, or a command it started. */
  running() {
    try {
      process.kill(-this.child.pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  }

  /**
   * Ends the terminal and everything started in it, and waits until all of it is gone: a service that was told
   * to stop takes a moment to do so after its shell has ended. Returns whether something would not go.
   */
  async close() {
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      try {
        process.kill(-this.child.pid, signal);
      } catch {
        // Gone already.
      }
      const end = Date.now() + 5000;
      while (this.running() && Date.now() < end) await wait(20);
      if (!this.running()) return false;
    }
    return true;
  }
}

/**
 * A throwaway place to type commands in: a home folder with the command at ~/code/vigile/bin/vigile, and
 * terminals that start with what `setting` says. With `running` or `running-demo`, an instance called main
 * runs at ~/vigile/main, started here through the program, and each terminal has vigile on its PATH and
 * VIGILE_CONFIG set; with `running-demo` the made-up plan was made in it, call by call.
 */
export async function place(setting, ports) {
  for (const port of ports) if (NEVER.has(port)) throw new Error(`Port ${port} is a real instance's and is not used.`);
  const home = mkdtempSync(join(tmpdir(), "vigile-docs-"));
  // The command where the pages have it: one line that hands everything on to the program.
  mkdirSync(join(home, "code", "vigile", "bin"), { recursive: true });
  writeFileSync(join(home, "code", "vigile", "bin", "vigile"), `#!/bin/sh\nexec '${programPath().replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
  const config = join(home, "vigile", "main", "config.toml");
  const env = { HOME: home, PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, LANG: "C.UTF-8", TERM: "dumb", NO_COLOR: "1" };
  const terminals = new Map();
  const keys = {};
  let service = null;
  if (setting === "fresh") {
    // The pages that start from nothing name no port, and the service would take its usual one. The product
    // lets a setting be given in the environment for one run: that is how the port is moved here.
    env.VIGILE_LISTEN_PORT = String(ports[0]);
  } else if (setting === "running" || setting === "running-demo") {
    try {
      service = await startService({ name: "main", config, home, port: ports[0] });
      if (setting === "running-demo") await replayPlan(service);
    } catch (error) {
      await service?.stop();
      rmSync(home, { recursive: true, force: true });
      throw error;
    }
    keys["vig_..."] = service.keys.get("admin");
    env.PATH = `${join(home, "code", "vigile", "bin")}:${env.PATH}`;
    env.VIGILE_CONFIG = config;
  } else throw new Error(`"${setting}" is nothing a page's terminals start with.`);

  const terminal = (name) => {
    if (!terminals.has(name)) terminals.set(name, new Terminal(name, home, env));
    return terminals.get(name);
  };
  return {
    home,
    /** The service that runs in this place, to speak to over its API, or null in a place that starts with nothing. */
    service,
    keys,
    /** Types one block of a page in the terminal it names. */
    async run(block) {
      const text = typed(block.text, ports);
      return block.stays ? terminal(block.terminal).start(text) : terminal(block.terminal).type(text);
    },
    /** Types text in a terminal of its own that is closed after it, and says how it ended. */
    async once(text, extraKeys = {}) {
      const child = spawn("bash", ["--noprofile", "--norc", "-c", typed(text, ports, extraKeys)], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      const code = await new Promise((resolve) => child.once("exit", resolve));
      return { code, out, err };
    },
    async close() {
      // Whatever a page started is gone with its terminal: each terminal is waited for until nothing of it runs.
      // That is asked of the processes themselves and not of the ports: a port that was given back can be
      // another test's by the time it is looked at.
      const left = [];
      for (const [name, one] of terminals) if (await one.close()) left.push(name);
      if (service) await service.stop();
      rmSync(home, { recursive: true, force: true });
      if (left.length) throw new Error(`Something that was started in the ${left.join(" and the ")} terminal still runs after the terminal was closed.`);
    },
  };
}
