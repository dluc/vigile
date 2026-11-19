// Holds the web site to the program it describes. The site is built here, into a throwaway folder, and looked
// at as a visitor's browser would find it: a change to an operation, a setting or a command that the site does
// not follow, a link that leads nowhere or a picture that is missing fails these tests.
//
// What the program is and does is asked through the two doors the site has to it, and no other: the
// description it prints of itself (`vigile describe`), and the program run as anyone would run it, as services
// on 127.0.0.1 that are started here and spoken to over their HTTP API. No module of the product is loaded
// and no file of its code is read: see website/lib/program.mjs, and independence.test.mjs, which holds every
// file of the site to that.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "./build.mjs";
import { checkSite, sitemapPaths } from "./lib/check.mjs";
import { INTERNAL, tooLarge } from "./lib/contract.mjs";
import { captionOfChain, chainOf, describedAs, descriptionOfChain, modelOf, namesIn, runScenario, textsOf } from "./lib/diagrams.mjs";
import { demoService, runExample } from "./lib/examples.mjs";
import { readFacts } from "./lib/facts.mjs";
import { generators, operationPage } from "./lib/generate.mjs";
import { markdown } from "./lib/markdown.mjs";
import { describeProgram, hyphens, startService } from "./lib/program.mjs";
import { parseYaml } from "./lib/yaml.mjs";
import { SITE_URL } from "./site.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
/** The folder the site's folder is in: only its name is used, to see that no page tells it. */
const root = dirname(here.replace(/[\\/]$/, ""));
/** The two files outside the site's folder that these tests read: the README, for its links to the site, and the site's own workflow. */
const README = fileURLToPath(new URL("../README.md", import.meta.url));
const WORKFLOW = fileURLToPath(new URL("../.github/workflows/pages.yml", import.meta.url));
const SITE = "https://site.example/vigile/";

const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]));
/** What a page says, without its markup. */
const words = (html) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");
describe("the web site", () => {
  let folder;
  let out;
  let built;
  /** What the program says of itself, as it prints it: the pages are held to this. */
  let described;
  const page = (path) => readFileSync(join(out, path, path.endsWith(".html") ? "" : "index.html"), "utf8");
  /** An option of a command as it is typed. */
  const asTyped = (option) => `--${option.name}${option.value ? ` <${option.value}>` : ""}`;

  before(async () => {
    folder = mkdtempSync(join(tmpdir(), "vigile-site-"));
    out = join(folder, "site");
    described = await describeProgram();
    built = await build({ out, siteUrl: SITE });
  });
  after(() => rmSync(folder, { recursive: true, force: true }));

  it("is built from what the program says of itself and the hand-written pages, in three areas", () => {
    const of = (area) => built.pages.filter((one) => one.area === area && one.path !== "404.html");
    assert.deepEqual(of("product").map((one) => one.path).sort(), ["", "vision/"], "the product is the home page and the vision");
    assert.ok(of("how").length >= 10, "how it works has a page for each idea");
    assert.ok(described.operations.length >= 20, "the description names the operations");
    assert.ok(of("docs").length >= 14 + described.operations.length, "the documentation has its pages and one for each operation");
    for (const one of built.pages) assert.ok(existsSync(join(out, one.path.endsWith(".html") ? one.path : join(one.path, "index.html"))), `${one.path} was written`);
    // Every page says where it is: its area is marked in the header that all pages share.
    for (const [path, area] of [["", "Product"], ["how/statuses/", "How it works"], ["docs/cli/", "Documentation"], ["docs/operations/get/", "Documentation"]]) {
      const marked = [...page(path).matchAll(/<a href="[^"]*" data-area="[a-z]+" aria-current="(?:page|true)">([^<]+)<\/a>/g)].map((match) => match[1]);
      assert.deepEqual(marked, [area], `${path || "the home page"} marks its area, and only that one`);
    }
  });

  it("has no link that leads to a page or an anchor that is not there, and no picture that is missing", () => {
    assert.deepEqual(checkSite(out, { basePath: "/vigile/" }), []);
  });

  it("is found broken when an anchor of the first page is gone, from every page that links to it, at every depth and under every base path", async () => {
    for (const base of ["/", "/vigile/", "/a/b/"]) {
      const copy = join(folder, `anchors${base.replaceAll("/", "-")}`);
      await build({ out: copy, siteUrl: `https://site.example${base}` });
      assert.deepEqual(checkSite(copy, { basePath: base }), [], `under ${base}, the site as it is built has no link that leads nowhere`);
      const home = join(copy, "index.html");
      const whole = readFileSync(home, "utf8");
      // How a link to the first page is written, from the first page itself and from one, two and three folders down, and from the page of what is not there.
      const written = { "index.html": ["#start", "./#start"], "vision/index.html": ["../#start"], "how/statuses/index.html": ["../../#start"], "docs/operations/get/index.html": ["../../../#start"], "404.html": [`${base}#start`] };
      for (const [name, links] of Object.entries(written)) for (const link of links) assert.ok(readFileSync(join(copy, name), "utf8").includes(`href="${link}"`), `under ${base}, ${name} links to the first page as ${link}`);
      // The anchor goes: every page that has the footer says so, each with the link as it wrote it.
      assert.ok(whole.includes(' id="start"'));
      writeFileSync(home, whole.replace(' id="start"', ' id="start-gone"'));
      const problems = checkSite(copy, { basePath: base });
      for (const [name, links] of Object.entries(written)) {
        for (const link of links) {
          const said = link.startsWith("#") ? `${name}: links to ${link}, and the page has no such anchor` : `${name}: links to ${link}, and that page has no anchor "start"`;
          assert.ok(problems.includes(said), `under ${base}: ${said}`);
        }
      }
      const pagesOfSite = walk(copy).filter((file) => file.endsWith(".html")).length;
      assert.equal(new Set(problems.map((problem) => problem.split(": ")[0])).size, pagesOfSite, `under ${base}, every one of the ${pagesOfSite} pages links to that anchor in its footer, and every one is found`);
      assert.ok(problems.every((problem) => /#start/.test(problem)), "and nothing else is said to be wrong");
      // Another anchor of the first page, which only the footer and the first screen link to; and one of another page, for comparison.
      writeFileSync(home, whole.replace(' id="limits"', ' id="limits-gone"'));
      const limits = checkSite(copy, { basePath: base });
      assert.ok(limits.includes('docs/cli/index.html: links to ../../#limits, and that page has no anchor "limits"') && limits.includes('vision/index.html: links to ../#limits, and that page has no anchor "limits"') && limits.includes("index.html: links to #limits, and the page has no such anchor"), `under ${base}, the anchor of the limits`);
      writeFileSync(home, whole);
      assert.deepEqual(checkSite(copy, { basePath: base }), [], "put back, nothing is wrong");
      // A link to a page this check has not read is said, and not passed over.
      const vision = join(copy, "vision", "index.html");
      writeFileSync(vision, readFileSync(vision, "utf8").replace('href="../#start"', 'href="../extra.html#start"'));
      writeFileSync(join(copy, "extra.txt"), "");
      assert.ok(checkSite(copy, { basePath: base }).some((problem) => problem === "vision/index.html: links to ../extra.html#start, and there is nothing there"));
    }
  });

  it("is found broken when a link, an anchor or a picture is taken away", async () => {
    const copy = join(folder, "broken");
    await build({ out: copy, siteUrl: SITE });
    rmSync(join(copy, "docs", "cli"), { recursive: true });
    rmSync(join(copy, "assets", "pictures", "board-light-1520.webp"));
    const file = join(copy, "docs", "errors", "index.html");
    writeFileSync(file, readFileSync(file, "utf8").replace('id="rules"', 'id="rules-gone"'));
    const problems = checkSite(copy, { basePath: "/vigile/" }).join("\n");
    assert.match(problems, /links to [^\n]*docs\/cli\/[^\n]*nothing there/, "a link to a page that is gone");
    assert.match(problems, /board-light-1520\.webp, and there is nothing there/, "a picture that is gone");
    assert.match(problems, /no anchor "rules"/, "a link to an anchor that is gone");
  });

  it("has a page for every operation that says what the program says of it", () => {
    for (const operation of described.operations) {
      const command = operation.command;
      assert.equal(command, hyphens(operation.name), `${operation.name}: its command is its name with hyphens`);
      const html = page(`docs/operations/${command}/`);
      const said = words(html);
      assert.ok(said.includes(operation.description), `${operation.name}: the page carries the operation's description, word for word`);
      assert.ok(said.includes(`POST /api/${command}`) && said.includes(`vigile ${command}`), `${operation.name}: the page names it in each interface`);
      assert.ok(said.includes(operation.kind === "read" ? "Reads. It changes nothing." : "Changes the plan"), `${operation.name}: the page says whether it reads or changes`);
      assert.ok(said.includes(operation.access === "all" ? "Every user." : "Admins only."), `${operation.name}: the page says who may call it`);
      // The table of the input: each field, with whether it is required, as the command line's own options have it.
      const table = html.slice(html.indexOf('<h2 id="input">'), html.indexOf('<h2 id="example">'));
      const rows = [...table.matchAll(/<tr><th scope="row"><code>([a-z_]+)<\/code><\/th>[\s\S]*?<span class="(must|quiet)">(required|optional)<\/span>/g)].map((match) => [match[1], match[3] === "required"]);
      assert.deepEqual(rows, operation.options.map((option) => [option.name.replaceAll("-", "_"), option.required]), `${operation.name}: the fields of the input`);
      assert.deepEqual(rows.map(([name]) => name), Object.keys(operation.input.properties ?? {}), `${operation.name}: and they are the properties of its input`);
      for (const option of operation.options) if (option.description) assert.ok(words(table).includes(option.description), `${operation.name}: the page describes ${option.name} as the program does`);
      // The example is an input the operation takes, and the page shows an answer.
      assert.match(html, /<h2 id="example">/, `${operation.name}: the page has an example`);
    }
    const index = words(page("docs/operations/"));
    for (const operation of described.operations) assert.ok(index.includes(operation.name), `the list of operations names ${operation.name}`);
    assert.equal(readdirSync(join(out, "docs", "operations"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length, described.operations.length, "there is no page for an operation that does not exist");
  });

  it("lists every setting with the default and the environment variable the program gives it", () => {
    const said = words(page("docs/configuration/"));
    assert.ok(described.settings.length >= 8, "the description names the settings");
    for (const setting of described.settings) {
      assert.ok(said.includes(`${setting.key} ${JSON.stringify(setting.default)}`), `${setting.key}: listed with its default, ${JSON.stringify(setting.default)}`);
      assert.ok(said.includes(setting.environment), `${setting.key}: listed with ${setting.environment}`);
      assert.ok(said.includes(`--${setting.key}`), `${setting.key}: listed as an option of serve`);
      assert.ok(said.toLowerCase().includes(setting.description.toLowerCase()), `${setting.key}: described as the program describes it`);
    }
  });

  it("describes every built-in command as it is called, and every option of every command", () => {
    const said = words(page("docs/cli/"));
    assert.ok(described.commands.length >= 10, "the description names the built-in commands");
    for (const builtin of described.commands) {
      assert.ok(said.includes(builtin.usage), `the page shows how it is called: ${builtin.usage}`);
      for (const option of builtin.options) assert.ok(said.includes(asTyped(option)), `${builtin.name}: ${asTyped(option)}`);
    }
    for (const option of described.options.everywhere) assert.ok(said.includes(asTyped(option)), `the option every command takes: ${asTyped(option)}`);
    for (const operation of described.operations) {
      assert.ok(said.includes(`vigile ${operation.command}`), `the command of ${operation.name}`);
      for (const option of operation.options) assert.ok(said.includes(asTyped(option)), `${operation.name}: ${asTyped(option)}`);
    }
  });

  it("names every error code with its HTTP status, every rule and every problem, and the codes of the command line", () => {
    const html = page("docs/errors/");
    for (const { code, http_status: status } of described.errors.codes) {
      assert.match(html, new RegExp(`<code>${code}</code></span></th><td>${status}</td>`), `${code} with status ${status}`);
      assert.match(page("docs/http-api/"), new RegExp(`<code>${code}</code></span></th><td>${status}</td>`), `${code} on the page of the HTTP API`);
    }
    // The rules a change can be refused by, as the program names them.
    const rules = described.errors.rules;
    assert.ok(rules.length >= 20 && rules.includes("unfinished_dependencies"), "the description names the rules");
    const listed = [...html.matchAll(/id="rule-[a-z-]+"><code>([a-z_]+)<\/code>/g)].map((match) => match[1]);
    assert.deepEqual(listed.sort(), [...rules].sort(), "the rules the page lists are the rules the program has");
    const problems = described.problems;
    assert.ok(problems.length >= 5, "the description names the problems");
    for (const where of ["how/problems/", "docs/model/"]) {
      assert.deepEqual([...page(where).matchAll(/id="problem-[a-z-]+"><code>([a-z_]+)<\/code>/g)].map((match) => match[1]).sort(), [...problems].sort(), `${where} lists the problems the program finds`);
    }
    // What the command line calls its own failures.
    const own = described.errors.command_line.codes;
    assert.ok(own.includes("usage") && own.includes("no_answer") && own.includes("config_busy") && own.includes("not_running") && own.includes("not_this_service"), "the description names the codes of the command line");
    for (const code of own) assert.ok(html.includes(`<code>${code}</code>`), `the page names the command line's code ${code}`);
    // And what a command ends with.
    assert.deepEqual(described.errors.command_line.exit_codes, { done: 0, failed: 1, no_answer: 2 }, "the exit codes the page of the command line speaks of");
  });

  it("shows the statuses, the moves between them, the types and the link types as the program has them", () => {
    const TASK_STATUSES = described.tasks.statuses;
    const TASK_MOVES = described.tasks.moves;
    // The table of moves, cell by cell.
    const table = page("docs/model/");
    const matrix = table.slice(table.indexOf('aria-label="Which status a task can move to from each status"'));
    const rows = [...matrix.slice(0, matrix.indexOf("</table>")).matchAll(/<tr><th scope="row"><code>([a-z_]+)<\/code><\/th>(.*?)<\/tr>/g)];
    assert.deepEqual(rows.map((row) => row[1]), [...TASK_STATUSES], "a row for each status");
    for (const row of rows) {
      const cells = [...row[2].matchAll(/<td><span class="(yes|no|quiet)"/g)].map((match) => match[1]);
      const moves = TASK_STATUSES.filter((_, index) => cells[index] === "yes");
      assert.deepEqual(moves, TASK_STATUSES.filter((to) => TASK_MOVES[row[1]].includes(to)), `where a task can go from ${row[1]}`);
    }
    for (const where of ["docs/model/", "how/statuses/"]) {
      const html = page(where);
      // The list of the statuses says where each can move to, in the order the program has them.
      for (const status of TASK_STATUSES) {
        const listed = new RegExp(`id="status-${status.replaceAll("_", "-")}"><code>${status}</code></span></th><td>.*?</td><td>(.*?)</td>`).exec(html);
        assert.ok(listed, `${where}: the status ${status} is listed`);
        assert.deepEqual([...listed[1].matchAll(/<code>([a-z_]+)<\/code>/g)].map((match) => match[1]), [...TASK_MOVES[status]], `${where}: where a task can go from ${status}`);
      }
      // The drawing says the same: each move is one end of a line.
      const heads = (html.match(/class="move" marker-end/g) ?? []).length + (html.match(/marker-start="url\(#move-head\)"/g) ?? []).length;
      assert.equal(heads, Object.values(TASK_MOVES).flat().length, `${where}: the diagram has an arrowhead for each move`);
      for (const status of TASK_STATUSES) assert.match(html, new RegExp(`class="status-name">${status}<`), `${where}: the diagram shows ${status}`);
    }
    const model = words(page("docs/model/"));
    for (const status of described.projects.statuses) assert.ok(model.includes(status), `the status ${status} of a project`);
    for (const type of described.tasks.types) assert.ok(model.includes(type), `the type ${type} of a task`);
    for (const type of described.link_types) assert.ok(model.includes(`${type.type} ${type.reverse} ${type.from.join(" or ")} ${type.to.join(" or ")} ${type.description}`), `the link type "${type.type}", with its reverse name, its ends and what it does`);
    for (const [name, value] of Object.entries(described.limits.plan)) assert.ok(model.includes(`${name} ${value} `), `the limit ${name} is ${value}`);
  });

  it("carries the guide and what an agent is told over MCP, word for word", () => {
    const html = page("docs/guide/");
    const said = words(html);
    assert.ok(described.guide.topics.length >= 4, "the description carries the guide");
    for (const { topic, text } of described.guide.topics) {
      if (topic === "examples") continue;
      // The guide is written as Markdown; the page shows what it says, without the marks.
      const expected = words(markdown(text).html);
      assert.ok(said.includes(expected.trim()), `the topic ${topic} is on the page as the program gives it`);
    }
    for (const example of described.guide.examples) {
      assert.ok(said.includes(example.title) && said.includes(example.when) && said.includes(example.result), `the example "${example.title}"`);
      for (const call of example.calls) assert.ok(said.includes(`${call.operation} ${JSON.stringify(call.input)}`), `the call ${call.operation} of "${example.title}"`);
    }
    const mcp = words(page("docs/mcp/"));
    assert.ok(mcp.includes(described.mcp.instructions.replace(/\s+/g, " ")), "the instructions an agent receives");
    for (const prompt of described.mcp.prompts) assert.ok(mcp.includes(prompt.name) && mcp.includes(prompt.description), `the prompt ${prompt.name}`);
    for (const operation of described.operations) assert.ok(mcp.includes(operation.name), `the tool ${operation.name}`);
    assert.ok(words(page("docs/")).includes(`Vigile ${described.version}`), "the documentation says which version it describes");
  });

  it("stops the build when the program has something the pages do not follow", async () => {
    const code = await readFacts();
    const settings = { SITE_URL: SITE, REPO_URL: "https://example.org/repo" };
    // A rule, a problem, a status and an error code that the pages have no words for.
    assert.throws(() => generators({ ...code, rules: [...code.rules, "brand_new_rule"] }, settings).block.rules("", null), /no words for: brand_new_rule/);
    assert.throws(() => generators({ ...code, problems: [...code.problems, "brand_new_problem"] }, settings).block.problems("", null), /no words for: brand_new_problem/);
    assert.throws(() => generators({ ...code, errorCodes: [...code.errorCodes, { code: "brand_new", status: 418 }] }, settings).block["error-codes"]("", null), /no words for: brand_new/);
    assert.throws(() => generators({ ...code, taskStatuses: [...code.taskStatuses, "frozen"], taskMoves: { ...code.taskMoves, frozen: ["open"] } }, settings).block["task-statuses"]("", null), /no words for: frozen/);
    // A status the diagram has no place for, and a move it has no line for.
    assert.throws(() => generators({ ...code, taskStatuses: [...code.taskStatuses, "frozen"], taskMoves: { ...code.taskMoves, frozen: ["open"] } }, settings).block["statuses-diagram"](), /no place for "frozen"/);
    assert.throws(() => generators({ ...code, taskMoves: { ...code.taskMoves, draft: [...code.taskMoves.draft, "done"] } }, settings).block["statuses-diagram"](), /no line for the move between "draft" and "done"/);
    const fewer = { ...code.taskMoves, draft: code.taskMoves.draft.filter((to) => to !== "cancelled"), cancelled: code.taskMoves.cancelled.filter((to) => to !== "draft") };
    assert.throws(() => generators({ ...code, taskMoves: fewer }, settings).block["statuses-diagram"](), /draws a line for "draft\|cancelled", and the program allows no such move/);
    // Words for a name the program no longer has.
    assert.throws(() => generators({ ...code, rules: code.rules.filter((rule) => rule !== "loop") }, settings).block.rules("", null), /a line for "loop/);
    // An operation that is in no group, and one that has no notes.
    const extra = { ...code.operations[0], name: "brand_new_operation", command: "brand-new-operation" };
    assert.throws(() => generators({ ...code, operations: [...code.operations, extra] }, settings), /brand_new_operation is in no group/);
    await assert.rejects(operationPage(extra, join(here, "content", "docs", "operations", "brand-new-operation.md"), (body) => body), /brand_new_operation has no notes/);
    // What the service does, when it comes to do something else: the sentence that said it stops the build.
    const contract = code.contract;
    const moved = { ...contract, versioned: contract.versioned.filter((name) => name !== "set_task_status"), unversioned: [...contract.unversioned, "set_task_status"] };
    assert.throws(() => generators({ ...code, contract: moved }, settings).block.versions("", null), /no words for: set_task_status/, "an operation that stops taking a version has no words for what a second call does");
    const gained = { ...contract, versioned: [...contract.versioned, "restore"], unversioned: contract.unversioned.filter((name) => name !== "restore") };
    assert.throws(() => generators({ ...code, contract: gained }, settings).block.versions("", null), /a line for "restore/, "an operation that starts taking a version still has words that say it takes none");
    const wider = { ...contract, summaries: { ...contract.summaries, task: { ...contract.summaries.task, always: [...contract.summaries.task.always, "brand_new_field"] } } };
    assert.throws(() => generators({ ...code, contract: wider }, settings).block["answer-fields"]("task", null), /no words for: brand_new_field/);
    const whole = { ...contract, conflict: { ...contract.conflict, update_task: { ...contract.conflict.update_task, category: "detail" } } };
    assert.throws(() => generators({ ...code, contract: whole }, settings).block["conflict-current"](), /A conflict of update_task no longer hands back the item in short/);
    const uneven = { ...contract, createdWith: { ...contract.createdWith, user: true } };
    assert.throws(() => generators({ ...code, contract: uneven }, settings).block["link-history"](), /Whether a user hears of a link in its history is not the same/);
    assert.throws(() => generators(code, settings).block.guards("/nowhere"), /no guard stands before \/nowhere/);
    // How a task gets its ID, what a change does to the version, and when a task is waiting: a fact that changes stops the build at its sentence.
    const renamed = { ...contract, taskIds: contract.taskIds.map((one) => (one.given === "parent" ? { ...one, from: "none" } : one)) };
    assert.throws(() => generators({ ...code, contract: renamed }, settings), /A task created "parent" gets its ID from "none", and the sentence about IDs/);
    assert.throws(() => generators({ ...code, contract: { ...contract, idKeptOnMove: false } }, settings).block["task-ids"](), /A task no longer keeps its ID when it is moved/);
    const lateWaiting = { ...contract, waiting: contract.waiting.map((one) => (one.status === "open" ? { ...one, deleted: { ...one.deleted, waiting: true } } : one)) };
    assert.throws(() => generators({ ...code, contract: lateWaiting }, settings), /What a deleted or a held-back task says of next and waiting is not what/);
    const doneWaits = generators({ ...code, contract: { ...contract, waiting: contract.waiting.map((one) => (one.status === "done" ? { ...one, waiting: true, waitingFor: true } : one)) } }, settings);
    assert.equal(doneWaits.inlineValues["waiting.statuses"], "`draft`, `open`, `in_progress`, `paused`, `in_review` or `done`", "with another status that waits, the sentence names it by itself");
    const getPage = (versions) => operationPage(code.operations.find((operation) => operation.name === "update_task"), join(here, "content", "docs", "operations", "update-task.md"), (body) => body, { ...contract, versions }, code.limits);
    await assert.rejects(getPage({ ...contract.versions, update_task: { change: 2, same: "unchanged" } }), /update_task moves the version by 2, and its page says "one on"/);
    await assert.rejects(getPage({ ...contract.versions, update_task: { change: 1, same: "moved" } }), /What update_task does when it is asked for what is already so is "moved"/);
    // And the sentences follow the facts: with another list in pages, the pages say so by themselves.
    const morePages = generators({ ...code, contract: { ...contract, paged: [...contract.paged, "list_link_types"], wholeLists: [] } }, settings);
    assert.match(words(morePages.block.paged()), /Seven list operations answer in pages of at most 100: list_projects , list_history , list_tasks , list_next_tasks , list_stale_tasks , list_users and list_link_types \./);
    assert.match(words(morePages.block.paged()), /get can page each cut list of one item separately/);
    assert.equal(morePages.inlineValues["ops.paged"], "`list_projects`, `list_history`, `list_tasks`, `list_next_tasks`, `list_stale_tasks`, `get`, `list_users` and `list_link_types`");
    // A built-in command the page of the command line does not describe.
    const made = generators({ ...code, builtins: [...code.builtins, { ...code.builtins[0], name: "brand new" }] }, settings);
    for (const builtin of code.builtins) made.block.command(builtin.name);
    assert.throws(() => made.block["commands-check"](), /does not describe: brand new/);
  });

  it("shows, for every operation, an example that a service answered when the site was built", async () => {
    // The example of each page is run against a real service by the build. Here: what the page shows of it is an
    // answer of that operation, and a call the page says is refused is one the service refuses.
    const code = await readFacts();
    for (const operation of code.operations) {
      const html = page(`docs/operations/${operation.command}/`);
      const answer = /<p class="way-name">The answer<\/p>\s*<pre data-language="json" data-noindex><code>([\s\S]*?)<\/code><\/pre>/.exec(html);
      assert.ok(answer, `${operation.name}: the page shows an answer`);
      assert.doesNotMatch(answer[1], /&quot;error&quot;/, `${operation.name}: the example is not a refusal`);
      const refusal = /<h3 id="a-refusal">[\s\S]*?<pre data-language="json" data-noindex><code>([\s\S]*?)<\/code><\/pre>/.exec(html);
      if (refusal) assert.match(refusal[1], /&quot;error&quot;: \{\s*&quot;code&quot;: &quot;(rule_violation|invalid_input|version_conflict|forbidden|not_found)&quot;/, `${operation.name}: the refused call shows the refusal`);
    }
    // An example the service refuses stops the build, and says which.
    const notes = join(folder, "set-task-status.md");
    writeFileSync(notes, '---\nexample: {"id": "WEB-004", "version": 1, "status": "in_progress"}\n---\n');
    await assert.rejects(operationPage(code.operations.find((one) => one.name === "set_task_status"), notes, (body) => body), /the example was refused by the service: Task WEB-004 cannot be started/);
  });

  it("gives every page a title and a description of its own, and what a shared link shows", () => {
    const titles = new Set();
    for (const one of built.pages) {
      const html = page(one.path);
      const title = /<title>([^<]+)<\/title>/.exec(html)[1];
      assert.ok(!titles.has(title), `the title "${title}" is used once`);
      titles.add(title);
      assert.ok(one.description.length >= 50 && one.description.length <= 320, `${one.path}: a description of a useful length (${one.description.length})`);
      assert.ok(html.includes(`<meta property="og:image" content="${SITE}assets/og.jpg">`), `${one.path}: the picture of a shared link, by its whole address`);
      if (one.path !== "404.html") assert.ok(html.includes(`<link rel="canonical" href="${SITE}${one.path}">`), `${one.path}: its own address`);
      assert.match(html, /<a class="skip" href="#main">/, `${one.path}: a way past the header for the keyboard`);
    }
    assert.ok(existsSync(join(out, "assets", "og.jpg")) && existsSync(join(out, "assets", "favicon.svg")) && existsSync(join(out, "assets", "apple-touch-icon.png")));
    assert.deepEqual(sitemapPaths(out, SITE).sort(), built.pages.filter((one) => one.path !== "404.html").map((one) => one.path).sort(), "the sitemap names every page but the 404 page");
    assert.match(readFileSync(join(out, "robots.txt"), "utf8"), new RegExp(`Sitemap: ${SITE}sitemap.xml`));
  });

  it("says in words what each picture shows, and gives each its sizes for small and large screens", () => {
    let pictures = 0;
    for (const one of built.pages) {
      for (const tag of page(one.path).match(/<img [^>]+>/g) ?? []) {
        pictures++;
        const alt = /alt="([^"]*)"/.exec(tag)?.[1] ?? "";
        assert.ok(alt.length >= 40, `${one.path}: a picture is described in a sentence, not "${alt}"`);
        assert.match(tag, /srcset="[^"]+ \d+w, [^"]+ \d+w/, `${one.path}: a picture comes in more than one size`);
        assert.match(tag, /sizes="[^"]+" width="\d+" height="\d+"/, `${one.path}: a picture says its size`);
        assert.match(tag, /loading="lazy"|fetchpriority="high"/, `${one.path}: a picture is loaded when it is needed`);
        assert.match(tag, /\.webp"/, `${one.path}: a picture is in a modern format`);
      }
    }
    assert.ok(pictures >= 20, "the site shows the real page");
    // Diagrams are drawn into the page, each with a title and a description for who cannot see it.
    for (const where of ["", "how/plan-as-a-graph/", "how/next-and-waiting/", "how/versions-and-history/", "how/problems/", "how/users-and-access/", "how/interfaces/", "how/storage/", "how/one-service/", "how/statuses/"]) {
      assert.match(page(where), /<svg [^>]*role="img" aria-labelledby="[a-z-]+-title [a-z-]+-desc"[^>]*>\s*<title id=/, `${where || "the home page"} has a diagram that says what it shows`);
    }
  });

  it("is found by its own search: every page and every section is in the index", () => {
    const index = JSON.parse(readFileSync(join(out, "search.json"), "utf8"));
    const places = new Set(index.map((entry) => entry[0]));
    for (const one of built.pages) if (one.path !== "404.html") assert.ok(places.has(one.path) || [...places].some((place) => place.startsWith(`${one.path}#`)), `${one.path} can be found`);
    const find = (...asked) => index.filter((entry) => asked.every((word) => `${entry[1]} ${entry[2]} ${entry[3]}`.toLowerCase().includes(word))).map((entry) => entry[0]);
    assert.ok(find("unfinished_dependencies").includes("docs/errors/#rules"), "a rule is found where the rules are listed");
    assert.ok(find("vigile_listen_port").some((place) => place.startsWith("docs/configuration/")), "a setting is found by its environment variable");
    assert.ok(find("restore-backup").some((place) => place.startsWith("docs/cli/")), "a command is found");
    assert.ok(find("set_task_status").includes("docs/operations/set-task-status/"), "an operation is found");
    // Every place the index names is a page, and an anchor of it.
    for (const place of places) {
      const [path, anchor] = place.split("#");
      const html = page(path);
      if (anchor) assert.ok(html.includes(`id="${anchor}"`), `the index leads to ${place}, which is there`);
    }
    assert.ok(statSync(join(out, "search.json")).size < 400_000, "the index stays small");
  });

  it("works under any path: its links are relative, and one setting moves what has to be absolute", async () => {
    for (const one of built.pages) {
      if (one.path === "404.html") continue;
      const absolute = [...page(one.path).matchAll(/\b(?:href|src)="(\/[^"]*)"/g)].map((match) => match[1]);
      assert.deepEqual(absolute, [], `${one.path} has no link that starts at the root of a host`);
    }
    // The 404 page is served at any depth, so its links start at the base path. Another base path moves them.
    assert.match(page("404.html"), /<a href="\/vigile\/docs\/">/);
    const moved = join(folder, "moved");
    const other = await build({ out: moved, siteUrl: SITE, base: "/somewhere/else" });
    assert.equal(other.siteUrl, "https://site.example/somewhere/else/");
    assert.match(readFileSync(join(moved, "404.html"), "utf8"), /<a href="\/somewhere\/else\/docs\/">/);
    assert.match(readFileSync(join(moved, "sitemap.xml"), "utf8"), /<loc>https:\/\/site\.example\/somewhere\/else\/how\/<\/loc>/);
    assert.deepEqual(checkSite(moved, { basePath: "/somewhere/else/" }), []);
    // Apart from the 404 page and the absolute addresses, the two are the same site.
    assert.equal(readFileSync(join(moved, "how", "statuses", "index.html"), "utf8").replaceAll("/somewhere/else/", "/vigile/"), page("how/statuses/"));
  });

  it("is put in place whole: a build that fails leaves the site that was there, and nothing half-made beside it", async () => {
    const before = page("");
    await assert.rejects(build({ out, siteUrl: SITE, base: "no-slash" }), /has to start with a slash/);
    assert.equal(page(""), before, "the site is as it was");
    await build({ out, siteUrl: SITE });
    assert.deepEqual(readdirSync(folder).filter((name) => /\.(building|old)-/.test(name)), [], "nothing is left beside the built folder");
    assert.equal(page(""), before, "building twice gives the same site");
  });

  it("says nothing of the machine it was built on, and shows no real key", () => {
    const told = [homedir(), root, tmpdir() === "/tmp" ? null : tmpdir(), hostname().length > 3 ? hostname() : null].filter(Boolean);
    const user = userInfo().username;
    for (const file of walk(out)) {
      if (!/\.(html|json|xml|txt|js|css|svg)$/.test(file)) continue;
      const text = readFileSync(file, "utf8");
      for (const word of told) assert.ok(!text.includes(word), `${file} names ${word}`);
      if (user.length > 3 && user !== "root" && user !== "runner") assert.doesNotMatch(text, new RegExp(`\\b${user}\\b`), `${file} names the account ${user}`);
      assert.doesNotMatch(text, /vig_[A-Za-z0-9_-]{16,}/, `${file} shows what looks like a real API key`);
    }
  });

  it("lets nothing run or load that is not its own", () => {
    for (const one of built.pages) {
      const html = page(one.path);
      assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'self';/, `${one.path}: says so to the browser`);
      const outside = [...html.matchAll(/<(?:script|link|img|source|iframe)\b[^>]*\b(?:src|href)="(https?:[^"]+)"/g)].map((match) => match[1]).filter((address) => !address.startsWith(SITE));
      assert.deepEqual(outside, [], `${one.path} loads nothing from elsewhere`);
    }
    assert.doesNotMatch(readFileSync(join(out, "assets", "site.css"), "utf8"), /@import|url\(\s*["']?https?:/, "the styles load nothing from elsewhere");
  });

  it("finds where the words of a search stand in a text, all at once and in the text as it is", () => {
    // The script the pages load, by itself: it needs no page.
    const scope = {};
    runInNewContext(readFileSync(join(out, "assets", "marks.js"), "utf8"), { globalThis: scope, window: undefined });
    const { pieces, ranges } = scope.vigileMarks;
    const marked = (text, words) => pieces(text, words).map((piece) => (piece.marked ? `[${piece.text}]` : piece.text)).join("");
    assert.equal(marked("To create a task, call create_task.", ["create", "a", "task"]), "To [create] [a] [task], c[a]ll [create]_[task].");
    assert.equal(marked("To create a task, call create_task.", ["task", "a", "create"]), "To [create] [a] [task], c[a]ll [create]_[task].", "the order of the words does not matter");
    // A word that is a piece of the name of a tag marks the text, and there is no tag for it to get into.
    assert.equal(marked("mark the remark", ["m", "a", "r", "k"]), "[mark] the [r]e[mark]");
    assert.equal(marked("a span of class marks", ["mark", "span", "class", "a"]), "[a] [span] of [class] [mark]s");
    // Words that overlap or touch are one stretch.
    assert.equal(marked("create a task", ["creat", "eate", "e a", " task"]), "[create a task]");
    assert.equal(marked("aaaa", ["aa", "a"]), "[aaaa]");
    assert.deepEqual(JSON.parse(JSON.stringify(ranges("abcabc", ["bc", "cab"]))), [[1, 6]]);
    // A word found again inside its own match is found whole: "ana" stands twice in "banana".
    assert.deepEqual(JSON.parse(JSON.stringify(ranges("banana", ["ana"]))), [[1, 6]]);
    assert.equal(marked("aaa b", ["aa"]), "[aaa] b");
    assert.equal(marked("😀😀😀 x", ["😀😀"]), "[😀😀😀] x");
    // Case is not regarded, in any script; what is found is shown as it is written.
    assert.equal(marked("Set_Task_Status SET task", ["set", "TASK"]), "[Set]_[Task]_Status [SET] [task]");
    assert.equal(marked("Ünïcödé, İstanbul, ΑΒΓ, 日本語, 😀😀", ["ünïcödé", "İSTANBUL", "αβγ", "本", "😀"]), "[Ünïcödé], [İstanbul], [ΑΒΓ], 日[本]語, [😀😀]");
    // Signs that mean something in a pattern or in markup are found as the signs they are.
    assert.equal(marked("a.b* (x) [group] $1 ^ \\ a|b {2} x?y +z /p", [".", "*", "(", ")", "[", "]", "$1", "^", "\\", "|", "{2}", "?", "+", "/"]), "a[.]b[*] [(]x[)] [[]group[]] [$1] [^] [\\] a[|]b [{2}] x[?]y [+]z [/]p");
    assert.equal(marked("no dot here", [".", ".*", "[a-z]+", "\\w"]), "no dot here", "a pattern is not a pattern here");
    assert.equal(marked('<script>alert("x")</script> & <mark>', ["<", ">", "script", "&", '"', "mark", "/"]), '[<script>]alert(["]x["])[</script>] [&] [<mark>]');
    // What cannot be a word finds nothing, and nothing goes round for ever.
    assert.equal(marked("text", ["", null, undefined, 7, "\ud83d"]), "text");
    assert.deepEqual(JSON.parse(JSON.stringify(pieces("", ["a"]))), []);
    // Whatever the text and the words: the pieces put together again are the text, sign for sign, in order,
    // marked and unmarked taking turns, and a piece is marked exactly where one of the words stands.
    const signs = ["a", "b", "A", "ab", " ", "<", ">", "&", '"', "'", "/", "mark", "<mark>", "</mark>", ".", "*", "(", "[", "\\", "$", "é", "İ", "ß", "日", "😀", "\n"];
    let state = 7;
    const random = (below) => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return Math.floor((state / 4294967296) * below);
    };
    const some = (most) => Array.from({ length: random(most + 1) }, () => signs[random(signs.length)]).join("");
    for (let round = 0; round < 3000; round++) {
      const text = some(30);
      const words = Array.from({ length: random(5) }, () => some(3));
      // A list of this test's own: the one the script made is of the script's world.
      const made = Array.from(pieces(text, words));
      assert.equal(made.map((piece) => piece.text).join(""), text, `the pieces of ${JSON.stringify(text)} for ${JSON.stringify(words)} are the text`);
      assert.ok(made.every((piece) => piece.text.length > 0) && made.every((piece, index) => index === 0 || piece.marked !== made[index - 1].marked), "no piece is empty, and marked and unmarked take turns");
      // Held against a search that knows nothing of patterns, for words whose small and capital letters are as long as each other.
      const plain = words.filter((word) => word !== "" && !/[İß]/.test(word));
      if (plain.length !== words.filter((word) => word !== "").length || /[İß]/.test(text)) continue;
      const expected = new Array(text.length).fill(false);
      const low = text.toLowerCase();
      for (const word of plain) for (let at = low.indexOf(word.toLowerCase()); at >= 0; at = low.indexOf(word.toLowerCase(), at + 1)) expected.fill(true, at, at + word.length);
      const actual = made.flatMap((piece) => new Array(piece.text.length).fill(piece.marked));
      assert.deepEqual(actual, expected, `what is marked in ${JSON.stringify(text)} for ${JSON.stringify(words)}`);
    }
    // The page never writes a result as markup: the one script that shows results builds nodes.
    const script = readFileSync(join(out, "assets", "site.js"), "utf8");
    assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, "site.js makes no markup out of text");
  });

  it("writes what it is given into its pages as text, whatever is in it", async () => {
    // The address of the code is written into every page. One that would end its attribute and start a script does neither.
    const hostile = join(folder, "hostile");
    await build({ out: hostile, siteUrl: SITE, repoUrl: 'https://example.org/code"><script>alert(1)</script><a href="' });
    for (const name of ["index.html", "docs/install/index.html", "404.html"]) {
      const html = readFileSync(join(hostile, name), "utf8");
      assert.doesNotMatch(html, /<script>alert|"><script|<a href=""/, `${name}: the address did not become markup`);
      assert.match(html, /href="https:\/\/example\.org\/code%22%3E%3Cscript%3Ealert\(1\)%3C\/script%3E%3Ca%20href=%22"/, `${name}: it is the address, written as an address`);
    }
    assert.deepEqual(checkSite(hostile, { basePath: "/vigile/" }), []);
    for (const repoUrl of ["javascript:alert(1)", "not an address", "http://example.org/code", "//example.org/code"]) {
      await assert.rejects(build({ out: hostile, siteUrl: SITE, repoUrl }), /The address of the code, .* (is not an address|has to start with https)/, `the code is not at "${repoUrl}"`);
    }
    // The diagrams are put into the pages as they are drawn: nothing in them runs, loads or styles by itself.
    for (const file of readdirSync(join(here, "diagrams")).filter((name) => name.endsWith(".svg"))) {
      const svg = readFileSync(join(here, "diagrams", file), "utf8");
      assert.doesNotMatch(svg, /<script|<foreignObject|<iframe|<image|<use\b|\son[a-z]+=|\sstyle=|(xlink:)?href=|url\((?!#)/i, `${file} is a drawing and nothing else`);
      assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+" font-size="13" role="img" aria-labelledby="[a-z-]+-title [a-z-]+-desc">\n<title id=/, `${file} says what it shows`);
    }
    // Every link of every page leads into the site, to an anchor, or to another site over https; none does anything else.
    for (const one of built.pages) {
      for (const [, href] of page(one.path).matchAll(/<a\b[^>]*\shref="([^"]*)"/g)) {
        assert.match(href, /^(#[\w-]*|https:\/\/[^\s]+|(\.\.?\/)[^:]*|[a-z0-9-]+\/[^:]*|\/vigile\/[^:]*)$/, `${one.path}: the link to ${href}`);
      }
    }
    // What the program says of itself is shown as text, signs and all: the options with their <placeholders>.
    assert.match(page("docs/cli/"), /<code>--type &lt;agent\|person&gt;<\/code>/);
    assert.match(page("docs/operations/create-task/"), /&quot;task&quot; \| &quot;bug&quot;/);
  });

  it("is whole without its scripts: the pages of an area, the content and the blocks of code are in the page as it is written", () => {
    for (const one of built.pages) {
      const html = page(one.path);
      // What a script would take out or put in, taken out: the page as a browser without scripts has it.
      const plain = html.replace(/<script\b[^>]*><\/script>/g, "");
      assert.doesNotMatch(plain, /<script/, `${one.path}: every script is a file of its own, which a browser may leave out`);
      // The list of the area's pages is open as written, and holds every page of the area as a plain link.
      if (one.area !== "product" && one.path !== "404.html") {
        assert.match(plain, /<details class="side-fold" open>/, `${one.path}: the list of pages is open without a script`);
        const side = plain.slice(plain.indexOf('<nav class="side"'), plain.indexOf("</nav>", plain.indexOf('<nav class="side"')));
        const listed = [...side.matchAll(/<a href="([^"]+)"/g)].length;
        const expected = built.pages.filter((other) => other.area === one.area && other.path !== "404.html" && (!other.path.startsWith("docs/operations/") || other.path === "docs/operations/" || one.path.startsWith("docs/operations/"))).length;
        assert.equal(listed, expected, `${one.path}: every page of its area is in the list`);
        assert.match(side, /<script src="[^"]*assets\/fold\.js"><\/script>|<\/details>$/, `${one.path}: the script that folds the list stands right after it`);
      }
      // Nothing is hidden for a script to show, but the two things that are of no use without one.
      const hidden = [...plain.matchAll(/<([a-z]+)\b[^>]*\shidden(?:="")?[\s>][^>]*>|<([a-z]+)\b[^>]*\shidden>/g)].map((match) => match[0]);
      assert.ok(hidden.every((tag) => tag.includes("data-scheme-switch")), `${one.path}: only the switch between light and dark waits for a script: ${hidden.join(" ")}`);
      assert.doesNotMatch(plain, /<[a-z]+\b[^>]*\s(inert|aria-hidden="true")[^>]*>\s*<(main|nav|article)/, `${one.path}: no part of the page is taken away from those who cannot see it`);
      // The place of the search is a link to the contents of the documentation, which is a page with every page on it.
      assert.match(plain, /<a class="tool search-open" href="[^"]*docs\/#contents" data-search aria-label="Search, or the contents of the documentation">.*<span class="tool-word without-script">Contents<\/span>/, `${one.path}: without a script, the search leads to the contents`);
      // Code can be read and selected: it is text in the page, and nothing has to be pressed to see it.
      for (const block of plain.match(/<pre\b[^>]*>/g) ?? []) assert.doesNotMatch(block, /hidden|aria-hidden/, `${one.path}: a block of code is there to be read`);
      assert.doesNotMatch(plain, /<noscript>/, `${one.path}: nothing has to be said to a browser without scripts, because nothing is missing`);
    }
    const contents = page("docs/");
    for (const one of built.pages.filter((other) => other.area === "docs" && !other.path.startsWith("docs/operations/") && other.path !== "docs/")) assert.ok(contents.includes(`href="../${one.path}"`), `the contents of the documentation lead to ${one.path}`);
    // The styles show nothing only where a script has run, and hide nothing until one has.
    const css = readFileSync(join(out, "assets", "site.css"), "utf8");
    const needsScript = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter(([, selector, rules]) => /display:\s*none/.test(rules) && /(^|[\s,>])(:root|html)?:not\(\.js\)/.test(selector));
    assert.deepEqual(needsScript.map((rule) => rule[1].trim()), [], "no rule hides something for want of a script");
    assert.doesNotMatch(css, /\.side-fold:not\(\.ready\)/, "the list of pages does not wait for a script to be shown");
    assert.match(css, /\.when-script \{ display: none; \}\s*\.js \.when-script \{ display: revert; \}\s*\.js \.without-script \{ display: none; \}/);
    // The script that folds the list does so only on a small screen, and touches nothing else.
    const fold = readFileSync(join(out, "assets", "fold.js"), "utf8");
    assert.match(fold, /matchMedia\("\(max-width: 820px\)"\)/);
    assert.match(fold, /fold\.open = !small\.matches;/);
  });

  it("says of an exit code of 1 only what is true of it: a failure was reported, and the error says what was changed", () => {
    const cli = words(page("docs/cli/"));
    // The words that are safe to act on, exactly.
    assert.ok(cli.includes("1 The command reports a failure. Read the error before trying again: it says what happened, and what to do."), "what an exit code of 1 means");
    assert.ok(cli.includes("An exit code of 1 does not by itself say that nothing was changed."), "and what it does not mean");
    assert.ok(cli.includes("It does not send a change again only because the exit code was 1."), "and what a script does with it");
    assert.ok(cli.includes("Not known. Look at the item with vigile get <id> --history before sending the change again"), "what to do when the outcome is not known");
    // What the page once said, and what no page may say: that a failure means nothing was changed.
    for (const one of built.pages) {
      const said = words(page(one.path));
      assert.doesNotMatch(said, /nothing was changed by it/i, `${one.path} does not say that a command that failed changed nothing`);
      // A sentence that speaks of the exit code 1 and of nothing having been changed says that the one does not tell the other.
      for (const sentence of said.split(/(?<=[.!?])\s+/)) {
        if (/\b(ends with 1|exit code (of )?1|exits? with 1)\b/i.test(sentence) && /\bnothing (was|is|has been) (changed|stored|written)\b/i.test(sentence)) assert.match(sentence, /does not/, `${one.path}: an exit code of 1 is not said to mean that nothing happened: ${sentence}`);
      }
      assert.doesNotMatch(said, /\b(just|simply) (run|send|call|try) (it|the command|the change) again\b/i, `${one.path} does not tell anyone to simply try again`);
    }
    // The codes after which nothing was changed are named, in the table that is made from what a service that refused with each left behind, and `internal` is not among them.
    const named = /<th scope="row">((?:<code>[a-z_]+<\/code>(?:, )?)+)<\/th><td>Nothing\. The call was refused before anything was stored\./.exec(page("docs/cli/"));
    assert.ok(named, "the page names the codes after which nothing was changed");
    assert.deepEqual([...named[1].matchAll(/<code>([a-z_]+)<\/code>/g)].map((match) => match[1]).sort(), described.errors.codes.map((one) => one.code).filter((code) => !["internal", "too_many_requests", "unauthorized"].includes(code)).sort(), "the codes an operation refuses with before it stores; unauthorized has its own row");
    // The same is said where an error is read by a program, and where an operation can end that way.
    assert.ok(words(page("docs/errors/")).includes("Do not take it to mean that nothing was changed."), "errors: internal");
    assert.ok(words(page("docs/http-api/")).includes("An error does not always mean that nothing was changed."), "the HTTP API");
    assert.ok(words(page("docs/operations/")).includes("A refusal means nothing was changed, with one exception."), "the operations");
    for (const [operation, says] of [["create-user", "the user is there and cannot connect yet. Do not create it again"], ["reset-user-key", "the key the user had still works"], ["delete", "the user is deleted, and the key lets nobody in while it is"], ["restore", "the user is back"]]) {
      assert.ok(words(page(`docs/operations/${operation}/`)).includes(says), `${operation}: what stands after "internal"`);
    }
    // What a service itself says when a later step fails after a change was stored is seen in commands.test.mjs,
    // on a service whose config file cannot be written.
    // After no answer at all: look, wait, and only then decide.
    const trouble = words(page("docs/troubleshooting/"));
    assert.ok(trouble.includes("So do not send it again straight away."));
    assert.ok(trouble.includes("Only then decide whether to send it again"));
  });

  describe("what it says the service does", () => {
    // Each of these asks a real service, here, what it does, and holds the pages to the answer. The service is
    // started through the program for each of them, holds the made-up plan, and is spoken to over its HTTP API.
    // The facts the pages are made from (website/lib/contract.mjs) are held to the same answers, worked out a
    // second time.
    let service;
    let contract;
    const call = (operation, input, as = "agent1") => service.call(operation, input, as);
    const refusal = (operation, input, as = "agent1") => service.refusal(operation, input, as);
    /** The cells of the rows of the table that has this label, as words. */
    const rowsOf = (html, label) => {
      const table = new RegExp(`aria-label="${label}"><table>.*?<tbody>(.*?)</tbody>`, "s").exec(html);
      assert.ok(table, `the table "${label}" is on the page`);
      return [...table[1].matchAll(/<tr>(.*?)<\/tr>/gs)].map((row) => [...row[1].matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/gs)].map((cell) => words(cell[1]).replace(/ ([,.:;])/g, "$1").trim()));
    };
    const fact = (html, name) => words(new RegExp(`<dt>${name}</dt><dd>(.*?)</dd>`, "s").exec(html)?.[1] ?? "").replace(/ ([,.:;])/g, "$1").trim();
    /** The operations, the limits and the statuses, as the program describes them. */
    let OPERATIONS;
    let LIMITS;
    let TASK_STATUSES;
    let TASK_MOVES;
    let LINK_TYPES;
    const toHyphens = hyphens;
    /** Whether the input of an operation has a field: asked of its JSON Schema. */
    const takes = (name, field) => Object.hasOwn(OPERATIONS.find((operation) => operation.name === name).input.properties ?? {}, field);
    /** What a page says, as it reads: no space is left before a sign where markup stood. */
    const said = (path) => words(page(path)).replace(/ ([,.:;])/g, "$1");

    before(() => {
      OPERATIONS = described.operations;
      LIMITS = described.limits.plan;
      TASK_STATUSES = described.tasks.statuses;
      TASK_MOVES = described.tasks.moves;
      LINK_TYPES = described.link_types;
      contract = built.facts.contract;
    });
    // Each of them starts with the made-up plan as it is, in a service of its own.
    beforeEach(async () => {
      service = await demoService();
    });
    afterEach(() => service?.stop());

    it("of a version: only the operations whose input has one are said to take it, each on its own page and in one table", async () => {
      const writes = OPERATIONS.filter((operation) => operation.kind === "write").map((operation) => operation.name);
      const versioned = OPERATIONS.filter((operation) => takes(operation.name, "version")).map((operation) => operation.name);
      const unversioned = writes.filter((name) => !versioned.includes(name));
      assert.deepEqual(versioned, ["set_project_status", "update_task", "set_task_status", "delete", "override_timestamp"], "the operations that take a version, on this branch");
      assert.deepEqual(unversioned, ["create_project", "create_task", "restore", "add_link", "remove_link", "create_user", "reset_user_key"]);
      assert.deepEqual([contract.versioned, contract.unversioned], [versioned, unversioned], "the facts the pages are made from say the same");
      assert.ok(said("docs/mcp/").includes(`${versioned.slice(0, -1).join(", ")} and ${versioned.at(-1)} take the version you last read.`), "what an agent is told over MCP names the operations that take a version");
      assert.ok(said("docs/guide/").includes(`${unversioned.slice(0, -1).join(", ")} and ${unversioned.at(-1)} take no version`), "the guide names the changes that take none");
      // The service itself: an operation that takes none does not know the field; one that takes it refuses a wrong one with a conflict.
      for (const name of unversioned) {
        const refused = await refusal(name, { version: 1 }, "admin");
        assert.equal(refused?.code, "invalid_input", `${name} does not take a version`);
        assert.match(refused.message, /version/);
      }
      // Each operation's page.
      for (const operation of OPERATIONS) {
        const html = page(`docs/operations/${toHyphens(operation.name)}/`);
        const says = fact(html, "Version");
        if (operation.kind === "read") assert.equal(says, "", `${operation.name} reads: its page says nothing of a version`);
        else if (versioned.includes(operation.name)) assert.ok(says.startsWith("Takes the version the caller last read, and is refused with version_conflict when the item has changed since."), operation.name);
        else assert.ok(says.startsWith("Takes no version: it is carried out on the plan as it is at that moment."), operation.name);
        // What the page's own words say agrees: "version_conflict" is an error of the operations that take a version, and of no other.
        const errors = html.slice(html.indexOf('id="errors"'));
        assert.equal(/version_conflict/.test(words(errors)), versioned.includes(operation.name), `${operation.name}: version_conflict is among its errors exactly when it takes a version`);
      }
      // The one table that says it of every operation that changes something.
      const rows = rowsOf(page("docs/operations/"), "Which operations take a version");
      assert.deepEqual(rows.map((row) => [row[0], row[1]]), [...versioned.map((name) => [name, "yes"]), ...unversioned.map((name) => [name, "no"])]);
      // What the table says a second call does, for the ones that take no version: seen here.
      const again = Object.fromEntries(rows.map((row) => [row[0], row[2]]));
      await call("create_project", { title: "Twice", prefix: "TWICE" });
      assert.equal((await refusal("create_project", { title: "Twice", prefix: "TWICE" })).rule, "prefix_taken");
      assert.match(again.create_project, /the second is then refused with prefix_taken/);
      const first = await call("create_task", { title: "Twice", description: "Sent twice." });
      const second = await call("create_task", { title: "Twice", description: "Sent twice." });
      assert.notEqual(first.id, second.id);
      assert.match(again.create_task, /Sent twice, it makes two tasks/);
      assert.deepEqual([(await call("add_link", { from: first.id, type: "depends on", to: second.id })).created, (await call("add_link", { from: first.id, type: "depends on", to: second.id })).created], [true, false]);
      assert.match(again.add_link, /left as it is, and the answer says created: false/);
      await call("remove_link", { from: first.id, type: "depends on", to: second.id });
      assert.equal((await refusal("remove_link", { from: first.id, type: "depends on", to: second.id })).code, "not_found");
      assert.match(again.remove_link, /A link that is no longer there is not_found/);
      await call("delete", { id: second.id, version: second.version });
      assert.equal((await refusal("update_task", { id: second.id, version: second.version + 1, priority: 3 })).rule, "deleted", "a deleted item cannot be changed");
      await call("restore", { id: second.id });
      assert.equal((await refusal("restore", { id: second.id })).rule, "not_deleted");
      assert.match(again.restore, /A deleted item cannot be changed.*the second is refused with not_deleted/);
      await call("create_user", { username: "twice", type: "agent" }, "admin");
      assert.equal((await refusal("create_user", { username: "twice", type: "agent" }, "admin")).rule, "username_taken");
      assert.match(again.create_user, /refused with username_taken/);
      const keys = [(await call("reset_user_key", { user: "twice" }, "admin")).api_key, (await call("reset_user_key", { user: "twice" }, "admin")).api_key];
      assert.notEqual(keys[0], keys[1]);
      assert.match(again.reset_user_key, /Each reset that is carried out replaces the key/);
      // Where a sentence names them, it names exactly them.
      const how = said("how/versions-and-history/");
      assert.ok(how.includes(`Those are ${versioned.slice(0, -1).join(", ")} and ${versioned.at(-1)}:`), "the page about versions names the operations that take one");
      assert.ok(how.includes(`take no version: ${unversioned.slice(0, -1).join(", ")} and ${unversioned.at(-1)}.`), "and the ones that take none");
      // What the pages once said of every change is said nowhere.
      // Also not where the product's own words are shown: the guide and what an agent is told over MCP.
      for (const one of built.pages) {
        const text = said(one.path);
        assert.doesNotMatch(text, /Every change (to an item )?(names|needs|carries) (a|the) version|A change names (a|the) version/, `${one.path} does not say that every change names a version`);
        assert.doesNotMatch(text, /What all of them share/, one.path);
      }
    });

    it("of pages: only the lists that take a continuation token are said to answer in pages", async () => {
      const paged = OPERATIONS.filter((operation) => takes(operation.name, "continuation")).map((operation) => operation.name);
      const whole = OPERATIONS.filter((operation) => operation.name.startsWith("list_") && !paged.includes(operation.name)).map((operation) => operation.name);
      assert.deepEqual([paged, whole], [["list_projects", "list_history", "list_tasks", "list_next_tasks", "list_stale_tasks", "get", "list_users"], ["list_link_types"]], "the lists that answer in pages, and those that do not, on this branch");
      assert.deepEqual([contract.paged, contract.wholeLists], [paged, whole]);
      // The service itself, on a plan with more of everything than a page holds.
      for (let n = 0; n <= LIMITS.page; n++) {
        await call("create_task", { title: `One of many, ${n}`, description: "Made to fill a page." });
        await call("create_project", { title: `One of many, ${n}` });
        await call("create_user", { username: `many${n}`, type: "agent" }, "admin");
      }
      for (const [name, field] of [["list_tasks", "tasks"], ["list_next_tasks", "tasks"], ["list_projects", "projects"], ["list_users", "users"], ["list_history", "changes"]]) {
        const answer = await call(name, {});
        assert.equal(answer[field].length, LIMITS.page, `${name} answers with a page of ${LIMITS.page}`);
        assert.equal(typeof answer.continuation, "string", `${name}: and a token for the next`);
        assert.ok((await call(name, { continuation: answer.continuation }))[field].length > 0);
      }
      for (const name of whole) assert.equal((await refusal(name, { continuation: "x" }))?.code, "invalid_input", `${name} takes no continuation token`);
      // Each operation's page.
      for (const operation of OPERATIONS) {
        const html = page(`docs/operations/${toHyphens(operation.name)}/`);
        const says = fact(html, "Pages");
        if (paged.includes(operation.name)) assert.equal(says, `Answers in pages of at most ${LIMITS.page}, with a continuation token for the next.`, operation.name);
        else if (whole.includes(operation.name)) assert.equal(says, "Answers with the whole list at once. It takes no continuation token.", operation.name);
        else assert.equal(says, "", operation.name);
        assert.equal(/continuation/.test(words(html.replace(/<dl class="facts">.*?<\/dl>/s, ""))), paged.includes(operation.name), `${operation.name}: its page speaks of a continuation token exactly when it takes one`);
      }
      // The two places that say it of all paged reads name them from the contract.
      const sentence = `Six list operations answer in pages of at most ${LIMITS.page}: list_projects, list_history, list_tasks, list_next_tasks, list_stale_tasks and list_users. When there is more, the answer carries a top-level continuation token: send it back unchanged, with the same operation and filters, for the next page. list_link_types answer with the whole list at once, and take no token.`;
      assert.ok(said("docs/http-api/").includes(sentence), "the HTTP API");
      assert.ok(said("docs/operations/").includes(sentence), "the operations");
      const getPages = "get can page each cut list of one item separately. more.links[<type>], more.timeline or more.history carries that list's total and continuation token. Send the token back to get with the same item ID. Link pages continue forward by ID; timeline and history pages continue to older entries. Combine item pages only while their unchanged_since values match. If one differs, read the item again from the first page.";
      assert.ok(said("docs/http-api/").includes(getPages), "the HTTP API distinguishes get pagination");
      assert.ok(said("docs/operations/").includes(getPages), "the operations distinguish get pagination");
      for (const one of built.pages) {
        const text = said(one.path);
        assert.doesNotMatch(text, /Lists come in pages|A list returns at most|Items in one answer of a list/, `${one.path} does not say of all lists that they answer in pages`);
      }
    });

    it("of an answer: what a list, a conflict and a full reading carry, field by field", async () => {
      const tasks = (await call("list_tasks", {})).tasks;
      const task = tasks.find((one) => one.status === "open" && !one.progress);
      // A conflict hands back what the list says of the item, and not what get says.
      const full = await call("get", { id: task.id });
      for (const [name, input] of [["update_task", { priority: 5 }], ["set_task_status", { status: "in_progress" }], ["delete", {}], ["override_timestamp", { name: "created_at", value: "2026-01-01T00:00:00Z" }]]) {
        const refused = await refusal(name, { id: task.id, version: task.version + 7, ...input });
        assert.equal(refused.code, "version_conflict", name);
        assert.deepEqual(refused.current, task, `${name}: a conflict hands back the task as a list has it`);
        for (const field of ["description", "why", "links", "timeline", "history", "created_at", "created_by", "updated_at"]) assert.ok(!Object.hasOwn(refused.current, field) && (field === "history" || Object.hasOwn(full, field)), `${name}: ${field} is not under current, and get has it`);
      }
      const project = (await call("list_projects", {})).projects[0];
      assert.deepEqual((await refusal("set_project_status", { id: project.id, version: project.version + 7, status: "ready" })).current, project);
      assert.deepEqual(Object.keys(contract.conflict).sort(), [...contract.versioned].sort(), "the facts have a conflict of every operation that takes a version");
      // The fields the pages name are the fields there are.
      const sometimes = { task: ["live_containers", "completed_at", "progress", "problems", "deleted_at"], project: ["problems", "deleted_at"], user: ["deleted_at"] };
      const always = { task: Object.keys(task), project: Object.keys(project).filter((field) => field !== "problems"), user: Object.keys((await call("list_users", {})).users[0]) };
      for (const kind of ["task", "project", "user"]) {
        assert.deepEqual(contract.summaries[kind].always, always[kind], `what is sent of a ${kind} every time`);
        assert.deepEqual([...contract.summaries[kind].sometimes].sort(), [...sometimes[kind]].sort(), `what is sent of a ${kind} only sometimes`);
      }
      for (const html of [page("docs/http-api/")]) {
        assert.deepEqual(rowsOf(html, "What a conflict hands back under current"), ["task", "project", "user"].map((kind) => [`a ${kind}`, always[kind].join(", "), contract.summaries[kind].sometimes.join(", ")]));
      }
      const http = said("docs/http-api/");
      assert.ok(http.includes("Under current is the item as it is now, in short: what a list says of it, which is less than get says."), "the HTTP API says that current is the item in short");
      assert.ok(http.includes("It does not have description, why, links, timeline, created_at, created_by, updated_at or unchanged_since, nor the history. Call get for those."));
      assert.deepEqual(rowsOf(page("docs/operations/"), "What an answer about a task carries").map((row) => [row[0], row[1]]), [...always.task.map((field) => [field, "always"]), ...contract.summaries.task.sometimes.map((field) => [field, "sometimes"])]);
      // What a full reading adds.
      const adds = { task: Object.keys(full).filter((field) => !Object.hasOwn(task, field)), project: Object.keys(await call("get", { id: project.id, kind: "project" })).filter((field) => !Object.hasOwn(project, field)), user: Object.keys(await call("get", { id: "agent1", kind: "user" })).filter((field) => !always.user.includes(field)) };
      assert.deepEqual(adds, { task: ["description", "why", "links", "timeline", "created_at", "created_by", "updated_at", "unchanged_since"], project: ["description", "links", "timeline", "created_at", "created_by", "updated_at", "unchanged_since"], user: ["links", "created_at", "created_by", "updated_at", "unchanged_since"] });
      assert.deepEqual(contract.detailAdds, adds);
      for (const path of ["docs/operations/", "docs/operations/get/"]) assert.deepEqual(rowsOf(page(path), "What a full reading adds to the short form"), Object.entries(adds).map(([kind, fields]) => [`a ${kind}`, fields.join(", ")]), path);
      // No page says any more that a conflict hands back the whole item.
      for (const one of built.pages) assert.doesNotMatch(said(one.path), /the item as it is now, whole|holds the current item\./, `${one.path} does not say that a conflict hands back the whole item`);
      for (const path of ["docs/errors/", "how/versions-and-history/", "docs/operations/set-task-status/", "docs/operations/update-task/", "docs/operations/set-project-status/"]) assert.match(said(path), /as it is now, in short/, `${path}: the item of a conflict is the item in short`);
      // The words that are worked out are in an answer in short every time, and the progress of a group only for a group.
      assert.ok(["is_next", "is_waiting", "waiting_for", "has_problems"].every((field) => always.task.includes(field)) && sometimes.task.includes("progress"));
      assert.ok(said("how/next-and-waiting/").includes("In an answer with a task in short or in full: is_next, is_waiting and waiting_for, and for a group progress."));
      assert.ok(said("how/problems/").includes("A task or a project that an operation answers with, in short or in full, carries has_problems"));
    });

    it("of a linked item: a task and a project come with their status, a user has none", async () => {
      const tasks = (await call("list_tasks", {})).tasks;
      const busy = tasks.find((one) => one.assigned_to.length && one.depends_on.length && one.contained_in.length > 1);
      const seen = { project: new Set(), task: new Set(), user: new Set() };
      const count = { project: 0, task: 0, user: 0 };
      for (const item of [await call("get", { id: busy.id }), await call("get", { id: busy.assigned_to[0], kind: "user" }), await call("get", { id: busy.contained_in[0], kind: "project" })]) {
        for (const linked of Object.values(item.links).flat()) {
          count[linked.kind]++;
          for (const field of Object.keys(linked)) seen[linked.kind].add(field);
          assert.equal(Object.hasOwn(linked, "status"), linked.kind !== "user", `a linked ${linked.kind} ${linked.kind === "user" ? "has no status" : "comes with its status"}`);
        }
      }
      assert.ok(count.project > 0 && count.task > 3 && count.user > 0, "linked items of every kind were seen");
      assert.deepEqual({ project: [...seen.project], task: [...seen.task], user: [...seen.user] }, { project: ["kind", "id", "title", "status"], task: ["kind", "id", "title", "status"], user: ["kind", "id", "title"] });
      for (const kind of ["project", "task", "user"]) assert.deepEqual([contract.linked[kind].always, contract.linked[kind].sometimes], [[...seen[kind]], ["deleted"]], `the facts about a linked ${kind}`);
      const html = page("docs/operations/get/");
      assert.deepEqual(rowsOf(html, "What a full reading says of a linked item"), [["a project", "kind, id, title, status", "deleted: true"], ["a task", "kind, id, title, status", "deleted: true"], ["a user", "kind, id, title", "deleted: true"]]);
      assert.ok(said("docs/operations/get/").includes("A linked project or task comes with its status. A linked user has none: its title is the username."));
      assert.doesNotMatch(said("docs/operations/get/"), /Each linked item comes with its kind, id, title and status/, "the page no longer says that every linked item has a status");
    });

    it("of the history of a link: a project and a task record it, a user does not", async () => {
      // Every type of link, between every two kinds it joins, added and removed: what each end's history gained.
      const matrix = [];
      let made = 0;
      const fresh = {
        task: async () => (await call("create_task", { title: `An end, ${++made}`, description: "Made to be linked." })).id,
        project: async () => `project:${(await call("create_project", { title: `An end, ${++made}` })).id}`,
        user: async () => (await call("create_user", { username: `end${++made}`, type: "agent" }, "admin")).user.username,
      };
      const look = async (id, kind) => {
        const item = await call("get", { id: id.replace(/^project:/, ""), kind, history: true });
        return { version: item.version, links: item.history.filter((entry) => entry.action.startsWith("link_")).map((entry) => entry.action) };
      };
      for (const type of LINK_TYPES) {
        for (const from of type.from) {
          for (const to of type.to) {
            const ends = { from: await fresh[from](), to: await fresh[to]() };
            const before = { from: await look(ends.from, from), to: await look(ends.to, to) };
            await call("add_link", { from: ends.from, type: type.type, to: ends.to });
            await call("remove_link", { from: ends.from, type: type.type, to: ends.to });
            const after = { from: await look(ends.from, from), to: await look(ends.to, to) };
            const records = (end) => {
              assert.ok(after[end].links.length === before[end].links.length || after[end].links.slice(before[end].links.length).join() === "link_added,link_removed", `${type.type}, ${end}: both or neither`);
              return after[end].links.length > before[end].links.length;
            };
            matrix.push({ type: type.type, from, to, history: { from: records("from"), to: records("to") }, version: { from: after.from.version === before.from.version + 2, to: after.to.version === before.to.version + 2 } });
            assert.ok([0, 2].includes(after.from.version - before.from.version) && [0, 2].includes(after.to.version - before.to.version));
          }
        }
      }
      assert.deepEqual(matrix, [
        { type: "contains", from: "project", to: "task", history: { from: true, to: true }, version: { from: false, to: true } },
        { type: "contains", from: "task", to: "task", history: { from: true, to: true }, version: { from: false, to: true } },
        { type: "depends on", from: "task", to: "task", history: { from: true, to: true }, version: { from: true, to: false } },
        { type: "depends on", from: "task", to: "project", history: { from: true, to: true }, version: { from: true, to: false } },
        { type: "assigned to", from: "task", to: "user", history: { from: true, to: false }, version: { from: true, to: false } },
      ]);
      assert.deepEqual(contract.linkHistory, matrix, "the facts the pages are made from say the same");
      for (const row of matrix) for (const end of ["from", "to"]) assert.equal(row.history[end], row[end] !== "user", `a ${row[end]} at the ${end} end of "${row.type}" ${row[end] === "user" ? "records nothing" : "records the link"}`);
      assert.deepEqual([contract.leftBehind, contract.createdWith], [{ project: true, task: true, user: false }, { project: true, task: true, user: false }]);
      // The table of add_link, row by row.
      assert.deepEqual(rowsOf(page("docs/operations/add-link/"), "Which end of a link records it, and whose version moves"), [
        ["contains", "project", "task", "the project and the task", "the task"],
        ["contains", "task", "task", "the task that contains and the task that is contained", "the task that is contained"],
        ["depends on", "task", "task", "the task that depends and the task that is depended on", "the task that depends"],
        ["depends on", "task", "project", "the task and the project", "the task"],
        ["assigned to", "task", "user", "the task", "the task"],
      ]);
      // The four pages that speak of it.
      assert.ok(said("docs/operations/add-link/").includes("An end that is a project or task records the new link in its history. A user keeps no history of the tasks it is given: an assignment is in the history of the task, and only there."));
      assert.ok(said("docs/operations/add-link/").includes("a project or task at the other end records it in its history, a user does not."));
      assert.ok(said("docs/operations/remove-link/").includes("An end that is a project or task records in its history that the link is gone. A user does not: that a task was taken from a user is in the history of the task, and only there."));
      assert.ok(said("docs/operations/delete/").includes("A project or task that was linked to it records in its own history that the link is gone; a user does not."));
      assert.ok(said("how/versions-and-history/").includes("Links added and removed, in the history of each end that is a project or task. A user keeps no history of the tasks it is given"));
      for (const one of built.pages) assert.doesNotMatch(said(one.path), /Both ends record|at both ends|What was linked to it records/i, `${one.path} does not say that both ends of every link record it`);
    });

    it("of a task's ID: it is given at creation from the project or the parent, and a move does not change it", async () => {
      const prefixed = (await call("create_project", { title: "Prefixed", prefix: "IDS" })).id;
      const other = (await call("create_project", { title: "Other", prefix: "OTHER" })).id;
      const numbered = `project:${(await call("create_project", { title: "Numbered" })).id}`;
      const make = async (input) => (await call("create_task", { title: "A task", description: "Made for its ID.", ...input })).id;
      const parent = await make({ project: other });
      const bareParent = `task:${await make({})}`;
      const seen = {
        project: await make({ project: prefixed }),
        "project-and-parent": await make({ project: prefixed, parent }),
        parent: await make({ parent }),
        "numbered-project-and-parent": await make({ project: numbered, parent }),
        "numbered-project": await make({ project: numbered }),
        "numbered-parent": await make({ parent: bareParent }),
        nothing: await make({}),
      };
      const shape = (id) => (/^IDS-\d{3,}$/.test(id) ? "project" : /^OTHER-\d{3,}$/.test(id) ? "parent" : /^\d{3,}$/.test(id) ? "none" : id);
      const from = Object.fromEntries(Object.entries(seen).map(([given, id]) => [given, shape(id)]));
      assert.deepEqual(from, { project: "project", "project-and-parent": "project", parent: "parent", "numbered-project-and-parent": "parent", "numbered-project": "none", "numbered-parent": "none", nothing: "none" }, "where the prefix of a task's ID comes from, on this branch");
      assert.deepEqual(Object.fromEntries(contract.taskIds.map((one) => [one.given, one.from])), from, "the facts the pages are made from say the same");
      // Moved later: into another project and out of its own, into a group, out of everything. The ID stays.
      const moved = seen.project;
      await call("add_link", { from: other, type: "contains", to: moved });
      await call("remove_link", { from: prefixed, type: "contains", to: moved });
      assert.deepEqual([(await call("get", { id: moved })).id, (await call("get", { id: moved })).contained_in], [moved, [other]], "a task that was moved into another project keeps the ID it was created with");
      await call("add_link", { from: parent, type: "contains", to: moved });
      await call("remove_link", { from: other, type: "contains", to: moved });
      assert.equal((await call("get", { id: moved })).id, moved);
      const loose = seen.nothing;
      await call("add_link", { from: prefixed, type: "contains", to: `task:${loose}` });
      assert.deepEqual([(await call("get", { id: `task:${loose}` })).id, (await call("get", { id: `task:${loose}` })).contained_in], [loose, [prefixed]], "and a task that was created in nothing keeps its number alone when it is put into a project");
      assert.equal(contract.idKeptOnMove, true);
      // The pages: the table, row by row, and the sentence that says the rule in passing.
      const model = page("docs/model/");
      assert.deepEqual(rowsOf(model, "How a task gets its ID"), [
        ["In a project that has a prefix", "The project's prefix and a number"],
        ["In a project that has a prefix, under a parent whose ID has another prefix", "The project's prefix and a number"],
        ["Under a parent whose ID has a prefix, with no project given", "The prefix of the parent's ID and a number"],
        ["In a project whose ID is a number, under a parent whose ID has a prefix", "The prefix of the parent's ID and a number"],
        ["In a project whose ID is a number", "A number alone"],
        ["Under a parent whose ID is a number alone", "A number alone"],
        ["In no project and under no parent", "A number alone"],
      ]);
      const rule = "The prefix of the project it is created in, when that project has one; otherwise the prefix of its parent's ID, when that has one; otherwise none. Then a number";
      assert.ok(said("docs/model/").includes("The ID is given once, when the task is created. Putting the task into another project or group afterwards, or taking it out of the one it was created in, does not change it."));
      assert.ok(said("docs/model/").includes(rule) && said("docs/operations/create-task/").includes(`The task gets its ID now, and keeps it when it is moved. ${rule}`));
      assert.ok(said("how/plan-as-a-graph/").includes("WEB-012 for a task created in it, which keeps that ID when it is moved"));
      for (const one of built.pages) assert.doesNotMatch(said(one.path), /The task's ID takes the prefix of the project, or of the parent's ID when no project is given|The prefix of its project and a number\. In no project|WEB-012 for a task in it/, `${one.path} does not say that a task's ID follows the project it is in`);
      // How a project is written in a task's links: by its prefix, or with its kind when its ID is a number.
      assert.deepEqual((await call("get", { id: `task:${seen["numbered-project"]}` })).contained_in, [numbered]);
      assert.ok(rowsOf(page("docs/operations/"), "What an answer about a task carries").some((row) => row[0] === "contained_in" && row[2].includes("A project whose ID is a number is written with its kind, as project:001")));
      // The order of the lists, as the pages say it.
      const ids = (await call("list_tasks", {})).tasks.map((task) => task.id);
      const bare = ids.filter((id) => /^\d+$/.test(id));
      assert.deepEqual(ids, [...bare.sort(), ...ids.filter((id) => !/^\d+$/.test(id)).sort()], "tasks: the bare numbers first, then by prefix and number");
      assert.ok(bare.length >= 2 && ids.indexOf(bare.at(-1)) < ids.indexOf("APP-015"));
      assert.ok(said("docs/operations/list-tasks/").includes("The order is by ID: tasks whose ID is a number alone first, then by prefix in alphabetical order, and by number within a prefix."));
      const projects = (await call("list_projects", {})).projects.map((project) => project.id);
      assert.deepEqual(projects, [...projects.filter((id) => !/^\d+$/.test(id)).sort(), ...projects.filter((id) => /^\d+$/.test(id)).sort()], "projects: the prefixes first, then the numbers");
      assert.ok(said("docs/operations/list-projects/").includes("The order is by ID: prefixes in alphabetical order, then the numbered projects."));
    });

    it("of the version after a change: one on, and as it was when the call asks for what is already so", async () => {
      const task = await call("create_task", { title: "Versions", description: "Made to count versions.", priority: 2 });
      const id = `task:${task.id}`;
      assert.equal(task.version, 1);
      const linked = await call("create_task", { title: "Versions, with links", description: "Made with links.", depends_on: [id], assigned_to: ["agent2"], project: "WEB" });
      assert.equal(linked.version, 1, "a task that is created with links starts at version 1 as well");
      // update_task: a change is one on; the same values again are no change, and the answer has no description.
      const updated = await call("update_task", { id, version: 1, description: "Other words.", why: "A reason." });
      assert.equal(updated.version, 2);
      assert.ok(!Object.hasOwn(updated, "description") && !Object.hasOwn(updated, "why"), "the answer of update_task is the task in short: the description and the reason that were changed are not in it");
      const read = await call("get", { id });
      assert.deepEqual([read.description, read.why], ["Other words.", "A reason."], "get has them");
      assert.equal((await call("update_task", { id, version: 2, description: "Other words.", why: "A reason.", priority: 2 })).version, 2, "the same values again leave the version as it is");
      // set_task_status: one on, also when starting assigns the task; the same status is refused.
      const started = await call("set_task_status", { id, version: 2, status: "in_progress" });
      assert.deepEqual([started.version, started.assigned_to], [3, ["agent1"]]);
      assert.equal((await refusal("set_task_status", { id, version: 3, status: "in_progress" })).rule, "same_status");
      const done = await call("set_task_status", { id, version: 3, status: "done" });
      // override_timestamp: the date the task has, in either way of writing it, changes nothing; another date is one on.
      const completed = (await call("get", { id })).completed_at;
      const lines = async () => (await call("get", { id, history: true })).history.length;
      const before = await lines();
      for (const value of [completed, completed.replace(/Z$/, "+00:00"), completed.replace(/Z$/, "-00:00")]) {
        assert.equal((await call("override_timestamp", { id, version: done.version, name: "completed_at", value })).version, done.version, `the date it has, written ${value}, leaves the version as it is`);
      }
      assert.equal(await lines(), before, "and writes no line in the history");
      // The task was made a moment ago, and cannot have been completed before it was created: its creation is set
      // back by a day first, which is a change like any other, and then its completion by a minute.
      const created = await call("override_timestamp", { id, version: done.version, name: "created_at", value: new Date(Date.parse(completed) - 86_400_000).toISOString() });
      assert.equal(created.version, done.version + 1, "another date of creation is one version on");
      const earlier = await call("override_timestamp", { id, version: created.version, name: "completed_at", value: new Date(Date.parse(completed) - 60_000).toISOString() });
      assert.equal(earlier.version, created.version + 1, "another date of completion is one version on");
      assert.equal(await lines(), before + 2);
      // delete, restore, and a project's status.
      await call("delete", { id, version: earlier.version });
      assert.equal((await refusal("delete", { id, version: earlier.version + 1 })).rule, "already_deleted");
      assert.equal((await call("restore", { id })).version, earlier.version + 2, "deleting is one version on, and restoring one more");
      const project = await call("create_project", { title: "Versions" });
      assert.equal(project.version, 1);
      assert.equal((await call("set_project_status", { id: project.id, version: 1, status: "ready" })).version, 2);
      assert.equal((await refusal("set_project_status", { id: project.id, version: 2, status: "ready" })).rule, "same_status");
      assert.deepEqual(contract.versions, {
        update_task: { change: 1, same: "unchanged" },
        set_task_status: { change: 1, same: "refused:same_status" },
        override_timestamp: { change: 1, same: "unchanged" },
        delete: { change: 1, same: "refused:already_deleted" },
        restore: { change: 1 },
        set_project_status: { change: 1, same: "refused:same_status" },
        create_task: { starts: 1, startsWithLinks: 1 },
        create_project: { starts: 1 },
      });
      // Each page's row, made from that.
      const takes = "Takes the version the caller last read, and is refused with version_conflict when the item has changed since. A change moves the version one on.";
      const rows = {
        update_task: `${takes} A call that asks for what is already so changes nothing, and leaves the version as it is.`,
        override_timestamp: `${takes} A call that asks for what is already so changes nothing, and leaves the version as it is.`,
        set_task_status: `${takes} A call that asks for what is already so is refused with same_status.`,
        set_project_status: `${takes} A call that asks for what is already so is refused with same_status.`,
        delete: `${takes} A call that asks for what is already so is refused with already_deleted.`,
        restore: "Takes no version: it is carried out on the plan as it is at that moment. The item it brings back is one version on.",
        create_task: "Takes no version: it is carried out on the plan as it is at that moment. What it creates starts at version 1.",
        create_project: "Takes no version: it is carried out on the plan as it is at that moment. What it creates starts at version 1.",
      };
      for (const [name, row] of Object.entries(rows)) assert.equal(fact(page(`docs/operations/${toHyphens(name)}/`), "Version"), row, name);
      // What the pages' own words say of a version agrees with it, on every operation's page.
      for (const operation of OPERATIONS) {
        const text = said(`docs/operations/${toHyphens(operation.name)}/`);
        const own = text.slice(text.indexOf("What it answers"));
        if (/version,? one higher|a version one higher/.test(own)) assert.equal(contract.versions[operation.name]?.change, 1, `${operation.name}: its page says the version is one higher`);
        if (/version \(1\)/.test(own)) assert.equal(contract.versions[operation.name]?.starts, 1, `${operation.name}: its page says the version is 1`);
        if (contract.versions[operation.name]?.same === "unchanged") assert.doesNotMatch(own.split("Rules")[0], /one higher/, `${operation.name} can leave the version as it is: what it answers is not said to be one higher`);
      }
      assert.ok(said("docs/operations/override-timestamp/").includes("A date that names the moment the item already has, in whatever zone it is written, changes nothing: no new version, and no line in the history."));
      assert.ok(said("docs/operations/update-task/").includes("A short form has no description and no why: when one of those was changed, read it back with get."));
    });

    it("of what each operation answers with: the sort of answer on its page is the sort the service gives", async () => {
      const sorts = {
        create_project: ["summary", "project"], set_project_status: ["summary", "project"], list_projects: ["list", "project"],
        create_task: ["summary", "task"], update_task: ["summary", "task"], set_task_status: ["summary", "task"], list_tasks: ["list", "task"], list_next_tasks: ["list", "task"], list_stale_tasks: ["claims"],
        get: ["detail", "task"], list_history: ["changes"], delete: ["deleted"], restore: ["summary", "task"], override_timestamp: ["summary", "task"],
        add_link: ["link"], remove_link: ["link"], list_link_types: ["link-types"], create_user: ["key"], list_users: ["list", "user"], reset_user_key: ["key"], get_guide: ["guide"],
      };
      assert.deepEqual(Object.keys(sorts).sort(), OPERATIONS.map((operation) => operation.name).sort(), "every operation is here");
      const lacks = { task: "description, why, links, timeline, created_at, created_by, updated_at and unchanged_since", project: "description, links, timeline, created_at, created_by, updated_at and unchanged_since", user: "links, created_at, created_by, updated_at and unchanged_since" };
      for (const example of built.examples) {
        const [category, kind] = sorts[example.operation];
        // What a service answered to the example when the site was built: the answer the page shows, before it was cut for the page.
        const ran = await runExample({ operation: example.operation, as: example.as, input: example.input, before: example.before, changes: OPERATIONS.find((operation) => operation.name === example.operation).kind !== "read" });
        assert.ok(ran.ok, `${example.operation}: the example was answered`);
        const answer = ran.answer;
        const items = category === "list" ? answer[`${kind}s`] : category === "summary" || category === "detail" ? [answer] : [];
        assert.deepEqual([example.answers.category, example.answers.kind], [category, kind], `${example.operation}: the sort of its answer`);
        for (const item of items) {
          assert.equal(item.kind, kind, example.operation);
          assert.equal(Object.hasOwn(item, "links"), category === "detail", `${example.operation}: ${category === "detail" ? "the item in full has its links" : "an item in short has no links"}`);
          if (category !== "detail") for (const field of contract.detailAdds[kind]) assert.ok(!Object.hasOwn(item, field), `${example.operation}: an item in short has no ${field}`);
        }
        const row = fact(page(`docs/operations/${toHyphens(example.operation)}/`), "Answers with");
        if (category === "summary" || category === "list") assert.ok(row.endsWith(`Not in it: ${lacks[kind]}. get has those.`), `${example.operation}: its page says what an item in short does not have: ${row}`);
        else assert.doesNotMatch(row, /Not in it/, example.operation);
        if (category === "summary") assert.ok(row.startsWith(`The ${kind} in short.`), `${example.operation}: ${row}`);
        if (category === "detail") assert.equal(row, "The task in full.");
        if (category === "deleted") assert.equal(row, "That it was deleted, whether for good, and the kind and ID of the item.");
      }
      // What list_users says of the caller, and that a token of one caller's list is not another's.
      assert.equal((await call("list_users", {})).you, "agent1");
      for (let n = 0; n <= LIMITS.page; n++) await call("create_task", { title: `One of many, ${n}`, description: "Made to fill a page." });
      const token = (await call("list_next_tasks", {})).continuation;
      assert.equal((await refusal("list_next_tasks", { continuation: token }, "agent2")).code, "invalid_input", "a token of one user's list is refused for another user");
    });

    it("of next and waiting: a task is waiting only while it is unfinished and not deleted", async () => {
      const unfinished = `task:${(await call("create_task", { title: "Unfinished", description: "Stays open." })).id}`;
      const route = (to) => {
        const queue = [["open"]];
        for (const path of queue) {
          if (path.at(-1) === to) return path.slice(1);
          for (const step of TASK_MOVES[path.at(-1)]) if (!path.includes(step)) queue.push([...path, step]);
        }
        return assert.fail(`no way from open to ${to}`);
      };
      const seen = {};
      for (const status of TASK_STATUSES) {
        let task = await call("create_task", { title: `A task that is ${status}`, description: "Made to see whether it waits." });
        const id = `task:${task.id}`;
        for (const step of route(status)) task = await call("set_task_status", { id, version: task.version, status: step });
        const alone = await call("get", { id });
        await call("add_link", { from: id, type: "depends on", to: unfinished });
        const held = await call("get", { id });
        assert.equal(held.status, status);
        assert.equal(held.is_waiting, held.waiting_for.length > 0, `${status}: waiting_for names something exactly when the task is waiting`);
        await call("delete", { id, version: held.version });
        const gone = await call("get", { id });
        assert.deepEqual([gone.is_waiting, gone.waiting_for, gone.is_next, gone.depends_on.length], [false, [], false, 1], `a deleted ${status} task is not waiting and not next, though its dependency is still there`);
        seen[status] = { next: alone.is_next, waiting: held.is_waiting, problem: (held.problems ?? []).map((problem) => problem.code) };
      }
      assert.deepEqual(seen, {
        draft: { next: false, waiting: true, problem: [] },
        open: { next: true, waiting: true, problem: [] },
        in_progress: { next: false, waiting: true, problem: ["unfinished_dependency"] },
        paused: { next: false, waiting: true, problem: [] },
        in_review: { next: false, waiting: true, problem: ["unfinished_dependency"] },
        done: { next: false, waiting: false, problem: ["unfinished_dependency"] },
        cancelled: { next: false, waiting: false, problem: [] },
      });
      assert.deepEqual(Object.fromEntries(contract.waiting.map((one) => [one.status, { next: one.next, waiting: one.waiting, problem: one.problem }])), seen, "the facts the pages are made from say the same");
      // The sentences made from it, where they stand.
      const next = "The task is open, is not deleted, has an active path through its projects and groups, and has no unfinished dependency";
      const waiting = "The task is not deleted, is draft, open, in_progress, paused or in_review, and either depends on something unfinished or every path through its projects and groups is inactive";
      const not = "A task that is done or cancelled, or deleted, is not waiting, whatever it depends on; one that is done with an unfinished dependency carries a problem instead";
      for (const path of ["docs/model/", "how/next-and-waiting/"]) assert.ok(said(path).includes(next) && said(path).includes(waiting) && said(path).includes(not), `${path} says what next and waiting are, as the service has them`);
      const fields = Object.fromEntries(rowsOf(page("docs/operations/"), "What an answer about a task carries").map((row) => [row[0], row[2]]));
      assert.ok(fields.is_waiting.includes(waiting) && fields.is_next.includes(next));
      assert.deepEqual(contract.containerWaiting, {
        inactive: { next: false, waiting: true, waitingFor: [contract.containerWaiting.inactiveGroup] },
        alternate: { next: true, waiting: false, waitingFor: [] },
        inactiveGroup: contract.containerWaiting.inactiveGroup,
      }, "an inactive path waits and an alternate active path clears it");
      for (const one of built.pages) assert.doesNotMatch(said(one.path), /Whether something it depends on is unfinished|The task is not finished and depends on something unfinished|is waiting when it is not finished and depends on|waiting: an open task that depends/, `${one.path} does not say that a finished or a deleted task can be waiting`);
    });

    it("of what an error leaves behind: nothing after a refusal, part or an unknown outcome after internal", async () => {
      // A refusal of each code that a call can be refused with from outside, on a service of this test's own. Whether
      // the plan had changed is asked of the service: the number of the plan as it is stored goes up with every change.
      const own = await startService();
      let seen;
      try {
        const task = await own.call("create_task", { title: "A task", description: "Made to fail on." });
        const id = `task:${task.id}`;
        const tried = async (operation, input, as = "agent1") => {
          const revision = await own.revision();
          const error = await own.refusal(operation, input, as);
          assert.ok(error, `${operation} was to be refused`);
          return { code: error.code, message: error.message, stored: (await own.revision()) !== revision };
        };
        seen = [
          await tried("update_task", { id, version: 1, nope: 1 }),
          await tried("get", { id: "task:404" }),
          await tried("delete", { id, version: 1, permanent: true }),
          await tried("update_task", { id, version: 5, priority: 1 }),
          await tried("set_task_status", { id, version: 1, status: "open" }),
        ];
        // A change that is announced as larger than the service reads is refused before any of it is sent.
        {
          const revision = await own.revision();
          const { status, error } = await own.announce("update_task", tooLarge(await readFacts()));
          assert.equal(status, 413);
          seen.push({ code: error.code, message: error.message, stored: (await own.revision()) !== revision });
        }
        assert.deepEqual(seen.map((one) => [one.code, one.stored]), [["invalid_input", false], ["not_found", false], ["forbidden", false], ["version_conflict", false], ["rule_violation", false], ["limit_exceeded", false]]);
        // A call with a key that is none is turned away before it reaches an operation, and changes nothing.
        const revision = await own.revision();
        const turnedAway = await fetch(`${own.url}/api/update-task`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer vig_not_a_key" }, body: JSON.stringify({ id, version: 1, priority: 5 }) });
        assert.deepEqual([turnedAway.status, (await turnedAway.json()).error.code, await own.revision()], [401, "unauthorized", revision]);
        assert.deepEqual(contract.turnedAway, { code: "unauthorized", stored: false });
        assert.deepEqual([(await own.call("get", { id })).priority, (await own.call("get", { id })).version], [0, 1], "after all of them the task is as it was made");
      } finally {
        await own.stop();
      }
      // What is said of `internal` is stated, since no store can be made to fail from outside: the same answer whether
      // the change was stored or not, and a message that says what stands. The second is seen in commands.test.mjs.
      const notConfirmed = "The service hit an unexpected error. The change was not confirmed.";
      assert.deepEqual(INTERNAL.map((one) => [one.code, one.message, one.stored]), [
        ["internal", "User keyless was created, but its API key could not be stored, so it cannot connect yet.", true],
        ["internal", notConfirmed, false],
        ["internal", notConfirmed, true],
      ]);
      assert.deepEqual(contract.outcomes.map((one) => [one.code, one.stored]), [...seen.map((one) => [one.code, one.stored]), ...INTERNAL.map((one) => [one.code, one.stored])], "the facts the pages are made from say the same");
      // The table, on the two pages that have it, and the sentences made from the same.
      const unchanged = "invalid_input, not_found, forbidden, version_conflict, rule_violation, limit_exceeded";
      for (const path of ["docs/cli/", "docs/errors/"]) {
        assert.deepEqual(rowsOf(page(path), "What an error of the service leaves behind"), [
          [unchanged, "Nothing. The call was refused before anything was stored."],
          ["unauthorized", "Nothing. The call was turned away before it reached an operation."],
          ['internal, with a message that says what stands, as in "User keyless was created, but its API key could not be stored, so it cannot connect yet."', "Part of it: what the message says stands, and it says what to do about the rest."],
          [`internal, "${notConfirmed}"`, "Not known. The same answer is given when the change was stored and when it was not. Look at the item, with get and its history, before sending the change again."],
        ], path);
      }
      const inSentence = "invalid_input, not_found, forbidden, version_conflict, rule_violation and limit_exceeded";
      assert.ok(said("docs/errors/").includes(`After ${inSentence}, nothing was changed: the call was refused before anything was stored. unauthorized is given before a call reaches an operation.`));
      assert.ok(said("docs/http-api/").includes(`After ${inSentence} nothing was: the change was refused before it was stored.`));
      assert.ok(said("docs/operations/").includes(`${inSentence} are given before anything is stored.`));
      for (const one of built.pages) assert.doesNotMatch(said(one.path), /Every (other )?code (but internal )?(means|does)|Every code but internal is given before/, `${one.path} names the codes after which nothing was changed, and does not say "every"`);
    });

    it("of the fields of a task in short: each is there when its words say it is", async () => {
      const tasks = (await call("list_tasks", {})).tasks;
      const gone = tasks.find((task) => task.status === "open" && !task.progress);
      await call("delete", { id: gone.id, version: gone.version });
      const deleted = (await refusal("delete", { id: gone.id, version: gone.version + 5 })).current;
      const says = Object.fromEntries(rowsOf(page("docs/operations/"), "What an answer about a task carries").map((row) => [row[0], row[2]]));
      const contains = (task) => tasks.some((other) => other.contained_in.includes(task.id));
      for (const task of tasks.filter((each) => each.id !== gone.id)) {
        assert.equal(Object.hasOwn(task, "progress"), contains(task), `${task.id}: progress is there exactly when the task contains tasks`);
        assert.equal(Object.hasOwn(task, "completed_at"), task.status === "done", `${task.id}: completed_at is there exactly when the task is done`);
        assert.equal(Object.hasOwn(task, "problems"), task.has_problems, `${task.id}: problems are there exactly when there are some`);
        assert.ok(!Object.hasOwn(task, "deleted_at"), "a task of a list is not deleted");
        assert.equal(task.waiting_for.length > 0, task.is_waiting);
        assert.equal(task.is_assigned, task.assigned_to.length > 0);
        assert.ok(task.value === null || typeof task.value === "number");
        // A full reading has everything a list says, and more.
        const full = await call("get", { id: task.id });
        for (const field of Object.keys(task)) assert.deepEqual(full[field], task[field], `${task.id}: get has ${field} as the list has it`);
        if (task.status === "done") assert.equal(task.completed_at, full.timeline.findLast((entry) => entry.status === "done").at, "completed_at is when the task was last set to done");
      }
      assert.ok(tasks.some(contains) && tasks.some((task) => task.status === "done") && tasks.some((task) => task.value === null));
      assert.equal(typeof deleted.deleted_at, "string", "a deleted task says when it was deleted");
      assert.ok(says.progress.startsWith("Only for a task that contains tasks") && says.completed_at === "Only for a task that is done: when it was last set to done." && says.problems.startsWith("Only when there are some") && says.deleted_at.startsWith("Only for a deleted task") && says.value === "As set, or null." && says.waiting_for.includes("empty when it is not waiting") && says.is_assigned === "Whether anyone has it.");
      assert.ok(said("docs/operations/override-timestamp/").includes("For a task that is done, completed_at is in it. created_at and the timeline show in get."));
    });

    it("of the shape of the plan: only what the lists, the board and the graph show, and nothing that judges a plan by itself", async () => {
      const input = Object.keys(OPERATIONS.find((operation) => operation.name === "list_tasks").input.properties);
      assert.ok(["top_level", "parent", "status", "project"].every((field) => input.includes(field)), "list_tasks takes what the page says an agent passes");
      // Work that belongs nowhere: a task in no group, and one in no project either, as an agent finds them.
      const project = (await call("list_projects", {})).projects[0].id;
      const loose = await call("create_task", { title: "In a project and in no group", description: "Made to be found.", project });
      const nowhere = await call("create_task", { title: "In nothing at all", description: "Made to be found." });
      assert.deepEqual([loose.contained_in, nowhere.contained_in], [[project], []], "a task says what it is in, and that it is in nothing");
      const top = (await call("list_tasks", { top_level: true })).tasks;
      const all = (await call("list_tasks", {})).tasks;
      const inGroup = (task) => task.contained_in.some((holder) => all.some((other) => other.id === holder));
      assert.ok(top.some((task) => task.id === loose.id) && top.some((task) => task.id === nowhere.id), "the top level lists the ungrouped tasks");
      assert.ok(top.every((task) => !inGroup(task)) && all.filter((task) => !inGroup(task)).every((task) => top.some((one) => one.id === task.id)), "and the groups, and nothing that is inside a group");
      // Groups, wide or thin: each with how many tasks it holds, and its inside one call away.
      const groups = top.filter((task) => task.progress);
      assert.ok(groups.length >= 3 && groups.every((group) => Number.isInteger(group.progress.total) && group.progress.total > 0));
      const inside = (await call("list_tasks", { parent: groups[0].id })).tasks;
      assert.ok(inside.length > 0 && inside.every((task) => task.contained_in.includes(groups[0].id) || inGroup(task)));
      // What is in progress: each task with its priority, who has it and what it is in.
      const started = (await call("list_tasks", { status: "in_progress" })).tasks;
      assert.ok(started.length >= 2 && started.every((task) => task.status === "in_progress" && Number.isInteger(task.priority) && Array.isArray(task.assigned_to) && Array.isArray(task.contained_in)));
      for (const field of ["priority", "assigned_to", "contained_in", "depends_on", "waiting_for"]) assert.ok(contract.summaries.task.always.includes(field), `${field} is in every task in short`);
      assert.ok(Object.keys((await call("get", { id: started[0].id })).links).length > 0, "get has the links in both directions");
      // What the page about the web page says a card and the graph show, which the sentences here rest on.
      const web = said("docs/web-page/");
      assert.ok(web.includes("A card shows the task's ID, title, priority, who has it, the group and project it is in, and what it waits for."));
      assert.ok(web.includes('A group\'s card shows its progress, such as "1/4 done".'));
      assert.ok(web.includes("Collapse groups Shows each group as one item with its progress"));
      // The sentences.
      assert.ok(said("").includes("The whole plan in one picture, grouped into areas, with its dependencies, its work in progress and its priorities, also shows how the work is cut: tasks that belong to no group, a group grown too wide, too many unrelated things started at once. An agent can read the same plan through the same lists."), "the first page");
      const how = said("how/plan-as-a-graph/");
      assert.ok(how.includes("Vigile does not rate a plan. It flags contradictions, and shows the rest for a person to read on the board and the graph, and for an agent to read through the same lists."));
      assert.deepEqual(rowsOf(page("how/plan-as-a-graph/"), "Table: To notice, A person looks at, An agent calls").map((row) => row[0]), ["Work that belongs nowhere", "Groups that are too wide or too thin", "Too many unrelated things in progress", "Work that hangs on much else"]);
      assert.ok(said("how/problems/").includes("Nor is a problem a judgement of the plan. Work in no group, or too much started at once, contradicts nothing and is not flagged"));
    });

    it("of a refusal: who may call is asked first, a field that is not known is refused by every operation, and the refusals the first page names say what would resolve them", async () => {
      for (const operation of OPERATIONS) assert.equal((await refusal(operation.name, { no_such_field: 1 }, "admin"))?.code, "invalid_input", `${operation.name} refuses a field it does not know`);
      assert.equal(contract.strict.length, OPERATIONS.length);
      const forAdmins = OPERATIONS.filter((operation) => operation.access !== "all").map((operation) => operation.name);
      assert.deepEqual(forAdmins, ["create_user", "reset_user_key"]);
      for (const name of forAdmins) assert.equal((await refusal(name, { no_such_field: 1 }))?.code, "forbidden", `${name} asks who is calling before it looks at the input`);
      assert.deepEqual([contract.adminOnly, contract.accessFirst], [forAdmins, true]);
      assert.ok(said("docs/operations/").includes("Input is checked before anything is done. A field of the wrong type, a required field that is missing or a field the operation does not know is refused as invalid_input, and the message names the field. An operation for admins asks who is calling before that."));
      // The first page: three wrong moves, each refused with what would resolve it. Not each names items in the way.
      assert.deepEqual(contract.statusRefusals, [{ rule: "unfinished_dependencies", actions: true, blocking: true }, { rule: "unfinished_contents", actions: true, blocking: true }, { rule: "status_move_not_allowed", actions: true, blocking: false }]);
      assert.ok(said("").includes("each is refused, and the refusal says why, and what would resolve it"), "the first page says of the three what is true of all three");
      assert.doesNotMatch(said(""), /each is refused, with what is in the way/);
      // A refusal of an operation names something to do, also one that names no item in the way. An error of the service itself may not.
      const bare = await refusal("restore", { id: (await call("list_tasks", {})).tasks[0].id });
      assert.deepEqual([bare.rule, Array.isArray(bare.actions) && bare.actions.length > 0, Object.hasOwn(bare, "blocking")], ["not_deleted", true, false]);
      assert.ok(said("docs/errors/").includes("rule_violation: follow one of the actions. Repeating the same call will be refused again while the plan is as it is."));
      assert.ok(said("docs/errors/").includes("with a refusal of an operation; an error of the service itself may have none"));
      // The table of an error's fields has every field the program names, and says "always" of the two that every error has.
      const errorsPage = page("docs/errors/");
      const shape = [...errorsPage.slice(errorsPage.indexOf('id="the-shape-of-an-error"'), errorsPage.indexOf('id="codes"')).matchAll(/<tr><td><code>([a-z_]+)<\/code><\/td><td>.*?<\/td><td>(.*?)<\/td><\/tr>/g)].map((row) => [row[1], words(row[2]).trim()]);
      const members = described.errors.members;
      assert.deepEqual(members.always, ["code", "message"], "the description names the two fields every error has");
      assert.deepEqual(shape.map(([field]) => field).sort(), [...members.always, ...Object.keys(members.sometimes)].sort(), "the fields of an error");
      assert.deepEqual(shape.filter(([, present]) => present === "always").map(([field]) => field), [...members.always], "only a code and a message are in every error");
      // Where the product's own words are shown, and on the page about statuses: no refusal is promised more than that.
      for (const one of built.pages) assert.doesNotMatch(said(one.path), /Any move is allowed/, `${one.path} does not say of a project's status more than is so`);
      assert.ok(said("how/statuses/").includes("It carries the rule that refused the change and actions that would resolve it, and with some rules the items in the way"));
      assert.ok(said("docs/mcp/").includes("A refusal names the obstacle and actions."), "what an agent is told of a refusal");
      assert.ok(said("docs/guide/").includes("A change that breaks a rule is refused. The refusal says what is in the way and lists actions you can take."), "what the guide says of a refusal");
      // A project's status: every move but the one to the status it has, on the operation's page.
      assert.ok(said("docs/operations/set-project-status/").includes("Any move to another status is allowed; setting the status the project already has is refused."));
    });
  });

  describe("the diagrams", () => {
    // Each drawing has a model beside it, and is held to it: by the names in it, and where it shows a plan, by
    // what a real service works out of that plan. A drawing is not only looked at.
    const names = readdirSync(join(here, "diagrams")).filter((file) => file.endsWith(".svg")).map((file) => file.slice(0, -4));
    const svgOf = (name) => readFileSync(join(here, "diagrams", `${name}.svg`), "utf8");
    /** A way to call a new service that holds nothing yet. Each one is stopped when its test is over. */
    const services = [];
    const own = async () => {
      const service = await startService();
      services.push(service);
      return (operation, input, as = "agent1") => service.call(operation, input, as);
    };
    afterEach(async () => {
      for (const service of services.splice(0)) await service.stop();
    });
    let TASK_MOVES;
    before(() => (TASK_MOVES = described.tasks.moves));

    it("each have a model beside them that names every item and every name of the program they show, and every such name is the program's", () => {
      assert.deepEqual(readdirSync(join(here, "diagrams")).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)).sort(), [...names].sort(), "a model for every drawing, and none without one");
      const codes = described.errors.codes.map((one) => one.code);
      const known = new Set([...codes, ...described.problems, ...described.errors.rules, ...described.tasks.statuses, ...described.projects.statuses, ...described.operations.map((operation) => operation.name), ...described.settings.map((setting) => setting.key.split(".").at(-1))]);
      for (const name of names) {
        const model = modelOf(name);
        const found = namesIn(svgOf(name));
        assert.ok(typeof model.shows === "string" && model.shows.length > 20, `${name}: its model says what it shows`);
        assert.deepEqual(found.ids, [...model.ids].sort(), `${name}: the items the drawing names are the items of its model`);
        assert.deepEqual(found.terms, [...model.terms].sort(), `${name}: the names of the program in the drawing are those of its model`);
        for (const term of found.terms) assert.ok(known.has(term), `${name}: "${term}" is a name the program has`);
        // A caption under the drawing, on any page, names no item the drawing does not have.
        for (const one of built.pages) {
          for (const [, caption] of page(one.path).matchAll(new RegExp(`aria-labelledby="${name}-title[^"]*"[\\s\\S]*?</svg></div>(?:<figcaption>([\\s\\S]*?)</figcaption>)?`, "g"))) {
            for (const id of words(caption ?? "").match(/\b[A-Z]{2,8}-\d{3}\b/g) ?? []) assert.ok(model.ids.includes(id), `${one.path}: the caption of ${name} names ${id}, which the drawing does not show`);
          }
        }
      }
      // What a drawing says of the settings is what the settings are.
      const byDefault = (key) => described.settings.find((one) => one.key === key).default;
      assert.equal(modelOf("one-service").address, `${byDefault("listen.address")}:${byDefault("listen.port")}`);
      assert.ok(textsOf(svgOf("one-service")).some((one) => one.text === modelOf("one-service").address));
      assert.equal(modelOf("access").keyless, byDefault("auth.keyless_user"));
      assert.ok(textsOf(svgOf("access")).some((one) => one.text === `keyless_user = "${byDefault("auth.keyless_user")}"`));
      assert.ok(codes.includes(modelOf("access").refusal) && textsOf(svgOf("access")).filter((one) => one.text === modelOf("access").refusal).length === 2);
      for (const path of [...modelOf("interfaces").paths, ...modelOf("one-service").paths]) assert.ok([...textsOf(svgOf("interfaces")), ...textsOf(svgOf("one-service"))].some((one) => one.text.startsWith(path)), `${path} is in the drawing`);
      assert.deepEqual(textsOf(svgOf("storage")).map((one) => /^\d · ([A-Z]+)$/.exec(one.text)?.[1]).filter(Boolean), modelOf("storage").steps);
    });

    it("of next and waiting: the boxes, the arrows and what is worked out under each are the scenario, as a service works it out", async () => {
      const { scenario } = modelOf("next");
      const tasks = scenario.items.filter((item) => item.kind !== "project");
      const drawn = chainOf(svgOf("next"));
      // The boxes: each task of the scenario with its ID, its title and its status. The arrows: from what a task depends on, to the task.
      assert.deepEqual(drawn.tasks, tasks.map((item) => ({ id: item.id, title: item.title, status: item.status })), "the boxes are the tasks of the scenario");
      assert.deepEqual(drawn.arrows, tasks.flatMap((item) => (item.depends_on ?? []).map((from) => ({ from, to: item.id }))), "the arrows are the dependencies of the scenario, and no others");
      assert.deepEqual(drawn.arrows.at(-1), { from: "WEB-004", to: "WEB-013" }, "the launch waits for the confirmation email, not for a group");
      // What the service works out of that plan, under each box.
      const seen = await runScenario(scenario, await own(), TASK_MOVES);
      const label = (id) => (["done", "cancelled"].includes(seen[id].status) ? "finished" : seen[id].is_next ? "next: can start" : `waiting for ${seen[id].waiting_for.join(" and ")}`);
      assert.deepEqual(drawn.workedOut, Object.fromEntries(tasks.map((item) => [item.id, label(item.id)])), "under each box is what the service works out of it");
      assert.deepEqual(built.facts.contract.diagrams.next.seen, seen, "the facts the caption is made from say the same");
      // The two lines under the drawing: finishing one task makes the next one next, and nothing else was changed.
      const { finish, next } = scenario.after;
      assert.deepEqual(drawn.notes, [`Finish ${finish}, and ${next} is next for whoever asks after that.`, `No flag was updated, because there is none: only the status of ${finish} changed.`]);
      const after = await runScenario({ ...scenario, then: [{ id: finish, status: "done" }] }, await own(), TASK_MOVES);
      assert.deepEqual([seen[next].is_next, after[next].is_next, after[next].waiting_for], [false, true, []], `finishing ${finish} makes ${next} next`);
      // The words for those who do not see it, and the caption, are made from the same.
      assert.deepEqual(described.tasks.finished, ["done", "cancelled"], "the statuses that count as finished");
      assert.equal(describedAs(svgOf("next")), descriptionOfChain(scenario, seen, ["done", "cancelled"]));
      const caption = "The cart page is done, so the payment form is next. The confirmation email waits for the payment form, and the launch waits for the confirmation email. The statuses and the links are what is stored; next and waiting are worked out from them each time they are read.";
      assert.equal(captionOfChain(scenario, seen, ["done", "cancelled"]), caption);
      assert.ok(page("how/next-and-waiting/").includes(`<figcaption>${caption}</figcaption>`), "the page shows the caption that was made");
      for (const one of built.pages) assert.doesNotMatch(words(page(one.path)), /the launch waits for the whole checkout group|Nothing in this picture was set by hand except the statuses/, `${one.path} does not say of this drawing what it does not show`);
      assert.ok(words(page("how/next-and-waiting/")).includes("In the picture above the launch waits for one task, the confirmation email. It could wait for the whole checkout instead"));
      // A scenario that says something else is not this drawing: the check sees it.
      const other = { ...scenario, items: scenario.items.map((item) => (item.id === "WEB-013" ? { ...item, depends_on: ["WEB-003"] } : item)) };
      assert.notDeepEqual(drawn.arrows, other.items.filter((item) => item.kind !== "project").flatMap((item) => (item.depends_on ?? []).map((from) => ({ from, to: item.id }))));
    });

    it("of storage: the drawing and the page say which reads are answered from the plan in memory and which from the store, and none says that all are", () => {
      // Where a read is answered from is the service's own business, and cannot be seen by asking it: the drawing
      // is held to its model, and the pages to the drawing.
      const { reads } = modelOf("storage");
      assert.deepEqual(reads.fromTheStore, ["description", "timeline", "history"], "what the model says a full reading takes from the store");
      // The drawing says both, and no longer that every read is answered from memory.
      const drawn = textsOf(svgOf("storage")).map((one) => one.text);
      assert.ok(drawn.includes(reads.memory) && drawn.includes(reads.store), "the two ways a read is answered are in the drawing");
      assert.ok(drawn.includes("THE PLAN IN MEMORY: A WORKING COPY"));
      assert.ok(describedAs(svgOf("storage")).endsWith("Items, links and what is worked out of them, next, waiting and problems, are answered from the plan in memory. Descriptions, history and status timelines are read from the store when they are asked for."));
      const how = words(page("how/storage/")).replace(/ ([,.:;])/g, "$1");
      assert.ok(how.includes("Lists, links and what is worked out of them are answered from memory; a description, the history and the status timeline are read from the store."), "the caption");
      assert.ok(how.includes("A description, the history of an item and the statuses it went through are not kept in memory: get reads them from the store when it is asked."));
      for (const name of names) assert.doesNotMatch(svgOf(name), /every read is answered|Reads are answered from the plan in memory\.<|all reads/i, `${name}.svg does not say that every read is answered from memory`);
      for (const one of built.pages) assert.doesNotMatch(words(page(one.path)), /every read is answered from|A read is answered from memory|Reads are answered from there|keeps the whole plan in memory|all reads (are|come)/i, `${one.path} does not say that every read is answered from memory`);
    });

    it("of a plan, of a problem and of a conflict: what they show is what a service does with their scenario", async () => {
      // The plan as a graph: the progress of the group, and who waits for what.
      for (const name of ["plan-graph", "problems"]) {
        const { scenario } = modelOf(name);
        const seen = await runScenario(scenario, await own(), TASK_MOVES);
        for (const [id, expected] of Object.entries(scenario.expect)) for (const [field, value] of Object.entries(expected)) assert.deepEqual(seen[id][field], value, `${name}: ${id}.${field}`);
        assert.deepEqual(built.facts.contract.diagrams[name].seen, seen);
        const texts = textsOf(svgOf(name)).map((one) => one.text);
        for (const item of scenario.items) assert.ok(texts.includes(item.id) && texts.includes(item.title), `${name}: ${item.id}, ${item.title}, is in the drawing`);
        // The state each task is drawn with: its status, or "waiting" for an open task that is held back; a group is drawn with its progress.
        for (const item of scenario.items.filter((one) => one.kind !== "project" && !seen[one.id].progress)) {
          const state = seen[item.id].status === "open" && seen[item.id].is_waiting ? "waiting" : seen[item.id].status.replaceAll("_", " ");
          assert.ok(texts.some((text) => text === state || text.includes(`status: ${state}`) || text.endsWith(`now ${state} again`)), `${name}: the state of ${item.id}, ${state}, is in the drawing`);
        }
      }
      const graph = textsOf(svgOf("plan-graph")).map((one) => one.text);
      const group = modelOf("plan-graph").scenario.expect["WEB-001"].progress;
      assert.ok(graph.includes(`${group.finished} of ${group.total} done`), "the group's progress is the service's");
      assert.ok(describedAs(svgOf("plan-graph")).includes("The task WEB-013, Launch, depends on the whole group and waits for it."));
      const problem = textsOf(svgOf("problems")).map((one) => one.text);
      for (const code of ["unfinished_dependency", "contains_task_with_problems"]) assert.ok(problem.includes(code));
      // The conflict: two agents read one task, the first starts it, the second is refused with the task as it is now.
      const { conflict } = modelOf("versions");
      const call = await own();
      await call("create_user", { username: conflict.second, type: "agent" }, "admin");
      const task = await call("create_task", { title: "A task two agents take", description: "Made for the diagram of versions." });
      assert.deepEqual([task.status, task.version], [conflict.read.status, conflict.read.version]);
      const done = await call("set_task_status", { id: `task:${task.id}`, version: 1, status: "in_progress" }, conflict.first);
      assert.deepEqual([done.status, done.version, done.assigned_to], [conflict.after.status, conflict.after.version, conflict.after.assigned_to]);
      const refused = await call("set_task_status", { id: `task:${task.id}`, version: 1, status: "in_progress" }, conflict.second).then(() => null, (error) => error.refusal);
      assert.deepEqual([refused.code, refused.current.status, refused.current.version, refused.current.assigned_to], [conflict.refusal, conflict.after.status, conflict.after.version, conflict.after.assigned_to]);
      const drawn = textsOf(svgOf("versions")).map((one) => one.text);
      for (const text of ["open, version 1", "done: in progress, version 2", "version_conflict", "in progress, version 2, agent1", "agent1", "agent2"]) assert.ok(drawn.includes(text), `the drawing of versions says "${text}"`);
    });
  });

  it("keeps its pictures as files, and has no tool and no instruction for taking them", () => {
    // Every file of the site's folder that is not ignored, as git has it, named from that folder.
    const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: here, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(listed.status, 0, listed.stderr);
    const files = listed.stdout.split("\0").filter((file) => file && existsSync(join(here, file)));
    assert.ok(files.includes("build.mjs") && files.includes("lib/browser.mjs") && files.length > 100, "the files of the site are found");
    // No file is a tool for taking pictures, by its name or by what it does.
    assert.deepEqual(files.filter((file) => /screenshot|screen-shot|take-pictures|pictures\.mjs$/i.test(file)), [], "no file of the site is named after taking pictures");
    const texts = files.filter((file) => /\.(md|mjs|js|json|ya?ml|html|txt|toml|sh)$/.test(file));
    // The browser tests drive a browser with the site's own driver, which has no way to save what it sees.
    const self = "site.test.mjs";
    for (const file of texts.filter((each) => each !== self)) {
      const text = readFileSync(join(here, file), "utf8");
      assert.doesNotMatch(text, /captureScreenshot|\.screenshot\(/, `${file} takes no picture of a page`);
      assert.doesNotMatch(text, /screenshots?\.mjs|node [^\n\`]*(screenshot|pictures?)[^\n\` ]*\.m?js/i, `${file} names no tool that takes pictures, and no command that runs one`);
      if (/\.md$/.test(file)) assert.doesNotMatch(text, /\b(take|make|retake|regenerate|capture) (them|the pictures|the screenshots|the images|new pictures|new screenshots)\b[^.\n]{0,80}\b(and commit|by running|with the script|yourself)\b/i, `${file} does not tell a contributor to take the pictures`);
    }
    // What the site's own README says instead.
    const siteReadme = readFileSync(join(here, "README.md"), "utf8").replace(/\s+/g, " ");
    assert.ok(siteReadme.includes("The pictures are maintained by the project's maintainers, who take them again when the page's look has changed. A contribution changes the code and the text, and leaves the pictures as they are"));
    assert.ok(siteReadme.includes("Building the site needs no browser."));
    // Instructions for agents that work on the site are not part of it.
    assert.deepEqual(files.filter((file) => /(^|\/)(AGENTS|CLAUDE|GEMINI|COPILOT)\.md$|(^|\/)\.(cursor|claude|opencode)(\/|rules)|copilot-instructions/i.test(file)), [], "the site has no instructions for agents");
    // The pictures themselves are all there: every one the site's list names, in each width and in light and dark, the picture of a shared link and the icons.
    const pictures = JSON.parse(readFileSync(join(here, "assets", "pictures", "pictures.json"), "utf8"));
    assert.ok(Object.keys(pictures).length >= 8);
    for (const [name, picture] of Object.entries(pictures)) {
      assert.ok(picture.width > 0 && picture.height > 0 && picture.widths.length >= 2 && picture.schemes.length >= 1, `${name} has its size, its widths and its schemes`);
      for (const scheme of picture.schemes) for (const width of picture.widths) assert.ok(files.includes(`assets/pictures/${name}-${scheme}-${width}.webp`), `website/assets/pictures/${name}-${scheme}-${width}.webp is in the repository`);
    }
    const kept = files.filter((file) => file.startsWith("assets/pictures/") && file.endsWith(".webp"));
    assert.equal(kept.length, Object.values(pictures).reduce((sum, picture) => sum + picture.schemes.length * picture.widths.length, 0), "and no picture is there that the list does not name");
    for (const file of ["assets/og.jpg", "assets/favicon.png", "assets/apple-touch-icon.png", "assets/favicon.svg"]) assert.ok(files.includes(file), `website/${file} is in the repository`);
    // Every picture a page shows says what it shows and how large it is.
    let shown = 0;
    for (const one of built.pages) {
      for (const [tag] of page(one.path).matchAll(/<img\b[^>]*>/g)) {
        shown++;
        assert.match(tag, /\salt="[^"]{20,}"/, `${one.path}: a picture says what it shows: ${tag.slice(0, 80)}`);
        assert.match(tag, /\swidth="\d+"\s+height="\d+"|\sheight="\d+"[^>]*\swidth="\d+"/, `${one.path}: a picture says its size: ${tag.slice(0, 80)}`);
      }
    }
    assert.ok(shown >= 10, `${shown} pictures are shown on the site`);
  });

  it("is tested, built and published by a workflow that is read as YAML, names every action by its commit, and asks for no more than each job needs", () => {
    const file = "pages.yml";
    const text = readFileSync(WORKFLOW, "utf8");
    // Read whole, as GitHub reads it: a file that is not YAML, such as one a merge left its marks in, stops here with its line.
    const workflow = parseYaml(text, `.github/workflows/${file}`);
    assert.ok(typeof workflow.name === "string" && workflow.on && workflow.permissions && workflow.jobs, `${file} has a name, what starts it, what it may do, and jobs`);
    assert.equal(workflow.name, "Web site");
    const lines = text.split("\n");
    const named = [];
    const pins = new Map();
    for (const [id, job] of Object.entries(workflow.jobs)) {
      assert.ok(job["runs-on"] === "ubuntu-latest" && Number.isInteger(job["timeout-minutes"]) && Array.isArray(job.steps) && job.steps.length > 0, `${file}: the job ${id} says where it runs, for how long at most, and what it does`);
      assert.ok(job.permissions && typeof job.permissions === "object", `${file}: the job ${id} says what it may do`);
      const jobNamed = [];
      for (const step of job.steps) {
        assert.equal(Number(step.uses !== undefined) + Number(step.run !== undefined), 1, `${file}: a step of ${id} either uses an action or runs a command: ${JSON.stringify(step)}`);
        if (step.uses !== undefined) {
          named.push(step.uses);
          jobNamed.push(step.uses);
        }
      }
      assert.equal(new Set(jobNamed).size, jobNamed.length, `${file}: the job ${id} names no action twice: ${jobNamed.join(", ")}`);
    }
    // Every line of the file that names an action is one the reading above found: none hides in a place that is not a step.
    const inText = lines.filter((line) => /^[^#]*\buses\s*:/.test(line));
    assert.equal(inText.length, named.length, `${file}: every "uses:" of the file is a step of a job`);
    for (const uses of named) {
      const index = lines.findIndex((line) => line.includes(`uses: ${uses}`));
      const where = `${file}:${index + 1}`;
      const [, name, ref] = /^(\S+?)@(\S+)$/.exec(uses) ?? [];
      assert.ok(name, `${where}: an action is named as owner/repository@commit`);
      assert.doesNotMatch(name, /^docker:/, `${where}: an image is not named here without its digest`);
      assert.match(name, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.\/-]+)?$/, `${where}: ${name}`);
      assert.match(ref, /^[0-9a-f]{40}$/, `${where}: ${name} is named by its commit, all forty characters of it, and not by "${ref}": a tag or a branch can be moved to other code`);
      // Its version stands beside the commit, or on the line above it, for whoever reads the file. Every line that names the action says it.
      for (const [at, line] of lines.entries()) {
        if (!line.includes(`uses: ${uses}`)) continue;
        const beside = /#\s*(v\d+\.\d+\.\d+)\b/.exec(line.split(uses)[1] ?? "")?.[1];
        const above = /^\s*#\s*(v\d+\.\d+\.\d+)\b/.exec(lines[at - 1] ?? "")?.[1];
        assert.ok(beside ?? above, `${file}:${at + 1}: ${name} says which version its commit is, as in "# v1.2.3", beside it or on the line above`);
      }
      // One action is one commit in every job.
      if (pins.has(name)) assert.equal(ref, pins.get(name), `${where}: ${name} is the same commit in every job`);
      pins.set(name, ref);
    }
    assert.doesNotMatch(text, /write-all|pull_request_target|secrets\./, `${file} has no wide permission, no trigger that runs with them on a stranger's code, and no secret`);
    assert.ok(named.length >= 9, "the actions were found");
    assert.deepEqual([...pins.keys()].sort(), ["actions/checkout", "actions/configure-pages", "actions/deploy-pages", "actions/setup-node", "actions/upload-pages-artifact", "pnpm/action-setup"]);
    // It is started by a pull request, by a push to main, and by hand; and unless a job says otherwise, it may only read the code.
    assert.deepEqual(workflow.on, { pull_request: null, push: { branches: ["main"] }, workflow_dispatch: null });
    assert.deepEqual(workflow.permissions, { contents: "read" }, "what every job has unless it says otherwise: to read the code");
    assert.equal(workflow.concurrency, undefined, "no rule of the whole workflow makes the tests of one branch wait for a publication");
    const { test, build: building, publish } = workflow.jobs;
    assert.deepEqual(Object.keys(workflow.jobs), ["test", "build", "publish"]);
    // The tests: on whatever starts the workflow, with a browser that is there, reading the code and nothing else.
    assert.equal(test.if, undefined, "the tests run for a pull request, for a push to main, and before a publication");
    assert.deepEqual(test.permissions, { contents: "read" }, "the tests read the code");
    assert.deepEqual(test.concurrency, { group: "site-tests-${{ github.event_name }}-${{ github.ref }}", "cancel-in-progress": true }, "a push ends the tests of an older push, and not the ones a publication waits for");
    assert.deepEqual(test.steps.map((step) => (step.uses ?? step.run).split("@")[0]), ["actions/checkout", "pnpm/action-setup", "actions/setup-node", "pnpm install --frozen-lockfile", "pnpm build", "test -x /usr/bin/google-chrome && /usr/bin/google-chrome --version", "node --test website/*.test.mjs"]);
    assert.deepEqual(test.steps.at(-1).env, { VIGILE_TEST_BROWSER: "/usr/bin/google-chrome" }, "the tests are told which browser to drive, so that none of them is skipped for want of one");
    // Building and publishing: for a push to main and when someone starts them, never for a pull request; one publication at a time, into the environment of Pages.
    for (const job of [building, publish]) assert.equal(job.if, "github.event_name != 'pull_request'", "the site is built and published for a push to main and when someone starts it, and never for a pull request");
    assert.deepEqual(building.permissions, { contents: "read", pages: "read" }, "building reads the code, and asks Pages where the site is served");
    assert.deepEqual(building.steps.map((step) => (step.uses ?? step.run).split("@")[0]), ["actions/checkout", "pnpm/action-setup", "actions/setup-node", "pnpm install --frozen-lockfile", "pnpm build", "actions/configure-pages", 'node website/build.mjs --out website/dist --site-url "${{ steps.pages.outputs.base_url }}/"', "actions/upload-pages-artifact"]);
    assert.deepEqual(publish.permissions, { pages: "write", "id-token": "write" }, "publishing writes the pages and says who it is to Pages");
    assert.deepEqual(publish.concurrency, { group: "pages", "cancel-in-progress": false, queue: "max" }, "one publication at a time, one that has begun is let finish, and one that waits is not put out of its turn by another");
    assert.deepEqual(publish.environment, { name: "github-pages", url: "${{ steps.deployment.outputs.page_url }}" }, "it is published into the environment of Pages");
    assert.deepEqual([building.needs, publish.needs], ["test", "build"], "only a site whose tests passed in the same run is built, and only one that was built is published");
    // An older commit is never published over a newer one: the turn of a publication may come after main has moved on, and then it publishes nothing.
    const [current, deploy] = publish.steps;
    assert.equal(publish.steps.length, 2);
    assert.deepEqual([current.id, current.uses], ["current", undefined]);
    assert.match(current.run, /^head=\$\(git ls-remote "https:\/\/github\.com\/\$GITHUB_REPOSITORY\.git" refs\/heads\/main \| cut -f1\) && test -n "\$head" && if \[ "\$head" = "\$GITHUB_SHA" \]; then echo "is=true" >> "\$GITHUB_OUTPUT"; else echo "[^"]*"; fi$/, "it asks where main is, fails when it cannot tell, and says yes only for the commit main is at");
    assert.deepEqual([deploy.id, deploy.if, deploy.uses.split("@")[0]], ["deployment", "steps.current.outputs.is == 'true'", "actions/deploy-pages"], "the pages are written only when main is still at this commit");

    // The reading refuses what GitHub refuses. A workflow with the marks of a merge that was not finished, as one was sent:
    const checkout = lines.findIndex((line) => line.includes("uses: actions/checkout@"));
    const conflicted = lines.toSpliced(checkout, 0, "<<<<<<< main").toSpliced(checkout + 2, 0, "=======", "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1", ">>>>>>> work").join("\n");
    assert.throws(() => parseYaml(conflicted, file), (error) => error.name === "YamlError" && error.message === `${file}:${checkout + 1}: a mark of a merge that was not finished`);
    for (const [bad, says] of [
      ["name: a\nname: b\n", /the key "name" is there twice/],
      ["jobs:\n  test:\n    steps:\n      - uses: a/b@c\n        - run: x\n", /indented/],
      ["on:\n\tpush:\n", /a tab in the indentation/],
      ["run: echo a: b\n", /a plain value has no ": " in it/],
      ['name: "Web "site""\n', /double-quoted value has only valid escaped quotes/],
      ["name: 'Web 'site''\n", /quote inside a single-quoted value is written twice/],
      ["a: 1\n  b: 2\n", /indented under "a"/],
      ["- a\nb: 1\n", /belongs to nothing above it/],
      ["branches: [main,,release]\n", /a list in brackets has an element between its commas/],
      ["branches: [,main]\n", /a list in brackets has an element between its commas/],
      ["branches: [main]]\n", /x\.yml:1: the brackets of a list pair up/],
      ["a: 1\nbranches: [[main], release\n", /x\.yml:2: a list in brackets ends on its line/],
      ["branches: [[main, release]\n", /x\.yml:1: the brackets of a list pair up/],
      ["branches: [main], release]\n", /x\.yml:1: the brackets of a list pair up/],
      ["branches: [main, 'a]\n", /a quote that is opened is closed/],
    ]) {
      assert.throws(() => parseYaml(bad, "x.yml"), says, JSON.stringify(bad));
    }
    assert.deepEqual(parseYaml('a: 1 # one\nb:\n  - x\n  - y: "z # not a comment"\n    w: [p, q]\nc: ${{ a.b }}/\nd: "echo \\" # still inside\\"" # outside\ne: \'it\'\'s # inside\' # outside\n', "x.yml"), { a: 1, b: ["x", { y: "z # not a comment", w: ["p", "q"] }], c: "${{ a.b }}/", d: 'echo " # still inside"', e: "it's # inside" });
    // A list in brackets is cut at the commas between its elements, not at one inside a quote; a comma after the last is allowed.
    assert.deepEqual(parseYaml('a: ["main,release"]\nb: [main, \'it\'\'s, here\', "x\\", y"]\nc: [main, release,]\nd: []\ne: [[p, q], r]\n', "x.yml"), { a: ["main,release"], b: ["main", "it's, here", 'x", y'], c: ["main", "release"], d: [], e: [["p", "q"], "r"] });
    // And the check of the pins sees what it is for: a tag, a branch and a short commit are each refused.
    for (const bad of ["v7", "main", "3d3c42e", "3D3C42E5AAC5BA805825DA76410C181273BA90B1"]) assert.doesNotMatch(bad, /^[0-9a-f]{40}$/);
  });

  it("says that the code is compiled before it runs, and does not say that there is nothing to compile", () => {
    for (const one of built.pages) {
      assert.doesNotMatch(words(page(one.path)), /nothing to (install or )?compile|no compil|nothing to build|no build step|without (a )?build|no setup|zero[- ]config|no installation/i, `${one.path} does not say that nothing has to be compiled or set up`);
    }
    const install = words(page("docs/install/"));
    assert.ok(install.includes("There is no database server to install and no account to make; the code is compiled once, with one command."));
    assert.ok(install.includes("pnpm build compiles the TypeScript of the packages; until it has run, there is no command to start."));
    assert.ok(words(page("docs/storage/")).includes("so there is no database to install and no native module to compile"));
    // The first page says what is needed, and what is not: Node.js, pnpm, no database server, no account.
    assert.match(words(page("")), /It needs Node\.js \S+ or later and pnpm \. No database server and no account\./);
  });

  describe("what it says of the future", () => {
    // What can be used today and what is a direction that is not built are kept apart by labels a reader sees and
    // marks a test can find: data-horizon="today", "direction", "mixed", and "limits" for a list of what there is
    // not. These tests are a net, not a proof: they catch the words a promise is usually made of.
    const mainOf = (path) => {
      const html = page(path);
      return html.slice(html.indexOf("<main"), html.indexOf("</main>"));
    };
    /** The elements that carry a mark. None of these tags stands inside itself in a page, so each ends at its first end tag. */
    const MARKED = /<(aside|article|ul|li|p)\b[^>]*\bdata-horizon="(today|direction|mixed|limits)"[^>]*>[\s\S]*?<\/\1>/g;
    const markedIn = (html) => [...html.matchAll(MARKED)].map((match) => ({ tag: match[1], horizon: match[2], html: match[0], text: words(match[0]).replace(/ ([,.:;])/g, "$1").trim() }));
    /** What a page says outside everything that is marked as direction, as mixed or as a list of limits, and outside code. */
    const unmarked = (html) =>
      words(html.replace(MARKED, (whole, _tag, horizon) => (horizon === "today" ? whole : " ")).replace(/<pre\b[\s\S]*?<\/pre>/g, " ").replace(/<svg\b[\s\S]*?<\/svg>/g, " ")).replace(/ ([,.:;])/g, "$1");
    const sentences = (text) => text.split(/(?<=[.!?:;])\s+/);
    const count = (html) => words(html.replace(/<pre\b[\s\S]*?<\/pre>/g, " ").replace(/<svg\b[\s\S]*?<\/svg>/g, " ").replace(/<figcaption\b[\s\S]*?<\/figcaption>/g, " ")).split(/\s+/).filter(Boolean).length;

    /** Words a promise is made of: what the product is going to do, and when. */
    const PROMISE = /\b(Vigile|the product|we) (will|is going to|plans to|aims to)\b|\bwill (soon|support|ship|add|offer|bring|let you)\b|\b(coming soon|(?<!as )soon\b(?! as)|upcoming|roadmap|in a future (release|version)|next (release|quarter|year)\b|planned for|we plan|we are (working|building)|stay tuned|early access|waitlist|beta programme)/i;
    /** What is not built. Outside a place that is marked, each may be named only to say that it is not there. */
    const UNBUILT = /\b(hosted|cloud|access by team|multi-team|observer|plan health|health of a plan|portfolio|sync\b|integrations?|controlled automation|nudges?|area priorit|across teams)\b/i;
    const DENIES = /\b(no|not|none|nothing|without|cannot|never|neither|nor|only shows|look elsewhere)\b/i;
    /** What a direction may not be dressed in: a date, a price, a customer, a market, a promise, or the usual words. */
    const DRESSED = [
      [/\bwill\b|\bshall\b|\bgoing to\b|\bguarantee/i, "a promise"],
      [/\b20\d\d\b|\bQ[1-4]\b|\b(this|next) (month|quarter|year|release)\b|\bsoon\b|\bweeks?\b|\bmonths?\b/i, "a date"],
      [/[$€£]|\bpric|\bper (seat|user|month)\b|\bfree\b|\bpaid\b|\bsubscription/i, "a price"],
      [/\bcustomers? (use|trust|love|rely)|\btrusted by\b|\bmarket\b|\bbillion\b|\bmillion\b|\bindustry-leading|\bleading\b/i, "a customer or a market"],
      [/\benterprise-grade|\bworld-class|\bseamless|\brevolution|\bbest-in-class|\bsynerg|\bnext-generation|\bgame-chang|\bAI-powered|\bcutting-edge|\bunlock|\bsupercharg|\bturnkey|\bmission-critical/i, "the usual words"],
    ];

    it("only where a label says so: outside a marked place no page promises, and what is not built is named only as not there", () => {
      for (const one of built.pages) {
        const text = unmarked(mainOf(one.path));
        for (const sentence of sentences(text)) {
          assert.doesNotMatch(sentence, PROMISE, `${one.path} promises something outside a place that is marked as direction: ${sentence}`);
          if (UNBUILT.test(sentence)) assert.match(sentence, DENIES, `${one.path} names something that is not built, outside a place that is marked as direction, without saying that it is not there: ${sentence}`);
        }
      }
      // The net catches what it is for. A promise and an unbuilt thing, put into a page as plain text, are found.
      for (const [bad, found] of [["<p>Vigile will support access by team.</p>", "promise"], ["<p>A hosted service keeps the plan for you.</p>", "unbuilt"], ["<p>Coming soon: an observer.</p>", "promise"]]) {
        const text = unmarked(`<main>${bad}</main>`);
        assert.ok(sentences(text).some((sentence) => (found === "promise" ? PROMISE.test(sentence) : UNBUILT.test(sentence) && !DENIES.test(sentence))), `the net catches: ${bad}`);
      }
      assert.equal(unmarked('<main><p data-horizon="direction">Direction A hosted service.</p><ul data-horizon="limits"><li>No hosted service.</li></ul></main>').trim(), "", "and lets a marked place be");
    });

    it("in a marked place: a direction carries its label, says that it is not built, and wears no date, price, customer or promise", () => {
      const withDirections = built.pages.filter((one) => markedIn(mainOf(one.path)).some((mark) => mark.horizon === "direction" || mark.horizon === "mixed"));
      assert.deepEqual(withDirections.map((one) => one.path).sort(), ["", "vision/"], "a direction is spoken of on the first page and on the vision, and nowhere else");
      for (const one of withDirections) {
        const marks = markedIn(mainOf(one.path));
        for (const mark of marks.filter((each) => each.horizon === "direction" || each.horizon === "mixed")) {
          for (const [dress, name] of DRESSED) assert.doesNotMatch(mark.text, dress, `${one.path}: a direction is said with ${name}: ${mark.text}`);
          // The label a reader sees.
          const label = mark.horizon === "mixed" ? /^Mixed\b/ : /^Direction\b/;
          assert.match(mark.text, label, `${one.path}: what is marked as ${mark.horizon} starts with that word: ${mark.text.slice(0, 80)}`);
        }
        // A row that is mixed says which part is which.
        for (const mark of marks.filter((each) => each.horizon === "mixed")) assert.match(mark.text, /\bToday\b[\s\S]*\b(direction|not built)\b/, `${one.path}: a mixed row says what is there today and what is direction: ${mark.text}`);
        // What is said to be there today leads to where it is shown.
        for (const mark of marks.filter((each) => each.horizon === "today" && each.tag !== "aside")) assert.match(mark.html, /<a href="/, `${one.path}: what is there today links to the page that shows it: ${mark.text.slice(0, 80)}`);
      }
      const vision = markedIn(mainOf("vision/"));
      assert.ok(vision.filter((mark) => mark.horizon === "today").length >= 5 && vision.filter((mark) => mark.horizon === "direction").length >= 8 && vision.filter((mark) => mark.horizon === "mixed").length >= 3, "the vision has rows of each of the three");
      // Every row that is a direction on its own says, in so many words, that it is not built.
      for (const mark of vision.filter((each) => each.horizon === "direction" && each.tag === "li")) assert.match(mark.text, /\bnot built\b|\bNot built\b|\bnothing takes\b/, `a direction of the vision says that it is not built: ${mark.text}`);
      const list = vision.find((mark) => mark.tag === "aside" && mark.horizon === "direction");
      assert.ok(list.text.startsWith("Direction: not built, no date None of these is built, none is promised and none has a date. They are where this design could go."), "the list of directions is under its label, and says what it is");
      for (const direction of ["Access by team", "A hosted service", "Integrations and sync", "An observer of plan health, with suggestions", "Controlled automation", "Views across projects and teams"]) assert.ok(list.text.includes(direction), direction);
      const today = vision.find((mark) => mark.tag === "aside" && mark.horizon === "today");
      assert.ok(today.text.startsWith(`Today Version ${described.version}: one service that you run yourself.`) && /no TLS of its own and no access by team; its web page mostly reads, with −\/\+ controls for task priority; and it has no importer/.test(today.text), "the vision does not hide what the product is today");
      // No task, ticket or person of the work on Vigile is named.
      for (const one of built.pages) assert.doesNotMatch(mainOf(one.path), /\bVIG-\d+/, `${one.path} names no task of the work on Vigile`);
    });

    it("on the first page: what can be used today and the direction stand side by side before anything else, and the page stays short", () => {
      const main = mainOf("");
      const first = main.slice(0, main.indexOf('class="hero-shot"'));
      const marks = markedIn(first);
      assert.deepEqual(marks.map((mark) => [mark.tag, mark.horizon]), [["article", "today"], ["article", "direction"]], "the two stand in the first screen, in that order");
      const [today, direction] = marks;
      assert.match(today.html, /^<article id="today" data-horizon="today">/);
      assert.match(direction.html, /^<article id="direction" data-horizon="direction">/);
      assert.ok(today.text.startsWith("Use today One service, on your machine"));
      assert.ok(today.text.includes(`Version ${described.version}: no TLS, no access by team.`), "what can be used today says its limits where it stands");
      for (const href of ["#start", "#why", "#limits"]) assert.ok(today.html.includes(`<a href="${href}">`) && main.includes(` id="${href.slice(1)}"`), `today leads to ${href}, which is on the page`);
      assert.ok(direction.text.startsWith("Direction · not built, no dates A control plane for people and agents"));
      assert.ok(direction.text.includes("could carry") && direction.text.includes("None of it is built."));
      assert.ok(direction.html.includes('<a href="vision/">'), "the direction leads to the vision");
      // The limits stand with trying it, after it, and are a list of what there is not.
      assert.ok(main.indexOf('id="start"') < main.indexOf('id="limits"'));
      const limits = markedIn(main).find((mark) => mark.horizon === "limits");
      const lines = [...limits.html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((line) => words(line[1]).trim());
      assert.ok(lines.length >= 4 && lines.every((line) => /^No\b/.test(line)), "every line of the limits says that something is not there");
      // Attention: the point in forty seconds, the page in about three and a half minutes, at 230 words a minute.
      assert.ok(count(first) <= 153, `the first screen has ${count(first)} words: what Vigile is, today and in direction, is read in forty seconds`);
      assert.ok(count(main) <= 800, `the first page has ${count(main)} words`);
      assert.ok(count(mainOf("vision/")) <= 1000, `the vision has ${count(mainOf("vision/"))} words`);
    });

    it("of today, on the vision: each thing that is said to be there is there", async () => {
      // Asked of a real service that holds the made-up plan, and of what the program says of itself.
      const service = await demoService();
      try {
        await holds((operation, input, as = "agent1") => service.call(operation, input, as));
      } finally {
        await service.stop();
      }
    });

    /** What the vision says is there today, each thing asked of a service through `call`. */
    async function holds(call) {
      const OPERATIONS = described.operations;
      const guide = (topic) => described.guide.topics.find((one) => one.topic === topic);
      // What is next: from each task's priority, its dependencies and who has it.
      await call("create_task", { title: "Urgent and free", description: "Made to come first.", priority: 9 });
      const next = (await call("list_next_tasks", {})).tasks;
      const follows = (before, after) => {
        const different = before.findIndex((priority, index) => priority !== after[index]);
        return different < 0 ? before.length <= after.length : after[different] === undefined || before[different] > after[different];
      };
      assert.ok(next.length >= 3 && next.every((task, index) => index === 0 || follows(next[index - 1].priority_path, task.priority_path)), "the most important priority path first");
      assert.ok(next.every((task) => task.is_next && !task.is_waiting && (task.assigned_to.length === 0 || task.assigned_to.includes("agent1"))), "what can start, and is the caller's or nobody's");
      // A priority belongs to a task, and to nothing larger.
      const takes = (name) => Object.keys(OPERATIONS.find((operation) => operation.name === name).input.properties);
      assert.ok(takes("create_task").includes("priority") && !takes("create_project").includes("priority") && !takes("set_project_status").includes("priority"));
      assert.ok(!Object.hasOwn((await call("list_projects", {})).projects[0], "priority"));
      // A task waits for a task, or for a whole project, elsewhere in the same plan.
      const projects = (await call("list_projects", {})).projects;
      const there = (await call("list_tasks", { project: projects[1].id })).tasks.find((task) => task.status !== "done");
      const here = await call("create_task", { title: "Waits for the other team", description: "Made to wait.", project: projects[0].id, depends_on: [there.id, `project:${projects[1].id}`] });
      assert.deepEqual([...here.waiting_for].sort(), [there.id, projects[1].id].sort());
      // Decisions and history stay with the task.
      const full = await call("get", { id: here.id, history: true });
      assert.ok(typeof full.description === "string" && Object.hasOwn(full, "why") && full.history[0].by === "agent1" && full.timeline.length > 0);
      // The loop, where the page says it is taught.
      const routine = guide("working").text;
      for (const step of ["list_next_tasks lists what can start now, following priorities from the outermost group to the task", "get shows the task in full: its description, its reason, its links and its version", "in_progress when implementation really starts", "Set done only when the outcome is shipped and verified", "## Keep the plan true"]) assert.ok(routine.includes(step), `the guide teaches: ${step}`);
      assert.ok(guide("organising").text.includes("To read a plan from the top, call list_tasks with top_level."));
      for (const step of ["Call list_next_tasks", "implementation is actively under way", "take the version you last read", "call get on the task"]) assert.ok(described.mcp.instructions.includes(step), `an agent is told on connecting: ${step}`);
      assert.ok(OPERATIONS.find((operation) => operation.name === "list_next_tasks").description.includes("This starts nothing: read the chosen task with get, then call set_task_status with in_progress only when work actually starts."), "a tool's description says the next step");
      // The guide is the same text for every caller, and the text the program describes.
      const asAgent = await call("get_guide", { topic: "working" });
      assert.deepEqual(await call("get_guide", { topic: "working" }, "admin"), asAgent, "the guide is the same text whoever asks");
      assert.equal(asAgent.text, routine);
      // Three types of user.
      assert.equal(described.users.types.length, 3);
      // And the page says these things in the rows it marks as today.
      const today = markedIn(mainOf("vision/")).filter((mark) => mark.horizon === "today").map((mark) => mark.text).join(" ");
      for (const said of ["read the plan from the top, ask what is next, read the task and its version, start only when the work starts, keep statuses and structure true, finish when the work is shown to work", "list_next_tasks answers from each task's priority, its dependencies and who has it", "Users of three types", "a second store already meets", "The description, the reason, each status and who changed what stay with the task"]) assert.ok(today.includes(said), `said as today: ${said}`);
    }
  });

  it("has been read, page by page, as someone deciding whether to spend attention on it: every public page has its row in the editorial pass", () => {
    const file = join(here, "editorial", "README.md");
    const text = readFileSync(file, "utf8");
    // One row for each page: the page, its purpose, its reader, its value, what was checked, the attention it asks, the verdict, the date.
    const rows = text
      .split("\n")
      .filter((line) => /^\| `\//.test(line))
      .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
    const pages = built.pages.map((one) => `/${one.path}`);
    const listed = rows.map((row) => row[0].replaceAll("`", ""));
    for (const path of pages) assert.ok(listed.includes(path), `${path} has no row in website/editorial/README.md. Read the page as that file says, change what fails, and add its row.`);
    for (const path of listed) assert.ok(pages.includes(path), `website/editorial/README.md has a row for ${path}, which is no page of the site. Remove the row.`);
    assert.equal(new Set(listed).size, listed.length, "a page has one row");
    for (const row of rows) {
      assert.equal(row.length, 8, `${row[0]}: a row has eight cells`);
      const [path, purpose, reader, value, checked, attention, verdict, date] = row;
      for (const [name, cell] of [["purpose", purpose], ["reader", reader], ["value", value], ["what was checked", checked]]) assert.ok(cell.length >= 12, `${path}: the ${name} is said in words`);
      assert.match(attention, /\d+(\.\d+)? (s|min)\b/, `${path}: the attention it asks is a time, in seconds or minutes`);
      assert.match(verdict, /^(keep|shorten|move|rewrite)\b/, `${path}: the verdict is keep, shorten, move or rewrite`);
      assert.match(date, /^\d{4}-\d{2}-\d{2}$/, `${path}: the date of the pass`);
      assert.ok(!Number.isNaN(Date.parse(date)) && Date.parse(date) <= Date.now() + 86_400_000, `${path}: the date of the pass is a day that has been`);
    }
    // The pass is for those who work on the site: it is not a page of it, and it says nothing of this machine.
    assert.deepEqual(built.files.filter((name) => /editorial/i.test(name)), [], "the editorial file is not built into the site");
    for (const one of built.pages) assert.ok(!page(one.path).includes("editorial"), `${one.path} does not lead to the editorial file`);
    for (const word of [homedir(), root, hostname().length > 3 ? hostname() : null].filter(Boolean)) assert.ok(!text.includes(word), `the editorial file names ${word}`);
    assert.doesNotMatch(text, /vig_[A-Za-z0-9_-]{16,}|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, "the editorial file shows no key and no address");
  });

  it("keeps the README's links to it true", () => {
    const readme = readFileSync(README, "utf8");
    // The README names the site by the address it is published at, which is the one website/site.mjs has.
    const links = readme.split(`](${SITE_URL}`).slice(1).map((rest) => rest.slice(0, rest.indexOf(")")));
    assert.ok(links.length >= 3, "the README leads to the three areas of the site");
    for (const link of links) {
      const [path, anchor] = link.split("#");
      assert.ok(built.pages.some((one) => one.path === path), `the README links to ${link}, which is a page of the site`);
      if (anchor) assert.ok(page(path).includes(`id="${anchor}"`), `the README links to ${link}, which is an anchor of that page`);
    }
  });
});
