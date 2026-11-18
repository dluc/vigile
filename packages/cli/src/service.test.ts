import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect as openSocket, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { initConfig, loadConfig, setKey, setValue } from "@vigile/config";
import { Engine, VigileError, paging } from "@vigile/core";
import { compareTaskIds } from "@vigile/core/ids.js";
import type { StorageAdapter } from "@vigile/storage";
import { SqliteStorage, backupTenantFile, folderIsHeld, historyOwners, inspectTenantFile } from "@vigile/storage-sqlite";
import { webRoot } from "@vigile/web";
import { FORMAT_1_ANSWERS, FORMAT_1_SQL, FORMAT_1_THEN, FORMAT_1_THEN_FROM } from "./format-1-data.js";
import { openAsPlan } from "./restore.js";
import { PING_MS } from "@vigile/http-api";
import { LIMITS, StartupError, isLoopback, namedFromOutside, startService, type Service, type ServiceOptions } from "./service.js";

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

interface Running {
  service: Service;
  directory: string;
  config: string;
  adminKey: string;
  warnings: string[];
  /** The lines of the service's log. */
  logged: string[];
  call(path: string, body?: unknown, key?: string): Promise<{ status: number; body: any }>;
  stop(): Promise<void>;
}

async function start(environment: NodeJS.ProcessEnv = {}, limits: ServiceOptions["limits"] = undefined, mcpLimits: ServiceOptions["mcpLimits"] = undefined): Promise<Running> {
  const directory = mkdtempSync(join(tmpdir(), "vigile-service-"));
  const config = join(directory, "config.toml");
  const { adminKey } = initConfig(config, { name: "test", port: await freePort() });
  const warnings: string[] = [];
  const logged: string[] = [];
  const service = await startService({ loaded: loadConfig(config, environment), log: (line) => logged.push(line), warn: (line) => warnings.push(line), limits, mcpLimits });
  return {
    service,
    directory,
    config,
    adminKey,
    warnings,
    logged,
    async call(path, body, key) {
      const response = await fetch(`${service.urls.base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    async stop() {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function connect(running: Running, key?: string): Promise<Client> {
  const client = new Client({ name: "vigile-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(running.service.urls.mcp), {
    requestInit: key ? { headers: { authorization: `Bearer ${key}` } } : undefined,
  });
  await client.connect(transport);
  return client;
}

const payload = (result: any) => JSON.parse(result.content[0].text);

describe("service over HTTP", () => {
  let running: Running;
  before(async () => (running = await start()));
  after(() => running.stop());

  it("gives keyless callers accurate guidance and an API key recovers access", async () => {
    const isolated = await start();
    try {
      setValue(isolated.config, "auth.keyless_user", "ghost");
      const denied = await isolated.call("/api/list-tasks", {});
      assert.equal(denied.status, 401);
      assert.match(denied.body.error.message, /connection without a key.*ghost.*no such user/);
      assert.doesNotMatch(denied.body.error.message, /key belongs/);
      assert.match(denied.body.error.actions[0], /Authorization: Bearer/);
      assert.equal((await isolated.call("/api/list-tasks", {}, isolated.adminKey)).status, 200);
    } finally {
      await isolated.stop();
    }
  });

  it("answers /health without a key", async () => {
    const { status, body } = await running.call("/health");
    assert.equal(status, 200);
    assert.deepEqual(body, { status: "ok", name: "test", version: "0.1.0" });
  });

  it("omits successful reads from info logs and includes them at debug", async () => {
    const before = running.logged.length;
    assert.equal((await running.call("/api/list-projects", {})).status, 200);
    assert.deepEqual(running.logged.slice(before), [], "info does not log successful reads");

    const debug = await start({ VIGILE_LOG_LEVEL: "debug" });
    try {
      assert.equal((await debug.call("/api/list-projects", {})).status, 200);
      assert.ok(debug.logged.some((line) => /op=list_projects caller=agent1 kind=read .*result=ok$/.test(line)));
    } finally {
      await debug.stop();
    }
  });

  it("treats a connection without a key as the keyless user", async () => {
    const { body } = await running.call("/api/instance");
    assert.deepEqual(body.you, { username: "agent1", type: "agent", keyless: true });
  });

  it("refuses a wrong key instead of falling back to the keyless user", async () => {
    const { status, body } = await running.call("/api/list-users", {}, "vig_not-a-real-key-000000000000");
    assert.equal(status, 401);
    assert.equal(body.error.code, "unauthorized");
    assert.ok(body.error.actions.length > 0);
  });

  it("accepts the admin key and keeps admin operations from other users", async () => {
    const asAgent = await running.call("/api/create-user", { username: "agent2", type: "agent" });
    assert.equal(asAgent.status, 403);
    const asAdmin = await running.call("/api/create-user", { username: "agent2", type: "agent" }, running.adminKey);
    assert.equal(asAdmin.status, 200);
    assert.equal(asAdmin.body.user.username, "agent2");

    const withNewKey = await running.call("/api/instance", undefined, asAdmin.body.api_key);
    assert.deepEqual(withNewKey.body.you, { username: "agent2", type: "agent", keyless: false });
    assert.ok(loadConfig(running.config, {}).config.auth.keys.agent2, "the new key is written to the config file");

    const user = await running.call("/api/get", { id: "agent2" }, running.adminKey);
    await running.call("/api/delete", { id: "agent2", version: user.body.version }, running.adminKey);
    assert.equal((await running.call("/api/instance", undefined, asAdmin.body.api_key)).status, 401);
    assert.equal(loadConfig(running.config, {}).config.auth.keys.agent2, undefined);
  });

  it("uses hyphens in addresses and reports refusals with what is in the way", async () => {
    await running.call("/api/create-project", { title: "Alpha", prefix: "ABC" });
    const first = await running.call("/api/create-task", { title: "First", description: "d", project: "ABC" });
    const second = await running.call("/api/create-task", { title: "Second", description: "d", project: "ABC", depends_on: [first.body.id] });
    const refused = await running.call("/api/set-task-status", { id: second.body.id, version: 1, status: "in_progress" });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.rule, "unfinished_dependencies");
    assert.deepEqual(refused.body.error.blocking, [{ kind: "task", id: first.body.id, title: "First", status: "open" }]);

    assert.equal((await running.call("/api/set_task_status", { id: first.body.id, version: 1, status: "done" })).status, 200);
    assert.equal((await running.call("/api/no-such-operation", {})).status, 404);
    assert.equal((await running.call("/api/create-task", { title: "No description" })).status, 400);
    assert.equal((await running.call("/nothing-here")).status, 404);
  });

  it("lists operations with their input schemas, by caller", async () => {
    await assert.rejects(running.service.engine.execute("not_an_operation", "agent1", {}), (error: unknown) => {
      assert.ok(error instanceof VigileError);
      assert.match(error.details.actions![0]!, /GET \/api\/operations.*MCP tools\/list/);
      return true;
    });
    const agent = await running.call("/api/operations");
    const admin = await running.call("/api/operations", undefined, running.adminKey);
    assert.equal(agent.body.operations.length, 19);
    assert.equal(admin.body.operations.length, 21);
    const setStatus = agent.body.operations.find((o: any) => o.name === "set_task_status");
    assert.equal(setStatus.path, "/api/set-task-status");
    assert.deepEqual(setStatus.input.required, ["id", "version", "status"]);
  });

  it("keeps the service status for admins", async () => {
    assert.equal((await running.call("/api/admin/status")).status, 403);
    const { body } = await running.call("/api/admin/status", undefined, running.adminKey);
    assert.equal(body.pid, process.pid);
    assert.deepEqual(body.inconsistencies, []);
    assert.equal(JSON.stringify(body).includes(running.adminKey), false, "keys are masked");
  });

  it("reports a missing status timeline in the admin diagnostic used by doctor", async () => {
    const isolated = await start();
    const file = join(isolated.directory, "data", "default.sqlite");
    let db: DatabaseSync | undefined;
    let row: { kind: string; id: string; place: number; data: string } | undefined;
    let removed = false;
    try {
      const made = await isolated.call("/api/create-task", { title: "Timeline checked by doctor", description: "d" });
      assert.equal(made.status, 200, JSON.stringify(made.body));
      db = new DatabaseSync(file);
      row = db.prepare("SELECT kind, id, place, data FROM timeline WHERE kind = 'task' AND id = ?").get(made.body.id) as typeof row;
      assert.ok(row);
      db.prepare("DELETE FROM timeline WHERE kind = 'task' AND id = ?").run(made.body.id);
      removed = true;
      db.close();
      db = undefined;
      const status = await isolated.call("/api/admin/status", undefined, isolated.adminKey);
      assert.equal(status.status, 200);
      assert.equal(Object.hasOwn(status.body, "timeline_inconsistencies"), false, "ordinary admin status does not scan every timeline");
      const diagnostic = await isolated.call("/api/admin/status?check_timelines=true", undefined, isolated.adminKey);
      assert.equal(diagnostic.status, 200);
      assert.ok(diagnostic.body.timeline_inconsistencies.some((problem: string) => problem.includes(`The task ${made.body.id} is damaged`) && problem.includes("empty")));
    } finally {
      db?.close();
      if (removed && row) {
        const restore = new DatabaseSync(file);
        try {
          restore.prepare("INSERT INTO timeline (kind, id, place, data) VALUES (?, ?, ?, ?)").run(row.kind, row.id, row.place, row.data);
        } finally {
          restore.close();
        }
      }
      await isolated.stop();
    }
  });

  it("serves the web page and nothing outside it", async () => {
    const page = await fetch(running.service.urls.web);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Vigile<\/title>/);
    assert.equal((await fetch(`${running.service.urls.base}/..%2f..%2fpackage.json`)).status, 404);
  });

  it("hands the page the engine's own rules for reading a list in pages, as they are compiled, and nothing else of the engine", async () => {
    for (const file of ["paging.js", "ids.js"]) {
      const response = await fetch(`${running.service.urls.base}/shared/${file}`);
      assert.deepEqual([response.status, response.headers.get("content-type"), response.headers.get("cache-control")], [200, "text/javascript; charset=utf-8", "no-cache"], file);
      // The very file the service runs: what the page reads a list by cannot come to differ from what makes the list.
      assert.equal(await response.text(), readFileSync(fileURLToPath(import.meta.resolve(`@vigile/core/${file}`)), "utf8"), file);
    }
    // What the page imports from it is there.
    const page = await (await fetch(`${running.service.urls.base}/app.js`)).text();
    const taken = /import \{([^}]+)\} from "\/shared\/paging\.js";/.exec(page)?.[1]?.split(",").map((name) => name.trim()) ?? [];
    assert.ok(taken.length > 5 && taken.every((name) => name in paging), taken.join(", "));
    for (const path of ["/shared/index.js", "/shared/engine.js", "/shared/", "/shared/paging.js.map", "/shared/..%2fengine.js", "/shared/constructor"]) {
      assert.equal((await fetch(`${running.service.urls.base}${path}`)).status, 404, path);
    }
  });

  it("tells the browser what the page may do, as a second line of defence", async () => {
    // The worker that lays out the graph is among them: the policy it is served with is the one that holds inside it.
    for (const path of ["/", "/app.js", "/board.js", "/boot.js", "/shared/paging.js", "/shared/ids.js", "/vendor/cytoscape.min.js", "/vendor/elk-api.js", "/vendor/elk-worker.min.js", "/vendor/cytoscape-elk.js"]) {
      const response = await fetch(`${running.service.urls.base}${path}`);
      await response.arrayBuffer();
      assert.equal(response.status, 200, path);
      const policy = response.headers.get("content-security-policy") ?? "";
      assert.match(policy, /default-src 'self'/, path);
      assert.match(policy, /frame-ancestors 'self'/, path);
      // A worker starts from the page's own files and from nowhere else.
      assert.match(policy, /(^|; )worker-src 'self'(;|$)/, path);
      assert.equal(/unsafe-inline|unsafe-eval/.test(policy), false, "nothing written into the page may run");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
    }
    // Every answer says that it is what its type says: the API, a refusal, the stream of changes, MCP.
    const abort = new AbortController();
    for (const [path, init] of [["/api/instance", {}], ["/api/no-such", { method: "POST" }], ["/nothing-here", {}], ["/api/events", { signal: abort.signal }], ["/mcp", {}]] as const) {
      const answer = await fetch(`${running.service.urls.base}${path}`, init);
      assert.equal(answer.headers.get("x-content-type-options"), "nosniff", path);
      if (path === "/api/events") abort.abort();
      else await answer.arrayBuffer();
    }
    // The page has no script or style written into it, which the policy would not let run.
    const page = await (await fetch(`${running.service.urls.base}/`)).text();
    assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/.test(page), false, "no script in the page itself");
    assert.equal(/\sstyle="|<style[\s>]|\son[a-z]+="/.test(page), false, "no style or handler written into the page");
  });

  it("refuses a second service on the same data folder", async () => {
    await assert.rejects(startService({ loaded: loadConfig(running.config, {}), log: () => {}, warn: () => {} }), StartupError);
  });

  it("requires a key from everyone once the keyless user is cleared, without a restart", async () => {
    setValue(running.config, "auth.keyless_user", "");
    const { status, body } = await running.call("/api/list-users", {});
    assert.equal(status, 401);
    assert.match(body.error.message, /needs an API key/);
    assert.equal((await running.call("/api/list-users", {}, running.adminKey)).status, 200);
    setValue(running.config, "auth.keyless_user", "agent1");
    assert.equal((await running.call("/api/list-users", {})).status, 200);
  });
});

/** Opens the stream of changes and collects its events as they arrive. */
async function listen(running: Running, key?: string) {
  const abort = new AbortController();
  const response = await fetch(`${running.service.urls.base}/api/events`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: abort.signal });
  const events: Array<{ event: string; revision: number }> = [];
  let ended = false;
  const reading = (async () => {
    if (!response.ok || !response.body) return;
    let text = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body) {
        text += decoder.decode(chunk as Uint8Array, { stream: true });
        for (let cut = text.indexOf("\n\n"); cut >= 0; cut = text.indexOf("\n\n")) {
          const block = text.slice(0, cut);
          text = text.slice(cut + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event && data) events.push({ event, revision: JSON.parse(data).revision });
        }
      }
    } catch {
      // Aborted by the test.
    }
    ended = true;
  })();
  const until = async (count: number) => {
    const end = Date.now() + 3000;
    while (events.length < count && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    assert.ok(events.length >= count, `expected ${count} events, got ${JSON.stringify(events)}`);
  };
  return { response, events, until, isEnded: () => ended, reading, close: () => abort.abort() };
}

/** Sends a request exactly as written, which `fetch` would tidy up first, and returns the status line of the answer. */
function raw(running: Running, request: string): Promise<string> {
  const { port, hostname } = new URL(running.service.urls.base);
  return new Promise((resolve, reject) => {
    const socket = openSocket(Number(port), hostname, () => socket.write(request));
    let answer = "";
    socket.on("data", (chunk) => (answer += chunk));
    socket.on("end", () => resolve(answer.split("\r\n")[0]!));
    socket.on("error", reject);
  });
}

describe("requests nobody should send", () => {
  let running: Running;
  before(async () => (running = await start()));
  after(() => running.stop());

  it("answers an address that is not one with an error, and keeps running", async () => {
    for (const target of ["//", "/\\", "http://[", "http://a:b/"]) {
      assert.equal(await raw(running, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`), "HTTP/1.1 400 Bad Request", target);
    }
    assert.equal((await running.call("/health")).status, 200, "the service still answers");
    assert.deepEqual(running.warnings, [], "and has nothing to report: the request was wrong, not the service");
  });

  it("answers a badly encoded address of a page file with not found, not with a failure of its own", async () => {
    for (const target of ["/%", "/%zz", "/%c0%ae%c0%ae/", "/%E0%A4%A"]) {
      assert.equal(await raw(running, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`), "HTTP/1.1 404 Not Found", target);
    }
  });

  it("answers a page file that cannot be read with an error, and keeps running", async () => {
    // The file is there when the service looks, and cannot be opened: here, because it is not readable.
    const file = join(webRoot, "unreadable-for-the-test.css");
    writeFileSync(file, "body {}");
    chmodSync(file, 0o000);
    try {
      // Someone who may read every file, as root may, cannot see this happen.
      if (process.getuid?.() === 0) return;
      const before = running.warnings.length;
      assert.equal(await raw(running, "GET /unreadable-for-the-test.css HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"), "HTTP/1.1 500 Internal Server Error");
      assert.equal((await running.call("/health")).status, 200, "the service still answers");
      // And whoever runs the service finds in its log which file it was and why.
      assert.equal(running.warnings.length, before + 1);
      assert.match(running.warnings.at(-1)!, /The page's file \/unreadable-for-the-test\.css could not be read: .*EACCES/);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("closes a page file when the client leaves before it has all of it", async () => {
    // Open files can be counted where the system lists them, which is on Linux.
    if (!existsSync("/proc/self/fd")) return;
    const open = () => readdirSync("/proc/self/fd").filter((fd) => {
      try {
        return readlinkSync(`/proc/self/fd/${fd}`).endsWith("elk-worker.min.js");
      } catch {
        return false;
      }
    }).length;
    const { port, hostname } = new URL(running.service.urls.base);
    // The largest file the page has does not fit in what is sent at once, so the client can leave half-way.
    const abandon = () =>
      new Promise<void>((resolve, reject) => {
        const socket = openSocket(Number(port), hostname, () => socket.write("GET /vendor/elk-worker.min.js HTTP/1.1\r\nHost: x\r\n\r\n"));
        socket.once("data", () => socket.destroy());
        socket.once("close", () => resolve());
        socket.once("error", reject);
      });
    assert.equal(open(), 0);
    for (let round = 0; round < 5; round++) await Promise.all(Array.from({ length: 20 }, abandon));
    const end = Date.now() + 3000;
    while (open() > 0 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(open(), 0, "none of the hundred downloads that were given up left the file open");
    const whole = await fetch(`${running.service.urls.base}/vendor/elk-worker.min.js`);
    assert.equal(whole.status, 200);
    assert.ok((await whole.arrayBuffer()).byteLength > 1_000_000, "and the file is still served whole");
  });

  it("holds no page file open for answers that wait on a connection, however long they wait", async () => {
    // Open files can be counted where the system lists them, which is on Linux.
    if (!existsSync("/proc/self/fd")) return;
    const open = () => readdirSync("/proc/self/fd").filter((fd) => {
      try {
        return readlinkSync(`/proc/self/fd/${fd}`).endsWith("elk-worker.min.js");
      } catch {
        return false;
      }
    }).length;
    const { port, hostname } = new URL(running.service.urls.base);
    // As many requests as a connection may have unanswered, sent in one piece, and not one answer read: the
    // first answer does not fit in what is sent at once, so the others wait behind it for as long as the client likes.
    const asked = "GET /vendor/elk-worker.min.js HTTP/1.1\r\nHost: x\r\n\r\n".repeat(8);
    const sockets = await Promise.all(
      Array.from({ length: 20 }, () =>
        new Promise<ReturnType<typeof openSocket>>((resolve, reject) => {
          const socket = openSocket(Number(port), hostname, () => {
            socket.pause();
            socket.write(asked, () => resolve(socket));
          });
          socket.once("error", reject);
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(open(), 0, "none of the 160 answers that wait holds the file open");
    assert.equal((await running.call("/health")).status, 200, "and the service answers others meanwhile");
    await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.once("close", resolve).destroy())));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(open(), 0, "nor after the clients have left");
    const whole = await fetch(`${running.service.urls.base}/vendor/elk-worker.min.js`);
    assert.equal(whole.status, 200);
    assert.ok((await whole.arrayBuffer()).byteLength > 1_000_000, "and the file is still served whole");
  });

  it("serves a page file as it is on the disk now, and says how long it is", async () => {
    // Not a name of the kind the service's code has, so that nothing takes it for a change of the code.
    const file = join(webRoot, "changed-for-the-test.txt");
    const get = async (method = "GET") => {
      const response = await fetch(`${running.service.urls.base}/changed-for-the-test.txt`, { method });
      return [response.status, response.headers.get("content-length"), await response.text()];
    };
    try {
      assert.deepEqual((await get()).slice(0, 1), [404]);
      writeFileSync(file, "body {}");
      assert.deepEqual(await get(), [200, "7", "body {}"]);
      assert.deepEqual(await get(), [200, "7", "body {}"], "the same when asked again");
      assert.deepEqual(await get("HEAD"), [200, "7", ""], "its length without its content, when only that is asked for");
      // Another file under the same name, as an update of the service puts one there while it runs.
      writeFileSync(file, "body { color: black }");
      assert.deepEqual(await get(), [200, "21", "body { color: black }"]);
      // And one of the same length, written into the same file, with the time of its content put back to what it
      // was: a time on a whole second, which every file system keeps to the letter.
      const then = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000);
      utimesSync(file, then, then);
      assert.deepEqual(await get(), [200, "21", "body { color: black }"]);
      writeFileSync(file, "body { color: white }");
      utimesSync(file, then, then);
      assert.equal(statSync(file).mtimeMs, then.getTime());
      assert.deepEqual(await get(), [200, "21", "body { color: white }"]);
      rmSync(file);
      assert.deepEqual((await get()).slice(0, 1), [404]);
      writeFileSync(file, "");
      assert.deepEqual(await get(), [200, "0", ""], "an empty file is an empty answer");
    } finally {
      rmSync(file, { force: true });
    }
    // What is served is the file to the letter, for the largest of them too.
    const largest = createRequire(import.meta.resolve("@vigile/web")).resolve("elkjs/lib/elk-worker.min.js");
    const served = Buffer.from(await (await fetch(`${running.service.urls.base}/vendor/elk-worker.min.js`)).arrayBuffer());
    assert.ok(served.equals(readFileSync(largest)));
  });

  it("closes a connection that sends more requests than it may have unanswered, and no other", async () => {
    const { port, hostname } = new URL(running.service.urls.base);
    const one = "GET /health HTTP/1.1\r\nHost: x\r\n\r\n";
    /** Sends what is given on one connection, and says how many answers came and whether the service closed it. */
    const send = (pieces: string[]) =>
      new Promise<{ answers: number; closed: boolean }>((resolve, reject) => {
        let text = "";
        let closed = false;
        const answers = () => text.split("HTTP/1.1 200 OK").length - 1;
        const socket = openSocket(Number(port), hostname, async () => {
          for (const [index, piece] of pieces.entries()) {
            if (closed) break;
            const expected = answers() + piece.split(" HTTP/1.1\r\n").length - 1;
            socket.write(piece);
            // The next piece goes once every answer to this one is here, as a client that waits sends.
            const end = Date.now() + 3000;
            while (!closed && answers() < expected && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
            if (index === pieces.length - 1) await new Promise((r) => setTimeout(r, 100));
          }
          resolve({ answers: answers(), closed });
          socket.destroy();
        });
        socket.on("data", (chunk) => (text += chunk));
        socket.on("close", () => (closed = true));
        socket.on("error", reject);
      });
    const before = running.warnings.length;
    // A connection of someone else, open all the while.
    const other = openSocket(Number(port), hostname);
    await new Promise((resolve, reject) => other.once("connect", resolve).once("error", reject));
    // One after the other on one connection, each sent when the answer before it has come: as many as one likes.
    assert.deepEqual(await send(Array.from({ length: 40 }, () => one)), { answers: 40, closed: false });
    // As many at once as a connection may have unanswered, again and again: each is answered, in its turn.
    assert.deepEqual(await send([one.repeat(8), one.repeat(8), one.repeat(8)]), { answers: 24, closed: false });
    // One more than that at once: the connection is closed, and what it sent after is not answered.
    const over = await send([one.repeat(9), one]);
    assert.equal(over.closed, true);
    assert.ok(over.answers < 9, `${over.answers} answers`);
    // The one too many, and what came with it in the same piece, is not looked at: a change among them is not made.
    const task = JSON.stringify({ title: "Sent with one request too many", description: "d" });
    const create = `POST /api/create-task HTTP/1.1\r\nHost: ${hostname}\r\nContent-Type: application/json\r\nContent-Length: ${task.length}\r\n\r\n${task}`;
    const logged = running.logged.length;
    assert.equal((await send([one.repeat(8) + create + create])).closed, true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(running.logged.slice(logged).filter((line) => line.includes("create_task")), []);
    const made = async () => (await running.call("/api/list-tasks", {})).body.tasks.filter((found: { title: string }) => found.title === "Sent with one request too many").length;
    assert.equal(await made(), 0);
    // The same request on a connection that may send it is carried out: it was not the request that was refused.
    assert.deepEqual(await send([create]), { answers: 1, closed: false });
    assert.equal(await made(), 1);
    // A stream of requests that is never read, the size of what a connection may send at once several times over.
    const flood = await send([one.repeat(2000), one.repeat(2000)]);
    assert.equal(flood.closed, true);
    assert.ok(flood.answers < 9, `${flood.answers} answers`);
    assert.equal((await running.call("/health")).status, 200, "the service answers others as before");
    // The connection that was open all the while is open still, and is answered.
    const answer = await new Promise<string>((resolve, reject) => {
      other.once("data", (chunk) => resolve(String(chunk))).once("close", () => reject(new Error("the other connection was closed")));
      other.write(one);
    });
    assert.match(answer, /^HTTP\/1\.1 200 OK/);
    other.destroy();
    assert.deepEqual(running.warnings.slice(before), [], "and has nothing to report: the client was wrong, not the service");
  });

  it("answers only to its own name while it listens on this machine only", async () => {
    const { port } = new URL(running.service.urls.base);
    const post = (path: string, host: string | null) =>
      raw(running, `POST ${path} HTTP/1.1\r\n${host === null ? "" : `Host: ${host}\r\n`}Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
    // A site can point a name of its own at 127.0.0.1; its page then asks under that name.
    for (const host of ["evil.example", `evil.example:${port}`, "127.0.0.1.evil.example", "localhost.evil.example", "192.168.1.20"]) {
      assert.equal(await post("/api/list-projects", host), "HTTP/1.1 403 Forbidden", host);
      assert.equal(await post("/mcp", host), "HTTP/1.1 403 Forbidden", `/mcp as ${host}`);
    }
    // The machine's own names for itself, with or without the port, written in full with a dot at the end, or in capitals.
    for (const host of [`127.0.0.1:${port}`, "127.0.0.1", `localhost:${port}`, "LOCALHOST", `localhost.:${port}`, `[::1]:${port}`, "127.0.0.2"]) {
      assert.equal(await post("/api/list-projects", host), "HTTP/1.1 200 OK", host);
    }
    // The page's files are no secret, and are served under any name.
    assert.equal(await raw(running, "GET / HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n"), "HTTP/1.1 200 OK");
  });

  it("refuses what a browser sends on behalf of a page of another site, over the API and over MCP", async () => {
    const host = new URL(running.service.urls.base).host;
    const send = async (path: string, headers: Record<string, string>, body: string | null = "{}") => {
      const response = await fetch(`${running.service.urls.base}${path}`, { method: body === null ? "GET" : "POST", headers, body });
      return { status: response.status, body: (await response.json()) as { error?: { code: string; message: string; actions?: string[] } } };
    };
    const json = { "content-type": "application/json" };
    const before = (await running.call("/api/list-projects", {})).body.projects.length;
    // A page of another site, a page opened from a file, and a page of the same machine on another port.
    const others: Array<Record<string, string>> = [{ origin: "https://evil.example" }, { origin: "null" }, { origin: "http://127.0.0.1:1" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }];
    for (const headers of others) {
      for (const path of ["/api/create-project", "/mcp"]) {
        const answer = await send(path, { ...json, ...headers }, JSON.stringify({ title: "Planted", prefix: "EVIL", description: "d" }));
        assert.equal(answer.status, 403, `${path} with ${JSON.stringify(headers)}`);
        assert.match(answer.body.error!.message, /page of another site/);
      }
    }
    assert.equal((await send("/api/events", { "sec-fetch-site": "cross-site" }, null)).status, 403, "listening is refused as well");
    // A body that does not say it is JSON is what a browser sends to another site without asking first.
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const answer = await send("/api/create-project", { "content-type": type }, JSON.stringify({ title: "Planted", prefix: "EVIL", description: "d" }));
      assert.equal(answer.status, 400, type);
      assert.deepEqual(answer.body.error!.actions, ['Send the header "Content-Type: application/json".']);
    }
    assert.equal((await running.call("/api/list-projects", {})).body.projects.length, before, "nothing was planted");

    // Behind a proxy on the same machine that puts the service's address in place of the name the browser used,
    // the two names differ. The browser's own word that the page is the service's is taken; a page cannot forge it.
    assert.equal((await send("/api/list-projects", { ...json, origin: "https://plan.example.org", "sec-fetch-site": "same-origin" })).status, 200);
    assert.equal((await send("/api/list-projects", { ...json, origin: `http://${host}`, "sec-fetch-site": "cross-site" })).status, 403, "and its word that it is not, also");
    // The service's own page, a program that sends no such header, and a call with no input are let through.
    assert.equal((await send("/api/list-projects", { ...json, origin: `http://${host}`, "sec-fetch-site": "same-origin" })).status, 200);
    assert.equal((await send("/api/list-projects", { "content-type": "application/json; charset=utf-8" })).status, 200);
    assert.equal((await fetch(`${running.service.urls.base}/api/list-projects`, { method: "POST" })).status, 200);
    assert.equal((await send("/api/instance", { "sec-fetch-site": "none" }, null)).status, 200);
  });
});

describe("what one client may hold of the service", () => {
  it("lets go of a request that does not arrive in full, and answers while every connection is taken by one that says nothing", async () => {
    const running = await start({}, { requestMs: 400, headersMs: 400, checkMs: 100, connections: 12 });
    const { port, hostname } = new URL(running.service.urls.base);
    const sockets: Array<ReturnType<typeof openSocket>> = [];
    try {
      // A request that says it has a megabyte to send, sends a little, and stops.
      const ended = (request: string) =>
        new Promise<{ answer: string; ms: number }>((resolve, reject) => {
          const began = Date.now();
          const socket = openSocket(Number(port), hostname, () => socket.write(request));
          sockets.push(socket);
          let answer = "";
          socket.on("data", (chunk) => (answer += chunk));
          socket.on("close", () => resolve({ answer: answer.split("\r\n")[0]!, ms: Date.now() - began }));
          socket.on("error", reject);
        });
      const held = await ended("POST /api/create-task HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000000\r\n\r\n{\"title\":");
      assert.equal(held.answer, "HTTP/1.1 408 Request Timeout");
      assert.ok(held.ms < 3000, `let go after ${held.ms} ms`);
      const noHeaders = await ended("GET /health HTTP/1.1\r\nHost: x\r\n");
      assert.ok(noHeaders.ms < 3000, `a request whose headers never end is let go too, after ${noHeaders.ms} ms`);

      // More connections than there are, none of which says anything: each further one takes the place of the
      // one that has waited the longest, so that no more than the limit are open.
      const open = (): Promise<boolean> =>
        new Promise((resolve) => {
          const socket = openSocket(Number(port), hostname);
          sockets.push(socket);
          const stays = setTimeout(() => resolve(true), 300);
          socket.on("close", () => {
            clearTimeout(stays);
            resolve(false);
          });
          socket.on("error", () => {});
        });
      const stayed = (await Promise.all(Array.from({ length: 30 }, open))).filter(Boolean).length;
      assert.ok(stayed <= 12, `${stayed} of 30 connections were kept`);
      assert.ok(stayed >= 8, `${stayed} of 30 connections were kept`);
      // And the service answers while they are all held: the request that comes now gets the place of one of them.
      const silent = await Promise.all(Array.from({ length: 12 }, open));
      assert.deepEqual(silent, Array(12).fill(true));
      assert.equal((await running.call("/health")).status, 200);
      assert.match(running.warnings.join("\n"), /^The service has no connection left to give: since this was last said, 1 idle or stalled connection was closed to make room, and 0 new ones were refused\.$/m);
      assert.equal(running.warnings.filter((line) => line.startsWith("The service has no connection left")).length, 1, "said once, not for each of them");
    } finally {
      for (const socket of sockets) socket.destroy();
      await running.stop();
    }
  });

  /** How many connections the service has open, as the service counts them. */
  const openAt = (running: Running): Promise<number> => new Promise((resolve, reject) => running.service.server.getConnections((error, count) => (error ? reject(error) : resolve(count))));
  const until = async (what: () => Promise<boolean>, ms = 5000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await what()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return what();
  };
  /** Sends what a client would, and gives what comes back until the service closes the connection or `ms` have passed. */
  const exchange = (running: Running, parts: string[], ms = 1500): Promise<{ answer: string; closed: boolean }> =>
    new Promise((resolve, reject) => {
      const { port, hostname } = new URL(running.service.urls.base);
      let answer = "";
      const socket = openSocket(Number(port), hostname, () => {
        socket.write(parts[0]!);
        // The rest only once the service has said to go ahead.
        socket.on("data", (chunk) => {
          answer += chunk;
          if (parts.length > 1 && answer.startsWith("HTTP/1.1 100 Continue\r\n\r\n") && parts[1] !== "") socket.write(parts.splice(1, 1)[0]!);
        });
      });
      const over = setTimeout(() => (socket.destroy(), resolve({ answer, closed: false })), ms);
      socket.on("close", () => (clearTimeout(over), resolve({ answer, closed: true })));
      socket.on("error", reject);
    });

  it("gives the place of a connection that does not read its answer to a new one, and closes it in the end", async () => {
    const running = await start({}, { connections: 6, idleMs: 1500 });
    const { port, hostname } = new URL(running.service.urls.base);
    const sockets: Array<ReturnType<typeof openSocket>> = [];
    try {
      // Six connections ask for the largest file of the page, several times over, so that it is more than the
      // system takes off the service's hands by itself, and read none of it.
      await Promise.all(
        Array.from(
          { length: 6 },
          () =>
            new Promise<void>((resolve) => {
              const socket = openSocket(Number(port), hostname, () => {
                socket.pause();
                socket.write("GET /vendor/elk-worker.min.js HTTP/1.1\r\nHost: localhost\r\n\r\n".repeat(8), () => resolve());
              });
              sockets.push(socket);
              socket.on("error", () => {});
            }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(await openAt(running), 6, "all of them are held, with an answer nobody takes");
      // The next request is answered: one of them gave way to it.
      const began = Date.now();
      assert.equal((await running.call("/health")).status, 200);
      assert.ok(Date.now() - began < 1000, "at once, and not when the limit of time has let one of them go");
      assert.equal(await openAt(running), 6);
      // And none of them is kept for good, although their clients hold on: nothing moves on them.
      assert.equal(await until(async () => (await openAt(running)) <= 1, 8000), true, `${await openAt(running)} connections are still open`);
      assert.equal(sockets.every((socket) => !socket.destroyed), true, "the clients did not let go themselves");
    } finally {
      for (const socket of sockets) socket.destroy();
      await running.stop();
    }
  });

  it("does not cut short an answer that is read on with pauses shorter than the limit, however long all of it takes", async () => {
    const running = await start({}, { idleMs: 2000 });
    const { port, hostname } = new URL(running.service.urls.base);
    try {
      const whole = (await (await fetch(`${running.service.urls.base}/vendor/elk-worker.min.js`)).arrayBuffer()).byteLength;
      assert.ok(whole > 1_000_000, "a file that does not go out in one piece");
      // The largest file of the page eight times over on one connection, which is more than the system takes
      // off the service's hands by itself: the service hands the rest on as the client reads.
      const ask = (more = "") => `GET /vendor/elk-worker.min.js HTTP/1.1\r\nHost: localhost\r\n${more}\r\n`;
      const began = Date.now();
      const read = await new Promise<number>((resolve, reject) => {
        let [size, sincePause] = [0, 0];
        const socket = openSocket(Number(port), hostname, () => socket.write(ask().repeat(7) + ask("Connection: close\r\n")));
        // A megabyte, then a pause a quarter of the limit long, over and over.
        socket.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if ((sincePause += chunk.length) < 1_000_000) return;
          sincePause = 0;
          socket.pause();
          setTimeout(() => socket.resume(), 500);
        });
        socket.on("close", () => resolve(size));
        socket.on("error", reject);
      });
      assert.ok(read > 8 * whole, `${read} bytes of eight answers of ${whole} each`);
      assert.ok(Date.now() - began > 4000, `it took ${Date.now() - began} ms, more than twice the limit`);
      // The limit is well above the time between two lines sent to a client that listens for changes.
      assert.ok(LIMITS.idleMs >= 2 * PING_MS, `${LIMITS.idleMs} ms against a line every ${PING_MS} ms`);
    } finally {
      await running.stop();
    }
  });

  it("takes a client that reads too little for more of its answer to be sent for one that does not read", async () => {
    const running = await start({}, { idleMs: 1000 });
    const { port, hostname } = new URL(running.service.urls.base);
    let taking: NodeJS.Timeout | undefined;
    const socket = openSocket(Number(port), hostname);
    try {
      socket.on("error", () => {});
      socket.pause();
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      socket.write("GET /vendor/elk-worker.min.js HTTP/1.1\r\nHost: localhost\r\n\r\n".repeat(8));
      // A byte every tenth of the limit, for as long as the connection lasts: the client is there and reads,
      // and megabytes wait of which the service can hand on no more.
      let taken = 0;
      taking = setInterval(() => (taken += socket.read(1)?.length ?? 0), 100);
      const began = Date.now();
      assert.equal(await until(async () => (await openAt(running)) === 0, 8000), true, "the connection was kept although no more of the answer could be sent");
      assert.ok(Date.now() - began >= 1000, `closed after ${Date.now() - began} ms, not before the limit`);
      assert.ok(taken >= 5, `the client took ${taken} bytes meanwhile`);
      assert.equal(socket.destroyed, false, "the client did not let go itself");
    } finally {
      clearInterval(taking);
      socket.destroy();
      await running.stop();
    }
  });

  it("never closes a connection that is at work to make room: the new one is refused until one is free", async () => {
    const running = await start({}, { connections: 4 });
    const aborts: AbortController[] = [];
    try {
      // Four clients listen for changes: each has a connection, and each is sent all there is. Their answers are
      // kept here: one that nothing refers to any more has its connection closed for it.
      const listening: Response[] = [];
      for (let i = 0; i < 4; i++) {
        const abort = new AbortController();
        aborts.push(abort);
        listening.push(await fetch(`${running.service.urls.base}/api/events`, { signal: abort.signal }));
        assert.equal(listening[i]!.status, 200);
      }
      assert.equal(await openAt(running), 4);
      const refused = await exchange(running, ["GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n"]);
      assert.deepEqual(refused, { answer: "", closed: true });
      assert.equal(await openAt(running), 4, "the four that listen were left alone");
      assert.equal(listening.length, 4);
      // One of them leaves, and its place is there for the next.
      aborts[0]!.abort();
      assert.equal(await until(async () => (await openAt(running)) === 3), true);
      assert.equal((await running.call("/health")).status, 200);
      assert.match(running.warnings.join("\n"), /^The service has no connection left to give: since this was last said, 0 idle or stalled connections were closed to make room, and 1 new one was refused\.$/m);
    } finally {
      for (const abort of aborts) abort.abort();
      await running.stop();
    }
  });

  it("leaves a connection alone while something is worked out for it, although another request of its is still arriving", async () => {
    const running = await start({}, { connections: 1 });
    const { port, hostname } = new URL(running.service.urls.base);
    const socket = openSocket(Number(port), hostname);
    try {
      // One connection, and that is all there are. It listens for changes, and has begun to send a change as
      // well, of which most is still to come.
      let got = "";
      socket.on("data", (chunk) => (got += chunk));
      socket.on("error", () => {});
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      socket.write('GET /api/events HTTP/1.1\r\nHost: localhost\r\n\r\nPOST /api/create-task HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"title":');
      assert.equal(await until(async () => got.includes("event: hello")), true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The next connection is refused, and the one at work stays.
      assert.deepEqual(await exchange(running, ["GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n"]), { answer: "", closed: true });
      assert.deepEqual([socket.destroyed, await openAt(running)], [false, 1]);
    } finally {
      socket.destroy();
      await running.stop();
    }
  });

  it("takes the command line for this machine when the service listens on an address of a network", async (t) => {
    // An address this machine has on a network, where it has one: a connection from the machine to that address
    // comes from that address, and not from one that is the machine's own on every machine.
    const address = Object.values(networkInterfaces())
      .flat()
      .find((one) => one && !one.internal && one.family === "IPv4")?.address;
    if (!address) return void t.skip("this machine has no address on a network");
    // One connection for each address beyond the machine, and no more than that for all of them.
    const running = await start({ VIGILE_LISTEN_ADDRESS: address }, { connections: 4, connectionsPerAddress: 1, connectionsKeptForHere: 3 });
    const aborts: AbortController[] = [];
    const listening: Response[] = [];
    try {
      assert.equal(running.service.loopbackOnly, false);
      // Three clients on this machine listen for changes, and a fourth connection is answered: taken for
      // connections from beyond, the second of them would have been refused.
      for (let i = 0; i < 3; i++) {
        const abort = new AbortController();
        aborts.push(abort);
        listening.push(await fetch(`${running.service.urls.base}/api/events`, { signal: abort.signal }));
      }
      assert.deepEqual(listening.map((response) => response.status), [200, 200, 200]);
      assert.equal((await running.call("/health")).status, 200);
      assert.deepEqual(running.warnings.filter((line) => line.startsWith("The service has no connection left")), []);
    } finally {
      for (const abort of aborts) abort.abort();
      await running.stop();
    }
  });

  it("counts a client on this machine among the machine's on the stream of changes, by whichever address it connects", async (t) => {
    const address = Object.values(networkInterfaces())
      .flat()
      .find((one) => one && !one.internal && one.family === "IPv4")?.address;
    if (!address) return void t.skip("this machine has no address on a network");
    // On every address of the machine: a program on it reaches the service over the one it has for itself and
    // over the one it has on a network.
    const running = await start({ VIGILE_LISTEN_ADDRESS: "0.0.0.0" });
    const { port } = new URL(running.service.urls.base);
    const aborts: AbortController[] = [];
    const listening: Response[] = [];
    const listen = async (host: string, headers: Record<string, string> = {}) => {
      const abort = new AbortController();
      aborts.push(abort);
      const response = await fetch(`http://${host}:${port}/api/events`, { signal: abort.signal, headers });
      listening.push(response);
      return response;
    };
    try {
      // It takes all the places of the machine over the first, naming a new address each time.
      const statuses = [];
      for (let i = 0; i < 168; i++) statuses.push((await listen("127.0.0.1", { "x-forwarded-for": `192.0.2.${i}` })).status);
      assert.deepEqual([...new Set(statuses)], [200]);
      // Over the second it is still the machine, and has none of the places left for clients from elsewhere.
      const refused = await listen(address);
      assert.equal(refused.status, 429);
      assert.match(((await refused.json()) as any).error.message, /^168 clients that connect from the service's own machine are already listening for changes\.$/);
      // Whom it says it speaks for is believed only of what the machine says to itself.
      aborts[0]!.abort();
      assert.equal(await until(async () => ((await running.call("/api/admin/status", undefined, running.adminKey)).body.listeners as number) === 167, 2000), true);
      const named = [];
      for (let i = 0; i < 33; i++) named.push((await listen(address, { "x-forwarded-for": `198.51.100.${i}` })).status);
      assert.deepEqual([named[0], named.filter((status) => status === 200).length], [200, 1], "one place was free, and the name given changes nothing");
    } finally {
      for (const abort of aborts) abort.abort();
      await running.stop();
    }
  });

  it("reads no body that says it is too large, and tells a request that asks first to go ahead only when its body would be read", async () => {
    const running = await start();
    try {
      // Each on a connection of its own, which the service closes once it has answered.
      const head = (path: string, length: number, more = "") => `POST ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n${more}\r\n`;
      const first = (answer: string) => answer.split("\r\n")[0];
      // Five megabytes are announced and none is sent: the answer does not wait for them.
      const large = await exchange(running, [head("/api/list-projects", 5_000_000)], 1000);
      assert.equal(first(large.answer), "HTTP/1.1 413 Payload Too Large");
      assert.match(large.answer, /"code":"limit_exceeded","message":"The request body is larger than 1 MB\."/);

      const asks = "Expect: 100-continue\r\n";
      const wrongKey = "Authorization: Bearer vig_wrongwrongwrongwrongwrong\r\n";
      // Asked first, the service says to go ahead and then answers what was sent.
      const taken = await exchange(running, [head("/api/list-projects", 2, asks), "{}"]);
      assert.match(taken.answer, /^HTTP\/1\.1 100 Continue\r\n\r\nHTTP\/1\.1 200 OK\r\n/);
      assert.match(taken.answer, /\{"projects":\[\]\}$/);
      // Where the body would not be read, it is not asked for: the answer comes as it is.
      assert.equal(first((await exchange(running, [head("/api/list-projects", 5_000_000, asks)], 1000)).answer), "HTTP/1.1 413 Payload Too Large");
      assert.equal(first((await exchange(running, [head("/api/list-projects", 2, asks + wrongKey)], 1000)).answer), "HTTP/1.1 401 Unauthorized");
      assert.equal(first((await exchange(running, [head("/mcp", 2, asks + wrongKey)], 1000)).answer), "HTTP/1.1 401 Unauthorized");
      assert.equal(first((await exchange(running, [head("/api/list-projects", 2, `${asks}Sec-Fetch-Site: cross-site\r\n`)], 1000)).answer), "HTTP/1.1 403 Forbidden");
      assert.equal(first((await exchange(running, [head("/nothing-here", 2, asks)], 1000)).answer), "HTTP/1.1 404 Not Found");
      const plain = await exchange(running, [`POST /api/list-projects HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n${asks}\r\n`], 1000);
      assert.equal(first(plain.answer), "HTTP/1.1 400 Bad Request", "a body that does not say it is JSON is not asked for either");
      // MCP takes a body as large as the API does: one of a megabyte is asked for, one of two is not.
      const more = `${asks}Accept: application/json, text/event-stream\r\n`;
      assert.equal(first((await exchange(running, [head("/mcp", 1024 * 1024, more)], 500)).answer), "HTTP/1.1 100 Continue");
      const tooLarge = await exchange(running, [head("/mcp", 2_000_000, more)], 1000);
      assert.equal(first(tooLarge.answer), "HTTP/1.1 413 Payload Too Large");
      assert.match(tooLarge.answer, /"message":"The request body is larger than 1 MB\."/);
      // Nor is a body asked for that MCP would not read: one that does not say it is JSON, or a request that
      // does not take both kinds of answer.
      const text = await exchange(running, [`POST /mcp HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n${more}\r\n`], 1000);
      assert.equal(first(text.answer), "HTTP/1.1 415 Unsupported Media Type");
      assert.match(text.answer, /"message":"Unsupported Media Type: Content-Type must be application\/json"/);
      assert.equal(first((await exchange(running, [head("/mcp", 2, asks)], 1000)).answer), "HTTP/1.1 406 Not Acceptable");
      assert.equal(first((await exchange(running, [head("/mcp", 2, `${asks}Accept: application/json\r\n`)], 1000)).answer), "HTTP/1.1 406 Not Acceptable");
      // MCP is told to go ahead as well, and answers.
      const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
      const mcp = await exchange(running, [head("/mcp", ping.length, `${asks}Accept: application/json, text/event-stream\r\n`), ping]);
      assert.match(mcp.answer, /^HTTP\/1\.1 100 Continue\r\n\r\nHTTP\/1\.1 200 OK\r\n/);
      assert.match(mcp.answer, /\{"result":\{\},"jsonrpc":"2\.0","id":1\}$/);
    } finally {
      await running.stop();
    }
  });

  it("ends the connection with an answer it gives before the body of the request is here, and carries out nothing that came behind it", async () => {
    const running = await start();
    try {
      const create = (title: string, prefix: string) => {
        const body = JSON.stringify({ title, prefix });
        return `POST /api/create-project HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
      };
      const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
      const mcp = (more: string) => `POST /mcp HTTP/1.1\r\nHost: localhost\r\n${more}Content-Length: ${ping.length}\r\n\r\n${ping}`;
      const takes = "Accept: application/json, text/event-stream\r\n";
      // Each refusal with a change behind it, in one piece: by the endpoint for what the request says of its
      // body or of the answers it takes, by the service for the page it comes from, and by the API for its key.
      const refusals: Array<[string, string, string]> = [
        ["415 Unsupported Media Type", mcp(`Content-Type: text/plain\r\n${takes}`), "ONE"],
        ["406 Not Acceptable", mcp("Content-Type: application/json\r\nAccept: application/json\r\n"), "TWO"],
        ["403 Forbidden", mcp(`Content-Type: application/json\r\n${takes}Sec-Fetch-Site: cross-site\r\n`), "THREE"],
        ["401 Unauthorized", mcp(`Content-Type: application/json\r\n${takes}Authorization: Bearer vig_wrongwrongwrongwrongwrong\r\n`), "FOUR"],
        ["401 Unauthorized", `POST /api/list-projects HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nAuthorization: Bearer vig_wrongwrongwrongwrongwrong\r\nContent-Length: 2\r\n\r\n{}`, "FIVE"],
      ];
      for (const [status, refused, prefix] of refusals) {
        const { answer, closed } = await exchange(running, [refused + create(`Behind a refusal ${prefix}`, prefix)], 2000);
        assert.equal(answer.split("\r\n")[0], `HTTP/1.1 ${status}`);
        assert.match(answer, /\r\nConnection: close\r\n/i, status);
        assert.equal(closed, true, `${status}: the connection ended with the answer`);
        assert.equal(answer.split("HTTP/1.1 ").length - 1, 1, `${status}: one answer, and none to what came behind it`);
      }
      assert.deepEqual((await running.call("/api/list-projects", {})).body.projects, [], "nothing behind a refusal was carried out");
      // Only a POST has a use for a body. A stream of changes asked for with one would go on while what came
      // behind it is not looked at: it is refused like the others, and the connection ends.
      const stream = await exchange(running, [`GET /api/events HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}` + create("Behind a stream", "SIX")], 2000);
      assert.equal(stream.answer.split("\r\n")[0], "HTTP/1.1 400 Bad Request");
      assert.match(stream.answer, /"code":"invalid_input","message":"Only a POST request may have a body\."/);
      assert.match(stream.answer, /\r\nConnection: close\r\n/i);
      assert.equal(stream.closed, true, "the connection ended with the answer");
      assert.equal(stream.answer.split("HTTP/1.1 ").length - 1, 1, "one answer, and none to what came behind it");
      assert.deepEqual((await running.call("/api/list-projects", {})).body.projects, [], "nothing behind the refused stream was carried out");
      assert.equal((await running.call("/api/admin/status", undefined, running.adminKey)).body.listeners, 0, "no stream was begun");
      // A stream of changes is the last answer on its connection, and says so: a refusal behind it could not
      // be sent while the stream goes on, so neither it nor what follows it is looked at.
      const behind = await exchange(running, ["GET /api/events HTTP/1.1\r\nHost: localhost\r\n\r\n" + mcp(`Content-Type: text/plain\r\n${takes}`) + create("Behind a stream and a refusal", "SEVEN")], 700);
      assert.match(behind.answer, /^HTTP\/1\.1 200 OK\r\n/);
      assert.match(behind.answer, /\r\nConnection: close\r\n/i);
      assert.doesNotMatch(behind.answer, /keep-alive/i);
      assert.match(behind.answer, /event: hello\n/);
      assert.equal(behind.closed, false, "the stream goes on");
      assert.equal(behind.answer.split("HTTP/1.1 ").length - 1, 1, "one answer, the stream");
      assert.deepEqual((await running.call("/api/list-projects", {})).body.projects, [], "nothing behind the stream was carried out");
      // What is not looked at is counted all the same: a connection that sends more behind its stream than a
      // connection may have unanswered is closed, and the stream with it.
      const many = await exchange(running, ["GET /api/events HTTP/1.1\r\nHost: localhost\r\n\r\n" + "GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n".repeat(LIMITS.unanswered)], 2000);
      assert.equal(many.closed, true, "the connection was closed");
      assert.ok(many.answer.split("HTTP/1.1 ").length - 1 <= 1, "and none of them was answered");
      assert.equal(await until(async () => ((await running.call("/api/admin/status", undefined, running.adminKey)).body.listeners as number) === 0, 2000), true, "no stream is left");
      // A large body that is refused for what it says is not taken in: the answer does not wait for it.
      const large = await exchange(running, [`POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\n${takes}Content-Length: 50000000\r\n\r\n${" ".repeat(100_000)}`], 2000);
      assert.equal(large.answer.split("\r\n")[0], "HTTP/1.1 415 Unsupported Media Type");
      assert.equal(large.closed, true);
      // A body that grows past what is taken without having said how large it is, over the API and over MCP:
      // the refusal is sent, the connection ends, and the change behind it is not carried out.
      const piece = " ".repeat(64 * 1024);
      const pieces = `${piece.length.toString(16)}\r\n${piece}\r\n`.repeat(20) + "0\r\n\r\n";
      for (const [path, more, said] of [
        ["/api/create-project", "", /"code":"limit_exceeded","message":"The request body is larger than 1 MB\."/],
        ["/mcp", takes, /"message":"The request body is larger than 1 MB\."/],
      ] as const) {
        const grown = await exchange(running, [`POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n${more}Transfer-Encoding: chunked\r\n\r\n${pieces}` + create(`Behind a body that grew ${path}`, "EIGHT")], 3000);
        assert.equal(grown.answer.split("\r\n")[0], "HTTP/1.1 413 Payload Too Large", path);
        assert.match(grown.answer, said, path);
        assert.match(grown.answer, /\r\nConnection: close\r\n/i, path);
        assert.equal(grown.closed, true, `${path}: the connection ended with the answer`);
        assert.equal(grown.answer.split("HTTP/1.1 ").length - 1, 1, `${path}: one answer, and none to what came behind it`);
      }
      assert.deepEqual((await running.call("/api/list-projects", {})).body.projects, [], "nothing behind a body that grew was carried out");
      // A body that comes a byte at a time is read whole and as it was written over the API too.
      const inBytes = Buffer.from(JSON.stringify({ title: "Stück für Stück ✓", prefix: "BYTE", description: "d".repeat(2000) }));
      const bytes = [...inBytes].map((byte) => Buffer.concat([Buffer.from("1\r\n"), Buffer.from([byte]), Buffer.from("\r\n")]).toString("latin1")).join("");
      const { port, hostname } = new URL(running.service.urls.base);
      const read = await new Promise<string>((resolve, reject) => {
        const socket = openSocket(Number(port), hostname, () => socket.write(`POST /api/create-project HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${bytes}0\r\n\r\n`, "latin1"));
        let answer = "";
        socket.on("data", (chunk) => (answer += chunk));
        socket.on("close", () => resolve(answer));
        socket.on("error", reject);
      });
      assert.equal(read.split("\r\n")[0], "HTTP/1.1 200 OK");
      const made = (await running.call("/api/get", { id: "BYTE" })).body;
      assert.equal(made.title, "Stück für Stück ✓");
      assert.equal((await running.call("/api/delete", { id: "BYTE", version: made.version, permanent: true }, running.adminKey)).status, 200);
      // Requests that are taken keep their connection, and each is answered in its turn.
      const kept = await exchange(running, [mcp(`Content-Type: application/json\r\n${takes}`) + create("Behind an answer", "KEPT")], 700);
      assert.equal(kept.closed, false);
      assert.deepEqual(kept.answer.match(/HTTP\/1\.1 \d+/g), ["HTTP/1.1 200", "HTTP/1.1 200"]);
      assert.deepEqual((await running.call("/api/list-projects", {})).body.projects.map((project: { id: string }) => project.id), ["KEPT"]);
    } finally {
      await running.stop();
    }
  });

  it("says what goes wrong with the server once it runs, and goes on", async () => {
    const running = await start();
    try {
      running.service.server.emit("error", new Error("EMFILE: too many open files"));
      assert.match(running.warnings.join("\n"), /^The server reported an error: Error: EMFILE: too many open files/m);
      assert.equal((await running.call("/health")).status, 200);
    } finally {
      await running.stop();
    }
  });

  it("gives one address a share of the places on the stream of changes, not all of them", async () => {
    const running = await start();
    const aborts: AbortController[] = [];
    // The answers of those that listen are kept: one that nothing refers to any more has its connection closed for it.
    const listening: Response[] = [];
    try {
      const listen = async () => {
        const abort = new AbortController();
        aborts.push(abort);
        const response = await fetch(`${running.service.urls.base}/api/events`, { signal: abort.signal });
        listening.push(response);
        return response.status === 200 ? { status: 200 } : { status: response.status, body: (await response.json()) as any };
      };
      const answers = [];
      for (let i = 0; i < 34; i++) answers.push(await listen());
      assert.deepEqual(answers.slice(0, 32).map((a) => a.status), Array(32).fill(200));
      assert.deepEqual(answers.slice(32).map((a) => a.status), [429, 429]);
      assert.equal(answers[33]!.body.error.code, "too_many_requests");
      assert.match(answers[33]!.body.error.message, /^32 clients at your address are already listening/);
      // Behind a proxy on this machine every listener would come from the one address; the proxy says whom it
      // speaks for, and each of them has a share of their own.
      const behind = async (client: string) => {
        const abort = new AbortController();
        aborts.push(abort);
        const response = await fetch(`${running.service.urls.base}/api/events`, { signal: abort.signal, headers: { "x-forwarded-for": client } });
        listening.push(response);
        return response.status;
      };
      assert.equal(await behind("203.0.113.7"), 200);
      // What a client writes into that header itself stands before what the proxy adds, and does not count: one
      // client cannot pass for many by naming a new address each time.
      const sameClient = [];
      for (let i = 0; i < 33; i++) sameClient.push(await behind(`198.51.100.${i}, 203.0.113.99`));
      assert.deepEqual([sameClient.filter((status) => status === 200).length, sameClient.at(-1)], [32, 429], "the 33rd connection of one client is refused, whatever it claims");
      // A place is free again as soon as one of them leaves.
      const listeners = async () => (await running.call("/api/admin/status", undefined, running.adminKey)).body.listeners as number;
      assert.equal(await listeners(), 65);
      aborts[0]!.abort();
      assert.equal(await until(async () => (await listeners()) === 64, 2000), true);
      assert.equal((await listen()).status, 200);

      // Whatever is sent from this machine is believed about whom it speaks for, a proxy and any other program
      // alike. Together they have all places but the share of one address, which is left to clients that connect
      // from elsewhere themselves: a program here that names a new address each time does not take every place.
      const others = [];
      for (let i = 0; i < 104; i++) others.push(await behind(`192.0.2.${i}`));
      assert.deepEqual([others.slice(0, 103).every((status) => status === 200), others[103], await listeners()], [true, 429, 168]);
      const abort = new AbortController();
      aborts.push(abort);
      const full = await fetch(`${running.service.urls.base}/api/events`, { signal: abort.signal, headers: { "x-forwarded-for": "192.0.2.200" } });
      assert.match(((await full.json()) as any).error.message, /^168 clients that connect from the service's own machine are already listening for changes\.$/);
      assert.equal(listening.length, 34 + 1 + 33 + 1 + 104 + 0);
    } finally {
      for (const abort of aborts) abort.abort();
      await running.stop();
    }
  });
});

describe("a service whose log cannot be written", () => {
  it("starts, answers, and reports what goes wrong to nobody without stopping for it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-nolog-"));
    const config = join(directory, "config.toml");
    initConfig(config, { name: "nolog", port: await freePort() });
    // Something to warn about at the start: a key for a user that does not exist.
    setKey(config, "ghost", "vig_ghostghostghostghostghost");
    const full = () => {
      throw new Error("ENOSPC: the log is full");
    };
    const service = await startService({ loaded: loadConfig(config, {}), log: full, warn: full });
    try {
      const ask = (path: string) => fetch(`${service.urls.base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal((await ask("/api/list-projects")).status, 200);
      // Something inside the service breaks for a request, in a place no operation looks after.
      const real = service.engine.user.bind(service.engine);
      service.engine.user = () => {
        throw new Error("broken inside");
      };
      const broken = await ask("/api/list-projects");
      assert.equal(broken.status, 500, "the request is answered, with an error");
      service.engine.user = real;
      assert.equal((await ask("/api/list-projects")).status, 200, "and the service goes on");
    } finally {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("says in its log what went wrong for a request outside any operation", async () => {
    const running = await start();
    try {
      // Finding out who calls breaks, which no operation looks after: the caller gets an error without the
      // reason, and the log gets the reason.
      const real = running.service.engine.user.bind(running.service.engine);
      running.service.engine.user = () => {
        throw new Error("broken inside");
      };
      const broken = await running.call("/api/list-projects", {});
      running.service.engine.user = real;
      assert.equal(broken.status, 500);
      assert.equal(JSON.stringify(broken.body).includes("broken inside"), false, "what went wrong inside stays inside");
      assert.equal(running.warnings.length, 1);
      assert.match(running.warnings[0]!, /A request to the API failed unexpectedly: Error: broken inside/);
      // A refusal is no such thing: nothing is logged for a caller's mistake.
      await running.call("/api/no-such-operation", {});
      assert.equal(running.warnings.length, 1);
      // The same on the MCP endpoint, where finding out who calls comes before anything else.
      running.service.engine.user = () => {
        throw new Error("broken inside");
      };
      const mcp = await fetch(`${running.service.urls.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      running.service.engine.user = real;
      assert.equal(mcp.status, 500);
      assert.equal((await mcp.text()).includes("broken inside"), false);
      assert.equal(running.warnings.length, 2);
      assert.match(running.warnings[1]!, /A request to \/mcp failed unexpectedly: Error: broken inside/);
    } finally {
      await running.service.stop();
      rmSync(running.directory, { recursive: true, force: true });
    }
  });
});

describe("a service whose config writes this machine's own address in another way", () => {
  it("goes by the address it is bound to: it answers only to the machine's own names", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-bound-"));
    const config = join(directory, "config.toml");
    // 127.1 is 127.0.0.1 to the system, and does not look like it.
    initConfig(config, { name: "bound", address: "127.1", port: await freePort() });
    const service = await startService({ loaded: loadConfig(config, {}), log: () => {}, warn: () => {} });
    try {
      assert.equal(isLoopback("127.1"), false, "by its looks it is some name");
      assert.equal(service.loopbackOnly, true, "by what the service is bound to it is this machine");
      const { port } = new URL(service.urls.base);
      const post = (host: string) =>
        new Promise<string>((resolve, reject) => {
          const socket = openSocket(Number(port), "127.0.0.1", () => socket.write(`POST /api/list-projects HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`));
          let answer = "";
          socket.on("data", (chunk) => (answer += chunk));
          socket.on("end", () => resolve(answer.split("\r\n")[0]!));
          socket.on("error", reject);
        });
      assert.equal(await post("evil.example"), "HTTP/1.1 403 Forbidden");
      assert.equal(await post(`127.0.0.1:${port}`), "HTTP/1.1 200 OK");
      assert.equal(await post(`127.1:${port}`), "HTTP/1.1 200 OK", "the address as the config writes it is one of the machine's own too");
    } finally {
      await service.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("a service whose config gives it a name of the machine's own that leads to the machine itself", () => {
  it("answers to that name, which is the one it prints and the command line uses, and to no other", () => {
    const named = (host: string, configured: string, loopbackOnly = true) => namedFromOutside({ headers: { host } }, loopbackOnly, configured);
    // "workshop" stands in the machine's own table of names for 127.0.1.1: the service is bound to this machine only.
    for (const host of ["workshop:8700", "workshop", "WORKSHOP:8700", "workshop.:8700", "127.0.1.1:8700", "localhost:8700"]) assert.equal(named(host, "workshop"), null, host);
    for (const host of ["evil.example:8700", "workshop.evil.example", "notworkshop", "workshop2:8700"]) assert.notEqual(named(host, "workshop"), null, host);
    // Bound beyond this machine, it answers under any name, as before.
    assert.equal(named("evil.example", "workshop", false), null);
  });
});

describe("an address that is this machine itself", () => {
  it("is known as such however it is written, so that the checks that go with it are not left off", () => {
    for (const address of ["127.0.0.1", "127.5.6.7", "localhost", "LOCALHOST", "localhost.", "::1", "[::1]", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::FFFF:127.1.2.3", "::ffff:7f00:1", "::1%lo"]) {
      assert.equal(isLoopback(address), true, address);
    }
    // An address with the name of its interface after it, as link-local ones are written, is an address like any other.
    for (const address of ["0.0.0.0", "::", "192.168.1.20", "::ffff:192.168.1.20", "example.org", "127.0.0.1.evil.example", "localhost.evil.example", "2130706433", "::2", "", "fe80::1%eth0", "[fe80::1%eth0]", "%", "::%"]) {
      assert.equal(isLoopback(address), false, address);
    }
  });
});

describe("a service that listens beyond this machine", () => {
  it("answers under whatever name it is reached by, with nothing to configure", async () => {
    const running = await start({ VIGILE_LISTEN_ADDRESS: "0.0.0.0" });
    try {
      for (const host of ["plan.example.org", "plan.tailnet.example:8700", "192.168.1.20"]) {
        assert.equal(await raw(running, `POST /api/list-projects HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`), "HTTP/1.1 200 OK", host);
      }
    } finally {
      await running.stop();
    }
  });
});

describe("a run started to want a key from everyone", () => {
  it("still wants one after a user is added and after the config file changes", async () => {
    // The file lets agent1 in without a key. The environment of this run says otherwise.
    const running = await start({ VIGILE_AUTH_KEYLESS_USER: "" });
    try {
      assert.equal((await running.call("/api/list-projects", {})).status, 401);
      const made = await running.call("/api/create-user", { username: "agent9", type: "agent" }, running.adminKey);
      assert.equal(made.status, 200);
      assert.equal((await running.call("/api/list-projects", {})).status, 401, "after a user was added");
      assert.equal((await running.call("/api/list-projects", {}, made.body.api_key)).status, 200, "while the new key works at once");
      setKey(running.config, "agent8", "vig_not-a-real-key-0123456789abcdef");
      utimesSync(running.config, new Date(), new Date(Date.now() + 5000));
      assert.equal((await running.call("/api/list-projects", {})).status, 401, "after the file changed");
      const status = await running.call("/api/admin/status", undefined, running.adminKey);
      assert.equal(status.body.auth.keyless_user, "");
    } finally {
      await running.stop();
    }
  });
});

describe("stream of changes", () => {
  let running: Running;
  before(async () => (running = await start()));
  after(() => running.stop());

  it("says hello with the current revision, then reports each change as it is stored, and nothing about its content", async () => {
    const stream = await listen(running);
    assert.equal(stream.response.status, 200);
    assert.match(stream.response.headers.get("content-type") ?? "", /^text\/event-stream/);
    await stream.until(1);
    const start = stream.events[0]!;
    assert.equal(start.event, "hello");

    const began = Date.now();
    const created = await running.call("/api/create-task", { title: "Secret title", description: "Secret description" });
    await stream.until(2);
    assert.ok(Date.now() - began < 1000, "the change is reported at once");
    assert.deepEqual(stream.events[1], { event: "change", revision: start.revision + 1 });
    await running.call("/api/set-task-status", { id: created.body.id, version: 1, status: "in_progress" });
    await stream.until(3);
    assert.deepEqual(stream.events[2], { event: "change", revision: start.revision + 2 });

    // Reads and refused writes change nothing, so they are not reported.
    await running.call("/api/list-tasks", {});
    await running.call("/api/set-task-status", { id: created.body.id, version: 1, status: "done" });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(stream.events.length, 3);
    stream.close();
  });

  it("lets go of a listener that has stopped reading, and keeps nothing more for it", async () => {
    const { createApiHandler } = await import("@vigile/http-api");
    const { EventEmitter } = await import("node:events");
    const api = createApiHandler({ engine: running.service.engine, caller: () => ({ username: "agent1", id: running.service.engine.user("agent1")!.id, keyless: true }), instance: () => ({}) });
    // A client whose connection takes two more messages and then is full, as one that has stopped reading is.
    let room = 2;
    const written: string[] = [];
    const seen = { ended: false, destroyed: false };
    const response = {
      writeHead: () => response,
      write: (text: string) => (written.push(text), room-- > 0),
      end: () => void (seen.ended = true),
      destroy: () => void (seen.destroyed = true),
    };
    const request = Object.assign(new EventEmitter(), { method: "GET", headers: {} });
    await api(request as never, response as never, new URL("http://local/api/events"));
    assert.equal(api.streams(), 1);
    assert.match(written[0]!, /^event: hello/);

    await running.call("/api/create-task", { title: "First", description: "d" });
    assert.deepEqual([written.length, api.streams(), seen.destroyed], [2, 1, false], "a message that goes out keeps the listener");
    await running.call("/api/create-task", { title: "Second", description: "d" });
    assert.deepEqual([written.length, api.streams(), seen.ended, seen.destroyed], [3, 0, true, true], "the first message that does not go out ends the stream and drops what was kept for it");
    await running.call("/api/create-task", { title: "Third", description: "d" });
    assert.equal(written.length, 3, "nothing more is written for a listener that was let go");
  });

  it("reports a change to every listener, and stops reporting to one that has left", async () => {
    const first = await listen(running);
    const second = await listen(running);
    await first.until(1);
    await second.until(1);
    const status = await running.call("/api/admin/status", undefined, running.adminKey);
    assert.equal(status.body.listeners, 2);
    first.close();
    await first.reading;
    await running.call("/api/create-task", { title: "Another", description: "d" });
    await second.until(2);
    assert.equal(first.events.length, 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await running.call("/api/admin/status", undefined, running.adminKey)).body.listeners, 1);
    second.close();
  });

  it("needs a key when the operations do", async () => {
    setValue(running.config, "auth.keyless_user", "");
    try {
      const refused = await listen(running);
      assert.equal(refused.response.status, 401);
      const wrong = await listen(running, "vig_not-a-real-key-000000000000");
      assert.equal(wrong.response.status, 401);
      const allowed = await listen(running, running.adminKey);
      assert.equal(allowed.response.status, 200);
      await allowed.until(1);
      allowed.close();
    } finally {
      setValue(running.config, "auth.keyless_user", "agent1");
    }
  });

  it("ends a stream at its next message once its listener is no longer let in", async () => {
    const listeners = async () => (await running.call("/api/admin/status", undefined, running.adminKey)).body.listeners as number;
    const ended = async (stream: Awaited<ReturnType<typeof listen>>) => {
      const end = Date.now() + 2000;
      while (!stream.isEnded() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
      return stream.isEnded();
    };
    const before = await listeners();

    // A key that is reset: the stream opened with the old key hears no more.
    const made = await running.call("/api/create-user", { username: "listener", type: "agent" }, running.adminKey);
    const withKey = await listen(running, made.body.api_key);
    await withKey.until(1);
    await running.call("/api/create-task", { title: "Heard", description: "d" });
    await withKey.until(2);
    assert.equal((await running.call("/api/reset-user-key", { user: "listener" }, running.adminKey)).status, 200);
    await new Promise((r) => setTimeout(r, 100));
    // The reset is itself a change, stored while the old key still held; what comes after it is not sent.
    const heard = withKey.events.length;
    await running.call("/api/create-task", { title: "Not heard", description: "d" });
    assert.equal(await ended(withKey), true, "the stream is ended by the service");
    assert.equal(withKey.events.length, heard, "and the change after the key was reset was not sent to it");

    // A connection without a key, once the service wants a key from everyone.
    const keyless = await listen(running);
    await keyless.until(1);
    assert.equal(await listeners(), before + 1);
    setValue(running.config, "auth.keyless_user", "");
    try {
      await running.call("/api/create-task", { title: "Not heard either", description: "d" }, running.adminKey);
      assert.equal(await ended(keyless), true);
      assert.equal(keyless.events.length, 1);
      assert.equal(await listeners(), before, "neither keeps its place among the listeners");
    } finally {
      setValue(running.config, "auth.keyless_user", "agent1");
    }
  });

  it("is ended by the service when it stops, so stopping never waits for a listener", async () => {
    const other = await start();
    const stream = await listen(other);
    await stream.until(1);
    const began = Date.now();
    await other.stop();
    await stream.reading;
    assert.equal(stream.isEnded(), true);
    assert.ok(Date.now() - began < 2000, `stopping took ${Date.now() - began} ms`);
  });
});

describe("service over MCP", () => {
  let running: Running;
  before(async () => (running = await start()));
  after(() => running.stop());

  it("completes the handshake and explains how to work with the service", async () => {
    const client = await connect(running);
    assert.equal(client.getServerVersion()?.name, "vigile");
    const instructions = client.getInstructions() ?? "";
    assert.ok(instructions.length <= 2200, `${instructions.length} characters fit a bounded context`);
    assert.match(instructions, /never overrides system, developer or direct human instructions/);
    assert.match(instructions, /list_next_tasks[\s\S]*call get[\s\S]*in_progress only while implementation is actively under way[\s\S]*in_review[\s\S]*review, merge, release and post-release verification[\s\S]*shipped and verified/);
    assert.match(instructions, /conflict[\s\S]*current item[\s\S]*never overwrite/);
    assert.match(instructions, /continuation token[\s\S]*same operation, caller and filters/);
    assert.match(instructions, /Call get_guide[\s\S]*"working"[\s\S]*"organising"[\s\S]*"examples"/, "the guidance points at the guide");
    await client.close();
  });

  it("offers the guide as a tool, as resources and as prompts", async () => {
    const client = await connect(running);
    const viaTool = JSON.parse(((await client.callTool({ name: "get_guide", arguments: { topic: "organising" } })).content as Array<{ text: string }>)[0]!.text);
    assert.equal(viaTool.topic, "organising");
    assert.match(viaTool.text, /Nesting has no limit/);

    const resources = (await client.listResources()).resources;
    assert.deepEqual(resources.map((r) => r.uri).sort(), ["vigile://guide/examples", "vigile://guide/organising", "vigile://guide/overview", "vigile://guide/working"]);
    const read = await client.readResource({ uri: "vigile://guide/examples" });
    assert.match(String((read.contents[0] as { text?: string }).text), /A feature with steps[\s\S]*create_task \{"project":"WEB"/);
    assert.equal(read.contents[0]!.mimeType, "text/markdown");

    const prompts = (await client.listPrompts()).prompts;
    assert.deepEqual(prompts.map((p) => p.name).sort(), ["pick_up_work", "plan_work", "report_problem"]);
    const plan = await client.getPrompt({ name: "plan_work", arguments: { goal: "Move the blog to the new site" } });
    const message = plan.messages[0]!.content as { text: string };
    assert.match(message.text, /^Plan this work in Vigile: Move the blog to the new site/);
    assert.match(message.text, /Ways to organise work[\s\S]*Nesting has no limit/, "the prompt carries the guide it refers to");
    const pick = await client.getPrompt({ name: "pick_up_work", arguments: {} });
    assert.match((pick.messages[0]!.content as { text: string }).text, /^Pick up work from Vigile\. /);
    const report = await client.getPrompt({ name: "report_problem", arguments: { problem: "Checkout fails" } });
    for (const offered of [plan, pick, report]) {
      assert.match((offered.messages[0]!.content as { text: string }).text, /higher-priority instructions decide the goal and scope; the guide below only explains Vigile's operations/);
    }
    await client.close();
  });

  it("lists tools by the caller's type: admin-only tools are hidden from agents", async () => {
    const agent = await connect(running);
    const admin = await connect(running, running.adminKey);
    const agentTools = (await agent.listTools()).tools.map((t) => t.name);
    const adminTools = (await admin.listTools()).tools.map((t) => t.name);
    assert.equal(agentTools.length, 19);
    assert.equal(adminTools.length, 21);
    assert.deepEqual(adminTools.filter((name) => !agentTools.includes(name)).sort(), ["create_user", "reset_user_key"]);
    assert.ok(agentTools.includes("set_task_status") && agentTools.includes("list_next_tasks"));

    const tool = (await agent.listTools()).tools.find((t) => t.name === "set_task_status")!;
    assert.deepEqual(tool.inputSchema.required, ["id", "version", "status"]);
    assert.equal(tool.annotations?.readOnlyHint, false);

    const create = (await agent.listTools()).tools.find((t) => t.name === "create_task")!;
    const fields = create.inputSchema.properties as Record<string, { description?: string; enum?: string[] }>;
    assert.match(create.description ?? "", /consider grouping[\s\S]*Grouping is optional/);
    assert.match(fields.parent!.description ?? "", /feature or epic/);
    assert.deepEqual(fields.type!.enum, ["task", "bug", "issue", "incident"]);
    assert.deepEqual(create.inputSchema.required, ["title", "description"], "neither a parent nor a type is required");
    const list = (await agent.listTools()).tools.find((t) => t.name === "list_tasks")!;
    assert.ok("top_level" in (list.inputSchema.properties as object) && "parent" in (list.inputSchema.properties as object));

    // Every tool describes its input as the API describes the operation's, in the dialect MCP clients read.
    const operations: Array<{ name: string; description: string; input: Record<string, unknown> }> = (await running.call("/api/operations", undefined, running.adminKey)).body.operations;
    const described = (await admin.listTools()).tools;
    assert.deepEqual(described.map((t) => t.name), operations.map((o) => o.name));
    for (const tool of described) {
      const operation = operations.find((o) => o.name === tool.name)!;
      assert.equal(tool.description, operation.description);
      assert.deepEqual(tool.inputSchema, { ...operation.input, $schema: "http://json-schema.org/draft-07/schema#" }, tool.name);
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} says that it takes no other field`);
    }
    await agent.close();
    await admin.close();
  });

  it("runs operations as tools and returns refusals the agent can act on", async () => {
    const agent = await connect(running);
    const project = payload(await agent.callTool({ name: "create_project", arguments: { title: "Alpha", prefix: "ABC" } }));
    assert.equal(project.id, "ABC");
    const first = payload(await agent.callTool({ name: "create_task", arguments: { title: "First", description: "d", project: "ABC" } }));
    const second = payload(
      await agent.callTool({ name: "create_task", arguments: { title: "Second", description: "d", project: "ABC", depends_on: [first.id] } }),
    );
    assert.deepEqual(payload(await agent.callTool({ name: "list_next_tasks", arguments: {} })).tasks.map((t: any) => t.id), [first.id]);

    const refused = await agent.callTool({ name: "set_task_status", arguments: { id: second.id, version: 1, status: "in_progress" } });
    assert.equal(refused.isError, true);
    assert.equal(payload(refused).error.rule, "unfinished_dependencies");
    assert.ok(payload(refused).error.actions.length > 0);

    const started = payload(await agent.callTool({ name: "set_task_status", arguments: { id: first.id, version: 1, status: "in_progress" } }));
    assert.deepEqual(started.assigned_to, ["agent1"]);
    await agent.close();
  });

  it("refuses input the engine refuses with the error body the API returns, whatever is wrong with it, and writes each refusal to the log", async () => {
    const agent = await connect(running);
    // What the log says of an operation, without when it was and how long it took.
    const said = (from: number) => running.logged.slice(from).map((line) => line.replace(/^\S+ /, "").replace(/ ms=\S+/, ""));
    // A call as the request it is, for what a client made with the library would not send.
    const raw = async (params: unknown) => {
      const response = await fetch(running.service.urls.mcp, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
      });
      return (await response.json()) as { result?: any; error?: { code: number; message: string } };
    };
    for (const [tool, input, code, message] of [
      // A value of the wrong type, a required field that is missing, a field nobody knows.
      ["get", { id: 5 }, "invalid_input", /^The input for get is not valid\. id: Invalid input: expected string, received number\.$/],
      ["get", {}, "invalid_input", /^The input for get is not valid\. id is required\.$/],
      ["get", { id: "ABC-001", nonsense: 1 }, "invalid_input", /Unrecognized key: "nonsense"/],
      ["create_task", { title: "T", description: "d", depends_on: "ABC-001", size: "large" }, "invalid_input", /size: .*expected number, received string\. depends_on: .*expected array, received string\.$/],
      // Input that is no object at all.
      ["get", "ABC-001", "invalid_input", /input: Invalid input: expected object, received string/],
      ["get", ["ABC-001"], "invalid_input", /input: Invalid input: expected object, received array/],
      // A tool the caller's type may not call, and one that does not exist: a name every object answers to.
      ["create_user", { username: "x", type: "agent" }, "forbidden", /create_user is for admin users; you are connected as agent1/],
      ["constructor", {}, "not_found", /There is no operation called "constructor"/],
    ] as const) {
      const from = running.logged.length;
      const viaApi = await running.call(`/api/${tool.replaceAll("_", "-")}`, input);
      const viaMcp = typeof input === "object" && !Array.isArray(input) ? await agent.callTool({ name: tool, arguments: input as Record<string, unknown> }) : (await raw({ name: tool, arguments: input })).result;
      const what = `${tool} ${JSON.stringify(input)}`;
      assert.equal(viaMcp.isError, true, what);
      assert.deepEqual(payload(viaMcp), viaApi.body, what);
      assert.equal(viaApi.body.error.code, code, what);
      assert.match(viaApi.body.error.message, message, what);
      // One line for the call over the API and one for the call over MCP, and they say the same.
      const line = `op=${tool} caller=agent1 kind=${tool === "get" || tool === "constructor" ? "read" : "write"} result=${code}`;
      assert.deepEqual(said(from), [line, line], what);
    }
    // No arguments, or null for them, is no input, as an empty body is over the API.
    for (const params of [{ name: "list_link_types" }, { name: "list_link_types", arguments: null }]) {
      assert.ok(payload((await raw(params)).result).link_types.length > 0);
    }
    // A request that names no tool is not a call of one. It is answered as the protocol answers a request that
    // is not well made, and so is a method there is none of.
    const from = running.logged.length;
    for (const params of [{ arguments: {} }, { name: 5, arguments: {} }, undefined]) {
      const answer = await raw(params);
      assert.equal(answer.result, undefined);
      assert.deepEqual(answer.error, { code: -32602, message: "A tools/call request names the tool to call, as text, in params.name." });
    }
    const unknown = await fetch(running.service.urls.mcp, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/destroy" }) });
    assert.deepEqual(((await unknown.json()) as { error: unknown }).error, { code: -32601, message: "Method not found" });
    assert.deepEqual(said(from), []);
    await agent.close();
  });

  it("refuses a hidden tool even when called by name, and a connection with a wrong key", async () => {
    const agent = await connect(running);
    const result = await agent.callTool({ name: "create_user", arguments: { username: "x", type: "agent" } }).catch((error) => error);
    assert.ok(result instanceof Error || result.isError, "an agent cannot call an admin-only tool");
    await agent.close();
    await assert.rejects(connect(running, "vig_not-a-real-key-000000000000"));
  });

  /** A request to the endpoint as it is written, and its answer: the status, the text, and the text as JSON. */
  const sent = async (to: Running, body: unknown, key?: string) => {
    const response = await fetch(to.service.urls.mcp, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, answer: text ? JSON.parse(text) : null, closes: response.headers.get("connection") === "close" };
  };
  const ping = (params?: unknown) => ({ jsonrpc: "2.0", id: 1, method: "ping", ...(params === undefined ? {} : { params }) });

  it("reads a megabyte of a request and no more, whether or not the request says how large it is", async () => {
    const large = JSON.stringify(ping({ _meta: { pad: " ".repeat(1024 * 1024) } }));
    const refused = await sent(running, large);
    assert.equal(refused.status, 413);
    assert.deepEqual(refused.answer, { jsonrpc: "2.0", error: { code: -32000, message: "The request body is larger than 1 MB." }, id: null });
    assert.equal(refused.closes, true, "what is left of the body is not waited for");
    // Sent in pieces, with no word of its size: refused once it has grown past the limit, and not kept.
    const { port, hostname } = new URL(running.service.urls.base);
    const inPieces = await new Promise<string>((resolve, reject) => {
      const socket = openSocket(Number(port), hostname, () => {
        socket.write(`POST /mcp HTTP/1.1\r\nHost: ${hostname}:${port}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n`);
        const piece = " ".repeat(64 * 1024);
        for (let i = 0; i < 20; i++) socket.write(`${piece.length.toString(16)}\r\n${piece}\r\n`);
      });
      let answer = "";
      socket.on("data", (chunk) => (answer += chunk));
      socket.on("close", () => resolve(answer));
      socket.on("error", reject);
    });
    assert.equal(inPieces.split("\r\n")[0], "HTTP/1.1 413 Payload Too Large");
    assert.match(inPieces, /The request body is larger than 1 MB\./);
    // What is refused before its body is read is not read to keep the connection either: for its key, for the
    // answers it takes, or for what it says its body is. The connection ends with the answer.
    const refusedUnread = async (headers: Record<string, string>) => {
      const response = await fetch(running.service.urls.mcp, { method: "POST", headers, body: JSON.stringify(ping()) });
      await response.text();
      return [response.status, response.headers.get("connection")];
    };
    assert.deepEqual(await refusedUnread({ "content-type": "text/plain", accept: "application/json, text/event-stream" }), [415, "close"]);
    assert.deepEqual(await refusedUnread({ "content-type": "application/json", accept: "application/json" }), [406, "close"]);
    assert.deepEqual(await refusedUnread({ "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer vig_wrongwrongwrongwrongwrong" }), [401, "close"]);
    // A request that is taken keeps its connection.
    const taken = await fetch(running.service.urls.mcp, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(ping()) });
    assert.deepEqual([taken.status, taken.headers.get("connection"), await taken.json()], [200, "keep-alive", { result: {}, jsonrpc: "2.0", id: 1 }]);
    // A body that comes a byte at a time is read whole and as it was written, a character of several bytes too.
    const inBytes = await new Promise<string>((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_task", arguments: { title: "Stück für Stück ✓", description: "d".repeat(3000) } } }));
      const socket = openSocket(Number(port), hostname, () => {
        socket.write(`POST /mcp HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: close\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n`);
        for (const byte of body) socket.write(Buffer.concat([Buffer.from("1\r\n"), Buffer.from([byte]), Buffer.from("\r\n")]));
        socket.write("0\r\n\r\n");
      });
      let answer = "";
      socket.on("data", (chunk) => (answer += chunk));
      socket.on("close", () => resolve(answer));
      socket.on("error", reject);
    });
    assert.equal(inBytes.split("\r\n")[0], "HTTP/1.1 200 OK");
    assert.match(inBytes, /\\"title\\":\\"Stück für Stück ✓\\"/);
    // A body that is not JSON is answered as the protocol answers one, and a megabyte less a little is read.
    assert.deepEqual((await sent(running, "{not json")).answer, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error: Invalid JSON" }, id: null });
    assert.deepEqual((await sent(running, JSON.stringify(ping({ _meta: { pad: " ".repeat(1024 * 1024 - 200) } })))).answer, { result: {}, jsonrpc: "2.0", id: 1 });
  });

  it("takes one message in a request: a list of them is refused whole, and nothing in it is carried out", async () => {
    const projects = async () => payload((await sent(running, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_projects", arguments: {} } })).answer.result).projects.length;
    const before = await projects();
    const refusal = { jsonrpc: "2.0", error: { code: -32600, message: "This endpoint takes one message in a request, not a list of them." }, id: null };
    for (const list of [
      [ping(), ping()],
      [ping()],
      [],
      // A call, and word in the same request that the call is taken back: the answer would wait for good.
      [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_project", arguments: { title: "In a list", prefix: "LST" } } }, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }],
      Array.from({ length: 100 }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/list" })),
    ]) {
      const began = Date.now();
      const answer = await sent(running, list);
      assert.equal(answer.status, 400, `${list.length} messages`);
      assert.deepEqual(answer.answer, refusal);
      assert.ok(Date.now() - began < 2000, "answered at once");
    }
    assert.equal(await projects(), before, "the project of the refused list was not created");
    // One message at a time is what the library's own client sends: the handshake and a call go through.
    const client = await connect(running);
    assert.ok((await client.listTools()).tools.length > 0);
    await client.close();
  });

  it("refuses a message of more members and elements than a call has, however they are arranged, with a short answer", async () => {
    const tooMany = { jsonrpc: "2.0", error: { code: -32000, message: "The message has more than 1000 members and elements." }, id: 1 };
    const keys = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, 0]));
    const nested = (depth: number) => "[".repeat(depth) + "]".repeat(depth);
    const initialize = (icons: unknown[]) => ({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "a", version: "1", icons } } });
    for (const [what, body] of [
      ["a long list of values of the wrong kind", initialize(Array(50_000).fill(0))],
      ["a wide object", ping({ _meta: keys(5000) })],
      ["one more than is taken", ping({ _meta: keys(996) })],
      ["lists inside lists, as deep as the body allows", `{"jsonrpc":"2.0","id":1,"method":"ping","params":{"_meta":{"deep":${nested(200_000)}}}}`],
      ["many small objects", ping({ _meta: { all: Array.from({ length: 400 }, () => ({ a: 1, b: 2 })) } })],
    ] as const) {
      const answer = await sent(running, body);
      assert.equal(answer.status, 413, what);
      assert.deepEqual(answer.answer, tooMany, what);
    }
    // The message itself has four members, its params one, and 995 more make the thousand that are taken.
    assert.deepEqual((await sent(running, ping({ _meta: keys(995) }))).answer, { result: {}, jsonrpc: "2.0", id: 1 });
    // What is wrong with a message that is taken is said in a thousand characters, however much is wrong.
    const wrong = await sent(running, initialize(Array(900).fill(0)));
    assert.equal(wrong.status, 200);
    assert.equal(wrong.answer.id, 1);
    assert.equal(wrong.answer.error.message.length, 1000);
    assert.match(wrong.answer.error.message, /… \(\d{5,} characters\)$/);
    assert.ok(wrong.text.length < 1500, `${wrong.text.length} characters of answer`);
    // So is what the library refuses before it has a message to answer, which it answers by itself: a version
    // of the protocol that it does not speak, named at length.
    const version = await fetch(running.service.urls.mcp, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "9".repeat(3000) }, body: JSON.stringify(ping()) });
    const unspoken = (await version.json()) as { error: { code: number; message: string }; id: null };
    assert.deepEqual([version.status, unspoken.error.code, unspoken.id], [400, -32000, null]);
    assert.equal(unspoken.error.message.length, 1000);
    assert.match(unspoken.error.message, /^Bad Request: Unsupported protocol version: 9{900,}… \(\d{4} characters\)$/);
    // Text of any length is one value, and is not counted: a call with a full description goes through.
    const made = await sent(running, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_task", arguments: { title: "A full description", description: "d".repeat(4000) } } });
    assert.equal(payload(made.answer.result).title, "A full description");
  });

  it("passes on what the protocol library answers as it answered it: the status, the type, the length and the body", async () => {
    // The endpoint hands the library a message it has read itself and writes the library's answer itself. What
    // it relies on the library for is said here, so that a library that comes to behave otherwise is noticed.
    const ask = async (body: unknown, more: Record<string, string> = {}) => {
      const response = await fetch(running.service.urls.mcp, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...more }, body: JSON.stringify(body) });
      const bytes = Buffer.from(await response.arrayBuffer());
      return { status: response.status, type: response.headers.get("content-type"), length: response.headers.get("content-length"), session: response.headers.get("mcp-session-id"), bytes, text: bytes.toString("utf8") };
    };
    // A request is answered at once and in JSON, never as a stream, although the caller takes both; with no
    // session, since nothing is kept between requests.
    const hello = await ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "a", version: "1" } } });
    assert.deepEqual([hello.status, hello.type, hello.length, hello.session], [200, "application/json", String(hello.bytes.length), null]);
    const greeted = JSON.parse(hello.text);
    assert.deepEqual([greeted.id, greeted.result.protocolVersion, greeted.result.serverInfo.name], [1, "2025-06-18", "vigile"]);
    // The length is that of the bytes, not of the characters.
    const goal = "Stück für Stück ✓ ".repeat(50);
    const prompt = await ask({ jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: "plan_work", arguments: { goal } } });
    assert.deepEqual([prompt.status, prompt.length], [200, String(prompt.bytes.length)]);
    assert.ok(prompt.text.includes("Stück für Stück ✓"), prompt.text.slice(0, 300));
    assert.ok(prompt.bytes.length > prompt.text.length, "the answer has characters of several bytes");
    // What asks for no answer gets none: a notification, and an answer to something the service never asked.
    for (const message of [{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 5, result: {} }]) {
      const none = await ask(message);
      assert.deepEqual([none.status, none.bytes.length], [202, 0], JSON.stringify(message));
    }
    // What the library refuses is passed on with the status and the error it gave it.
    const noMessage = await ask({ hello: "there" });
    assert.deepEqual([noMessage.status, noMessage.type, JSON.parse(noMessage.text)], [400, "application/json", { jsonrpc: "2.0", error: { code: -32700, message: "Parse error: Invalid JSON-RPC message" }, id: null }]);
    const noVersion = await ask({ jsonrpc: "2.0", id: 3, method: "ping" }, { "mcp-protocol-version": "1999-01-01" });
    assert.equal(noVersion.status, 400);
    assert.match(JSON.parse(noVersion.text).error.message, /^Bad Request: Unsupported protocol version: 1999-01-01/);
    const noMethod = await ask({ jsonrpc: "2.0", id: 4, method: "tools/destroy" });
    assert.deepEqual([noMethod.status, JSON.parse(noMethod.text)], [200, { jsonrpc: "2.0", id: 4, error: { code: -32601, message: "Method not found" } }]);
    // None of it was the service's trouble.
    assert.deepEqual(running.warnings, []);
  });

  it("answers with an error, and says why in its log, when the protocol library fails at a request", async () => {
    const real = WebStandardStreamableHTTPServerTransport.prototype.handleRequest;
    const warned = running.warnings.length;
    try {
      for (const fails of [
        () => {
          throw new Error("the transport broke");
        },
        () => Promise.reject(new Error("the transport broke")),
      ]) {
        WebStandardStreamableHTTPServerTransport.prototype.handleRequest = fails as never;
        const broken = await sent(running, ping());
        assert.equal(broken.status, 500);
        assert.deepEqual(broken.answer, { jsonrpc: "2.0", error: { code: -32000, message: "The service hit an unexpected error." }, id: null });
      }
    } finally {
      WebStandardStreamableHTTPServerTransport.prototype.handleRequest = real;
    }
    assert.equal(running.warnings.length - warned, 2);
    for (const line of running.warnings.slice(warned)) assert.match(line, /^A request to \/mcp failed unexpectedly: Error: the transport broke\n/);
    running.warnings.length = warned;
    assert.deepEqual((await sent(running, ping())).answer, { result: {}, jsonrpc: "2.0", id: 1 });
  });

  it("lists the tools of the user that asks, the same every time it is asked", async () => {
    const list = async (key?: string) => (await sent(running, { jsonrpc: "2.0", id: 1, method: "tools/list" }, key)).answer.result.tools as Array<{ name: string }>;
    const [first, second, admins] = [await list(), await list(), await list(running.adminKey)];
    assert.deepEqual(second, first);
    assert.equal(first.some((tool) => tool.name === "create_user"), false);
    assert.equal(admins.some((tool) => tool.name === "create_user"), true);
    assert.deepEqual(admins.filter((tool) => first.some((one) => one.name === tool.name)), first, "each tool is described the same to both");
  });

  it("is still there for the next caller after one that left before its request was here", async () => {
    const { port, hostname } = new URL(running.service.urls.base);
    const warned = running.warnings.length;
    await new Promise<void>((resolve, reject) => {
      const socket = openSocket(Number(port), hostname, () => {
        socket.write(`POST /mcp HTTP/1.1\r\nHost: ${hostname}:${port}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: 1000\r\n\r\n{"jsonrpc":`);
        setTimeout(() => socket.destroy(), 50);
      });
      socket.on("close", () => resolve());
      socket.on("error", reject);
    });
    assert.deepEqual((await sent(running, ping())).answer, { result: {}, jsonrpc: "2.0", id: 1 });
    assert.equal(running.warnings.length, warned, "a caller that leaves is nobody's trouble");
  });
});

describe("an MCP request the service cannot answer", () => {
  const post = async (to: Running, body: unknown) => {
    const response = await fetch(to.service.urls.mcp, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
    return { status: response.status, answer: JSON.parse((await response.text()) || "null") };
  };

  it("is ended when the answer does not come in time, with an error that names the request, and the log says so", async () => {
    const running = await start({}, undefined, { answerMs: 200 });
    try {
      const real = running.service.engine.execute;
      running.service.engine.execute = () => new Promise(() => {});
      const began = Date.now();
      const late = await post(running, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_projects", arguments: {} } });
      running.service.engine.execute = real;
      assert.equal(late.status, 503);
      assert.equal(late.answer.id, 7);
      assert.match(late.answer.error.message, /^The service did not answer in time\. The request may still be carried out: read the item/);
      assert.ok(Date.now() - began < 3000, `ended after ${Date.now() - began} ms`);
      assert.equal(running.warnings.length, 1);
      assert.match(running.warnings[0]!, /^A request to \/mcp failed unexpectedly: Error: A request to \/mcp was not answered within 200 ms\./);
      assert.doesNotMatch(late.answer.error.message, /key/);
      // The next request is answered, and one that is answered in time says nothing to the log.
      assert.equal((await post(running, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "list_projects", arguments: {} } })).answer.id, 8);
      assert.equal(running.warnings.length, 1);
      // A key is said once, in the answer: a caller whose answer did not come is told how to get another.
      for (const [name, input] of [
        ["create_user", { username: "late", type: "agent" }],
        ["reset_user_key", { username: "agent1" }],
      ] as const) {
        running.service.engine.execute = () => new Promise(() => {});
        const lost = await post(running, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: input } });
        running.service.engine.execute = real;
        assert.deepEqual([lost.status, lost.answer.id], [503, 9], name);
        assert.match(lost.answer.error.message, /^The service did not answer in time\. .* A key that the request made was in its answer and is not sent again: once the request has been carried out, have an admin reset the key of that user, or, for the admin's own key, run "vigile user reset-key admin" on the service's machine\.$/, name);
      }
    } finally {
      await running.stop();
    }
  });

  it("carries out once what was begun before the deadline and ends after it, and nothing is left unhandled when it ends", async () => {
    const running = await start({}, undefined, { answerMs: 200 });
    const unhandled: unknown[] = [];
    const seen = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", seen);
    try {
      const { engine } = running.service;
      const real = engine.execute;
      // A write and a refusal that both wait until their callers have been told that the answer did not come.
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      engine.execute = async (...call: Parameters<typeof real>) => {
        await gate;
        return real.apply(engine, call);
      };
      const [stored, refused] = await Promise.all([
        post(running, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_task", arguments: { title: "Stored after its answer", description: "d" } } }),
        post(running, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get", arguments: { id: "NOPE-1" } } }),
      ]);
      engine.execute = real;
      assert.deepEqual([stored.status, stored.answer.id, refused.status, refused.answer.id], [503, 1, 503, 2]);
      assert.deepEqual((await running.call("/api/list-tasks", {})).body.tasks, [], "nothing is stored while the write waits");
      release();
      const titles = async () => ((await running.call("/api/list-tasks", {})).body.tasks as Array<{ title: string }>).map((task) => task.title);
      for (const began = Date.now(); (await titles()).length === 0 && Date.now() - began < 2000; ) await new Promise((resolve) => setTimeout(resolve, 20));
      // Both have ended by now, the write and the refusal: neither has anybody left to tell, and neither is
      // anybody's trouble.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(await titles(), ["Stored after its answer"], "stored once");
      assert.deepEqual(unhandled, []);
      assert.equal(running.warnings.length, 2, "one line in the log for each answer that did not come, and none for how the work ended");
      assert.ok(running.logged.some((line) => /op=create_task .*result=ok/.test(line)) && running.logged.some((line) => /op=get .*result=not_found/.test(line)), "both have their line in the log of operations");
    } finally {
      process.off("unhandledRejection", seen);
      await running.stop();
    }
  });

  it("lets go of a caller that does not read its answer, as the service lets go of any connection on which nothing moves", async () => {
    const running = await start({}, { idleMs: 500 });
    const { port, hostname } = new URL(running.service.urls.base);
    const connections = () => new Promise<number>((resolve, reject) => running.service.server.getConnections((error, count) => (error ? reject(error) : resolve(count))));
    // Answers of nearly a megabyte each, more of them than a connection takes in while nobody reads: the
    // answer to a request that is carried out, and a refusal, which names the request by an ID of any length.
    const unread = async (what: string, body: string) => {
      const request = `POST /mcp HTTP/1.1\r\nHost: ${hostname}:${port}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
      const socket = openSocket(Number(port), hostname);
      socket.on("error", () => {});
      try {
        await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
        socket.pause();
        for (let i = 0; i < 6; i++) socket.write(request);
        const began = Date.now();
        while ((await connections()) > 0 && Date.now() - began < 4000) await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(await connections(), 0, `${what}: the connection was closed`);
        assert.equal(socket.destroyed, false, `${what}: the caller did not let go itself`);
      } finally {
        socket.destroy();
      }
    };
    try {
      await unread("an answer", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name: "plan_work", arguments: { goal: "g".repeat(900_000) } } }));
      await unread("a refusal", JSON.stringify({ jsonrpc: "2.0", id: "i".repeat(900_000), method: "ping", params: { _meta: Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [`k${i}`, 0])) } }));
      assert.deepEqual(running.warnings, [], "a caller that does not read is nobody's trouble");
    } finally {
      await running.stop();
    }
  });

  it("does not send an answer that is larger than an answer may be, and says so in its place", async () => {
    const running = await start({}, undefined, { answerBytes: 400 });
    try {
      const refusal = /^The answer is larger than \S+ MB and was not sent\. A change that the request made is stored: read the item before sending the request again\.$/;
      const large = await post(running, { jsonrpc: "2.0", id: 3, method: "tools/list" });
      assert.equal(large.status, 200);
      assert.equal(large.answer.id, 3);
      assert.equal(large.answer.error.code, -32603);
      assert.match(large.answer.error.message, refusal);
      // The result of a call is measured as soon as there is one. A call that changed something has changed it.
      const made = await post(running, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "create_task", arguments: { title: `Stored, and too large to say${" again".repeat(70)}`, description: "d" } } });
      assert.deepEqual([made.status, made.answer.id, made.answer.error.code], [200, 5, -32603]);
      assert.match(made.answer.error.message, refusal);
      const { tasks } = (await running.call("/api/list-tasks", {})).body;
      assert.equal(tasks.length, 1);
      assert.match(tasks[0].title, /^Stored, and too large to say/);
      assert.deepEqual((await post(running, { jsonrpc: "2.0", id: 4, method: "ping" })).answer, { result: {}, jsonrpc: "2.0", id: 4 });
      assert.deepEqual(running.warnings, []);
    } finally {
      await running.stop();
    }
  });
});

describe("lists longer than a page, over HTTP and MCP on the store the service runs on", () => {
  let running: Running;
  let group: string;
  let busy: string;
  before(async () => {
    running = await start();
    const run = (operation: string, input: Record<string, unknown>) => running.service.engine.execute(operation, "agent1", input) as Promise<any>;
    group = (await run("create_task", { title: "A group of many", description: "d" })).id;
    for (let n = 1; n <= 105; n++) await run("create_task", { title: `Step ${n}`, description: "d", parent: group });
    busy = (await run("create_task", { title: "Back and forth", description: "d" })).id;
    for (let n = 1; n <= 150; n++) await run("set_task_status", { id: busy, version: n, status: n % 2 ? "draft" : "open" });
  });
  after(() => running.stop());

  it("returns the latest 100 changes of an item's history from the data file, counts them all, and reads back to the first", async () => {
    const first = (await running.call("/api/get", { id: busy, history: true })).body;
    assert.deepEqual([first.history.length, first.more.history.total, first.timeline.length, first.more.timeline.total], [100, 151, 100, 151]);
    assert.deepEqual(first.history.at(-1).data, { from: "draft", to: "open" });
    const before = await running.call("/api/get", { id: busy, continuation: first.more.history.continuation });
    assert.equal(before.status, 200);
    assert.deepEqual([before.body.history.length, before.body.history[0].action, before.body.history[1].data, "more" in before.body], [51, "created", { from: "open", to: "draft" }, false]);
    const changes = [...before.body.history, ...first.history];
    assert.deepEqual(changes.map((entry: any) => entry.data.to ?? "created"), ["created", ...Array.from({ length: 150 }, (_, n) => (n % 2 ? "open" : "draft"))], "every change once, in the order it was made");
    // The group's own history is as long as what was put into it, and is read the same way.
    const filled = (await running.call("/api/get", { id: group, history: true })).body;
    assert.deepEqual([filled.history.length, filled.more.history.total, filled.links.contains.length, filled.more.links.contains.total], [100, 106, 100, 105]);
    // A token that is refused is refused as a mistake of the caller's, with what to do.
    const wrong = await running.call("/api/get", { id: group, continuation: first.more.history.continuation });
    assert.deepEqual([wrong.status, wrong.body.error.code], [400, "invalid_input"]);
    assert.match(wrong.body.error.message, /belongs to another list/);
  });

  it("returns and counts a project's history from its own creation on, where the data file holds a longer one of an earlier project of its name", async () => {
    const { engine, storage } = running.service;
    const run = (operation: string, input: Record<string, unknown>) => engine.execute(operation, "agent1", input) as Promise<any>;
    // Data from before a prefix was given only once: 149 entries of a project that was deleted for good stand
    // in the file in front of the creation of the project that has its prefix now.
    await run("create_project", { title: "Second of the name", prefix: "LEG" });
    const second = (await run("get", { id: "LEG" })).created_at as string;
    const entry = (action: string, data = {}, at = "2025-06-01T00:00:00.000Z") => ({ op: "add_history" as const, record: { kind: "project", id: "LEG", at, actor: "3", action, data } });
    const earlier = (entries: number) => Array.from({ length: entries }, () => entry("status_changed", { from: "open", to: "broken" }));
    const { head, objects } = (await storage.load("default"))!;
    const first = await storage.commit("default", { expectedRevision: head.revision, counters: head.counters, changes: [{ op: "delete_object", kind: "project", id: "LEG" }, entry("created", { status: "open" }), ...earlier(97)] });
    await storage.commit("default", {
      expectedRevision: first.revision,
      counters: first.counters,
      changes: [...earlier(50), entry("deleted_permanently"), { op: "put_object", record: objects.find((record) => record.kind === "project" && record.id === "LEG")!, text: "" }, entry("created", { status: "open" }, second)],
    });
    await engine.reload();

    const young = (await running.call("/api/get", { id: "LEG", history: true })).body;
    assert.deepEqual([young.history.map((h: any) => [h.action, h.at]), "more" in young], [[["created", second]], false]);
    let version = 1;
    for (let n = 0; n < 120; n++) version = (await run("set_project_status", { id: "LEG", version, status: n % 2 ? "open" : "in_preview" })).version;
    const latest = (await running.call("/api/get", { id: "LEG", history: true })).body;
    assert.deepEqual([latest.history.length, latest.more.history.total], [100, 121]);
    const before = (await running.call("/api/get", { id: "LEG", continuation: latest.more.history.continuation })).body;
    assert.deepEqual([before.history.length, [before.history[0].action, before.history[0].at], "more" in before], [21, ["created", second], false]);
    assert.equal([...before.history, ...latest.history].some((h: any) => h.data.to === "broken" || h.action === "deleted_permanently"), false);
    // A place before its creation, in a token nobody was given, leads to nothing of the earlier project.
    const { q } = JSON.parse(Buffer.from(latest.more.history.continuation, "base64url").toString("utf8")) as { q: string };
    const made = Buffer.from(JSON.stringify({ q, k: [first.revision, 50] }), "utf8").toString("base64url");
    assert.deepEqual((await running.call("/api/get", { id: "LEG", continuation: made })).body.history, []);
    // Deleted for good, the project takes all of it along: what was its own and what stood before it.
    await engine.execute("delete", "admin", { id: "LEG", version, permanent: true });
    assert.deepEqual(await storage.readHistoryPage("default", "project", "LEG", { limit: 5, sinceLast: "created" }), { records: [], total: 0 });
    assert.equal((await running.call("/api/create-project", { title: "Third", prefix: "LEG" })).body.error.rule, "prefix_taken");
  });

  it("answers every read of an item alike while the plan is read anew again and again, and while the item is changed between the reads", async () => {
    const { engine } = running.service;
    const whole = async () => (await running.call("/api/get", { id: busy, history: true })).body;
    const quiet = await whole();
    // Thirty reads over HTTP, with the plan read anew under them as fast as it can be: each is the item as it
    // is, with nothing left from the plan as it was in memory before, and none fails or waits for ever.
    // Each round lets the service get to its requests: reading the plan from this store takes no waiting, and a
    // loop that never waits would keep every request out.
    const breath = () => new Promise((resolve) => setImmediate(resolve));
    let reading = true;
    const anew = (async () => {
      while (reading) await engine.reload().then(breath);
    })();
    const answers = await Promise.all(Array.from({ length: 30 }, whole));
    reading = false;
    await anew;
    for (const answer of answers) assert.deepEqual({ ...answer, unchanged_since: 0 }, { ...quiet, unchanged_since: 0 });
    // The item is changed again and again while it is read and its history paged: every answer is of one state.
    // Its version, the last entry of its history and of its timeline, and how many of each there are, fit.
    let now = { version: quiet.version as number, status: quiet.status as string };
    let changing = true;
    const changes = (async () => {
      while (changing) now = (await engine.execute("set_task_status", "agent1", { id: busy, version: now.version, status: now.status === "open" ? "draft" : "open" }).finally(breath)) as typeof now;
    })();
    const read = await Promise.all(Array.from({ length: 40 }, whole));
    changing = false;
    await changes;
    for (const answer of read) {
      const changed = (answer.version as number) - (quiet.version as number);
      assert.deepEqual(
        [answer.more.history.total, answer.more.timeline.total, answer.history.at(-1).data.to, answer.timeline.at(-1).status],
        [quiet.more.history.total + changed, quiet.more.timeline.total + changed, answer.status, answer.status],
        `version ${answer.version}`,
      );
    }
    // Two answers that say the same revision are the same answer.
    const bySince = new Map<number, string>();
    for (const answer of read) {
      const said = JSON.stringify(answer);
      assert.equal(bySince.get(answer.unchanged_since) ?? said, said);
      bySince.set(answer.unchanged_since, said);
    }
  });

  it("offers the same over MCP: the tool says what is returned, takes the token, and returns the next page", async () => {
    const agent = await connect(running);
    const tools = (await agent.listTools()).tools;
    const get = tools.find((tool) => tool.name === "get")!;
    assert.match(get.description ?? "", /at most 100 entries[\s\S]*"more"[\s\S]*continuation token/);
    assert.ok("continuation" in (get.inputSchema.properties as object));
    const users = tools.find((tool) => tool.name === "list_users")!;
    assert.match(users.description ?? "", /at most 100 per call/);
    assert.ok("continuation" in (users.inputSchema.properties as object));

    const first = payload(await agent.callTool({ name: "get", arguments: { id: group } }));
    assert.deepEqual([first.links.contains.length, first.more.links.contains.total], [100, 105]);
    const next = payload(await agent.callTool({ name: "get", arguments: { id: group, continuation: first.more.links.contains.continuation } }));
    assert.deepEqual([next.kind, next.id, next.links.contains.map((item: any) => item.title), "more" in next], ["task", group, ["Step 101", "Step 102", "Step 103", "Step 104", "Step 105"], false]);
    // Both answers say since when the group and its lists are unchanged, and say the same: they belong together.
    // The description tells an agent what the field is for.
    assert.match(get.description ?? "", /"unchanged_since"[\s\S]*Pages belong together when they say the same/);
    assert.deepEqual([typeof first.unchanged_since, next.unchanged_since], ["number", first.unchanged_since]);
    const overHttp = (await running.call("/api/get", { id: group, continuation: first.more.links.contains.continuation })).body;
    assert.deepEqual([overHttp.unchanged_since, overHttp.version], [first.unchanged_since, first.version]);
    const refused = await agent.callTool({ name: "set_task_status", arguments: { id: group, version: 1, status: "done" } });
    assert.deepEqual([refused.isError, payload(refused).error.blocking.length, payload(refused).error.blocking_total], [true, 20, 105]);
    // A token is taken or refused as over the API, and a page of users is asked for the same way.
    const wrong = await agent.callTool({ name: "get", arguments: { id: busy, continuation: first.more.links.contains.continuation } });
    assert.deepEqual([wrong.isError, payload(wrong).error.code], [true, "invalid_input"]);
    assert.match(payload(wrong).error.message, /belongs to another list/);
    assert.match(payload(await agent.callTool({ name: "list_users", arguments: { continuation: "bm90IGEgdG9rZW4" } })).error.message, /continuation token is not valid/);

    // A call goes to the engine as it came, whatever it sends: what the engine answers repeats as little of it
    // as it does over the API, in the answer and in the log.
    const long = "x".repeat(200_000);
    const from = running.logged.length;
    for (const [name, input, message] of [
      [long, {}, /^There is no operation called "x{80}… \(200000 characters\)"\.$/],
      ["get", { id: long }, /^No project, task or user matches "x{80}… \(200000 characters\)"\.$/],
      ["get", { id: group, [long]: 1 }, /^The input for get is not valid\. input: Unrecognized key: "x+… \(\d+ characters\)\.$/],
      ["add_link", { from: group, type: long, to: busy }, /^"x{80}… \(200000 characters\)" is not a link type\.$/],
    ] as const) {
      const answer = await agent.callTool({ name, arguments: input });
      const said = (answer.content as Array<{ text: string }>)[0]!.text;
      assert.equal(answer.isError, true);
      assert.match(payload(answer).error.message, message);
      assert.ok(said.length < 800, `an answer of ${said.length} characters`);
    }
    const lines = running.logged.slice(from);
    assert.equal(lines.length, 4);
    assert.match(lines[0]!, new RegExp(` op=x{64} caller=agent1 kind=read ms=\\S+ result=not_found$`));
    assert.ok(lines.every((line) => line.length < 200), "no line of the log is longer for it");
    await agent.close();
  });

  it("repeats an address that leads nowhere only in part", async () => {
    const long = "x".repeat(8000);
    for (const [path, body] of [[`/api/${long}`, {}], [`/api/${long}`, undefined], [`/${long}`, undefined]] as const) {
      const answer = await running.call(path, body);
      assert.equal(answer.status, 404);
      assert.ok(JSON.stringify(answer.body).length < 400, JSON.stringify(answer.body).slice(0, 200));
      assert.match(answer.body.error.message, /x{60,80}… \(80\d\d characters\)/);
    }
  });
});

describe("two engines on one data file", () => {
  it("answers get with the data file and the plan in memory at one revision, whenever the other engine stores a change during the read, and refuses a read that is overtaken every time", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-two-engines-"));
    const file = new SqliteStorage({ directory });
    // What happens while this engine reads: during the next reading of a description, during the next readings
    // of a history, and just before the file is next asked which revision it is at.
    const during = { text: null as (() => unknown) | null, history: [] as Array<() => unknown>, revision: null as (() => unknown) | null, histories: 0 };
    const once = async (what: "text" | "revision") => {
      const now = during[what];
      during[what] = null;
      await now?.();
    };
    const watched: StorageAdapter = {
      load: (tenant) => file.load(tenant),
      commit: (tenant, request) => file.commit(tenant, request),
      readRevision: async (tenant) => (await once("revision"), file.readRevision(tenant)),
      readText: async (tenant, kind, id) => (await once("text"), file.readText(tenant, kind, id)),
      readHistory: (tenant, kind, id) => file.readHistory(tenant, kind, id),
      readHistoryPage: async (tenant, kind, id, page) => (during.histories++, await during.history.shift()?.(), file.readHistoryPage(tenant, kind, id, page)),
      readHistoryFeedPage: (tenant, page) => file.readHistoryFeedPage(tenant, page),
      readTimeline: (tenant, kind, id, page) => file.readTimeline(tenant, kind, id, page),
      close: async () => {},
    };
    try {
      const mine = await Engine.open({ storage: watched });
      const other = await Engine.open({ storage: file });
      const group = ((await mine.execute("create_task", "agent1", { title: "Group", description: "As it was" })) as { id: string }).id;
      await other.reload();
      let version = 1;
      let texts = 0;
      let members = 0;
      /** The other engine rewrites the group's description and puts a task into it. */
      const elsewhere = async () => {
        version = ((await other.execute("update_task", "user", { id: group, version, description: `Rewritten ${++texts} times` })) as { version: number }).version;
        await other.execute("create_task", "user", { title: `Put in by the other engine, ${++members}`, description: "d", parent: group });
      };
      const read = () => mine.execute("get", "agent1", { id: group, history: true }) as Promise<any>;
      const whole = async (what: string) => {
        const answer = await read();
        assert.deepEqual(
          [answer.description, answer.version, answer.links.contains.length, answer.history.filter((h: any) => h.action === "updated").length, answer.history.filter((h: any) => h.action === "link_added").length, answer.unchanged_since],
          [`Rewritten ${texts} times`, version, members, texts, members, other.currentRevision],
          what,
        );
        return answer;
      };
      const quiet = await read();
      assert.deepEqual([quiet.description, quiet.version], ["As it was", 1]);
      await elsewhere();
      const first = await whole("a change stored before the read");
      assert.ok(first.unchanged_since > quiet.unchanged_since);
      during.text = elsewhere;
      await whole("a change stored while the description is read");
      during.history.push(elsewhere);
      await whole("a change stored between the description and the history");
      during.revision = elsewhere;
      await whole("a change stored after the last of the reads");
      during.history.push(elsewhere, elsewhere);
      await whole("a change stored during the read, and another during the read that had its turn");

      // Overtaken by the other engine every time: four readings, and then a refusal to ask again.
      during.histories = 0;
      during.history.push(elsewhere, elsewhere, elsewhere, elsewhere);
      const refused = await read().then(
        () => assert.fail("a read that was overtaken every time gave an answer"),
        (error: unknown) => error as VigileError,
      );
      assert.ok(refused instanceof VigileError);
      assert.deepEqual([refused.code, during.histories], ["too_many_requests", 4]);
      assert.match(refused.message, /changed faster than it can be read/);
      await whole("the item as it is, once it is left alone");
      await other.close();
    } finally {
      await file.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("links across an SQLite reload", () => {
  it("keeps summary arrays and link pages ordered after restart and after an uncertain commit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-link-order-"));
    let file: SqliteStorage | undefined;
    let engine: Engine | undefined;
    let failAfterCommit = false;
    const open = async () => {
      const backing = (file = new SqliteStorage({ directory }));
      const storage: StorageAdapter = {
        load: (tenant) => backing.load(tenant),
        commit: async (tenant, request) => {
          const head = await backing.commit(tenant, request);
          if (failAfterCommit) {
            failAfterCommit = false;
            throw new Error("the commit succeeded but its acknowledgement was lost");
          }
          return head;
        },
        readRevision: (tenant) => backing.readRevision(tenant),
        readText: (tenant, kind, id) => backing.readText(tenant, kind, id),
        readHistory: (tenant, kind, id) => backing.readHistory(tenant, kind, id),
        readHistoryPage: (tenant, kind, id, page) => backing.readHistoryPage(tenant, kind, id, page),
        readHistoryFeedPage: (tenant, page) => backing.readHistoryFeedPage(tenant, page),
        readTimeline: (tenant, kind, id, page) => backing.readTimeline(tenant, kind, id, page),
        close: () => backing.close(),
      };
      engine = await Engine.open({ storage });
    };
    const agent = (operation: string, input: Record<string, unknown> = {}) => engine!.execute(operation, "agent1", input) as Promise<any>;
    const orderedLists = (answer: any) => ({
      contained_in: answer.contained_in,
      live_containers: answer.live_containers,
      depends_on: answer.depends_on,
      assigned_to: answer.assigned_to,
      waiting_for: answer.waiting_for,
      links: Object.fromEntries(Object.entries(answer.links).map(([name, items]: [string, any]) => [name, items.map((item: any) => item.id)])),
    });

    try {
      await open();
      await agent("create_project", { title: "Second by name", prefix: "ZZ" });
      await agent("create_project", { title: "First by name", prefix: "AB" });
      const group = await agent("create_task", { title: "Deleted group", description: "d", project: "AB" });
      const targets: string[] = [];
      for (const project of ["ZZ", "AB", "ZZ", "AB"]) {
        targets.push((await agent("create_task", { title: `Dependency ${targets.length}`, description: "d", project })).id);
      }
      const dependencyOrder = [...targets].reverse();
      const task = await agent("create_task", {
        title: "Shared task",
        description: "d",
        project: "ZZ",
        depends_on: dependencyOrder,
        assigned_to: ["agent1", "admin"],
      });
      await agent("add_link", { from: "AB", type: "contains", to: task.id });
      await agent("add_link", { from: group.id, type: "contains", to: task.id });
      await agent("delete", { id: group.id, version: group.version });

      const beforeRestart = await agent("get", { id: task.id });
      assert.deepEqual(beforeRestart.contained_in, ["AB", "ZZ", group.id]);
      assert.deepEqual(beforeRestart.live_containers, ["AB", "ZZ"]);
      assert.deepEqual(beforeRestart.depends_on, [...targets].sort(compareTaskIds));
      assert.deepEqual(beforeRestart.assigned_to, ["admin", "agent1"]);
      assert.notDeepEqual(beforeRestart.depends_on, dependencyOrder, "the answer is not the order links were inserted");
      assert.notDeepEqual(beforeRestart.assigned_to, ["agent1", "admin"], "the answer is not the order assignees were given");
      const expected = orderedLists(beforeRestart);

      await engine!.close();
      engine = undefined;
      file = undefined;
      await open();
      const afterRestart = await agent("get", { id: task.id });
      assert.deepEqual(orderedLists(afterRestart), expected, "SQLite key order does not change any answer list");

      failAfterCommit = true;
      await assert.rejects(
        agent("update_task", { id: task.id, version: afterRestart.version, title: "Committed despite lost acknowledgement" }),
        (error: unknown) => error instanceof VigileError && /change was not confirmed/.test(error.message),
      );
      const afterFailedCommitReload = await agent("get", { id: task.id });
      assert.equal(afterFailedCommitReload.title, "Committed despite lost acknowledgement");
      assert.deepEqual(orderedLists(afterFailedCommitReload), expected, "recovery after an uncertain commit keeps every list ordered");
    } finally {
      if (engine) await engine.close();
      else await file?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("several agents at once", () => {
  let running: Running;
  let agent2: string;
  before(async () => {
    running = await start();
    agent2 = (await running.call("/api/create-user", { username: "agent2", type: "agent" }, running.adminKey)).body.api_key;
  });
  after(() => running.stop());

  it("runs a request as the user it was let in as, or not at all: not as someone else who has the name by its end", async () => {
    const { port, hostname } = new URL(running.service.urls.base);
    // A request that is let in when it arrives, and sends the rest of what it has to say after `meanwhile`.
    const slow = (path: string, key: string, body: string, meanwhile: () => Promise<void>) =>
      new Promise<string>((resolve, reject) => {
        const half = Math.floor(body.length / 2);
        const socket = openSocket(Number(port), hostname, () => {
          socket.write(`POST ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: close\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nAuthorization: Bearer ${key}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, half)}`);
          // The service has let the request in by now, and waits for the rest.
          setTimeout(() => meanwhile().then(() => socket.write(body.slice(half)), reject), 150);
        });
        let answer = "";
        socket.on("data", (chunk) => (answer += chunk));
        socket.on("end", () => resolve(answer));
        socket.on("error", reject);
      });
    const titles = async () => ((await running.call("/api/list-tasks", {}, running.adminKey)).body.tasks as Array<{ title: string }>).map((task) => task.title);
    // Meanwhile the user is deleted for good and the name is given to someone else, with a key of their own.
    const replaced = async (username: string) => {
      const user = (await running.call("/api/get", { id: username }, running.adminKey)).body;
      assert.equal((await running.call("/api/delete", { id: username, version: user.version, permanent: true }, running.adminKey)).status, 200);
      assert.equal((await running.call("/api/create-user", { username, type: "person" }, running.adminKey)).status, 200);
    };

    for (const [username, path, body, refusal] of [
      ["walt", "/api/create-task", JSON.stringify({ title: "As the walt that was", description: "d" }), /^HTTP\/1\.1 401 /],
      ["wendy", "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_task", arguments: { title: "As the wendy that was", description: "d" } } }), /unauthorized/],
    ] as const) {
      const key = (await running.call("/api/create-user", { username, type: "agent" }, running.adminKey)).body.api_key as string;
      // Left alone, such a request goes through as the user it was let in as.
      const alone = await slow(path, key, body.replace("that was", "that is"), async () => {});
      assert.match(alone, /^HTTP\/1\.1 200 /, username);
      assert.doesNotMatch(alone, /unauthorized/, username);
      // With the name passed on before its end, it is refused: what it asks for is not done as the new user.
      const answer = await slow(path, key, body, () => replaced(username));
      assert.match(answer, refusal, username);
      assert.match(answer, /has been deleted since, and the name belongs to someone else now/, username);
      const now = await titles();
      assert.ok(now.includes(`As the ${username} that is`), username);
      assert.equal(now.includes(`As the ${username} that was`), false, `${username}: nothing was created in the new user's name`);
      // And the key that was let in is refused from then on, as before.
      assert.equal((await running.call("/api/list-tasks", {}, key)).status, 401, username);
    }
    // With the user gone and the name given to nobody, a call over MCP is still a call: the engine refuses it
    // as it refuses anyone it does not know, and the log has its line.
    const key = (await running.call("/api/create-user", { username: "wilma", type: "agent" }, running.adminKey)).body.api_key as string;
    const from = running.logged.length;
    const gone = await slow("/mcp", key, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_task", arguments: { title: "As the wilma that was", description: "d" } } }), async () => {
      const user = (await running.call("/api/get", { id: "wilma" }, running.adminKey)).body;
      assert.equal((await running.call("/api/delete", { id: "wilma", version: user.version, permanent: true }, running.adminKey)).status, 200);
    });
    assert.match(gone, /^HTTP\/1\.1 200 /);
    assert.match(gone, /unauthorized/);
    assert.match(gone, /There is no user called \\+"wilma\\+"/);
    assert.doesNotMatch(gone, /Method not found/);
    assert.ok(running.logged.slice(from).some((line) => /op=create_task caller=wilma kind=write .*result=unauthorized/.test(line)), running.logged.slice(from).join("\n"));
    assert.equal((await titles()).includes("As the wilma that was"), false);
    // Nor is such a request shown the tools of whoever has the name now.
    const list = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { pad: "p".repeat(200) } } });
    const wanda = (await running.call("/api/create-user", { username: "wanda", type: "agent" }, running.adminKey)).body.api_key as string;
    const own = await slow("/mcp", wanda, list, async () => {});
    assert.match(own, /"name":"create_task"/);
    const others = await slow("/mcp", wanda, list, async () => {
      const user = (await running.call("/api/get", { id: "wanda" }, running.adminKey)).body;
      assert.equal((await running.call("/api/delete", { id: "wanda", version: user.version, permanent: true }, running.adminKey)).status, 200);
      assert.equal((await running.call("/api/create-user", { username: "wanda", type: "person" }, running.adminKey)).status, 200);
    });
    assert.match(others, /^HTTP\/1\.1 200 /);
    assert.match(others, /\{"result":\{"tools":\[\]\},"jsonrpc":"2\.0","id":1\}$/);
  });

  it("lets exactly one of two agents start a task, and tells the other who has it", async () => {
    for (let round = 0; round < 10; round++) {
      const created = (await running.call("/api/create-task", { title: `Contested ${round}`, description: "d" })).body;
      const attempt = { id: created.id, version: 1, status: "in_progress" };
      const results = await Promise.all([running.call("/api/set-task-status", attempt), running.call("/api/set-task-status", attempt, agent2)]);
      const won = results.filter((r) => r.status === 200);
      const lost = results.filter((r) => r.status !== 200);
      assert.equal(won.length, 1, "exactly one start wins");
      assert.equal(lost.length, 1);
      assert.equal(lost[0]!.status, 409);
      assert.equal(lost[0]!.body.error.code, "version_conflict");
      assert.equal(lost[0]!.body.error.current.status, "in_progress");
      assert.deepEqual(lost[0]!.body.error.current.assigned_to, won[0]!.body.assigned_to, "the refusal shows who took it");
      assert.equal(won[0]!.body.assigned_to.length, 1);
    }
  });

  it("gives every one of many simultaneous creates its own ID", async () => {
    const before = (await running.call("/api/admin/status", undefined, running.adminKey)).body.engine.counters.task;
    const keys = [undefined, agent2, running.adminKey];
    const created = await Promise.all(
      Array.from({ length: 60 }, (_, i) => running.call("/api/create-task", { title: `Burst ${i}`, description: "d" }, keys[i % 3])),
    );
    assert.ok(created.every((r) => r.status === 200));
    assert.equal(new Set(created.map((r) => r.body.id)).size, 60);
    const status = (await running.call("/api/admin/status", undefined, running.adminKey)).body;
    assert.equal(status.engine.counters.task, before + 60, "no number was skipped or used twice");
    assert.deepEqual(status.inconsistencies, []);
  });

  it("records each change under the agent that made it", async () => {
    const created = (await running.call("/api/create-task", { title: "Attributed", description: "d" }, agent2)).body;
    await running.call("/api/set-task-status", { id: created.id, version: 1, status: "in_progress" });
    const read = (await running.call("/api/get", { id: created.id, history: true })).body;
    assert.equal(read.created_by, "agent2");
    assert.deepEqual(read.history.map((h: any) => [h.action, h.by]), [
      ["created", "agent2"],
      ["status_changed", "agent1"],
    ]);
  });
});

describe("stopping the service", () => {
  it("stops within seconds while a connection that has sent nothing is still open", async () => {
    const running = await start();
    const { connect } = await import("node:net");
    const address = new URL(running.service.urls.base);
    // What a browser does when it opens a connection in advance: connects, and sends nothing.
    const socket = connect(Number(address.port), address.hostname);
    await new Promise<void>((resolve, reject) => socket.once("connect", () => resolve()).once("error", reject));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.on("error", () => {});
    const began = Date.now();
    await running.service.stop();
    const took = Date.now() - began;
    assert.ok(took < 3000, `the service stopped after ${took} ms`);
    await closed;
    rmSync(running.directory, { recursive: true, force: true });
  });
});

describe("a project that was deleted for good", () => {
  it("takes its history with it and leaves its prefix used up, also after the service is started again and in a backup", async () => {
    const running = await start();
    const data = join(running.directory, "data", "default.sqlite");
    let again: Service | undefined;
    try {
      const asAdmin = (path: string, body: unknown) => running.call(path, body, running.adminKey);
      await running.call("/api/create-project", { title: "First of the name", prefix: "old", description: "What it was for" });
      await running.call("/api/set-project-status", { id: "OLD", version: 1, status: "broken" });
      const task = (await running.call("/api/create-task", { title: "In it", description: "d", project: "OLD" })).body;
      await running.call("/api/delete", { id: task.id, version: 1 });

      // With a deleted task in it the project stays, and the answer says what to do.
      const held = await asAdmin("/api/delete", { id: "OLD", version: 2, permanent: true });
      assert.equal(held.status, 409);
      assert.equal(held.body.error.rule, "contains_deleted_tasks");
      assert.deepEqual(held.body.error.blocking.map((item: any) => item.id), [task.id]);
      assert.match(held.body.error.actions[0], /Delete those tasks permanently first, or call remove_link/);
      assert.equal((await asAdmin("/api/delete", { id: task.id, version: 2, permanent: true })).status, 200);
      assert.deepEqual((await asAdmin("/api/delete", { id: "OLD", version: 2, permanent: true })).body, { deleted: true, permanent: true, kind: "project", id: "OLD" });

      // The prefix is refused from then on, over the API and over MCP alike.
      const refused = await running.call("/api/create-project", { title: "Second of the name", prefix: "OLD" });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error.rule, "prefix_taken");
      assert.match(refused.body.error.message, /^The prefix OLD was used by a project that has been deleted for good\./);
      const agent = await connect(running);
      const overMcp = await agent.callTool({ name: "create_project", arguments: { title: "Second of the name", prefix: "old" } });
      assert.equal(overMcp.isError, true);
      assert.equal(payload(overMcp).error.rule, "prefix_taken");
      await agent.close();
      // A project that is there, for the backup below.
      assert.equal((await running.call("/api/create-project", { title: "Still here", prefix: "new" })).status, 200);

      await running.service.stop();
      // Nothing of the project or of its task is left in the data file: no record, no description, no history.
      assert.deepEqual(historyOwners(data).filter((owner) => owner.kind !== "user").map((owner) => owner.id), ["NEW"]);
      const file = new DatabaseSync(data, { readOnly: true });
      try {
        assert.deepEqual((file.prepare("SELECT kind, id FROM objects WHERE kind <> 'user'").all() as any[]).map((row) => row.id), ["NEW"]);
        assert.equal((file.prepare("SELECT count(*) AS links FROM links").get() as any).links, 0);
        assert.deepEqual(JSON.parse((file.prepare("SELECT counters FROM head").get() as any).counters), { identity: 3, task: 1, "prefix:OLD": 1 });
      } finally {
        file.close();
      }

      // A backup of that data is one that can be restored: so says what restore-backup asks of it. Also one in
      // which a project that is there has its own prefix beside the counters.
      const backup = join(running.directory, "default-backup.sqlite");
      backupTenantFile(data, backup);
      for (const marked of [false, true]) {
        if (marked) {
          const copy = new DatabaseSync(backup);
          copy.exec(`UPDATE head SET counters = json_set(counters, '$."prefix:NEW"', 1)`);
          copy.close();
        }
        assert.deepEqual(inspectTenantFile("default", backup).messages, ["ok"], String(marked));
        assert.deepEqual(await openAsPlan("default", backup), { users: ["admin", "user", "agent1"] }, String(marked));
      }

      again = await startService({ loaded: loadConfig(running.config, {}), log: () => {}, warn: () => {} });
      // The service was stopped and started on the same port: a connection kept from before the stop is a dead
      // one, and the first call after it finds that out. It is made again.
      const call = async (path: string, body?: unknown, key?: string) => {
        const once = () => fetch(`${again!.urls.base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
        const response = await once().catch(once);
        return { status: response.status, body: (await response.json()) as any };
      };
      const restarted = await call("/api/create-project", { title: "Second of the name", prefix: "old" });
      assert.equal(restarted.status, 409);
      assert.equal(restarted.body.error.rule, "prefix_taken");
      assert.match(restarted.body.error.message, /^The prefix OLD was used by a project that has been deleted for good\./);
      assert.deepEqual(restarted.body.error.actions, ["Choose a different prefix."]);
      for (const id of ["OLD", task.id]) assert.equal((await call("/api/get", { id, history: true })).status, 404, id);
      const status = (await call("/api/admin/status", undefined, running.adminKey)).body;
      assert.deepEqual([status.inconsistencies, status.engine.retired_prefixes, status.engine.counters], [[], 1, { identity: 3, task: 1 }]);
      // The task number is not given again either, and another prefix is free.
      assert.equal((await call("/api/create-project", { title: "Another", prefix: "oldd" })).status, 200);
      assert.equal((await call("/api/create-task", { title: "Next", description: "d", project: "OLDD" })).body.id, "OLDD-002");
    } finally {
      await again?.stop();
      await running.stop();
    }
  });
});

describe("starting the service", () => {
  it("refuses a config whose keyless user does not exist, and says which", async () => {
    const running = await start();
    await running.service.stop();
    setValue(running.config, "auth.keyless_user", "ghost");
    await assert.rejects(
      startService({ loaded: loadConfig(running.config, {}), log: () => {}, warn: () => {} }),
      (error: unknown) => error instanceof StartupError && error.hints.join(" ").includes("auth.keyless_user: there is no user called ghost"),
    );
    // A refused start must release the data folder, so a corrected config can start.
    setValue(running.config, "auth.keyless_user", "agent1");
    const again = await startService({ loaded: loadConfig(running.config, {}), log: () => {}, warn: () => {} });
    await again.stop();
    rmSync(running.directory, { recursive: true, force: true });
  });

  it("does not take a data folder that a service from before this version may still be using", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-earlier-"));
    const config = join(directory, "config.toml");
    initConfig(config, { name: "earlier", port: await freePort() });
    const data = join(directory, "data");
    mkdirSync(data);
    const begin = () => startService({ loaded: loadConfig(config, {}), log: () => {}, warn: () => {} });
    try {
      // What such a service leaves while it runs: its process number in vigile.lock, and no lock of the system.
      // The number here is of a process that is alive and is not this one.
      writeFileSync(join(data, "vigile.lock"), `${process.ppid}\n`);
      await assert.rejects(begin(), (error: unknown) => error instanceof StartupError && new RegExp(`from before this version may be using .* \\(process ${process.ppid}\\)`).test(error.message));
      assert.deepEqual(readdirSync(data), ["vigile.lock"], "nothing was taken and nothing was opened");
      // A number that belongs to no process is a file left behind by a service that was killed: it keeps nobody out.
      writeFileSync(join(data, "vigile.lock"), "999999999\n");
      const service = await begin();
      await service.stop();
      // Once the folder has been held the new way, a number in that file means nothing, whoever has it.
      writeFileSync(join(data, "vigile.lock"), `${process.ppid}\n`);
      const again = await begin();
      await again.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps its data folder after an in-process diagnostic opens the lock file", async () => {
    const running = await start();
    const data = join(running.directory, "data");
    try {
      assert.equal(folderIsHeld(data), true, "the diagnostic sees the service's holder");
      readFileSync(join(data, "vigile.hold"));
      assert.equal(folderIsHeld(data), true, "closing both diagnostic descriptors leaves the holder in place");
      const loaded = loadConfig(running.config, { VIGILE_LISTEN_PORT: String(await freePort()) });
      await assert.rejects(
        startService({ loaded, log: () => {}, warn: () => {} }),
        (error: unknown) => error instanceof StartupError && /Another Vigile service/.test(error.message),
      );
    } finally {
      await running.stop();
    }
  });

  it("says which folder it cannot take when the data folder cannot be held", async () => {
    const running = await start();
    await running.service.stop();
    // Something that is not the lock stands where the lock belongs.
    const hold = join(running.directory, "data", "vigile.hold");
    rmSync(hold, { force: true });
    rmSync(`${hold}-journal`, { force: true });
    mkdirSync(hold);
    try {
      await assert.rejects(
        startService({ loaded: loadConfig(running.config, {}), log: () => {}, warn: () => {} }),
        (error: unknown) => error instanceof StartupError && error.message.includes(join(running.directory, "data")) && /cannot be taken for this service/.test(error.message),
      );
      assert.equal(existsSync(join(running.directory, "data", "vigile.lock")), false, "and it leaves no lock file behind");
    } finally {
      rmSync(running.directory, { recursive: true, force: true });
    }
  });

  it("starts with a key in the config that belongs to nobody, says so, and lets nobody in with it", async () => {
    const running = await start();
    await running.service.stop();
    // What a delete leaves behind when its last step fails, or a hand edit.
    setKey(running.config, "ghost", "vig_ghostghostghostghostghost");
    const warnings: string[] = [];
    const again = await startService({ loaded: loadConfig(running.config, {}), log: () => {}, warn: (line) => warnings.push(line) });
    try {
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /auth\.keys\.ghost: there is no user called ghost; the key lets nobody in/);
      const withOldKey = async () => (await fetch(`${again.urls.base}/api/list-projects`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer vig_ghostghostghostghostghost" }, body: "{}" })).status;
      assert.equal(await withOldKey(), 401);
      // A user is then created under that very name, and its key cannot be stored. The key that was in the file
      // before is not this user's: whoever holds it does not get in as them.
      if (process.getuid?.() !== 0) {
        const admin = loadConfig(running.config, {}).config.auth.keys.admin!;
        const create = async () => fetch(`${again.urls.base}/api/create-user`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${admin}` }, body: JSON.stringify({ username: "ghost", type: "agent" }) });
        chmodSync(running.directory, 0o500);
        try {
          const failed = await create();
          assert.equal(failed.status, 500);
          assert.match(((await failed.json()) as any).error.message, /User ghost was created, but its API key could not be stored/);
          assert.equal(await withOldKey(), 401, "the old key does not reach the new user");
        } finally {
          chmodSync(running.directory, 0o700);
        }
        assert.equal(await withOldKey(), 401, "nor once the file can be written again");
        // Nor after a restart, when the file is all the service has to go by and still holds the old key under
        // the name: the user carries the mark of the key that was made for it, and this is not that key.
        await again.stop();
        const said: string[] = [];
        const restarted = await startService({ loaded: loadConfig(running.config, {}), log: () => {}, warn: (line) => said.push(line) });
        try {
          // The start says that the key under the name is not the user's own, and what to do about it.
          assert.deepEqual(said, ["auth.keys.ghost: this key was not issued for the user ghost as the data has it, and lets nobody in. Issue a new one: vigile user reset-key ghost"]);
          // The service was stopped and started on the same port: a connection kept from before the stop is a
          // dead one, and the first call after it finds that out. It is made again.
          const call = async (path: string, key: string, body?: unknown) => {
            const once = () => fetch(`${restarted.urls.base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: body === undefined ? undefined : JSON.stringify(body) });
            return once().catch(once);
          };
          assert.equal((await call("/api/instance", "vig_ghostghostghostghostghost")).status, 401, "the old key does not reach the new user after a restart either");
          assert.deepEqual(((await (await call("/api/admin/status", admin)).json()) as any).auth.keys_of_someone_else, ["ghost"]);
          const fresh = ((await (await call("/api/reset-user-key", admin, { user: "ghost" })).json()) as any).api_key as string;
          assert.equal((await call("/api/instance", fresh)).status, 200, "a key issued for the new user works");
          assert.equal((await call("/api/instance", "vig_ghostghostghostghostghost")).status, 401);
          assert.deepEqual(((await (await call("/api/admin/status", admin)).json()) as any).auth.keys_of_someone_else, [], "once a key is issued for the user, nothing is amiss");

          // A key that is replaced, and the new one cannot be stored: the one the user has goes on working, as the
          // answer says, for a user and for admin, now and after a restart.
          chmodSync(running.directory, 0o500);
          try {
            for (const user of ["ghost", "admin"]) {
              const failed = await call("/api/reset-user-key", admin, { user });
              assert.equal(failed.status, 500, user);
              assert.match(((await failed.json()) as any).error.message, /The key it had, if any, still works/);
            }
          } finally {
            chmodSync(running.directory, 0o700);
          }
          assert.equal((await call("/api/instance", fresh)).status, 200, "the user's key still works");
          assert.equal((await call("/api/admin/status", admin)).status, 200, "and so does admin's");
        } finally {
          await restarted.stop();
        }
        const third = await startService({ loaded: loadConfig(running.config, {}), log: () => {}, warn: () => {} });
        try {
          const keys = loadConfig(running.config, {}).config.auth.keys;
          const once = () => fetch(`${third.urls.base}/api/instance`, { headers: { authorization: `Bearer ${keys.ghost}` } });
          assert.equal((await once().catch(once)).status, 200, "also after another restart");
        } finally {
          await third.stop();
        }
      }
    } finally {
      await again.stop();
      rmSync(running.directory, { recursive: true, force: true });
    }
  });
});

/** Makes the data file of format 1 that the version before this one left: see format-1-data.ts. */
function writeFormat1(file: string): void {
  const db = new DatabaseSync(file);
  for (const statement of FORMAT_1_SQL) db.exec(statement);
  db.close();
}

/**
 * An item in full with every list read to its end, as the version before returned it in one answer: the pages
 * of its timeline and of its history put one before the other, those of its links one after the other.
 */
async function whole(engine: Engine, input: Record<string, unknown>): Promise<any> {
  const get = (more: Record<string, unknown> = {}) => engine.execute("get", "agent1", { ...input, ...more }) as Promise<any>;
  const item = await get();
  for (const list of ["timeline", "history"] as const) {
    for (let more = item.more?.[list]; more; ) {
      const page = await get({ history: undefined, continuation: more.continuation });
      item[list].unshift(...page[list]);
      assert.equal(more.total, page.more?.[list]?.total ?? more.total);
      more = page.more?.[list];
      if (!more) assert.equal(item[list].length, item.more[list].total, `${list}: as many as the answer counted`);
    }
  }
  for (const [name, first] of Object.entries((item.more?.links ?? {}) as Record<string, { continuation: string }>)) {
    for (let more: { continuation: string } | undefined = first; more; ) {
      const page = await get({ history: undefined, continuation: more.continuation });
      item.links[name].push(...page.links[name]);
      more = page.more?.links?.[name];
    }
  }
  delete item.more;
  return item;
}

/**
 * An answer with the links of an item in the order of the IDs at their other end, which is the order `get`
 * returns them in now. The version before returned them in the order they were stored in.
 */
function linksInOrder<T>(answer: T): T {
  const detail = answer as {
    links?: Record<string, Array<{ kind: string; id: string }>>;
    timeline?: Array<Record<string, unknown>>;
    history?: Array<Record<string, unknown>>;
    problems?: unknown;
    unchanged_since?: number;
    progress?: unknown;
    has_problems?: boolean;
    is_assigned?: boolean;
    is_next?: boolean;
    is_waiting?: boolean;
    waiting_for?: unknown;
    live_containers?: unknown;
    tasks?: Array<Record<string, unknown>>;
    projects?: Array<Record<string, unknown>>;
    users?: Array<Record<string, unknown>>;
  } | undefined;
  if (!detail) return answer;
  const key = (item: { kind: string; id: string }) => `${item.kind} ${item.id}`;
  const withoutPlace = (items: Array<Record<string, unknown>>) => items.map(({ place: _place, ...item }) => item);
  const summaryOnly = (items: Array<Record<string, unknown>>) => items.map(({ is_assigned: _isAssigned, is_next: _isNext, is_waiting: _isWaiting, waiting_for: _waitingFor, live_containers: _liveContainers, has_problems: _hasProblems, problems: _problems, progress: _progress, ...item }) => item);
  const { unchanged_since: _unchangedSince, progress: _progress, has_problems: _hasProblems, is_assigned: _isAssigned, is_next: _isNext, is_waiting: _isWaiting, waiting_for: _waitingFor, live_containers: _liveContainers, problems: _problems, ...withoutDerived } = detail;
  return {
    ...withoutDerived,
    ...(detail.tasks ? { tasks: summaryOnly(detail.tasks) } : {}),
    ...(detail.projects ? { projects: summaryOnly(detail.projects) } : {}),
    ...(detail.users ? { users: summaryOnly(detail.users) } : {}),
    ...(detail.links ? { links: Object.fromEntries(Object.entries(detail.links).map(([name, items]) => [name, [...items].sort((a, b) => (key(a) < key(b) ? -1 : 1))])) } : {}),
    ...(detail.timeline ? { timeline: withoutPlace(detail.timeline) } : {}),
    ...(detail.history ? { history: withoutPlace(detail.history) } : {}),
  } as T;
}

describe("an item that has changed status 20,000 times, in the data file", () => {
  it("costs the next change what the second cost: the same time, the same record, one row more, and nothing more to load at the start", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-busy-"));
    const changes = 20_000;
    const median = (durations: number[]) => [...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)]!;
    try {
      const storage = new SqliteStorage({ directory });
      const engine = await Engine.open({ storage });
      const call = (operation: string, input: Record<string, unknown>) => engine.execute(operation, "agent1", input) as Promise<any>;
      await call("create_project", { title: "Busy", prefix: "busy" });
      const task = await call("create_task", { title: "Busy", description: "Switched between draft and open, over and over." });
      const db = new DatabaseSync(join(directory, "default.sqlite"), { readOnly: true });
      const stored = (kind: string, id: string) => ({
        record: Number((db.prepare("SELECT length(data) AS bytes FROM objects WHERE kind = ? AND id = ?").get(kind, id) as { bytes: number }).bytes),
        timeline: Number((db.prepare("SELECT count(*) AS entries FROM timeline WHERE kind = ? AND id = ?").get(kind, id) as { entries: number }).entries),
        history: Number((db.prepare("SELECT count(*) AS entries FROM history WHERE kind = ? AND id = ?").get(kind, id) as { entries: number }).entries),
      });
      for (const [kind, id, operation, statuses] of [["task", task.id as string, "set_task_status", ["draft", "open"]], ["project", "BUSY", "set_project_status", ["broken", "open"]]] as const) {
        const took: number[] = [];
        let early: { stored: ReturnType<typeof stored>; loaded: number } | undefined;
        for (let n = 1; n <= changes; n++) {
          const began = performance.now();
          await call(operation, { id, version: n, status: statuses[(n - 1) % 2] });
          took.push(performance.now() - began);
          if (n === 2) early = { stored: stored(kind, id), loaded: JSON.stringify(await storage.load("default")).length };
        }
        const late = { stored: stored(kind, id), loaded: JSON.stringify(await storage.load("default")).length };
        // The record is what it was after the second change, but for the digits its version gained: with the
        // timeline inside it, it had grown to more than a megabyte by now.
        assert.ok(late.stored.record <= early!.stored.record + 4 && late.stored.record < 400, `${kind}: the record had ${early!.stored.record} bytes after 2 changes and has ${late.stored.record} after ${changes}`);
        // Each change added one row to the timeline and one to the history, and rewrote none.
        assert.deepEqual([late.stored.timeline - early!.stored.timeline, late.stored.history - early!.stored.history], [changes - 2, changes - 2], kind);
        // What the service loads into memory when it starts is as much as after the second change.
        assert.ok(late.loaded <= early!.loaded + 16, `${kind}: ${early!.loaded} bytes were loaded at the start after 2 changes, ${late.loaded} after ${changes}`);
        // And a change takes as long as one did early on. Half of the last thousand took no longer than this
        // many times what half of the second thousand took; with the timeline inside the record it was twenty times.
        const [then, now] = [median(took.slice(1000, 2000)), median(took.slice(-1000))];
        assert.ok(now <= 3 * then + 0.05, `${kind}: a change took ${then.toFixed(3)} ms around the 1,500th and ${now.toFixed(3)} ms around the ${changes - 500}th`);
        // The item is read with the latest page of its timeline, and says how long the timeline is.
        const read = await call("get", { id });
        assert.deepEqual([read.timeline.length, read.more.timeline.total, read.timeline.at(-1).status, read.status], [100, changes + 1, "open", "open"], kind);
        assert.ok(JSON.stringify(read).length < 10_000, `${kind}: get answers with ${JSON.stringify(read).length} bytes`);
      }
      db.close();
      await engine.close();
      // Started again, the plan in memory is small, and no timeline was read to build it.
      const again = await Engine.open({ storage: new SqliteStorage({ directory }) });
      assert.deepEqual([again.checkConsistency(), (await again.checkTimelines()).length], [[], 0]);
      await again.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("a data file that the version before wrote, with each item's timeline inside its record", () => {
  const pick = ({ ok, format, revision, messages }: ReturnType<typeof inspectTenantFile>) => ({ ok, format, revision, messages });
  const revision = Number(/VALUES \(1, 1, (\d+),/.exec(FORMAT_1_SQL.find((statement) => statement.startsWith("INSERT INTO head"))!)![1]);

  it("is taken over by the service at its start, which says so once, and by no start after that", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-format-1-"));
    const config = join(directory, "config.toml");
    initConfig(config, { name: "taken-over", port: await freePort() });
    mkdirSync(join(directory, "data"));
    writeFormat1(join(directory, "data", "default.sqlite"));
    let running: Service | undefined;
    const begin = async () => {
      const warnings: string[] = [];
      running = await startService({ loaded: loadConfig(config, {}), log: () => {}, warn: (line) => warnings.push(line) });
      return { service: running, warnings };
    };
    try {
      const first = await begin();
      assert.deepEqual(
        first.warnings.filter((line) => line.includes("format")),
        ['The data of "default" was written by an earlier version of the service and has been brought from format 1 to format 2. A version from before this one will refuse to open it; backups taken before still restore.'],
      );
      const read = (await (await fetch(`${first.service.urls.base}/api/get`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "ABC-002" }) })).json()) as any;
      const before = FORMAT_1_ANSWERS.get["task ABC-002"];
      assert.deepEqual([read.timeline.map(({ place: _place, ...entry }: Record<string, unknown>) => entry), read.completed_at, read.status], [before.timeline, before.completed_at, "done"]);
      await first.service.stop();
      await first.service.backups.over();
      const second = await begin();
      assert.deepEqual(second.warnings.filter((line) => line.includes("format")), []);
    } finally {
      // Also when something above did not hold: a service left running would keep the tests from ending.
      const ending = running;
      await ending?.stop().catch(() => {});
      await ending?.backups.over().catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("is brought to the present format when the store opens it, and then answers and changes as the version that wrote it did", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vigile-format-1-"));
    const file = join(directory, "default.sqlite");
    writeFormat1(file);
    let tick = Date.parse(FORMAT_1_THEN_FROM);
    const open = async () => {
      const upgrades: unknown[] = [];
      const storage = new SqliteStorage({ directory, onUpgrade: (...told) => upgrades.push(told) });
      return { engine: await Engine.open({ storage, clock: { now: () => new Date(tick) } }), upgrades };
    };
    const look = (sql: string, ...values: string[]) => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        return Number(Object.values(db.prepare(sql).get(...values) as Record<string, unknown>)[0]);
      } finally {
        db.close();
      }
    };
    try {
      // Before the service has started on it, the file is what the doctor finds sound: of format 1, as it is.
      assert.deepEqual(pick(inspectTenantFile("default", file)), { ok: true, format: 1, revision, messages: ["ok"] });
      assert.equal(look("SELECT length(data) FROM objects WHERE id = 'ABC-003'") > 6000, true, "the task that changed status 105 times carries them all in its record");

      const { engine, upgrades } = await open();
      assert.deepEqual(upgrades, [["default", 1, 2]]);
      assert.deepEqual(pick(inspectTenantFile("default", file)), { ok: true, format: 2, revision: revision + 1, messages: ["ok"] }, "migration advances the revision so a writer holding format-1 state must reload");
      assert.deepEqual([engine.checkConsistency(), await engine.checkTimelines()], [[], []]);
      // The timelines are beside the records now, entry for entry, and no record holds one.
      assert.equal(look("SELECT count(*) FROM objects WHERE json_type(data, '$.timeline') IS NOT NULL"), 0);
      assert.equal(look("SELECT count(*) FROM timeline WHERE kind = 'task' AND id = 'ABC-003'"), 106);
      assert.equal(look("SELECT length(data) FROM objects WHERE id = 'ABC-003'") < 400, true);

      // Every item in full, and every list to its end, as the version that wrote the file answered.
      for (const [key, before] of Object.entries(FORMAT_1_ANSWERS.get)) {
        const [kind, id] = key.split(" ");
        const answer = await whole(engine, { kind, id, history: true });
        const normalized = linksInOrder(answer);
        assert.deepEqual(normalized, linksInOrder(before), key);
        if (key === "project ABC") assert.ok(answer.problems.some((problem: { code: string }) => problem.code === "contains_task_with_problems"), "current calculations also flag problems in contained tasks");
      }
      const all = async (operation: string, field: string, input: Record<string, unknown> = {}) => {
        const found: unknown[] = [];
        for (let continuation: string | undefined, first = true; first || continuation; first = false) {
          const page = (await engine.execute(operation, "agent1", { ...input, ...(continuation ? { continuation } : {}) })) as any;
          found.push(...page[field]);
          continuation = page.continuation;
        }
        return found;
      };
      // The service's calculated fields have evolved since format 1 was written. Compare the stored task and
      // project fields and their links here; timeline and history pages are compared above through `get`.
      const storedSummary = (items: any[]) => items.map((item) => {
        const fields = ["kind", "id", "title", "type", "status", "priority", "value", "size", "version", "completed_at", "contained_in", "depends_on", "assigned_to", "username", "built_in", "deleted_at"];
        return Object.fromEntries(fields.filter((field) => Object.hasOwn(item, field)).map((field) => [field, item[field]]));
      });
      assert.deepEqual(
        {
          tasks: storedSummary(await all("list_tasks", "tasks")),
          done: storedSummary(await all("list_tasks", "tasks", { status: "done" })),
          projects: storedSummary(await all("list_projects", "projects")),
          users: storedSummary(await all("list_users", "users")),
        },
        {
          tasks: storedSummary(FORMAT_1_ANSWERS.lists.tasks!),
          done: storedSummary(FORMAT_1_ANSWERS.lists.done!),
          projects: storedSummary(FORMAT_1_ANSWERS.lists.projects!),
          users: storedSummary(FORMAT_1_ANSWERS.lists.users!),
        },
      );

      // Then the same calls that version went on to make, a minute apart: changes of status, dates carried over
      // and each of the refusals of that, a delete for good. Each is answered, or refused, as it was then.
      for (const [index, call] of FORMAT_1_THEN.entries()) {
        tick += 60_000;
        const what = `call ${index + 1}: ${call.operation} ${JSON.stringify(call.input)}`;
        const outcome = await (call.operation === "get" ? whole(engine, call.input) : engine.execute(call.operation, call.as, call.input)).then(
          (answer) => ({ answer }),
          (error: unknown) => ({ refusal: (error as { toJSON(): unknown }).toJSON() }),
        );
        // The old same-status refusal now also explains how to read the unchanged project.
        const expected = call.refusal?.rule === "same_status"
          ? { ...call.refusal, actions: [`Call get with kind "project" and id "${call.input.id}" to read its current state; no status change is needed.`] }
          : call.refusal;
        assert.deepEqual("answer" in outcome ? { answer: linksInOrder(outcome.answer) } : outcome, "refusal" in call ? { refusal: expected } : { answer: linksInOrder(call.answer) }, what);
      }
      assert.deepEqual([engine.checkConsistency(), await engine.checkTimelines()], [[], []]);
      // The task that was deleted for good took its timeline with it.
      assert.equal(look("SELECT count(*) FROM timeline WHERE id = 'ABC-004'"), 0);
      await engine.close();

      // Opened again, the file is of the present format already: nothing is brought anywhere, and it reads the same.
      const again = await open();
      assert.deepEqual(again.upgrades, []);
      const last = FORMAT_1_THEN.findLast((call) => call.operation === "get" && call.answer?.id === "ABC-002")!;
      assert.deepEqual(linksInOrder(await whole(again.engine, last.input)), linksInOrder(last.answer));
      await again.engine.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
