import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const shard = process.argv[2];
const { BROWSER_TEST_SHARDS } = await import(pathToFileURL(join(root, "packages/cli/dist/browser-shards.js")));
const browserShards = new Set(Object.keys(BROWSER_TEST_SHARDS));
if (shard !== "non-browser" && !browserShards.has(shard)) {
  console.error(`Unknown test shard: ${shard ?? "(none)"}`);
  process.exit(2);
}

// The workflow is deliberately simple YAML. Keep its matrix in lockstep with the one source of browser shards:
// adding a suite to a new shard without giving that shard a runner must fail every existing shard, not skip tests.
const workflow = readFileSync(join(root, ".github/workflows/tests.yml"), "utf8");
const inWorkflow = new Set([...workflow.matchAll(/^\s+shard:\s+(\S+)\s*$/gm)].map((match) => match[1]));
const expected = new Set(["non-browser", ...browserShards]);
if (inWorkflow.size !== expected.size || [...expected].some((name) => !inWorkflow.has(name))) {
  console.error(`Workflow shards ${JSON.stringify([...inWorkflow].sort())} do not match ${JSON.stringify([...expected].sort())}.`);
  process.exit(2);
}

function testsUnder(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...testsUnder(path));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) found.push(path);
  }
  return found;
}

const all = testsUnder(join(root, "packages")).sort();
const browser = all.filter((path) => relative(root, path).split(sep).join("/") === "packages/cli/dist/browser.test.js");
if (browser.length !== 1) {
  console.error(`Expected one compiled browser test, found ${browser.length}.`);
  process.exit(2);
}
const files = shard === "non-browser" ? all.filter((path) => path !== browser[0]) : browser;
if (!files.length) {
  console.error(`Test shard ${shard} is empty.`);
  process.exit(2);
}
if (browserShards.has(shard)) {
  const { findBrowser } = await import(pathToFileURL(join(root, "packages/cli/dist/browser-driver.js")));
  if (!findBrowser()) {
    console.error(`Test shard ${shard} needs Chromium; refusing to pass by skipping every browser test.`);
    process.exit(2);
  }
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  env: { ...process.env, ...(browserShards.has(shard) ? { VIGILE_TEST_BROWSER_SHARD: shard } : {}) },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
