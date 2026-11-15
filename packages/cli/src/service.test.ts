import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { connect as openSocket, createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { initConfig, loadConfig, setKey, setValue } from "@vigile/config";
import { Engine, VigileError, paging } from "@vigile/core";
import type { StorageAdapter } from "@vigile/storage";
import { SqliteStorage, backupTenantFile, folderIsHeld, historyOwners, inspectTenantFile } from "@vigile/storage-sqlite";
import { webRoot } from "@vigile/web";
import { openAsPlan } from "./restore.js";
import { StartupError, isLoopback, namedFromOutside, startService, type Service, type ServiceOptions } from "./service.js";

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

async function start(environment: NodeJS.ProcessEnv = {}, limits: ServiceOptions["limits"] = undefined): Promise<Running> {
  const directory = mkdtempSync(join(tmpdir(), "vigile-service-"));
  const config = join(directory, "config.toml");
  const { adminKey } = initConfig(config, { name: "test", port: await freePort() });
  const warnings: string[] = [];
  const logged: string[] = [];
  const service = await startService({ loaded: loadConfig(config, environment), log: (line) => logged.push(line), warn: (line) => warnings.push(line), limits });
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

  it("answers /health without a key", async () => {
    const { status, body } = await running.call("/health");
    assert.equal(status, 200);
    assert.deepEqual(body, { status: "ok", name: "test", version: "0.1.0" });
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
    const agent = await running.call("/api/operations");
    const admin = await running.call("/api/operations", undefined, running.adminKey);
    assert.equal(agent.body.operations.length, 18);
    assert.equal(admin.body.operations.length, 20);
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
  it("lets go of a request that does not arrive in full, and of connections beyond the limit", async () => {
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

      // More connections than the limit: the further ones are closed at once, and the service still answers after.
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
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal((await running.call("/health")).status, 200);
    } finally {
      for (const socket of sockets) socket.destroy();
      await running.stop();
    }
  });

  it("gives one address a share of the places on the stream of changes, not all of them", async () => {
    const running = await start();
    const aborts: AbortController[] = [];
    try {
      const listen = async () => {
        const abort = new AbortController();
        aborts.push(abort);
        const response = await fetch(`${running.service.urls.base}/api/events`, { signal: abort.signal });
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
        return (await fetch(`${running.service.urls.base}/api/events`, { signal: abort.signal, headers: { "x-forwarded-for": client } })).status;
      };
      assert.equal(await behind("203.0.113.7"), 200);
      // What a client writes into that header itself stands before what the proxy adds, and does not count: one
      // client cannot pass for many by naming a new address each time.
      const sameClient = [];
      for (let i = 0; i < 33; i++) sameClient.push(await behind(`198.51.100.${i}, 203.0.113.99`));
      assert.deepEqual([sameClient.filter((status) => status === 200).length, sameClient.at(-1)], [32, 429], "the 33rd connection of one client is refused, whatever it claims");
      // A place is free again as soon as one of them leaves.
      aborts[0]!.abort();
      const end = Date.now() + 2000;
      const listeners = async () => (await running.call("/api/admin/status", undefined, running.adminKey)).body.listeners as number;
      while ((await listeners()) !== 31 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal((await listen()).status, 200);
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
    assert.equal(agentTools.length, 18);
    assert.equal(adminTools.length, 20);
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
