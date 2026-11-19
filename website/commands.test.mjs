// Types the commands the site shows. Every block of commands on a hand-written page says which terminal it is
// typed in, and here each is typed there, in the order of the page, in terminals that start with what the page
// says they start with. The example of every operation is run as its page shows it, on the command line and
// over HTTP, against a real service. A page whose commands do not work as typed fails these tests.
//
// Everything here goes through the program, as a reader would: the command, and the service it starts. No
// module of the product is loaded and no file of its code is read.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { SETTINGS_OF_TERMINALS, SKIPS, build } from "./build.mjs";
import { GUARDS, INTERNAL, STARTUP } from "./lib/contract.mjs";
import { run, startService } from "./lib/program.mjs";
import { freePorts, place, typed } from "./lib/terminals.mjs";

describe("the commands the site shows", () => {
  let folder;
  let built;
  before(async () => {
    folder = mkdtempSync(join(tmpdir(), "vigile-site-commands-"));
    built = await build({ out: join(folder, "site"), siteUrl: "https://site.example/vigile/" });
  });
  after(() => rmSync(folder, { recursive: true, force: true }));

  it("say, each block of them, which terminal it is typed in or why it is not run", () => {
    // In the pages as they are built: no block of shell commands without one of the three.
    let blocks = 0;
    for (const page of built.pages) {
      const html = readFileSync(join(folder, "site", page.path.endsWith(".html") ? page.path : join(page.path, "index.html")), "utf8");
      for (const tag of html.match(/<pre data-language="sh"[^>]*>/g) ?? []) {
        blocks++;
        const said = ["terminal", "skip", "example"].filter((name) => tag.includes(`data-${name}="`));
        assert.equal(said.length, 1, `${page.path}: a block of commands says its terminal, why it is not run, or that it is an operation's example: ${tag}`);
      }
    }
    assert.ok(blocks >= 60, "the blocks of commands are found");
    for (const block of built.shell) {
      assert.ok(block.terminal ? Object.hasOwn(SETTINGS_OF_TERMINALS, block.setting) : Object.hasOwn(SKIPS, block.skip), `${block.source}: ${block.text.split("\n")[0]}`);
    }
    // Most of them are typed: what is left out is what cannot be typed in a throwaway place.
    const run = built.shell.filter((block) => block.terminal);
    const left = built.shell.filter((block) => block.skip);
    assert.ok(run.length >= 20, `${run.length} blocks are typed`);
    for (const block of left) {
      const text = block.text;
      const why = { network: /git (clone|pull)|pnpm install/, "other-program": /^claude /, placeholder: /vig_\.\.\.|<token>|\d{8}-\d{6}/, "second-service": /vigile serve/ }[block.skip];
      assert.match(text, why, `${block.source}: a block that is left out for "${block.skip}" is one that reason is true of: ${text.split("\n")[0]}`);
    }
  });

  it("never name a port of a real instance when they are typed", () => {
    assert.equal(typed("curl http://127.0.0.1:8700/x; vigile config set listen.port 8701; echo 18700 87001", [19001, 19002, 19003]), "curl http://127.0.0.1:19001/x; vigile config set listen.port 19002; echo 18700 87001");
    assert.throws(() => typed("vigile serve --listen.port 8700", [8700, 19002, 19003]), /a port of a real instance/);
  });

  it("cannot be typed in a terminal that was not given the two lines every terminal needs, which is why the pages give them", async () => {
    // What Install and first run once showed: the second terminal went straight to the commands.
    const there = await place("fresh", await freePorts(3));
    try {
      await there.run({ terminal: "first", stays: false, text: 'export PATH="$HOME/code/vigile/bin:$PATH"\nexport VIGILE_CONFIG=~/vigile/main/config.toml\nvigile config init --name main' });
      await there.run({ terminal: "first", stays: true, text: "vigile serve" });
      await assert.rejects(there.run({ terminal: "second", stays: false, text: 'vigile create-project --title "Website relaunch" --prefix WEB' }), /In the second terminal a command failed: vigile create-project[\s\S]*command not found/);
      await assert.rejects(there.run({ terminal: "third", stays: false, text: 'export PATH="$HOME/code/vigile/bin:$PATH"\nvigile list-projects' }), /In the third terminal a command failed: vigile list-projects[\s\S]*No config file given/);
      // And a terminal that a service keeps takes nothing more.
      await assert.rejects(there.run({ terminal: "first", stays: false, text: "vigile doctor" }), /The first terminal is taken by a command that is still running in it/);
    } finally {
      await there.close();
    }
    // The page as it is: each terminal it opens starts with the two lines.
    const install = built.shell.filter((block) => block.page === "docs/install/" && block.terminal);
    for (const name of new Set(install.map((block) => block.terminal))) {
      const first = install.find((block) => block.terminal === name);
      assert.equal(first.text, 'export PATH="$HOME/code/vigile/bin:$PATH"\nexport VIGILE_CONFIG=~/vigile/main/config.toml', `the ${name} terminal of Install and first run starts with the two lines`);
    }
    assert.deepEqual([...new Set(install.map((block) => block.terminal))], ["first", "second"]);
  });

  it("work as typed, page by page and terminal by terminal", async () => {
    const pages = [...new Set(built.shell.filter((block) => block.terminal).map((block) => block.page))];
    assert.ok(pages.includes("") && pages.includes("docs/install/") && pages.includes("docs/cli/") && pages.includes("docs/http-api/"), "the pages with commands to type are found");
    for (const path of pages) {
      const blocks = built.shell.filter((block) => block.page === path && block.terminal);
      const there = await place(blocks[0].setting, await freePorts(3));
      const printed = [];
      try {
        for (const block of blocks) {
          try {
            printed.push(await there.run(block));
          } catch (error) {
            assert.fail(`${block.source}, in a terminal that starts with this: ${SETTINGS_OF_TERMINALS[block.setting]}.\n${error.message}`);
          }
        }
        // What the pages say the commands print, where they show it.
        if (path === "docs/install/") {
          const all = printed.join("\n");
          assert.match(all, /Config created/);
          assert.match(all, /MCP\s+http:\/\/127\.0\.0\.1:\d+\/mcp/);
          assert.match(all, /2 tasks can be started now/, "the first plan of Install and first run ends as the page says");
          assert.match(all, /WEB-001 .*Checkout: a customer can pay for a basket\s+\(0\/2\)/);
          assert.match(all, /vigile doctor[\s\S]*passed/);
        }
        if (path === "docs/http-api/") assert.match(printed.join("\n"), /event: hello\ndata: \{"revision":\d+\}/, "the stream of changes says hello");
        if (path === "docs/storage/") assert.match(printed.join("\n"), /default-\d{8}-\d{6}-\d{3}\.sqlite/, "a backup is named after the moment it was taken");
      } finally {
        await there.close();
      }
    }
  });

  it("say of each guard before the API and MCP what a real service does: a program is passed by the first only", async () => {
    const ports = await freePorts(3);
    const there = await place("running", ports);
    const port = ports[0];
    const local = `127.0.0.1:${port}`;
    /** One request with exactly these headers: nothing is added that a browser or fetch would add. */
    const ask = (method, path, headers = {}, body) =>
      new Promise((resolve, reject) => {
        const sent = request({ host: "127.0.0.1", port, path, method, headers: { host: local, ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) }), ...headers } }, (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => (text += chunk));
          response.on("end", () => {
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              // Not JSON: a page, or a stream of events.
            }
            resolve({ status: response.statusCode, code: json?.error?.code ?? null, message: json?.error?.message ?? "", json, text });
          });
        });
        sent.on("error", reject);
        sent.end(body);
      });
    const json = { "content-type": "application/json" };
    const mcpBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    /** A call of each guarded endpoint that is let in when nothing is wrong with it. */
    const calls = {
      "/api": (headers = {}) => ask("POST", "/api/list-tasks", { ...json, ...headers }, "{}"),
      "/mcp": (headers = {}) => ask("POST", "/mcp", { ...json, accept: "application/json, text/event-stream", ...headers }, mcpBody),
    };
    try {
      assert.deepEqual(GUARDS.map((guard) => [guard.id, guard.on, guard.code]), [["other-site", ["/api", "/mcp"], "forbidden"], ["host", ["/api", "/mcp"], "forbidden"], ["json", ["/api"], "invalid_input"]], "the guards the pages name");
      // A program, which sends no header of a browser's, is let in at both.
      for (const [where, callIt] of Object.entries(calls)) {
        const answer = await callIt();
        assert.equal(answer.status, 200, `${where}: a plain program is let in\n${answer.text.slice(0, 200)}`);
      }
      /** What breaks each guard's rule, as a program could send it and as a browser would. */
      const breaks = {
        "other-site": [{ origin: "http://evil.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "cross-site", origin: `http://${local}` }],
        host: [{ host: "evil.example" }, { host: `evil.example:${port}` }, { host: "127.0.0.1.evil.example" }, { host: "192.168.1.20" }],
      };
      for (const guard of GUARDS.filter((one) => one.id !== "json")) {
        for (const where of guard.on) {
          for (const headers of breaks[guard.id]) {
            const answer = await calls[where](headers);
            assert.equal(answer.code, guard.code, `${guard.name}, before ${where}: ${JSON.stringify(headers)} is refused with ${guard.code}\n${answer.text.slice(0, 200)}`);
          }
        }
      }
      // The first guard goes by what browsers send, and lets the service's own page and a plain program through.
      for (const headers of [{}, { "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "none" }, { origin: `http://${local}` }, { "sec-fetch-site": "same-origin", origin: "http://evil.example" }]) {
        assert.equal((await calls["/api"](headers)).status, 200, `the first guard lets ${JSON.stringify(headers)} through`);
      }
      // The second is held against every client. A program that sends nothing of a browser's and calls the
      // service by another name is refused, with a key as without one; by this machine's names it is let in.
      const refused = await ask("POST", "/api/list-tasks", { ...json, host: "evil.example", "user-agent": "curl/8.5.0" }, "{}");
      assert.deepEqual([refused.status, refused.code], [403, "forbidden"], "a program that is no browser is refused when it calls the service by another name");
      assert.match(refused.message, /listens on this machine only, and the request calls it "evil\.example"/);
      const withKey = await ask("POST", "/api/list-users", { ...json, host: "evil.example", authorization: `Bearer ${there.keys["vig_..."]}` }, "{}");
      assert.equal(withKey.code, "forbidden", "also with the admin's key");
      assert.equal((await ask("GET", "/api/operations", { host: "evil.example" })).code, "forbidden", "and for an endpoint that is not an operation");
      for (const host of [`localhost:${port}`, `LOCALHOST:${port}`, `127.0.0.1:${port}`, `127.9.9.9:${port}`, `[::1]:${port}`, `localhost.:${port}`]) {
        assert.equal((await calls["/api"]({ host })).status, 200, `called ${host}, it answers`);
      }
      // The third is held against every client as well: a body that does not say it is JSON is not read.
      for (const headers of [{ "content-type": "text/plain" }, {}, { "content-type": "application/x-www-form-urlencoded" }, { "content-type": "text/json" }]) {
        const answer = await ask("POST", "/api/list-tasks", headers, "{}");
        assert.deepEqual([answer.status, answer.code], [400, "invalid_input"], `a body sent with ${JSON.stringify(headers)} is refused`);
        assert.match(answer.message, /must be JSON and say so/);
      }
      for (const headers of [json, { "content-type": "application/json; charset=utf-8" }, { "content-type": "APPLICATION/JSON" }]) assert.equal((await ask("POST", "/api/list-tasks", headers, "{}")).status, 200, JSON.stringify(headers));
      assert.equal((await ask("POST", "/api/list-tasks")).status, 200, "no body at all is an empty input");
      // What is not behind the guards: the health check and the files of the page.
      for (const headers of [{ host: "evil.example" }, { origin: "http://evil.example" }, { "sec-fetch-site": "cross-site" }]) {
        const health = await ask("GET", "/health", headers);
        assert.deepEqual([health.status, health.json?.status], [200, "ok"], `/health answers ${JSON.stringify(headers)}`);
        const pageOf = await ask("GET", "/", headers);
        assert.equal(pageOf.status, 200, `the page is served to ${JSON.stringify(headers)}`);
        assert.match(pageOf.text, /<!doctype html>/i);
      }

      // ---- The pages say this, and no longer that a program is not affected.
      const text = (path) =>
        readFileSync(join(folder, "site", path, "index.html"), "utf8")
          .replace(/<[^>]+>/g, " ")
          .replaceAll("&quot;", '"')
          .replaceAll("&amp;", "&")
          .replace(/\s+/g, " ")
          .replace(/ ([,.:;])/g, "$1");
      const sentence = (words) => `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
      for (const [path, guards] of [["docs/security/", GUARDS], ["docs/http-api/", GUARDS.filter((guard) => guard.on.includes("/api"))], ["docs/mcp/", GUARDS.filter((guard) => guard.on.includes("/mcp"))]]) {
        const said = text(path);
        for (const guard of guards) {
          assert.ok(said.includes(`${guard.name} `) && said.includes(sentence(guard.refuses)) && said.includes(sentence(guard.concerns)), `${path} says of "${guard.name}" what it refuses and whom it concerns`);
        }
        assert.doesNotMatch(said, /Programs that are not browsers are not affected/, `${path} does not say that a program is not affected`);
      }
      assert.equal(GUARDS.filter((guard) => /Every client, a browser or not/.test(guard.concerns)).length, 2, "two of the three are held against every client");
      assert.match(GUARDS[0].concerns, /^Only what sends those headers, which is browsers/);
      const security = text("docs/security/");
      assert.ok(security.includes("Only the first is about browsers alone."));
      assert.ok(security.includes("The other two are held against every client. A script or an agent that calls a service on 127.0.0.1 by another name is refused like a browser, and so is one that sends a body to the API without saying that it is JSON."));
      assert.ok(security.includes("GET /health and the files of the web page are not behind the guards."));
      assert.ok(text("docs/http-api/").includes("A program that is not a browser is passed by the first guard only, because it sends neither header. The other two are held against it like against a browser. GET /health is not behind them."));
      assert.ok(text("docs/mcp/").includes("An agent is not a browser, so the first passes it by. The second is held against it"));
    } finally {
      await there.close();
    }
  });

  it("show how to get it and build it, on the first page and in Install and first run, with the same commands", () => {
    // These blocks fetch from the network and are not typed here: what they say is held to one form.
    const blocks = built.shell.filter((block) => block.skip === "network" && /pnpm install\npnpm build/.test(block.text));
    assert.deepEqual([...new Set(blocks.map((block) => block.page))].sort(), ["", "docs/install/"], "the first page and Install and first run show how to get it and build it");
    for (const block of blocks.filter((each) => !/git pull/.test(each.text))) assert.match(block.text, /^git clone \S+ ~\/code\/vigile\ncd ~\/code\/vigile\npnpm install\npnpm build$/, `${block.source}: the commands to get it and build it`);
  });

  it("say of a start that failed what has happened to the data folder by then, step by step, as a real service leaves it", async () => {
    assert.deepEqual(STARTUP.map((step) => [step.id, step.changed]), [["take", false], ["recover", false], ["open", true], ["listen", true]], "the steps of a start, and whether the folder can have changed by the time each fails");
    const home = mkdtempSync(join(tmpdir(), "vigile-site-start-"));
    /** Runs the command once, and reads the error it reports as JSON, if it reports one. */
    const vigile = async (args) => {
      const done = await run(args, { home });
      let error = null;
      try {
        error = JSON.parse(done.err).error ?? null;
      } catch {
        // No error as JSON: the command did not fail, or said something else.
      }
      return { ...done, error };
    };
    /** The files of a data folder with what is in each, the lock of a running service left out. */
    const filesOf = (data) =>
      Object.fromEntries(
        readdirSync(data, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile() && !/^vigile\.(lock|hold|files)|-shm$|-wal$|-journal$/.test(entry.name))
          .map((entry) => [join(entry.parentPath, entry.name).slice(data.length + 1), createHash("sha256").update(readFileSync(join(entry.parentPath, entry.name))).digest("hex")]),
      );
    const taken = [];
    const occupy = (port) =>
      new Promise((resolve, reject) => {
        const server = createServer();
        taken.push(server);
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
    /** A new instance, made with the command and not started. */
    const instance = async (name) => {
      const [port] = await freePorts(1);
      const config = join(home, name, "config.toml");
      const made = await vigile(["config", "init", "--config", config, "--name", name, "--port", String(port), "--json"]);
      assert.equal(made.code, 0, made.err);
      return { name, config, data: join(home, name, "data"), port, adminKey: JSON.parse(made.out).admin_key };
    };
    const started = [];
    const start = async (one) => {
      const service = await startService({ name: one.name, config: one.config, home, port: one.port, adminKey: one.adminKey });
      started.push(service);
      return service;
    };
    try {
      // ---- Step 1, the folder is another service's: nothing in it is changed.
      // The service is a process of its own, as it is for a reader: this test then reads its files without being
      // the process that holds them.
      const held = await instance("held");
      const first = await start(held);
      assert.equal((await first.ask("create_task", { title: "There before", description: "Made before the second start." })).status, 200);
      const before = filesOf(held.data);
      assert.ok(Object.hasOwn(before, "default.sqlite"));
      const second = await vigile(["serve", "--json", "--config", held.config]);
      assert.deepEqual([second.code, second.error?.code], [1, "cannot_start"], second.err);
      assert.match(second.error.message, /Another Vigile service \(process \d+\) is already using/);
      assert.deepEqual(filesOf(held.data), before, "a start that could not take the folder changed nothing in it");
      // A call that is turned away before it reaches an operation changes nothing either.
      const turnedAway = await fetch(`${first.url}/api/create-task`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer vig_not_a_key" }, body: JSON.stringify({ title: "No", description: "Not let in." }) });
      assert.deepEqual([turnedAway.status, (await turnedAway.json()).error.code], [401, "unauthorized"]);
      assert.equal((await first.call("list_tasks", {})).tasks.length, 1, "after unauthorized, nothing was changed");
      await first.stop();

      // ---- Step 3, the config names a user that does not exist: the new folder has its data file by then.
      const ghost = await instance("ghost");
      assert.equal(existsSync(join(ghost.data, "default.sqlite")), false, "a new instance has no data file before its first start");
      // No service runs on it, so the command writes the setting without being able to check it, and says so.
      const unchecked = await vigile(["config", "set", "auth.keyless_user", "ghost", "--json", "--config", ghost.config]);
      assert.equal(unchecked.code, 0, unchecked.err);
      assert.match(JSON.parse(unchecked.out).warning, /could not be checked/);
      const noSuchUser = await vigile(["serve", "--json", "--config", ghost.config]);
      assert.deepEqual([noSuchUser.code, noSuchUser.error?.code, noSuchUser.error?.message], [1, "cannot_start", "The config names a user that does not exist."], noSuchUser.err);
      assert.ok(Object.keys(filesOf(ghost.data)).includes("default.sqlite"), "the start that failed at the keyless user had opened the plan: the new folder has its data file");
      assert.equal((await vigile(["config", "set", "auth.keyless_user", "agent1", "--json", "--config", ghost.config])).code, 0);
      const opened = await start(ghost);
      assert.deepEqual((await opened.call("list_users", {}, "admin")).users.map((user) => user.username), ["admin", "user", "agent1"], "with the three built-in users, made by the start that failed");
      await opened.stop();

      // ---- Step 4, the port is taken: the new folder has its data file by then.
      const busy = await instance("busy");
      await occupy(busy.port);
      const noPort = await vigile(["serve", "--json", "--config", busy.config]);
      assert.deepEqual([noPort.code, noPort.error?.code], [1, "cannot_start"], noPort.err);
      assert.match(noPort.error.message, new RegExp(`^Port ${busy.port} on 127\\.0\\.0\\.1 is already in use`));
      assert.ok(Object.keys(filesOf(busy.data)).includes("default.sqlite"), "the start that failed at the port had opened the plan");

      // ---- The page says this, step by step, and no page says that a start that failed left the plan untouched.
      const text = (path) =>
        readFileSync(join(folder, "site", path, "index.html"), "utf8")
          .replace(/<[^>]+>/g, " ")
          .replaceAll("&quot;", '"')
          .replace(/\s+/g, " ")
          .replace(/ ([,.:;])/g, "$1");
      const sentence = (words) => `${words}.`;
      const trouble = text("docs/troubleshooting/");
      for (const step of STARTUP) assert.ok(trouble.includes(sentence(step.does)) && trouble.includes(sentence(step.fails)) && trouble.includes(sentence(step.by)), `the page says of the step "${step.id}" what it does, when it fails and what has happened by then`);
      assert.ok(trouble.includes("So a failed start does not by itself mean that the data folder is as it was"));
      assert.ok(trouble.includes("Before starting it again, look: vigile doctor checks the config and the data, and says whether a restore was left half-done"));
      for (const page of built.pages) {
        const said = text(page.path.endsWith(".html") ? "docs/errors/" : page.path);
        assert.doesNotMatch(said, /Nothing of the plan was changed/, `${page.path} does not say that a start that failed changed nothing`);
        // Where a row of a table, a paragraph or an item of a list speaks of cannot_start, it does not say that nothing was changed.
        const html = readFileSync(join(folder, "site", page.path.endsWith(".html") ? "404.html" : join(page.path, "index.html")), "utf8");
        for (const one of html.split(/<\/tr>|<\/p>|<\/li>/)) if (/cannot_start/.test(one)) assert.doesNotMatch(one.replace(/<[^>]+>/g, " "), /\b(nothing|Nothing) (of the plan )?(was|is|has been) (changed|written|touched)/, `${page.path}: ${one.replace(/<[^>]+>/g, " ").slice(-200)}`);
      }
      assert.ok(text("docs/errors/").includes("What has happened to the data folder by then depends on the step that failed"));
      assert.ok(text("docs/cli/").includes("cannot_start It depends on how far the start had come"));
    } finally {
      for (const server of taken) server.close();
      for (const service of started) await service.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("say of an error called internal that left something behind what a real service says, when its config file cannot be written", async (context) => {
    // The keys are kept in the config file. A service whose config folder takes no writing stores a new user
    // and cannot store its key: the one way from outside to an error after which something stands. An account
    // that may write anywhere cannot be kept from writing, and stands aside.
    if (typeof process.getuid !== "function" || process.getuid() === 0) return context.skip("This account can write to a folder that is closed to writing, so a config file that cannot be written cannot be made.");
    const service = await startService();
    const instance = dirname(service.config);
    const text = (path) =>
      readFileSync(join(folder, "site", path, "index.html"), "utf8")
        .replace(/<[^>]+>/g, " ")
        .replaceAll("&quot;", '"')
        .replace(/\s+/g, " ")
        .replace(/ ([,.:;])/g, "$1");
    try {
      await service.call("create_user", { username: "leaving", type: "agent" }, "admin");
      chmodSync(instance, 0o555);
      // A user is created, and its key cannot be stored: the message the pages quote, and the user is there.
      const before = await service.revision();
      const created = await service.refusal("create_user", { username: "keyless", type: "agent" }, "admin");
      const stated = INTERNAL.find((one) => one.case === "stored, then the key could not be");
      assert.deepEqual([created.code, created.message, (await service.revision()) !== before], [stated.code, stated.message, stated.stored], "what website/lib/contract.mjs states of this case is what the service does");
      assert.ok((await service.call("list_users", {}, "admin")).users.some((user) => user.username === "keyless"), "the user whose key could not be stored is there");
      assert.equal((await service.refusal("create_user", { username: "keyless", type: "agent" }, "admin")).rule, "username_taken", "so it is not created again");
      assert.ok(text("docs/operations/create-user/").includes('internal, "User … was created, but its API key could not be stored": the user is there and cannot connect yet. Do not create it again'));
      // A key is reset, and the new one cannot be stored.
      const reset = await service.refusal("reset_user_key", { user: "leaving" }, "admin");
      assert.deepEqual([reset.code, reset.message], ["internal", "No new API key could be stored for leaving. The key it had, if any, still works."]);
      assert.equal((await service.call("list_users", {}, "leaving")).you, "leaving", "the key the user had still works");
      assert.ok(text("docs/operations/reset-user-key/").includes("the key the user had still works"));
      // A user is deleted, and its key cannot be removed.
      const { version } = await service.call("get", { id: "leaving", kind: "user" }, "admin");
      const deleted = await service.refusal("delete", { id: "leaving", kind: "user", version }, "admin");
      assert.equal(deleted.code, "internal");
      assert.match(deleted.message, /^User leaving was deleted, but its API key could not be removed/);
      assert.equal((await service.ask("list_users", {}, "leaving")).status, 401, "the key lets nobody in while the user is deleted");
      assert.ok(text("docs/operations/delete/").includes('internal, "User … was deleted, but its API key could not be removed": the user is deleted, and the key lets nobody in while it is.'));
      // And it is brought back.
      const restored = await service.refusal("restore", { id: "leaving", kind: "user" }, "admin");
      assert.equal(restored.code, "internal");
      assert.match(restored.message, /^User leaving was restored\./);
      assert.ok((await service.call("list_users", {}, "admin")).users.some((user) => user.username === "leaving"), "the user is back");
      assert.ok(text("docs/operations/restore/").includes("the user is back"));
    } finally {
      chmodSync(instance, 0o755);
      await service.stop();
    }
  });

  it("show, for every operation, a command and a request that do what the page says when they are typed", async () => {
    assert.equal(built.examples.length, built.facts.operations.length);
    const tried = async (example) => {
      // On the command line, in one place: the call that is refused first, since it changes nothing, then the example.
      const first = await place("running-demo", await freePorts(3));
      try {
        for (const step of example.before) await first.service.call(step.operation, step.input, step.as ?? "agent1");
        if (example.refused) {
          const refused = await first.once(`${example.refused.command} --json`);
          assert.equal(refused.code, 1, `${example.operation}: the call the page says is refused ends with 1\n${refused.err}`);
          assert.equal(JSON.parse(refused.err).error.code, example.refused.code, `${example.operation}: and with the code the page shows`);
          const overHttp = await first.once(example.refused.http, first.keys);
          assert.equal(JSON.parse(overHttp.out).error?.code, example.refused.code, `${example.operation}: the refused call over HTTP\n${overHttp.out}`);
        }
        const done = await first.once(example.command);
        assert.equal(done.code, 0, `${example.operation}: the command of the page works as typed: ${example.command}\n${done.err}`);
      } finally {
        await first.close();
      }
      // Over HTTP, in a place of its own: the example is a change, and is made once.
      const second = await place("running-demo", await freePorts(3));
      try {
        for (const step of example.before) await second.service.call(step.operation, step.input, step.as ?? "agent1");
        const answered = await second.once(example.http, second.keys);
        assert.equal(answered.code, 0, `${example.operation}: curl ran\n${answered.err}`);
        const answer = JSON.parse(answered.out);
        assert.equal(answer.error, undefined, `${example.operation}: the request of the page is answered, not refused: ${example.http}\n${answered.out}`);
      } finally {
        await second.close();
      }
    };
    // Each example has its own two places, so a few are tried side by side.
    const waiting = [...built.examples];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let example = waiting.shift(); example; example = waiting.shift()) await tried(example);
      }),
    );
  });
});
