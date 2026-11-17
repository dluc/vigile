import { existsSync, readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The folder that holds the page's files. */
export const webRoot = fileURLToPath(new URL("../public", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * What the browser is told about the page, as a second line of defence should a script ever get into it: the
 * page keeps the API key in the browser's storage. Only the page's own files may run or be loaded, nothing
 * written into the page itself runs, no other site may show the page in a frame (the page itself may, which
 * is how the tests open several of it side by side), and a file is what its type says it is. The worker that
 * lays out the graph is one of the page's own files as well, and is served with the same policy, which then
 * holds inside it: a worker may be started from nowhere else, not even from text the page holds.
 */
export const PROTECTION = {
  "content-security-policy": "default-src 'self'; img-src 'self' data:; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

const require = createRequire(import.meta.url);

/**
 * Libraries the page uses to draw the graph. They are served from this package's own dependencies,
 * so the page works without the internet.
 */
const VENDOR: Record<string, string> = {
  "cytoscape.min.js": "cytoscape/dist/cytoscape.min.js",
  "elk-api.js": "elkjs/lib/elk-api.js",
  "elk-worker.min.js": "elkjs/lib/elk-worker.min.js",
  "cytoscape-elk.js": "cytoscape-elk/dist/cytoscape-elk.js",
};

/**
 * The rules by which a list is read in pages: what a continuation token is, which list it belongs to, and the
 * steps of reading one to its end. They are the engine's own modules, compiled, and are served as they are, so
 * that the page runs the rules the service runs and has none of its own. They use nothing but the language.
 */
const SHARED: Record<string, string> = {
  "paging.js": "@vigile/core/paging.js",
  "ids.js": "@vigile/core/ids.js",
};

function sharedFile(pathname: string): string | null {
  const name = pathname.slice("/shared/".length);
  const target = Object.hasOwn(SHARED, name) ? SHARED[name] : undefined;
  return target ? require.resolve(target) : null;
}

function vendorFile(pathname: string): string | null {
  const name = pathname.slice("/vendor/".length);
  const target = Object.hasOwn(VENDOR, name) ? VENDOR[name] : undefined;
  return target ? require.resolve(target) : null;
}

/**
 * What each of the page's files held when it was last read, and what the file was then: when its content and
 * when anything about it last changed, its size and which file it is. The files are few and small, and are kept whole, so that an answer holds no file open. A
 * file held open for each request stays open for as long as its answer has not gone out, and a client decides
 * how long that is and how many answers wait: the service has only so many files it may hold open. An answer
 * that waits holds no copy either, only the content that all of them share.
 */
const held = new Map<string, { stamp: string; content: Buffer }>();

/** The content of a file as it is on the disk now: read again only when the file is another than it was. */
function contentOf(file: string): Buffer {
  // The time of the last change of anything about the file moves on with every write, also with one that
  // leaves the size as it was and puts the time of the content back, as a copy that keeps the times does.
  const { mtimeMs, ctimeMs, size, ino } = statSync(file);
  const stamp = `${mtimeMs} ${ctimeMs} ${size} ${ino}`;
  const known = held.get(file);
  if (known?.stamp === stamp) return known.content;
  const content = readFileSync(file);
  held.set(file, { stamp, content });
  return content;
}

/**
 * Serves one of the page's files. Returns false when the path is not one of them. `onUnexpected` is told when a
 * file that is there cannot be read, which is the service's own trouble and not the caller's.
 */
export function serveWeb(response: ServerResponse, pathname: string, headOnly = false, onUnexpected?: (error: unknown) => void): boolean {
  let file: string;
  let cache = "no-cache";
  if (pathname.startsWith("/vendor/")) {
    const vendor = vendorFile(pathname);
    if (!vendor) return false;
    file = vendor;
    cache = "public, max-age=86400";
  } else if (pathname.startsWith("/shared/")) {
    const shared = sharedFile(pathname);
    if (!shared) return false;
    file = shared;
  } else {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      // Not a path at all, so not one of the page's files.
      return false;
    }
    const relative = pathname === "/" ? "index.html" : normalize(decoded).replace(/^[/\\]+/, "");
    file = join(webRoot, relative);
    if (!file.startsWith(webRoot + sep) || !existsSync(file) || !statSync(file).isFile()) {
      // A file that is gone is not kept either.
      held.delete(file);
      return false;
    }
  }
  // A file that cannot be read ends this request and nothing else.
  let content: Buffer;
  try {
    content = contentOf(file);
  } catch (error) {
    try {
      onUnexpected?.(error);
    } catch {
      // That it could not be reported does not keep the answer back.
    }
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("The file could not be read.\n");
    return true;
  }
  response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-length": content.length, "cache-control": cache, ...PROTECTION });
  if (headOnly) response.end();
  else response.end(content);
  return true;
}
