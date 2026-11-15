import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initConfig, loadConfig, setValue } from "@vigile/config";
import { Engine, OPERATIONS, LIMITS as SIZES, PROJECT_STATUSES, TASK_STATUSES, TASK_TYPES, paging, readAll } from "@vigile/core";
import { MemoryStorage, type Snapshot, type StorageAdapter } from "@vigile/storage";
import { backupTenantFile, everHeld, folderIsHeld, holdFile, holdFolder, holdTenantFiles } from "@vigile/storage-sqlite";
import { FLAGS, UsageError, configPath, nothingElse, parseArgs, take } from "./args.js";
import { adversary, type Case, type Target } from "./adversary.js";
import { allUsers } from "./answers.js";
import { NoAnswerError, NotRunningError, ServiceClient } from "./client.js";
import { BUILTINS, calledAs } from "./commands/builtin.js";
import { config as configCommand } from "./commands/config.js";
import { doctor } from "./commands/doctor.js";
import { user } from "./commands/user.js";
import { optionsOf } from "./commands/operation.js";
import { EXPECTED, judge } from "./expected.js";
import { NotReachedError, inTheServicesPlace, onThisMachine, whoAnswers } from "./reach.js";
import { isPrinted, printable, renderError, renderResult } from "./render.js";
import { forgetRestore, noteRestore, openAsPlan, putBackOrder, putInPlace, recoverRestore, restoreInterrupted } from "./restore.js";
import { LIMITS, startService, type Service } from "./service.js";
import type { Ui } from "./ui.js";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer, type Socket } from "node:net";

const BIN = fileURLToPath(new URL("./bin.js", import.meta.url));

/** Runs the command to its end. A command that should end and does not is stopped after a while, and fails the test. */
function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, timeout: 30_000 }, (error, out, err) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out, err });
    });
  });
}

/**
 * A token of each list operation as a service makes it, asked without filters, from a plan that has more than
 * a page of everything; and one of a list of an item. What a token is made of is the service's own: a test that
 * needs one of a certain list takes a real one.
 */
let tokensOfLists: Promise<{ users: string; tasks: string; nextTasks: string; projects: string; ofItem: string }> | undefined;
function realTokens(): NonNullable<typeof tokensOfLists> {
  return (tokensOfLists ??= (async () => {
    const engine = await Engine.open({ storage: new MemoryStorage() });
    const admin = (name: string, input: Record<string, unknown> = {}): Promise<any> => engine.execute(name, "admin", input);
    const group = (await admin("create_task", { title: "Group", description: "d" })).id as string;
    for (let n = 0; n <= SIZES.page; n++) {
      await admin("create_user", { username: `u${n}`, type: "agent" });
      await admin("create_task", { title: `T${n}`, description: "d", parent: group });
      await admin("create_project", { title: `P${n}`, prefix: `Q${String.fromCharCode(65 + Math.floor(n / 26))}${String.fromCharCode(65 + (n % 26))}` });
    }
    const tokens = {
      users: (await admin("list_users")).continuation as string,
      tasks: (await admin("list_tasks")).continuation as string,
      nextTasks: (await admin("list_next_tasks")).continuation as string,
      projects: (await admin("list_projects")).continuation as string,
      ofItem: (await admin("get", { id: group })).more.links.contains.continuation as string,
    };
    assert.ok(Object.values(tokens).every((token) => typeof token === "string" && token !== ""));
    return tokens;
  })());
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

/** Something that listens where a service is expected, answers as it is told to, and keeps what it was sent. */
async function stranger(port: number, answer: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ seen: Array<{ asked: string; authorization: string | undefined; body: string }>; close(): Promise<void> }> {
  const seen: Array<{ asked: string; authorization: string | undefined; body: string }> = [];
  const server = createHttpServer((request, response) => {
    const entry = { asked: `${request.method} ${request.url}`, authorization: request.headers.authorization, body: "" };
    seen.push(entry);
    request.on("data", (part: Buffer) => (entry.body += part.toString()));
    answer(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    seen,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      // A test that asked it something itself has a moment to see that its connection is gone, before it asks
      // the next listener on the same port.
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  };
}

describe("arguments", () => {
  it("reads options with values, flags, and plain words", () => {
    const args = parseArgs(["set-task-status", "ABC-042", "--version", "3", "--status=done", "--json", "--priority", "-1"]);
    assert.deepEqual(args.words, ["set-task-status", "ABC-042"]);
    assert.deepEqual([...args.options], [
      ["version", "3"],
      ["status", "done"],
      ["json", true],
      ["priority", "-1"],
    ]);
  });

  it("does not let a flag swallow the word after it", () => {
    const args = parseArgs(["list-tasks", "--has-problems", "--draft", "next"]);
    assert.deepEqual(args.words, ["list-tasks", "next"]);
    assert.equal(args.options.get("has-problems"), true);
  });

  it("lets a yes/no option say which, and refuses the same option twice", () => {
    const args = parseArgs(["create-task", "--draft", "false", "--title", "T", "--has-problems", "true", "--json"]);
    assert.deepEqual(args.words, ["create-task"]);
    assert.deepEqual([...args.options], [
      ["draft", "false"],
      ["title", "T"],
      ["has-problems", "true"],
      ["json", true],
    ]);
    assert.throws(() => parseArgs(["get", "--id", "A", "--id", "B"]), /--id is given twice/);
    assert.throws(() => parseArgs(["get", "--id=A", "--id", "B"]), /--id is given twice/);
    // Written once with hyphens and once with underscores, it is the same option twice.
    assert.throws(() => parseArgs(["create-task", "--assigned-to", "alice", "--assigned_to", "bob"]), /--assigned-to and --assigned_to are the same option, given twice/);
    assert.throws(() => parseArgs(["list-tasks", "--top_level", "--top-level=false"]), /--top_level and --top-level are the same option, given twice/);
    assert.deepEqual([...parseArgs(["list-tasks", "--top_level", "false", "--has-problems"]).options], [["top_level", "false"], ["has-problems", true]], "a yes/no option is one however it is written");
  });

  it("refuses an option that was given without its value, and whatever a command does not know", () => {
    // `--as $WHO` with nothing in the variable: the option stands alone, and must not count as not given.
    assert.throws(() => take(parseArgs(["get", "X", "--as"]), "as"), /--as needs a value/);
    assert.throws(() => take(parseArgs(["get", "X", "--as", "--json"]), "as"), /--as needs a value/);
    assert.throws(() => configPath(parseArgs(["doctor", "--config"]), { VIGILE_CONFIG: "other.toml" }), /--config needs a value/);
    assert.equal(take(parseArgs(["serve", "--auth.keyless_user", ""]), "auth.keyless_user"), "", "an empty value that was written out is a value");
    assert.equal(take(parseArgs(["create-task", "--title=--force is documented"]), "title"), "--force is documented");
    assert.equal(take(parseArgs(["get"]), "as"), undefined);
    assert.throws(() => nothingElse(parseArgs(["--prot", "9999"])), /There is no option --prot here/);
    assert.throws(() => nothingElse(parseArgs(["b", "c"])), /Unexpected "b"/);
    assert.doesNotThrow(() => nothingElse(parseArgs([])));
  });

  it("needs a config file: an option, or the environment variable, and nothing else", () => {
    assert.equal(configPath(parseArgs(["--config", "a.toml"]), {}), "a.toml");
    assert.equal(configPath(parseArgs([]), { VIGILE_CONFIG: "b.toml" }), "b.toml");
    assert.throws(() => configPath(parseArgs([]), {}), UsageError);
  });
});

describe("what is printed", () => {
  it("shows that a character that steers the terminal was there, and does not send it", () => {
    const lines: string[] = [];
    const ui = { fancy: false, paint: (_style: unknown, text: string) => text, out: (line = "") => void lines.push(line), err: (line = "") => void lines.push(line) } as Ui;
    const title = "ok\u001b[2K\r  \u2713 WEB-999  All clear \u001b]0;pwned\u0007\u001b[8m";
    renderResult(ui, "list_tasks", { tasks: [{ id: "WEB-001", title, status: "open", type: "task", priority: 0, value: null, size: null, is_next: true, is_waiting: false, assigned_to: [], contained_in: [] }] }, "http://x");
    renderError(ui, { code: "rule_violation", message: `Task ${title} is in the way.`, blocking: [{ kind: "task", id: "WEB-001", title }], actions: [`Finish ${title}.`] });
    const printed = lines.join("\n");
    assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(printed), false, JSON.stringify(printed));
    assert.ok(printed.includes("ok\ufffd[2K"), "the place of the character is marked");
    assert.deepEqual(printable({ text: "line one\n\tline two", n: 3, none: null, list: ["a\u0000b"] }), { text: "line one\n\tline two", n: 3, none: null, list: ["a\ufffdb"] });
    // The names of fields are text from the store as much as their values: those of a history entry's changes are printed.
    assert.deepEqual(printable({ changes: { "title\u001b[2J": ["a", "b"] } }), { changes: { "title\ufffd[2J": ["a", "b"] } });
  });

  it("says of each list that is not whole how much of it is shown and how to read on, also on a page that continues one", () => {
    const lines: string[] = [];
    const ui = { fancy: false, paint: (_style: unknown, text: string) => text, out: (line = "") => void lines.push(line), err: (line = "") => void lines.push(line) } as Ui;
    const printed = () => lines.splice(0).join("\n");
    // Tokens as the service makes them: what else is not printed into a command.
    const token = (key: unknown) => Buffer.from(JSON.stringify({ q: "abcdefghijkl", k: key })).toString("base64url");
    const tok = { links: token("task:WEB-002"), timeline: token(100), history: token([7, 0]), earlier: token([3, 0]), users: token(100) };
    const entry = (action: string) => ({ at: "2026-01-01T00:00:00.000Z", by: "agent1", action, data: {} });
    const item = { kind: "task", id: "WEB-001", title: "Many of everything", type: "task", status: "open", priority: 0, value: null, size: null, version: 7, assigned_to: ["ann", "bob"], created_at: "c", created_by: "agent1", updated_at: "u", unchanged_since: 57 };
    renderResult(
      ui,
      "get",
      {
        ...item,
        links: { contains: [{ kind: "task", id: "WEB-002", title: "Inside", status: "open" }], "depends on": [{ kind: "task", id: "WEB-003", title: "First", status: "done" }] },
        timeline: [{ status: "open", at: "t", by: "agent1" }],
        history: [entry("created")],
        more: { assigned_to: { total: 150 }, links: { contains: { total: 250, continuation: tok.links } }, timeline: { total: 300, continuation: tok.timeline }, history: { total: 400, continuation: tok.history } },
      },
      "http://x",
    );
    const full = printed();
    assert.match(full, /Assigned to\s+ann, bob, … \(150 in all\)/);
    assert.match(full, new RegExp(`contains\\s+WEB-002\\s+Inside\\s+open\\n\\s+contains\\s+These are 1 of 250\\. Next page: add --continuation ${tok.links}\\n\\s+depends on\\s+WEB-003`), "the note stands under the list it is about, and only there");
    assert.match(full, new RegExp(`\\n {2}The latest 1 of 300\\. The ones before: add --continuation ${tok.timeline}\\n\\s+t\\s+open`));
    assert.match(full, new RegExp(`History\\n {2}The latest 1 of 400\\. The ones before: add --continuation ${tok.history}\\n`));

    // The first page says since which revision of the plan the item and its lists are unchanged, for the pages
    // after it to be held against.
    assert.match(full, /\n {2}Version {10}7\n {2}Unchanged since {2}revision 57\n/);
    // A page that continues a list is the item's ID and version and that list: not the latest entries any more.
    // It says the revision too, and what another one than the first page's means. What is printed as a page is
    // the answer to a call with a continuation: it goes by what was called, and not by what the answer looks like.
    const continued = { id: "WEB-001", continuation: tok.history };
    renderResult(ui, "get", { kind: "task", id: "WEB-001", version: 7, unchanged_since: 61, history: [entry("created")], more: { history: { total: 400, continuation: tok.earlier } } }, "http://x", continued);
    const page = printed();
    assert.match(page, new RegExp(String.raw`^\n {2}WEB-001 {2}v7\n {2}A page of the item as it is unchanged since revision 61\. If the first page said "Unchanged since" another revision, the item or one of its lists has changed in between: read it again from the start\.\n\n {2}History\n {2}A further 1 of 400\. The ones before: add --continuation ${tok.earlier}\n`));
    assert.equal(/undefined|The latest/.test(page), false, page);
    // A list whose name is a word every object answers to has no note unless the service gave one.
    renderResult(ui, "get", { kind: "task", id: "WEB-001", version: 7, unchanged_since: 61, links: { constructor: [{ kind: "task", id: "WEB-009", title: "Odd", status: "open" }] }, more: { links: {} } }, "http://x", continued);
    assert.equal(/These are|undefined/.test(printed()), false);
    renderResult(ui, "get", { kind: "task", id: "WEB-001", version: 7, unchanged_since: 61, links: { contains: [] } }, "http://x", continued);
    assert.match(printed(), /WEB-001 {2}v7\n {2}A page of the item as it is unchanged since revision 61\.[^\n]*\n\n {2}Nothing more\.\n/, "a page that holds nothing says so");
    renderResult(ui, "list_users", { users: [{ id: "USER-001", username: "admin", type: "admin", built_in: true }], you: "admin", continuation: tok.users }, "http://x");
    assert.match(printed(), new RegExp(`There are more\\. Next page: add --continuation ${tok.users}\n`));
    renderResult(
      ui,
      "list_stale_tasks",
      {
        attention_after_hours: 24,
        claims: [{ id: "WEB-004", title: "Quiet work", assigned_to: ["agent1"], quiet_since: "2026-01-01T00:00:00.000Z", attention_since: "2026-01-02T00:00:00.000Z" }],
        continuation: tok.users,
      },
      "http://x",
    );
    const stale = printed();
    assert.match(stale, /WEB-004\s+2026-01-01T00:00:00\.000Z\s+2026-01-02T00:00:00\.000Z\s+agent1\s+Quiet work/);
    assert.match(stale, /Attention threshold: 24 hours without a recorded task change/);
    assert.match(stale, new RegExp(`There are more\\. Next page: add --continuation ${tok.users}\n`));

    // What a command to read on is made with is a token, or nothing is printed: an answer is looked at before it
    // is printed, and what is no token is not put into a command whatever let it through.
    assert.match(full, /--continuation [A-Za-z][A-Za-z0-9_-]*\n/);
    const item0 = { ...item, links: {}, timeline: [{ status: "open", at: "t", by: "agent1" }], history: [entry("created")] };
    for (const none of [undefined, "", "x y", "$(reboot)", "tok-1", `-${tok.history}`, 5]) {
      assert.throws(() => renderResult(ui, "get", { ...item0, more: { history: { total: 150, continuation: none } } }, "http://x"), TypeError, `a history that goes on from ${String(none)}`);
      assert.throws(() => renderResult(ui, "get", { ...item0, more: { timeline: { total: 150, continuation: none } } }, "http://x"), TypeError);
      assert.throws(() => renderResult(ui, "get", { ...item0, links: { contains: [{ kind: "task", id: "WEB-002", title: "Inside", status: "open" }] }, more: { links: { contains: { total: 150, continuation: none } } } }, "http://x"), TypeError);
      if (none !== undefined) assert.throws(() => renderResult(ui, "list_users", { users: [{ id: "USER-001", username: "admin", type: "admin", built_in: true }], you: "admin", continuation: none }, "http://x"), TypeError);
    }
    lines.length = 0;

    const blocking = [{ kind: "task", id: "WEB-002", title: "Inside", status: "open" }];
    renderError(ui, { code: "rule_violation", message: "In the way.", blocking, blocking_total: 31 });
    assert.match(printed(), /· WEB-002 {2}Inside {2}open\n\s+· and 30 more\n/);
    renderError(ui, { code: "rule_violation", message: "In the way.", blocking });
    assert.equal(/more/.test(printed()), false);
  });
});

describe("command line", () => {
  let directory: string;
  let config: string;
  let service: Service;
  const cli = (...args: string[]) => run([...args, "--config", config]);

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), "vigile-cli-"));
    config = join(directory, "config.toml");
    initConfig(config, { name: "cli-test", port: await freePort() });
    service = await startService({ loaded: loadConfig(config, {}), log: () => {}, warn: () => {} });
  });
  after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });

  it("prints its version only when no command is given", async () => {
    assert.equal((await run(["--version"])).out.trim(), "0.1.0");
    const help = await run(["help"]);
    assert.match(help.out, /set-task-status/);
    assert.match((await run(["help", "create-task"])).out, /--depends-on <a,b,c>/);
  });

  it("stops with a hint when no config is given", async () => {
    const result = await run(["list-tasks"]);
    assert.equal(result.code, 1);
    assert.match(result.err, /No config file given/);
  });

  it("runs operations with hyphenated names and options, as the user named by --as", async () => {
    assert.equal((await cli("create-project", "--title", "Alpha", "--prefix", "abc", "--as", "agent1")).code, 0);
    const created = await cli("create-task", "--title", "First", "--description", "do it", "--project", "ABC", "--priority", "3", "--as", "agent1", "--json");
    assert.equal(JSON.parse(created.out).id, "ABC-001");
    await cli("create-task", "--title", "Second", "--description", "then this", "--project", "ABC", "--depends-on", "ABC-001", "--assigned-to", "user,agent1", "--as", "agent1");

    const started = await cli("set-task-status", "ABC-001", "--version", "1", "--status", "in_progress", "--as", "agent1", "--json");
    assert.deepEqual(JSON.parse(started.out).assigned_to, ["agent1"], "--version after a command is the item's version, not the CLI's");

    const list = await cli("list-tasks", "--as", "agent1");
    assert.match(list.out, /ID\s+STATE\s+TYPE\s+PRI\s+VALUE\s+SIZE\s+ASSIGNED\s+TITLE/);
    assert.match(list.out, /ABC-002\s+waiting\s+–\s+0\s+–\s+–\s+user,agent1\s+Second/);
    assert.equal(list.out.includes("\u001b["), false, "no colour codes when the output is not a terminal");
  });

  it("groups tasks under a parent, shows the group's progress, and marks bugs", async () => {
    const group = JSON.parse((await cli("create-task", "--title", "Checkout", "--description", "the feature", "--project", "ABC", "--as", "agent1", "--json")).out);
    await cli("create-task", "--title", "Card form", "--description", "step", "--parent", group.id, "--as", "agent1");
    await cli("create-task", "--title", "Crash on pay", "--description", "it crashes", "--parent", group.id, "--type", "bug", "--as", "agent1");
    const top = await cli("list-tasks", "--top-level", "--as", "agent1");
    assert.match(top.out, /Checkout  \(0\/2\)/);
    assert.equal(top.out.includes("Card form"), false);
    const inside = await cli("list-tasks", "--parent", group.id, "--as", "agent1");
    assert.match(inside.out, /next\s+bug\s+0\s+–\s+–\s+–\s+Crash on pay/);
    assert.match((await cli("get", group.id, "--as", "agent1")).out, /Progress\s+0 of 2 tasks inside finished/);
  });

  it("says in the history what each change was, in words that fit it", async () => {
    const group = JSON.parse((await cli("create-task", "--title", "Payments", "--description", "the feature", "--project", "ABC", "--as", "agent1", "--json")).out);
    const bug = JSON.parse((await cli("create-task", "--title", "Refund fails", "--description", "first text", "--project", "ABC", "--type", "bug", "--as", "agent1", "--json")).out);
    await cli("add-link", "--from", group.id, "--type", "contains", "--to", bug.id, "--as", "agent1");
    await cli("update-task", "--id", bug.id, "--version", "2", "--description", "second text", "--priority", "3", "--as", "agent1");
    const history = (await cli("get", bug.id, "--history", "--as", "agent1")).out;
    assert.match(history, /created\s+by agent1\s+as open, type bug, in ABC/);
    assert.match(history, new RegExp(`link added\\s+by agent1\\s+${group.id} contains ${bug.id}`));
    assert.match(history, /updated\s+by agent1\s+priority: 0 → 3, description/);
    assert.equal(history.includes("undefined"), false, history);
    // A user's own line names the user and its type.
    await cli("user", "add", "historian");
    const user = (await cli("get", "historian", "--history")).out;
    assert.match(user, /created\s+by admin\s+historian, agent/);
    assert.equal(user.includes("undefined"), false, user);
  });

  it("shows a refusal with what is in the way, and exits with an error", async () => {
    const refused = await cli("set-task-status", "ABC-002", "--version", "1", "--status", "done", "--as", "agent1");
    assert.equal(refused.code, 1);
    assert.match(refused.err, /cannot be marked done/);
    assert.match(refused.err, /ABC-001\s+First\s+in progress/);
    assert.match(refused.err, /→ Finish or cancel/);

    const asJson = await cli("set-task-status", "ABC-002", "--version", "1", "--status", "done", "--as", "agent1", "--json");
    assert.equal(JSON.parse(asJson.err).error.rule, "unfinished_dependencies");
  });

  it("rejects unknown options and missing values before calling the service", async () => {
    const unknown = await cli("list-tasks", "--stat", "open");
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /has no option --stat/);
    assert.match((await cli("update-task", "ABC-001", "--version", "two")).err, /must be a number/);
    assert.match((await cli("no-such-command")).err, /no command called/);
  });

  it("does not act as admin when --as lost its value, and takes yes/no options with a value", async () => {
    const before = JSON.parse((await cli("list-tasks", "--json")).out).tasks.length;
    for (const args of [["create-task", "--title", "As nobody", "--description", "d", "--as"], ["create-task", "--title", "As nobody", "--description", "d", "--as", ""], ["create-task", "--title", "As nobody", "--description", "d", "--as="]]) {
      const lost = await cli(...args);
      assert.equal(lost.code, 1, args.join(" "));
      assert.match(lost.err, /--as needs/);
    }
    assert.equal(JSON.parse((await cli("list-tasks", "--json")).out).tasks.length, before, "nothing was created as admin");
    const made = JSON.parse((await cli("create-task", "--title", "Not a draft", "--description", "d", "--draft", "false", "--as", "agent1", "--json")).out);
    assert.deepEqual([made.title, made.status], ["Not a draft", "open"]);
    const dashed = JSON.parse((await cli("create-task", "--title=--force is documented", "--description", "d", "--as", "agent1", "--json")).out);
    assert.equal(dashed.title, "--force is documented");
    // A yes/no option with some other word is refused, not taken for no: the delete would not be the one asked for.
    for (const args of [["delete", made.id, "--version", "1", "--permanent=yes"], ["list-tasks", "--top-level=1"], ["user", "remove", "agent1", "--permanent=yes"], ["doctor", "--json=yes"]]) {
      const odd = await cli(...args);
      assert.equal(odd.code, 1, args.join(" "));
      assert.match(odd.err, /yes\/no option/, args.join(" "));
    }
    assert.equal(JSON.parse((await cli("get", made.id, "--json")).out).deleted_at ?? null, null, "nothing was deleted");
    const twice = await cli("get", "--id", made.id, "--id", dashed.id);
    assert.equal(twice.code, 1);
    assert.match(twice.err, /--id is given twice/);
    // What follows a bare "--" is a word, also one that looks like --json: the refusal is in words, not in JSON.
    const word = await run(["get", "--config", config, "--", "--json"]);
    assert.equal(word.code, 1);
    assert.match(word.err, /No project, task or user matches "--json"/);
    assert.throws(() => JSON.parse(word.err), "the error is not JSON");
    const asked = await run(["get", "NOPE-999", "--json", "--config", config]);
    assert.equal(JSON.parse(asked.err).error.code, "not_found", "as an option before the --, it is");
    const spelled = await cli("create-task", "--title", "Two assignees", "--description", "d", "--assigned-to", "agent1", "--assigned_to", "admin");
    assert.equal(spelled.code, 1);
    assert.match(spelled.err, /--assigned-to and --assigned_to are the same option, given twice/);
  });

  it("refuses options and words that serve, config, user, doctor and backup do not know", async () => {
    const fresh = join(directory, "fresh", "config.toml");
    for (const [args, message] of [
      [["serve", "--listen.prot", "8899"], /no option --listen\.prot/],
      [["doctor", "--fix"], /no option --fix/],
      [["backup", join(directory, "b"), "--compress"], /no option --compress/],
      [["user", "add", "zed", "--typ", "person"], /no option --typ/],
      [["user", "list", "everyone"], /Unexpected "everyone"/],
      [["config", "set", "name", "a", "b", "c"], /Unexpected "b"/],
      [["config", "show", "--verbose"], /no option --verbose/],
    ] as const) {
      const result = await cli(...args);
      assert.equal(result.code, 1, args.join(" "));
      assert.match(result.err, message);
    }
    assert.equal(loadConfig(config, {}).config.name, "cli-test", "config set changed nothing");
    assert.equal(JSON.parse((await cli("user", "list", "--json")).out).some((u: any) => u.username === "zed"), false);
    // config init takes the names of the settings, as serve does, and refuses what it does not know.
    const wrong = await run(["config", "init", "--config", fresh, "--prot", "9999"]);
    assert.equal(wrong.code, 1);
    assert.equal(existsSync(fresh), false, "no file was written");
    const lost = await run(["config", "init", "--config", fresh, "--listen.port"]);
    assert.match(lost.err, /--listen\.port needs a value/);
    assert.equal((await run(["config", "init", "--config", fresh, "--listen.port", "8899", "--listen.address", "127.0.0.2", "--name", "fresh"])).code, 0);
    const made = loadConfig(fresh, {}).config;
    assert.deepEqual([made.name, made.listen.address, made.listen.port], ["fresh", "127.0.0.2", 8899]);
  });

  it("manages users and prints the settings an agent needs", async () => {
    const added = await cli("user", "add", "agent2");
    assert.equal(added.code, 0);
    assert.match(added.out, /"Authorization": "Bearer vig_/);
    assert.match(added.out, new RegExp(`"url": "${service.urls.mcp}"`));
    assert.match((await cli("user", "list")).out, /agent2\s+agent\s+API key/);
    assert.equal((await cli("user", "remove", "agent2")).code, 0);
    assert.equal((await cli("user", "remove", "agent1")).code, 1);
    assert.equal((await cli("create-user", "--username", "x", "--type", "agent", "--as", "agent1")).code, 1);
  });

  it("checks a healthy instance with the doctor, and backs it up", async () => {
    const doctor = await cli("doctor", "--json");
    const report = JSON.parse(doctor.out);
    assert.equal(doctor.code, 0);
    assert.equal(report.failed, 0);
    assert.ok(report.checks.some((c: any) => c.title === "MCP endpoint answers" && c.level === "ok"));
    assert.ok(report.checks.some((c: any) => c.title === "auth is off for non-admin users" && c.level === "warn"));

    const backup = await cli("backup", join(directory, "backups"), "--json");
    assert.equal(JSON.parse(backup.out).files.length, 1);
  });

  it("refuses a keyless user that does not exist, and repairs a config without an admin key", async () => {
    const typo = await cli("config", "set", "auth.keyless_user", "agnet1");
    assert.equal(typo.code, 1);
    assert.match(typo.err, /There is no user called "agnet1"/);
    assert.match(typo.err, /Users: .*agent1/);
    assert.equal(loadConfig(config, {}).config.auth.keyless_user, "agent1", "nothing was written");
    assert.equal((await cli("config", "set", "auth.keyless_user", "")).code, 0);
    assert.equal((await cli("config", "set", "auth.keyless_user", "agent1")).code, 0);

    // The admin key is lost from the file. The message says to run reset-key admin, and that works.
    const text = readFileSync(config, "utf8");
    writeFileSync(config, text.replace(/^admin = .*\n/m, ""));
    const broken = await cli("user", "list");
    assert.equal(broken.code, 1);
    assert.match(broken.err, /vigile user reset-key admin/);
    const repaired = await cli("user", "reset-key", "admin", "--json");
    assert.equal(repaired.code, 0, repaired.err);
    assert.equal(loadConfig(config, {}).config.auth.keys.admin, JSON.parse(repaired.out).api_key);
    // The running service takes the new key up, so the command line reaches it again.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await cli("user", "list")).code, 0);
  });

  it("refuses a config that does not pass the check", async () => {
    const bad = await cli("config", "set", "listen.port", "99999");
    assert.equal(bad.code, 1);
    assert.match(bad.err, /listen\.port/);
    assert.equal(loadConfig(config, {}).config.listen.port, service.server.address() && (service.server.address() as { port: number }).port);
    const shown = await cli("config", "show");
    assert.equal(shown.out.includes(loadConfig(config, {}).config.auth.keys.admin!), false, "keys are masked");
  });
});

describe("lists longer than a page, at the command line", () => {
  let directory: string;
  let config: string;
  let service: Service;
  let group: string;
  let busy: string;
  const cli = (...args: string[]) => run([...args, "--config", config]);
  const as = (username: string) => (operation: string, input: Record<string, unknown>) => service.engine.execute(operation, username, input) as Promise<any>;
  const names = Array.from({ length: 105 }, (_, n) => `u${String(n).padStart(3, "0")}`);

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), "vigile-cli-pages-"));
    config = join(directory, "config.toml");
    initConfig(config, { name: "cli-pages-test", port: await freePort() });
    service = await startService({ loaded: loadConfig(config, {}), log: () => {}, warn: () => {} });
    // 105 users beside the three that are built in, a group of 105 tasks, and a task that changed status 105 times.
    for (const username of names) await as("admin")("create_user", { username, type: "agent" });
    group = (await as("agent1")("create_task", { title: "A group of many", description: "d" })).id;
    for (let n = 1; n <= 105; n++) await as("agent1")("create_task", { title: `Step ${n}`, description: "d", parent: group, assigned_to: ["u000"] });
    busy = (await as("agent1")("create_task", { title: "Back and forth", description: "d" })).id;
    for (let n = 1; n <= 105; n++) await as("agent1")("set_task_status", { id: busy, version: n, status: n % 2 ? "draft" : "open" });
  });
  after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });

  it("shows a page of users with list-users and how to read on, and every user with user list", async () => {
    const first = (await cli("list-users")).out;
    assert.match(first, /USER-100\s+u096\s+agent/);
    assert.equal(first.includes("u097"), false, "the first page ends at 100 users");
    const token = /There are more\. Next page: add --continuation (\S+)/.exec(first)?.[1];
    assert.ok(token, first);
    const second = (await cli("list-users", "--continuation", token)).out;
    assert.deepEqual(second.match(/u\d{3}/g), names.slice(97));
    assert.equal(second.includes("There are more"), false);

    // Whoever manages the users sees them all, and each with how it connects.
    const listed = await cli("user", "list");
    assert.deepEqual(listed.out.match(/\bu\d{3}\b/g), names);
    assert.match(listed.out, /u104\s+agent\s+API key/);
    assert.equal(JSON.parse((await cli("user", "list", "--json")).out).length, 108);
  });

  it("knows a user beyond the first page as a user: in the config, in the doctor's check, at the next start and in a backup", async () => {
    // The last user of all may be the one a connection without a key acts as.
    const set = await cli("config", "set", "auth.keyless_user", "u104");
    assert.equal(set.code, 0, set.err);
    assert.equal((await cli("config", "set", "auth.keyless_user", "u105")).code, 1);
    const report = JSON.parse((await cli("doctor", "--json")).out);
    const check = report.checks.find((c: any) => c.title === "config users exist");
    assert.deepEqual([check.level, check.detail], ["ok", "106 users with a key"]);

    // Started again, the service finds every user its keys are for, and the one without a key.
    await service.stop();
    const warnings: string[] = [];
    service = await startService({ loaded: loadConfig(config, {}), log: () => {}, warn: (line) => warnings.push(line) });
    assert.deepEqual(warnings.filter((line) => /there is no user called/.test(line)), []);
    // A backup of this plan is one the service would start on, with all its users.
    const backup = JSON.parse((await cli("backup", join(directory, "backups"), "--json")).out);
    const plan = await openAsPlan("default", backup.files[0].file);
    assert.equal("users" in plan && plan.users.length, 108, JSON.stringify(plan).slice(0, 300));
  });

  it("shows the first 100 of an item's links with get, says how many there are, and reads on with the token it gives", async () => {
    const first = (await cli("get", group)).out;
    assert.equal(first.match(/^\s+contains\s+\d+\s+Step \d+\s+open$/gm)?.length, 100);
    const more = /contains\s+These are 100 of 105\. Next page: add --continuation (\S+)/.exec(first);
    assert.ok(more, first);
    const rest = await cli("get", group, "--continuation", more[1]!);
    assert.equal(rest.code, 0, rest.err);
    assert.deepEqual(rest.out.match(/Step \d+/g), ["Step 101", "Step 102", "Step 103", "Step 104", "Step 105"]);
    assert.match(rest.out, new RegExp(`^\\s+${group}\\s+v1$`, "m"), "a continued page says which item it is of");
    assert.equal(/undefined|These are|NaN/.test(rest.out), false, rest.out);
    // As JSON the same answer is the service's own.
    const json = JSON.parse((await cli("get", group, "--json")).out);
    assert.deepEqual([json.links.contains.length, json.more.links.contains.total], [100, 105]);
    // Each page says since which revision of the plan the item and its lists are unchanged: the first and the
    // one after it say the same while nothing changes.
    const since = (out: string) => Number(/(?:Unchanged since\s+revision|unchanged since revision) (\d+)/.exec(out)?.[1]);
    assert.ok(since(first) > 0, first);
    assert.equal(since(rest.out), since(first));
    assert.match(rest.out, /\n\s+A page of the item as it is unchanged since revision \d+\. If the first page said "Unchanged since" another revision, the item or one of its lists has changed in between: read it again from the start\.\n/);
    // One of the tasks of the first page is taken out of the group. The group's version stays, and the page
    // that is read with the token from before has the five that follow: put beside the first page they would
    // make 105 where 104 are left. The page says that it was read after a change.
    const out = /contains\s+(\d+)\s+Step 1\s/.exec(first)![1]!;
    await as("agent1")("remove_link", { from: group, type: "contains", to: out });
    const later = await cli("get", group, "--continuation", more[1]!);
    assert.match(later.out, new RegExp(`^\\s+${group}\\s+v1$`, "m"), "the group's version has not moved");
    assert.ok(since(later.out) > since(first), `the first page said revision ${since(first)}, the page read after the change ${since(later.out)}`);
    assert.equal(later.out.match(/Step \d+/g)?.length, 5);
    const again = JSON.parse((await cli("get", group, "--json")).out);
    assert.deepEqual([again.unchanged_since, again.more.links.contains.total, again.version], [since(later.out), 104, 1], "read from the start, the item says the same revision and counts what is left");
    await as("agent1")("add_link", { from: group, type: "contains", to: out });

    // The same for the tasks a user has: one of the first page is given back.
    const person = (await cli("get", "u000")).out;
    const given = /is assigned\s+These are 100 of 105\. Next page: add --continuation (\S+)/.exec(person);
    assert.ok(given, person);
    await as("agent1")("remove_link", { from: out, type: "assigned to", to: "u000" });
    const further = (await cli("get", "u000", "--continuation", given[1]!)).out;
    assert.ok(since(further) > since(person), `the user's first page said revision ${since(person)}, the page read after the change ${since(further)}`);
    assert.equal(JSON.parse((await cli("get", "u000", "--json")).out).more.links["is assigned"].total, 104);
    await as("agent1")("add_link", { from: out, type: "assigned to", to: "u000" });
    // A token that is of another item is refused, with what to do.
    const wrong = await cli("get", busy, "--continuation", more[1]!);
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /belongs to another list/);
  });

  it("shows the latest 100 entries of an item's timeline and history with get, and the ones before on request", async () => {
    const first = (await cli("get", busy, "--history")).out;
    const timeline = /The latest 100 of 106\. The ones before: add --continuation (\S+)\n\s+\S+\s+(?:open|draft)\s+by agent1/.exec(first);
    const history = /History\n\s+The latest 100 of 106\. The ones before: add --continuation (\S+)/.exec(first);
    assert.ok(timeline && history, first);
    assert.equal(first.match(/status changed\s+by agent1/g)?.length, 100);
    assert.equal(/\screated\s+by agent1/.test(first), false, "the creation is before the latest 100");
    const before = (await cli("get", busy, "--continuation", history[1]!)).out;
    assert.match(before, /History\n\s+\S+\s+created\s+by agent1\s+as open/);
    assert.equal(before.match(/status changed\s+by agent1/g)?.length, 5);
    assert.equal(/undefined|The latest|A further/.test(before), false, before);
    const earlier = (await cli("get", busy, "--continuation", timeline[1]!)).out;
    assert.equal(earlier.match(/^\s+\S+T\S+\s+(open|draft)\s+by agent1$/gm)?.length, 6);
  });

  it("names the first 20 items in the way of a change, and says how many more there are", async () => {
    const refused = await cli("set-task-status", group, "--version", "1", "--status", "done");
    assert.equal(refused.code, 1);
    assert.match(refused.err, /contains 105 unfinished tasks/);
    assert.equal(refused.err.match(/Step \d+\s+open/g)?.length, 20);
    assert.match(refused.err, /· and 85 more\n/);
    // A long word that names nothing is not printed back whole.
    const unknown = await cli("get", "x".repeat(5000));
    assert.equal(unknown.code, 1);
    assert.ok(unknown.err.length < 400, `${unknown.err.length} characters`);
    assert.match(unknown.err, /matches "x{80}… \(5000 characters\)"/);
  });
  it("shows the links that lead somewhere when most of an item's links lead nowhere, as damage to the data leaves them", async () => {
    const waits = (await as("agent1")("create_task", { title: "Waits for what is partly gone", description: "d" })).id as string;
    const there = ((await as("agent1")("get", { id: group })).links.contains as Array<{ id: string }>).slice(0, 5).map((item) => item.id);
    for (const id of there) await as("agent1")("add_link", { from: waits, type: "depends on", to: id });
    // 120 links to projects that are not there, which stand before every task in a list: a page of them and more.
    const gone = Array.from({ length: 120 }, (_, n) => ({ fromKind: "task", fromId: waits, type: "depends on", toKind: "project", toId: `GONE${String.fromCharCode(65 + Math.floor(n / 26))}${String.fromCharCode(65 + (n % 26))}` }));
    const written = async (changes: Array<{ op: "put_link"; record: any } | { op: "delete_link"; key: any }>) => {
      for (let from = 0; from < changes.length; from += 90) {
        const { head } = (await service.storage.load("default"))!;
        await service.storage.commit("default", { expectedRevision: head.revision, counters: head.counters, changes: changes.slice(from, from + 90) });
      }
      await service.engine.reload();
    };
    await written(gone.map((key) => ({ op: "put_link" as const, record: { ...key, data: { at: "2026-01-01T00:00:00.000Z", by: "1" } } })));
    try {
      const shown = await cli("get", waits);
      assert.equal(shown.code, 0, shown.err);
      assert.deepEqual(shown.out.match(/^\s+depends on\s+(\d+)\s+Step \d+/gm)?.map((line) => /(\d+)\s+Step/.exec(line)![1]), there, "the five that are there, and nothing that says there is more");
      assert.equal(/These are|Next page|GONE/.test(shown.out), false, shown.out);
      const json = JSON.parse((await cli("get", waits, "--json")).out);
      assert.deepEqual([json.links["depends on"].length, json.depends_on.length, "more" in json], [5, 5, false]);
      // Whoever checks the instance is told of the damage.
      const report = JSON.parse((await cli("doctor", "--json")).out);
      assert.equal(report.checks.find((c: any) => c.title === "graph is consistent").level, "fail");
    } finally {
      await written(gone.map((key) => ({ op: "delete_link" as const, key })));
    }
  });
});

describe("a service that is killed without warning", () => {
  let directory: string;
  let config: string;
  let base: string;
  let child: ChildProcess | undefined;

  const serve = async (): Promise<ChildProcess> => {
    const started = spawn(process.execPath, [BIN, "serve", "--config", config], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" } });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) return started;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    started.kill("SIGKILL");
    throw new Error("the service did not start");
  };
  const post = async (path: string, body: unknown) => (await fetch(`${base}/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;
  const exited = (process: ChildProcess) => new Promise((resolve) => process.once("exit", resolve));

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), "vigile-crash-"));
    config = join(directory, "config.toml");
    const port = await freePort();
    initConfig(config, { name: "crash-test", port });
    base = `http://127.0.0.1:${port}`;
  });
  after(() => {
    child?.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  });

  it("still has every confirmed write after it is started again", async () => {
    child = await serve();
    await post("create-project", { title: "Durable", prefix: "DUR" });
    const created: string[] = [];
    for (let i = 0; i < 25; i++) created.push((await post("create-task", { title: `Task ${i}`, description: "d", project: "DUR" })).id);
    await post("set-task-status", { id: created[0], version: 1, status: "in_progress" });

    const killed = exited(child);
    child.kill("SIGKILL");
    await killed;
    const lock = join(directory, "data", "vigile.lock");
    assert.equal(existsSync(lock), true, "a killed service leaves its lock behind");
    assert.equal(Number(readFileSync(lock, "utf8")), child.pid);

    child = await serve();
    assert.notEqual(Number(readFileSync(lock, "utf8")), Number.NaN);
    const tasks = (await post("list-tasks", { project: "DUR" })).tasks;
    assert.deepEqual(tasks.map((t: any) => t.id), created);
    assert.equal(tasks[0].status, "in_progress");
    assert.equal((await post("create-task", { title: "After the crash", description: "d", project: "DUR" })).id, "DUR-026");

    const doctor = await run(["doctor", "--json", "--config", config]);
    const report = JSON.parse(doctor.out);
    assert.equal(report.failed, 0, doctor.out);
    assert.ok(report.checks.some((c: any) => c.title === 'store "default" is intact' && c.level === "ok"));
    assert.ok(report.checks.some((c: any) => c.title === "graph is consistent" && c.level === "ok"));
  });

  it("starts although the lock file names a process that is alive and is not a Vigile service", async () => {
    // After a crash and a restart of the machine, the number in the lock file may belong to anything.
    const stopped = exited(child!);
    child!.kill("SIGKILL");
    await stopped;
    writeFileSync(join(directory, "data", "vigile.lock"), `${process.pid}\n`);
    child = await serve();
    assert.equal(Number(readFileSync(join(directory, "data", "vigile.lock"), "utf8")), child.pid, "and the lock file names the new service");
    assert.equal((await post("list-tasks", { project: "DUR" })).tasks.length, 26);
  });

  it("refuses a second service on the same data folder, also one on another port, and the doctor sees who holds it", async () => {
    const second = await run(["serve", "--config", config, "--listen.port", String(await freePort())]);
    assert.equal(second.code, 1);
    assert.match(second.err, new RegExp(`Another Vigile service \\(process ${child!.pid}\\) is already using`));
    // serve takes --json as every command does: it is not turned away as an option nobody knows, and the
    // failure to start is then reported as JSON.
    const asJson = await run(["serve", "--json", "--config", config, "--listen.port", String(await freePort())]);
    assert.equal(asJson.code, 1);
    const said = JSON.parse(asJson.err).error;
    assert.equal(said.code, "cannot_start");
    assert.match(said.message, new RegExp(`Another Vigile service \\(process ${child!.pid}\\) is already using`));
    assert.ok(Array.isArray(said.actions) && said.actions.length > 0, "with what to do about it");
    const plain = await run(["serve", "--json=false", "--config", config, "--listen.port", String(await freePort())]);
    assert.match(plain.err, /Another Vigile service/);
    assert.throws(() => JSON.parse(plain.err), "and in words when JSON is not asked for");
    // A start that warns of something and then fails: the warning is part of the one JSON document, not a line
    // of words before it. Here, a key in the config that belongs to nobody, and a port that is taken.
    const other = mkdtempSync(join(tmpdir(), "vigile-warned-"));
    try {
      const taken = String(loadConfig(config, {}).config.listen.port);
      initConfig(join(other, "config.toml"), { name: "warned", port: Number(taken) });
      writeFileSync(join(other, "config.toml"), `${readFileSync(join(other, "config.toml"), "utf8")}ghost = "vig_ghostghostghostghostghostghostghost"\n`);
      const warned = await run(["serve", "--json", "--config", join(other, "config.toml")]);
      assert.equal(warned.code, 1);
      const report = JSON.parse(warned.err);
      assert.equal(report.error.code, "cannot_start");
      assert.match(report.error.message, new RegExp(`Port ${taken} .* is already in use`));
      assert.equal(report.warnings.length, 1);
      assert.match(report.warnings[0], /auth\.keys\.ghost: there is no user called ghost/);
      // In words, both are said, the warning first.
      const words = await run(["serve", "--config", join(other, "config.toml")]);
      assert.match(words.err, /warning auth\.keys\.ghost[^]*is already in use/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    const report = JSON.parse((await run(["doctor", "--json", "--config", config])).out);
    assert.ok(report.checks.some((c: any) => c.title === "service holds the data folder" && c.level === "ok" && c.detail === `process ${child!.pid}`), JSON.stringify(report.checks));
  });

  it("keeps running when whatever reads its output goes away", async () => {
    const stopped = exited(child!);
    child!.kill("SIGTERM");
    await stopped;
    // The output goes into a pipe, as it does to a program that collects logs, and the reader leaves.
    child = spawn(process.execPath, [BIN, "serve", "--config", config], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
    for (let attempt = 0; attempt < 100 && !(await fetch(`${base}/health`).then((r) => r.ok, () => false)); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
    child.stdout!.destroy();
    child.stderr!.destroy();
    // Each write is a line in the log that can no longer be written.
    for (let i = 0; i < 5; i++) assert.equal((await post("create-task", { title: `Without a log ${i}`, description: "d", project: "DUR" })).id, `DUR-${String(27 + i).padStart(3, "0")}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(child.exitCode, null, "the service is still running");
    assert.equal((await post("list-tasks", { project: "DUR" })).tasks.length, 31);
  });

  it("stops cleanly on SIGTERM and releases the data folder", async () => {
    const stopped = exited(child!);
    child!.kill("SIGTERM");
    assert.equal(await stopped, 0);
    assert.equal(existsSync(join(directory, "data", "vigile.lock")), false);
    child = undefined;
  });
});

describe("restoring a backup", () => {
  it("puts the backup in place after a crash, sets aside what was there, and refuses while a service runs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-restore-"));
    const config = join(directory, "config.toml");
    const port = await freePort();
    initConfig(config, { name: "restore-test", port });
    const base = `http://127.0.0.1:${port}`;
    const data = join(directory, "data");
    const post = async (path: string, body: unknown) => (await fetch(`${base}/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;
    const serve = async (): Promise<ChildProcess> => {
      const started = spawn(process.execPath, [BIN, "serve", "--config", config], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" } });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) return started;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      started.kill("SIGKILL");
      throw new Error("the service did not start");
    };
    const exited = (child: ChildProcess) => new Promise((resolve) => child.once("exit", resolve));
    let child: ChildProcess | undefined;
    try {
      child = await serve();
      await post("create-project", { title: "Kept", prefix: "KEP" });
      for (let i = 0; i < 3; i++) await post("create-task", { title: `In the backup ${i}`, description: "d", project: "KEP" });
      const taken = JSON.parse((await run(["backup", join(directory, "backups"), "--json", "--config", config])).out);
      const backup = taken.files[0].file as string;
      // A second backup right away gets a name of its own.
      assert.equal((await run(["backup", join(directory, "backups"), "--config", config])).code, 0);
      // The data folder itself is no place for a backup: the next start would take it for a tenant.
      const inside = await run(["backup", data, "--config", config]);
      assert.equal(inside.code, 1);
      assert.match(inside.err, /cannot go into the data folder/);
      // Nor by another name for it, through a link.
      symlinkSync(data, join(directory, "data-by-another-name"));
      const aliased = await run(["backup", join(directory, "data-by-another-name"), "--config", config]);
      assert.equal(aliased.code, 1);
      assert.match(aliased.err, /cannot go into the data folder/);
      assert.deepEqual(readdirSync(data).filter((name) => /^default-\d/.test(name)), [], "no backup was written among the data");

      const refused = await run(["restore-backup", backup, "--config", config]);
      assert.equal(refused.code, 1);
      assert.match(refused.err, /A Vigile service, or another restore, is using/);

      // More is written, and the service is killed: what it had not yet folded into the data file stays beside it.
      for (let i = 0; i < 40; i++) await post("create-task", { title: `After the backup ${i}`, description: "x".repeat(2000), project: "KEP" });
      const killed = exited(child);
      child.kill("SIGKILL");
      await killed;
      child = undefined;
      assert.equal(existsSync(join(data, "default.sqlite-wal")), true, "the killed service left its log of changes beside the data");

      const restored = await run(["restore-backup", backup, "--json", "--config", config]);
      assert.equal(restored.code, 0, restored.err);
      const result = JSON.parse(restored.out);
      assert.equal(result.tenant, "default");
      assert.deepEqual(result.set_aside.files.slice(0, 2), ["default.sqlite", "default.sqlite-wal"]);
      assert.equal(existsSync(join(result.set_aside.folder, "default.sqlite")), true, "what was there is kept");
      assert.equal(existsSync(join(data, "default.sqlite-wal")), false, "and nothing of it is left beside the restored data");

      const doctor = JSON.parse((await run(["doctor", "--json", "--config", config])).out);
      assert.ok(doctor.checks.some((c: any) => c.title === 'store "default" is intact' && c.level === "ok"), JSON.stringify(doctor.checks));

      // The restore is taken back, by restoring from what it set aside. That file has changes in the file beside
      // it that the killed service never folded in: a restore from it brings them along, where a copy of the data
      // file alone would silently go back to an earlier state.
      const back = await run(["restore-backup", join(result.set_aside.folder, "default.sqlite"), "--tenant", "default", "--json", "--config", config]);
      assert.equal(back.code, 0, back.err);
      child = await serve();
      assert.equal((await post("get", { id: "KEP-043" })).title, "After the backup 39", "the last task the killed service had stored is there");
      const again = exited(child);
      child.kill("SIGTERM");
      await again;
      child = undefined;
      assert.deepEqual(readdirSync(data).filter((name) => name.includes(".restoring")), [], "and nothing of the copy is left, nor what the check of it put beside it");
      assert.equal((await run(["restore-backup", backup, "--config", config])).code, 0);

      child = await serve();
      const tasks = (await post("list-tasks", { project: "KEP" })).tasks;
      assert.deepEqual(tasks.map((t: any) => t.title), ["In the backup 0", "In the backup 1", "In the backup 2"]);
      assert.equal((await post("create-task", { title: "After the restore", description: "d", project: "KEP" })).id, "KEP-004");

      // A name that would lead out of the data folder is no tenant, and the data itself is no backup of itself.
      const outside = await run(["restore-backup", backup, "--tenant", "../../elsewhere", "--config", config]);
      assert.equal(outside.code, 1);
      assert.match(outside.err, /cannot be the name of a tenant/);
      assert.equal(existsSync(join(directory, "..", "elsewhere.sqlite")), false);
      // A file that is not a backup is refused before anything is touched.
      const stopped = exited(child);
      child.kill("SIGTERM");
      await stopped;
      child = undefined;
      writeFileSync(join(directory, "default-20260101-000000.sqlite"), "this is not a database");
      const bad = await run(["restore-backup", join(directory, "default-20260101-000000.sqlite"), "--config", config]);
      assert.equal(bad.code, 1);
      assert.match(bad.err, /cannot be restored/);
      assert.equal(existsSync(join(data, "default.sqlite")), true);
      const itself = await run(["restore-backup", join(data, "default.sqlite"), "--tenant", "default", "--config", config]);
      assert.equal(itself.code, 1);
      assert.match(itself.err, /is the data itself/);
      // Nor is what lies beside the data file, whatever is in it: a restore moves that aside with the data file.
      copyFileSync(backup, join(data, "default.sqlite-wal"));
      const beside = await run(["restore-backup", join(data, "default.sqlite-wal"), "--tenant", "default", "--config", config]);
      assert.equal(beside.code, 1);
      assert.match(beside.err, /is the data itself/);
      rmSync(join(data, "default.sqlite-wal"));
      assert.equal(existsSync(join(data, "default.sqlite")), true, "and the data is where it was");
      assert.deepEqual(readdirSync(data).filter((name) => name.endsWith(".restoring")), [], "nothing half-restored is left");
      // A backup that lies where a restore keeps its copy while it works would be copied onto itself and lost.
      const staging = join(data, "default.sqlite.restoring");
      copyFileSync(backup, staging);
      const onto = await run(["restore-backup", staging, "--tenant", "default", "--config", config]);
      assert.equal(onto.code, 1);
      assert.match(onto.err, /is a file that a restore works with in the data folder/);
      assert.equal(readFileSync(staging).equals(readFileSync(backup)), true, "the file is still there, and whole");
      rmSync(staging);
      // The same for whatever may lie beside that copy, for the copy of another tenant's restore, and for any of
      // them reached by another name: all are cleared away when a restore begins or an earlier one is recovered.
      const elsewhere = join(directory, "a-backup-by-another-name.sqlite");
      for (const [name, given] of [
        ["default.sqlite.restoring-journal", null],
        ["default.sqlite.restoring-wal", null],
        ["other.sqlite.restoring", null],
        ["other.sqlite.restoring", elsewhere],
      ] as const) {
        const working = join(data, name);
        copyFileSync(backup, working);
        if (given) symlinkSync(working, given);
        // A restore of another tenant that was interrupted: its recovery clears that tenant's copy away.
        writeFileSync(join(data, "restore-in-progress.json"), JSON.stringify({ tenant: "other", aside: "replaced-20260101-000000-900", had: [] }));
        const gone = await run(["restore-backup", given ?? working, "--tenant", "default", "--config", config]);
        assert.equal(gone.code, 1, name);
        assert.match(gone.err, /is a file that a restore works with in the data folder/, name);
        assert.equal(readFileSync(working).equals(readFileSync(backup)), true, `${name}: the file is still there, and whole`);
        rmSync(working);
        rmSync(join(data, "restore-in-progress.json"));
        if (given) rmSync(given);
      }
      // And for the note of a restore, with or without its name yet: one is cleared away, the other written over.
      for (const [name, given] of [
        ["restore-in-progress.json.tmp", null],
        ["restore-in-progress.json.tmp", elsewhere],
        ["restore-in-progress.json", null],
      ] as const) {
        const working = join(data, name);
        copyFileSync(backup, working);
        if (given) symlinkSync(working, given);
        const gone = await run(["restore-backup", given ?? working, "--tenant", "default", "--config", config]);
        assert.equal(gone.code, 1, name);
        assert.match(gone.err, /is a file that a restore works with in the data folder/, name);
        assert.equal(readFileSync(working).equals(readFileSync(backup)), true, `${name}: the file is still there, and whole`);
        rmSync(working);
        if (given) rmSync(given);
      }
      // A file that is a sound database with a plan's tables, and whose content the service could not read: a
      // record that is not a record, counters that are not numbers. It is refused, and the data that works stays.
      const beforeBad = readFileSync(join(data, "default.sqlite"));
      for (const [name, damage, says] of [
        ["record", "UPDATE objects SET data = '{not a record' WHERE kind = 'project'", /what is stored in it cannot be read/],
        ["counters", "UPDATE head SET counters = '[\"none\"]'", /its counters are not numbers/],
        ["shape", "UPDATE objects SET data = '\"a word\"' WHERE kind = 'project'", /is not a record/],
        // Every record reads, and the plan is one the service does not start on: it has no admin.
        ["nobody", "DELETE FROM objects WHERE kind = 'user' AND json_extract(data, '$.username') = 'admin'", /the service would not start on it \(There is no user called "admin"\.\)/],
        // One whose admin is no admin: nobody could do what only an admin can, and no new key would mend it.
        ["agent", "UPDATE objects SET data = json_set(data, '$.type', 'agent') WHERE kind = 'user' AND json_extract(data, '$.username') = 'admin'", /the plan in it is damaged: The built-in user "admin" is of type agent, not admin/],
        // And one whose users carry something that is not a list where the marks of their keys belong.
        ["marks", "UPDATE objects SET data = json_set(data, '$.key_marks', 7) WHERE kind = 'user' AND json_extract(data, '$.username') = 'agent1'", /the user agent1 has key marks that are not a list of marks/],
        // A plan whose counters fell behind the IDs in use: the next task would get the ID of one that is there.
        ["behind", "UPDATE head SET counters = '{}'", /the plan in it is damaged: .*counter/],
        // And a file that lacks a column the store reads and writes: every task would fail to open.
        ["column", "ALTER TABLE objects DROP COLUMN text", /its table "objects" has no column "text"/],
        ["table", "DROP TABLE history", /it has no table "history"/],
        // Records that read as records and lack what the engine reads in them: every list of tasks would fail.
        ["timeline", "UPDATE objects SET data = json_set(data, '$.timeline', json('null')) WHERE kind = 'task'", /the plan in it is damaged: The task \S+ is damaged: timeline is not what it has to be/],
        ["status", "UPDATE objects SET data = json_set(data, '$.status', 'sideways') WHERE kind = 'project'", /The project \S+ is damaged: status is not what it has to be/],
        ["title", "UPDATE objects SET data = json_remove(data, '$.title') WHERE kind = 'task'", /The task \S+ is damaged: title is not what it has to be/],
        ["kind", "UPDATE objects SET kind = 'gizmo' WHERE kind = 'project'", /is of a kind that is not known/],
        ["word", "UPDATE objects SET kind = 'constructor' WHERE kind = 'project'", /The constructor \S+ is damaged: is of a kind that is not known/],
        // A task that does not say whether it is deleted would be neither shown nor in anyone's way.
        ["deleted", "UPDATE objects SET data = json_remove(data, '$.deleted_at') WHERE kind = 'task'", /The task \S+ is damaged: deleted_at is not what it has to be/],
        // And an entry of the history that is not a record: opening the item with its history would fail.
        ["history", "UPDATE history SET data = '{not a record' WHERE kind = 'task'", /an entry in the history of task \S+, at revision \d+, is not a record/],
        ["entry", "UPDATE history SET data = '[1, 2]' WHERE kind = 'project'", /an entry in the history of project \S+, at revision \d+, is not a record/],
        // A user stored under a number with a nought before it: shown the same, and every change would go past it.
        ["nought", "UPDATE objects SET id = '0' || id WHERE kind = 'user' AND json_extract(data, '$.username') = 'agent1'", /The user is stored under "0\d+", where the store writes "\d+"/],
        ["past", "UPDATE history SET id = '0' || id WHERE kind = 'user'", /the history of user "0\d+" is stored under an ID the store would not write/],
        // A task that is done, with nothing in its timeline that says when: that moment could not be set either.
        ["done", "UPDATE objects SET data = json_set(data, '$.status', 'done') WHERE kind = 'task'", /The task \S+ is damaged: has the status done, and its timeline ends with \w+/],
        ["bare", "UPDATE objects SET data = json_set(data, '$.timeline', json('[]')) WHERE kind = 'task'", /The task \S+ is damaged: timeline is not what it has to be \(empty\)/],
        // A project whose prefix could not be a prefix: the next task in it would get an ID nobody can ask for.
        ["prefix", "UPDATE objects SET data = json_set(data, '$.prefix', 'bad prefix') WHERE kind = 'project'", /The project \S+ is damaged: prefix is not what it has to be/],
        // An item that cannot be asked for by its ID, and one that no change could name the version of.
        ["id", "UPDATE objects SET id = 'garbage' WHERE kind = 'task' AND id = (SELECT min(id) FROM objects WHERE kind = 'task')", /The task garbage is damaged: has an ID that an item of its kind cannot have/],
        ["version", "UPDATE objects SET version = 0 WHERE kind = 'task'", /The task \S+ is damaged: version is not what it has to be/],
        // And a table that has every column and not the key the store writes by: every change would fail.
        [
          "key",
          "CREATE TABLE remade (kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, text TEXT) STRICT; INSERT INTO remade SELECT kind, id, version, data, text FROM objects; DROP TABLE objects; ALTER TABLE remade RENAME TO objects;",
          /its table "objects" does not have the key the store writes by \(kind, id\)/,
        ],
        // A column the store does not fill, a trigger that turns a write away, a default the store did not give.
        ["extra", "ALTER TABLE objects ADD COLUMN required_extra TEXT NOT NULL DEFAULT 'x'", /its table "objects" has a column "required_extra" that the store does not make and would not fill/],
        ["trigger", "CREATE TRIGGER no_more BEFORE INSERT ON objects BEGIN SELECT RAISE(ABORT, 'no more'); END", /it has a trigger "no_more" that the store does not make/],
        ["index", "CREATE INDEX by_version ON objects (version)", /it has an index "by_version" that the store does not make/],
        // A name that only looks like one of SQLite's own is as much the file's as any other.
        ["named", "CREATE TRIGGER sqliteX_block_writes BEFORE INSERT ON objects BEGIN SELECT RAISE(ABORT, 'no more'); END", /it has a trigger "sqliteX_block_writes" that the store does not make/],
        // A file that says it is at an earlier revision than its history reaches: the next change would be written where an entry is.
        ["earlier", "UPDATE head SET revision = (SELECT max(revision) FROM history) - 1", /its history goes on to revision \d+, after revision \d+, which it says it is at/],
        [
          "defined",
          "CREATE TABLE remade (kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL CHECK (action <> 'updated'), data TEXT NOT NULL, PRIMARY KEY (kind, id, revision, seq)) STRICT, WITHOUT ROWID; INSERT INTO remade SELECT * FROM history WHERE action <> 'updated'; DROP TABLE history; ALTER TABLE remade RENAME TO history;",
          /its table "history" is not defined the way the store defines it/,
        ],
      ] as const) {
        const damaged = join(directory, `default-20260101-00000${name.length}.sqlite`);
        copyFileSync(backup, damaged);
        const db = new DatabaseSync(damaged);
        db.exec(damage);
        db.close();
        const unloadable = await run(["restore-backup", damaged, "--config", config]);
        assert.equal(unloadable.code, 1, name);
        assert.match(unloadable.err, /cannot be restored/, name);
        assert.match(unloadable.err, says, name);
        assert.equal(readFileSync(join(data, "default.sqlite")).equals(beforeBad), true, `${name}: the data that works is still in place`);
        assert.deepEqual(readdirSync(data).filter((file) => file.includes("restor")), [], `${name}: and nothing of the attempt is left`);
      }
      // A backup is readable by its owner only, also in a folder that others can look into.
      assert.equal(statSync(backup).mode & 0o077, 0);
      // A backup from before the user that connections without a key act as: the backup is restored, since it
      // may be the very one that is wanted, and the answer says that the service will not start until the
      // setting is changed, and how, in words and in JSON.
      setValue(config, "auth.keyless_user", "newcomer");
      const early = await run(["restore-backup", backup, "--json", "--config", config]);
      assert.equal(early.code, 0, early.err);
      assert.deepEqual(JSON.parse(early.out).warnings.length, 1);
      assert.match(JSON.parse(early.out).warnings[0], /act as "newcomer", and the restored plan has no such user: the service will not start like this\. Before starting it, run: vigile config set auth\.keyless_user ""/);
      const earlyText = await run(["restore-backup", backup, "--config", config]);
      assert.match(earlyText.out, /the restored plan has no such user/);
      const refusedStart = await run(["serve", "--config", config]);
      assert.equal(refusedStart.code, 1, "which is true: it does not start");
      assert.equal((await run(["config", "set", "auth.keyless_user", "", "--config", config])).code, 0, "and the way out that was named works with nothing running");
      setValue(config, "auth.keyless_user", "agent1");
      assert.equal("warnings" in JSON.parse((await run(["restore-backup", backup, "--json", "--config", config])).out), false, "with a config that goes with the plan there is nothing to warn of");
      // A data folder in which a service from before this version may be running, which the lock of the system
      // does not know of: a restore does not move files there.
      const before = mkdtempSync(join(tmpdir(), "vigile-before-"));
      try {
        initConfig(join(before, "config.toml"), { name: "before", port: await freePort() });
        mkdirSync(join(before, "data"));
        writeFileSync(join(before, "data", "vigile.lock"), `${process.pid}\n`);
        const inUse = await run(["restore-backup", backup, "--config", join(before, "config.toml")]);
        assert.equal(inUse.code, 1);
        assert.match(inUse.err, /A Vigile service from before this version may be using/);
        assert.deepEqual(readdirSync(join(before, "data")), ["vigile.lock"]);
      } finally {
        rmSync(before, { recursive: true, force: true });
      }
      // While a backup is at work, a restore does not move the files away under it; while a restore is at work,
      // a backup does not start on files that are about to move. Each waits a little, then says who is at work.
      const atWork = holdTenantFiles(data);
      assert.ok(atWork);
      const [kept, late] = await Promise.all([run(["restore-backup", backup, "--config", config]), run(["backup", join(directory, "backups"), "--config", config])]);
      assert.equal(kept.code, 1);
      assert.match(kept.err, /A backup of .* is being taken/);
      assert.equal(late.code, 1);
      assert.match(late.err, /A restore, or another backup, is at work in/);
      assert.equal(existsSync(join(data, "restore-in-progress.json")), false, "the restore moved nothing");
      atWork();
      assert.equal((await run(["backup", join(directory, "backups"), "--config", config])).code, 0, "once it has let go, a backup is taken");
      // Something else where the hold on the data folder belongs: the restore says which folder it cannot take.
      rmSync(join(data, "vigile.hold"), { force: true });
      rmSync(join(data, "vigile.hold-journal"), { force: true });
      mkdirSync(join(data, "vigile.hold"));
      const unheld = await run(["restore-backup", backup, "--config", config]);
      assert.equal(unheld.code, 1);
      assert.match(unheld.err, /The data folder .* cannot be taken for a restore/);
    } finally {
      child?.kill("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("a data file that cannot be written", () => {
  it("is reported by the doctor, and keeps the service from starting with the reason", async () => {
    // Someone who may write every file, as root may, cannot see this happen.
    if (process.getuid?.() === 0) return;
    const directory = mkdtempSync(join(tmpdir(), "vigile-readonly-"));
    const config = join(directory, "config.toml");
    initConfig(config, { name: "readonly-test", port: await freePort() });
    const file = join(directory, "data", "default.sqlite");
    try {
      const service = await startService({ loaded: loadConfig(config, {}), log: () => {}, warn: () => {} });
      await service.engine.execute("create_task", "agent1", { title: "Stored", description: "d" });
      await service.stop();
      chmodSync(file, 0o444);

      const report = JSON.parse((await run(["doctor", "--json", "--config", config])).out);
      const check = report.checks.find((c: any) => c.title === 'store "default" can be written');
      assert.deepEqual([check.level, check.detail], ["fail", file]);
      const started = await run(["serve", "--config", config]);
      assert.equal(started.code, 1);
      assert.match(started.err, /The data file .*default\.sqlite cannot be written/);
      assert.equal(existsSync(join(directory, "data", "vigile.lock")), false, "and it lets go of the data folder");

      chmodSync(file, 0o600);
      const again = JSON.parse((await run(["doctor", "--json", "--config", config])).out);
      assert.equal(again.checks.find((c: any) => c.title === 'store "default" can be written').level, "ok");
    } finally {
      chmodSync(file, 0o600);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("an admin key written to a folder that cannot be flushed", () => {
  it("is handed over all the same, with a warning: it is the admin key from then on", async () => {
    // Someone who may read anywhere, as root may, cannot see this happen.
    if (process.getuid?.() === 0) return;
    const directory = mkdtempSync(join(tmpdir(), "vigile-unconfirmed-"));
    const config = join(directory, "config.toml");
    try {
      // A folder that can be written to and not opened for reading: the file is replaced, the flush after it fails.
      chmodSync(directory, 0o300);
      const made = await run(["config", "init", "--config", config, "--json"]);
      chmodSync(directory, 0o700);
      assert.equal(made.code, 0, made.err);
      const created = JSON.parse(made.out);
      assert.match(created.warning, /is in place, but the system could not confirm that it will survive a power cut/);
      assert.equal(loadConfig(config, {}).config.auth.keys.admin, created.admin_key, "the key that was handed over is the one in the file");

      // The admin key is lost from the file and written anew, with nothing running.
      writeFileSync(config, readFileSync(config, "utf8").replace(/^admin = .*\n/m, ""));
      chmodSync(directory, 0o300);
      const repaired = await run(["user", "reset-key", "admin", "--config", config, "--json"]);
      const shown = await run(["user", "reset-key", "admin", "--config", config]);
      chmodSync(directory, 0o700);
      assert.equal(repaired.code, 0, repaired.err);
      const answer = JSON.parse(repaired.out);
      assert.match(answer.warning, /could not confirm that it will survive a power cut/);
      assert.match(answer.api_key, /^vig_/);
      // The second time the key is replaced through the same direct path, since no service runs: in words, with the warning.
      assert.equal(shown.code, 0, shown.err);
      assert.match(shown.out, /admin has a new API key/);
      assert.match(shown.out, /could not confirm that it will survive a power cut/);
      assert.ok(shown.out.includes(loadConfig(config, {}).config.auth.keys.admin!), "and the key that is shown is the one in the file");
    } finally {
      chmodSync(directory, 0o700);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("what the command line says when it is not the config that is wrong", () => {
  it("says of a key the service refuses where the key is from, and of a config that is being changed that it is busy", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-says-"));
    const config = join(directory, "config.toml");
    initConfig(config, { name: "says-test", port: await freePort() });
    const service = await startService({ loaded: loadConfig(config, { VIGILE_AUTH_KEYLESS_USER: "" }), log: () => {}, warn: () => {} });
    try {
      // A key that was put into the file by hand, and was never issued for the user it stands under.
      await service.engine.execute("create_user", "admin", { username: "bob", type: "agent" });
      const keys = readFileSync(config, "utf8").replace(/^bob = .*$/m, 'bob = "vig_put-in-by-hand-0123456789abcdef"');
      writeFileSync(config, keys);
      const refused = await run(["list-projects", "--as", "bob", "--config", config]);
      assert.equal(refused.code, 1);
      assert.match(refused.err, /The API key is not valid/);
      assert.match(refused.err, /Check the key in the Authorization header/, "what the service advises is still there");
      assert.match(refused.err, /The command line took the key from the config file\. vigile doctor says what is wrong with it; vigile user reset-key <username> issues a new one/);
      // Without a key there is no key to speak of: the service's own advice stands alone. This run of the service
      // wants a key from everyone, and the file, which the command line goes by, lets agent1 in without one.
      const keyless = await run(["list-projects", "--as", "agent1", "--config", config]);
      assert.equal(keyless.code, 1);
      assert.match(keyless.err, /This service needs an API key/);
      assert.doesNotMatch(keyless.err, /The command line took the key/);
      // The list of users does not say that such a key connects: it is in the config, and it lets nobody in.
      const listed = JSON.parse((await run(["user", "list", "--json", "--config", config])).out) as Array<{ username: string; access: string; key_refused?: boolean }>;
      assert.deepEqual(listed.filter((u) => u.username === "bob" || u.username === "admin").map((u) => [u.username, u.access, u.key_refused ?? false]).sort(), [["admin", "API key", false], ["bob", "cannot connect", true]]);
      const shown = await run(["user", "list", "--config", config]);
      assert.match(shown.out, /bob\s+agent\s+cannot connect/);
      assert.match(shown.out, /The key the config has for bob was not issued for the user as the data has it, and is refused\. Issue a new one: vigile user reset-key bob/);
      // The doctor names the user whose key is not its own.
      const report = JSON.parse((await run(["doctor", "--json", "--config", config])).out);
      const check = report.checks.find((c: any) => c.title === "each key is its user's own");
      assert.equal(check?.level, "warn", JSON.stringify(report.checks));
      assert.match(check.detail, /the key in the config for bob was not issued for the user/);

      // Someone is changing the config and does not finish: that is not a config that is wrong.
      const release = holdFile(`${config}.hold`);
      assert.ok(release);
      const busy = await run(["config", "set", "name", "other", "--config", config]);
      release();
      assert.equal(busy.code, 1);
      assert.match(busy.err, /another change to the config file is under way and does not finish/);
      assert.match(busy.err, /Nothing was changed\. Try again in a moment/);
      assert.doesNotMatch(busy.err, /The config is not correct/);
      assert.equal(loadConfig(config, {}).config.name, "says-test");
    } finally {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("something else on the service's port", () => {
  const health = (name: string) => JSON.stringify({ status: "ok", name, version: "0.1.0" });

  it("is sent no key and nothing of the plan while the service is down: not by an operation, not by the user commands, not by the doctor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-stranger-"));
    const config = join(directory, "config.toml");
    const port = await freePort();
    initConfig(config, { name: "stranger-test", port });
    const adminKey = loadConfig(config, {}).config.auth.keys.admin;
    // It says of itself, word for word, what the service of this config would, and answers every command with
    // something the command could print.
    const listener = await stranger(port, (request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(request.url === "/health" ? health("stranger-test") : JSON.stringify({ users: [], tasks: [], projects: [], status: "ok" }));
    });
    const cli = (...args: string[]) => run([...args, "--config", config]);
    try {
      const commands = [
        ["list-tasks"],
        ["create-project", "--title", "A plan nobody else may read", "--prefix", "SEC"],
        ["list-tasks", "--as", "agent1"],
        ["user", "list"],
        ["user", "add", "zed"],
        ["user", "remove", "agent1"],
        ["user", "reset-key", "agent1"],
      ];
      for (const command of commands) {
        const result = await cli(...command);
        assert.equal(result.code, 1, command.join(" "));
        assert.equal(result.out, "", `${command.join(" ")} prints nothing of what the stranger answered`);
        assert.match(result.err, /A Vigile service that calls itself "stranger-test" answers at http:\/\/127\.0\.0\.1:\d+, and it is not the service of this config: no service holds the data folder \S+\. Nothing was sent to it, and no key\./, command.join(" "));
        assert.match(result.err, /If it is this config's service, it runs on another data folder: data_dir was changed after it started, or given for one run \(serve --data_dir, VIGILE_DATA_DIR\)\. Stop it and start it again, or run this command with the same VIGILE_DATA_DIR\./);
        assert.match(result.err, /If not, stop the program that has the port, or choose another port: vigile config set listen\.port <port>/);
        assert.match(result.err, /Then start the service: vigile serve --config \S+config\.toml/);
      }
      // For a script it is a service that does not run, said in the shape every failure has.
      const asJson = await cli("list-tasks", "--json");
      assert.equal(asJson.code, 1);
      const failure = JSON.parse(asJson.err) as { error: { code: string; message: string; actions: string[] } };
      assert.equal(failure.error.code, "not_running");
      assert.match(failure.error.message, /it is not the service of this config/);
      assert.equal(failure.error.actions.length, 3);

      // The doctor says that something else answers, and ends as a doctor does: with its report and a failed check.
      const doctor = await cli("doctor");
      assert.equal(doctor.code, 1);
      assert.equal(doctor.err, "", "the doctor does not crash on what it is answered");
      assert.match(doctor.out, /service is running\s+A Vigile service that calls itself "stranger-test" answers at \S+, and it is not the service of this config/);
      assert.match(doctor.out, /stop the program that has the port/);
      assert.doesNotMatch(doctor.out, /admin key works/);
      assert.match(doctor.out, /1 failed/);
      const report = JSON.parse((await cli("doctor", "--json")).out) as { ok: boolean; checks: Array<{ section: string; level: string; title: string; detail?: string; fix?: string }> };
      assert.equal(report.ok, false);
      assert.deepEqual(report.checks.filter((c) => c.section === "Service").map((c) => [c.title, c.level]), [["service is running", "fail"]]);

      // A setting that the running service would be asked about is written unasked, as when nothing answers.
      const set = await cli("config", "set", "auth.keyless_user", "agent1");
      assert.equal(set.code, 0, set.err);
      assert.match(set.out, /The service is not running, so whether there is a user called agent1 could not be checked/);
      // The admin key is replaced in the file, as when nothing answers: the new one does not leave either.
      const reset = await cli("user", "reset-key", "admin", "--json");
      assert.equal(reset.code, 0, reset.err);
      const newKey = (JSON.parse(reset.out) as { api_key: string }).api_key;
      assert.equal(loadConfig(config, {}).config.auth.keys.admin, newKey);
      assert.notEqual(newKey, adminKey);

      assert.ok(listener.seen.length >= commands.length + 5, "each command asked who is there");
      assert.deepEqual([...new Set(listener.seen.map((request) => request.asked))], ["GET /health"]);
      assert.ok(listener.seen.every((request) => request.authorization === undefined), "the stranger never saw an Authorization header");
      assert.ok(listener.seen.every((request) => request.body === ""));
      assert.ok(!JSON.stringify(listener.seen).includes("vig_"));

      // One that does not even say what a Vigile service says, as the program that the review of the command
      // line put there: the doctor used to call it a healthy service, and then crashed on what it answered.
      await listener.close();
      const plain = await stranger(port, (_request, response) => response.end('{"status":"ok","name":"fake"}'));
      try {
        const result = await cli("list-tasks");
        assert.equal(result.code, 1);
        assert.match(result.err, /Something that is not a Vigile service answers at \S+, and it is not the service of this config: no service holds the data folder/);
        assert.match(result.err, /Stop the program that has the port, or choose another port/);
        assert.doesNotMatch(result.err, /VIGILE_DATA_DIR/);
        const checked = await cli("doctor");
        assert.equal(checked.code, 1);
        assert.equal(checked.err, "");
        assert.match(checked.out, /service is running\s+Something that is not a Vigile service answers/);
        assert.doesNotMatch(checked.out, /admin key works|NaN|undefined/);
        assert.deepEqual(plain.seen.map((request) => [request.asked, request.authorization]), [["GET /health", undefined], ["GET /health", undefined]]);
      } finally {
        await plain.close();
      }
    } finally {
      await listener.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("is not taken for the service while the service runs elsewhere, whatever it answers: no JSON, another shape, a redirect, another name, nothing at all", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-elsewhere-"));
    const config = join(directory, "config.toml");
    const port = await freePort();
    initConfig(config, { name: "elsewhere-test", port });
    // The service of this config runs, and holds its data folder, on a port that was given for this run only.
    const elsewhere = await freePort();
    const service = await startService({ loaded: loadConfig(config, { VIGILE_LISTEN_PORT: String(elsewhere) }), log: () => {}, warn: () => {} });
    const cli = (...args: string[]) => run([...args, "--config", config]);
    const unsent = (listener: { seen: Array<{ asked: string; authorization: string | undefined; body: string }> }, what: string) => {
      assert.ok(listener.seen.length > 0, what);
      assert.deepEqual([...new Set(listener.seen.map((request) => request.asked))], ["GET /health"], what);
      assert.ok(listener.seen.every((request) => request.authorization === undefined && request.body === ""), `${what}: no Authorization header, and nothing else`);
    };
    try {
      const answers: Array<[what: string, answer: (response: ServerResponse) => void, says: RegExp]> = [
        ["no JSON", (response) => response.end("<html>Welcome</html>"), /What answers at \S+ is not a Vigile service: its answer to GET \/health is not JSON\./],
        ["JSON of another shape", (response) => response.end('{"status":"ok","name":"elsewhere-test"}'), /is not a Vigile service: its answer to GET \/health is not the one a Vigile service gives\./],
        ["JSON that is no object", (response) => response.end("null"), /its answer to GET \/health is not the one a Vigile service gives\./],
        ["an error", (response) => void ((response.statusCode = 404), response.end(health("elsewhere-test"))), /is not a Vigile service: it answers GET \/health with status 404\./],
        // Followed, the redirect would lead to the real service, whose answer is the right one.
        ["a redirect", (response) => void ((response.statusCode = 307), response.setHeader("location", `http://127.0.0.1:${elsewhere}/health`), response.end()), /is not a Vigile service: it sends GET \/health on to http:\/\/127\.0\.0\.1:\d+\/health\./],
        ["another name", (response) => response.end(health("someone\u001b[2K-else")), /The Vigile service at \S+ calls itself "someone\ufffd\[2K-else", and this config calls its service "elsewhere-test"\./],
      ];
      for (const [what, answer, says] of answers) {
        const listener = await stranger(port, (_request, response) => answer(response));
        try {
          for (const command of [["list-tasks"], ["user", "list"], ["user", "reset-key", "agent1"], ["config", "set", "auth.keyless_user", "nobody"]]) {
            const result = await cli(...command);
            assert.equal(result.code, 1, `${what}: ${command.join(" ")}`);
            assert.match(result.err, says, `${what}: ${command.join(" ")}`);
            assert.match(result.err, /Nothing was sent to it, and no key\./);
          }
          assert.equal(JSON.parse((await cli("list-tasks", "--json")).err).error.code, "not_this_service", what);
          const doctor = await cli("doctor", "--json");
          assert.equal(doctor.err, "", `${what}: the doctor does not crash`);
          const report = JSON.parse(doctor.out) as { ok: boolean; checks: Array<{ section: string; level: string; title: string; detail: string; fix: string }> };
          const checks = report.checks.filter((c) => c.section === "Service");
          assert.deepEqual(checks.map((c) => [c.title, c.level]), [["service is running", "fail"]], what);
          assert.match(checks[0]!.detail, says, what);
          assert.ok(checks[0]!.fix.length > 0, what);
          unsent(listener, what);
          // The setting that could not be asked about was not written: the service may well run.
          assert.equal(loadConfig(config, {}).config.auth.keyless_user, "agent1", what);
        } finally {
          await listener.close();
        }
      }

      // An answer that never ends, and one that never begins, are waited for only so long. With the usual wait
      // a command would take a quarter of a minute here, so who answers is asked directly.
      const loaded = loadConfig(config, {});
      for (const [what, answer] of [
        ["never ends", (response: ServerResponse) => void response.write('{"status":"ok",')],
        ["never begins", () => {}],
      ] as Array<[string, (response: ServerResponse) => void]>) {
        const listener = await stranger(port, (_request, response) => answer(response));
        try {
          const began = Date.now();
          const reached = await whoAnswers(loaded, 1000);
          assert.ok(Date.now() - began < 5000, what);
          assert.equal(reached.ok, false, what);
          // The service of this config holds its data, so this is taken for it: a service that does not answer,
          // said as of any request that gets no answer, and nothing can have been changed.
          assert.ok(!reached.ok && reached.why === "silent" && reached.error instanceof NoAnswerError && !reached.error.change, what);
          assert.match(!reached.ok ? reached.error.message : "", /^The service at http:\S+ did not answer within 1 seconds\. It was asked who it is, and nothing else was sent to it\. Nothing was changed: the call only reads\.$/, what);
          // The commands say the same, with the time they were given, and do nothing in the service's place: no
          // setting is written unasked, and the doctor names the service that holds the data and does not answer.
          const lines: string[] = [];
          const ui = { fancy: false, paint: (_style: unknown, text: string) => text, out: (line = "") => void lines.push(line), err: (line = "") => void lines.push(line) } as Ui;
          await assert.rejects(user(parseArgs(["list", "--config", config]), ui, 300), (error) => error instanceof NoAnswerError && !error.change && /did not answer within 0\.3 seconds\. It was asked who it is/.test(error.message), what);
          await assert.rejects(configCommand(parseArgs(["set", "auth.keyless_user", "nobody", "--config", config]), ui, 300), (error) => error instanceof NoAnswerError && /auth\.keyless_user was not changed/.test(error.advice![0]!), what);
          assert.equal(loadConfig(config, {}).config.auth.keyless_user, "agent1", what);
          assert.deepEqual(lines, [], what);
          assert.equal(await doctor(parseArgs(["--json", "--config", config]), ui, 300), 1);
          const check = (JSON.parse(lines.join("\n")) as { checks: Array<{ section: string; title: string; level: string; detail: string; fix: string }> }).checks.filter((c) => c.section === "Service");
          assert.deepEqual(check.map((c) => [c.title, c.level, c.detail]), [["service is running", "fail", `http://127.0.0.1:${port} takes the connection and does not answer`]], what);
          assert.match(check[0]!.fix, /^A Vigile service \(process \d+\) holds the data folder but does not answer at http:\S+; stop it, then start it again\.$/, what);
          unsent(listener, what);
        } finally {
          await listener.close();
        }
      }
      // An answer that goes on and on is not read to its end, which it does not have.
      const flood = await stranger(port, (_request, response) => {
        const more = () => {
          while (!response.destroyed && response.write("x".repeat(64 * 1024))) {}
          if (!response.destroyed) response.once("drain", more);
        };
        more();
      });
      try {
        const reached = await whoAnswers(loaded, 20_000);
        assert.match(!reached.ok ? reached.error.message : "", /its answer to GET \/health goes on where that of a Vigile service ends/);
      } finally {
        await flood.close();
      }

      // What says of itself what the service would, while the service holds its folder, is believed: that much
      // a stranger would need. Its redirect is still not followed, so the request and the key go no further.
      const onward = await freePort();
      const further = await stranger(onward, (_request, response) => response.end("{}"));
      const redirecting = await stranger(port, (request, response) => {
        if (request.url === "/health") return void response.end(health("elsewhere-test"));
        response.statusCode = 307;
        response.setHeader("location", `http://127.0.0.1:${onward}${request.url}`);
        response.end();
      });
      try {
        const result = await cli("create-project", "--title", "Sent on", "--prefix", "ON");
        assert.equal(result.code, 1);
        assert.match(result.err, /http:\S+\/api\/create-project answered with a redirect \(307\) to http:\/\/127\.0\.0\.1:\d+\/api\/create-project, which the command line does not follow\./);
        assert.deepEqual(further.seen, [], "nothing followed the redirect");
      } finally {
        await redirecting.close();
        await further.close();
      }

      // The doctor does not read on in what such a listener says of itself where a service's status is asked for.
      const shallow = await stranger(port, (request, response) => response.end(request.url === "/health" ? health("elsewhere-test") : '{"status":"ok","name":"elsewhere-test"}'));
      try {
        const doctor = await cli("doctor", "--json");
        assert.equal(doctor.err, "", "the doctor does not crash");
        const checks = (JSON.parse(doctor.out) as { checks: Array<{ section: string; level: string; title: string; detail: string }> }).checks.filter((c) => c.section === "Service");
        assert.deepEqual(checks.map((c) => [c.title, c.level]), [["service is running", "fail"]]);
        assert.match(checks[0]!.detail, /answered GET \/api\/admin\/status, but not as a Vigile service does/);
      } finally {
        await shallow.close();
      }

      // The service itself, reached where it listens, is called as ever, by its admin and by a user without a key.
      const there = { VIGILE_LISTEN_PORT: String(elsewhere) };
      assert.equal((await run(["create-project", "--title", "Here", "--prefix", "HER", "--config", config], there)).code, 0);
      assert.match((await run(["list-projects", "--as", "agent1", "--config", config], there)).out, /HER\s+open/);
      assert.equal((await run(["doctor", "--config", config], there)).err, "");
      // A command that goes by another data folder than the one the service holds takes it for a service of
      // other data, and says how it may be this config's all the same.
      const otherData = await run(["list-projects", "--config", config], { ...there, VIGILE_DATA_DIR: join(directory, "other-data") });
      assert.equal(otherData.code, 1);
      assert.match(otherData.err, /A Vigile service that calls itself "elsewhere-test" answers at \S+, and it is not the service of this config: no service holds the data folder \S+other-data\./);
      assert.match(otherData.err, /If it is this config's service, it runs on another data folder/);
      // Under a new name in the config it still goes by the old one until it is started again, and is not called.
      const renamed = await cli("config", "set", "name", "renamed");
      assert.match(renamed.out, /Restart the service for this to take effect\. Until then the commands that call the service refuse to: it still goes by its old name\./);
      const refused = await run(["list-projects", "--config", config], there);
      assert.equal(refused.code, 1);
      assert.match(refused.err, /The Vigile service at \S+ calls itself "elsewhere-test", and this config calls its service "renamed"\. Nothing was sent to it, and no key\./);
      assert.match(refused.err, /If the name was changed after the service started \(vigile config set name\), or given for one run \(serve --name, VIGILE_NAME\), stop the service and start it again, or run this command with the same VIGILE_NAME\./);
      assert.match(refused.err, /If not, another instance has the port: give each its own listen\.port\./);
      assert.match((await run(["list-projects", "--config", config], { ...there, VIGILE_NAME: "elsewhere-test" })).out, /HER\s+open/, "given the name the service was started with, the command calls it");
    } finally {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not stand in the way of a service on another machine, or of one from before the data folder was held by the system", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-far-"));
    const config = join(directory, "config.toml");
    const port = await freePort();
    initConfig(config, { name: "far-test", port });
    const service = await startService({ loaded: loadConfig(config, {}), log: () => {}, warn: () => {} });
    try {
      // A config that names the same address and has no data here: on this machine that is another instance's
      // port. Were the address another machine's, the answer would be all there is to go by, as it was before.
      mkdirSync(join(directory, "copy"));
      const copy = join(directory, "copy", "config.toml");
      initConfig(copy, { name: "far-test", port });
      assert.match((await run(["config", "set", "data_dir", "elsewhere", "--config", copy])).out, /Restart the service for this to take effect\. Until then the commands that call the service refuse to: it still holds the data folder it was started on\./);
      assert.match((await run(["config", "set", "log_level", "quiet", "--config", copy])).out, /Restart the service for this to take effect\.\n/);
      const far = async () => false;
      const here = await whoAnswers(loadConfig(copy, {}), 5000);
      assert.ok(!here.ok && here.error instanceof NotReachedError && here.error.code === "not_running");
      assert.deepEqual(await whoAnswers(loadConfig(copy, {}), 5000, far), { ok: true, name: "far-test", version: "0.1.0" });
      const other = await whoAnswers(loadConfig(copy, { VIGILE_NAME: "near-test" }), 5000, far);
      assert.match(!other.ok ? other.error.message : "", /calls itself "far-test", and this config calls its service "near-test"/);
      const nothing = await whoAnswers(loadConfig(copy, { VIGILE_LISTEN_PORT: String(await freePort()) }), 5000, far);
      assert.ok(!nothing.ok && nothing.why === "nothing" && !(nothing.error instanceof NotReachedError));
      assert.match(!nothing.ok ? nothing.error.message : "", /No Vigile service answers at/);

      // Which addresses are this machine's, however they are written; 192.0.2.1 is an address kept for examples.
      for (const address of ["127.0.0.1", "127.8.9.10", "::1", "[::1]", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "0.0.0.0", "::", "localhost", "LOCALHOST."]) {
        assert.equal(await onThisMachine(address), true, address);
      }
      for (const address of ["192.0.2.1", "::ffff:192.0.2.1", "2001:db8::1"]) assert.equal(await onThisMachine(address), false, address);
    } finally {
      await service.stop();
    }

    // A service from before the folder was held by a lock of the system left only its process number, and that
    // process lives: here it is this test. What then answers as the service of this config is called.
    const old = join(directory, "old");
    mkdirSync(join(old, "data"), { recursive: true });
    const oldConfig = join(old, "config.toml");
    initConfig(oldConfig, { name: "old-test", port });
    writeFileSync(join(old, "data", "vigile.lock"), `${process.pid}\n`);
    const earlier = await stranger(port, (request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(request.url === "/health" ? health("old-test") : JSON.stringify({ projects: [] }));
    });
    try {
      const result = await run(["list-projects", "--json", "--config", oldConfig]);
      assert.equal(result.code, 0, result.err);
      assert.deepEqual(JSON.parse(result.out), { projects: [] });
      assert.deepEqual(earlier.seen.map((request) => [request.asked, request.authorization === undefined]), [["GET /health", true], ["POST /api/list-projects", false]]);
    } finally {
      await earlier.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("has the command line do by itself what it would ask of the service only when it is certain that no service runs on the config's data: its lock is free", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-alone-"));
    const config = join(directory, "config.toml");
    const data = join(directory, "data");
    const port = await freePort();
    initConfig(config, { name: "alone-test", port });
    mkdirSync(data);
    const json = (response: ServerResponse, body: unknown, status = 200): void => {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
    };
    // What is at the address, and whether a process holds the data folder: each a failure of its own kind.
    type Listens = ((request: IncomingMessage, response: ServerResponse) => void) | null;
    const asItself: Listens = (request, response) => json(response, request.url === "/health" ? { status: "ok", name: "alone-test", version: "0.1.0" } : { users: [] });
    const notVigile: Listens = (_request, response) => void response.end("<html>Welcome</html>");
    const silent: Listens = () => {};
    const otherName: Listens = (_request, response) => json(response, { status: "ok", name: "another", version: "0.1.0" });
    const sendsOn: Listens = (_request, response) => void ((response.statusCode = 307), response.setHeader("location", "http://127.0.0.1:9/"), response.end());
    const refuses =
      (status: number, code: string): Listens =>
      (request, response) =>
        request.url === "/health" ? json(response, { status: "ok", name: "alone-test", version: "0.1.0" }) : json(response, { error: { code, message: "Refused." } }, status);
    const root = process.getuid?.() === 0;
    const kinds: Array<{ what: string; listens: Listens; held: boolean; unreadable?: true; writes: { key: boolean; setting: boolean }; says: RegExp }> = [
      // No service runs on this data: nothing was sent to anyone, and the folder's lock is free.
      { what: "nothing answers, and nothing holds the data", listens: null, held: false, writes: { key: true, setting: true }, says: /^$/ },
      { what: "something that says it is this service answers, and nothing holds the data", listens: asItself, held: false, writes: { key: true, setting: true }, says: /^$/ },
      { what: "something that is no Vigile service answers, and nothing holds the data", listens: notVigile, held: false, writes: { key: true, setting: true }, says: /^$/ },
      { what: "something takes the connection and says nothing, and nothing holds the data", listens: silent, held: false, writes: { key: true, setting: true }, says: /^$/ },
      // A process holds the data: a service may run, whatever is or is not at the address.
      { what: "nothing answers, and a process holds the data", listens: null, held: true, writes: { key: false, setting: false }, says: /^A process holds the data folder \S+: the service of this config runs at another address than the config names or is starting, or a backup is being restored\. Nothing was written in the service's place\.$/ },
      { what: "a service of another name answers, and a process holds the data", listens: otherName, held: true, writes: { key: false, setting: false }, says: /calls itself "another", and this config calls its service "alone-test"/ },
      { what: "something that is no Vigile service answers, and a process holds the data", listens: notVigile, held: true, writes: { key: false, setting: false }, says: /is not a Vigile service: its answer to GET \/health is not JSON/ },
      { what: "a redirect is answered, and a process holds the data", listens: sendsOn, held: true, writes: { key: false, setting: false }, says: /is not a Vigile service: it sends GET \/health on to/ },
      { what: "the service takes the connection and does not answer", listens: silent, held: true, writes: { key: false, setting: false }, says: /did not answer within 0\.3 seconds\. It was asked who it is/ },
      { what: "the service refuses, and not the key", listens: refuses(403, "forbidden"), held: true, writes: { key: false, setting: false }, says: /^Refused\.$/ },
      { what: "the service fails", listens: refuses(500, "internal"), held: true, writes: { key: false, setting: false }, says: /^Refused\.$/ },
      // The one refusal that has the admin key replaced past the service: the service's own, of the key. The
      // setting is the service's to check, and is not written unasked while it runs.
      { what: "the service refuses the key", listens: refuses(401, "unauthorized"), held: true, writes: { key: true, setting: false }, says: /^Refused\.$/ },
      // Whether a process holds the data cannot be told: that is not the same as none holding it.
      ...(root
        ? []
        : ([
            { what: "nothing answers, and the data folder cannot be looked into", listens: null, held: false, unreadable: true, writes: { key: false, setting: false }, says: /^Whether a service runs on this config's data cannot be told: the data folder \S+ cannot be taken \(.+\)\. Nothing was written in the service's place\.$/ },
            { what: "something answers, and the data folder cannot be looked into", listens: asItself, held: false, unreadable: true, writes: { key: false, setting: false }, says: /^Whether a service runs on this config's data cannot be told: the data folder \S+ cannot be taken/ },
          ] as const)),
    ];
    try {
      const bytes = readFileSync(config);
      for (const kind of kinds) {
        const listener = kind.listens ? await stranger(port, kind.listens) : null;
        const release = kind.held ? holdFolder(data) : null;
        assert.ok(!kind.held || release, kind.what);
        if (kind.unreadable) chmodSync(data, 0o000);
        try {
          const commands: Array<[name: "key" | "setting", run: (ui: Ui) => Promise<void>]> = [
            ["key", (ui) => user(parseArgs(["reset-key", "admin", "--json", "--config", config]), ui, 300)],
            ["setting", (ui) => configCommand(parseArgs(["set", "auth.keyless_user", "user", "--json", "--config", config]), ui, 300)],
          ];
          for (const [name, command] of commands) {
            const lines: string[] = [];
            const ui = { fancy: false, paint: (_style: unknown, text: string) => text, out: (line = "") => void lines.push(line), err: (line = "") => void lines.push(line) } as Ui;
            const failed = await command(ui).then(
              () => null,
              (error: unknown) => error as Error,
            );
            const where = `${kind.what}: the ${name}`;
            if (kind.writes[name]) {
              assert.equal(failed, null, `${where}: ${failed?.message}`);
              assert.ok(!readFileSync(config).equals(bytes), `${where} is written`);
              const now = loadConfig(config, {}).config.auth;
              if (name === "key") assert.equal((JSON.parse(lines.join("\n")) as { api_key: string }).api_key, now.keys.admin, where);
              else assert.equal(now.keyless_user, "user", where);
            } else {
              assert.ok(failed, `${where}: the command fails`);
              assert.match(failed.message, kind.says, where);
              assert.ok(readFileSync(config).equals(bytes), `${where}: the config file is, byte for byte, as it was`);
              assert.deepEqual(lines, [], `${where}: nothing is printed, no key and no word of success`);
            }
            writeFileSync(config, bytes);
          }
          // Whatever was at the address was asked who it is, and got no key.
          for (const request of listener?.seen ?? []) assert.ok(request.authorization === undefined || kind.held, `${kind.what}: ${request.asked}`);
        } finally {
          if (kind.unreadable) chmodSync(data, 0o700);
          release?.();
          await listener?.close();
        }
      }
      // An address of another machine, and a name that leads nowhere: no data folder here says whether the
      // service runs there. That nothing answers is then not that none runs, and nothing is done in its place.
      // Nor after a failure that may have left a request behind, or any other: each is thrown on as it is.
      const lost = new NotRunningError("http://192.0.2.1:1");
      const acted = async (loaded: ReturnType<typeof loadConfig>, error: unknown): Promise<unknown> => inTheServicesPlace(loaded, error, () => "acted").catch((thrown: unknown) => thrown);
      assert.equal(await acted(loadConfig(config, {}), lost), "acted", "here, with the folder to be had, it is done");
      assert.equal(await acted(loadConfig(config, { VIGILE_LISTEN_ADDRESS: "192.0.2.1" }), lost), lost);
      assert.equal(await acted(loadConfig(config, { VIGILE_LISTEN_ADDRESS: "no-such-machine.invalid" }), lost), lost);
      const noAnswer = new NoAnswerError("http://x", "No answer.", true);
      assert.equal(await acted(loadConfig(config, {}), noAnswer), noAnswer);
      const other = new Error("anything else");
      assert.equal(await acted(loadConfig(config, {}), other), other);
      assert.equal(new NotReachedError("http://x", "Not reached.", [], "not_running") instanceof NotRunningError, false, "what was not reached is not a service that is not running");
      // Nothing answered a moment ago, and a process has the folder now: it is not looked at, it is taken, or not.
      const meanwhile = holdFolder(data);
      assert.ok(meanwhile);
      const refused = await acted(loadConfig(config, {}), lost);
      meanwhile();
      assert.ok(refused instanceof NotReachedError && /^A process holds the data folder/.test(refused.message), String(refused));
      // The folder is held for as long as what is done takes, also when that fails, and is let go then.
      await assert.rejects(
        inTheServicesPlace(loadConfig(config, {}), lost, () => {
          assert.equal(holdFolder(data), null, "held while it is done");
          throw new Error("the write failed");
        }),
        /the write failed/,
      );
      const again = holdFolder(data);
      assert.ok(again, "and let go when it failed");
      again();
    } finally {
      chmodSync(data, 0o700);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("what the command line writes in the service's place", () => {
  // The two things it does by itself when no service runs: a new admin key, and a setting the service would check.
  type InPlace = (config: string, ui: Ui, taken?: () => unknown) => Promise<void>;
  const commands: Array<[what: string, args: string[], inProcess: InPlace, written: (config: string, before: Buffer) => boolean]> = [
    ["a new admin key", ["user", "reset-key", "admin"], (config, ui, taken) => user(parseArgs(["reset-key", "admin", "--json", "--config", config]), ui, 300, taken), (config, before) => !readFileSync(config).equals(before)],
    ["a setting written unasked", ["config", "set", "auth.keyless_user", "user"], (config, ui, taken) => configCommand(parseArgs(["set", "auth.keyless_user", "user", "--json", "--config", config]), ui, 300, taken), (config) => loadConfig(config, {}).config.auth.keyless_user === "user"],
  ];
  const quiet = (): Ui => ({ fancy: false, paint: (_style, text) => text, out: () => {}, err: () => {} });
  const fresh = async (name: string): Promise<{ directory: string; config: string; data: string; port: number }> => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-place-"));
    const config = join(directory, "config.toml");
    const port = await freePort();
    initConfig(config, { name, port });
    return { directory, config, data: join(directory, "data"), port };
  };
  /** A real service on the config, once it answers; `at` is the port it listens on when that is not the config's. */
  const serving = async (config: string, port: number, at?: number): Promise<ChildProcess> => {
    const child = spawn(process.execPath, [BIN, "serve", "--config", config], { stdio: "ignore", env: { PATH: process.env.PATH ?? "", ...(at ? { VIGILE_LISTEN_PORT: String(at) } : {}) } });
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await fetch(`http://127.0.0.1:${at ?? port}/health`).then((answer) => answer.ok, () => false)) return child;
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    child.kill("SIGKILL");
    throw new Error("the service did not start");
  };
  const stopped = async (child: ChildProcess): Promise<void> => {
    const gone = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await gone;
  };
  const refusedBy = /Another Vigile process is using \S+: a service that is starting, a restore of a backup, or a command that is writing the config while no service runs\.\n\s+→ A command is done in a moment: start the service again\./;

  it("is written with the data folder held from before the first byte to after the last: a service that is started meanwhile is refused, and starts on what was written once the command is done", async () => {
    for (const [what, args, inProcess, written] of commands) {
      const { directory, config, data, port } = await fresh("place-test");
      let child: ChildProcess | undefined;
      try {
        const before = readFileSync(config);
        assert.equal(existsSync(data), false, "a config that was made and never served has no data folder");
        // The command is held where it has taken the folder and has written nothing yet.
        let arrived!: () => void;
        let letGo!: () => void;
        const there = new Promise<void>((resolve) => (arrived = resolve));
        const gate = new Promise<void>((resolve) => (letGo = resolve));
        const lines: string[] = [];
        const ui: Ui = { ...quiet(), out: (line = "") => void lines.push(line) };
        const command = inProcess(config, ui, () => {
          arrived();
          return gate;
        });
        await there;
        assert.ok(readFileSync(config).equals(before), `${what}: nothing is written yet`);
        // The folder is made, as by a first start, and holds nothing but the file the lock is on and what the lock keeps beside it while it is held.
        assert.deepEqual(readdirSync(data).filter((name) => name !== "vigile.hold-journal"), ["vigile.hold"], what);
        assert.ok(folderIsHeld(data), `${what}: the folder is held`);
        // A real service, started now on the same config, does not get the folder, and says what has it: not
        // a service. Nor does a second command that would write in the service's place.
        const meanwhile = await run(["serve", "--config", config]);
        assert.equal(meanwhile.code, 1, `${what}: ${meanwhile.out}`);
        assert.match(meanwhile.err, refusedBy, what);
        assert.doesNotMatch(meanwhile.err, /Another Vigile service/, what);
        assert.equal(JSON.parse((await run(["serve", "--json", "--config", config])).err).error.code, "cannot_start", what);
        const second = await run([...args, "--config", config]);
        assert.equal(second.code, 1, what);
        assert.match(second.err, /A process holds the data folder \S+: .*Nothing was written in the service's place\./, what);
        assert.ok(readFileSync(config).equals(before), `${what}: still nothing is written`);
        // The command goes on, writes, and lets the folder go.
        letGo();
        await command;
        assert.ok(written(config, before), `${what} is written`);
        assert.equal(folderIsHeld(data), false, `${what}: the folder is let go`);
        assert.deepEqual(readdirSync(data), ["vigile.hold"], `${what}: what is left is what a first start of the service leaves`);
        const after = readFileSync(config);
        // The service is started again and has what the command wrote.
        child = await serving(config, port);
        assert.ok(readFileSync(config).equals(after), what);
        const listed = await run(["list-users", "--json", "--config", config]);
        assert.equal(listed.code, 0, `${what}: the key in the file is the service's: ${listed.err}`);
        const you = (await (await fetch(`http://127.0.0.1:${port}/api/instance`)).json()) as { you: { username: string } };
        assert.equal(you.you.username, loadConfig(config, {}).config.auth.keyless_user, what);
      } finally {
        if (child) await stopped(child);
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("is held back by the config file's own lock with the data folder already taken: a service started during that wait is refused", async () => {
    for (const [what, args, , written] of commands) {
      const { directory, config, data } = await fresh("wait-test");
      try {
        const before = readFileSync(config);
        // Someone is changing the config and does not finish: the command's write waits for that.
        const busy = holdFile(`${config}.hold`);
        assert.ok(busy);
        const command = run([...args, "--json", "--config", config]);
        // It waits with the folder in its hands, not before it has it.
        for (let attempt = 0; attempt < 100 && !(existsSync(data) && folderIsHeld(data)); attempt++) await new Promise((resolve) => setTimeout(resolve, 30));
        assert.ok(existsSync(data) && folderIsHeld(data), `${what}: the data folder is held while the write waits for the config file`);
        const meanwhile = await run(["serve", "--config", config]);
        assert.equal(meanwhile.code, 1, `${what}: a service started during the wait: ${meanwhile.out}`);
        assert.match(meanwhile.err, refusedBy, what);
        assert.ok(readFileSync(config).equals(before), what);
        busy();
        const done = await command;
        assert.equal(done.code, 0, `${what}: ${done.err}`);
        assert.ok(written(config, before), `${what} is written`);
        assert.equal(folderIsHeld(data), false, what);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
    // A config file that stays busy: the write gives up, nothing is written, and the folder is let go.
    const { directory, config, data } = await fresh("busy-test");
    try {
      const before = readFileSync(config);
      const busy = holdFile(`${config}.hold`);
      assert.ok(busy);
      const gaveUp = await run(["user", "reset-key", "admin", "--json", "--config", config]);
      busy();
      assert.equal(gaveUp.code, 1);
      assert.equal(JSON.parse(gaveUp.err).error.code, "config_busy");
      assert.ok(readFileSync(config).equals(before));
      assert.equal(folderIsHeld(data), false, "the folder is let go when the write fails");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("is not written while a service holds the data folder: the service was there first, and the config file is, byte for byte, as it was", async () => {
    const { directory, config, data, port } = await fresh("first-test");
    // The service listens on a port given for this run: at the config's address nothing answers.
    const child = await serving(config, port, await freePort());
    try {
      const before = readFileSync(config);
      for (const [what, args, inProcess] of commands) {
        await assert.rejects(inProcess(config, quiet()), (error) => error instanceof NotReachedError && /^A process holds the data folder \S+: /.test(error.message), what);
        const result = await run([...args, "--json", "--config", config]);
        assert.equal(result.code, 1, what);
        assert.equal(result.out, "", what);
        const report = JSON.parse(result.err).error as { code: string; message: string };
        assert.equal(report.code, "not_running", what);
        assert.match(report.message, /^A process holds the data folder \S+: /, what);
        assert.ok(readFileSync(config).equals(before), `${what}: the config file is as it was`);
      }
      assert.ok(folderIsHeld(data), "the service has the folder still");
      // Once the service has stopped and let the folder go, no service runs, and the command line acts.
      await stopped(child);
      const alone = await run(["user", "reset-key", "admin", "--json", "--config", config]);
      assert.equal(alone.code, 0, alone.err);
      assert.equal(JSON.parse(alone.out).api_key, loadConfig(config, {}).config.auth.keys.admin);
    } finally {
      if (child.exitCode === null) await stopped(child);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("looks for a service from before the folder was held by a lock of the system first, and leaves a folder that was never held as it finds it when such a one may run", async () => {
    // A live process named in the lock file of a folder that was never held the new way: here the process that
    // runs the tests. A service from before may be using the folder, and is not kept out by the system's lock.
    const legacy = await fresh("legacy-test");
    try {
      mkdirSync(legacy.data);
      writeFileSync(join(legacy.data, "vigile.lock"), `${process.ppid}\n`);
      const before = readFileSync(legacy.config);
      for (const [what, args, inProcess] of commands) {
        await assert.rejects(inProcess(legacy.config, quiet()), (error) => error instanceof NotReachedError && new RegExp(`^A Vigile service from before this version may be using \\S+ \\(process ${process.ppid}\\)\\. Nothing was written in the service's place\\.$`).test(error.message), what);
        const result = await run([...args, "--config", legacy.config]);
        assert.equal(result.code, 1, what);
        assert.match(result.err, /Stop that service first\.\n\s+→ If no such service is running, the file \S+vigile\.lock was left behind by one that was killed: remove it\./, what);
        assert.ok(readFileSync(legacy.config).equals(before), what);
      }
      // The folder is as it was: never held the new way, so that the number in the lock file goes on counting.
      assert.deepEqual(readdirSync(legacy.data), ["vigile.lock"]);
      assert.equal(everHeld(legacy.data), false);
      const start = await run(["serve", "--config", legacy.config]);
      assert.match(start.err, /A Vigile service from before this version may be using/);
    } finally {
      rmSync(legacy.directory, { recursive: true, force: true });
    }
    // A number left behind by a service that is gone keeps nobody out, as at a start of the service: the command
    // line acts, the file with the number is left as it is, and the folder is held the new way from then on.
    const left = await fresh("left-test");
    try {
      const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await new Promise((resolve) => gone.once("exit", resolve));
      mkdirSync(left.data);
      writeFileSync(join(left.data, "vigile.lock"), `${gone.pid}\n`);
      const done = await run(["config", "set", "auth.keyless_user", "user", "--json", "--config", left.config]);
      assert.equal(done.code, 0, done.err);
      assert.equal(loadConfig(left.config, {}).config.auth.keyless_user, "user");
      assert.deepEqual(readdirSync(left.data).sort(), ["vigile.hold", "vigile.lock"]);
      assert.equal(readFileSync(join(left.data, "vigile.lock"), "utf8"), `${gone.pid}\n`);
      assert.equal(folderIsHeld(left.data), false);
    } finally {
      rmSync(left.directory, { recursive: true, force: true });
    }
  });
});

describe("a service that answers in another shape than a Vigile service does", () => {
  type Swap = { status?: number; type?: string; body: string; headers?: Record<string, string> } | { change(real: any): unknown };
  type Check = { section: string; level: string; title: string; detail?: string; fix?: string };
  let directory: string;
  let config: string;
  let service: Service;
  let front: Awaited<ReturnType<typeof stranger>>;
  let port: number;
  /** What is answered in the service's place, or made of its answer, for the request that is asked for. */
  let swap: (asked: string, body: string) => Swap | undefined = () => undefined;
  /** Headers that a request is passed on with, in place of its own: the name it calls the service by, or where it says it is from. */
  let dress: Record<string, string> = {};
  const cli = (...args: string[]) => run([...args, "--config", config]);
  const STATUS = "GET /api/admin/status";
  const USERS = "POST /api/list-users";
  const LAST = "auth is off for non-admin users";
  /** The doctor's checks of the service, as it reports them. */
  const examine = async (): Promise<{ code: number; checks: Check[] }> => {
    const lines: string[] = [];
    const ui = { fancy: false, paint: (_style: unknown, text: string) => text, out: (line = "") => void lines.push(line), err: (line = "") => void lines.push(line) } as Ui;
    const code = await doctor(parseArgs(["--json", "--config", config]), ui);
    return { code, checks: (JSON.parse(lines.join("\n")) as { checks: Check[] }).checks.filter((check) => check.section === "Service") };
  };
  const titles = (checks: Check[]) => checks.map((check) => check.title);
  const of = (checks: Check[], title: string) => checks.find((check) => check.title === title);
  const answering = (asked: string, instead: Swap) => {
    swap = (request) => (request === asked ? instead : undefined);
  };
  const json = (value: unknown, status = 200): Swap => ({ status, body: JSON.stringify(value) });
  /** A failure that was reported as one, and not as the place in the code where it happened. */
  const reported = (result: { code: number; out: string; err: string }, says: RegExp, what: string) => {
    assert.equal(result.code, 1, `${what}: ${result.err}`);
    assert.match(result.err, says, what);
    assert.doesNotMatch(result.err, /^\s+at .+:\d+:\d+\)?$/m, `${what}: no line of the code`);
    assert.doesNotMatch(result.err, /TypeError|RangeError|node:internal|Unhandled/, what);
    assert.equal(result.out, "", `${what}: nothing of the answer is printed`);
  };

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), "vigile-shape-"));
    config = join(directory, "config.toml");
    port = await freePort();
    initConfig(config, { name: "shape-test", port });
    // The service holds its data folder and listens on a port given for this run. Where the config says it is,
    // something passes every request on to it and every answer back, but for the one that is being tried.
    const behind = await freePort();
    service = await startService({ loaded: loadConfig(config, { VIGILE_LISTEN_PORT: String(behind) }), log: () => {}, warn: () => {} });
    await service.engine.execute("create_project", "admin", { title: "Shapes", prefix: "SHP" });
    await service.engine.execute("create_task", "admin", { title: "One task", description: "A task to show.", project: "SHP" });
    await service.engine.execute("create_task", "admin", { title: "Another task", description: "A task to link.", project: "SHP" });
    front = await stranger(port, (request, response) => {
      const parts: Buffer[] = [];
      request.on("data", (part: Buffer) => parts.push(part));
      request.on("end", () => {
        void (async () => {
          const sent = Buffer.concat(parts);
          const instead = swap(`${request.method} ${request.url}`, sent.toString());
          if (instead && "body" in instead) {
            response.statusCode = instead.status ?? 200;
            response.setHeader("content-type", instead.type ?? "application/json");
            for (const [name, value] of Object.entries(instead.headers ?? {})) response.setHeader(name, value);
            return void response.end(instead.body);
          }
          const headers: Record<string, string> = {};
          for (const name of ["authorization", "content-type", "accept", "mcp-session-id", "mcp-protocol-version"]) {
            const value = request.headers[name];
            if (typeof value === "string") headers[name] = value;
          }
          const real = await new Promise<{ status: number; type: string; text: string }>((resolve, reject) => {
            const onward = httpRequest({ host: "127.0.0.1", port: behind, method: request.method, path: request.url, headers: { ...headers, ...dress, "content-length": String(sent.length) } }, (answer) => {
              const got: Buffer[] = [];
              answer.on("data", (part: Buffer) => got.push(part));
              answer.on("end", () => resolve({ status: answer.statusCode ?? 0, type: String(answer.headers["content-type"] ?? "application/json"), text: Buffer.concat(got).toString() }));
              answer.on("error", reject);
            });
            onward.on("error", reject);
            onward.end(sent);
          });
          response.statusCode = real.status;
          response.setHeader("content-type", real.type);
          response.end(instead ? JSON.stringify(instead.change(JSON.parse(real.text))) : real.text);
        })().catch(() => response.destroy());
      });
    });
  });
  after(async () => {
    await front.close();
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });

  it("is told so by the doctor, check by check, whichever of its answers is wrong, and the doctor finishes its report", async () => {
    // Passed on untouched, every answer is read as it always was.
    swap = () => undefined;
    const whole = await examine();
    assert.deepEqual(whole.checks.filter((check) => check.level === "fail").map((check) => check.title), ["running settings match the config"], JSON.stringify(whole.checks));
    assert.match(whole.checks.find((check) => check.title === "running settings match the config")!.detail!, /^listen\.port: running with \d+, config says \d+$/);
    assert.equal(titles(whole.checks).at(-1), LAST);
    assert.match(whole.checks.find((check) => check.title === "graph is consistent")!.detail!, /^1 project, 2 tasks, 3 users, \d+ links?$/);

    // The status with one part of it of another kind: the doctor names the part, vouches for nothing, and asks
    // nothing further of what answered.
    const wrongStatus: Array<[what: string, change: (status: any) => unknown, says: RegExp]> = [
      ["inconsistencies as a text", (status) => ({ ...status, inconsistencies: "broken" }), /"inconsistencies" is not a list of texts/],
      ["inconsistencies of objects", (status) => ({ ...status, inconsistencies: [{ toString: 1 }] }), /"inconsistencies" is not a list of texts/],
      ["auth with nothing in it", (status) => ({ ...status, auth: {} }), /"auth\.keyless_user" is not a text/],
      ["auth without its users", (status) => ({ ...status, auth: { keyless_user: "agent1" } }), /"auth\.users_with_keys" is not a list of texts/],
      ["auth with users that are numbers", (status) => ({ ...status, auth: { ...status.auth, users_with_keys: [1, 2] } }), /"auth\.users_with_keys" is not a list of texts/],
      ["refused keys as a number", (status) => ({ ...status, auth: { ...status.auth, keys_of_someone_else: 5 } }), /"auth\.keys_of_someone_else" is not a list of texts/],
      ["auth as a list", (status) => ({ ...status, auth: [] }), /"auth" is not an object/],
      ["settings as a text", (status) => ({ ...status, settings: "all of them" }), /"settings" is not an object/],
      ["engine as a text", (status) => ({ ...status, engine: "fine" }), /"engine" is not an object/],
      ["counts as a list", (status) => ({ ...status, engine: { ...status.engine, counts: [3] } }), /"engine\.counts" is not an object/],
      ["a count that is an object", (status) => ({ ...status, engine: { ...status.engine, counts: { project: { toString: 1 } } } }), /"engine\.counts\.project" is not a number/],
      ["links as a text", (status) => ({ ...status, engine: { ...status.engine, links: "many" } }), /"engine\.links" is not a number/],
      ["listen as a text", (status) => ({ ...status, listen: "everywhere" }), /"listen" is not an object/],
      ["bound to this machine only, as a text", (status) => ({ ...status, listen: { loopback_only: "yes" } }), /"listen\.loopback_only" is not yes or no/],
      ["a code stamp that is a text", (status) => ({ ...status, code_stamp: "yesterday" }), /"code_stamp" is not a number/],
      ["a process number that is a text", (status) => ({ ...status, pid: "12" }), /"pid" is not a number/],
      ["no uptime", (status) => ({ ...status, uptime_s: undefined }), /"uptime_s" is not a number/],
      ["a config path that is a list", (status) => ({ ...status, config_path: ["/etc"] }), /"config_path" is not a text/],
      ["no data folder", (status) => ({ ...status, data_dir: null }), /"data_dir" is not a text/],
      ["a list", () => [], /the answer is not an object/],
      ["nothing", () => null, /the answer is not an object/],
    ];
    for (const [what, change, says] of wrongStatus) {
      answering(STATUS, { change });
      const { code, checks } = await examine();
      assert.equal(code, 1, what);
      assert.deepEqual(checks.map((check) => [check.title, check.level]), [["service is running", "fail"]], what);
      assert.match(checks[0]!.detail!, /answered GET \/api\/admin\/status, but not as a Vigile service does: /, what);
      assert.match(checks[0]!.detail!, says, what);
      assert.match(checks[0]!.fix!, /stop the service and start it again/, what);
    }
    // An answer that is no status at all, and a failure of the service's own, are not a key that does not work.
    for (const [what, instead, says] of [
      ["a page", { body: "<html>Welcome</html>", type: "text/html" }, /^shape-test 0\.1\.0 answers at http:\S+, and did not give its status: http:\S+ answered, but not as a Vigile service\.$/],
      ["a failure", json({ error: { code: "internal", message: "The service hit an unexpected error." } }, 500), /and did not give its status: The service hit an unexpected error\.$/],
      ["a failure that says nothing", json({ error: { message: { toString: 1 } } }, 500), /and did not give its status: no reason was given$/],
    ] as Array<[string, Swap, RegExp]>) {
      answering(STATUS, instead);
      const { checks } = await examine();
      assert.deepEqual(checks.map((check) => [check.title, check.level]), [["service is running", "fail"]], what);
      assert.match(checks[0]!.detail!, says, what);
    }
    // A key that is refused is still said to be that.
    answering(STATUS, json({ error: { code: "unauthorized", message: "The API key is not valid." } }, 401));
    const refused = await examine();
    assert.deepEqual(refused.checks.map((check) => [check.title, check.level, check.detail]), [["service is running", "ok", `shape-test 0.1.0 at http://127.0.0.1:${port}`], ["admin key works", "fail", "The API key is not valid."]]);

    // What an earlier service did not send may be absent, and is taken as it always was.
    answering(STATUS, {
      change: (status) => {
        const { inconsistencies: _i, engine: _e, auth: _a, listen: _l, ...rest } = status;
        return rest;
      },
    });
    const earlier = await examine();
    assert.equal(titles(earlier.checks).at(-1), LAST);
    assert.deepEqual([of(earlier.checks, "graph is consistent")?.level, of(earlier.checks, "graph is consistent")?.detail], ["ok", "0 projects, 0 tasks, 0 users, 0 links"]);
    assert.deepEqual([of(earlier.checks, "config users exist")?.level, of(earlier.checks, "config users exist")?.detail], ["ok", "1 user with a key"]);
    answering(STATUS, { change: (status) => ({ ...status, auth: { keyless_user: "agent1", users_with_keys: ["admin"] }, code_stamp: undefined, settings: undefined }) });
    const partly = await examine();
    assert.equal(titles(partly.checks).at(-1), LAST);
    assert.equal(of(partly.checks, "each key is its user's own"), undefined);
    assert.equal(of(partly.checks, "service runs the code on disk")?.level, "fail");
    assert.deepEqual([of(partly.checks, "running settings match the config")?.level, of(partly.checks, "running settings match the config")?.detail], ["fail", "the service does not say what settings it runs with"]);

    // Settings of any shape are compared without harm: names that every object answers to, values that cannot
    // be written out, and more differences than anyone reads.
    const many = Object.fromEntries(Array.from({ length: 300 }, (_unused, i) => [`extra_${i}`, "x".repeat(5000)]));
    answering(STATUS, { change: (status) => ({ ...status, settings: { ...status.settings, ...many, constructor: 5, listen: { port: { toString: 1 }, address: [[[]]] }, ["__proto__"]: { a: 1 } } }) });
    const odd = await examine();
    const settings = of(odd.checks, "running settings match the config")!;
    assert.equal(settings.level, "fail");
    assert.match(settings.detail!, /; and \d+ more$/);
    assert.ok(settings.detail!.length < 2000, `the differences are listed in ${settings.detail!.length} characters`);
    assert.equal(titles(odd.checks).at(-1), LAST);

    // The users: the check that needs them fails and says what answered wrongly; the checks after it are made.
    for (const [what, instead, says] of [
      ["users as a text", json({ users: "none" }), /the users could not be asked for: .*answered POST \/api\/list-users, but not as a Vigile service does: "users" is not a list of users/],
      ["users that are nothing", json({ users: [null] }), /"users" is not a list of users/],
      ["users without names", json({ users: [{ id: "USER-001", type: "admin" }] }), /"users" is not a list of users/],
      ["no answer to speak of", json(null), /"users" is not a list of users/],
      ["a page", { body: "<html>Users</html>", type: "text/html" }, /the users could not be asked for: .*answered, but not as a Vigile service\./],
      ["a failure", json({ error: { code: "internal", message: "The service hit an unexpected error.", blocking: 5, actions: 7 } }, 500), /the users could not be asked for: The service hit an unexpected error\./],
    ] as Array<[string, Swap, RegExp]>) {
      answering(USERS, instead);
      const { code, checks } = await examine();
      assert.equal(code, 1, what);
      assert.deepEqual([of(checks, "config users exist")?.level], ["fail"], what);
      assert.match(of(checks, "config users exist")!.detail!, says, what);
      assert.equal(of(checks, "MCP endpoint answers")?.level, "ok", what);
      assert.equal(of(checks, "web page answers")?.level, "ok", what);
      assert.equal(titles(checks).at(-1), LAST, what);
    }

    // The MCP endpoint and the page: each fails as its own check.
    const listsTools = (body: string): boolean => {
      try {
        return (JSON.parse(body) as { method?: string }).method === "tools/list";
      } catch {
        return false;
      }
    };
    const idOf = (body: string): unknown => (JSON.parse(body) as { id?: unknown }).id;
    const wrongMcp: Array<[what: string, instead: (asked: string, body: string) => Swap | undefined]> = [
      ["a page where MCP is", (asked) => (asked === "POST /mcp" ? { body: "<html>MCP</html>", type: "text/html" } : undefined)],
      ["JSON that is no MCP answer", (asked) => (asked === "POST /mcp" ? json({ status: "ok" }) : undefined)],
      ["a failure where MCP is", (asked) => (asked === "POST /mcp" ? json({ error: { code: "internal", message: "No." } }, 500) : undefined)],
      ["tools as a text", (asked, body) => (asked === "POST /mcp" && listsTools(body) ? json({ jsonrpc: "2.0", id: idOf(body), result: { tools: "none" } }) : undefined)],
      ["tools that are numbers", (asked, body) => (asked === "POST /mcp" && listsTools(body) ? json({ jsonrpc: "2.0", id: idOf(body), result: { tools: [1, 2] } }) : undefined)],
      ["an error for the list of tools", (asked, body) => (asked === "POST /mcp" && listsTools(body) ? json({ jsonrpc: "2.0", id: idOf(body), error: { code: -32000, message: { toString: 1 } } }) : undefined)],
      ["one tool too few", (asked, body) => (asked === "POST /mcp" && listsTools(body) ? { change: (real: any) => ({ ...real, result: { ...real.result, tools: real.result.tools.slice(1) } }) } : undefined)],
    ];
    for (const [what, instead] of wrongMcp) {
      swap = instead;
      const { code, checks } = await examine();
      assert.equal(code, 1, what);
      assert.equal(of(checks, "MCP endpoint answers")?.level, "fail", `${what}: ${JSON.stringify(checks)}`);
      assert.ok(of(checks, "MCP endpoint answers")!.detail!.length > 0, what);
      assert.equal(of(checks, "config users exist")?.level, "ok", what);
      assert.equal(of(checks, "web page answers")?.level, "ok", what);
      assert.equal(titles(checks).at(-1), LAST, what);
    }
    answering("GET /", json({ error: { code: "internal", message: "No." } }, 500));
    const noPage = await examine();
    assert.deepEqual([of(noPage.checks, "web page answers")?.level, of(noPage.checks, "web page answers")?.detail], ["fail", "status 500"]);
    assert.equal(of(noPage.checks, "MCP endpoint answers")?.level, "ok");
    assert.equal(titles(noPage.checks).at(-1), LAST);

    // As a command, in words: the report is whole, and nothing is on the error output.
    answering(STATUS, { change: (status) => ({ ...status, inconsistencies: "broken", auth: {} }) });
    const inWords = await cli("doctor");
    assert.equal(inWords.code, 1);
    assert.equal(inWords.err, "");
    assert.match(inWords.out, /service is running\s+shape-test 0\.1\.0 answers at http:\S+, and did not give its status: it answered GET \/api\/admin\/status, but not as a Vigile service does: "inconsistencies" is not a list of texts/);
    assert.match(inWords.out, /\d+ passed .* 1 failed/);
    swap = () => undefined;
  });

  it("is reported as that by the commands that read its answers, and never as a place in the code", async () => {
    const notAsVigile = (asked: string) => new RegExp(`answered ${asked.replace(/[/]/g, "\\/")}, but not as (a Vigile service|[a-z-]+) does`);

    // The users, for the list of them and for the setting that names one.
    for (const [what, instead] of [["users as a text", json({ users: "none" })], ["users that are nothing", json({ users: [null] })], ["users that are numbers", json({ users: [1, 2] })], ["no users", json({})]] as Array<[string, Swap]>) {
      answering(USERS, instead);
      reported(await cli("user", "list"), /answered POST \/api\/list-users, but not as a Vigile service does: "users" is not a list of users with an id, a username and a type\./, what);
      reported(await cli("config", "set", "auth.keyless_user", "agent1"), /"users" is not a list of users/, what);
      const asJson = await cli("user", "list", "--json");
      assert.equal(asJson.code, 1, what);
      assert.equal((JSON.parse(asJson.err) as { error: { code: string } }).error.code, "internal", what);
    }
    // A list of users that is none of the service's, in each way in which a list can be none: the commands
    // that read all users stop at the first answer that is not one, say what answered wrongly, and have asked
    // for no page more. The whole table is held against what they read with further down; here, through the
    // commands, the ways that take a few answers.
    const real = await realTokens();
    const users: Target = { list: "users", entries: "users", question: paging.questionOfList("list_users"), owner: "nobody", remembers: true, first: 0, held: 0, foreign: { "the list of tasks": real.tasks, "the list of projects": real.projects, "a list of an item": real.ofItem } };
    const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\/"]/g, "\\$&");
    for (const attack of adversary(paging, users).filter((one) => one.why !== null && one.requests <= 3 && !one.limit && !/no list|nothing where|no place in the list$/.test(one.name))) {
      const says = new RegExp(`answered POST \\/api\\/list-users, but not as a Vigile service does: ${escaped(attack.why!)}\\.`);
      let asked = 0;
      swap = (request, body) => {
        if (request !== USERS) return undefined;
        const answer = attack.page(++asked, (JSON.parse(body) as { continuation?: unknown }).continuation);
        return json({ users: answer.entries, you: "admin", ...(Object.hasOwn(answer, "continuation") ? { continuation: answer.continuation } : {}) });
      };
      reported(await cli("user", "list"), says, attack.name);
      assert.equal(asked, attack.requests, `user list, ${attack.name}: ${asked} pages were asked for`);
      asked = 0;
      reported(await cli("config", "set", "auth.keyless_user", "agent1"), says, attack.name);
      assert.equal(asked, attack.requests, `config set, ${attack.name}: ${asked} pages were asked for`);
      asked = 0;
      const check = of((await examine()).checks, "config users exist");
      assert.equal(check?.level, "fail", `${attack.name}: ${JSON.stringify(check)}`);
      assert.ok(check?.detail?.includes(`the users could not be asked for: `) && check.detail.includes(`but not as a Vigile service does: ${attack.why!.slice(0, 150)}`), `${attack.name}: ${check?.detail}`);
      assert.equal(asked, attack.requests, `the doctor, ${attack.name}: ${asked} pages were asked for`);
    }
    // Users without end, through the command: a thousand pages are asked for, and no more.
    const endless = adversary(paging, users).find((one) => one.name === "pages without end, each new and each with a new token")!;
    let through = 0;
    swap = (request, body) => {
      if (request !== USERS) return undefined;
      const answer = endless.page(++through, (JSON.parse(body) as { continuation?: unknown }).continuation);
      return json({ users: answer.entries, you: "admin", continuation: answer.continuation });
    };
    reported(await cli("user", "list"), /answered POST \/api\/list-users, but not as a Vigile service does: it goes on after 1000 pages\./, "users without end, one to a page");
    assert.equal(through, 1000, `${through} pages were asked for`);
    swap = () => undefined;
    swap = () => undefined;
    assert.equal(loadConfig(config, {}).config.auth.keyless_user, "agent1");
    answering("GET /api/admin/status", { change: (status) => ({ ...status, auth: { ...status.auth, keys_of_someone_else: 5 } }) });
    reported(await cli("user", "list"), /answered GET \/api\/admin\/status, but not as a Vigile service does: "auth\.keys_of_someone_else" is not a list of texts\./, "refused keys as a number");
    for (const [what, instead, says] of [
      ["a status that is a text", json("fine"), /the answer is not an object/],
      ["auth as a text", { change: (status: any) => ({ ...status, auth: "on" }) }, /"auth" is not an object/],
    ] as Array<[string, Swap, RegExp]>) {
      answering("GET /api/admin/status", instead);
      reported(await cli("user", "list"), says, what);
    }
    // A status that says nothing of keys, as an earlier service's, refuses none.
    answering("GET /api/admin/status", { change: ({ auth: _auth, ...status }: any) => status });
    const listed = await cli("user", "list");
    assert.equal(listed.code, 0, listed.err);
    assert.match(listed.out, /admin\s+admin\s+API key/);

    // A user that is to be removed, and is not what a user is.
    await service.engine.execute("create_user", "admin", { username: "zed", type: "agent" });
    for (const [what, instead] of [["nothing", json(null)], ["a text", json("agent1")], ["no version", json({ kind: "user", username: "agent1" })]] as Array<[string, Swap]>) {
      answering("POST /api/get", instead);
      reported(await cli("user", "remove", "zed"), /answered POST \/api\/get, but not as get does: /, what);
    }
    const usernames = ((await service.engine.execute("list_users", "admin", {})) as { users: Array<{ username: string }> }).users.map((user) => user.username);
    assert.ok(usernames.includes("zed"), "nothing was deleted");

    // The operations, as they are shown: lists whose items are not items, an item whose parts are of other kinds.
    const deep = `${"[".repeat(20_000)}${"]".repeat(20_000)}`;
    const shown: Array<[command: string[], asked: string, instead: Swap]> = [
      [["list-tasks"], "POST /api/list-tasks", json({ tasks: [null] })],
      [["list-tasks"], "POST /api/list-tasks", json({ tasks: [{ id: "SHP-001", status: "open", title: "T" }] })],
      [["list-tasks"], "POST /api/list-tasks", json({ tasks: [{ id: { toString: 1 }, status: "open", title: "T", priority: 0, assigned_to: [] }] })],
      [["list-next-tasks"], "POST /api/list-next-tasks", json({ tasks: [5] })],
      [["list-projects"], "POST /api/list-projects", json({ projects: [{ id: "SHP", status: "open", title: "T" }] })],
      [["list-projects"], "POST /api/list-projects", json({ projects: [{ id: "SHP", status: 7, title: "T", progress: { finished: 0, total: 0 } }] })],
      [["list-users"], "POST /api/list-users", json({ users: [undefined, null] })],
      [["get", "SHP-001"], "POST /api/get", json({ kind: "task", id: "SHP-001", title: "T", links: { blocks: 5 }, assigned_to: [] })],
      [["get", "SHP-001"], "POST /api/get", json({ kind: "task", id: "SHP-001", title: "T", links: {}, assigned_to: null })],
      [["get", "SHP-001"], "POST /api/get", json({ kind: "task", id: "SHP-001", title: "T", status: "open", links: {}, assigned_to: [], history: [{ at: "now", action: 5, by: "x" }] })],
      [["get", "SHP-001"], "POST /api/get", json({ kind: "task", id: "SHP-001", title: "T", status: "open", links: {}, assigned_to: [], history: [{ at: "now", action: "updated", by: "x", data: null }] })],
      [["get", "SHP"], "POST /api/get", json({ kind: "project", id: "SHP", title: "T", status: "open", links: {} })],
      [["get-guide"], "POST /api/get-guide", json({ text: "Guide", title: "T", topics: [null] })],
      [["list-link-types"], "POST /api/list-link-types", json({ link_types: [{ type: "x", reverse: "y", from: "task", to: 5 }] })],
      [["list-tasks"], "POST /api/list-tasks", { body: deep }],
      [["list-tasks", "--json"], "POST /api/list-tasks", { body: deep }],
    ];
    for (const [command, asked, instead] of shown) {
      answering(asked, instead);
      reported(await cli(...command), notAsVigile(asked), `${command.join(" ")} answered ${"body" in instead ? instead.body.slice(0, 80) : ""}`);
    }

    // A refusal of another shape is still a refusal that is reported, in words and as JSON.
    const refusals: Array<[what: string, body: unknown, says: RegExp]> = [
      ["what is in the way as a number", { error: { code: "rule_violation", message: "It is refused.", blocking: 5, actions: 7, current: "x" } }, /✗ It is refused\./],
      ["parts that are of other kinds", { error: { code: "rule_violation", message: "It is refused.", blocking: [null, 3, { id: { toString: 1 }, title: ["t"] }], actions: [{ toString: 1 }, "Do this."], current: { id: {}, version: [] } } }, /✗ It is refused\.[^]*Do this\./],
      ["a message that is an object", { error: { message: { toString: 1 } } }, /✗ The service refused the request, and did not say why in a way this command line can read\./],
      ["an error that is a text", { error: "no" }, /✗ The service refused the request, and did not say why/],
      ["an error that is a number", { error: 0 }, /✗ The service refused the request, and did not say why/],
    ];
    const written: Array<[what: string, body: string, says: RegExp]> = [
      ...refusals.map(([what, body, says]): [string, string, RegExp] => [what, JSON.stringify(body), says]),
      ["an error nested too deep to walk", `{"error":{"code":"rule_violation","message":"It is refused.","current":${deep}}}`, /✗ The service refused the request, and did not say why/],
    ];
    for (const [what, body, says] of written) {
      for (const status of [400, 401]) {
        answering("POST /api/list-tasks", { status, body });
        reported(await cli("list-tasks"), says, `${what}, ${status}`);
        const asJson = await cli("list-tasks", "--json");
        assert.equal(asJson.code, 1, what);
        assert.equal(asJson.out, "", what);
        assert.ok("error" in (JSON.parse(asJson.err) as object), `${what}, ${status}: ${asJson.err.slice(0, 200)}`);
      }
    }
    // A question whose answer is not the one its operation gives is not shown as its result; as JSON it is
    // passed on as it came.
    const part = { kind: "task", id: "SHP-001", title: "T", status: "open", is_waiting: true };
    answering("POST /api/get", json(part));
    reported(await cli("get", "SHP-001"), /answered POST \/api\/get, but not as get does: "type" of the task is not one of task, bug, issue, incident\./, "a part of a task");
    const raw = await cli("get", "SHP-001", "--json");
    assert.equal(raw.code, 0, raw.err);
    assert.deepEqual(JSON.parse(raw.out), part);
    swap = () => undefined;
    assert.match((await cli("list-tasks")).out, /SHP-001/, "passed on untouched, the service's answers are shown as ever");
  });

  it("takes only a 401 in the service's own words for a key that is refused, and reports every other refusal with the service's reason and what it says to do", async () => {
    const adminKey = () => loadConfig(config, {}).config.auth.keys.admin;
    const key = adminKey();
    const HINT = /The command line took the key from the config file/;
    const running = (checks: Check[], what: string): Check => {
      assert.deepEqual(checks.map((check) => [check.title, check.level]), [["service is running", "fail"]], `${what}: ${JSON.stringify(checks)}`);
      assert.match(checks[0]!.detail!, new RegExp(`^shape-test 0\\.1\\.0 answers at http://127\\.0\\.0\\.1:${port}, and did not give its status: `), what);
      assert.doesNotMatch(`${checks[0]!.detail} ${checks[0]!.fix}`, /reset-key|admin key/, `${what}: nothing is said of the key`);
      return checks[0]!;
    };

    // The service's own guards answer 403 before any key is looked at, and let the question of who is there
    // through: a request that calls the service by a name it does not go by, and one that a page of another
    // site sent. Here every request is passed on to the service dressed as such a one.
    swap = () => undefined;
    for (const [what, headers, says, does] of [
      ["a name the service does not go by", { host: "plan.example:8700" }, /This service listens on this machine only, and the request calls it "plan\.example"\./, /Reach it as http:\/\/127\.0\.0\.1:\d+\./],
      ["a page of another site", { "sec-fetch-site": "cross-site" }, /This request comes from a page of another site, which may not use the service\./, /Open the page at the service's own address, or call the service from a program\./],
    ] as Array<[string, Record<string, string>, RegExp, RegExp]>) {
      dress = headers;
      const check = running((await examine()).checks, what);
      assert.match(check.detail!, says, what);
      assert.match(check.fix!, does, what);
      for (const command of [["list-tasks"], ["user", "list"], ["user", "reset-key", "admin"], ["user", "reset-key", "agent1"], ["config", "set", "auth.keyless_user", "agent1"]]) {
        const result = await cli(...command);
        reported(result, says, `${what}: ${command.join(" ")}`);
        assert.match(result.err, does, `${what}: ${command.join(" ")}`);
        assert.doesNotMatch(result.err, HINT, `${what}: ${command.join(" ")}`);
      }
      assert.equal(adminKey(), key, `${what}: the admin key that works was not replaced`);
    }
    dress = {};

    // Answers that have something of a refused key about them, and are not one.
    const notTheKey: Array<[what: string, instead: Swap, says: RegExp, does: RegExp | null]> = [
      ["403 that calls itself unauthorized", json({ error: { code: "unauthorized", message: "Not from here.", actions: ["Come from there.", 7, ""] } }, 403), /Not from here\./, /^Come from there\.$/],
      ["500 that calls itself unauthorized", json({ error: { code: "unauthorized", message: "Not from here.", actions: "Come from there." } }, 500), /Not from here\./, null],
      ["404 that calls itself unauthorized", json({ error: { code: "unauthorized", message: "Not from here." } }, 404), /Not from here\./, null],
      ["401 in other words", json({ error: { code: "forbidden", message: "Not from here.", actions: ["Come from there."] } }, 401), /Not from here\./, /^Come from there\.$/],
      ["401 that is a page", { status: 401, body: "<html>Sign in</html>", type: "text/html" }, /answered, but not as a Vigile service\./, null],
      ["401 without an error", json({ status: "no" }, 401), /The service answered 401\./, null],
      ["401 whose error is a text", json({ error: "unauthorized" }, 401), /no reason was given|did not say why/, null],
    ];
    for (const [what, instead, says, does] of notTheKey) {
      answering(STATUS, instead);
      const check = running((await examine()).checks, what);
      assert.match(check.detail!, says, what);
      if (does) assert.match(check.fix!, does, what);
      else assert.match(check.fix!, /stop the service and start it again/, what);
      answering("POST /api/reset-user-key", instead);
      const reset = await cli("user", "reset-key", "admin");
      reported(reset, says, `${what}: user reset-key admin`);
      assert.doesNotMatch(reset.err, HINT, what);
      assert.equal(adminKey(), key, `${what}: the admin key was not replaced`);
      answering("POST /api/list-tasks", instead);
      const listed = await cli("list-tasks");
      reported(listed, says, `${what}: list-tasks`);
      assert.doesNotMatch(listed.err, HINT, what);
      // The list of users rests on the status too: that it could not be asked is not that no key is refused.
      answering(STATUS, instead);
      reported(await cli("user", "list"), says, `${what}: user list`);
    }
    // The users the doctor asks for, refused: the reason, and of what the answer says to do, the texts.
    answering(USERS, json({ error: { code: "forbidden", message: "Not from here.", actions: ["Come from there.", 7, ["x"], "Or wait."] } }, 403));
    const users = of((await examine()).checks, "config users exist")!;
    assert.deepEqual([users.level, users.detail, users.fix], ["fail", "the users could not be asked for: Not from here.", "Come from there. Or wait."]);

    // The one answer that means it: 401, in the service's own words.
    const refused = json({ error: { code: "unauthorized", message: "The API key is not valid.", actions: ["Check the key in the Authorization header."] } }, 401);
    answering(STATUS, refused);
    assert.deepEqual((await examine()).checks.map((check) => [check.title, check.level, check.detail, check.fix]), [
      ["service is running", "ok", `shape-test 0.1.0 at http://127.0.0.1:${port}`, undefined],
      ["admin key works", "fail", "The API key is not valid.", "Issue a new one: vigile user reset-key admin"],
    ]);
    answering("POST /api/list-tasks", refused);
    const withKey = await cli("list-tasks");
    reported(withKey, /The API key is not valid\./, "a key that is refused");
    assert.match(withKey.err, HINT);
    // Without a key there is none to speak of.
    assert.doesNotMatch((await cli("list-tasks", "--as", "agent1")).err, HINT);
    // And only then is the admin key replaced in the file, past the service that refuses it.
    answering("POST /api/reset-user-key", refused);
    const replaced = await cli("user", "reset-key", "admin", "--json");
    assert.equal(replaced.code, 0, replaced.err);
    assert.equal((JSON.parse(replaced.out) as { api_key: string }).api_key, adminKey());
    assert.notEqual(adminKey(), key);
    swap = () => undefined;
    assert.equal((await cli("list-tasks")).code, 0, "the service takes the new key up");
  });

  it("follows no redirect, whichever request is answered with one", async () => {
    // Where every redirect points: it answers whatever it is asked, and must never be asked.
    const elsewhere = await freePort();
    const second = await stranger(elsewhere, (request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(request.url === "/health" ? JSON.stringify({ status: "ok", name: "shape-test", version: "0.1.0" }) : JSON.stringify({ users: [], tasks: [], projects: [] }));
    });
    const sendsOn = (asked: string, status = 307): Swap => ({ status, body: "", headers: { location: `http://127.0.0.1:${elsewhere}${asked.slice(asked.indexOf(" ") + 1)}` } });
    const redirect = (status: number, path: string) => new RegExp(`a redirect \\(${status}\\) to http://127\\.0\\.0\\.1:${elsewhere}${path.replace(/[/]/g, "\\/")}, which the command line does not follow`);
    try {
      // Every request but the question of who is there.
      swap = (asked) => (asked === "GET /health" ? undefined : sendsOn(asked));
      const commands: Array<[command: string[], path: string]> = [
        [["list-tasks"], "/api/list-tasks"],
        [["get", "SHP-001"], "/api/get"],
        [["create-project", "--title", "Sent on", "--prefix", "ON"], "/api/create-project"],
        [["user", "list"], "/api/list-users"],
        [["user", "add", "sent-on"], "/api/create-user"],
        [["user", "remove", "agent1"], "/api/get"],
        // A reset reads the user first, as a removal does.
        [["user", "reset-key", "agent1"], "/api/get"],
        [["user", "reset-key", "admin"], "/api/get"],
        [["config", "set", "auth.keyless_user", "agent1"], "/api/list-users"],
      ];
      const key = loadConfig(config, {}).config.auth.keys.admin;
      for (const [command, path] of commands) reported(await cli(...command), redirect(307, path), command.join(" "));
      assert.equal(loadConfig(config, {}).config.auth.keys.admin, key, "a redirect is not a key that is refused");
      const sent = (await examine()).checks;
      assert.deepEqual(sent.map((check) => [check.title, check.level]), [["service is running", "fail"]]);
      assert.match(sent[0]!.detail!, redirect(307, "/api/admin/status"));

      // Each request the doctor makes after that, in turn; the others are passed on.
      const later: Array<[asked: string, status: number, title: string | null]> = [
        [USERS, 307, "config users exist"],
        [USERS, 308, "config users exist"],
        ["POST /mcp", 307, "MCP endpoint answers"],
        ["POST /mcp", 308, "MCP endpoint answers"],
        ["GET /mcp", 302, null],
        ["DELETE /mcp", 307, null],
        ["GET /", 301, "web page answers"],
        ["GET /", 302, "web page answers"],
        ["GET /", 303, "web page answers"],
        ["GET /", 307, "web page answers"],
      ];
      for (const [asked, status, title] of later) {
        swap = (request) => (request === asked ? sendsOn(request, status) : undefined);
        const { checks } = await examine();
        const what = `${asked} answered ${status}`;
        assert.equal(titles(checks).at(-1), LAST, what);
        for (const check of checks.filter((check) => ["config users exist", "MCP endpoint answers", "web page answers"].includes(check.title))) {
          assert.equal(check.level, check.title === title ? "fail" : "ok", `${what}: ${check.title}: ${check.detail}`);
          if (check.title === title) assert.match(check.detail!, redirect(status, asked.slice(asked.indexOf(" ") + 1)), what);
        }
      }

      // Every request, the question of who is there too.
      swap = (asked) => sendsOn(asked);
      const stopped = await cli("list-tasks");
      assert.equal(stopped.code, 1);
      assert.match(stopped.err, new RegExp(`is not a Vigile service: it sends GET /health on to http://127\\.0\\.0\\.1:${elsewhere}/health\\.`));
      assert.deepEqual((await examine()).checks.map((check) => [check.title, check.level]), [["service is running", "fail"]]);

      assert.deepEqual(second.seen, [], "what the redirects point to was never asked anything");
    } finally {
      swap = () => undefined;
      await second.close();
    }
  });

  it("does not say that something was done before the answer says so", async () => {
    const unknown = (asked: string) => new RegExp(`answered ${asked.replace(/[/]/g, "\\/")}, but not with what says that it was done \\(.+\\): .+\\. Whether it was done is not known\\.`);
    const usernames = async () => ((await service.engine.execute("list_users", "admin", {})) as { users: Array<{ username: string }> }).users.map((user) => user.username);
    await service.engine.execute("create_user", "admin", { username: "leaver", type: "agent" });
    const link = { from: "SHP-002", type: "depends on", to: "SHP-001" };

    // A user that is removed: only a yes that is a yes, about a user, with a yes or no for "for good".
    const notDeleted: Array<[what: string, answer: unknown, alsoAsOperation: boolean]> = [
      ["nothing in it", {}, true],
      ["a no, and for good as a text", { deleted: false, permanent: "false" }, true],
      ["a yes that is a text", { deleted: "true", permanent: false, kind: "user", id: "leaver" }, true],
      ["for good as a text", { deleted: true, permanent: "false", kind: "user", id: "leaver" }, true],
      ["without saying whether for good", { deleted: true, kind: "user", id: "leaver" }, true],
      ["something else that was deleted", { deleted: true, permanent: false, kind: "task", id: "SHP-001" }, true],
      ["another user that was deleted", { deleted: true, permanent: false, kind: "user", id: "USER-001" }, false],
      ["nothing", null, true],
    ];
    for (const [what, answer, alsoAsOperation] of notDeleted) {
      answering("POST /api/delete", json(answer));
      for (const command of [["user", "remove", "leaver"], ["user", "remove", "leaver", "--permanent"], ...(alsoAsOperation ? [["delete", "leaver", "--kind", "user", "--version", "1"]] : [])]) {
        const result = await cli(...command);
        reported(result, unknown("POST /api/delete"), `${what}: ${command.join(" ")}`);
        assert.ok(result.err.includes(`${JSON.stringify(answer)}. Whether`), `${what}: what was answered is said: ${result.err}`);
        assert.match(result.err, command[0] === "user" ? /vigile user list shows whether leaver is still there\./ : /Look at what the command was about: vigile get <id>/, what);
        assert.doesNotMatch(result.err, /deleted;|deleted permanently|no longer works|To bring it back/, what);
      }
    }
    assert.ok((await usernames()).includes("leaver"));

    // A key that is issued: only with the user it is for and the key, each a text that says something.
    const notIssued: Array<[what: string, answer: unknown]> = [
      ["an empty key", { user: { username: "newcomer", type: "agent" }, api_key: "" }],
      ["an empty name", { user: { username: "", type: "agent" }, api_key: "vig_x" }],
      ["a key that is a number", { user: { username: "newcomer", type: "agent" }, api_key: 5 }],
      ["a user that is a text", { user: "newcomer", api_key: "vig_x" }],
      ["no key at all", { status: "ok" }],
      ["nothing", null],
    ];
    for (const [what, answer] of notIssued) {
      answering("POST /api/create-user", json(answer));
      const added = await cli("user", "add", "newcomer");
      reported(added, unknown("POST /api/create-user"), `${what}: user add`);
      assert.match(added.err, /vigile user list shows whether newcomer is there\. If it is, its key was not shown: issue one with vigile user reset-key newcomer/, what);
      reported(await cli("create-user", "--username", "newcomer", "--type", "agent"), unknown("POST /api/create-user"), `${what}: create-user`);
      answering("POST /api/reset-user-key", json(answer));
      const reset = await cli("user", "reset-key", "agent1");
      reported(reset, unknown("POST /api/reset-user-key"), `${what}: user reset-key`);
      assert.match(reset.err, /The key agent1 had may no longer work\. Run the command again: the key it then shows is the one that works\./, what);
      reported(await cli("reset-user-key", "--user", "agent1"), unknown("POST /api/reset-user-key"), `${what}: reset-user-key`);
    }

    // The operations that change something: a link, an item's status, a new item.
    const linking = ["--from", "SHP-002", "--type", "depends on", "--to", "SHP-001"];
    const moving = ["set-task-status", "--id", "SHP-001", "--version", "1", "--status", "in_progress"];
    const notDone: Array<[command: string[], asked: string, answer: unknown]> = [
      [["delete", "SHP-001", "--version", "1"], "POST /api/delete", { deleted: "yes", permanent: false, kind: "task", id: "SHP-001" }],
      [["delete", "SHP-001", "--version", "1"], "POST /api/delete", { deleted: true, permanent: "false", kind: "task", id: "SHP-001" }],
      [["delete", "SHP-001", "--version", "1"], "POST /api/delete", { deleted: true, permanent: false, kind: "task" }],
      [["add-link", ...linking], "POST /api/add-link", { created: "no", link }],
      [["add-link", ...linking], "POST /api/add-link", { created: 1, link }],
      [["add-link", ...linking], "POST /api/add-link", { link }],
      [["add-link", ...linking], "POST /api/add-link", { created: true, link: { from: { toString: 1 }, type: "depends on", to: "SHP-001" } }],
      [["add-link", ...linking], "POST /api/add-link", { created: true, link: "SHP-002 depends on SHP-001" }],
      [["remove-link", ...linking], "POST /api/remove-link", { removed: "true", link }],
      [["remove-link", ...linking], "POST /api/remove-link", { removed: false, link }],
      [moving, "POST /api/set-task-status", { status: "ok" }],
      [moving, "POST /api/set-task-status", { kind: "task", id: "SHP-001", title: "One task", status: "in_progress", version: "2" }],
      [moving, "POST /api/set-task-status", { kind: "task", id: "SHP-001", title: "One task", version: 2 }],
      [moving, "POST /api/set-task-status", { kind: "task", links: {} }],
      [["create-project", "--title", "P", "--prefix", "PPP"], "POST /api/create-project", "done"],
      [["create-project", "--title", "P", "--prefix", "PPP"], "POST /api/create-project", null],
      [["create-project", "--title", "P", "--prefix", "PPP"], "POST /api/create-project", { kind: "project", id: "", title: "P", status: "open", version: 1 }],
    ];
    for (const [command, asked, answer] of notDone) {
      answering(asked, json(answer));
      const result = await cli(...command);
      const what = `${command[0]} answered ${JSON.stringify(answer)}`;
      reported(result, unknown(asked), what);
      assert.ok(result.err.includes(`${JSON.stringify(answer)}. Whether`), `${what}: what was answered is said: ${result.err}`);
      assert.match(result.err, /Look at what the command was about: vigile get <id>, or vigile list-tasks, vigile list-projects, vigile list-users\./, what);
    }
    // Asked for as JSON, the answer is passed on as it came, and nothing is said about it.
    answering("POST /api/delete", json({ deleted: "yes" }));
    const passedOn = await cli("delete", "SHP-001", "--version", "1", "--json");
    assert.deepEqual([passedOn.code, JSON.parse(passedOn.out)], [0, { deleted: "yes" }]);
    // A question that is answered in another shape is not answered: nothing is shown as its result.
    answering("POST /api/list-tasks", json({ status: "ok" }));
    reported(await cli("list-tasks"), /answered POST \/api\/list-tasks, but not as list-tasks does: "tasks" of a list is not a list of tasks\./, "a list that is none");

    // An answer that another operation gives is not this operation's, however well it can be shown. A list of
    // tasks does not say that a task was deleted; that a link is there already does not say that it was removed.
    answering("POST /api/delete", json({ tasks: [] }));
    const listForDelete = await cli("delete", "SHP-001", "--version", "1");
    reported(listForDelete, unknown("POST /api/delete"), "a list of tasks for a delete");
    assert.match(listForDelete.err, /\("deleted" of a deletion is not true\): \{"tasks":\[\]\}\. Whether it was done is not known\./);
    answering("POST /api/remove-link", json({ created: false, link }));
    const thereForRemoved = await cli("remove-link", ...linking);
    reported(thereForRemoved, unknown("POST /api/remove-link"), "the answer of add-link for remove-link");
    assert.match(thereForRemoved.err, /\("removed" of what became of a link is not true\)/);
    assert.doesNotMatch(thereForRemoved.err, /Already linked|Removed/);
    // The real answers of other operations, and of the same operation about another item.
    const real = async (name: string, input: Record<string, unknown>) => JSON.parse(JSON.stringify(await service.engine.execute(name, "admin", input))) as unknown;
    answering("POST /api/get", json(await real("get", { id: "SHP" })));
    reported(await cli("get", "SHP-001"), /answered POST \/api\/get, but not as get does: it is about the project SHP, and not about SHP-001\./, "a project for a task");
    answering("POST /api/get", json(await real("get", { id: "SHP-002" })));
    reported(await cli("get", "SHP-001"), /but not as get does: it is about the task SHP-002, and not about SHP-001\./, "another task");
    answering("POST /api/list-tasks", json(await real("list_projects", {})));
    reported(await cli("list-tasks"), /but not as list-tasks does: "tasks" of a list is not a list of tasks\./, "the projects for the tasks");
    answering("POST /api/set-task-status", json(await real("get", { id: "SHP-002" })));
    reported(await cli(...moving), unknown("POST /api/set-task-status"), "another task for the one whose status was set");

    // What the service does say, the commands say after it.
    swap = () => undefined;
    assert.match((await cli("add-link", ...linking)).out, /✓ Linked: SHP-002 depends on SHP-001/);
    assert.match((await cli("add-link", ...linking)).out, /✓ Already linked: SHP-002 depends on SHP-001/);
    assert.match((await cli("remove-link", ...linking)).out, /✓ Removed: SHP-002 depends on SHP-001/);
    assert.match((await cli("set-task-status", "--id", "SHP-002", "--version", "3", "--status", "in_progress")).out, /✓ SHP-002  Another task  in progress/);
    const gone = await cli("user", "remove", "leaver");
    assert.equal(gone.code, 0, gone.err);
    assert.match(gone.out, /✓ User leaver deleted; its API key no longer works\n\s+→ To bring it back: vigile restore leaver --kind user, then vigile user reset-key leaver/);
    const added = await cli("user", "add", "newcomer");
    assert.match(added.out, /✓ User newcomer created/);
    assert.match((await cli("user", "reset-key", "newcomer")).out, /✓ newcomer has a new API key; the old one no longer works/);
    const forGood = await cli("user", "remove", "newcomer", "--permanent");
    assert.match(forGood.out, /✓ User newcomer deleted permanently; its API key no longer works/);
    assert.doesNotMatch(forGood.out, /To bring it back/);
    assert.match((await cli("delete", "SHP-002", "--version", "4")).out, /✓ task SHP-002 deleted\n\s+→ To bring it back: vigile restore SHP-002/);
    assert.ok(!(await usernames()).includes("leaver") && !(await usernames()).includes("newcomer"));
  });
  it("prints what the service says it stored: an answer of the right shape about the right item is not held to the values that were asked for", async () => {
    // Whether the values of an item are the ones the call asked for is the service's to decide, and the engine's
    // tests' to check. The command line shows what came back, so that whoever asked sees it.
    await service.engine.execute("create_project", "admin", { title: "The line", prefix: "LIN" });
    // The numbers of tasks run through all projects: the two that are made here are named by what they were given.
    const [first, second] = await Promise.all(["First", "Second"].map(async (title) => ((await service.engine.execute("create_task", "admin", { title, description: "A task.", project: "LIN" })) as { id: string }).id)) as [string, string];
    await service.engine.execute("create_user", "admin", { username: "liner", type: "agent" });
    const creating = ["create-task", "--title", "Asked for", "--description", "A task.", "--project", "LIN", "--priority", "3", "--depends-on", `${first},${first}`, "--assigned-to", "USER-001"];

    // A task that was made, as the service made it of that call: its dependency once, the user by its name.
    swap = () => undefined;
    const asMade = await cli(...creating, "--json");
    assert.equal(asMade.code, 0, asMade.err);
    const task = JSON.parse(asMade.out) as { id: string; depends_on: string[]; assigned_to: string[]; priority: number };
    assert.deepEqual([task.depends_on, task.assigned_to, task.priority], [[first], ["admin"], 3]);

    // The same call, answered with other values in the same shape: printed as they came, and the command ends well.
    const otherwise: Array<[what: string, change: (task: any) => unknown, shows: RegExp]> = [
      ["another title", (made) => ({ ...made, title: "Stored otherwise" }), /✓ LIN-\d+  Stored otherwise  open/],
      ["a dependency that was not asked for", (made) => ({ ...made, depends_on: [first, second] }), /✓ LIN-\d+  Asked for  open/],
      ["nobody it is assigned to", (made) => ({ ...made, assigned_to: [], is_assigned: false }), /✓ LIN-\d+  Asked for  open/],
      ["another priority, type and status", (made) => ({ ...made, priority: 0, type: "bug", status: "draft" }), /✓ LIN-\d+  Asked for  draft/],
    ];
    for (const [what, change, shows] of otherwise) {
      answering("POST /api/create-task", { change });
      const result = await cli(...creating);
      assert.equal(result.code, 0, `${what}: ${result.err}`);
      assert.match(result.out, shows, what);
      assert.equal(result.err, "", what);
    }
    // What the answer is made of is still held to its kind, whatever the call asked: with a user asked for by
    // its ID, a number among the users is turned away for being no username.
    const ofAnotherKind: Array<[what: string, change: (task: any) => unknown, says: RegExp]> = [
      ["a number among the users", (made) => ({ ...made, assigned_to: [5] }), /\("assigned_to" of the task is not a list of usernames\)/],
      ["an ID among the users", (made) => ({ ...made, assigned_to: ["USER-001"] }), /\("assigned_to" of the task is not a list of usernames\)/],
      ["a dependency in another spelling", (made) => ({ ...made, depends_on: ["lin-1"] }), /\("depends_on" of the task is not a list of the tasks and projects it depends on\)/],
      ["a version that is a text", (made) => ({ ...made, version: "1" }), /\("version" of the task is not a whole number from 1 up\)/],
    ];
    for (const [what, change, says] of ofAnotherKind) {
      answering("POST /api/create-task", { change });
      const result = await cli(...creating);
      assert.equal(result.code, 1, what);
      assert.equal(result.out, "", what);
      assert.match(result.err, /answered POST \/api\/create-task, but not with what says that it was done/, what);
      assert.match(result.err, says, what);
    }

    // A status that was set, a task that was changed, a user that was removed for good: what came back is shown.
    answering("POST /api/set-task-status", { change: (moved: any) => ({ ...moved, status: "open" }) });
    const moved = await cli("set-task-status", "--id", second, "--version", "1", "--status", "in_progress");
    assert.equal(moved.code, 0, moved.err);
    assert.match(moved.out, new RegExp(`✓ ${second}  Second  open`));
    answering("POST /api/update-task", { change: (updated: any) => ({ ...updated, title: "Kept as it was" }) });
    const now = (await service.engine.execute("get", "admin", { id: second })) as { version: number };
    const updated = await cli("update-task", "--id", second, "--version", String(now.version), "--title", "Renamed");
    assert.equal(updated.code, 0, updated.err);
    assert.match(updated.out, new RegExp(`✓ ${second}  Kept as it was  `));
    answering("POST /api/delete", { change: (gone: any) => ({ ...gone, permanent: false }) });
    const gone = await cli("user", "remove", "liner", "--permanent");
    assert.equal(gone.code, 0, gone.err);
    assert.match(gone.out, /✓ User liner deleted; its API key no longer works\n\s+→ To bring it back/);
    // About another item than the one that was named, it is no answer to the call, as before.
    answering("POST /api/set-task-status", { change: () => task });
    const another = await cli("set-task-status", "--id", first, "--version", "1", "--status", "in_progress");
    assert.equal(another.code, 1);
    assert.match(another.err, new RegExp(`\\(it is about the task ${task.id}, and not about ${first}\\)`));
    swap = () => undefined;
  });

  it("makes no second request on a reading that does not carry what the request needs: the user's ID, and its version", async () => {
    await service.engine.execute("create_user", "admin", { username: "keeper", type: "agent" });
    const kept = async () => ((await service.engine.execute("list_users", "admin", {})) as { users: Array<{ username: string; id: string; version: number }> }).users.find((user) => user.username === "keeper");
    const before = await kept();
    const key = loadConfig(config, {}).config.auth.keys.keeper;
    const notAVersion = /answered POST \/api\/get, but not as get does: "version" of the user is not a whole number from 1 up\./;
    const notAnId = /answered POST \/api\/get, but not as get does: "id" of the user is not the ID of a user\./;
    const wrong: Array<[what: string, change: (user: any) => unknown, says: RegExp]> = [
      ["no version", ({ version: _version, ...user }) => user, notAVersion],
      ["a version that is a text", (user) => ({ ...user, version: String(user.version) }), notAVersion],
      ["a version that is a fraction", (user) => ({ ...user, version: 1.5 }), notAVersion],
      ["a version of nought", (user) => ({ ...user, version: 0 }), notAVersion],
      ["a version below nought", (user) => ({ ...user, version: -1 }), notAVersion],
      ["a version that is nothing", (user) => ({ ...user, version: null }), notAVersion],
      ["no ID", ({ id: _id, ...user }) => user, notAnId],
      ["an ID that is a number", (user) => ({ ...user, id: 9 }), notAnId],
      ["an ID as it is not stored", (user) => ({ ...user, id: user.id.toLowerCase() }), notAnId],
      ["the ID of a task", (user) => ({ ...user, id: "SHP-001" }), notAnId],
    ];
    for (const [what, change, says] of wrong) {
      answering("POST /api/get", { change });
      const from = front.seen.length;
      for (const command of [["user", "remove", "keeper"], ["user", "remove", "keeper", "--permanent"], ["user", "reset-key", "keeper"], ["user", "reset-key", "keeper", "--json"]]) {
        const result = await cli(...command);
        assert.equal(result.code, 1, `${what}: ${command.join(" ")}`);
        assert.equal(result.out, "", `${what}: ${command.join(" ")}`);
        assert.match(command.includes("--json") ? (JSON.parse(result.err) as { error: { message: string } }).error.message : result.err, says, `${what}: ${command.join(" ")}`);
      }
      // The reading was the last thing asked: no removal and no reset went out on the strength of it.
      assert.deepEqual([...new Set(front.seen.slice(from).map((request) => request.asked))].sort(), ["GET /health", "POST /api/get"], what);
    }
    assert.deepEqual(await kept(), before, "the user is there, as it was");
    assert.equal(loadConfig(config, {}).config.auth.keys.keeper, key, "and its key is the one it had");
    // On the reading as the service gives it, the commands do what they are for.
    swap = () => undefined;
    assert.match((await cli("user", "reset-key", "keeper")).out, /✓ keeper has a new API key/);
    assert.notEqual(loadConfig(config, {}).config.auth.keys.keeper, key);
    assert.match((await cli("user", "remove", "keeper")).out, /✓ User keeper deleted; its API key no longer works/);
  });

  it("reports a list that goes on without the token to read on with as an answer that is not the operation's, and prints no command made of anything else", async () => {
    // A task with more than a page of tasks in it, and more than two of statuses and of recorded changes.
    const execute = (name: string, input: Record<string, unknown>): Promise<any> => service.engine.execute(name, "admin", input);
    const long: string = (await execute("create_task", { title: "Long", description: "A task.", project: "SHP" })).id;
    let version = 1;
    for (let n = 0; n <= 2 * SIZES.page; n++) version = (await execute("set_task_status", { id: long, version, status: n % 2 ? "paused" : "in_progress" })).version;
    for (let n = 0; n <= SIZES.page; n++) await execute("create_task", { title: `Inside ${n}`, description: "A task.", project: "SHP", parent: long });
    const real = await execute("get", { id: long, history: true });
    const tokens: Record<string, string> = { history: real.more.history.continuation, timeline: real.more.timeline.continuation, "links.contains": real.more.links.contains.continuation };

    // As the service answers, the command says how to read on in each list, with the token of that list: letters,
    // digits, "-" and "_", which a shell passes on as they are.
    const asIs = await cli("get", long, "--history");
    assert.equal(asIs.code, 0, asIs.err);
    const printed = [...asIs.out.matchAll(/add --continuation (\S+)/g)].map((found) => found[1]!);
    assert.deepEqual(printed.sort(), Object.values(tokens).sort());
    for (const token of printed) assert.match(token, /^[A-Za-z][A-Za-z0-9_-]*$/);
    const further = await cli("get", long, "--continuation", tokens.history!);
    assert.equal(further.code, 0, further.err);
    assert.match(further.out, /A further 100 of \d+\. The ones before: add --continuation [A-Za-z][A-Za-z0-9_-]*\n/);

    // Answered with a list that goes on and no token, or with something else where the token is, nothing is
    // printed of the answer: no command to read on that names "undefined", and none made of what came.
    const part = (more: any, list: string) => (list === "links.contains" ? more.links.contains : more[list]);
    const notThese: Array<[what: string, set: (part: any, list: string) => void]> = [
      ["no token", (cut) => void delete cut.continuation],
      ["a token that is empty", (cut) => void (cut.continuation = "")],
      ["a token that is nothing", (cut) => void (cut.continuation = null)],
      ["words where the token is", (cut) => void (cut.continuation = "the next page")],
      ["what a shell would act on where the token is", (cut) => void (cut.continuation = "x; touch /tmp/vigile-was-here; $(reboot)")],
      ["an option where the token is", (cut) => void (cut.continuation = "--permanent")],
      ["the token of another list", (cut, list) => void (cut.continuation = list === "history" ? tokens.timeline : tokens.history)],
      // A token that says it is of this very list, and names nothing a place of the list can be.
      ...[{}, -1, "nowhere", [1, 2, 3], null].map((none): [string, (part: any, list: string) => void] => [
        `a token of that list with ${JSON.stringify(none)} for its place`,
        (cut, list) => void (cut.continuation = paging.sealToken({ q: paging.questionMark(paging.itemListQuestion({ kind: "task", id: long }, list === "links.contains" ? ["links", "contains"] : [list as "timeline" | "history"])), k: none })),
      ]),
    ];
    const nothingOfIt = (result: { out: string; err: string }, what: string) => assert.doesNotMatch(result.out + result.err, /--continuation|undefined|the next page|reboot|--permanent/, what);
    for (const list of Object.keys(tokens)) {
      for (const [what, set] of notThese) {
        answering("POST /api/get", { change: (answer) => (set(part(answer.more, list), list), answer) });
        const result = await cli("get", long, "--history");
        reported(result, new RegExp(`answered POST \\/api\\/get, but not as get does: "more\\.${list}\\.continuation" of the task is not the token that reads on in that list`), `${list} with ${what}`);
        nothingOfIt(result, `${list} with ${what}`);
      }
      // As many as there are, and no more than are shown: then nothing goes on.
      answering("POST /api/get", { change: (answer) => ((part(answer.more, list).total = SIZES.page), answer) });
      reported(await cli("get", long, "--history"), new RegExp(`but not as get does: "more\\.${list}" of the task does not say how many entries the list has in all, more than the 100 that are shown`), list);
    }
    // The same of a page that continues a list.
    for (const [what, set] of notThese) {
      answering("POST /api/get", { change: (answer) => (set(answer.more.history, "history"), answer) });
      const result = await cli("get", long, "--continuation", tokens.history!);
      reported(result, /answered POST \/api\/get, but not as get does: "more\.history\.continuation" of a page of the task is not the token that reads on in that list/, `a page with ${what}`);
      nothingOfIt(result, `a page with ${what}`);
    }
    // A page of another list than the one that was asked for is not printed as that one.
    const ofTimeline = await execute("get", { id: long, continuation: tokens.timeline });
    answering("POST /api/get", json(ofTimeline));
    reported(await cli("get", long, "--continuation", tokens.history!), /but not as get does: it is a page of timeline of the task SHP-\d+, and not of the list the continuation of the call reads on in/, "a page of the timeline for one of the history");
    // A list of items that goes on from what is no token.
    const lists = await realTokens();
    for (const [command, asked, field] of [["list-users", USERS, "users"], ["list-tasks", "POST /api/list-tasks", "tasks"], ["list-projects", "POST /api/list-projects", "projects"], ["list-next-tasks", "POST /api/list-next-tasks", "tasks"]] as const) {
      for (const none of ["", "the next page", "$(reboot)", "--permanent", 5, null]) {
        answering(asked, { change: (answer) => ({ ...answer, continuation: none }) });
        const result = await cli(command);
        reported(result, new RegExp(`answered ${asked.replace(/[/]/g, "\\/")}, but not as ${command} does: "continuation" of a list is not a continuation token`), `${command} that goes on from ${JSON.stringify(none)}`);
        nothingOfIt(result, command);
      }
      answering(asked, { change: (answer) => ({ ...answer, [field]: [], continuation: tokens.history }) });
      reported(await cli(command), /"continuation" of a list says that there is more, after a page that holds nothing/, command);
      // A token that is one, of another list: of an item, of another operation, of this one asked otherwise.
      const own = { "list-users": lists.users, "list-tasks": lists.tasks, "list-projects": lists.projects, "list-next-tasks": lists.nextTasks }[command];
      for (const [what, token] of [["a list of an item", tokens.history], ...Object.entries(lists).filter(([, token]) => token !== own)] as Array<[string, string]>) {
        answering(asked, { change: (answer) => ({ ...answer, continuation: token }) });
        const result = await cli(command);
        reported(result, new RegExp(`but not as ${command} does: "continuation" of a list is not a token of the list that was asked for`), `${command} that goes on with a token of ${what}`);
        nothingOfIt(result, command);
      }
      // Its own token is printed, and so is the token of the list as it was asked for, and no other.
      // Its own token is printed: the token of the list as it was asked for, which names the place of the last entry shown.
      const list: paging.ListDescriptor = paging.describeList(command.replaceAll("-", "_") as paging.PagedOperation);
      // A list of tasks to start is its user's own: its token names a user, which one the command line does not know.
      const owned = { q: paging.questionMark(list.question), ...(list.owner === paging.SOMEONE ? { w: paging.whoMark("USER-001") } : {}) };
      const after = (answer: any) => paging.sealToken({ ...owned, k: list.keyOf(answer[field].at(-1)) });
      let given = "";
      answering(asked, { change: (answer) => ({ ...answer, continuation: (given = after(answer)) }) });
      const goesOn = await cli(command);
      assert.equal(goesOn.code, 0, `${command}: ${goesOn.err}`);
      assert.match(goesOn.out, new RegExp(`Next page: add --continuation ${given}\n`), command);
      // The token of its own list for another place than that is not: it would pass entries over, or lead back.
      for (const [what, key] of [["a place beyond the last entry", list.keyOf({ id: "ZZZZZZZZ-999999", priority: -1e300 })], ["a place before it", list.keyOf({ id: "", priority: 1e300 })], ["no place of the list", {}]] as const) {
        answering(asked, { change: (answer) => ({ ...answer, continuation: paging.sealToken({ ...owned, k: key }) }) });
        const result = await cli(command);
        reported(result, new RegExp(`but not as ${command} does: ${what === "no place of the list" ? `"continuation" of a list is not a token of the list that was asked for` : `"${field}" of a list is not a page of that list: it goes on from another place than the furthest of its entries`}`), `${command} that goes on from ${what}`);
        nothingOfIt(result, command);
      }
      // Whose the list is, the token says as the list has it: a user where the list is nobody's own, or none where it is a user's, is another list's token.
      answering(asked, { change: (answer) => ({ ...answer, continuation: paging.sealToken({ q: owned.q, ...(list.owner === paging.SOMEONE ? {} : { w: paging.whoMark("USER-001") }), k: list.keyOf(answer[field].at(-1)) }) }) });
      reported(await cli(command), new RegExp(`but not as ${command} does: "continuation" of a list is not a token of the list that was asked for`), `${command} with a token that says another owner`);
    }
    answering("POST /api/list-tasks", { change: (answer) => ({ ...answer, continuation: lists.tasks }) });
    reported(await cli("list-tasks", "--status", "open"), /but not as list-tasks does: "continuation" of a list is not a token of the list that was asked for/, "the token of all tasks for the list of the open ones");
    swap = () => undefined;
    assert.equal((await cli("list-tasks")).code, 0);
  });
});

describe("a list that is none of the service's", () => {
  /**
   * Holds the table against one reader: each way of not being a list ends the reading at the answer that shows
   * it, with what is wrong said in the reader's own words, and a list that is one is read whole. `read` reads
   * the list from what answers; `said` is what the reader says of a reason.
   */
  async function against(what: string, target: Target, read: (answer: (sent: unknown) => { entries: unknown; continuation?: unknown }) => Promise<unknown[]>, said: (attack: Case) => string): Promise<number> {
    const table = adversary(paging, target);
    for (const attack of table) {
      let asked = 0;
      const reading = read((sent) => attack.page(++asked, sent));
      if (attack.why === null) {
        const all = await reading;
        // What a reading returns is what it was given, at most as much as anyone reads.
        assert.ok(all.length === attack.holds && all.length <= paging.READING.entries, `${what}, ${attack.name}: ${all.length} entries`);
      } else {
        await assert.rejects(reading, (error: unknown) => {
          assert.ok(error instanceof Error, `${what}, ${attack.name}`);
          assert.equal(error.message, said(attack), `${what}, ${attack.name}`);
          return true;
        });
      }
      // Nothing is asked for after the answer that was not one, and never more than a thousand pages.
      assert.equal(asked, attack.requests, `${what}, ${attack.name}: ${asked} pages were asked for`);
      assert.ok(asked <= paging.READING.pages);
    }
    return table.length;
  }
  const mark = (question: unknown, key: unknown, who?: string) => paging.sealToken({ q: paging.questionMark(question), ...(who === undefined ? {} : { w: paging.whoMark(who) }), k: key });

  it("is not read on by the engine's own reader, which the service starts and restores with: users, tasks under filters, and a user's own tasks to start", async () => {
    const real = await realTokens();
    const call = (field: string, answer: (sent: unknown) => { entries: unknown; continuation?: unknown }) => async (_operation: string, input: Record<string, unknown>) => {
      const page = answer(input.continuation);
      return { [field]: page.entries, ...(Object.hasOwn(page, "continuation") ? { continuation: page.continuation } : {}) };
    };
    const filters = { status: "open", project: "ALP" };
    const readers: Array<[operation: string, field: string, input: Record<string, unknown>, who: string | undefined, target: Target]> = [
      ["list_users", "users", {}, undefined, { list: "users", entries: "users", question: paging.questionOfList("list_users"), owner: "nobody", remembers: true, first: 0, held: 0, foreign: { "the list of tasks": real.tasks, "the list of projects": real.projects, "a list of an item": real.ofItem, "the list of users asked in another way": mark(["list_users", { type: "agent" }], "USER-5000001") } }],
      [
        "list_tasks",
        "tasks",
        filters,
        undefined,
        {
          list: "tasks",
          entries: "tasks",
          question: paging.questionOfList("list_tasks", filters),
          owner: "nobody",
          remembers: true,
          first: 0,
          held: 0,
          foreign: {
            "the list of users": real.users,
            "the list of all tasks": real.tasks,
            "the list of tasks to start": real.nextTasks,
            "the list of tasks under one of its filters": mark(paging.questionOfList("list_tasks", { status: "open" }), "ZZZ-1"),
            "the list of tasks under one filter more": mark(paging.questionOfList("list_tasks", { ...filters, top_level: true }), "ZZZ-1"),
            "the list of tasks of another project": mark(paging.questionOfList("list_tasks", { ...filters, project: "BET" }), "ZZZ-1"),
          },
        },
      ],
      [
        "list_next_tasks",
        "tasks",
        {},
        "USER-001",
        {
          list: "next_tasks",
          entries: "tasks",
          question: paging.questionOfList("list_next_tasks"),
          owner: { who: "USER-001" },
          remembers: true,
          first: 0,
          held: 0,
          foreign: { "the list of all tasks": real.tasks, "another user's list of tasks to start": mark(paging.questionOfList("list_next_tasks"), [-1e300, "ZZZ-1"], "USER-002"), "the list of tasks to start in a project": mark(paging.questionOfList("list_next_tasks", { project: "ALP" }), [-1e300, "ZZZ-1"], "USER-001") },
        },
      ],
    ];
    let held = 0;
    for (const [operation, field, input, who, target] of readers) {
      held += await against(`readAll of ${operation}`, target, (answer) => readAll(call(field, answer), operation, input, who), (attack) => `${operation} did not answer as its list does: ${attack.why}.`);
    }
    assert.ok(held > 90, `${held} ways`);
    // The filters are the same question in whatever order they are written.
    assert.equal((await readAll(call("tasks", () => ({ entries: [] })), "list_tasks", { project: "ALP", status: "open" })).length, 0);
  });

  it("is not read on by the command line where it reads all users: it stops at the first answer that is none, with a hundred thousand users or a thousand pages at most", async () => {
    const real = await realTokens();
    const target: Target = { list: "users", entries: "users", question: paging.questionOfList("list_users"), owner: "nobody", remembers: true, first: 0, held: 0, foreign: { "the list of tasks": real.tasks, "the list of projects": real.projects, "the list of tasks to start": real.nextTasks, "a list of an item": real.ofItem, "the list of users asked in another way": mark(["list_users", { type: "agent" }], "USER-5000001") } };
    // Whether what is listed are users, with an ID, a name and a type, is looked at first, by what the command line has for that.
    const notUsers = '"users" is not a list of users with an id, a username and a type';
    const client = (answer: (sent: unknown) => { entries: unknown; continuation?: unknown }) => ({
      base: "http://x",
      call: async (_operation: string, input: Record<string, unknown> = {}) => {
        const page = answer(input.continuation);
        return { users: page.entries, you: "admin", ...(Object.hasOwn(page, "continuation") ? { continuation: page.continuation } : {}) };
      },
    });
    const ways = await against("allUsers", target, (answer) => allUsers(client(answer)), (attack) => `http://x answered POST /api/list-users, but not as a Vigile service does: ${/no list|nothing where|no place in the list$/.test(attack.name) ? notUsers : attack.why}.`);
    assert.ok(ways > 30);
    // A hundred thousand users are read, however they come: in one page, in a thousand, in two.
    for (const sizes of [[100_000], [99_999, 1], [50_000, 50_000], Array.from({ length: 1000 }, () => 100)]) {
      const pages = sizes.map((size, n) => Array.from({ length: size }, (_, i) => ({ id: `USER-${sizes.slice(0, n).reduce((sum, earlier) => sum + earlier, 0) + i + 1}`, username: `u${n}x${i}`, type: "agent" })));
      let asked = 0;
      const all = await allUsers(client(() => {
        const n = asked++;
        return { entries: pages[n]!, ...(n + 1 < pages.length ? { continuation: mark(target.question, pages[n]!.at(-1)!.id) } : {}) };
      }));
      assert.deepEqual([all.length, asked], [100_000, sizes.length], `in pages of ${sizes.slice(0, 3).join(", ")}`);
    }
    // One more is not: whichever page brings it, the last one or one that goes on, nothing of that page is kept.
    for (const sizes of [[100_001], [100_000, 1], [99_999, 2], [1, 100_000]]) {
      const pages = sizes.map((size, n) => Array.from({ length: size }, (_, i) => ({ id: `USER-${sizes.slice(0, n).reduce((sum, earlier) => sum + earlier, 0) + i + 1}`, username: `u${n}x${i}`, type: "agent" })));
      let asked = 0;
      await assert.rejects(allUsers(client(() => {
        const n = asked++;
        return { entries: pages[n]!, ...(n + 1 < pages.length ? { continuation: mark(target.question, pages[n]!.at(-1)!.id) } : {}) };
      })), /but not as a Vigile service does: it holds more than 100000 users\.$/, `in pages of ${sizes.join(", ")}`);
      assert.equal(asked, sizes.length, `in pages of ${sizes.join(", ")}`);
    }
  });

  it("is not printed on by the command line: of no answer that is none of a list's own does it print how to read on, for the list operations and for each list of an item", async () => {
    const real = await realTokens();
    // Answers of a service, for what an entry of each list carries beside its key.
    const engine = await Engine.open({ storage: new MemoryStorage() });
    const admin = (name: string, input: Record<string, unknown> = {}): Promise<any> => engine.execute(name, "admin", input);
    await admin("create_project", { title: "A project", prefix: "ALP" });
    const made = await admin("create_task", { title: "A task", description: "d", project: "ALP" });
    const like = {
      users: (await admin("list_users")).users[0],
      tasks: (await admin("list_tasks")).tasks[0],
      projects: (await admin("list_projects")).projects[0],
      next_tasks: (await admin("list_next_tasks")).tasks[0],
    };
    const item = await admin("get", { id: made.id });
    const ref = { kind: "task", id: made.id as string };
    const dressed = (entry: unknown, template: object) => (isRecord(entry) && typeof entry.id === "string" ? { ...template, ...entry } : entry);
    const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
    /** Reads a list as the command does: one page for each call, each judged before anything of it is printed. The reading ends where a page is not printed. */
    const printed = (shape: (page: { entries: unknown; continuation?: unknown }, sent: unknown) => [operation: string, input: Record<string, unknown>, answer: unknown], from?: string) => async (answer: (sent: unknown) => { entries: unknown; continuation?: unknown }) => {
      const all: unknown[] = [];
      for (let sent: unknown = from; ; ) {
        const page = answer(sent);
        const [operation, input, shaped] = shape(page, sent);
        const why = judge(operation, input, JSON.parse(JSON.stringify(shaped)));
        if (why !== null) throw new Error(why);
        all.push(...(page.entries as unknown[]));
        if (!Object.hasOwn(page, "continuation")) return all;
        sent = page.continuation;
      }
    };
    /** What the command line says of an answer it does not print. Where the rules of a list say what is wrong, in their words; where the answer is no list of its operation at all, in those of the operation. */
    const inItsWords = /no continuation token|token of another list|names no place in the list|page that holds nothing|holds no list|no place in the list$/;
    const said = (attack: Case): RegExp => (inItsWords.test(attack.why!) ? /./s : new RegExp(attack.why!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const held = async (what: string, target: Target, read: ReturnType<typeof printed>) => {
      let ways = 0;
      for (const attack of adversary(paging, target).filter((one) => !one.limit)) {
        let asked = 0;
        const reading = read((sent) => attack.page(++asked, sent));
        if (attack.why === null) assert.equal((await reading).length, attack.holds, `${what}, ${attack.name}`);
        else {
          await assert.rejects(reading, (error: unknown) => {
            assert.match((error as Error).message, said(attack), `${what}, ${attack.name}`);
            return true;
          });
          ways++;
        }
        // The page that is none is not printed, and the one after it is never asked for.
        assert.equal(asked, attack.requests, `${what}, ${attack.name}: ${asked} pages`);
      }
      return ways;
    };
    const mark = (question: unknown, key: unknown, who?: string) => paging.sealToken({ q: paging.questionMark(question), ...(who === undefined ? {} : { w: paging.whoMark(who) }), k: key });
    let ways = 0;

    // The list operations.
    const operations: Array<[operation: paging.PagedOperation, list: Target["list"], input: Record<string, unknown>, foreign: Record<string, string>]> = [
      ["list_users", "users", {}, { "the list of tasks": real.tasks, "a list of an item": real.ofItem }],
      ["list_tasks", "tasks", { status: "open" }, { "the list of all tasks": real.tasks, "the list of users": real.users, "the list of tasks under another filter": mark(paging.questionOfList("list_tasks", { status: "done" }), "ZZZ-1001") }],
      ["list_projects", "projects", {}, { "the list of tasks": real.tasks, "the list of projects with problems": mark(paging.questionOfList("list_projects", { has_problems: true }), "9000000000000001") }],
      ["list_next_tasks", "next_tasks", { project: "ALP" }, { "the list of all tasks": real.tasks, "the list of tasks to start anywhere": real.nextTasks }],
    ];
    for (const [operation, list, input, foreign] of operations) {
      const described = paging.describeList(operation, input);
      const field = paging.PAGED[operation];
      const target: Target = { list, entries: described.entries, question: described.question, owner: list === "next_tasks" ? "someone" : "nobody", remembers: false, first: 0, held: 0, foreign };
      const shape = (page: { entries: unknown; continuation?: unknown }, sent: unknown): [string, Record<string, unknown>, unknown] => [
        operation,
        { ...input, ...(sent === undefined ? {} : { continuation: sent }) },
        { [field]: Array.isArray(page.entries) ? page.entries.map((entry) => dressed(entry, like[list as keyof typeof like])) : page.entries, ...(operation === "list_users" ? { you: "admin" } : {}), ...(Object.hasOwn(page, "continuation") ? { continuation: page.continuation } : {}) },
      ];
      ways += await held(operation, target, printed(shape));
    }

    // Each list of an item, read on from a page of it: its links under a name, its timeline, its history.
    const lists: Array<[at: paging.At, list: Target["list"], from: unknown]> = [
      [["links", "contains"], "links", "task:000"],
      [["links", "is depended on by"], "links", "project:ALP"],
      [["timeline"], "timeline", 1_000_000_000],
      [["history"], "history", [5, 0]],
    ];
    for (const [at, list, from] of lists) {
      const described: paging.ListDescriptor = paging.describeItemList(ref, at);
      const others = lists.filter(([other]) => other !== at).map(([other, , place]): [string, string] => [`the item's ${other.join(" ")}`, mark(paging.itemListQuestion(ref, other), place)]);
      const target: Target = {
        list,
        entries: described.entries,
        question: described.question,
        owner: "nobody",
        remembers: false,
        first: 1,
        held: 0,
        foreign: { "the list of tasks": real.tasks, "that list of another item": mark(paging.itemListQuestion({ kind: "task", id: "ALP-999" }, at), from), "that list of a project of the same ID": mark(paging.itemListQuestion({ kind: "project", id: ref.id }, at), from), ...Object.fromEntries(others) },
      };
      const shape = (page: { entries: unknown; continuation?: unknown }, sent: unknown): [string, Record<string, unknown>, unknown] => {
        const goesOn = Object.hasOwn(page, "continuation") ? { total: (Array.isArray(page.entries) ? page.entries.length : 0) + 5, continuation: page.continuation } : undefined;
        return [
          "get",
          { id: ref.id, continuation: sent },
          {
            kind: "task",
            id: ref.id,
            version: item.version,
            unchanged_since: item.unchanged_since,
            ...(at[0] === "links" ? { links: { [at[1]]: page.entries } } : { [at[0]]: page.entries }),
            ...(goesOn ? { more: at[0] === "links" ? { links: { [at[1]]: goesOn } } : { [at[0]]: goesOn } } : {}),
          },
        ];
      };
      ways += await held(`get, ${at.join(" ")}`, target, printed(shape, mark(described.question, from)));
    }
    assert.ok(ways > 250, `${ways} ways`);
  });
});

describe("the answer of each operation", () => {
  let directory: string;
  let service: Service;
  /** One call of every operation the engine has, as it was made, with what a real service answered. */
  const calls: Array<{ name: string; input: Record<string, unknown>; answer: unknown }> = [];
  const asSent = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
  const call = async (name: string, input: Record<string, unknown>): Promise<any> => asSent(await service.engine.execute(name, "admin", input));

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), "vigile-answers-"));
    const config = join(directory, "config.toml");
    initConfig(config, { name: "answers-test", port: await freePort() });
    service = await startService({ loaded: loadConfig(config, {}), log: () => {}, warn: () => {} });
    // Each call is about items of its own, so that no answer is about what another call asked for.
    await call("create_project", { title: "For tasks", prefix: "ALP" });
    await call("create_project", { title: "For a status", prefix: "BET" });
    for (const title of ["To update", "To move", "To restore", "To date", "To read", "To delete", "Waits", "Waited for", "Linked", "Linked to"]) await call("create_task", { title, description: "A task.", project: "ALP" });
    await call("delete", { id: "ALP-003", version: 1 });
    await call("add_link", { from: "ALP-009", type: "depends on", to: "ALP-010" });
    await call("create_user", { username: "resetme", type: "agent" });
    const made: Array<[string, Record<string, unknown>]> = [
      ["create_project", { title: "  Made by the call ", prefix: "gam" }],
      ["set_project_status", { id: "bet", version: 1, status: "in_preview" }],
      ["list_projects", {}],
      ["create_task", { title: "Made by the call", description: "A task.", project: "ALP" }],
      ["update_task", { id: "alp-1", version: 1, title: "Updated" }],
      ["set_task_status", { id: "ALP-002", version: 1, status: "in_progress" }],
      ["add_link", { from: "ALP-007", type: "depends on", to: "ALP-008" }],
      ["list_tasks", {}],
      ["list_next_tasks", {}],
      ["list_stale_tasks", {}],
      ["get", { id: "ALP-005", history: true }],
      ["delete", { id: "ALP-006", version: 1 }],
      ["restore", { id: "ALP-003" }],
      ["override_timestamp", { id: "ALP-004", version: 1, name: "created_at", value: "2020-01-02T03:04:05Z" }],
      ["remove_link", { from: "ALP-010", type: "is depended on by", to: "ALP-009" }],
      ["list_link_types", {}],
      ["create_user", { username: " Made ", type: "person" }],
      ["list_users", {}],
      ["reset_user_key", { user: "RESETME" }],
      ["get_guide", { topic: "working" }],
    ];
    for (const [name, input] of made) calls.push({ name, input, answer: await call(name, input) });
  });
  after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });

  it("is expected and printed by the operation that was called: every operation the engine has is known, and no other", () => {
    const names = OPERATIONS.map((operation) => operation.name).sort();
    assert.deepEqual(Object.keys(EXPECTED).sort(), names, "what each operation's answer has to carry (expected.ts)");
    for (const name of names) assert.ok(isPrinted(name), `how the answer of ${name} is printed (render.ts)`);
    assert.equal(isPrinted("constructor"), false);
    assert.match(judge("constructor", {}, {}) ?? "", /does not know what constructor answers/);
    assert.deepEqual(calls.map((call) => call.name).sort(), names, "this test calls every operation once");
  });

  it("is accepted for its own call and turned away for every other operation's, a real answer of each", () => {
    // A list of the tasks that can be started is a list of tasks: what list_next_tasks answers, list_tasks may
    // answer too. And what makes a new item answers with the item, as what changes one or brings one back does:
    // the call that makes one names no item that exists, so that the answer is held to being a task, a project,
    // a user with its key, and not to which one. No other answer of one operation is one of another.
    const alike = new Set([
      "list_tasks < list_next_tasks",
      // A task that is read in full carries all that a task carries where it is made or changed.
      "create_task < get",
      "create_task < update_task",
      "create_task < set_task_status",
      "create_task < restore",
      "create_task < override_timestamp",
      "create_project < set_project_status",
      "create_user < reset_user_key",
    ]);
    const ui = { fancy: false, paint: (_style: unknown, text: string) => text, out: () => {}, err: () => {} } as Ui;
    for (const call of calls) {
      assert.equal(judge(call.name, call.input, call.answer), null, `${call.name} takes its own answer: ${JSON.stringify(call.answer).slice(0, 300)}`);
      assert.doesNotThrow(() => renderResult(ui, call.name, call.answer, "http://x"), call.name);
      for (const other of calls) {
        if (other === call) continue;
        const why = judge(call.name, call.input, other.answer);
        if (alike.has(`${call.name} < ${other.name}`)) assert.equal(why, null, `${call.name} takes the answer of ${other.name}`);
        else assert.ok(typeof why === "string" && why.length > 0, `${call.name} turns away the answer of ${other.name}: ${JSON.stringify(other.answer).slice(0, 200)}`);
      }
    }
    // The list that is not all of tasks that can be started is not the answer of list_next_tasks.
    const answerOf = (name: string): any => calls.find((call) => call.name === name)!.answer;
    assert.ok(answerOf("list_tasks").tasks.some((task: { is_next: boolean }) => !task.is_next));
    assert.ok(answerOf("list_next_tasks").tasks.length > 0);
  });

  it("is about the item the call names, by the service's own rule for what a reference names", async () => {
    const answerOf = (name: string): any => calls.find((call) => call.name === name)!.answer;
    const project = await call("get", { id: "ALP" });
    const task = await call("get", { id: "ALP-005" });
    const user = await call("get", { id: "resetme" });
    // A get of a task is not answered by a project, nor by another task, nor by the kind that was not asked for.
    assert.match(judge("get", { id: "ALP-005" }, project) ?? "", /it is about the project ALP, and not about ALP-005/);
    assert.match(judge("get", { id: "ALP-005" }, await call("get", { id: "ALP-004" })) ?? "", /it is about the task ALP-004, and not about ALP-005/);
    assert.match(judge("get", { id: "ALP-005", kind: "project" }, task) ?? "", /it is not a project/);
    assert.match(judge("get", { id: "project:ALP-005" }, task) ?? "", /not about project:ALP-005/);
    // However the reference was typed, as the service takes it.
    for (const id of ["ALP-005", "alp-5", "task:alp-005", " ALP-0005 "]) assert.equal(judge("get", { id }, task), null, id);
    for (const id of ["ALP", "alp", "project:alp"]) assert.equal(judge("get", { id }, project), null, id);
    for (const id of ["resetme", "RESETME", user.id, `user:${user.id.toLowerCase()}`, "user:resetme"]) assert.equal(judge("get", { id }, user), null, id);
    assert.notEqual(judge("get", { id: "agent1" }, user), null);
    // A change is acknowledged by the item that was changed.
    const moved = answerOf("set_task_status");
    assert.equal(judge("set_task_status", { id: "alp-2", version: 1, status: "in_progress" }, moved), null);
    assert.match(judge("set_task_status", { id: "ALP-001", version: 1, status: "in_progress" }, moved) ?? "", /it is about the task ALP-002, and not about ALP-001/);
    assert.match(judge("update_task", { id: "ALP-002", version: 1, title: "Updated" }, answerOf("update_task")) ?? "", /it is about the task ALP-001, and not about ALP-002/);
    // A deletion: of the item that was named.
    const gone = answerOf("delete");
    assert.match(judge("delete", { id: "ALP-005", version: 1 }, gone) ?? "", /it is about the task ALP-006, and not about ALP-005/);
    assert.match(judge("delete", { id: "ALP-006", kind: "project", version: 1 }, gone) ?? "", /not about ALP-006/);
    assert.equal(judge("delete", { id: "task:alp-6", version: 1 }, gone), null);
    // A user that was named by its username comes back as its ID: which user it is, only the service knows.
    assert.equal(judge("delete", { id: "resetme", kind: "user", version: 1 }, { deleted: true, permanent: false, kind: "user", id: user.id }), null);
    assert.notEqual(judge("delete", { id: "USER-001", version: 1 }, { deleted: true, permanent: false, kind: "user", id: user.id }), null);
    // A link: the one that was asked for, by either name of its type, and what became of it as that operation says it.
    const added = answerOf("add_link");
    assert.deepEqual(added, { created: true, link: { from: "ALP-007", type: "depends on", to: "ALP-008" } });
    assert.equal(judge("add_link", { from: "alp-8", type: "Is depended on by", to: "task:ALP-007" }, added), null);
    assert.equal(judge("add_link", { from: "ALP-007", type: "depends on", to: "ALP-008" }, { ...added, created: false }), null);
    assert.match(judge("add_link", { from: "ALP-008", type: "depends on", to: "ALP-007" }, added) ?? "", /not the one that was asked for/);
    assert.match(judge("add_link", { from: "ALP-007", type: "contains", to: "ALP-008" }, added) ?? "", /it is about a link "depends on", and not "contains"/);
    assert.match(judge("add_link", { from: "ALP-007", type: "depends on", to: "ALP-008" }, { ...added, created: "true" }) ?? "", /"created" of what became of a link is not yes or no/);
    assert.match(judge("remove_link", { from: "ALP-007", type: "depends on", to: "ALP-008" }, { created: false, link: added.link }) ?? "", /"removed" of what became of a link is not true/);
    assert.equal(judge("add_link", { from: "ALP-001", type: "assigned to", to: "resetme" }, await call("add_link", { from: "ALP-001", type: "assigned to", to: "resetme" })), null);
    // Where the item cannot be told apart, a user named by its username and answered by its ID, the answer
    // is still the ID of a user, in the form the store has it in: not a task's, not a name, not another spelling.
    const removed = (id: unknown, kind = "user") => ({ deleted: true, permanent: false, kind, id });
    assert.equal(judge("delete", { id: "resetme", kind: "user", version: 1 }, removed("USER-001")), null, "any user, when only the name is known");
    for (const id of ["SHP-001", "ALP-006", "resetme", "user-1", "USER-1", "task:USER-001", "ALP", "042", "", 7]) {
      assert.match(judge("delete", { id: "resetme", kind: "user", version: 1 }, removed(id)) ?? "", /"id" of a deletion is not (the ID of a user|a text)/, `a user that was deleted, answered with ${JSON.stringify(id)}`);
      assert.notEqual(judge("delete", { id: "resetme", version: 1 }, removed(id)), null, `the same without the kind: ${JSON.stringify(id)}`);
    }
    // The kind the answer says and the ID it gives go together, whatever was asked.
    assert.match(judge("delete", { id: "ALP-006", version: 1 }, removed("alp-006", "task")) ?? "", /"id" of a deletion is not the ID of a task/);
    assert.match(judge("delete", { id: "ALP-006", version: 1 }, removed("USER-001", "task")) ?? "", /it is about the task USER-001, and not about ALP-006/);
    assert.match(judge("delete", { id: "ALP", version: 1 }, removed("ALP-006", "project")) ?? "", /"id" of a deletion is not the ID of a project/);
    assert.match(judge("delete", { id: "042", kind: "project", version: 1 }, removed("042", "project")) ?? "", /"id" of a deletion is not the ID of a project/, "a project whose ID is a number is written with its kind in front");
    assert.equal(judge("delete", { id: "42", kind: "project", version: 1 }, removed("project:042", "project")), null);
    assert.equal(judge("delete", { id: "42", kind: "task", version: 1 }, removed("042", "task")), null);
    // The ends of a link: a user that was named by its username comes back as a user's ID, and as nothing else.
    const assigning = { from: "ALP-001", type: "assigned to", to: "resetme" };
    const assignedTo = (to: unknown, from: unknown = "ALP-001") => ({ created: true, link: { from, type: "assigned to", to } });
    assert.equal(judge("add_link", assigning, assignedTo(user.id)), null);
    assert.equal(judge("add_link", assigning, assignedTo("USER-001")), null, "any user, when only the name is known");
    for (const to of ["ALP-001", "resetme", "user-1", "USER-1", "user:USER-001", "ALP", "042"]) assert.match(judge("add_link", assigning, assignedTo(to)) ?? "", /not the one that was asked for/, `assigned to ${to}`);
    for (const from of ["alp-001", "ALP-1", "task:ALP-001", "USER-001", "ALP"]) assert.match(judge("add_link", assigning, assignedTo(user.id, from)) ?? "", /not the one that was asked for/, `assigned from ${from}`);
    assert.match(judge("add_link", { ...assigning, to: user.id }, assignedTo("USER-001")) ?? "", /not the one that was asked for/, "by its ID, a user is that user");
    // That is where the comparison with the call ends. Whether the values of the item are the ones that were
    // asked for is the service's to decide, by rules that are the engine's: what is given twice is taken once,
    // a name and an ID can be the same user, what was left out is filled in. An answer of the right shape is
    // taken with whatever values it has, and what it is made of is still held to its kind.
    const made = answerOf("create_task");
    const making = { title: "Made by the call", description: "A task.", project: "ALP" };
    const whatever: Array<[what: string, input: Record<string, unknown>, answer: unknown]> = [
      ["with another title", { ...making, title: "Another title" }, made],
      ["of another type, at another priority, as a draft", { ...making, type: "bug", priority: 3, draft: true }, made],
      ["in another project", making, { ...made, contained_in: ["BET"] }],
      ["depending on what was asked twice and on what was not", { ...making, depends_on: ["ALP-001", "ALP-001"] }, { ...made, depends_on: ["ALP-001", "BET-002"] }],
      ["assigned to nobody, when a user was named by its ID", { ...making, assigned_to: ["USER-001"] }, { ...made, assigned_to: [] }],
      ["assigned to someone else", { ...making, assigned_to: ["resetme"] }, { ...made, assigned_to: ["admin"] }],
    ];
    for (const [what, input, answer] of whatever) assert.equal(judge("create_task", input, answer), null, `a task that was made ${what} is the service's answer`);
    const ofAnotherKind: Array<[what: string, answer: unknown, says: RegExp]> = [
      ["a number among the users it is assigned to", { ...made, assigned_to: [5] }, /"assigned_to" of the task is not a list of usernames/],
      ["what is no username among them", { ...made, assigned_to: ["USER-001"] }, /"assigned_to" of the task is not a list of usernames/],
      ["users that are a text", { ...made, assigned_to: "admin" }, /"assigned_to" of the task is not a list of usernames/],
      ["a dependency in another spelling", { ...made, depends_on: ["alp-1"] }, /"depends_on" of the task is not a list of the tasks and projects it depends on/],
      ["a name among its dependencies", { ...made, depends_on: ["resetme"] }, /"depends_on" of the task is not a list of the tasks and projects it depends on/],
      ["a number among its dependencies", { ...made, depends_on: [7] }, /"depends_on" of the task is not a list of the tasks and projects it depends on/],
      ["a name among what it is in", { ...made, contained_in: ["resetme"] }, /"contained_in" of the task is not a list of the projects and tasks it is in/],
      ["an ID in a form no task has", { ...made, id: "alp-1" }, /"id" of the task is not the ID of a task/],
      ["a priority that is a text", { ...made, priority: "3" }, /"priority" of the task is not a number/],
    ];
    for (const [what, answer, says] of ofAnotherKind) {
      // With the very call that asked for a user by its ID: it is the kind of what came back that turns it away.
      assert.match(judge("create_task", { ...making, assigned_to: ["USER-001"], depends_on: ["ALP-001"] }, answer) ?? "", says, `a task with ${what}`);
    }
    const stored = answerOf("update_task");
    assert.equal(judge("update_task", { id: "ALP-001", version: 1, title: "Another title", priority: 9 }, stored), null);
    assert.equal(judge("set_task_status", { id: "ALP-002", version: 1, status: "done" }, moved), null);
    assert.equal(judge("create_project", { title: "Another", prefix: "DEL" }, answerOf("create_project")), null);
    assert.equal(judge("create_user", { username: "another", type: "agent" }, answerOf("create_user")), null);
    assert.equal(judge("delete", { id: "ALP-006", version: 1, permanent: true }, gone), null);
    assert.match(judge("delete", { id: "ALP-006", version: 1, permanent: true }, { ...gone, permanent: "true" }) ?? "", /"permanent" of a deletion is not yes or no/);
    assert.match(judge("create_user", { username: "made", type: "person" }, { ...answerOf("create_user"), user: { ...answerOf("create_user").user, id: "ALP-001" } }) ?? "", /"id" of the user is not the ID of a user/);
    // A key: for the user that was asked for.
    assert.match(judge("reset_user_key", { user: "agent1" }, answerOf("reset_user_key")) ?? "", /it is about the user USER-\d+, and not about agent1/);
    assert.match(judge("get_guide", { topic: "examples" }, answerOf("get_guide")) ?? "", /"topic" of a guide is not "examples"/);
    assert.equal(judge("get_guide", {}, answerOf("get_guide")), null);
  });
  /**
   * Holds answers of a real service against what is expected of them, field by field: each is taken as it is,
   * turned away without a field the service always sends, taken without one it sends only when there is
   * something to say, and turned away with any field as another kind than it is. Says how many were tried.
   */
  const held = (answers: Array<[what: string, name: string, input: Record<string, unknown>, answer: any]>): number => {
    // The fields the service sends only when there is something to say, and what a history entry says in a shape
    // of its own, which is not looked into.
    const mayBeAbsent = (path: string[], of: { kind?: unknown }, input: Record<string, unknown>, answer: any): boolean => {
      const last = path.at(-1)!;
      // The next page of one list, which get answers to a call with a continuation, is that list: without it
      // there is no page. A page of links is under the one name those links read by.
      if (input.continuation !== undefined && ["links", "timeline", "history"].includes(path[0]!) && path.length <= (path[0] === "links" ? 2 : 1)) return false;
      // What says that lists go on is there only when one does, and names only those that do: it may be absent,
      // and so may any list in it but the last, without which it would name none. Of a list that is named,
      // how many it has is always said, and of one that can be read on the token that does: never one without
      // the other.
      if (path[0] === "more") {
        if (path.length === 1) return true;
        if (last === "total" || last === "continuation") return false;
        return Object.keys(of).length > 1;
      }
      // A list that is said to go on is there.
      const cut = answer?.more ?? {};
      if (path.length === 1 && Object.hasOwn(cut, last)) return false;
      if (path.length === 2 && path[0] === "links" && Object.hasOwn(cut.links ?? {}, last)) return false;
      if (["problems", "completed_at", "deleted_at", "continuation", "warning", "history"].includes(last)) return true;
      // How far a task has come is said only of one that contains others. Of a project it is always said.
      if (last === "progress") return of.kind === "task";
      const links = path.lastIndexOf("links");
      // A name under which nothing is linked is not sent; of a linked item, its status and that it is deleted.
      return links >= 0 && (path.length === links + 2 || (path.length === links + 4 && (last === "status" || last === "deleted")));
    };
    const free = (path: string[]): boolean => path.includes("data") && path[path.indexOf("data") - 2] === "history";
    // A value of another kind than the one that is there. A text is never put where nothing may be: text may be.
    const wrongFor = (value: unknown): unknown[] => {
      if (typeof value === "string") return [5, {}];
      if (typeof value === "number") return [String(value), true];
      if (typeof value === "boolean") return [String(value), 1];
      if (value === null) return [{}, true];
      if (Array.isArray(value)) return ["x", {}];
      return ["x", []];
    };
    const at = (root: any, path: string[]): any => path.reduce((node, key) => node[key], root);
    const copy = (root: unknown): any => JSON.parse(JSON.stringify(root));
    const paths = (node: unknown, path: string[] = []): string[][] => {
      if (free(path) || node === null || typeof node !== "object") return [];
      return Object.keys(node).flatMap((key) => [[...path, key], ...paths((node as Record<string, unknown>)[key], [...path, key])]);
    };
    let tried = 0;
    for (const [what, name, input, answer] of answers) {
      assert.equal(judge(name, input, answer), null, `${what} is taken as it is`);
      for (const path of paths(answer)) {
        const parent = at(answer, path.slice(0, -1));
        const where = `${what}: ${path.join(".")}`;
        if (!Array.isArray(parent)) {
          const without = copy(answer);
          delete at(without, path.slice(0, -1))[path.at(-1)!];
          const why = judge(name, input, without);
          if (mayBeAbsent(path, parent, input, answer)) assert.equal(why, null, `${where} may be absent`);
          else assert.ok(typeof why === "string", `${where} is required: without it the answer is turned away`);
          tried++;
        }
        for (const wrong of wrongFor(at(answer, path))) {
          const other = copy(answer);
          at(other, path.slice(0, -1))[path.at(-1)!] = wrong;
          assert.ok(typeof judge(name, input, other) === "string", `${where} as ${JSON.stringify(wrong)} is turned away`);
          tried++;
        }
      }
    }
    return tried;
  };

  it("has every field the service sends, of the kind the service sends it as: one that is missing or of another kind is turned away", async () => {
    // Items that carry all a service can say of an item: a task that contains another, waits for one, is
    // assigned, has a problem and is finished or deleted; a project with a problem; every kind of link.
    await call("add_link", { from: "ALP-005", type: "assigned to", to: "resetme" });
    await call("create_task", { title: "Inside", description: "A task.", project: "ALP", parent: "ALP-005" });
    await call("add_link", { from: "ALP-005", type: "depends on", to: "ALP-008" });
    await call("set_project_status", { id: "ALP", version: 1, status: "ready" });
    const started = await call("set_task_status", { id: "ALP-004", version: 2, status: "in_progress" });
    await call("set_task_status", { id: "ALP-004", version: started.version, status: "done" });
    const answers: Array<[what: string, name: string, input: Record<string, unknown>, answer: any]> = [];
    for (const { name, input, answer } of calls) answers.push([`the answer of ${name}`, name, input, answer]);
    for (const [name, input] of [
      ["list_tasks", {}],
      ["list_next_tasks", {}],
      ["list_projects", {}],
      ["list_users", {}],
      ["get", { id: "ALP-005", history: true }],
      ["get", { id: "ALP-004", history: true }],
      ["get", { id: "ALP-006" }],
      ["get", { id: "ALP", history: true }],
      ["get", { id: "resetme", history: true }],
    ] as Array<[string, Record<string, unknown>]>) {
      answers.push([`${name} ${JSON.stringify(input)}`, name, input, await call(name, input)]);
    }
    // What the items show between them: every field that is sent only when there is something to say.
    const tasks: any[] = (await call("list_tasks", {})).tasks;
    const read = await call("get", { id: "ALP-005", history: true });
    assert.ok(tasks.some((task) => task.problems?.length) || (await call("list_projects", {})).projects.some((project: any) => project.problems?.length), "an item with a problem");
    assert.ok(tasks.some((task) => task.progress) && tasks.some((task) => task.completed_at) && tasks.some((task) => task.is_waiting && task.waiting_for.length && task.depends_on.length) && tasks.some((task) => task.assigned_to.length && task.contained_in.length));
    assert.ok((await call("get", { id: "ALP-006" })).deleted_at, "a deleted item");
    assert.ok(Object.keys(read.links).length >= 3 && read.timeline.length && read.history.length, JSON.stringify(read.links));

    const tried = held(answers);
    assert.ok(tried > 2000, `${tried} answers with one field missing or of another kind`);

    // Of the right kind and still not what the service sends: a version that is no whole number from 1 up, an
    // ID that is not in the form it is stored in, a status the kind does not have, a moment that is none.
    const task = await call("get", { id: "ALP-005" });
    const project = await call("get", { id: "ALP" });
    const user = await call("get", { id: "resetme" });
    const notThat: Array<[item: any, id: string, field: string, values: unknown[], says: RegExp]> = [
      ...[task, project, user].map((item): [any, string, string, unknown[], RegExp] => [item, item.kind === "user" ? "resetme" : item.id, "version", [0, -1, 1.5, 1e400, Number.NaN], /"version" of the \w+ is not a whole number from 1 up/]),
      [task, "ALP-005", "status", ["ready", "nonsense", ""], /"status" of the task is not one of draft, open, in_progress, paused, in_review, done, cancelled/],
      [project, "ALP", "status", ["done", "nonsense"], /"status" of the project is not one of open, in_preview, ready, broken, cancelled/],
      [task, "ALP-005", "type", ["novel"], /"type" of the task is not one of task, bug, issue, incident/],
      [user, "resetme", "type", ["robot"], /"type" of the user is not one of admin, person, agent/],
      [user, "resetme", "username", ["Reset Me", ""], /"username" of the user is not a username/],
      // A moment is any text that names one, as in what is stored: a date alone is one. What names none is not.
      [task, "ALP-005", "created_at", ["yesterday", "2026-13-45T00:00:00Z", "", "at some time"], /"created_at" of the task is not a moment/],
      [task, "ALP-005", "updated_at", ["soon"], /"updated_at" of the task is not a moment/],
      [task, "ALP-005", "progress", [{ finished: 1.5, total: 2 }, { finished: -1, total: 2 }, { finished: 1 }], /"progress" of the task is not how many are finished, and of how many/],
      [task, "ALP-005", "assigned_to", [["Not A Name"], [""]], /"assigned_to" of the task is not a list of usernames/],
      [task, "ALP-005", "contained_in", [[""], ["alp"], ["resetme"], ["task:ALP-001"], ["042x"]], /"contained_in" of the task is not a list of the projects and tasks it is in/],
      [task, "ALP-005", "depends_on", [["resetme"], ["project:ALP"], ["ALP-8"]], /"depends_on" of the task is not a list of the tasks and projects it depends on/],
      [task, "ALP-005", "waiting_for", [["resetme"]], /"waiting_for" of the task is not a list of the tasks and projects it waits for/],
      [task, "ALP-005", "created_by", ["Not A Name", "USER-x", "ALP-001", ""], /"created_by" of the task is not a username or the ID of a user/],
      [
        task,
        "ALP-005",
        "links",
        [
          { "is friends with": [] },
          { contains: [{ kind: "thing", id: "X", title: "T" }] },
          { contains: [{ kind: "task", id: "", title: "T" }] },
          // What is linked is named as an item of the kind it says it is: not a user by a task's ID, nor a task by a name.
          { contains: [{ kind: "task", id: "alp-1", title: "T" }] },
          { "assigned to": [{ kind: "user", id: "ALP-001", title: "resetme" }] },
          { "assigned to": [{ kind: "user", id: "resetme", title: "resetme" }] },
          { "depends on": [{ kind: "project", id: "alp", title: "T" }] },
        ],
        /"links" of the task is not the links of the item/,
      ],
      [task, "ALP-005", "timeline", [[{ status: "ready", at: task.created_at, by: "admin" }], [{ status: "open", at: "then", by: "admin" }]], /"timeline" of the task is not a timeline/],
    ];
    for (const [item, id, field, values, says] of notThat) {
      for (const value of values) assert.match(judge("get", { id }, { ...item, [field]: value }) ?? "", says, `${item.kind}.${field} as ${JSON.stringify(value)}`);
    }
    // An ID in another form than the store writes it in is not the item's ID, whatever the call named.
    for (const [item, id] of [[task, "alp-005"], [task, "ALP-5"], [project, "alp"], [user, user.id.toLowerCase()], [user, "USER-9"]] as Array<[any, string]>) {
      assert.match(judge("get", { id }, { ...item, id }) ?? "", /"id" of the \w+ is not the ID of a \w+/, `${item.kind} with the ID ${id}`);
    }
  });

  it("has what says that a list is longer than a page: the lists of get that are cut, the next page of one of them, which is no whole item, and the next page of users", async () => {
    // A task with more than a page of everything a task has lists of: tasks in it and tasks it is in, tasks it
    // waits for, users it is assigned to, statuses it has had, changes that were recorded. A project and a
    // user with more than a page of links.
    const over = SIZES.page + 1;
    await call("create_project", { title: "Long lists", prefix: "LNG" });
    await call("create_user", { username: "manyhands", type: "agent" });
    const many: string = (await call("create_task", { title: "Many of everything", description: "A task.", project: "LNG" })).id;
    let version = 1;
    for (let n = 0; n < over; n++) version = (await call("set_task_status", { id: many, version, status: n % 2 ? "paused" : "in_progress" })).version;
    for (let n = 0; n < over; n++) {
      await call("create_task", { title: `Inside ${n}`, description: "A task.", project: "LNG", parent: many });
      const needed = await call("create_task", { title: `Needed ${n}`, description: "A task.", project: "LNG", assigned_to: ["manyhands"] });
      await call("add_link", { from: many, type: "depends on", to: needed.id });
      const holder = await call("create_task", { title: `Holds ${n}`, description: "A task.", project: "LNG" });
      await call("add_link", { from: holder.id, type: "contains", to: many });
      await call("create_user", { username: `hand${n}`, type: "agent" });
      await call("add_link", { from: many, type: "assigned to", to: `hand${n}` });
    }
    const whole = await call("get", { id: many, history: true });
    const project = await call("get", { id: "LNG" });
    const user = await call("get", { id: "manyhands" });
    assert.deepEqual(Object.keys(whole.more).sort(), ["assigned_to", "contained_in", "depends_on", "history", "links", "timeline", "waiting_for"], "every list of the task is cut");
    assert.deepEqual(Object.keys(whole.more.links).sort(), ["assigned to", "contains", "depends on", "is contained"]);
    assert.deepEqual([Object.keys(project.more), Object.keys(project.more.links), Object.keys(user.more), Object.keys(user.more.links)], [["links"], ["contains"], ["links"], ["is assigned"]]);

    const answers: Array<[what: string, name: string, input: Record<string, unknown>, answer: any]> = [
      ["a task whose lists are cut", "get", { id: many, history: true }, whole],
      ["a project whose links are cut", "get", { id: "LNG" }, project],
      ["a user whose links are cut", "get", { id: "manyhands" }, user],
    ];
    // The next page of each list: every list of links by its name, the timeline, the history.
    const pages: Record<string, any> = {};
    const next = async (id: string, of: string, continuation: string) => {
      const input = { id, continuation };
      pages[of] = await call("get", input);
      answers.push([`the next page of ${of}`, "get", input, pages[of]]);
    };
    for (const [name, part] of Object.entries(whole.more.links) as Array<[string, { continuation: string }]>) await next(many, `the task's links "${name}"`, part.continuation);
    await next(many, "the task's timeline", whole.more.timeline.continuation);
    await next(many, "the task's history", whole.more.history.continuation);
    await next("lng", "the project's links", project.more.links.contains.continuation);
    await next("manyhands", "the user's links", user.more.links["is assigned"].continuation);
    // A page that is not the last says where the one after it begins, and a page of links that holds nothing
    // still says which links it is of.
    const history = pages["the task's history"];
    assert.ok(history.history.length === SIZES.page && history.more.history.continuation, "the history goes on after its second page");
    const last = pages[`the task's links "contains"`];
    assert.deepEqual([Object.keys(last), last.links.contains.length], [["kind", "id", "version", "unchanged_since", "links"], 1]);
    // Users: the first page, which says where the next begins, and the next, which is the last.
    const users = await call("list_users", {});
    assert.equal(users.users.length, SIZES.page);
    answers.push(["the first page of users", "list_users", {}, users], ["the next page of users", "list_users", { continuation: users.continuation }, await call("list_users", { continuation: users.continuation })]);
    for (const name of ["list_tasks", "list_next_tasks"]) answers.push([`the first page of ${name}`, name, {}, await call(name, {})]);

    const tried = held(answers);
    assert.ok(tried > 5000, `${tried} answers with one field missing or of another kind`);
    // Each is printed, as the answer to the call it answers.
    const lines: string[] = [];
    const ui = { fancy: false, paint: (_style: unknown, text: string) => text, out: (line = "") => void lines.push(line), err: (line = "") => void lines.push(line) } as Ui;
    for (const [what, name, input, answer] of answers) {
      assert.doesNotThrow(() => renderResult(ui, name, answer, "http://x", input), what);
      const printed = lines.splice(0).join("\n");
      assert.equal(/undefined|\[object/.test(printed), false, `${what}: ${printed.slice(0, 300)}`);
      if (name === "get") assert.match(printed, input.continuation === undefined ? /Unchanged since {2}revision \d+\n/ : /A page of the item as it is unchanged since revision \d+\./, what);
    }

    // The answer to a call with a continuation is a page, and the answer to one without is the item: neither is
    // taken for the other, whatever it carries.
    const tokens = { history: whole.more.history.continuation as string, timeline: whole.more.timeline.continuation as string, contains: whole.more.links.contains.continuation as string };
    const continued = { id: many, continuation: tokens.history };
    const ofLinks = { id: many, continuation: tokens.contains };
    assert.match(judge("get", continued, whole) ?? "", /it is not one list of the task: a page carries its links, its timeline or its history, and one of them/);
    assert.match(judge("get", { id: many }, history) ?? "", /of the task is not/);
    assert.match(judge("get", continued, { ...history, timeline: [] }) ?? "", /it is not one list of the task/);
    assert.match(judge("get", continued, { kind: "task", id: many, version: 1, unchanged_since: 1 }) ?? "", /it is not one list of the task/);
    assert.match(judge("get", ofLinks, { ...last, links: { ...last.links, "depends on": [] } }) ?? "", /"links" of a page of the task is not one list of links, under the name it reads by/);
    assert.match(judge("get", ofLinks, { ...last, links: {} }) ?? "", /"links" of a page of the task is not one list of links/);
    assert.equal(judge("get", ofLinks, { ...last, links: { contains: [] } }), null, "a page of links that holds nothing");
    // A page is about the item the call names, by the rule that holds for the item in full.
    for (const id of [many, many.toLowerCase(), `task:${many}`]) assert.equal(judge("get", { ...continued, id }, history), null, id);
    assert.match(judge("get", { ...continued, id: "ALP-005" }, history) ?? "", new RegExp(`it is about the task ${many}, and not about ALP-005`));
    assert.match(judge("get", { ...continued, kind: "project" }, history) ?? "", /it is not a page of a project/);
    assert.match(judge("get", { ...continued, id: `project:${many}` }, history) ?? "", /and not about project:/);
    assert.match(judge("get", continued, { ...history, id: many.toLowerCase() }) ?? "", /"id" of a page of the task is not the ID of a task/);
    // And its list is the one the token of the call reads on in: of that item, and of no other list of it. Which
    // list a token is for is read from the token, as the service reads it.
    const notTheList = /and not of the list the continuation of the call reads on in/;
    assert.match(judge("get", { id: many, continuation: tokens.timeline }, history) ?? "", notTheList, "a page of history to a token of the timeline");
    assert.match(judge("get", continued, pages["the task's timeline"]) ?? "", notTheList, "a page of the timeline to a token of the history");
    assert.match(judge("get", continued, last) ?? "", notTheList, "a page of links to a token of the history");
    assert.match(judge("get", ofLinks, { ...last, links: { "depends on": [] } }) ?? "", notTheList, "a page of links under another name");
    assert.match(judge("get", { id: many, continuation: project.more.links.contains.continuation }, last) ?? "", notTheList, "a page of the task to a token of the project");
    for (const none of ["x", "", "not a token", tokens.history.slice(0, -4), 5, null]) assert.match(judge("get", { id: many, continuation: none }, history) ?? "", notTheList, `a page to what is no token: ${JSON.stringify(none)}`);
    // A user that was named by its username comes back as its ID, and a page carries no username: the token
    // says which user's list it continues. Named by its ID, a user is that user.
    const ofUser = pages["the user's links"];
    const hands = user.more.links["is assigned"].continuation as string;
    for (const id of ["manyhands", "MANYHANDS", "user:manyhands", ofUser.id, `user:${ofUser.id.toLowerCase()}`]) assert.equal(judge("get", { id, continuation: hands }, ofUser), null, id);
    assert.notEqual(judge("get", { id: "USER-001", continuation: hands }, ofUser), null);
    assert.match(judge("get", { id: "manyhands", continuation: hands }, { ...ofUser, id: "USER-001" }) ?? "", notTheList, "a page of another user's links, to a call that names a user by its name");
    assert.match(judge("get", { id: "manyhands", continuation: hands }, { ...ofUser, id: "manyhands" }) ?? "", /"id" of a page of the user is not the ID of a user/);
    assert.match(judge("get", { id: "manyhands", continuation: hands }, { kind: "user", id: ofUser.id, version: 1, unchanged_since: 1, timeline: [] }) ?? "", /it is not one list of the user/, "a user has no timeline");

    // What says that a list goes on says the same as the service, and no less. A list that can be read on, the
    // links under a name, the timeline, the history, is named with how many it has, more than are shown, and
    // with its token: never one without the other, and the token is that list's, of that item. A list of the
    // task's summary is named with how many it has and no token. What is named is in the answer, a page names
    // its own list and no other, and what names nothing is not sent.
    const cut = (item: any, change: (more: any) => void): any => {
      const changed = JSON.parse(JSON.stringify(item));
      change(changed.more);
      return changed;
    };
    const noToken = (list: string) => new RegExp(`"more\\.${list}\\.continuation" of (the task|a page of the task) is not the token that reads on in that list`);
    const howMany = (list: string, shown: number) => new RegExp(`"more\\.${list}" of (the task|a page of the task) does not say how many entries the list has in all, more than the ${shown} that are shown`);
    const shown = SIZES.page;
    const inFull = { id: many, history: true };
    const notSo: Array<[what: string, input: Record<string, unknown>, answer: unknown, says: RegExp]> = [
      // The token: there, a token, and the token of that list.
      ...["history", "timeline", "links.contains"].flatMap((list): Array<[string, Record<string, unknown>, unknown, RegExp]> => {
        const part = (more: any) => (list === "links.contains" ? more.links.contains : more[list]);
        const set = (value: unknown) => cut(whole, (more) => void (part(more).continuation = value));
        return [
          [`${list} that goes on without a token`, inFull, cut(whole, (more) => void delete part(more).continuation), noToken(list)],
          ...["", "x", "tok-1", "a b", "$(reboot)", "x; rm -rf ~", `-${tokens.history}`, `${tokens.history} `, `${tokens.history}=`, `"${tokens.history}"`, "x".repeat(2000), 5, null, {}, [tokens.history]].map((value): [string, Record<string, unknown>, unknown, RegExp] => [
            `${list} that goes on with ${JSON.stringify(value).slice(0, 40)} for a token`,
            inFull,
            set(value),
            noToken(list),
          ]),
          [`${list} with the token of another list`, inFull, set(list === "history" ? tokens.timeline : tokens.history), noToken(list)],
          [`${list} with the token of that list of another item`, inFull, set(project.more.links.contains.continuation), noToken(list)],
          [`${list} that has as many as are shown`, inFull, cut(whole, (more) => void (part(more).total = shown)), howMany(list, shown)],
          [`${list} that has fewer than are shown`, inFull, cut(whole, (more) => void (part(more).total = shown - 1)), howMany(list, shown)],
          [`${list} that has -1`, inFull, cut(whole, (more) => void (part(more).total = -1)), howMany(list, shown)],
          [`${list} that has 150.5`, inFull, cut(whole, (more) => void (part(more).total = 150.5)), howMany(list, shown)],
          [`${list} that has more than can be counted`, inFull, cut(whole, (more) => void (part(more).total = 1e21)), howMany(list, shown)],
        ];
      }),
      ["a history that goes on, of which nothing is shown", inFull, { ...whole, history: [] }, howMany("history", 0)],
      // The lists of the summary: counted, and not read on by themselves.
      ...["contained_in", "depends_on", "assigned_to", "waiting_for"].flatMap((list): Array<[string, Record<string, unknown>, unknown, RegExp]> => [
        [`${list} with a token`, inFull, cut(whole, (more) => void (more[list].continuation = tokens.history)), new RegExp(`"more\\.${list}" of the task carries a token, and the list is not read on by itself`)],
        [`${list} that has as many as are shown`, inFull, cut(whole, (more) => void (more[list].total = shown)), howMany(list, shown)],
        [`${list} that does not say how many`, inFull, cut(whole, (more) => void (more[list] = {})), howMany(list, shown)],
        [`${list} in a page`, continued, { ...history, more: { ...history.more, [list]: { total: 300 } } }, new RegExp(`"more\\.${list}" of a page of the task is about another list than the page holds`)],
      ]),
      // What is named is there.
      ["what names no list", inFull, { ...whole, more: {} }, /"more" of the task names no list that goes on/],
      ["what names only what is no list", inFull, { ...whole, more: { pages: 3 } }, /"more" of the task names no list that goes on/],
      ["what is no object", inFull, { ...whole, more: [whole.more] }, /"more" of the task is not which lists go on/],
      ["links that go on under no name", inFull, cut(whole, (more) => void (more.links = {})), /"more\.links" of the task is not which lists of links go on, by what they say/],
      ["links that go on under a name no link reads by", inFull, cut(whole, (more) => void (more.links["is friends with"] = more.links.contains)), /"more\.links" of the task is not which lists of links go on/],
      ["links that go on under a name the item has none under", inFull, cut(whole, (more) => void (more.links["is depended on by"] = more.links.contains)), /"more\.links\.is depended on by" of the task is about a list the answer does not carry/],
      ["a history that goes on in an answer without one", { id: many }, { ...cut(whole, () => {}), history: undefined }, /"more\.history" of the task is about a list the answer does not carry/],
      ["a project whose dependencies go on", { id: "LNG" }, cut(project, (more) => void (more.depends_on = { total: 300 })), /"more\.depends_on" of the project is about a list the answer does not carry/],
      ["a user whose timeline goes on", { id: "manyhands" }, cut(user, (more) => void (more.timeline = whole.more.timeline)), /"more\.timeline" of the user is about a list the answer does not carry/],
      // A page names its own list.
      ["a page of history that says the timeline goes on", continued, { ...history, more: { timeline: whole.more.timeline } }, /"more\.timeline" of a page of the task is about another list than the page holds/],
      ["a page of history that says links go on", continued, { ...history, more: { ...history.more, links: whole.more.links } }, /"more\.links\.\w[\w ]*" of a page of the task is about another list than the page holds/],
      ["a page of links that says links under another name go on", ofLinks, { ...last, more: { links: { "depends on": whole.more.links["depends on"] } } }, /"more\.links\.depends on" of a page of the task is about another list than the page holds/],
      ["a page of history that goes on without a token", continued, cut(history, (more) => void delete more.history.continuation), noToken("history")],
      ["a page of history that goes on with the token of the timeline", continued, cut(history, (more) => void (more.history.continuation = tokens.timeline)), noToken("history")],
      ["a page of history that has as many as it shows", continued, cut(history, (more) => void (more.history.total = history.history.length)), howMany("history", history.history.length)],
      ["a page that names no list that goes on", continued, { ...history, more: {} }, /"more" of a page of the task names no list that goes on/],
      // Since when: a revision.
      ...[-1, 1.5, 1e400, 1e21].flatMap((since): Array<[string, Record<string, unknown>, unknown, RegExp]> => [
        [`a task unchanged since ${since}`, { id: many }, { ...whole, unchanged_since: since }, /"unchanged_since" of the task is not a whole number from 0 up/],
        [`a page unchanged since ${since}`, continued, { ...history, unchanged_since: since }, /"unchanged_since" of a page of the task is not a whole number from 0 up/],
      ]),
      ["a page of a version that is none", continued, { ...history, version: 0 }, /"version" of a page of the task is not a whole number from 1 up/],
      ["a page of a timeline with a status no task has", { id: many, continuation: tokens.timeline }, { kind: "task", id: many, version: 1, unchanged_since: 1, timeline: [{ status: "ready", at: whole.created_at, by: "admin" }] }, /"timeline" of a page of the task is not a timeline/],
      ["a page of links to what is no item", ofLinks, { ...last, links: { contains: [{ kind: "task", id: "lng-1", title: "T" }] } }, /"links" of a page of the task is not the links of the item/],
    ];
    for (const [what, input, answer, says] of notSo) assert.match(judge("get", input, JSON.parse(JSON.stringify(answer))) ?? "", says, what);
    // The last page of a list, and an item none of whose lists is cut, say nothing of it.
    assert.equal(judge("get", ofLinks, last), null);
    assert.equal(Object.hasOwn(await call("get", { id: "ALP-005", history: true }), "more"), false);

    // A list of items: where the next page begins is a token, after a page that holds something, and the token
    // of that very list: the operation that was called, with the filters it was called with.
    const lists: Array<[name: string, field: string, answer: any]> = [
      ["list_users", "users", users],
      ["list_tasks", "tasks", await call("list_tasks", {})],
      ["list_next_tasks", "tasks", await call("list_next_tasks", {})],
      ["list_projects", "projects", await (async () => {
        // There is less than a page of projects: the token is the one the service would give after the last of them.
        const all = await call("list_projects", {});
        const list = paging.describeList("list_projects");
        return { ...all, continuation: paging.sealToken({ q: paging.questionMark(list.question), k: all.projects.at(-1).id }) };
      })()],
    ];
    const ofAnother = /"continuation" of a list is not a token of the list that was asked for/;
    for (const [name, field, answer] of lists) {
      assert.equal(judge(name, {}, answer), null, name);
      assert.ok(answer.continuation && answer[field].length > 0, `${name} goes on`);
      for (const none of ["", "x", "a b", "$(reboot)", `-${answer.continuation}`, `${answer.continuation}\n`, 5, null]) {
        assert.match(judge(name, {}, { ...answer, continuation: none }) ?? "", /"continuation" of a list is not a continuation token/, `${name} that goes on from ${JSON.stringify(none)}`);
      }
      assert.match(judge(name, {}, { ...answer, [field]: [] }) ?? "", /"continuation" of a list says that there is more, after a page that holds nothing/, name);
      const { continuation: _, ...ends } = answer;
      assert.equal(judge(name, {}, ends), null, `the last page of ${name}`);
      // A token of another operation's list, or of a list of an item, is none of this list's.
      for (const [other, , theirs] of lists) if (other !== name) assert.match(judge(name, {}, { ...answer, continuation: theirs.continuation }) ?? "", ofAnother, `${name} that goes on with a token of ${other}`);
      assert.match(judge(name, {}, { ...answer, continuation: tokens.history }) ?? "", ofAnother, `${name} that goes on with a token of get`);
      // The token of a page that was itself asked for with a token is of the same list.
      // A page that was asked for with a token holds what comes after the place the token names, and nothing from before it.
      assert.match(judge(name, { continuation: answer.continuation }, answer) ?? "", new RegExp(`"${field}" of a list is not a page of that list: it holds .*, which is not after the place it was asked from`, "s"), `${name}, the first page again`);
      if (name !== "list_projects") assert.equal(judge(name, { continuation: answer.continuation }, await call(name, { continuation: answer.continuation })), null, `${name}, a further page`);
    }
    // The same operation asked with other filters is another list: its token is not this one's.
    const open = await call("list_tasks", { status: "open" });
    const inProject = await call("list_tasks", { project: "LNG", status: "open" });
    assert.ok(open.continuation && inProject.continuation);
    assert.equal(judge("list_tasks", { status: "open" }, open), null);
    assert.equal(judge("list_tasks", { project: "LNG", status: "open" }, inProject), null);
    assert.equal(judge("list_tasks", { status: "open", project: "LNG" }, inProject), null, "in whatever order the filters were written");
    assert.match(judge("list_tasks", {}, open) ?? "", ofAnother, "a token of the open tasks for the list of all tasks");
    assert.match(judge("list_tasks", { status: "open" }, lists[1]![2]) ?? "", ofAnother, "a token of all tasks for the list of the open ones");
    assert.match(judge("list_tasks", { status: "open" }, inProject) ?? "", ofAnother, "a token of the open tasks of one project for the list of all open ones");
    assert.match(judge("list_tasks", { project: "lng", status: "open" }, inProject) ?? "", ofAnother, "a filter written another way is another question, as the service has it");
    assert.match(judge("list_next_tasks", { project: "LNG" }, lists[2]![2]) ?? "", ofAnother);

    // A refusal is read for what it carries, and what a longer list adds to one is printed: how many are in the
    // way when not all are named, and the item as it is now, whose lists are cut as those of the item in full.
    const refused = async (name: string, input: Record<string, unknown>): Promise<any> => {
      try {
        await service.engine.execute(name, "admin", input);
      } catch (error) {
        return asSent(error);
      }
      return assert.fail(`${name} was not refused`);
    };
    const conflict = await refused("update_task", { id: many, version: 1, title: "Changed meanwhile" });
    assert.deepEqual([conflict.code, Object.keys(conflict.current.more).sort(), conflict.current.depends_on.length], ["version_conflict", ["assigned_to", "contained_in", "depends_on", "waiting_for"], SIZES.page]);
    renderError(ui, conflict);
    assert.match(lines.splice(0).join("\n"), new RegExp(`now: ${many} {2}\\w+ {2}v\\d+`));
    const current = (await call("get", { id: many })).version;
    const inTheWay = await refused("set_task_status", { id: many, version: current, status: "done" });
    assert.deepEqual([inTheWay.blocking.length, inTheWay.blocking_total], [SIZES.blocking, over]);
    renderError(ui, inTheWay);
    assert.match(lines.splice(0).join("\n"), new RegExp(`· and ${over - SIZES.blocking} more\n`));
  });
});

describe("what the service can answer", () => {
  it("is never more than the command line takes: items at the edges of what may be stored are read through every reading, accepted and printed", async () => {
    // A plan as the operations write it, with one task for every status and every type there is.
    const storage = new MemoryStorage();
    const built = await Engine.open({ storage });
    const make = async (name: string, input: Record<string, unknown>): Promise<any> => built.execute(name, "admin", input);
    await make("create_project", { title: "With a prefix", prefix: "EDG", description: "A project." });
    const numbered = await make("create_project", { title: "With a number" });
    await make("create_user", { username: "worker", type: "agent" });
    await make("create_user", { username: "someone", type: "person" });
    // A project without a prefix has a number for its ID, as a task in it has: each is named with its kind.
    const tasks: Array<{ kind: string; id: string }> = [];
    for (let n = 0; n < TASK_STATUSES.length + TASK_TYPES.length + 6; n++) tasks.push(await make("create_task", { title: `Task ${n}`, description: "A task.", project: n % 2 ? "EDG" : numbered.id, ...(n === 1 ? { parent: `task:${tasks[0]!.id}`, why: "Because." } : {}) }));
    await make("add_link", { from: `task:${tasks[2]!.id}`, type: "depends on", to: `task:${tasks[3]!.id}` });
    await make("add_link", { from: `task:${tasks[2]!.id}`, type: "depends on", to: "EDG" });
    await make("add_link", { from: `task:${tasks[2]!.id}`, type: "assigned to", to: "worker" });
    await make("delete", { kind: "task", id: tasks[4]!.id, version: 1 });
    const gone = await make("get", { id: "someone" });
    await make("delete", { id: "someone", version: gone.version });
    const snapshot: Snapshot = (await storage.load("default"))!;

    // The same plan with every field at an edge of what the engine takes for a sound record (shape.ts): what was
    // written by an earlier version, carried over from another tool, or repaired by hand.
    const stored = (kind: string) => snapshot.objects.filter((record) => record.kind === kind);
    const moments = ["2026-01-12", "2026-01-12T09:14+01:00", "2026-01-12T09:14Z", "12 Jan 2026 09:14:03 GMT", "2026-01-12 09:14", "2026-01-12T09:14:03.120Z"];
    const titles = ["", "   ", "\u200b", "A title"];
    const priorities = [0, -7, 1.5, 1e21, -0.001, 3];
    const who = String(stored("user")[0]!.data.created_by);
    stored("task").forEach((record, n) => {
      const status = TASK_STATUSES[n % TASK_STATUSES.length]!;
      const at = moments[n % moments.length]!;
      Object.assign(record.data, {
        title: titles[n % titles.length],
        type: TASK_TYPES[n % TASK_TYPES.length],
        priority: priorities[n % priorities.length],
        value: n % 3 === 0 ? null : n % 3 === 1 ? -2.5 : 1e9,
        size: n % 3 === 1 ? null : 0.25,
        why: n % 2 ? null : "",
        status,
        // A timeline of one entry, and one of many: the last is the status the item has.
        timeline: n % 2 ? [{ status, at, by: who }] : [...TASK_STATUSES.map((earlier, index) => ({ status: earlier, at: moments[index % moments.length]!, by: index % 2 ? who : "9999" })), { status, at, by: who }],
        created_at: at,
        updated_at: moments[(n + 1) % moments.length],
        // Made by a user that is no longer found: what is stored of it is shown.
        created_by: n % 4 === 0 ? "9999" : who,
        ...(record.data.deleted_at ? { deleted_at: "2026-02-01" } : {}),
      });
    });
    stored("project").forEach((record, n) => {
      const status = PROJECT_STATUSES[(n + 3) % PROJECT_STATUSES.length]!;
      Object.assign(record.data, { title: titles[n % titles.length], status, timeline: [{ status, at: moments[n]!, by: who }], created_at: moments[n], updated_at: moments[n + 2] });
    });
    stored("user").forEach((record, n) => {
      Object.assign(record.data, { created_at: moments[n % moments.length], updated_at: moments[(n + 3) % moments.length], ...(record.data.deleted_at ? { deleted_at: "2026-02-01T10:00+02:00" } : {}) });
      // With the marks of its keys, with none, and without the field, as before there were any.
      if (n % 3 === 0) delete record.data.key_marks;
      else if (n % 3 === 1) record.data.key_marks = [];
    });
    const edges: StorageAdapter = {
      load: async () => structuredClone(snapshot),
      commit: async () => {
        throw new Error("read-only");
      },
      readRevision: async () => snapshot.head.revision,
      readText: async (tenant, kind, id) => (kind === "task" && Number(id) % 2 ? "" : storage.readText(tenant, kind, id)),
      readHistory: (tenant, kind, id) => storage.readHistory(tenant, kind, id),
      readHistoryPage: (tenant, kind, id, page) => storage.readHistoryPage(tenant, kind, id, page),
      close: async () => {},
    };
    const engine = await Engine.open({ storage: edges });
    assert.deepEqual(engine.checkConsistency(), [], "every one of these records is one the engine takes for sound");

    // Every reading there is, of every item: accepted as the answer of its operation, and printed.
    const asSent = (value: unknown): any => JSON.parse(JSON.stringify(value));
    const read = async (name: string, input: Record<string, unknown>): Promise<any> => asSent(await engine.execute(name, "admin", input));
    const shown = (name: string, input: Record<string, unknown>, answer: unknown): string => {
      assert.equal(judge(name, input, answer), null, `${name} ${JSON.stringify(input)} is taken: ${JSON.stringify(answer).slice(0, 400)}`);
      const lines: string[] = [];
      const ui = { fancy: false, paint: (_style: unknown, text: string) => text, out: (line = "") => void lines.push(line), err: (line = "") => void lines.push(line) } as Ui;
      assert.doesNotThrow(() => renderResult(ui, name, answer, "http://x", input), `${name} ${JSON.stringify(input)} is printed`);
      const printed = lines.join("\n");
      assert.doesNotMatch(printed, /undefined|NaN|\[object Object\]/, `${name} ${JSON.stringify(input)}: ${printed}`);
      return printed;
    };
    const all = async (name: string, field: string, input: Record<string, unknown> = {}): Promise<any[]> => {
      const items: any[] = [];
      let continuation: string | undefined;
      do {
        const answer = await read(name, { ...input, ...(continuation ? { continuation } : {}) });
        const printed = shown(name, { ...input, ...(continuation ? { continuation } : {}) }, answer);
        // No item is hidden by what it is called: each is there by its ID, and one whose title shows nothing says so.
        for (const item of answer[field]) {
          const line = printed.split("\n").find((one) => new RegExp(`^\\s+${item.id}\\s`).test(one));
          assert.ok(line, `${name}: ${item.id} is in what is printed`);
          if ("title" in item && item.title.replace(/[\s\u200b]/g, "") === "") assert.match(line, /\(no title\)/, `${name}: ${item.id}, whose title is ${JSON.stringify(item.title)}`);
        }
        items.push(...answer[field]);
        continuation = answer.continuation;
      } while (continuation);
      return items;
    };
    const listed = await all("list_tasks", "tasks");
    assert.equal(listed.length, tasks.length - 1, "every task that is not deleted");
    assert.deepEqual([...new Set(listed.map((task) => task.status))].sort(), [...TASK_STATUSES].sort(), "of every status");
    assert.deepEqual([...new Set(listed.map((task) => task.type))].sort(), [...TASK_TYPES].sort(), "and of every type");
    assert.ok(listed.some((task) => task.title === "") && listed.some((task) => task.title === "   ") && listed.some((task) => task.priority === 1.5) && listed.some((task) => task.priority === 1e21) && listed.some((task) => task.completed_at));
    for (const status of TASK_STATUSES) await all("list_tasks", "tasks", { status });
    await all("list_next_tasks", "tasks");
    const projects = await all("list_projects", "projects");
    assert.equal(projects.length, 2);
    const users = await all("list_users", "users");
    for (const item of [...tasks, ...projects, ...users, { kind: "user", id: "someone" }]) {
      for (const history of [false, true]) {
        const input = { kind: item.kind, id: item.id, ...(history ? { history: true } : {}) };
        const answer = await read("get", input);
        const printed = shown("get", input, answer);
        assert.ok(printed.includes(answer.id), `get ${item.id}: its ID is printed`);
        // What it is called stands in a line of its own, and is never a blank one.
        const called = printed.split("\n")[2]!;
        assert.match(called, /\S/, `get ${item.id}, whose title is ${JSON.stringify(answer.title)}: ${JSON.stringify(printed.split("\n").slice(0, 4))}`);
        if (answer.kind !== "user" && answer.title.replace(/[\s\u200b]/g, "") === "") assert.equal(called.trim(), "(no title)", `get ${item.id}`);
        // A moment is printed as the service gave it, whatever form it has.
        assert.ok(printed.includes(answer.created_at), `get ${item.id}: created ${answer.created_at}`);
      }
    }
    // The fields at their edges did arrive as they were stored.
    const details = await Promise.all(tasks.map((task) => read("get", { kind: "task", id: task.id })));
    assert.ok(details.some((task) => task.created_at === "2026-01-12") && details.some((task) => task.created_at === "12 Jan 2026 09:14:03 GMT") && details.some((task) => task.deleted_at === "2026-02-01"));
    assert.ok(details.some((task) => task.created_by === "USER-9999") && details.some((task) => task.timeline.some((entry: { by: string }) => entry.by === "USER-9999")), "who is no longer found is shown by what is stored");
    assert.ok(details.some((task) => task.description === "") && details.some((task) => task.why === "") && details.some((task) => task.why === null) && details.some((task) => task.value === null) && details.some((task) => task.size === 0.25));
    assert.ok(details.some((task) => task.timeline.length === 1) && details.some((task) => task.timeline.length > TASK_STATUSES.length));
  });
});

describe("names that every object answers to", () => {
  it("are not commands, not options, and not users with a key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-names-"));
    const config = join(directory, "config.toml");
    initConfig(config, { name: "names-test", port: await freePort() });
    try {
      for (const word of ["constructor", "toString", "hasOwnProperty"]) {
        const odd = await run([word, "--config", config]);
        assert.equal(odd.code, 1, word);
        assert.match(odd.err, /There is no command called/, word);
      }
      const option = await run(["list-projects", "--constructor", "x", "--config", config]);
      assert.equal(option.code, 1);
      assert.match(option.err, /list-projects has no option --constructor/);
      // Acting as a user called constructor that has no key: the command says so and sends nothing made up.
      const as = await run(["list-projects", "--as", "constructor", "--config", config]);
      assert.equal(as.code, 1);
      assert.match(as.err, /The config has no API key for "constructor"/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("putting a backup in place", () => {
  it("has what it moved on the disk before the copy gets the data file's name, and the new name before the note goes", () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-place-"));
    try {
      // A journal to roll back from is left by a crash too, and would be replayed onto the backup like the log.
      for (const [name, content] of [["default.sqlite", "old"], ["default.sqlite-wal", "old log"], ["default.sqlite-journal", "old journal"], ["default.sqlite.restoring", "new"]] as const) writeFileSync(join(directory, name), content);
      // What the folders hold each time the system is asked to write one of them down.
      const flushed: Array<{ folder: string; data: string; logBeside: boolean; noted: boolean }> = [];
      const { aside, moved } = putInPlace(directory, "default", join(directory, "default.sqlite.restoring"), (folder) =>
        flushed.push({
          folder: folder === directory ? "data" : "aside",
          data: existsSync(join(directory, "default.sqlite")) ? readFileSync(join(directory, "default.sqlite"), "utf8") : "none",
          logBeside: existsSync(join(directory, "default.sqlite-wal")),
          noted: restoreInterrupted(directory),
        }),
      );
      assert.deepEqual(moved, ["default.sqlite", "default.sqlite-wal", "default.sqlite-journal"]);
      assert.equal(existsSync(join(directory, "default.sqlite-journal")), false, "nothing of the old data lies beside the backup");
      assert.deepEqual(flushed, [
        // Everything is moved, nothing is installed: both folders are written down in that state.
        { folder: "aside", data: "none", logBeside: false, noted: true },
        { folder: "data", data: "none", logBeside: false, noted: true },
        // The copy has the data file's name: written down with the note still there, then with the note gone.
        { folder: "data", data: "new", logBeside: false, noted: true },
        { folder: "data", data: "new", logBeside: false, noted: false },
      ]);
      assert.deepEqual([readFileSync(join(aside, "default.sqlite"), "utf8"), readFileSync(join(aside, "default.sqlite-wal"), "utf8")], ["old", "old log"]);

      // When the folders cannot be written down after the moves, nothing is installed and everything is put back.
      writeFileSync(join(directory, "default.sqlite.restoring"), "newer");
      assert.throws(
        () =>
          putInPlace(directory, "default", join(directory, "default.sqlite.restoring"), () => {
            throw new Error("EIO: the folder could not be flushed");
          }),
        /EIO/,
      );
      assert.equal(readFileSync(join(directory, "default.sqlite"), "utf8"), "new", "the data is as it was before this restore");
      assert.equal(readdirSync(directory).filter((name) => name.startsWith("replaced-")).length, 1, "and the folder that gave back all it took is gone");

      // Two restores in the same moment, or a clock that was set back: the folder an earlier restore set its
      // data aside in is not moved into again, where the data file it keeps would be written over.
      const at = new Date("2026-01-01T00:00:00.000Z");
      const first = putInPlace(directory, "default", join(directory, "default.sqlite.restoring"), () => {}, at);
      assert.equal(first.aside, join(directory, "replaced-20260101-000000-000"));
      assert.equal(readFileSync(join(first.aside, "default.sqlite"), "utf8"), "new");
      writeFileSync(join(directory, "default.sqlite.restoring"), "newest");
      const second = putInPlace(directory, "default", join(directory, "default.sqlite.restoring"), () => {}, at);
      assert.equal(second.aside, join(directory, "replaced-20260101-000000-000-2"), "a folder of its own");
      assert.equal(readFileSync(join(first.aside, "default.sqlite"), "utf8"), "new", "what the earlier restore set aside is as it was");
      assert.equal(readFileSync(join(second.aside, "default.sqlite"), "utf8"), "newer");
      assert.equal(readFileSync(join(directory, "default.sqlite"), "utf8"), "newest");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("a restore whose process is killed", () => {
  it("leaves data the service starts on, the plan from before or the backup's, at whichever of its steps it dies", async () => {
    const root = mkdtempSync(join(tmpdir(), "vigile-killed-"));
    const titles = async (service: Service) => ((await service.engine.execute("list_tasks", "agent1", {})) as { tasks: Array<{ title: string }> }).tasks.map((task) => task.title);
    try {
      // A data folder with a plan, a backup of it, and a change made after the backup.
      const first = join(root, "first");
      mkdirSync(first);
      initConfig(join(first, "config.toml"), { name: "killed", port: await freePort() });
      const begin = (directory: string, warnings: string[] = []) => startService({ loaded: loadConfig(join(directory, "config.toml"), {}), log: () => {}, warn: (line) => warnings.push(line) });
      let service = await begin(first);
      await service.engine.execute("create_task", "agent1", { title: "In the backup", description: "d" });
      await service.stop();
      const backup = JSON.parse((await run(["backup", join(root, "backups"), "--json", "--config", join(first, "config.toml")])).out).files[0].file as string;
      service = await begin(first);
      await service.engine.execute("create_task", "agent1", { title: "After the backup", description: "d" });
      await service.stop();

      // The restore's own steps, run in a process of its own that kills itself, outright and with no chance to
      // tidy up, the moment it reaches the nth of the points where it has the system write a folder down. Those
      // are the points between its steps: after the moves, before the new name, after it, after the note is gone.
      const restore = fileURLToPath(new URL("./restore.js", import.meta.url));
      const dies = (data: string, at: number) =>
        new Promise<NodeJS.Signals | null>((resolve) => {
          const script = `import { putInPlace } from ${JSON.stringify(pathToFileURL(restore).href)}; let reached = 0; putInPlace(${JSON.stringify(data)}, "default", ${JSON.stringify(join(data, "default.sqlite.restoring"))}, () => { if (++reached === ${at}) { process.kill(process.pid, "SIGKILL"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); } });`;
          const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
          child.once("exit", (_code, signal) => resolve(signal));
        });
      const before = ["In the backup", "After the backup"];
      const restored = ["In the backup"];
      for (const [at, plan, said] of [
        [1, before, /was interrupted before the backup was in place\. The data is as it was/],
        [2, before, /was interrupted before the backup was in place\. The data is as it was/],
        [3, restored, /had put the backup in place and was interrupted before it could say so\. It is finished/],
        [4, restored, null],
      ] as const) {
        const directory = join(root, `killed-at-${at}`);
        cpSync(first, directory, { recursive: true });
        const data = join(directory, "data");
        backupTenantFile(backup, join(data, "default.sqlite.restoring"));
        assert.equal(await dies(data, at), "SIGKILL", `step ${at}: the restore was killed`);
        // The next start puts the folder in order and opens a plan that is whole: never an empty one.
        const warnings: string[] = [];
        service = await begin(directory, warnings);
        try {
          assert.deepEqual(await titles(service), plan, `step ${at}`);
          assert.deepEqual(service.engine.checkConsistency(), [], `step ${at}`);
          if (said) assert.match(warnings.join("\n"), said, `step ${at}`);
          else assert.deepEqual(warnings, [], `step ${at}: the restore had finished, and there is nothing to say`);
          // And the plan can be changed: what was put in order is a store that works.
          await service.engine.execute("create_task", "agent1", { title: "After the kill", description: "d" });
        } finally {
          await service.stop();
        }
        assert.deepEqual(readdirSync(data).filter((name) => name.includes("restor")), [], `step ${at}: nothing of the restore is left`);
        // The doctor, with the service stopped, finds the data sound and no restore left half-done.
        const report = JSON.parse((await run(["doctor", "--json", "--config", join(directory, "config.toml")])).out);
        assert.deepEqual(report.checks.filter((c: any) => c.section === "Data" && c.level === "fail"), [], `step ${at}`);
        assert.ok(report.checks.some((c: any) => c.title === 'store "default" is intact' && c.level === "ok"), `step ${at}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a recovery that moves files", () => {
  it("has each file written down where it now is before it is written down as gone from where it was", () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-order-"));
    const aside = join(directory, "replaced-20260101-000000-000");
    const flushes: string[] = [];
    const record = (folder: string) => flushes.push(folder === directory ? "data" : "aside");
    try {
      // The backup is in place, and the old log of changes is still beside it: it goes to the old data.
      mkdirSync(aside);
      writeFileSync(join(aside, "default.sqlite"), "old");
      writeFileSync(join(directory, "default.sqlite"), "the backup");
      writeFileSync(join(directory, "default.sqlite-wal"), "old log");
      noteRestore(directory, { tenant: "default", aside: "replaced-20260101-000000-000", had: ["default.sqlite", "default.sqlite-wal"] });
      assert.match(recoverRestore(directory, undefined, record) ?? "", /It is finished/);
      assert.equal(readFileSync(join(aside, "default.sqlite-wal"), "utf8"), "old log");
      assert.deepEqual(flushes.slice(0, 2), ["aside", "data"], "the folder the file went to first, then the one it left");

      // The same with a log of changes in both places, and a journal that the note does not know of: which
      // log is the old data's cannot be told, so both are kept, and nothing at all stays beside the backup.
      writeFileSync(join(directory, "default.sqlite-wal"), "a log found beside the backup");
      writeFileSync(join(directory, "default.sqlite-journal"), "a journal found beside the backup");
      noteRestore(directory, { tenant: "default", aside: "replaced-20260101-000000-000", had: ["default.sqlite", "default.sqlite-wal"] });
      assert.match(recoverRestore(directory, undefined, record) ?? "", /It is finished/);
      assert.deepEqual(readdirSync(directory).filter((name) => name.startsWith("default.sqlite")), ["default.sqlite"], "the backup stands alone");
      assert.equal(readFileSync(join(directory, "default.sqlite"), "utf8"), "the backup");
      assert.deepEqual(readdirSync(aside).sort(), ["default.sqlite", "default.sqlite-journal", "default.sqlite-wal", "default.sqlite-wal.found-beside-the-backup"]);
      assert.equal(readFileSync(join(aside, "default.sqlite-wal"), "utf8"), "old log", "what was set aside first is as it was");
      assert.equal(readFileSync(join(aside, "default.sqlite-wal.found-beside-the-backup"), "utf8"), "a log found beside the backup");
      rmSync(join(aside, "default.sqlite-wal.found-beside-the-backup"));
      rmSync(join(aside, "default.sqlite-journal"));

      // The backup is not in place, and what was set aside goes back: the data folder first, then the other.
      flushes.length = 0;
      rmSync(join(directory, "default.sqlite"));
      writeFileSync(join(directory, "default.sqlite.restoring"), "the backup");
      noteRestore(directory, { tenant: "default", aside: "replaced-20260101-000000-000", had: ["default.sqlite", "default.sqlite-wal"] });
      assert.match(recoverRestore(directory, undefined, record) ?? "", /The data is as it was/);
      assert.deepEqual([readFileSync(join(directory, "default.sqlite"), "utf8"), readFileSync(join(directory, "default.sqlite-wal"), "utf8")], ["old", "old log"]);
      assert.deepEqual(flushes.slice(0, 2), ["data", "aside"]);
      assert.equal(existsSync(aside), false, "and the folder that gave back all it took is gone");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("a failure of the command line itself", () => {
  it("is reported as JSON when JSON is asked for, in the shape the service's errors have, whatever the command", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-told-"));
    const config = join(directory, "config.toml");
    try {
      initConfig(config, { name: "told", port: await freePort() });
      const told = async (...args: string[]) => {
        const result = await run(args);
        assert.equal(result.code, 1, args.join(" "));
        assert.equal(result.out, "", args.join(" "));
        return JSON.parse(result.err).error as { code: string; message: string; actions?: string[] };
      };
      // No service answers.
      const stopped = await told("list-tasks", "--json", "--config", config);
      assert.equal(stopped.code, "not_running");
      assert.match(stopped.message, /No Vigile service answers at/);
      assert.ok(stopped.actions!.some((action) => action.startsWith("Start it: vigile serve")));
      // The command was not written as it has to be: an option twice, an option nobody knows, a command nobody knows.
      assert.match((await told("get", "--id", "A", "--id", "B", "--json", "--config", config)).message, /--id is given twice/);
      assert.equal((await told("serve", "--json", "--no-such-option", "--config", config)).code, "usage");
      assert.equal((await told("no-such-command", "--json", "--config", config)).code, "usage");
      // The config cannot be used: there is none, and one that is not correct.
      const missing = await told("config", "show", "--json", "--config", join(directory, "none.toml"));
      assert.equal(missing.code, "config_invalid");
      assert.match(missing.actions!.join("\n"), /there is no config file here; create one with/);
      assert.equal((await told("serve", "--json", "--listen.port", "not-a-port", "--config", config)).code, "config_invalid");
      // Anything else: a backup that is not there.
      const other = await told("restore-backup", join(directory, "no-such-backup.sqlite"), "--json", "--config", config);
      assert.equal(typeof other.message, "string");
      // And in words when JSON is not asked for.
      const words = await run(["list-tasks", "--config", config]);
      assert.match(words.err, /No Vigile service answers at/);
      assert.throws(() => JSON.parse(words.err));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("the note of a restore", () => {
  it("is taken away only once the folder says what it holds, and that it is gone is flushed too", () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-note-"));
    try {
      noteRestore(directory, { tenant: "default", aside: "replaced-x", had: [] });
      const seen: boolean[] = [];
      forgetRestore(directory, () => seen.push(restoreInterrupted(directory)));
      assert.deepEqual(seen, [true, false], "flushed with the note still there, then again with it gone");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("a restore that was killed half-way", () => {
  it("is put in order by the next start: undone when the backup was not in place yet, finished when it was", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-interrupted-"));
    const config = join(directory, "config.toml");
    initConfig(config, { name: "interrupted-test", port: await freePort() });
    const data = join(directory, "data");
    const titles = async (service: Service) => ((await service.engine.execute("list_tasks", "agent1", {})) as { tasks: Array<{ title: string }> }).tasks.map((task) => task.title);
    const start = async (warnings: string[]) => startService({ loaded: loadConfig(config, {}), log: () => {}, warn: (line) => warnings.push(line) });
    try {
      let service = await start([]);
      await service.engine.execute("create_task", "agent1", { title: "In the backup", description: "d" });
      await service.stop();
      const backup = JSON.parse((await run(["backup", join(directory, "backups"), "--json", "--config", config])).out).files[0].file as string;
      service = await start([]);
      await service.engine.execute("create_task", "agent1", { title: "After the backup", description: "d" });
      await service.stop();

      // 1. Killed after the data file was moved away and before the copy of the backup had its name: the note
      // is there, the data file is in the folder that takes what was there, and the copy is still beside it.
      mkdirSync(join(data, "replaced-20260101-000000-000"));
      copyFileSync(backup, join(data, "default.sqlite.restoring"));
      writeFileSync(join(data, "restore-in-progress.json"), JSON.stringify({ tenant: "default", aside: "replaced-20260101-000000-000", had: ["default.sqlite"] }));
      renameSync(join(data, "default.sqlite"), join(data, "replaced-20260101-000000-000", "default.sqlite"));
      const report = JSON.parse((await run(["doctor", "--json", "--config", config])).out);
      assert.ok(report.checks.some((c: any) => c.title === "no restore is left half-done" && c.level === "fail"), "the doctor sees it");
      // A backup taken now would find no tenant, or one without what belongs beside it, and say that all is well.
      const meanwhile = await run(["backup", join(directory, "backups"), "--config", config]);
      assert.equal(meanwhile.code, 1);
      assert.match(meanwhile.err, /A restore in .* was interrupted, and the data is not in order yet/);
      const undone: string[] = [];
      service = await start(undone);
      assert.deepEqual(await titles(service), ["In the backup", "After the backup"], "the plan is the one from before the restore, not an empty one");
      assert.equal(undone.length, 1);
      assert.match(undone[0]!, /was interrupted before the backup was in place\. The data is as it was/);
      await service.stop();
      assert.deepEqual([existsSync(join(data, "restore-in-progress.json")), existsSync(join(data, "default.sqlite.restoring"))], [false, false], "nothing of the restore is left");
      assert.equal(existsSync(join(data, "replaced-20260101-000000-000")), false, "nor the folder that gave back all it took");

      // 1a. Killed before it got as far as its note: a copy of the backup, with what the check of it may have put
      // beside it, and a note that never got its name. Nothing was moved; what lies about is cleared away.
      for (const name of ["default.sqlite.restoring", "default.sqlite.restoring-journal", "default.sqlite.restoring-wal", "default.sqlite.restoring-shm", "restore-in-progress.json.tmp"]) writeFileSync(join(data, name), "left behind");
      // And the folder it had made for what it was about to set aside, with nothing in it yet. A folder that
      // holds what an earlier restore set aside is not touched.
      mkdirSync(join(data, "replaced-20260101-000000-111"));
      mkdirSync(join(data, "replaced-20260101-000000-222"));
      writeFileSync(join(data, "replaced-20260101-000000-222", "default.sqlite"), "set aside by an earlier restore");
      service = await start([]);
      assert.deepEqual(await titles(service), ["In the backup", "After the backup"]);
      await service.stop();
      assert.deepEqual(readdirSync(data).filter((name) => name.includes("restor")), []);
      assert.deepEqual([existsSync(join(data, "replaced-20260101-000000-111")), existsSync(join(data, "replaced-20260101-000000-222", "default.sqlite"))], [false, true], "the empty folder is gone, the one that holds something stays");
      rmSync(join(data, "replaced-20260101-000000-222"), { recursive: true });

      // 1c. The undoing puts back the data file last: until it is back, nothing can open the tenant without what
      // belongs beside it. Here the undoing was cut short after the first file it put back.
      assert.deepEqual(putBackOrder(["default.sqlite", "default.sqlite-wal", "default.sqlite-shm"]), ["default.sqlite-shm", "default.sqlite-wal", "default.sqlite"]);
      mkdirSync(join(data, "replaced-20260101-000000-250"));
      writeFileSync(join(data, "restore-in-progress.json"), JSON.stringify({ tenant: "default", aside: "replaced-20260101-000000-250", had: ["default.sqlite", "default.sqlite-wal", "default.sqlite-shm"] }));
      renameSync(join(data, "default.sqlite"), join(data, "replaced-20260101-000000-250", "default.sqlite"));
      writeFileSync(join(data, "replaced-20260101-000000-250", "default.sqlite-wal"), "");
      writeFileSync(join(data, "default.sqlite-shm"), "");
      // The next restore finds it, puts it in order first, and says so in its answer.
      const next = await run(["restore-backup", backup, "--json", "--config", config]);
      assert.equal(next.code, 0, next.err);
      assert.match(JSON.parse(next.out).recovered, /was interrupted before the backup was in place\. The data is as it was/);
      assert.deepEqual(JSON.parse(next.out).set_aside.files[0], "default.sqlite");
      // 1d. A copy that a restore of this tenant left behind before it got as far as its note, while the note
      // that is there is of a restore of another tenant: the other restore is put in order, and the copy that
      // nobody needs does not stand in the way of the new one.
      for (const name of ["default.sqlite.restoring", "default.sqlite.restoring-journal"]) writeFileSync(join(data, name), "left behind");
      writeFileSync(join(data, "restore-in-progress.json"), JSON.stringify({ tenant: "other", aside: "replaced-20260101-000000-750", had: [] }));
      const beside = await run(["restore-backup", backup, "--json", "--config", config]);
      assert.equal(beside.code, 0, beside.err);
      assert.match(JSON.parse(beside.out).recovered, /A restore of "other" was interrupted/);
      assert.deepEqual(readdirSync(data).filter((name) => name.includes("restor")), []);
      // Back to the plan from before, for what follows.
      const before = join(JSON.parse(next.out).set_aside.folder, "default.sqlite");
      assert.equal((await run(["restore-backup", before, "--tenant", "default", "--config", config])).code, 0);

      // 2. Killed after the copy had its name and before the note was taken away: the restore only lacked its last word.
      // 1e. The file given to restore from is the data file that the interrupted restore had set aside. Putting
      // that restore in order moves it back to its place: there is nothing left to restore from, the data is as
      // it was, and that is what the command says.
      mkdirSync(join(data, "replaced-20260101-000000-600"));
      copyFileSync(backup, join(data, "default.sqlite.restoring"));
      writeFileSync(join(data, "restore-in-progress.json"), JSON.stringify({ tenant: "default", aside: "replaced-20260101-000000-600", had: ["default.sqlite"] }));
      renameSync(join(data, "default.sqlite"), join(data, "replaced-20260101-000000-600", "default.sqlite"));
      const moved = await run(["restore-backup", join(data, "replaced-20260101-000000-600", "default.sqlite"), "--tenant", "default", "--config", config]);
      assert.equal(moved.code, 1);
      assert.match(moved.err, /was set aside by a restore that was interrupted\. That restore has now been put in order, which moved the file/);
      assert.match(moved.err, /The data is as it was before the restore began/);
      service = await start([]);
      assert.deepEqual(await titles(service), ["In the backup", "After the backup"], "the data is as it was");
      await service.stop();
      assert.deepEqual(readdirSync(data).filter((name) => name.includes("restor")), []);

      // 1b. An undoing that was itself cut short: the data file is back, what lay beside it is not yet, and the
      // copy of the backup is gone. That is not a finished restore: the rest is put back too.
      mkdirSync(join(data, "replaced-20260101-000000-500"));
      writeFileSync(join(data, "replaced-20260101-000000-500", "default.sqlite-wal"), "");
      writeFileSync(join(data, "restore-in-progress.json"), JSON.stringify({ tenant: "default", aside: "replaced-20260101-000000-500", had: ["default.sqlite", "default.sqlite-wal"] }));
      const resumed: string[] = [];
      service = await start(resumed);
      assert.match(resumed[0]!, /was interrupted before the backup was in place/);
      assert.equal(existsSync(join(data, "replaced-20260101-000000-500", "default.sqlite-wal")), false, "what lay beside the data file was put back as well");
      assert.deepEqual(await titles(service), ["In the backup", "After the backup"]);
      await service.stop();

      mkdirSync(join(data, "replaced-20260101-000001-000"));
      writeFileSync(join(data, "restore-in-progress.json"), JSON.stringify({ tenant: "default", aside: "replaced-20260101-000001-000", had: ["default.sqlite"] }));
      renameSync(join(data, "default.sqlite"), join(data, "replaced-20260101-000001-000", "default.sqlite"));
      copyFileSync(backup, join(data, "default.sqlite"));
      const finished: string[] = [];
      service = await start(finished);
      assert.deepEqual(await titles(service), ["In the backup"], "the plan is the restored one");
      assert.match(finished[0]!, /had put the backup in place .* It is finished; what was there before is in .*replaced-20260101-000001-000/);
      await service.stop();
      assert.equal(existsSync(join(data, "restore-in-progress.json")), false);

      // 2b. The backup has the data file's name, and the move of the old log of changes was lost, as it can be
      // where a folder cannot be flushed: the old log lies beside the backup. The restore had installed the
      // backup, so it is finished, and the old log goes where the old data file is, not onto the backup.
      mkdirSync(join(data, "replaced-20260101-000002-000"));
      writeFileSync(join(data, "restore-in-progress.json"), JSON.stringify({ tenant: "default", aside: "replaced-20260101-000002-000", had: ["default.sqlite", "default.sqlite-wal"] }));
      renameSync(join(data, "default.sqlite"), join(data, "replaced-20260101-000002-000", "default.sqlite"));
      copyFileSync(backup, join(data, "default.sqlite"));
      writeFileSync(join(data, "default.sqlite-wal"), "the log of changes of the data that was replaced");
      const completed: string[] = [];
      service = await start(completed);
      assert.match(completed[0]!, /had put the backup in place .* It is finished/);
      assert.deepEqual(await titles(service), ["In the backup"], "the plan is the backup's");
      await service.stop();
      assert.equal(readFileSync(join(data, "replaced-20260101-000002-000", "default.sqlite-wal"), "utf8"), "the log of changes of the data that was replaced", "the old log is with the old data");

      // 3. A note that cannot be read keeps the service from opening the data, and says where to look.
      writeFileSync(join(data, "restore-in-progress.json"), JSON.stringify({ tenant: "../elsewhere", aside: "/tmp", had: [] }));
      await assert.rejects(start([]), /says that a restore was interrupted, but cannot be read/);
      assert.equal(existsSync(join(data, "vigile.lock")), false, "and it lets go of the data folder");
      rmSync(join(data, "restore-in-progress.json"));
      service = await start([]);
      await service.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("two services started on one data folder at the same moment", () => {
  it("leaves exactly one running, every time", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-race-"));
    const config = join(directory, "config.toml");
    initConfig(config, { name: "race-test", port: await freePort() });
    const exited = (child: ChildProcess) => (child.exitCode !== null ? Promise.resolve() : new Promise<void>((resolve) => child.once("exit", () => resolve())));
    try {
      for (let round = 0; round < 6; round++) {
        // Each on a port of its own, so that only the data folder can keep one of them out.
        const ports = [await freePort(), await freePort()];
        const pair = ports.map((port) => spawn(process.execPath, [BIN, "serve", "--config", config, "--listen.port", String(port)], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" } }));
        const answers = async () => Promise.all(ports.map((port) => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)));
        const end = Date.now() + 8000;
        // Settled when one answers and the other has ended.
        while (Date.now() < end && !((await answers()).filter(Boolean).length === 1 && pair.filter((child) => child.exitCode !== null).length === 1)) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const running = (await answers()).filter(Boolean).length;
        const ended = pair.map((child) => child.exitCode);
        for (const child of pair) child.kill("SIGTERM");
        await Promise.all(pair.map(exited));
        assert.equal(running, 1, `round ${round}: ${running} services answer, exit codes ${JSON.stringify(ended)}`);
        assert.deepEqual(ended.filter((code) => code !== null), [1], `round ${round}: the other one was refused`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

/**
 * Something that takes connections on a port and, once a request has come, does as it is told: says nothing,
 * starts an answer and stops, or hangs up. Given a name, it first says who it is as the service of that name
 * does, whenever it is asked: the command line asks that before it sends anything else, and such a question is
 * not counted among the requests.
 */
async function listener(port: number, behave: (socket: Socket) => void, name?: string): Promise<{ requests(): number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  let requests = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", (first: Buffer) => {
      if (name !== undefined && first.toString().startsWith("GET /health ")) {
        const health = JSON.stringify({ status: "ok", name, version: "0.1.0" });
        return void socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${health.length}\r\nconnection: close\r\n\r\n${health}`);
      }
      requests++;
      behave(socket);
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  return {
    requests: () => requests,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * In front of a service, something that passes the head of a request on at once and, for the requests it is told
 * to, the body a second late: the service lets the caller in by the key the request came with, and gets to the
 * operation when whoever sent it has long given up.
 */
async function lateFront(front: number, back: number, late: (path: string) => boolean): Promise<ReturnType<typeof createHttpServer>> {
  const server = createHttpServer((request, response) => {
    const body: Buffer[] = [];
    request.on("data", (chunk: Buffer) => body.push(chunk));
    request.on("end", () => {
      const passedOn = httpRequest({ host: "127.0.0.1", port: back, path: request.url, method: request.method, headers: { ...request.headers, host: `127.0.0.1:${back}` } }, (answer) => {
        response.on("error", () => {});
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      });
      passedOn.on("error", () => response.destroy());
      passedOn.flushHeaders();
      setTimeout(() => passedOn.end(Buffer.concat(body)), late(request.url ?? "") ? 1000 : 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(front, "127.0.0.1", resolve));
  return server;
}

/** What every change that got no answer is told first: what is open, and what ends it. */
const OPEN = [
  "The service carries out a request it has taken also after the connection has ended, and possibly after requests that were sent later: what is not there now may still come.",
  "This request is over when the service's log has the line of its operation (it has none when log_level is quiet), or when the service has been stopped and started again, which ends whatever it had taken. A request that does not reach the service in full within 30 seconds is dropped, and leaves no such line.",
];

/**
 * Nothing that is said after no answer may hold only when requests are carried out in the order they were sent:
 * not that a second try settles the matter once the service answers, nor which key is in force after one.
 */
function promisesNothing(lines: string[]): void {
  const said = lines.join("\n");
  assert.doesNotMatch(said, /the key that counts|last reset that answered|again when the service answers: vigile user|goes on working/);
  // Nor what holds for an ID only: a name can pass to another user, with the version the first one had.
  assert.doesNotMatch(said, /a change that names a version is stored once|The command can be run again|names the version of the user it read, so/);
  if (/vigile user reset-key/.test(said) && /may have been replaced/.test(said)) assert.match(said, /do not rely on the key of another reset until this request is over/);
}

describe("a service that takes the connection and does not answer", () => {
  let directory: string;
  let config: string;
  let port: number;
  const silent = (): void => {};
  const halfAnAnswer = (socket: Socket): void => void socket.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"tasks":');
  const hangUp = (socket: Socket): void => void socket.destroy();

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), "vigile-silent-"));
    config = join(directory, "config.toml");
    port = await freePort();
    initConfig(config, { name: "silent", port });
  });
  after(() => rmSync(directory, { recursive: true, force: true }));

  it("is not called a service that is not there: when its time is up the call says that it did not answer, and whether anything can have been stored", async () => {
    // Nothing listens: nothing was asked of anyone.
    await assert.rejects(new ServiceClient(`http://127.0.0.1:${port}`, undefined, "agent1", 300).call("create_task", { title: "T", description: "d" }), (error) => error instanceof NotRunningError && !(error instanceof NoAnswerError));
    for (const behave of [silent, halfAnAnswer]) {
      // Each on a port of its own: a connection that this process kept from the one before would be a dead one.
      const at = await freePort();
      const base = `http://127.0.0.1:${at}`;
      const client = new ServiceClient(base, undefined, "agent1", 300);
      const service = await listener(at, behave);
      try {
        const began = Date.now();
        await assert.rejects(client.call("create_task", { title: "T", description: "d" }), (error) => {
          assert.ok(error instanceof NoAnswerError, `${error}`);
          assert.equal(error.message, `The service at ${base} did not answer within 0.3 seconds. The change may or may not have been stored, and may still be.`);
          assert.equal(error.change, true);
          return true;
        });
        // A call that only reads has changed nothing, and says so: an operation, and a plain reading.
        for (const read of [() => client.call("list_tasks"), () => client.get("/health")]) {
          await assert.rejects(read(), (error) => {
            assert.ok(error instanceof NoAnswerError, `${error}`);
            assert.equal(error.message, `The service at ${base} did not answer within 0.3 seconds. Nothing was changed: the call only reads.`);
            return true;
          });
        }
        assert.equal(service.requests(), 3, "each call was sent, and waited for");
        assert.ok(Date.now() - began >= 900 && Date.now() - began < 5000, `three calls took ${Date.now() - began} ms`);
      } finally {
        await service.close();
      }
    }
    // The time a person is given is the one in the code, with nothing to set.
    const usual = new ServiceClient(`http://127.0.0.1:${port}`, undefined, "agent1") as unknown as { answerWithinMs: number };
    assert.equal(usual.answerWithinMs, 15_000);
  });

  it("has an exit code and a code in JSON of its own, and is said to leave open what it leaves open, with what ends that, also when the service hangs up instead of answering", async (t) => {
    let unchangedSince: unknown;
    // It is the service of this config that does not answer: it holds the config's data folder, and says who
    // it is when asked. To anything else on the port the command line sends nothing, and nothing is left open.
    mkdirSync(join(directory, "data"), { recursive: true });
    const held = holdFolder(join(directory, "data"));
    assert.ok(held);
    t.after(held);
    const service = await listener(port, hangUp, "silent");
    try {
      const change = await run(["create-task", "--title", "T", "--description", "d", "--json", "--config", config]);
      assert.equal(change.code, 2);
      assert.equal(change.out, "");
      const { error } = JSON.parse(change.err) as { error: { code: string; message: string; actions: string[] } };
      assert.equal(error.code, "no_answer");
      assert.equal(error.message, `The connection to the service at http://127.0.0.1:${port} ended before its answer came. The change may or may not have been stored, and may still be.`);
      // What is open, and what ends it: the limit named is the one the service has for a request to arrive.
      assert.equal(error.actions[0], OPEN[0]);
      assert.equal(error.actions[1], OPEN[1]);
      assert.equal(LIMITS.requestMs, 30_000);
      assert.match(error.actions[1]!, /A request that does not reach the service in full within 30 seconds is dropped/);
      assert.match(error.actions[2]!, /^vigile get <id> --history shows an item with the latest changes made to it; vigile list-tasks, vigile list-projects and vigile user list show what is there now\.$/);
      // Nothing is said to be safe to send again but what is: an ID is never given twice, a username is.
      assert.equal(error.actions[3], "Sent again, a change is sure to be stored only once when it names its item by an ID together with a version: the ID of a task, of a user (USER-007) or of a project is never given twice, so of two such requests the later one to be carried out is refused.");
      assert.equal(error.actions[4], "A request that names a user by its username acts on whoever has the name when it is carried out, and one that names no version on the item as it is then: a task is created once for each request, and a key is replaced by each reset, the last one carried out being the one in force. Do not send such a request again while an earlier one is outstanding: wait until it is over, or name the user by its ID, which vigile get <username> --kind user shows.");
      assert.equal(error.actions.length, 6);
      assert.equal(error.actions.at(-1), "Check the service: vigile doctor --config <file>");
      promisesNothing(error.actions);
      assert.equal(error.actions.some((action) => /Start it/.test(action)), false, "it is not told to be started: it is there");
      // A reading has nothing to look for.
      const read = await run(["list-tasks", "--json", "--config", config]);
      assert.equal(read.code, 2);
      assert.deepEqual(JSON.parse(read.err).error, {
        code: "no_answer",
        message: `The connection to the service at http://127.0.0.1:${port} ended before its answer came. Nothing was changed: the call only reads.`,
        actions: ["Check the service: vigile doctor --config <file>"],
      });
      // In words, the same.
      const words = await run(["create-task", "--title", "T", "--description", "d", "--config", config]);
      assert.equal(words.code, 2);
      assert.match(words.err, /✗ The connection to the service at \S+ ended before its answer came\. The change may or may not have been stored, and may still be\.\n\s+→ The service carries out a request it has taken also after the connection has ended/);
      assert.doesNotMatch(words.err, /No Vigile service answers|Start it/);

      // What the command line does by itself when no service is there, it does not do in the place of one that
      // took the request and may yet carry it out: no setting is written unchecked, and no key for admin.
      const before = loadConfig(config, {}).config;
      unchangedSince = before;
      const failed = async (...args: string[]) => {
        const result = await run([...args, "--json", "--config", config]);
        assert.deepEqual([result.code, result.out], [2, ""], args.join(" "));
        const report = JSON.parse(result.err).error as { code: string; message: string; actions: string[] };
        assert.equal(report.code, "no_answer", args.join(" "));
        assert.equal(report.actions.at(-1), "Check the service: vigile doctor --config <file>");
        return report;
      };
      // A reading leaves nothing behind that could still be carried out: only what was not done is said.
      const set = await failed("config", "set", "auth.keyless_user", "user");
      assert.match(set.message, /Nothing was changed: the call only reads\.$/);
      assert.deepEqual(set.actions.slice(0, -1), [
        "auth.keyless_user was not changed: the service could not be asked whether there is a user called user.",
        "Try again when the service answers. Or stop the service first: with none running the setting is written unchecked, and the service does not start if there is no such user.",
      ]);
      // A change: first what is open and what ends it, as for every change, then what it means for this one.
      const added = await failed("user", "add", "zed");
      assert.deepEqual(added.actions.slice(0, -1), [
        ...OPEN,
        "vigile user list shows whether zed is there now. Until this request is over it may still create zed: it goes by the name, and creates the user if the name is free when it is carried out.",
        "While a user has the name, a request to create it is refused: run again, the command is refused if this request has created zed by then, and this request is refused if the other has. A name is free again once its user has been removed for good, so do not remove zed for good while this request is outstanding.",
        "If zed is there and its key was not handed over, issue one: vigile user reset-key zed",
      ]);
      // A removal and a reset read the user first. Hung up on there, they have asked for no change.
      for (const args of [["user", "remove", "zed"], ["user", "reset-key", "zed"], ["user", "reset-key", "admin"]]) {
        const read = await failed(...args);
        assert.match(read.message, /Nothing was changed: the call only reads\.$/, args.join(" "));
        assert.deepEqual(read.actions, ["Check the service: vigile doctor --config <file>"], args.join(" "));
      }
      // The reset as an operation is a change like any other, and is told what holds for a reset among them.
      const operation = await failed("reset-user-key", "--user", "agent1");
      assert.match(operation.actions[4]!, /^A request that names a user by its username acts on whoever has the name when it is carried out[^]*a key is replaced by each reset, the last one carried out being the one in force\. Do not send such a request again while an earlier one is outstanding/);
      for (const report of [set, added, operation]) promisesNothing(report.actions);
      assert.deepEqual(loadConfig(config, {}).config, before, "the config file is as it was: the setting, and every key");
    } finally {
      await service.close();
    }
    // The list of users says of each key whether the service refuses it. A service that answers with the users
    // and then hangs up has not said that it refuses none. And a removal and a reset read the user first: one
    // that gets no answer after that says what holds for it, and names the user it read by its ID.
    // One answer for the list of users and for the reading of the user that a command names: the user as get gives it.
    const usersWith = (username: string): string =>
      JSON.stringify({
        users: [{ kind: "user", id: "USER-001", username: "admin", type: "admin", built_in: true, version: 1 }],
        kind: "user",
        id: "USER-009",
        username,
        type: "agent",
        built_in: false,
        version: 3,
        links: {},
        created_at: "2026-01-12T09:14:03.120Z",
        created_by: "admin",
        updated_at: "2026-01-12T09:14:03.120Z",
        unchanged_since: 12,
      });
    for (const [args, check] of [
      [["user", "list"], (actions: string[]) => assert.deepEqual(actions, ["Check the service: vigile doctor --config <file>"])],
      [
        ["user", "remove", "zed"],
        (actions: string[]) =>
          assert.deepEqual(actions.slice(0, -1), [
            ...OPEN,
            "vigile user list shows whether zed is still there. Until this request is over, the user it read may still be removed.",
            "This request names the user it read by its ID, USER-009, and its version, 3: it removes that user at most once, and no user that gets the name zed later. Running the command again looks the name up afresh, and removes whoever has it then: look first, with vigile user list, that it is the user you mean.",
          ]),
      ],
      [
        ["user", "reset-key", "zed"],
        (actions: string[]) =>
          assert.deepEqual(actions.slice(0, -1), [
            ...OPEN,
            "The key of zed may have been replaced, or may yet be. No new key was handed over, and none was written by the command line.",
            "A reset that is carried out later cancels the key of every reset before it, also of one that was sent after it and has answered. So do not rely on the key of another reset until this request is over. Then run: vigile user reset-key zed",
            "This request names the user it read by its ID, USER-009: it does not touch a user that gets the name zed later. Running the command again looks the name up afresh, and resets the key of whoever has it then.",
            "The reset needs the running service. Until one has answered with no other outstanding, whoever uses a key of zed may be refused.",
          ]),
      ],
      [
        ["user", "reset-key", "admin"],
        (actions: string[]) =>
          assert.deepEqual(actions.slice(0, -1), [
            ...OPEN,
            "The key of admin may have been replaced, or may yet be. No new key was handed over, and none was written by the command line.",
            "A reset that is carried out later cancels the key of every reset before it, also of one that was sent after it and has answered. So do not rely on the key of another reset until this request is over. Then run: vigile user reset-key admin",
            "This request names the user it read by its ID, USER-009: it does not touch a user that gets the name admin later. Running the command again looks the name up afresh, and resets the key of whoever has it then.",
            "With the service stopped, that command writes the new admin key straight to the config file. The command line reads the admin key from that file, which is also where the service writes one it issues.",
          ]),
      ],
    ] as const) {
      const users = usersWith(args.at(-1)!);
      const once = await listener(
        port,
        (socket) => {
          if (once.requests() === 1) socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${users.length}\r\nconnection: close\r\n\r\n${users}`);
          else socket.destroy();
        },
        "silent",
      );
      try {
        const result = await run([...args, "--json", "--config", config]);
        assert.deepEqual([result.code, result.out], [2, ""], args.join(" "));
        const report = JSON.parse(result.err).error as { code: string; actions: string[] };
        assert.equal(report.code, "no_answer");
        check(report.actions);
        promisesNothing(report.actions);
        assert.equal(once.requests(), 2);
      } finally {
        await once.close();
      }
    }
    assert.deepEqual(loadConfig(config, {}).config, unchangedSince, "no key was written by the command line");
    // A service that is not there is still called that, with the exit code every other failure has. Nothing
    // was sent to anyone, so here the command line does act by itself, and says what it could not check. Not
    // there means that nothing answers and that nothing holds the data: the service has let go of its folder.
    held();
    const absent = await run(["create-task", "--title", "T", "--description", "d", "--json", "--config", config]);
    assert.equal(absent.code, 1);
    assert.equal(JSON.parse(absent.err).error.code, "not_running");
    const unchecked = await run(["config", "set", "auth.keyless_user", "agent1", "--json", "--config", config]);
    assert.equal(unchecked.code, 0, unchecked.err);
    assert.deepEqual(JSON.parse(unchecked.out), { "auth.keyless_user": "agent1", warning: "The service is not running, so whether there is a user called agent1 could not be checked. It will not start if there is none." });
    const old = loadConfig(config, {}).config.auth.keys.admin;
    const written = await run(["user", "reset-key", "admin", "--json", "--config", config]);
    assert.equal(written.code, 0, written.err);
    assert.equal(JSON.parse(written.out).api_key, loadConfig(config, {}).config.auth.keys.admin);
    assert.notEqual(loadConfig(config, {}).config.auth.keys.admin, old);
  });

  it("has nothing written in its place when it carries out what it took after the command line has given up, and no promise made of a second reset: the first, carried out last, cancels its key", async () => {
    const home = mkdtempSync(join(tmpdir(), "vigile-late-"));
    const file = join(home, "config.toml");
    // The command line goes by the port in the file. The service listens on another, and in front of it stands
    // what passes every body on late but that of the reading of a user, which a reset begins with.
    const [front, back] = [await freePort(), await freePort()];
    initConfig(file, { name: "late", port: front });
    const service = await startService({ loaded: loadConfig(file, { VIGILE_LISTEN_PORT: String(back) }), log: () => {}, warn: () => {} });
    // Who is there is asked first, and answered at once: it is what the service is asked to do that arrives late.
    const late = await lateFront(front, back, (path) => path !== "/api/get" && path !== "/health");
    const direct = async (key: string): Promise<number> => (await fetch(`http://127.0.0.1:${back}/api/list-users`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: "{}" })).status;
    try {
      const lines: string[] = [];
      const ui: Ui = { fancy: false, paint: (_style, text) => text, out: (line = "") => void lines.push(line), err: (line = "") => void lines.push(line) };
      const before = loadConfig(file, {}).config;
      // A setting that would be written unchecked is not written: the service is there, and would apply it.
      await assert.rejects(configCommand(parseArgs(["set", "auth.keyless_user", "nobody", "--config", file]), ui, 300), (error) => error instanceof NoAnswerError && !error.change && /auth\.keyless_user was not changed/.test(error.advice![0]!));
      // The reset: no answer in the time given, so no key is handed over and none is written.
      await assert.rejects(user(parseArgs(["reset-key", "admin", "--json", "--config", file]), ui, 300), (error) => {
        assert.ok(error instanceof NoAnswerError, `${error}`);
        assert.match(error.message, /did not answer within 0\.3 seconds\. The change may or may not have been stored, and may still be\.$/);
        assert.match(error.advice![0]!, /^The key of admin may have been replaced, or may yet be\. No new key was handed over/);
        // What it says of a second reset is what the rest of this test then sees happen.
        assert.match(error.advice![1]!, /^A reset that is carried out later cancels the key of every reset before it, also of one that was sent after it and has answered\. So do not rely on the key of another reset until this request is over\./);
        promisesNothing(error.advice!);
        return true;
      });
      assert.deepEqual(lines, [], "nothing was printed: no key, and no word of success");
      assert.deepEqual(loadConfig(file, {}).config, before, "and nothing was written by the command line");
      // A second reset, sent while the first is still on its way, answers at once with a key.
      const second = await fetch(`http://127.0.0.1:${back}/api/reset-user-key`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${before.auth.keys.admin}` }, body: JSON.stringify({ user: "admin" }) });
      assert.equal(second.status, 200);
      const answered = ((await second.json()) as { api_key: string }).api_key;
      assert.equal(loadConfig(file, {}).config.auth.keys.admin, answered);
      assert.equal(await direct(answered), 200);
      // The service gets to the first reset after all: it was let in before the second, and is carried out
      // after it. Its key is the one in force, and the key of the reset that answered opens nothing.
      const waited = Date.now();
      while (loadConfig(file, {}).config.auth.keys.admin === answered && Date.now() - waited < 10_000) await new Promise((resolve) => setTimeout(resolve, 50));
      const now = loadConfig(file, {}).config;
      assert.ok(now.auth.keys.admin !== answered && now.auth.keys.admin !== before.auth.keys.admin, "the first reset was carried out, last");
      assert.equal(now.auth.keyless_user, before.auth.keyless_user);
      assert.deepEqual([await direct(now.auth.keys.admin!), await direct(answered), await direct(before.auth.keys.admin!)], [200, 401, 401]);
    } finally {
      late.closeAllConnections();
      await new Promise((resolve) => late.close(resolve));
      await service.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is asked to change the user that was read, by its ID: a removal or a reset that it carries out late is refused, and another user that has the name by then is left alone", async () => {
    const home = mkdtempSync(join(tmpdir(), "vigile-name-"));
    const file = join(home, "config.toml");
    const [front, back] = [await freePort(), await freePort()];
    initConfig(file, { name: "name", port: front });
    const logged: string[] = [];
    const service = await startService({ loaded: loadConfig(file, { VIGILE_LISTEN_PORT: String(back) }), log: (line) => logged.push(line), warn: () => {} });
    // The first removal and the first reset are the ones that arrive late. Everything else passes at once.
    const once = new Set(["/api/delete", "/api/reset-user-key"]);
    const late = await lateFront(front, back, (path) => once.delete(path));
    // What the service's log says of an operation, in the order it carried them out.
    const carriedOut = (operation: string): string[] => logged.filter((line) => line.includes(` op=${operation} `)).map((line) => / result=(\S+)/.exec(line)![1]!);
    const until = async (done: () => boolean): Promise<void> => {
      const began = Date.now();
      while (!done() && Date.now() - began < 10_000) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(done(), "the request that was late was carried out");
    };
    const zed = async (): Promise<Array<[string, string, number]>> => ((await service.engine.execute("list_users", "admin", {})) as { users: Array<{ username: string; id: string; version: number }> }).users.filter((u) => u.username === "zed").map((u) => [u.username, u.id, u.version]);
    const lets = async (key: string): Promise<number> => (await fetch(`http://127.0.0.1:${back}/api/list-tasks`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: "{}" })).status;
    try {
      const lines: string[] = [];
      const ui: Ui = { fancy: false, paint: (_style, text) => text, out: (line = "") => void lines.push(line), err: (line = "") => void lines.push(line) };
      const commandWithin = async (answerWithinMs: number, ...args: string[]): Promise<any> => {
        await user(parseArgs([...args, "--json", "--config", file]), ui, answerWithinMs);
        return JSON.parse(lines.at(-1)!);
      };
      const command = (...args: string[]): Promise<any> => commandWithin(1000, ...args);
      const first = await command("add", "zed");
      assert.deepEqual(await zed(), [["zed", first.user.id, 1]]);

      // A removal for good gets no answer: its body is still on its way.
      await assert.rejects(commandWithin(300, "remove", "zed", "--permanent"), (error) => {
        assert.ok(error instanceof NoAnswerError && error.change, `${error}`);
        assert.equal(error.advice![1], `This request names the user it read by its ID, ${first.user.id}, and its version, 1: it removes that user at most once, and no user that gets the name zed later. Running the command again looks the name up afresh, and removes whoever has it then: look first, with vigile user list, that it is the user you mean.`);
        promisesNothing(error.advice!);
        return true;
      });
      // The command is run again and removes the user. Then someone new gets the name: another user, at the
      // version the first one had.
      assert.deepEqual(await command("remove", "zed", "--permanent"), { deleted: true, permanent: true, kind: "user", id: first.user.id });
      const second = await command("add", "zed");
      assert.notEqual(second.user.id, first.user.id);
      assert.deepEqual(await zed(), [["zed", second.user.id, 1]]);
      // Now the service gets to the first removal. It names a user that is gone, and is refused: the user that
      // has the name is still there, and its key still lets it in.
      await until(() => carriedOut("delete").length === 2);
      assert.deepEqual(carriedOut("delete"), ["ok", "not_found"]);
      assert.deepEqual(await zed(), [["zed", second.user.id, 1]]);
      assert.equal(await lets(second.api_key), 200);

      // The same with a reset of the key: it gets no answer, the name passes to another user, and the reset
      // that is carried out late does not replace that user's key.
      await assert.rejects(commandWithin(300, "reset-key", "zed"), (error) => {
        assert.ok(error instanceof NoAnswerError && error.change, `${error}`);
        assert.equal(error.advice![2], `This request names the user it read by its ID, ${second.user.id}: it does not touch a user that gets the name zed later. Running the command again looks the name up afresh, and resets the key of whoever has it then.`);
        promisesNothing(error.advice!);
        return true;
      });
      await command("remove", "zed", "--permanent");
      const third = await command("add", "zed");
      await until(() => carriedOut("reset_user_key").length === 1);
      assert.deepEqual(carriedOut("reset_user_key"), ["not_found"]);
      assert.deepEqual(await zed(), [["zed", third.user.id, 1]]);
      assert.equal(await lets(third.api_key), 200);
      assert.equal(loadConfig(file, {}).config.auth.keys.zed, third.api_key);
    } finally {
      late.closeAllConnections();
      await new Promise((resolve) => late.close(resolve));
      await service.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is seen by the doctor as something that is there and says nothing", async (t) => {
    const service = await listener(port, silent);
    try {
      const lines: string[] = [];
      const ui: Ui = { fancy: false, paint: (_style, text) => text, out: (line = "") => void lines.push(line), err: (line = "") => void lines.push(line) };
      const began = Date.now();
      assert.equal(await doctor(parseArgs(["--json", "--config", config]), ui, 300), 1);
      assert.ok(Date.now() - began < 5000, `the doctor took ${Date.now() - began} ms`);
      const check = JSON.parse(lines.join("\n")).checks.find((c: { title: string }) => c.title === "service is running");
      assert.equal(check.level, "fail");
      assert.equal(check.detail, `http://127.0.0.1:${port} takes the connection and does not answer`);
      assert.match(check.fix, /^No service holds the data folder, so what has the port is another program\./);
      assert.doesNotMatch(check.fix, /Start it/);
    } finally {
      await service.close();
    }
    // One that says it is well and then says nothing more has not refused the admin's key. It is the service of
    // this config: it holds the config's data folder.
    mkdirSync(join(directory, "data"), { recursive: true });
    const held = holdFolder(join(directory, "data"));
    assert.ok(held);
    t.after(held);
    const answer = JSON.stringify({ status: "ok", name: "silent", version: "0.1.0" });
    const atFirst = await listener(port, (socket) => {
      if (atFirst.requests() === 1) socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${answer.length}\r\nconnection: close\r\n\r\n${answer}`);
    });
    try {
      const lines: string[] = [];
      const ui: Ui = { fancy: false, paint: (_style, text) => text, out: (line = "") => void lines.push(line), err: (line = "") => void lines.push(line) };
      assert.equal(await doctor(parseArgs(["--json", "--config", config]), ui, 300), 1);
      const checks = JSON.parse(lines.join("\n")).checks as Array<{ title: string; level: string; detail?: string; fix?: string }>;
      assert.equal(checks.find((c) => c.title === "service is running")?.level, "ok");
      assert.equal(checks.some((c) => c.title === "admin key works"), false);
      const check = checks.find((c) => c.title === "service keeps answering")!;
      assert.equal(check.level, "fail");
      assert.match(check.detail!, /did not answer within 0\.3 seconds\. Nothing was changed: the call only reads\./);
      assert.doesNotMatch(check.fix!, /reset-key/);
    } finally {
      await atFirst.close();
    }
  });
});

describe("the built-in commands", () => {
  let directory: string;
  let config: string;
  before(async () => {
    directory = mkdtempSync(join(tmpdir(), "vigile-builtin-"));
    config = join(directory, "config.toml");
    initConfig(config, { name: "builtin", port: await freePort() });
  });
  after(() => rmSync(directory, { recursive: true, force: true }));

  it("each have their own help, with their words and options, under help <command> and under <command> --help", async () => {
    // What the review found nowhere, and the commands the task names.
    for (const [topic, shown] of [
      [["serve"], /vigile serve \[--name <text>\][^\n]*\[--listen\.port <number>\][^]*--listen\.port <number>\s+for this run: the port to listen on/],
      [["config"], /vigile config init \[--name <name>\] \[--listen\.address <address>\] \[--listen\.port <port>\][^]*--listen\.address <address>\s+the address to listen on; also --address[^]*vigile config set <setting> <value>[^]*vigile config unset <setting>[^]*vigile config path/],
      [["user"], /vigile user add <username> \[--type <agent\|person>\][^]*--type <agent\|person>\s+what the user is[^]*vigile user remove <username> \[--permanent\][^]*--permanent\s+remove the user for good[^]*vigile user reset-key <username>[^]*vigile user list/],
      [["doctor"], /vigile doctor\n\s+check the config and the running service; changes nothing/],
      [["backup"], /vigile backup <folder>\n/],
      [["restore-backup"], /vigile restore-backup <backup file> \[--tenant <name>\][^]*--tenant <name>\s+the tenant the file is a backup of/],
    ] as const) {
      const viaHelp = await run(["help", ...topic]);
      assert.equal(viaHelp.code, 0, topic.join(" "));
      assert.match(viaHelp.out, shown, topic.join(" "));
      assert.match(viaHelp.out, /Everywhere\n\s+--config <file>[^\n]*\n\s+--json /, "with what every command takes");
      assert.doesNotMatch(viaHelp.out, /set-task-status/, `${topic.join(" ")}: not the help of everything`);
      // The same from the command itself. Nothing is started and no config is asked for.
      const viaOption = await run([...topic, "--help"]);
      assert.deepEqual([viaOption.code, viaOption.out, viaOption.err], [0, viaHelp.out, ""], topic.join(" "));
    }
    // One of several that share a first word, by both words.
    const one = await run(["help", "config", "set"]);
    assert.match(one.out, /vigile config set <setting> <value>/);
    assert.doesNotMatch(one.out, /config init/);
    assert.equal((await run(["config", "set", "name", "x", "--help", "--config", config])).out, one.out);
    assert.equal(loadConfig(config, {}).config.name, "builtin", "asking for help changes nothing");
    // The help of everything lists each of them, and says of --as what is true: it is for operations.
    const everything = (await run(["help"])).out;
    for (const builtin of BUILTINS) assert.ok(everything.includes(`    ${[builtin.name, ...builtin.words.map((word) => `<${word.name}>`)].join(" ")} `), builtin.name);
    assert.match(everything, /get-guide[^\n]*\n\s+--as <username>\s+act as another user; operations act as admin by default\n\n\s+Everywhere/);
    assert.match((await run(["help", "get"])).out, /--history\n\s+--continuation <text>\n\n\s+Also\n\s+--as <username>[^\n]*\n\s+--config <file>/);
  });

  it("answer every way of asking for help: with the help of what there is, and with a usage error that names what there is not and what there is instead", async () => {
    const everything = /^\n  vigile 0\.1\.0  a shared plan/;
    const of = (name: string): RegExp => new RegExp(`^\\n  vigile ${name}\\n`);
    // What there is: the help of everything, of a command, of the commands that share a first word, of an
    // operation. Asked of `help`, or of the command itself with --help, where what follows the command's name is
    // what the command was given and is not looked at.
    const there: Array<[args: string[], shown: RegExp, commands: string[] | "all"]> = [
      [[], everything, "all"],
      [["help"], everything, "all"],
      [["--help"], everything, "all"],
      [["help", "--help"], everything, "all"],
      [["help", "help"], everything, "all"],
      [["help", "serve"], of("serve"), ["serve"]],
      [["serve", "--help"], of("serve"), ["serve"]],
      [["--help", "serve"], of("serve"), ["serve"]],
      [["serve", "--listen.port", "1", "--help"], of("serve"), ["serve"]],
      [["help", "doctor"], of("doctor"), ["doctor"]],
      [["backup", "--help"], of("backup"), ["backup"]],
      [["backup", "some-folder", "--help"], of("backup"), ["backup"]],
      [["help", "restore-backup"], of("restore-backup"), ["restore-backup"]],
      [["help", "config"], of("config"), ["config init", "config show", "config set", "config unset", "config path"]],
      [["config", "--help"], of("config"), ["config init", "config show", "config set", "config unset", "config path"]],
      [["help", "config", "set"], of("config set"), ["config set"]],
      [["config", "set", "--help"], of("config set"), ["config set"]],
      [["config", "set", "name", "main", "--help"], of("config set"), ["config set"]],
      [["config", "--help", "path"], of("config path"), ["config path"]],
      [["help", "user"], of("user"), ["user add", "user remove", "user reset-key", "user list"]],
      [["user", "--help"], of("user"), ["user add", "user remove", "user reset-key", "user list"]],
      [["help", "user", "reset-key"], of("user reset-key"), ["user reset-key"]],
      [["user", "add", "zed", "--type", "person", "--help"], of("user add"), ["user add"]],
      [["help", "get"], of("get"), ["get"]],
      [["get", "--help"], of("get"), ["get"]],
      [["get", "ABC-001", "--history", "--help"], of("get"), ["get"]],
      [["help", "set-task-status"], of("set-task-status"), ["set-task-status"]],
      [["help", "set_task_status"], of("set-task-status"), ["set-task-status"]],
      [["set_task_status", "--help"], of("set-task-status"), ["set-task-status"]],
    ];
    for (const [args, shown, commands] of there) {
      const words = await run(args);
      assert.deepEqual([words.code, words.err], [0, ""], args.join(" "));
      assert.match(words.out, shown, args.join(" "));
      const json = await run([...args, "--json"]);
      assert.deepEqual([json.code, json.err], [0, ""], `${args.join(" ")} --json`);
      const listed = (JSON.parse(json.out).commands as Array<{ command: string }>).map((command) => command.command);
      if (commands === "all") assert.equal(listed.length, BUILTINS.length + OPERATIONS.length, args.join(" "));
      else assert.deepEqual(listed, commands, args.join(" "));
    }

    // What there is not. Each is refused with exit code 1, nothing on the standard output, what was not
    // understood, and what there is in its place; as JSON when that is asked for.
    const noCommand = (name: string): [RegExp, RegExp] => [new RegExp(`✗ There is no command called "${name}"\\.\\n`), /→ Run: vigile help\n/];
    const noneOf = (first: string, second: string, others: RegExp): [RegExp, RegExp] => [new RegExp(`✗ "${first} ${second}" is not a command\\.\\n`), others];
    const ofConfig = /→ init \[--name <name>\][^\n]*\n\s+→ show [^\n]*\n\s+→ set <setting> <value>[^\n]*\n\s+→ unset <setting>[^\n]*\n\s+→ path /;
    const ofUser = /→ add <username> \[--type <agent\|person>\][^\n]*\n\s+→ remove <username> \[--permanent\][^\n]*\n\s+→ reset-key <username>[^\n]*\n\s+→ list /;
    const tooMuch = (word: string, after: string): [RegExp, RegExp] => [new RegExp(`✗ Unexpected "${word}" after "help ${after}"\\.\\n`), new RegExp(`→ The help of this command: vigile help ${after}\\n\\s+→ The commands there are: vigile help\\n`)];
    const notThere: Array<[args: string[], said: [RegExp, RegExp]]> = [
      // A command that does not exist, also one that is the name of something every object has.
      [["help", "nonsense"], noCommand("nonsense")],
      [["nonsense", "--help"], noCommand("nonsense")],
      [["--help", "nonsense"], noCommand("nonsense")],
      [["help", "no-such-operation"], noCommand("no-such-operation")],
      [["help", "set-task"], noCommand("set-task")],
      [["help", "constructor"], noCommand("constructor")],
      [["help", ""], noCommand("")],
      // A second word that none of the commands under the first has.
      [["help", "config", "nonsense"], noneOf("config", "nonsense", ofConfig)],
      [["config", "nonsense", "--help"], noneOf("config", "nonsense", ofConfig)],
      [["config", "--help", "nonsense"], noneOf("config", "nonsense", ofConfig)],
      [["help", "config", "sett"], noneOf("config", "sett", ofConfig)],
      [["help", "config", "constructor"], noneOf("config", "constructor", ofConfig)],
      [["help", "user", "nonsense"], noneOf("user", "nonsense", ofUser)],
      [["user", "nonsense", "--help"], noneOf("user", "nonsense", ofUser)],
      [["user", "nonsense", "zed", "--help"], noneOf("user", "nonsense", ofUser)],
      [["help", "user", "delete"], noneOf("user", "delete", ofUser)],
      // A word after the name of a command, where help was asked for by name and nothing can follow.
      [["help", "config", "set", "nonsense"], tooMuch("nonsense", "config set")],
      [["help", "user", "list", "all"], tooMuch("all", "user list")],
      [["help", "serve", "nonsense"], tooMuch("nonsense", "serve")],
      [["help", "doctor", "nonsense"], tooMuch("nonsense", "doctor")],
      [["help", "get", "ABC-001"], tooMuch("ABC-001", "get")],
      [["help", "set_task_status", "done"], tooMuch("done", "set-task-status")],
      [["help", "help", "nonsense"], tooMuch("nonsense", "help")],
      // The same words without a question for help. No config is given here, and that is not what is said: the
      // word that was not understood is.
      [["nonsense"], noCommand("nonsense")],
      [["config", "nonsense"], noneOf("config", "nonsense", ofConfig)],
      [["user", "nonsense", "zed"], noneOf("user", "nonsense", ofUser)],
      [["config"], [/✗ Usage: vigile config <init\|show\|set\|unset\|path>\n/, ofConfig]],
      [["user"], [/✗ Usage: vigile user <add\|remove\|reset-key\|list>\n/, ofUser]],
    ];
    for (const [args, [what, instead]] of notThere) {
      const words = await run(args);
      assert.deepEqual([words.code, words.out], [1, ""], args.join(" "));
      assert.match(words.err, what, args.join(" "));
      assert.match(words.err, instead, args.join(" "));
      const json = await run([...args, "--json"]);
      assert.deepEqual([json.code, json.out], [1, ""], `${args.join(" ")} --json`);
      const { error } = JSON.parse(json.err) as { error: { code: string; message: string; actions: string[] } };
      assert.equal(error.code, "usage", args.join(" "));
      assert.match(`✗ ${error.message}\n`, what, args.join(" "));
      assert.match(`${error.actions.map((action) => `→ ${action}`).join("\n ")}\n`, instead, args.join(" "));
    }
  });

  it("take what their help says and nothing else: every refusal quotes the usage the help shows, and every option shown is read", async () => {
    for (const builtin of BUILTINS) {
      const words = [...builtin.name.split(" "), ...builtin.words.map(() => "x")];
      // The help, as JSON, says the same as the description the command reads its arguments by.
      const described = JSON.parse((await run(["help", ...builtin.name.split(" "), "--json"])).out).commands as Array<{ command: string; usage: string; options: Array<{ option: string; value?: string; also?: string }> }>;
      assert.deepEqual(described.map((one) => [one.command, one.usage]), [[builtin.name, calledAs(builtin)]]);
      assert.deepEqual(described[0]!.options.map((option) => option.option), builtin.options.map((option) => `--${option.name}`));
      // An option nobody described is refused, with that usage.
      const unknown = await run([...words, "--no-such-option", "--config", config]);
      assert.equal(unknown.code, 1, builtin.name);
      assert.ok(unknown.err.includes(`There is no option --no-such-option here.\n    → Usage: ${calledAs(builtin)}\n`), `${builtin.name}: ${unknown.err}`);
      // A word too many as well, and a word too few.
      assert.ok((await run([...words, "one-too-many", "--config", config])).err.includes(`→ Usage: ${calledAs(builtin)}\n`), builtin.name);
      if (builtin.words.length) assert.ok((await run([...builtin.name.split(" "), "--config", config])).err.includes(`✗ Usage: ${calledAs(builtin)}\n`), builtin.name);
      // Each option that is described is one the command reads: given wrongly, it is refused as itself and not
      // as an option that is not there.
      for (const option of builtin.options) {
        for (const name of [option.name, ...(option.also ? [option.also] : [])]) {
          const wrong = await run([...words, option.value ? `--${name}` : `--${name}=perhaps`, "--config", config]);
          assert.equal(wrong.code, 1, `${builtin.name} --${name}`);
          assert.match(wrong.err, option.value ? new RegExp(`--${name.replace(".", "\\.")} needs a value\\.`) : new RegExp(`--${name} is a yes/no option`), `${builtin.name} --${name}`);
        }
      }
    }
    assert.equal(loadConfig(config, {}).config.name, "builtin", "nothing was changed on the way");
    // The yes/no options are known where the arguments are split into words and options, each of them.
    const yesNo = [...BUILTINS.flatMap((builtin) => builtin.options), ...OPERATIONS.flatMap((operation) => optionsOf(operation))].filter((option) => !option.value).map((option) => option.name);
    assert.deepEqual([...FLAGS].sort(), [...new Set(["json", "help", ...yesNo])].sort());
  });

  it("are in the README as they are called", () => {
    // In a table a bar inside code is written with a backslash before it.
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8").replaceAll("\\|", "|");
    for (const builtin of BUILTINS) assert.ok(readme.includes(`| \`${calledAs(builtin)}\` |`), `the README's command reference has no row for: ${calledAs(builtin)}`);
  });
});

describe("with --json", () => {
  it("nothing but JSON is printed: also by the help, the version and the path of the config, and for a value of --json that is neither yes nor no", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-json-"));
    const config = join(directory, "config.toml");
    try {
      initConfig(config, { name: "json", port: await freePort() });
      const printed = async (...args: string[]) => {
        const result = await run(args);
        assert.deepEqual([result.code, result.err], [0, ""], args.join(" "));
        return JSON.parse(result.out);
      };
      assert.deepEqual(await printed("--version", "--json"), { version: "0.1.0" });
      assert.deepEqual(await printed("config", "path", "--json", "--config", config), { path: config });
      assert.equal((await run(["config", "path", "--config", config])).out, `${config}\n`, "and as it was without --json");
      const everything = await printed("help", "--json");
      assert.deepEqual(Object.keys(everything), ["version", "commands", "everywhere"]);
      assert.deepEqual(everything.commands.map((command: { command: string }) => command.command), [...BUILTINS.map((builtin) => builtin.name), ...OPERATIONS.map((operation) => operation.name.replaceAll("_", "-"))]);
      assert.deepEqual(everything.everywhere.map((option: { option: string }) => option.option), ["--config", "--json"]);
      assert.deepEqual(await printed("--json"), everything, "no command at all is the help");
      const get = (await printed("get", "--help", "--json")).commands[0];
      assert.equal(get.command, "get");
      assert.deepEqual(get.options.map((option: { option: string; value?: string; required: boolean }) => [option.option, option.value, option.required]), [["--kind", "project|task|user", false], ["--id", "text", true], ["--history", undefined, false], ["--continuation", "text", false], ["--as", "username", false]]);
      assert.deepEqual(await printed("help", "get", "--json"), await printed("get", "--help", "--json"));

      const told = async (...args: string[]) => {
        const result = await run(args);
        assert.deepEqual([result.code, result.out], [1, ""], args.join(" "));
        return JSON.parse(result.err).error as { code: string; message: string };
      };
      assert.deepEqual(await told("list-tasks", "--json=perhaps", "--config", config), { code: "usage", message: "--json is a yes/no option: use it alone, or with true or false." });
      assert.equal((await told("help", "nonsense", "--json")).code, "usage");
      assert.equal((await told("nonsense", "--help", "--json")).code, "usage");
      // Said no, it is words.
      assert.match((await run(["help", "nonsense", "--json=false"])).err, /✗ There is no command called "nonsense"/);
      assert.match((await run(["help", "doctor", "--json", "false"])).out, /^\n  vigile doctor\n/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
