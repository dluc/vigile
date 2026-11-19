// Holds every file of the web site to its two doors to the product: the description the program prints
// (`vigile describe`) and the program itself, run as anyone would run it. No file of the site imports a module
// from outside the site's folder, requires one, or names a path into the product's code or a file of
// TypeScript. Were the product written again in another language, the site would still be built and its tests
// would still run, as long as there is a `vigile` program.
//
// The check reads the code and not the words: a comment or a sentence that mentions a folder of the product
// is not a path to it. What it reads, and how, is in website/lib/reach.mjs.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { outsideReaches, readCode } from "./lib/reach.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * The places outside the site's folder that a file of the site may name, written from the folder the site's
 * folder is in. There are three, and each belongs to one file: the program, which is the one setting of
 * website/lib/program.mjs, and for the tests of the site the README, whose links to the site they check, and
 * the site's own workflow.
 */
const ALLOWED = {
  "lib/program.mjs": ["bin/vigile"],
  "site.test.mjs": ["README.md", ".github/workflows/pages.yml"],
};

/** Every file of code in the site's folder: its build, its parts, its tests and the scripts of its pages. Not what was built. */
function codeFiles(folder = here) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return /^(dist.*|node_modules)$/.test(entry.name) ? [] : codeFiles(path);
    return /\.(mjs|cjs|js)$/.test(entry.name) ? [path] : [];
  });
}

/** The names of the two folders of the product's code, put together here so that this file names no path into them. */
const [code, tools] = [["pack", "ages"].join(""), ["scr", "ipts"].join("")];
/** The ending of a file of TypeScript, put together the same way. */
const typed = [".", "ts"].join("");

describe("the web site keeps to its two doors to the product", () => {
  it("in every file of its code: nothing is imported from outside the site, and no path leads into the product's code", () => {
    const files = codeFiles();
    const names = files.map((file) => relative(here, file));
    for (const name of ["build.mjs", "serve.mjs", "site.mjs", "site.test.mjs", "commands.test.mjs", "browser.test.mjs", "serve.test.mjs", "markdown.test.mjs", "independence.test.mjs", "lib/program.mjs", "lib/facts.mjs", "lib/contract.mjs", "lib/examples.mjs", "lib/terminals.mjs", "lib/browser.mjs", "lib/generate.mjs", "assets/site.js"]) {
      assert.ok(names.includes(name), `${name} is among the files that are read`);
    }
    for (const name of Object.keys(ALLOWED)) assert.ok(names.includes(name), `${name}, which may name a place outside the site, is a file of the site`);
    const wrong = files.flatMap((file) => outsideReaches(readFileSync(file, "utf8"), file, here, ALLOWED[relative(here, file)] ?? []));
    assert.deepEqual(wrong, [], "every file of the site keeps to the site");
    // The one way to the program is the one setting, and it is where the program is found and nowhere else.
    const naming = files.filter((file) => readCode(readFileSync(file, "utf8")).texts.some((text) => /(^|\/)bin\/vigile$/.test(text.text) && text.text.startsWith(".")));
    assert.deepEqual(naming.map((file) => relative(here, file)), ["lib/program.mjs"], "only website/lib/program.mjs says where the program is");
    assert.match(readFileSync(join(here, "lib", "program.mjs"), "utf8"), /process\.env\.VIGILE_BIN/, "and another program can be named in its place");
  });

  it("is found out when a file reaches past them, whichever way it does it", () => {
    const file = join(here, "lib", "made-up.mjs");
    const reaches = (source, allowed = []) => outsideReaches(source, file, here, allowed);
    // Each of these is a way the site once reached into the product, or could.
    const refused = [
      [`import { OPERATIONS } from "../../${code}/core/dist/index.js";`, /imports "\.\.\/\.\.\/\w+\/core\/dist\/index\.js", which is outside the site's folder/],
      [`export { guide } from "../../${code}/core/dist/index.js";`, /is outside the site's folder/],
      [`import "../../${code}/web/public/graph.js";`, /is outside the site's folder/],
      [`const core = await import("../../${code}/core/dist/index.js");`, /is outside the site's folder/],
      ["const built = (path) => import(new URL(`../../" + code + "/${path}`, import.meta.url).href);", /imports something that is worked out when it runs/],
      ["const built = (path) => import(new URL(`../../" + code + "/${path}`, import.meta.url).href);", /names a place from where the file is with a part that is worked out/],
      ["const built = (path) => import(new URL(`../../" + code + "/${path}`, import.meta.url).href);", /names a path into the product's code/],
      [`import { z } from "zod";`, /which is neither a part of Node\.js \(node:…\) nor a file of the site/],
      [`const { z } = createRequire(join(root, "package.json"))("zod");`, /loads a module with require/],
      [`const z = require("zod");`, /loads a module with require/],
      [`const root = fileURLToPath(new URL("../..", import.meta.url));`, /names "\.\.\/\.\.", which is outside the site's folder/],
      [`const lock = readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8");`, /names "\.\.\/\.\.\/pnpm-lock\.yaml", which is outside the site's folder/],
      [`const root = join(here, "..", "..");\nconst scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;`, /made-up\.mjs:1: goes up and out of the site's folder with "\.\."/],
      [`const text = readFileSync(resolve(here, "../../README.md"), "utf8");`, /goes up and out of the site's folder with "\.\.\/\.\.\/README\.md"/],
      [`const text = readFileSync("../../package.json", "utf8");`, /goes up and out of the site's folder/],
      [`const source = readFileSync(join(root, "${code}", "cli", "src", "bin.js"), "utf8");`, /names a path into the product's code: "\w+"/],
      [`const source = readFileSync(join(root, "${code}/core/src/calc.js"), "utf8");`, /names a path into the product's code/],
      [`const shards = readFileSync(join(root, "${tools}", "run-test-shard.mjs"), "utf8");`, /names a path into the product's code/],
      ["const one = readFileSync(`${root}/" + tools + "/${name}`, \"utf8\");", /names a path into the product's code/],
      [`const sources = walk(root).filter((name) => name.endsWith("${typed}") && !name.endsWith(".test${typed}"));`, /names a file of TypeScript: "\.ts"/],
      [`const driver = "cli/src/browser-driver${typed}";`, /names a file of TypeScript/],
      [`const where = new URL(name, import.meta.url);`, /names a place from where the file is with something that is worked out/],
    ];
    for (const [source, says] of refused) {
      const found = reaches(source);
      assert.ok(found.some((line) => says.test(line)), `this is found:\n${source}\n\nIt was said of it:\n${found.join("\n") || "(nothing)"}`);
    }
    // What a file of the site does write, and words that only mention the product, are let be.
    const let_be = [
      `import assert from "node:assert/strict";\nimport { build } from "../build.mjs";\nimport { demoPlan } from "./examples.mjs";`,
      `const plan = new URL("../content/demo-plan.json", import.meta.url);\nconst words = fileURLToPath(new URL("../content/words", import.meta.url));`,
      `// The engine lives in ${code}/core/src, which the site does not read: see ${tools}/run-test-shard.mjs.\nconst one = 1;`,
      `/* import { Engine } from "../../${code}/core/dist/index.js"; */\nconst two = 2;`,
      `const says = "The reference pages are made from the description, not from the packages or the scripts of the repository.";`,
      `const hidden = pattern.test(text) ? /(^|\\/)${code}\\//.test(name) : false;`,
      `const up = depth ? "../".repeat(depth) : "./";\nconst plain = !pathname.split("/").some((part) => part === "." || part === "..");`,
      `const written = { "vision/index.html": ["../#start"], "how/statuses/index.html": ["../../#start"] };\nassert.ok(html.includes('href="../extra.html#start"'));`,
      "const answer = await ask(`${base}../secret.txt`);\nconst other = await ask(`${base}how/../../secret.txt`);",
      `const plain = text.endsWith(".txt") || text.endsWith(".toml") || name === "tsconfig";`,
    ];
    for (const source of let_be) assert.deepEqual(reaches(source), [], `this is let be:\n${source}`);
    // A place outside the site is named only by the file that may name it.
    const program = `const chosen = fileURLToPath(new URL("../../bin/vigile", import.meta.url));`;
    assert.deepEqual(reaches(program, ["bin/vigile"]), []);
    assert.match(reaches(program).join("\n"), /names "\.\.\/\.\.\/bin\/vigile", which is outside the site's folder and none of the places this file may name there/);
    assert.match(reaches(program, ["README.md"]).join("\n"), /none of the places this file may name there \(README\.md\)/);
  });

  it("tells code from words: comments are left out, and a text is read to its end whatever is in it", () => {
    const { code: read, texts } = readCode(
      [
        `// a comment with "a text" and a path/to/nowhere`,
        `const a = "one // not a comment"; /* gone */ const b = 'two \\' still two';`,
        "const c = `three ${d + `four ${\"five\"}`} six`;",
        `const e = /a "pattern" \\/ [/"]+/g.test(f) ? 1 / 2 : g / h;`,
        `const i = "seven";`,
      ].join("\n"),
    );
    assert.deepEqual(texts.map((text) => [text.text, text.line]), [["one // not a comment", 2], ["two ' still two", 2], ["three \u0000 six", 3], ["four \u0000", 3], ["five", 3], ["seven", 5]]);
    assert.doesNotMatch(read, /comment|gone|pattern/, "no comment and no pattern is left in the code");
    assert.match(read, /1 \/ 2 : g \/ h/, "a division is code");
  });
});
