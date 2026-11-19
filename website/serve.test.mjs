// The two commands of the web site: the one that builds it and the one that serves a built folder as GitHub
// Pages would. They are run here as they are typed, each as a process of its own, and the preview server is
// asked over HTTP as a browser asks.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "./build.mjs";
import { basePath } from "./lib/base.mjs";
import { checkSite } from "./lib/check.mjs";
import { programPath } from "./lib/program.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));

/** Ports that are free at this moment. */
async function ports(count) {
  const found = [];
  for (let i = 0; i < count; i++) {
    found.push(
      await new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
          const { port } = probe.address();
          probe.close(() => resolve(port));
        });
      }),
    );
  }
  return found;
}

describe("the commands of the web site", () => {
  let folder;
  const run = (script, args) => spawnSync(process.execPath, [join(here, script), ...args], { encoding: "utf8" });
  before(() => (folder = mkdtempSync(join(tmpdir(), "vigile-site-commands-"))));
  /**
   * A built site to serve, in a folder of its own. It is built in this process, which asks the program once
   * for all of them: the command that builds is typed where it is the command that is looked at.
   */
  const built = (out, base) => build({ out, siteUrl: `https://site.example${basePath(base)}` });
  after(() => rmSync(folder, { recursive: true, force: true }));

  it("build the site into the folder and under the base path they are given, and end with an error when they cannot", () => {
    const out = join(folder, "built");
    const good = run("build.mjs", ["--out", out, "--base", "/preview/"]);
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /Built \d+ pages into .*built in \d+\.\d s/);
    assert.match(readFileSync(join(out, "404.html"), "utf8"), /href="\/preview\/assets\/site\.css"/);
    for (const [args, message] of [[["--nonsense"], /There is no option --nonsense/], [["--out"], /--out needs a value/], [["--out", out, "--base", "preview"], /The site was not built: The base path "preview" has to start with a slash/]]) {
      const bad = run("build.mjs", args);
      assert.equal(bad.status, 1, `${args.join(" ")} ends with an error`);
      assert.match(bad.stderr, message);
    }
    assert.ok(existsSync(join(out, "index.html")), "the site that was built before is still there");
  });

  it("build from whichever program they are told of, with an option or a variable, and write the same site, byte for byte, each time", () => {
    // The program in another place: a file of one line, in a folder that is no repository, that runs it.
    const elsewhere = join(folder, "elsewhere", "vigile");
    mkdirSync(join(folder, "elsewhere"));
    writeFileSync(elsewhere, `#!/bin/sh\nexec '${programPath().replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
    const filesOf = (out) => Object.fromEntries(readdirSync(out, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => [join(entry.parentPath, entry.name).slice(out.length + 1), createHash("sha256").update(readFileSync(join(entry.parentPath, entry.name))).digest("hex")]));
    const first = join(folder, "by-option");
    const byOption = run("build.mjs", ["--out", first, "--base", "/preview/", "--vigile", elsewhere]);
    assert.equal(byOption.status, 0, byOption.stderr);
    const second = join(folder, "by-variable");
    const byVariable = spawnSync(process.execPath, [join(here, "build.mjs"), "--out", second, "--base", "/preview/"], { encoding: "utf8", env: { ...process.env, VIGILE_BIN: elsewhere } });
    assert.equal(byVariable.status, 0, byVariable.stderr);
    assert.ok(Object.keys(filesOf(first)).length > 90, "the files of a built site are found");
    assert.deepEqual(filesOf(second), filesOf(first), "two builds, each with services of its own at another time, write the same files");
    // A program that is not there stops the build, which says what it looked for and what to do.
    for (const [args, env] of [[["--vigile", join(folder, "nowhere", "vigile")], {}], [[], { VIGILE_BIN: join(folder, "nowhere", "vigile") }]]) {
      const missing = spawnSync(process.execPath, [join(here, "build.mjs"), "--out", join(folder, "never"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /The site was not built: The program .*nowhere.vigile could not be run .*Build it first \("pnpm build"\), or name another with VIGILE_BIN or --vigile\./);
    }
    assert.ok(!existsSync(join(folder, "never")), "nothing was built without the program");
  });

  it("serve a built site as GitHub Pages would, to the one address given, and stop when told", async () => {
    const out = join(folder, "served");
    await built(out, "/preview/");
    // A file outside the folder, and a link to it from inside: neither is served.
    writeFileSync(join(folder, "outside.txt"), "not part of the site\n");
    symlinkSync(join(folder, "outside.txt"), join(out, "way-out.txt"));
    const port = await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const found = probe.address().port;
        probe.close(() => resolve(found));
      });
    });
    const child = spawn(process.execPath, [join(here, "serve.mjs"), "--dir", out, "--base", "/preview/", "--host", "127.0.0.1", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    let said = "";
    child.stdout.on("data", (chunk) => (said += chunk));
    child.stderr.on("data", (chunk) => (said += chunk));
    const ended = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    try {
      const start = Date.now();
      while (!said.includes("Serving") && Date.now() - start < 10_000) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.match(said, new RegExp(`^Serving .*served at http://127\\.0\\.0\\.1:${port}/preview/\\n$`), "one line when it starts");
      const base = `http://127.0.0.1:${port}`;
      const get = (path, options = {}) => fetch(`${base}${path}`, { redirect: "manual", ...options });

      const home = await get("/preview/");
      assert.equal(home.status, 200);
      assert.equal(home.headers.get("content-type"), "text/html; charset=utf-8");
      assert.equal(home.headers.get("cache-control"), "no-cache", "a page is asked for again after a rebuild");
      assert.equal(await home.text(), readFileSync(join(out, "index.html"), "utf8"));
      for (const [path, to] of [["/", "/preview/"], ["/preview", "/preview/"], ["/preview/how", "/preview/how/"], ["/preview/docs/operations/get", "/preview/docs/operations/get/"]]) {
        const moved = await get(path);
        assert.ok(moved.status === 301 || moved.status === 302, `${path} leads on`);
        assert.equal(moved.headers.get("location"), to);
      }
      assert.equal(await (await get("/preview/how/statuses/")).text(), readFileSync(join(out, "how", "statuses", "index.html"), "utf8"), "a folder answers with its index.html");
      for (const [path, type] of [["/preview/assets/site.css", "text/css; charset=utf-8"], ["/preview/assets/site.js", "text/javascript; charset=utf-8"], ["/preview/search.json", "application/json; charset=utf-8"], ["/preview/assets/favicon.svg", "image/svg+xml"], ["/preview/assets/og.jpg", "image/jpeg"], ["/preview/assets/pictures/board-light-760.webp", "image/webp"], ["/preview/sitemap.xml", "application/xml; charset=utf-8"]]) {
        const answer = await get(path);
        assert.equal(answer.status, 200, path);
        assert.equal(answer.headers.get("content-type"), type, path);
        await answer.arrayBuffer();
      }
      // What is not there gets the site's own 404 page, at any depth, with the status that says so.
      for (const path of ["/preview/nothing", "/preview/docs/nothing/here/", "/elsewhere/", "/preview/../outside.txt", "/preview/%2e%2e/outside.txt", "/preview/..%2foutside.txt", "/preview/way-out.txt", "/preview/assets/%00"]) {
        const missing = await get(path);
        assert.equal(missing.status, 404, path);
        assert.equal(await missing.text(), readFileSync(join(out, "404.html"), "utf8"), `${path} gets the 404 page`);
      }
      const head = await get("/preview/docs/", { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(Number(head.headers.get("content-length")), statSync(join(out, "docs", "index.html")).size);
      assert.equal(await head.text(), "", "HEAD has no body");
      assert.equal((await get("/preview/", { method: "POST" })).status, 405);
      // The browser's copy is checked, not trusted: the same file is not sent twice, a new one is.
      const again = await get("/preview/", { headers: { "if-none-match": home.headers.get("etag") } });
      assert.equal(again.status, 304);
      writeFileSync(join(out, "index.html"), "<!doctype html><title>rebuilt</title>");
      const rebuilt = await get("/preview/", { headers: { "if-none-match": home.headers.get("etag") } });
      assert.equal(rebuilt.status, 200);
      assert.match(await rebuilt.text(), /rebuilt/);
      // The site is built again while it is being served: nobody who asks meanwhile is told that a page is not there.
      let building = true;
      const answers = [];
      const asking = (async () => {
        while (building) for (const path of ["/preview/", "/preview/docs/cli/", "/preview/assets/site.css"]) answers.push([path, (await get(path)).status]);
      })();
      for (let round = 0; round < 3; round++) {
        const rebuild = spawn(process.execPath, [join(here, "build.mjs"), "--out", out, "--base", "/preview/"], { stdio: "ignore" });
        assert.equal(await new Promise((resolve) => rebuild.once("exit", resolve)), 0, "the site is built again");
      }
      building = false;
      await asking;
      assert.ok(answers.length > 20, "pages were asked for while the site was being built");
      assert.deepEqual(answers.filter(([, status]) => status !== 200), [], "every one of them was answered with the page");
      assert.match(await (await get("/preview/")).text(), /People and agents, working from/, "and the page is the new one");
      assert.deepEqual(readdirSync(folder).filter((name) => /\.(building|old)-/.test(name)), [], "nothing is left beside the folder");
      assert.equal(said.split("\n").filter(Boolean).length, 1, "nothing is written for a request unless asked");
    } finally {
      child.kill("SIGTERM");
    }
    assert.deepEqual(await ended, { code: 0, signal: null }, "SIGTERM stops it cleanly");
    assert.match(said, /Stopped \(SIGTERM\)\.\n$/);
  });

  it("say \"you have it already\" only of the very bytes they would send: never of a file of the same length written in the same moment", async () => {
    const nameOf = (bytes) => `"${createHash("sha256").update(bytes).digest("base64url")}"`;
    const moment = new Date("2026-01-12T09:14:03.000Z");
    /** Writes a file whole, by putting a finished one in its place, and gives it the one moment every file here has. */
    const put = (file, bytes) => {
      writeFileSync(`${file}.new`, bytes);
      utimesSync(`${file}.new`, moment, moment);
      renameSync(`${file}.new`, file);
    };
    for (const base of ["/", "/vigile/", "/a/b/"]) {
      const out = join(folder, `validators${base.replaceAll("/", "-")}`);
      await built(out, base);
      const [port] = await ports(1);
      const child = spawn(process.execPath, [join(here, "serve.mjs"), "--dir", out, "--base", base, "--host", "127.0.0.1", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
      const ended = new Promise((resolve) => child.once("exit", resolve));
      try {
        await new Promise((resolve, reject) => {
          child.stdout.once("data", resolve);
          child.once("exit", () => reject(new Error(`the server did not start under ${base}`)));
        });
        const ask = async (path, headers = {}, method = "GET") => {
          const answer = await fetch(`http://127.0.0.1:${port}${base}${path}`, { method, headers, redirect: "manual" });
          return { status: answer.status, etag: answer.headers.get("etag"), length: answer.headers.get("content-length"), type: answer.headers.get("content-type"), cache: answer.headers.get("cache-control"), modified: answer.headers.get("last-modified"), body: Buffer.from(await answer.arrayBuffer()) };
        };

        // ---- The case that was wrong: two files of one length, written within one moment.
        for (const path of ["probe.html", "docs/index.html", "assets/site.css"]) {
          const file = join(out, path);
          const first = Buffer.from("<!doctype html><title>the first</title>".padEnd(64, "."));
          const second = Buffer.from("<!doctype html><title>the other</title>".padEnd(64, "."));
          put(file, first);
          const had = await ask(path);
          assert.deepEqual([had.status, had.body.equals(first), had.etag], [200, true, nameOf(first)], `${base}${path}: the name of a file is made of its bytes`);
          put(file, second);
          assert.deepEqual([statSync(file).size, statSync(file).mtimeMs], [first.length, moment.getTime()], "the new file has the length and the moment of the old one");
          for (const method of ["GET", "HEAD"]) {
            const now = await ask(path, { "if-none-match": had.etag }, method);
            assert.equal(now.status, 200, `${base}${path}, ${method}: a browser that has the old file is sent the new one, not told that it has it`);
            assert.equal(now.etag, nameOf(second));
            assert.notEqual(now.etag, had.etag);
            assert.equal(Number(now.length), second.length);
            assert.ok(method === "HEAD" ? now.body.length === 0 : now.body.equals(second), `${method}: ${method === "HEAD" ? "no body" : "the new bytes"}`);
          }
          // And the browser that has the new one is told so, with no body, for GET and for HEAD.
          for (const method of ["GET", "HEAD"]) {
            const same = await ask(path, { "if-none-match": nameOf(second) }, method);
            assert.deepEqual([same.status, same.body.length, same.etag, same.cache], [304, 0, nameOf(second), "no-cache"], `${base}${path}, ${method}`);
          }
        }

        // ---- What a browser may send to ask, and what each form means.
        const bytes = readFileSync(join(out, "how", "index.html"));
        const name = nameOf(bytes);
        for (const [header, status, why] of [
          [name, 304, "the name"],
          [`W/${name}`, 304, "the name called weak: for this question it counts the same"],
          [`"something-else", W/${name}, "and-another"`, 304, "one of several"],
          [`"something-else",${name}`, 304, "one of several, written close"],
          ["*", 304, "a star: anything that is there"],
          [" * ", 304, "a star with space around it"],
          [name.slice(1, -1), 200, "the name without its quotes names nothing"],
          ['"something-else"', 200, "another name"],
          [`"something-else", "and-another"`, 200, "several others"],
          [`W/"${name.slice(1, -1).toLowerCase()}x"`, 200, "nearly the name"],
          ["", 200, "nothing"],
          [`"${name.slice(1, 12)}"`, 200, "the start of the name"],
        ]) {
          const answer = await ask("how/", { "if-none-match": header });
          assert.equal(answer.status, status, `${base}how/ asked with If-None-Match: ${header} (${why})`);
          assert.ok(status === 304 ? answer.body.length === 0 : answer.body.equals(bytes));
        }
        // A time says too little to go by: none is given, and one that is sent decides nothing.
        const plainly = await ask("how/");
        assert.equal(plainly.modified, null, "no Last-Modified is sent");
        const later = new Date(Date.now() + 86_400_000).toUTCString();
        assert.equal((await ask("how/", { "if-modified-since": later })).status, 200, "If-Modified-Since alone is not gone by");
        assert.equal((await ask("how/", { "if-modified-since": later, "if-none-match": '"something-else"' })).status, 200, "a name that does not match decides, whatever the time");
        assert.equal((await ask("how/", { "if-modified-since": "Thu, 01 Jan 1970 00:00:00 GMT", "if-none-match": name })).status, 304, "a name that matches decides, whatever the time");
        // HEAD says what GET says, without the body.
        for (const path of ["", "how/", "assets/site.css", "search.json", "nothing/here/"]) {
          const got = await ask(path);
          const head = await ask(path, {}, "HEAD");
          assert.deepEqual([head.status, head.etag, head.length, head.type, head.cache, head.body.length], [got.status, got.etag, got.length, got.type, got.cache, 0], `${base}${path}: HEAD`);
          assert.equal(got.etag, nameOf(got.body), `${base}${path}: the name is the name of the bytes that were sent`);
        }
        // What is not there is never "had already": the 404 page is sent as what it is, whatever is asked.
        const notThere = await ask("nothing/here/");
        assert.equal(notThere.status, 404);
        for (const header of [notThere.etag, "*", `W/${notThere.etag}`]) {
          const again = await ask("nothing/here/", { "if-none-match": header });
          assert.deepEqual([again.status, again.body.equals(notThere.body)], [404, true], `${base}nothing/here/ asked with If-None-Match: ${header}`);
        }

        // ---- Whatever is written, and whenever: files of made-up bytes, many of one length and of one moment.
        let state = 20261113 + base.length;
        const random = (below) => {
          state = (Math.imul(state, 1103515245) + 12345) >>> 0;
          return Math.floor((state / 4294967296) * below);
        };
        const moments = [moment, new Date(moment.getTime() + 1), new Date(moment.getTime() + 1000)];
        const file = join(out, "made-up.bin");
        let held = null;
        let unchanged = 0;
        let changed = 0;
        for (let round = 0; round < 150; round++) {
          // Mostly a file of the length of the one before; sometimes the very same bytes.
          const length = held && random(4) > 0 ? held.bytes.length : 1 + random(48);
          const now = held && random(5) === 0 ? held.bytes : Buffer.from(Array.from({ length }, () => random(4)));
          writeFileSync(`${file}.new`, now);
          const at = moments[random(moments.length)];
          utimesSync(`${file}.new`, at, at);
          renameSync(`${file}.new`, file);
          const method = random(2) ? "GET" : "HEAD";
          const answer = await ask("made-up.bin", held ? { "if-none-match": random(2) ? held.etag : `W/${held.etag}` } : {}, method);
          const same = held !== null && held.bytes.equals(now);
          assert.equal(answer.status, same ? 304 : 200, `${base}, round ${round}: ${same ? "the same bytes are had already" : "other bytes are sent"}, whatever their length and moment`);
          assert.equal(answer.etag, nameOf(now));
          if (!same && method === "GET") assert.ok(answer.body.equals(now), `round ${round}: the bytes that are there now`);
          if (same || method === "HEAD") assert.equal(answer.body.length, 0);
          same ? unchanged++ : changed++;
          held = { bytes: now, etag: answer.etag };
        }
        assert.ok(unchanged > 10 && changed > 60, `${unchanged} times the same bytes, ${changed} times others`);

        // ---- A build puts a new folder in the place of the old one: the pages of the new one are sent.
        const before = await ask("docs/cli/");
        const beside = `${out}.next`;
        cpSync(out, beside, { recursive: true });
        const swapped = Buffer.from(readFileSync(join(out, "docs", "cli", "index.html")));
        swapped[swapped.indexOf("<title>") + 7] ^= 1;
        put(join(beside, "docs", "cli", "index.html"), swapped);
        utimesSync(join(beside, "docs", "cli", "index.html"), statSync(join(out, "docs", "cli", "index.html")).mtime, statSync(join(out, "docs", "cli", "index.html")).mtime);
        renameSync(out, `${out}.old`);
        renameSync(beside, out);
        const after = await ask("docs/cli/", { "if-none-match": before.etag });
        assert.deepEqual([after.status, after.body.equals(swapped), after.etag], [200, true, nameOf(swapped)], `${base}: after the folder was replaced, the page of the new folder is sent`);
        assert.equal((await ask("docs/cli/", { "if-none-match": after.etag })).status, 304);

        // ---- Edits in quick succession, while a browser keeps asking with what it has.
        const one = Buffer.from("one ".repeat(16));
        const two = Buffer.from("two ".repeat(16));
        const quick = join(out, "quick.txt");
        put(quick, one);
        let writing = true;
        const writer = (async () => {
          for (let turn = 0; writing; turn++) {
            put(quick, turn % 2 ? one : two);
            await new Promise((resolve) => setImmediate(resolve));
          }
        })();
        let has = await ask("quick.txt");
        const seen = new Set();
        for (let round = 0; round < 200; round++) {
          const answer = await ask("quick.txt", { "if-none-match": has.etag });
          if (answer.status === 304) {
            assert.equal(answer.etag, has.etag, "told that it has it, the browser has the bytes of that name");
            seen.add("same");
          } else {
            assert.equal(answer.status, 200);
            assert.notEqual(answer.etag, has.etag, "what is sent anew is something else than what the browser had");
            assert.equal(answer.etag, nameOf(answer.body));
            assert.ok(answer.body.equals(one) || answer.body.equals(two), "and it is one of the two files, whole");
            has = answer;
            seen.add("new");
          }
        }
        writing = false;
        await writer;
        assert.deepEqual([...seen].sort(), ["new", "same"], "both happened while the file was being written");
      } finally {
        child.kill("SIGTERM");
        await ended;
        rmSync(`${out}.old`, { recursive: true, force: true });
      }
    }
  });

  it("serve under the root of a host, a project's path and a deeper one, and lead a browser nowhere but into the site", async () => {
    const out = join(folder, "matrix");
    await built(out, "/vigile/");
    writeFileSync(join(folder, "secret.txt"), "not part of the site\n");
    const page = (path) => readFileSync(join(out, path), "utf8");
    /** One request, sent with exactly this path: nothing puts the path right on the way, as a browser or fetch would. */
    const ask = (port, path, method = "GET") =>
      new Promise((resolve, reject) => {
        const sent = request({ host: "127.0.0.1", port, path, method }, (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () => resolve({ status: response.statusCode, location: response.headers.location, type: response.headers["content-type"], length: response.headers["content-length"], body }));
        });
        sent.on("error", reject);
        sent.end();
      });
    // What was given as the base path, and the base path it is served under.
    for (const [given, base] of [["/", "/"], ["/vigile/", "/vigile/"], ["/vigile", "/vigile/"], ["/a/b/c/", "/a/b/c/"], ["/a/b/c", "/a/b/c/"], ["/docs_2.0~x-y/", "/docs_2.0~x-y/"]]) {
      const [port] = await ports(1);
      const child = spawn(process.execPath, [join(here, "serve.mjs"), "--dir", out, "--base", given, "--host", "127.0.0.1", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
      const ended = new Promise((resolve) => child.once("exit", resolve));
      try {
        const said = await new Promise((resolve, reject) => {
          child.stdout.once("data", (chunk) => resolve(String(chunk)));
          child.once("exit", () => reject(new Error(`the server did not start under ${given}`)));
        });
        assert.equal(said, `Serving ${out} at http://127.0.0.1:${port}${base}\n`, `given ${given}, it serves under ${base}`);
        const locations = [];
        const get = async (path, method) => {
          const answer = await ask(port, path, method);
          if (answer.location !== undefined) locations.push([path, answer.location]);
          return answer;
        };
        // The site itself: its first page at the base path, with no way round to it and no way on from it.
        const home = await get(base);
        assert.equal(home.status, 200, `${given}: ${base} is the first page`);
        assert.equal(home.location, undefined, `${given}: the first page leads on to nowhere, itself least of all`);
        assert.equal(home.body, page("index.html"));
        if (base === "/") {
          // At the root there is nothing to lead to the site from: "/" is the site.
          assert.equal((await get("/")).status, 200);
        } else {
          for (const path of ["/", base.slice(0, -1)]) {
            const lead = await get(path);
            assert.equal(lead.status, 302, `${given}: ${path} leads to the site`);
            assert.equal(lead.location, base);
          }
        }
        // A folder without its last slash, a folder, a file, what is not there, and HEAD.
        for (const folder of ["how", "docs/operations/get"]) {
          const moved = await get(`${base}${folder}`);
          assert.equal(moved.status, 301, `${given}: ${base}${folder}`);
          assert.equal(moved.location, `${base}${folder}/`);
          assert.equal((await get(`${base}${folder}/`)).body, page(`${folder}/index.html`));
        }
        const styles = await get(`${base}assets/site.css`);
        assert.equal(styles.status, 200);
        assert.equal(styles.type, "text/css; charset=utf-8");
        const head = await get(`${base}docs/`, "HEAD");
        assert.deepEqual([head.status, head.body, Number(head.length)], [200, "", statSync(join(out, "docs", "index.html")).size]);
        for (const path of [`${base}nothing`, `${base}how/nothing/`, `${base}how/index.html/x`, ...(base === "/" ? [] : ["/elsewhere/", `${base.slice(0, -1)}x/`])]) {
          const missing = await get(path);
          assert.equal(missing.status, 404, `${given}: ${path}`);
          assert.equal(missing.body, page("404.html"), `${given}: ${path} gets the site's 404 page`);
        }
        // Addresses that try to leave the folder, or to have the browser sent to another host: none of them is
        // answered with a file from outside, and none with a way on.
        for (const path of [
          "//evil.example/",
          "//evil.example",
          "///evil.example/",
          `${base}/evil.example/`,
          `${base}/evil.example`,
          `${base}how//`,
          `/%2f%2fevil.example/`,
          `${base}%2f%2fevil.example`,
          `${base}%5cevil.example`,
          `${base}\\evil.example`,
          `/\\evil.example/`,
          `${base}..`,
          `${base}../`,
          `${base}../secret.txt`,
          `${base}how/../../secret.txt`,
          `${base}%2e%2e/secret.txt`,
          `${base}..%2fsecret.txt`,
          `${base}how/..%2f..%2f..%2fsecret.txt`,
          `${base}./how`,
          `${base}how/.`,
          `${base}how/%00`,
          `${base}%`,
          "http://evil.example/",
          `http://evil.example${base}how`,
          `${base}how?next=//evil.example/`,
        ]) {
          const answer = await get(path);
          if (path === `${base}how?next=//evil.example/`) {
            // What follows a question mark is no part of the path: this is the folder without its slash.
            assert.deepEqual([answer.status, answer.location], [301, `${base}how/`], `${given}: ${path}`);
            continue;
          }
          assert.ok(answer.status === 404 || answer.status === 400, `${given}: ${path} is answered with "not there", not with ${answer.status}`);
          assert.equal(answer.location, undefined, `${given}: ${path} sends the browser nowhere`);
          assert.ok(!answer.body.includes("not part of the site"), `${given}: ${path} shows nothing from outside the folder`);
        }
        // Every way on that was given leads into the site: it starts with the base path, with one slash, and has no host in it.
        for (const [path, location] of locations) {
          assert.ok(location.startsWith(base) && !location.startsWith("//") && !location.includes("\\") && !/^[a-z]+:/i.test(location), `${given}: ${path} leads to ${location}`);
          assert.notEqual(location, path, `${given}: ${path} does not lead to itself`);
        }
      } finally {
        child.kill("SIGTERM");
        await ended;
      }
    }
  });

  it("take a base path in one form, and refuse one that is not a plain path, the build and the server alike", () => {
    assert.equal(basePath("/"), "/");
    assert.equal(basePath("/vigile"), "/vigile/");
    assert.equal(basePath("/vigile/"), "/vigile/");
    assert.equal(basePath("/a/b/c"), "/a/b/c/");
    const out = join(folder, "refused");
    for (const base of ["vigile", "vigile/", "", "//evil.example/", "//", "/a//b/", "/a/../b/", "/../", "/a/./b/", "/a b/", "/a?b/", "/a#b/", "/a%2fb/", "\\\\evil.example\\", "/a\\b/", "https://evil.example/", "/<script>/"]) {
      assert.throws(() => basePath(base), /The base path .* (has to start with a slash|is not a plain path)/, `"${base}" is no base path`);
      for (const [script, args] of [["serve.mjs", ["--dir", out, "--base", base, "--port", "1"]], ["build.mjs", ["--out", out, "--base", base]]]) {
        if (base === "") continue;
        const refused = run(script, args);
        assert.equal(refused.status, 1, `${script} --base "${base}" ends with an error`);
        assert.match(refused.stderr, /The base path .* (has to start with a slash|is not a plain path)/);
      }
    }
    assert.ok(!existsSync(out), "nothing was built for a base path that was refused");
    // The address of the site is held to the same: what is not an address, or has no plain path, is refused.
    for (const siteUrl of ["not an address", "ftp://example.org/vigile/", "https://example.org/a//b/"]) {
      const refused = run("build.mjs", ["--out", out, "--site-url", siteUrl]);
      assert.equal(refused.status, 1, `--site-url "${siteUrl}"`);
      assert.match(refused.stderr, /The site was not built: /);
    }
    // At the root of a host, the 404 page's links start at the root.
    const root = run("build.mjs", ["--out", out, "--base", "/"]);
    assert.equal(root.status, 0, root.stderr);
    assert.match(readFileSync(join(out, "404.html"), "utf8"), /<a href="\/docs\/">/);
    assert.deepEqual(checkSite(out, { basePath: "/" }), []);
  });

  it("refuse to serve with options they do not know", () => {
    for (const [args, message] of [[["--port", "none"], /--port needs a port number/], [["--base", "preview"], /The base path "preview" has to start with a slash/], [["--nonsense"], /There is no option --nonsense/], [["--host"], /--host needs a value/]]) {
      const bad = run("serve.mjs", args);
      assert.equal(bad.status, 1, args.join(" "));
      assert.match(bad.stderr, message);
    }
  });
});
