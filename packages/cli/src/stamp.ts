import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { webRoot } from "@vigile/web";

const PACKAGES = ["@vigile/core", "@vigile/storage", "@vigile/storage-sqlite", "@vigile/config", "@vigile/http-api", "@vigile/mcp", "@vigile/web"];

function newest(directory: string): number {
  let latest = 0;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) latest = Math.max(latest, newest(path));
    else if (/\.(js|html|css)$/.test(entry.name) && !entry.name.endsWith(".test.js")) latest = Math.max(latest, statSync(path).mtimeMs);
  }
  return latest;
}

/**
 * When the code on disk last changed: the newest file among the built packages and the page.
 * A service remembers this from its start, so the doctor can tell when it runs older code than what is installed,
 * which happens when files are updated under a running service.
 */
export function codeStamp(): number {
  const folders = [dirname(fileURLToPath(import.meta.url)), webRoot];
  for (const name of PACKAGES) folders.push(dirname(fileURLToPath(import.meta.resolve(name))));
  return Math.floor(Math.max(...folders.map(newest)));
}
