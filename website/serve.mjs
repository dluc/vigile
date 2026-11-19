// Serves a built site for looking at it, under the path it is published at, exactly as GitHub Pages would: a
// folder answers with its index.html, an address that leads nowhere with the site's 404 page, and "/" leads to
// the base path.
//
//   node website/serve.mjs [--dir <folder>] [--base /vigile/] [--host <address>] [--port <port>] [--log]
//
// Without options it serves website/dist under the base path of website/site.mjs, on 127.0.0.1:4173. It binds
// the one address it is given and no other. It serves files and nothing else, follows no path out of the
// folder, and has no dependency. It writes one line when it starts and one when it stops; --log adds one for
// each request. SIGTERM, or Ctrl-C, stops it once the answers under way are sent.
//
// A page is never served stale after a rebuild: every answer is to be checked with the server again, which
// answers "not modified" only when the bytes it would send are the very bytes the browser has. The folder may
// be replaced while this runs, as website/build.mjs does: each request looks at what is there then.

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { basePath } from "./lib/base.mjs";
import { SITE_URL } from "./site.mjs";

const USAGE = "Usage: node website/serve.mjs [--dir <folder>] [--base /vigile/] [--host <address>] [--port <port>] [--log]";
const fail = (message) => {
  console.error(`${message}\n${USAGE}`);
  process.exit(1);
};

const given = { dir: join(dirname(fileURLToPath(import.meta.url)), "dist"), base: new URL(SITE_URL).pathname, host: "127.0.0.1", port: "4173", log: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const [name, inline] = argv[i].split(/=(.*)/s);
  if (name === "--log") given.log = true;
  else if (["--dir", "--base", "--host", "--port"].includes(name)) {
    const value = inline ?? argv[++i];
    if (value === undefined || value === "") fail(`${name} needs a value.`);
    given[name.slice(2)] = value;
  } else fail(`There is no option ${argv[i]}.`);
}
const port = Number(given.port);
if (!/^\d+$/.test(given.port) || port < 1 || port > 65535) fail("--port needs a port number.");
let base;
try {
  base = basePath(given.base);
} catch (error) {
  fail(error.message);
}
const dir = resolve(given.dir);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** Which folder is served at this moment. It is another one once a build has put a new one in its place. */
function folderNow() {
  try {
    return statSync(dir).ino;
  } catch {
    return null;
  }
}

/**
 * The file an address leads to, or null. A folder is its index.html. The place is asked of the file system as
 * it really is, links followed, and has to be inside the folder that is served, as that folder really is.
 */
function fileFor(inside) {
  let root;
  let found;
  try {
    root = realpathSync(dir);
    found = realpathSync(join(root, inside));
    if (statSync(found).isDirectory()) found = realpathSync(join(found, "index.html"));
    if (found !== root && !found.startsWith(root + sep)) return null;
    return statSync(found).isFile() ? found : null;
  } catch {
    return null;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Looks for a file, and takes "it is not there" for an answer only when the folder was there, and the same
 * one, before the look and after it. While a build puts a new folder in the place of the old one, the folder
 * is away for a moment, and a file that was looked for in that moment is looked for again.
 */
async function look(inside) {
  for (let tries = 0; tries < 40; tries++) {
    const before = folderNow();
    const file = before === null ? null : fileFor(inside);
    if (before !== null && before === folderNow()) return file;
    await wait(25);
  }
  return null;
}

/**
 * Whether what a browser says it has is what would be sent: the names in If-None-Match against the name of the
 * bytes. A star stands for anything that is there. A name is taken as it is quoted, with or without the W/ that
 * calls it weak: for "have I got this already" the two count the same. A name that is not quoted names nothing.
 */
function hasItAlready(header, tag) {
  if (typeof header !== "string") return false;
  if (header.trim() === "*") return true;
  const names = header.match(/(?:W\/)?"[^"]*"/g) ?? [];
  return names.some((name) => name.replace(/^W\//, "") === tag);
}

/**
 * The file an address leads to, read: where it is, and its bytes. Null when nothing is there. A file that was
 * found and is gone when it is read was taken away by a build that put a new folder in place: it is looked for
 * again, in the folder that is there now.
 */
async function read(inside) {
  for (let tries = 0; tries < 5; tries++) {
    const file = await look(inside);
    if (!file) return null;
    try {
      return { file, bytes: readFileSync(file) };
    } catch {
      await wait(25);
    }
  }
  return null;
}

/**
 * Sends a file: every answer that has a file in it comes from here, a page, a picture, the 404 page, for GET and
 * for HEAD, under any base path.
 *
 * The file was read whole, once, and what is sent is those bytes. Their name for the browser, the ETag, is made
 * of the bytes themselves and of nothing else, so "you have it already" is said only of the very bytes the
 * browser has: not of a file of the same length written within the same moment, which a name made of the
 * file's size and time would take for the old one. For the same reason no time is given for the file, and a
 * browser's "has it changed since" is not gone by: a time says too little. The files of a site are small, and
 * this serves a preview: reading each one is what being right costs here.
 */
function send(request, response, status, { file, bytes }) {
  const tag = `"${createHash("sha256").update(bytes).digest("base64url")}"`;
  const headers = { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache", etag: tag, "x-content-type-options": "nosniff" };
  // Only a page that is there can be had already: the 404 page is sent each time, as what it is.
  if (status === 200 && hasItAlready(request.headers["if-none-match"], tag)) return void response.writeHead(304, headers).end();
  response.writeHead(status, { ...headers, "content-length": bytes.length });
  response.end(request.method === "HEAD" ? undefined : bytes);
}

function plain(response, status, text, headers = {}) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers }).end(`${text}\n`);
}

async function answer(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") return plain(response, 405, "This server only serves files.", { allow: "GET, HEAD" });
  // The address as it was asked for, up to its question mark. It is not put right: what has two slashes in a
  // row, a backslash, or a step back or on the spot in it is an address of nothing here.
  const asked = (request.url ?? "/").split("?")[0];
  let pathname;
  try {
    pathname = decodeURIComponent(asked);
  } catch {
    return plain(response, 400, "The address is not valid.");
  }
  const plainPath = pathname.startsWith("/") && !pathname.includes("//") && !/[\\\0]/.test(pathname) && !pathname.split("/").some((part) => part === "." || part === "..");
  // Under a base path, "/" and the base path without its last slash lead to the site. At the root there is
  // nowhere to lead on to: "/" is the site.
  if (base !== "/" && (pathname === "/" || `${pathname}/` === base)) return void response.writeHead(302, { location: base, "cache-control": "no-store" }).end();
  const missing = async () => {
    const page = await read("404.html");
    return page ? send(request, response, 404, page) : plain(response, 404, "There is nothing here, and the folder that is served has no 404.html: build the site first.");
  };
  if (!plainPath || !pathname.startsWith(base)) return missing();
  const inside = pathname.slice(base.length);
  const found = await read(inside);
  if (!found) return missing();
  const { file } = found;
  // A folder asked for without its last slash: the browser is sent to the folder, so that the page's relative
  // links hold. Where it is sent is the base path and the path that was asked for, which is a plain one.
  if (inside !== "" && !inside.endsWith("/") && file.endsWith(`${sep}index.html`) && !inside.endsWith("index.html")) {
    return void response.writeHead(301, { location: `${base}${inside}/`, "cache-control": "no-store" }).end();
  }
  send(request, response, 200, found);
}

const server = createServer((request, response) => {
  if (given.log) response.on("finish", () => console.log(`${new Date().toISOString()} ${request.method} ${request.url} ${response.statusCode}`));
  // A file that went away between the look and the answer, with the folder it was in, is looked for again.
  const attempt = (left) =>
    answer(request, response).catch(async () => {
      if (response.headersSent) return void response.destroy();
      if (left === 0) return plain(response, 503, "The site is being rebuilt. Ask again.", { "retry-after": "1" });
      await wait(25);
      return attempt(left - 1);
    });
  void attempt(20);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") fail(`Port ${port} on ${given.host} is already in use.`);
  if (error.code === "EADDRNOTAVAIL" || error.code === "ENOTFOUND") fail(`This machine has no address ${given.host}.`);
  fail(`The server could not start: ${error.message}`);
});

server.listen(port, given.host, () => {
  const host = given.host.includes(":") ? `[${given.host}]` : given.host;
  console.log(`Serving ${dir} at http://${host}:${port}${base}${fileFor("index.html") ? "" : "  (there is no built site in that folder yet: node website/build.mjs)"}`);
});

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    // Answers under way are sent; connections that are only kept open are closed.
    server.close(() => {
      console.log(`Stopped (${signal}).`);
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 2000).unref();
  });
}
