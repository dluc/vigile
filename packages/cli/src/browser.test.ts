import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { initConfig, loadConfig, setValue } from "@vigile/config";
import { paging } from "@vigile/core";
import { adversary, type Target } from "./adversary.js";
import { Page, findBrowser } from "./browser-driver.js";
import { BROWSER_TEST_SHARDS, type BrowserTestShard, type BrowserTestSuite } from "./browser-shards.js";
import { seedDemoPlan } from "./demo-plan.js";
import { startService, type Service } from "./service.js";

/**
 * Drives the real page in a real browser against a real service: resizing, scrolling, clicking, typing,
 * keyboard, touch, and a layout check after each step. Skipped, with a reason, when no Chromium is installed.
 */

const browser = findBrowser();
/** Set `VIGILE_TEST_SHOTS` to a folder to keep pictures of the page as the tests see it. */
const shots = process.env.VIGILE_TEST_SHOTS;

/** Runs in the page. Returns what is wrong with the layout as it is on screen right now. */
const AUDIT = `
const describe = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/).join(".") : "") + ' "' + (el.textContent || "").trim().slice(0, 30) + '"';
const vw = document.documentElement.clientWidth;
const issues = new Set();
if (document.documentElement.scrollWidth > vw) issues.add("PAGE scrolls sideways: " + document.documentElement.scrollWidth + " > " + vw);
const scope = document.getElementById("panel").hidden ? document.body : document.querySelector(".panel-card");
for (const el of scope.querySelectorAll("*")) {
  if (el.closest("[hidden]") || el.closest(".graph")) continue;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) continue;
  const style = getComputedStyle(el);
  if (style.position === "absolute" && el.matches(".visually-hidden, .switch input")) continue;
  const scroller = el.closest(".projects, .board");
  const inScroller = scroller && getComputedStyle(scroller).overflowX === "auto";
  if (!inScroller && (r.right > vw + 1 || r.left < -1)) issues.add("OUTSIDE viewport (" + Math.round(r.left) + ".." + Math.round(r.right) + " of " + vw + "): " + describe(el));
  const parent = el.parentElement;
  if (parent && parent !== document.body) {
    const pr = parent.getBoundingClientRect();
    const ps = getComputedStyle(parent);
    if (ps.display !== "contents" && !el.matches(".projects, .board > .column") && (r.right > pr.right + 1 || r.left < pr.left - 1) && ps.overflowX === "visible" && style.position !== "absolute" && style.position !== "fixed") issues.add("OVERFLOWS parent by " + Math.round(Math.max(r.right - pr.right, pr.left - r.left)) + "px: " + describe(el));
  }
  if (el.scrollWidth > el.clientWidth + 1 && ["hidden", "clip"].includes(style.overflowX) && style.textOverflow !== "ellipsis" && !el.matches(".bar, input, .scope, .instance, .card-title")) issues.add("CLIPPED: " + describe(el));
}
for (const el of document.querySelectorAll("[hidden]")) {
  const r = el.getBoundingClientRect();
  if (r.width > 0 && r.height > 0) issues.add("HIDDEN but displayed: " + describe(el).slice(0, 50));
}
{
  const shown = ["board", "graph-panel"].filter((id) => { const r = document.getElementById(id).getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const wanted = location.hash === "#graph" ? "graph-panel" : "board";
  if ([...document.querySelectorAll(".card, #graph-box canvas")].some((el) => el.getBoundingClientRect().width > 0) && !document.getElementById("main").hidden && (shown.length !== 1 || shown[0] !== wanted)) issues.add("VIEWS on screen: " + (shown.join(" and ") || "none") + "; expected only " + wanted);
}
if (innerWidth > 640) {
  const tops = new Set([...document.querySelectorAll(".board > .column")].map((c) => Math.round(c.getBoundingClientRect().top)));
  if (tops.size > 1) issues.add("COLUMNS wrap onto " + tops.size + " rows");
}
if (innerWidth <= 640) {
  const tops = new Set([...document.querySelectorAll(".projects > .project")].map((c) => Math.round(c.getBoundingClientRect().top)));
  if (tops.size > 1) issues.add("PROJECTS stack in " + tops.size + " rows on a phone");
}
{
  const parts = [...document.querySelectorAll(".top .brand, .top .views, .top .status, .top .controls")].filter((k) => k.getBoundingClientRect().width > 0);
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    const a = parts[i].getBoundingClientRect(), b = parts[j].getBoundingClientRect();
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) issues.add("OVERLAP in header: " + describe(parts[i]).slice(0, 30) + " and " + describe(parts[j]).slice(0, 30));
  }
  if (document.querySelector(".top").getBoundingClientRect().height > 130) issues.add("HEADER is too tall");
}
for (const row of scope.querySelectorAll(".card-top, .project-head, .project-foot, .column-head, .detail-head, .board-head, .filters, .lane, .graph-tools, .link, .timeline li, .tags, .back, .relation h4, .fold-block summary, .detail-head")) {
  if (row.closest("[hidden]")) continue;
  const kids = [...row.children].filter((k) => k.getBoundingClientRect().width > 0);
  for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
    const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) issues.add("OVERLAP in " + describe(row).slice(0, 40) + ": " + describe(kids[i]) + " and " + describe(kids[j]));
  }
}
// A drawing inside a button sits in the middle of it.
for (const icon of document.querySelectorAll("button > svg")) {
  const b = icon.parentElement.getBoundingClientRect(), i = icon.getBoundingClientRect();
  if (!b.width || !i.width) continue;
  const off = Math.max(Math.abs((b.left + b.right) / 2 - (i.left + i.right) / 2), Math.abs((b.top + b.bottom) / 2 - (i.top + i.bottom) / 2));
  if (off > 0.6) issues.add("ICON is " + off.toFixed(1) + "px off the middle of " + describe(icon.parentElement));
}
// A pill is as tall as its text: one that is taller has been stretched by the row it sits in.
for (const el of scope.querySelectorAll(".tag, .pill, .type, .priority, .count")) {
  // A button is made tall enough to press, so it is left out.
  if (el.closest("[hidden]") || !el.firstChild || el.matches("button")) continue;
  const r = el.getBoundingClientRect();
  if (!r.height) continue;
  // Its own height is its lines of text plus its own padding and border; more than that was added from outside.
  const s = getComputedStyle(el);
  const range = document.createRange();
  range.selectNodeContents(el);
  const lines = Math.max(1, Math.round(range.getBoundingClientRect().height / parseFloat(s.lineHeight)));
  const own = lines * parseFloat(s.lineHeight) + parseFloat(s.paddingTop) + parseFloat(s.paddingBottom) + parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth);
  const extra = Math.round(r.height - own);
  if (extra > 2) issues.add("PILL taller than its text by " + extra + "px: " + describe(el) + " in " + describe(el.closest(".card, .project, .block, .column-head, .summary") ?? el.parentElement).slice(0, 60));
}
if (!document.getElementById("panel").hidden) {
  const close = document.getElementById("close").getBoundingClientRect();
  for (const el of document.querySelectorAll("#detail .back, #detail .detail-head > *, #detail .detail-title, #detail .open-group")) {
    const r = el.getBoundingClientRect();
    if (Math.min(close.right, r.right) - Math.max(close.left, r.left) > 1 && Math.min(close.bottom, r.bottom) - Math.max(close.top, r.top) > 1) issues.add("CLOSE button covers " + describe(el));
  }
}
const graph = document.getElementById("graph-box");
if (graph.getBoundingClientRect().height > 0) {
  const r = graph.getBoundingClientRect();
  for (const canvas of graph.querySelectorAll("canvas")) {
    const c = canvas.getBoundingClientRect();
    if (Math.abs(c.width - graph.clientWidth) > 2 || Math.abs(c.height - graph.clientHeight) > 2) issues.add("GRAPH canvas is " + Math.round(c.width) + "x" + Math.round(c.height) + " in a box of " + graph.clientWidth + "x" + graph.clientHeight);
  }
  if (r.right > vw + 1) issues.add("GRAPH box leaves the screen");
}
return [...issues].slice(0, 10);
`;

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

describe("the page in a browser", { skip: browser ? false : "no Chromium found; install one or set VIGILE_TEST_BROWSER" }, () => {
  let directory: string;
  let config: string;
  let service: Service;
  let page: Page;
  let base: string;
  let adminKey: string;
  const ids: Record<string, string> = {};

  const run = (operation: string, input: Record<string, unknown>) => service.engine.execute(operation, "agent1", input) as Promise<any>;
  const move = async (id: string, ...statuses: string[]) => {
    let version = (await run("get", { id })).version;
    for (const status of statuses) version = (await run("set_task_status", { id, version, status })).version;
  };
  const make = async (key: string, title: string, extra: Record<string, unknown> = {}) => {
    ids[key] = (await run("create_task", { title, description: `Description of ${title}.`, project: "WEB", ...extra })).id;
    return ids[key]!;
  };

  /** Opens the page and waits for its data. */
  const load = async (path = "/") => {
    await page.open("about:blank");
    await page.open(`${base}${path}`);
    await page.until("return /^(Updated|Live)/.test(document.getElementById('sync').textContent)", "the page to show its data");
  };
  const settingsOpen = () => page.run<boolean>("return !document.getElementById('settings-menu').hidden");
  /** Opens the menu behind the settings button in the header, if it is closed. */
  const openSettings = async () => {
    if (!(await settingsOpen())) await page.click("#settings");
  };
  const closeSettings = async () => {
    if (await settingsOpen()) await page.click("#settings");
  };
  /** Turns a switch in the settings the way a person does: opens the menu, clicks the switch, closes the menu. */
  const setting = async (id: string) => {
    await openSettings();
    await page.click(`label:has(#${id})`);
    await closeSettings();
  };
  /** Chooses a theme in the settings. */
  const theme = async (name: string) => {
    await openSettings();
    await page.click(`#themes [data-theme-choice="${name}"]`);
    await closeSettings();
  };
  /** Runs a check with the page scrolling as a whole, which is the setting that is off by default. */
  const wholePage = async (check: () => Promise<void>) => {
    await load();
    await page.run("localStorage.setItem('vigile.scroll', 'page')");
    try {
      await load();
      await check();
    } finally {
      await page.run("localStorage.removeItem('vigile.scroll')");
    }
  };
  const graphReady = () => page.until("return Boolean(window.vigileGraph && window.vigileGraph.scratch('settled') && window.vigileGraph.nodes().length)", "the graph to be drawn", 20_000);
  const layout = async (where: string) => {
    // Animations that never end, such as the pulse that says the page is live, are not waited for.
    await page.until("return document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity)", "animations to finish");
    assert.deepEqual(await page.run<string[]>(AUDIT), [], `layout problems ${where}`);
    if (shots) await page.shot(join(shots, `${where.replace(/[^a-z0-9]+/gi, "-")}.png`));
  };
  const count = (selector: string) => page.run<number>(`return document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const text = (selector: string) => page.run<string>(`return document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);
  const columns = () => page.run<Record<string, number>>(`return Object.fromEntries([...document.querySelectorAll('.column')].map((c) => [c.querySelector('.column-head').childNodes[1].textContent, Number(c.querySelector('.count').textContent)]))`);
  const panelOpen = () => page.run<boolean>("return !document.getElementById('panel').hidden");
  const nodeAt = (id: string, corner = false) =>
    page.run<{ x: number; y: number }>(`
      const cy = window.vigileGraph; const node = cy.getElementById(${JSON.stringify(id)});
      cy.container().scrollIntoView({ block: "center" });
      const box = cy.container().getBoundingClientRect();
      const r = node.renderedBoundingBox({ includeLabels: false });
      // A box is clicked in the strip that carries its title, where none of its contents are.
      return ${corner} ? { x: box.left + (r.x1 + r.x2) / 2, y: box.top + r.y1 + 14 * cy.zoom() } : { x: box.left + (r.x1 + r.x2) / 2, y: box.top + (r.y1 + r.y2) / 2 };
    `);

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), "vigile-browser-test-"));
    config = join(directory, "config.toml");
    adminKey = initConfig(config, { name: "browser-test", port: await freePort() }).adminKey;
    service = await startService({ loaded: loadConfig(config, {}), log: () => {}, warn: () => {} });
    base = service.urls.base;

    await run("create_project", { title: "Website relaunch", prefix: "WEB", description: "The main project." });
    await run("create_project", { title: `A project whose title is very long indeed ${"and goes on ".repeat(30)}`, prefix: "LONGNAME" });
    await run("create_project", { title: "Empty project", prefix: "EMPTY" });
    await make("checkout", "Checkout", { priority: 6, why: "It is how the shop earns money." });
    await make("payments", "Payments", { parent: ids.checkout });
    await make("card", "Card form", { parent: ids.payments });
    await make("receipts", "Receipts", { parent: ids.payments, depends_on: [ids.card] });
    await make("refunds", "Refunds fail for split payments", { parent: ids.payments, depends_on: [ids.receipts], type: "bug" });
    await make("shipping", "Shipping", { parent: ids.checkout });
    await make("address", "Address form", { parent: ids.shipping });
    await make("rates", "Rates", { parent: ids.shipping, depends_on: [ids.address, ids.card] });
    await make("launch", "Launch the checkout", { depends_on: [ids.checkout] });
    await make("long", `A task title that is extremely long ${"and keeps going ".repeat(28)}`.slice(0, 500));
    await make("unbroken", `Unbroken_${"Supercalifragilisticexpialidocious".repeat(8)}`);
    const prerequisites: string[] = [];
    for (let i = 1; i <= 12; i++) prerequisites.push(await make(`pre${i}`, `Prerequisite ${i}`));
    await make("many", "Depends on twelve other tasks", { depends_on: prerequisites, priority: 2 });
    await make("review", "In review item");
    await make("paused", "Paused item");
    await make("draft", "Draft item", { draft: true });
    await make("cancelled", "Cancelled item");
    for (let i = 1; i <= 20; i++) await move(await make(`done${i}`, `Finished thing ${i}`), "done");
    await make("bugBusy", "Checkout page is blank on phones", { type: "bug" });
    await make("incident", "Site is down in Europe", { type: "incident", priority: 10 });
    await make("issue", "Unclear who owns the newsletter", { type: "issue" });
    await make("bugDone", "Old bug that was fixed", { type: "bug" });
    await make("assigned", "Assigned to two", { assigned_to: ["user", "agent1"] });
    ids.elsewhere = (await run("create_task", { title: "In the long-named project", description: "d", project: "LONGNAME" })).id;
    ids.loose = (await run("create_task", { title: "No project at all", description: "d" })).id;
    await move(ids.card!, "in_progress", "done");
    await move(ids.address!, "in_progress");
    await move(ids.review!, "in_progress", "in_review");
    await move(ids.paused!, "in_progress", "paused");
    await move(ids.cancelled!, "cancelled");
    await move(ids.bugBusy!, "in_progress");
    await move(ids.bugDone!, "done");

    if (shots) mkdirSync(shots, { recursive: true });
    page = await Page.launch(browser!);
  });

  after(async () => {
    await page?.close();
    await service?.stop();
    rmSync(directory, { recursive: true, force: true });
  });

  const selectedShard = process.env.VIGILE_TEST_BROWSER_SHARD;
  if (selectedShard !== undefined && !Object.hasOwn(BROWSER_TEST_SHARDS, selectedShard)) throw new Error(`Unknown browser test shard: ${selectedShard}`);
  const browserSuite = (name: BrowserTestSuite, run: () => void) => {
    const selected = selectedShard === undefined || (BROWSER_TEST_SHARDS[selectedShard as BrowserTestShard] as readonly string[]).includes(name);
    describe(name, { skip: selected ? false : `not in ${selectedShard}` }, run);
  };

  browserSuite("board", () => {
    it("shows every task in the column for its state, bugs among them and marked as bugs", async () => {
      await page.size(1440, 900);
      await load();
      assert.equal(await page.run<boolean>("return document.getElementById('bugs-apart').checked"), false, "bugs have no column of their own unless asked for");
      assert.deepEqual(await columns(), { "In progress": 2, "In review": 1, Next: 23, "Waiting for dependencies": 4, Paused: 1, Draft: 1, Done: 22, Cancelled: 1 });
      assert.match(await text("#summary"), /55 tasks.*4 open bugs, issues and incidents/);
      assert.match(await text("#summary"), /55 tasks\s*2 in progress\s*23 next\s*4 waiting\s*22 done/, "the counts above the board are those of the columns");
      assert.deepEqual(await page.run<string[]>("return [...document.querySelectorAll('.column[data-tone=\"busy\"] .card')].map((c) => c.querySelector('.card-title').textContent + (c.matches('.trouble') ? ' [' + c.querySelector('.type').textContent + ']' : ''))"), ["Address form", "Checkout page is blank on phones [bug]"]);
      assert.deepEqual(page.errors, []);
      await layout("on the board at 1440px");
      await page.run(`for (const more of document.querySelectorAll('.more[aria-expanded="false"]')) more.click()`);
      assert.equal(await count(".card.trouble"), 5, "four unfinished and one finished");
      await page.run(`for (const more of document.querySelectorAll('.more[aria-expanded="true"]')) more.click()`);
    });

    it("gives bugs, issues and incidents a column of their own on request, and says there which state each is in", async () => {
      await load();
      await setting("bugs-apart");
      assert.deepEqual(await columns(), {
        "Bugs, issues and incidents": 4,
        "In progress": 1,
        "In review": 1,
        Next: 21,
        "Waiting for dependencies": 3,
        Paused: 1,
        Draft: 1,
        Done: 22,
        Cancelled: 1,
      });
      assert.match(await text("#summary"), /55 tasks.*4 open bugs, issues and incidents/);
      assert.match(await text("#summary"), /55 tasks\s*1 in progress\s*21 next\s*3 waiting\s*22 done/, "with bugs apart, the counts are still those of the columns");
      assert.equal(await text(".column[data-tone='bug'] .card .type"), "bug");
      assert.equal(await count(".column[data-tone='bug'] .card.trouble"), 4);
      const lanes = await page.run<string[]>(`return [...document.querySelector(".column[data-tone='bug'] .cards").children].map((n) => n.matches(".lane") ? n.childNodes[1].textContent + " " + n.querySelector(".count").textContent : n.querySelector(".id").textContent)`);
      assert.deepEqual(lanes, ["In progress 1", ids.bugBusy, "Next 2", ids.incident, ids.issue, "Waiting for dependencies 1", ids.refunds], "inside the column, a heading for each state says which are being worked on");
      assert.match(await text(".column[data-tone='bug'] .column-note"), /Not finished yet, in any state/);
      await layout("on the board with a column for bugs");
      await load();
      assert.equal(await count(".column[data-tone='bug']"), 1, "the choice survives a reload");
      await page.click("#view-graph");
      await graphReady();
      await page.click("#view-board");
      await page.until("return document.getElementById('board').getBoundingClientRect().height > 0", "the board");
      await setting("bugs-apart");
      assert.equal(await count(".column[data-tone='bug']"), 0);
      assert.equal(await page.run<string | null>("return localStorage.getItem('vigile.bugs-apart')"), "off");
    });

    it("keeps its layout at every width from a small phone to a wide screen, in light and dark", async () => {
      for (const scheme of ["light", "dark"] as const) {
        await page.scheme(scheme);
        for (const width of [320, 360, 414, 640, 641, 768, 1024, 1280, 1440, 1920, 2560]) {
          await page.size(width, 900, width <= 640);
          await load();
          await layout(`on the board at ${width}px, ${scheme}`);
        }
      }
      await page.scheme("light");
    });

    it("keeps columns side by side while the window is narrowed and widened, and stacks them on a phone", async () => {
      await page.size(1920, 900);
      await load();
      for (const width of [1920, 1700, 1500, 1300, 1100, 950, 800, 700, 641, 640, 500, 360, 500, 641, 900, 1400, 1920]) {
        await page.size(width, 900);
        const rows = await page.run<number>("return new Set([...document.querySelectorAll('.board > .column')].map((c) => Math.round(c.getBoundingClientRect().top))).size");
        assert.equal(rows, width > 640 ? 1 : 8, `columns at ${width}px`);
        await layout(`after resizing to ${width}px`);
      }
    });

    it("does not stretch its columns across a wide window", async () => {
      for (const width of [1920, 2560, 3440]) {
        await page.size(width, 1200);
        await load();
        const seen = await page.run<{ widths: number[]; left: number; first: number; filter: number; scrolls: boolean }>(
          "const b = document.getElementById('board'); const cols = [...b.children].map((c) => c.getBoundingClientRect()); return { widths: cols.map((c) => Math.round(c.width)), left: Math.round(b.getBoundingClientRect().left), first: Math.round(cols[0].left), filter: Math.round(document.getElementById('filter').getBoundingClientRect().left), scrolls: b.scrollWidth > b.clientWidth }",
        );
        assert.equal(seen.widths.length, 8);
        for (const column of seen.widths) assert.ok(column >= 270 && column <= 380, `a column is ${column}px wide at ${width}px`);
        assert.equal(new Set(seen.widths).size, 1, "all columns are equally wide");
        assert.equal(seen.first, seen.left, "the columns start at the left");
        assert.equal(seen.filter, seen.left, "the filter is above the first column, not at the far side of the window");
        assert.equal(seen.scrolls, width < 8 * 270 + 7 * 14 + 56, `sideways scrolling at ${width}px only when the columns cannot fit`);
        await page.click(".project-main", 1);
        const few = await page.run<number[]>("return [...document.getElementById('board').children].map((c) => Math.round(c.getBoundingClientRect().width))");
        assert.deepEqual(few, [380, 380, 380], "three columns keep a readable width and are not spread out");
        await layout(`on a board of three columns at ${width}px`);
        await page.click(".project-main", 1);
      }
    });

    it("gives the Done column the spare width, with its cards side by side", async () => {
      const done = () =>
        page.run<{ width: number; perRow: number; cards: number; others: number[] }>(
          "const c = document.querySelector('.column[data-key=\"done\"]'); const cards = [...c.querySelectorAll('.card')].map((k) => k.getBoundingClientRect()); return { width: Math.round(c.getBoundingClientRect().width), perRow: cards.filter((k) => Math.abs(k.top - cards[0].top) < 2).length, cards: cards.length, others: [...document.querySelectorAll('.board > .column:not([data-key=\"done\"])')].map((k) => Math.round(k.getBoundingClientRect().width)) }",
        );
      await page.size(1280, 900);
      await load();
      await page.click("#filter");
      await page.type("Finished thing");
      assert.deepEqual(await done(), { width: 380, perRow: 1, cards: 20, others: [380, 380] }, "no spare width at 1280px: a column like the others");
      await page.size(1920, 900);
      await page.until("return document.querySelector('.column[data-key=\"done\"]').getBoundingClientRect().width > 700", "the Done column to take the spare width at 1920px");
      assert.deepEqual(await done(), { width: 774, perRow: 2, cards: 20, others: [380, 380] });
      await layout("with a Done column two cards wide");
      await page.size(2560, 900);
      await page.until("return document.querySelector('.column[data-key=\"done\"]').getBoundingClientRect().width > 1100", "the Done column to widen at 2560px");
      assert.deepEqual(await done(), { width: 1562, perRow: 4, cards: 20, others: [380, 380] });
      assert.equal(await page.run<boolean>("const b = document.getElementById('board'); return b.scrollWidth > b.clientWidth"), false, "it takes only room that is spare");
      await layout("with a Done column four cards wide");
      // Side by side, a short card is stretched to the height of a tall neighbour. Its pills must not stretch with it.
      await move(ids.long!, "done");
      try {
        await page.size(1920, 900);
        await load();
        await page.click("#filter");
        await page.type("ing");
        await page.until("return document.querySelector('.column[data-key=\"done\"]')?.getBoundingClientRect().width > 700", "the Done column to be two cards wide");
        const heights = await page.run<number[]>("return [...document.querySelectorAll('.column[data-key=\"done\"] .card')].slice(0, 2).map((c) => Math.round(c.getBoundingClientRect().height))");
        assert.ok(heights[0]! > 100 && heights[0] === heights[1], `a tall card and its short neighbour are equally tall: ${heights}`);
        const pills = await page.run<Array<{ bottom: number; fromCard: number; height: number; underTitle: number }>>(
          "return [...document.querySelectorAll('.column[data-key=\"done\"] .card')].slice(0, 2).map((c) => { const t = c.querySelector('.tags').getBoundingClientRect(); return { bottom: Math.round(t.bottom), fromCard: Math.round(c.getBoundingClientRect().bottom - t.bottom), height: Math.round(t.height), underTitle: Math.round(t.top - c.querySelector('.card-title').getBoundingClientRect().bottom) }; })",
        );
        assert.equal(pills[0]!.bottom, pills[1]!.bottom, "the pills of the two cards are on one line");
        assert.deepEqual([pills[0]!.fromCard, pills[1]!.fromCard, pills[0]!.height, pills[1]!.height].map((n) => n < 24), [true, true, true, true], `at the bottom of each card, at their own height: ${JSON.stringify(pills)}`);
        assert.ok(pills[1]!.underTitle > 40, "in the short card the spare room is between the title and the pills");
        await layout("with a short card next to a tall one");
      } finally {
        await move(ids.long!, "open");
      }
      await page.size(1280, 900);
      await load();
      await page.click("#filter");
      await page.type("Finished thing");
      await page.until("return Math.round(document.querySelector('.column[data-key=\"done\"]').getBoundingClientRect().width) === 380", "the Done column to give the room back");
      await page.run("document.getElementById('filter').select()");
      await page.type("Prerequisite");
      await page.size(2560, 900);
      await page.wait(300);
      assert.equal((await done()).width, 380, "a Done column with nothing in it stays narrow");
      await page.size(1280, 900);
    });

    it("scrolls sideways to reach the last column, without the page itself scrolling sideways", async () => {
      await page.size(1000, 800);
      await load();
      const before = await page.run<{ lastRight: number; board: number; client: number }>(
        "const b = document.getElementById('board'); return { lastRight: b.lastElementChild.getBoundingClientRect().right, board: b.scrollWidth, client: b.clientWidth }",
      );
      assert.ok(before.board > before.client && before.lastRight > 1000, "the last column starts off screen");
      const box = await page.box(".board > .column .column-head");
      await page.wheelUntil(box.x + 30, box.y + 10, 0, 600, "return document.getElementById('board').scrollLeft > 100", "the board to scroll");
      await page.run("document.getElementById('board').scrollLeft = 1e6");
      const after = await page.run<{ lastRight: number; pageX: number }>("return { lastRight: document.getElementById('board').lastElementChild.getBoundingClientRect().right, pageX: scrollX }");
      assert.ok(after.lastRight <= 1000, "the last column is fully on screen after scrolling");
      assert.equal(after.pageX, 0);
      await page.click(".board > .column:last-child .card");
      await page.until("return !document.getElementById('panel').hidden", "the panel to open from the last column");
      await page.key("Escape");
      await layout("with the board scrolled to its end");
    });

    it("opens a task when its card is clicked, and closes with Escape, the close button and a click outside", async () => {
      await page.size(1280, 900);
      await wholePage(async () => {
      await page.run("scrollTo(0, 400)");
      await page.click(`.column[data-tone='busy'] .card`);
      await page.until("return !document.getElementById('panel').hidden", "the panel");
      assert.equal(await text(".detail-title"), "Address form");
      assert.match(await text("#detail"), /History/);
      await layout("with the panel open");
      await page.key("Escape");
      assert.equal(await panelOpen(), false);

      await page.click(`.column[data-tone='busy'] .card`);
      await page.until("return !document.getElementById('panel').hidden", "the panel");
      await page.click("#close");
      assert.equal(await panelOpen(), false);

      await page.click(`.column[data-tone='busy'] .card`);
      await page.until("return !document.getElementById('panel').hidden", "the panel");
      await page.run("scrollTo(0, 400)");
      const scrolled = await page.run<number>("return scrollY");
      assert.ok(scrolled > 100);
      await page.clickAt(40, 450);
      assert.equal(await panelOpen(), false);
      assert.equal(await page.run<number>("return scrollY"), scrolled, "the page keeps its scroll position");
      });
    });

    it("follows a link inside the panel to the linked item, and scrolls a long panel inside itself", async () => {
      await load();
      await page.click(`.card`, await page.run<number>(`return [...document.querySelectorAll('.card')].findIndex((c) => c.querySelector('.id').textContent === ${JSON.stringify(ids.many)})`));
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Depends on twelve other tasks'", "the task with many links");
      assert.equal(await count("#detail .link"), 13);
      const scrolls = await page.run<boolean>("const c = document.querySelector('.panel-card'); return c.scrollHeight > c.clientHeight");
      assert.equal(scrolls, true, "a long panel scrolls");
      const pageY = await page.run<number>("return scrollY");
      await page.run("document.querySelector('.panel-card').scrollTop = 1e6");
      assert.equal(await page.run<number>("return scrollY"), pageY, "scrolling the panel does not scroll the page");
      await page.click("#detail .link", 12);
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Prerequisite 12'", "the linked task");
      await layout("in the panel of a linked task");
      await page.key("Escape");
    });

    it("comes back from a followed link, with the panel's own button and with the browser's Back", async () => {
      await page.size(1280, 900);
      await load();
      const shown = () => text(".detail-title");
      const back = () => page.run<string | null>("return document.querySelector('.back')?.textContent ?? null");
      const openLink = async (title: string) => {
        const index = await page.run<number>(`return [...document.querySelectorAll('#detail .link')].findIndex((l) => l.querySelector('.name').textContent === ${JSON.stringify(title)})`);
        assert.ok(index >= 0, `a link to ${title}`);
        await page.click("#detail .link", index);
        await page.until(`return document.querySelector('.detail-title')?.textContent === ${JSON.stringify(title)}`, `the panel of ${title}`);
      };
      await page.click(".card", await page.run<number>(`return [...document.querySelectorAll('.card')].findIndex((c) => c.querySelector('.id').textContent === ${JSON.stringify(ids.launch)})`));
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Launch the checkout'", "the first task");
      assert.equal(await back(), null, "nothing to go back to yet");
      await openLink("Checkout");
      assert.equal(await back(), `←${ids.launch}Launch the checkout`, "the panel names the task it came from");
      await openLink("Payments");
      assert.equal(await back(), `←${ids.checkout}Checkout`);
      await layout("in a panel opened from another");

      await page.click(".back");
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Checkout'", "the task before, by the panel's button");
      assert.equal(await back(), `←${ids.launch}Launch the checkout`);
      await page.run("history.back()");
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Launch the checkout'", "the first task, by the browser's Back");
      assert.equal(await back(), null);
      await page.run("history.forward()");
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Checkout'", "forward again");
      await page.key("Escape");
      assert.equal(await panelOpen(), false);
      assert.equal(await page.run<string>("return location.hash"), "#board");
      await page.run("history.back()");
      await page.until("return !document.getElementById('panel').hidden && document.querySelector('.detail-title')?.textContent === 'Checkout'", "Back after closing to open the task again");
      assert.equal(await shown(), "Checkout");
      await page.key("Escape");
    });

    it("does everything it does within what its policy allows: nothing of the page is blocked by the browser", async () => {
      await page.size(1280, 900);
      // Whatever the browser refuses because of the policy the page is served with is collected from the first moment.
      const watching = (await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: "window.blocked = []; document.addEventListener('securitypolicyviolation', (event) => window.blocked.push(event.violatedDirective + ' ' + (event.blockedURI || 'inline') + ' ' + (event.sourceFile ?? '') + ':' + event.lineNumber));",
      })) as { identifier: string };
      try {
        await load();
        assert.match((await (await fetch(`${base}/`)).headers.get("content-security-policy")) ?? "", /default-src 'self'/);
        // The theme and the scheme are set before the page is drawn, by a file of the page's own.
        assert.deepEqual(await page.run("return [document.documentElement.dataset.theme, ['light', 'dark'].includes(document.documentElement.dataset.scheme)]"), ["vigile", true]);
        // Styles that the page sets by itself still apply: a project's bar is as wide as its progress.
        const bars = await page.run<number[]>("return [...document.querySelectorAll('.bar i')].map((i) => Math.round(i.getBoundingClientRect().width))");
        assert.ok(bars.some((width) => width > 0), `progress bars have their width: ${bars.join(", ")}`);
        // The panel, the settings with every theme and the background, and the graph.
        await page.run(`document.querySelector('.card[data-id="${ids.address}"]').click()`);
        await page.until("return document.querySelector('.detail-title')?.textContent === 'Address form'", "the panel");
        await page.key("Escape");
        await openSettings();
        for (const theme of ["dado", "jeev", "gito", "vigile"]) await page.run(`[...document.querySelectorAll('.theme')].find((b) => b.dataset.theme === '${theme}' || b.title.toLowerCase().includes('${theme}') || b.textContent.toLowerCase().includes('${theme}'))?.click()`);
        await closeSettings();
        await setting("lights-on");
        await closeSettings();
        await page.wait(300);
        await page.click("#view-graph");
        await graphReady();
        assert.ok((await page.run<number>("return window.vigileGraph.nodes().length")) > 0);
        await page.click("#view-board");
        await page.wait(200);
        assert.deepEqual(await page.run<string[]>("return window.blocked"), [], "the browser blocked nothing");
        assert.deepEqual(page.errors, []);
      } finally {
        await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: watching.identifier });
        await page.run("localStorage.clear()");
        await load();
      }
    });

    it("starts with an address that is cut off, with a stored value that is broken, and in a browser that refuses to store anything", async () => {
      await page.size(1280, 900);
      const shown = () => page.run<{ sync: boolean; cards: number; panel: boolean; view: string }>("return { sync: /^(Updated|Live)/.test(document.getElementById('sync').textContent), cards: document.querySelectorAll('.card').length, panel: !document.getElementById('panel').hidden, view: document.body.classList.contains('graph-view') ? 'graph' : 'board' }");
      // An address whose last part cannot be decoded names no item: the board is shown without a panel.
      for (const address of ["/#board/100%", "/#board/%E0%A4%A"]) {
        await load(address);
        const state = await shown();
        assert.deepEqual([state.sync, state.cards > 0, state.panel, state.view], [true, true, false, "board"], address);
      }
      // The graph's address with nothing after the stroke is the graph.
      await load("/#graph/");
      assert.equal((await shown()).view, "graph");

      // Something else under the name of the watched tasks is taken for none.
      await load();
      await page.run("sessionStorage.setItem('vigile.watching', 'WEB-001')");
      await load();
      assert.equal((await shown()).cards > 0, true);
      assert.equal(await text("#watching"), "");
      await page.run("sessionStorage.setItem('vigile.watching', '{\"not\":\"a list\"}')");
      await load();
      assert.equal((await shown()).cards > 0, true);
      await page.run("sessionStorage.removeItem('vigile.watching')");

      // A browser that refuses storage altogether, as one that blocks all cookies does: every use of it throws.
      const refusing = (await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: "for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name, { configurable: true, get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });",
      })) as { identifier: string };
      try {
        await load();
        const state = await shown();
        assert.deepEqual([state.sync, state.cards > 0], [true, true], "the page shows the plan");
        // Its choices hold for as long as it is open: a setting can be switched, and a task watched.
        await setting("bugs-apart");
        assert.equal(await page.run<boolean>("return document.getElementById('bugs-apart').checked"), true);
        await closeSettings();
      } finally {
        await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: refusing.identifier });
        await load();
      }

      // A browser whose storage can be read and takes no change, as one that has run out of room: a choice that
      // is taken back stays taken back for as long as the page is open, and the value the browser still has
      // does not come back in its place.
      await page.run("localStorage.setItem('vigile.scheme', 'dark')");
      const stuck = (await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: "for (const method of ['setItem', 'removeItem']) Storage.prototype[method] = function () { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };",
      })) as { identifier: string };
      try {
        await load();
        const scheme = () => page.run<[boolean, string]>("return [document.getElementById('scheme-system').checked, document.documentElement.dataset.scheme]");
        assert.deepEqual(await scheme(), [false, "dark"], "the page has the scheme that was chosen for it");
        await setting("scheme-system");
        const system = await page.run<string>("return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'");
        assert.deepEqual(await scheme(), [true, system], "it follows the system again, although the browser kept the old choice");
        assert.equal(await page.run<string | null>("return window.localStorage.getItem('vigile.scheme')"), "dark", "which the browser does still have");
        // And another choice after that holds too.
        await setting("bugs-apart");
        assert.deepEqual(await scheme(), [true, system]);
      } finally {
        await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: stuck.identifier });
        await load();
        await page.run("localStorage.removeItem('vigile.scheme'); localStorage.removeItem('vigile.bugs-apart')");
        await load();
      }
    });

    it("gives every opened task and project an address that can be bookmarked", async () => {
      await load();
      await page.click(".column[data-tone='busy'] .card");
      await page.until("return !document.getElementById('panel').hidden", "the panel");
      assert.equal(await page.run<string>("return location.hash"), `#board/${ids.address}`);
      assert.equal(await page.run<string>("return document.title"), `${ids.address} · Address form · browser-test · Vigile`);
      await load(`/#board/${ids.address}`);
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Address form'", "the task named in the address, after a reload");
      assert.ok((await count(".card")) > 0, "with the board behind it");
      await page.click("#close");
      assert.deepEqual(await page.run("return [location.hash, document.title]"), ["#board", "browser-test · Vigile"]);

      await load(`/#graph/${ids.launch}`);
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Launch the checkout'", "a task opened over the graph");
      await graphReady();
      assert.equal(await text(".views [aria-current]"), "Graph");
      await page.key("Escape");
      assert.equal(await page.run<string>("return location.hash"), "#graph");
      await page.click("#zoom-fit");
      const launch = await nodeAt(`task:${ids.launch}`);
      await page.clickAt(launch.x, launch.y);
      await page.until("return !document.getElementById('panel').hidden", "the panel from a click in the graph");
      assert.equal(await page.run<string>("return location.hash"), `#graph/${ids.launch}`);
      assert.equal(await page.run<boolean>("return Boolean(window.vigileGraph.scratch('settled'))"), true, "opening an item does not draw the graph again");

      await load("/#board/project:WEB");
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Website relaunch'", "a project named in the address");
      await page.key("Escape");
      await page.click(".project .tag-button", 2);
      await page.until("return !document.getElementById('panel').hidden", "the project's panel");
      assert.equal(await page.run<string>("return location.hash"), "#board/project:WEB");
      await page.key("Escape");

      await load("/#board/WEB-999");
      await page.until("return !document.getElementById('panel').hidden", "the panel for an address that names nothing");
      assert.match(await text("#detail"), /WEB-999/);
      assert.ok((await count(".card")) > 0, "the board is still there");
      await layout("in the panel for an unknown item");
      await page.key("Escape");
      assert.deepEqual(page.errors, []);
    });

    it("says in the history what each change was: a bug that was created, moved and rewritten", async () => {
      await page.scheme("light");
      await page.size(1280, 900);
      const group = (await run("create_task", { title: "Holds the bug", description: "d", project: "WEB" })) as { id: string };
      const bug = (await run("create_task", { title: "Created as a bug", description: "first text", project: "WEB", type: "bug" })) as { id: string };
      try {
        await run("add_link", { from: group.id, type: "contains", to: bug.id });
        await run("update_task", { id: bug.id, version: 2, description: "second text", priority: 3 });
        await load(`/#board/${bug.id}`);
        await page.until("return document.querySelector('.detail-title')?.textContent === 'Created as a bug'", "the panel");
        await page.run("document.querySelector('#detail .fold-block').open = true");
        const lines = await page.run<string[]>("return [...document.querySelectorAll('#detail .fold-block li')].map((li) => li.querySelector('.what').textContent + ' | ' + li.querySelector('.change').textContent)");
        assert.deepEqual([...lines].sort(), [`created | as open, type bug, in WEB`, `link added | ${group.id} contains ${bug.id}`, `updated | priority: 0 → 3, description changed`].sort());
      } finally {
        for (const id of [bug.id, group.id]) await run("delete", { id, version: (await run("get", { id })).version });
        await load();
      }
    });

    it("says of a list in the panel that it is not whole, how many there are, and reads on at the click of a button", async () => {
      await page.scheme("light");
      await page.size(1280, 900);
      const made: string[] = [];
      const create = async (title: string, extra: Record<string, unknown> = {}) => {
        const id = (await run("create_task", { title, description: "d", ...extra })).id as string;
        made.push(id);
        return id;
      };
      try {
        // A group of 105 tasks, and a task that changed status 105 times: more than the service returns at once.
        const group = await create("A group of very many");
        for (let n = 1; n <= 105; n++) await create(`Member ${n}`, { parent: group });
        const busy = await create("Back and forth");
        for (let n = 1; n <= 105; n++) await run("set_task_status", { id: busy, version: n, status: n % 2 ? "draft" : "open" });

        await load(`/#board/${group}`);
        await page.until("return document.querySelector('.detail-title')?.textContent === 'A group of very many'", "the panel");
        const contains = () =>
          page.run<{ heading: string; links: number; last: string; button: string | null }>(`
            const relation = document.querySelector('#detail .relation[data-relation="contains"]');
            return { heading: relation.querySelector('h4').textContent, links: relation.querySelectorAll('.link').length, last: [...relation.querySelectorAll('.link .name')].at(-1).textContent, button: relation.querySelector('.further')?.textContent ?? null };
          `);
        assert.deepEqual(await contains(), { heading: "Contains100 of 105", links: 100, last: "Member 100", button: "Show more" }, "a part is shown as a part");
        await layout("in a panel with a list that goes on");
        // With the keyboard: the button is reached like any other, and Enter reads on.
        await page.run("document.querySelector('#detail .relation[data-relation=\"contains\"] .further').focus()");
        await page.key("Enter");
        await page.until("return document.querySelectorAll('#detail .relation[data-relation=\"contains\"] .link').length === 105", "the rest of the links");
        assert.deepEqual(await contains(), { heading: "Contains105", links: 105, last: "Member 105", button: null }, "shown whole, the list says so and offers nothing more");
        assert.equal(await page.run<boolean>("return document.querySelector('.panel-card').contains(document.activeElement)"), true, "the keyboard stays in the panel when the button it was on is gone");

        // Drawn again after a change, the list is read as far as it was shown: the task that came is there.
        await create("Member 106", { parent: group });
        await page.run("document.getElementById('refresh').click()");
        await page.until("return document.querySelectorAll('#detail .relation[data-relation=\"contains\"] .link').length === 106", "the new member in the panel");
        assert.deepEqual(await contains(), { heading: "Contains106", links: 106, last: "Member 106", button: null });

        // Opened anew, an item starts with its first page again.
        await load(`/#board/${busy}`);
        await page.until("return document.querySelector('.detail-title')?.textContent === 'Back and forth'", "the task that changed often");
        const records = () =>
          page.run<{ timeline: number; timelineNote: string | null; changes: string; history: number; historyNote: string | null; first: string; buttons: string[] }>(`
            const timeline = document.querySelector('#detail .timeline').closest('.block');
            const history = document.querySelector('#detail .fold-block');
            return {
              timeline: timeline.querySelectorAll('.timeline li').length, timelineNote: timeline.querySelector('.partial')?.textContent ?? null,
              changes: history.querySelector('summary .count').textContent, history: history.querySelectorAll('.history li').length, historyNote: history.querySelector('.partial')?.textContent ?? null,
              first: history.querySelector('.history li .what').textContent, buttons: [...document.querySelectorAll('#detail .further')].map((b) => b.dataset.list + ': ' + b.textContent),
            };
          `);
        assert.deepEqual(await records(), {
          timeline: 100, timelineNote: "The latest 100 of 106.", changes: "106 changes", history: 100, historyNote: "The latest 100 of 106.", first: "status changed",
          buttons: ["timeline: Show earlier ones", "history: Show earlier ones"],
        });
        await page.run("document.querySelector('#detail .fold-block').open = true");
        await layout("in a panel whose timeline and history go on");
        await page.click("#detail .fold-block .further");
        await page.until("return document.querySelectorAll('#detail .history li').length === 106", "the earlier changes");
        assert.deepEqual(await records(), {
          timeline: 100, timelineNote: "The latest 100 of 106.", changes: "106 changes", history: 106, historyNote: null, first: "created",
          buttons: ["timeline: Show earlier ones"],
        }, "one list read on leaves the other as it was");
        assert.equal(await page.run<boolean>("return document.querySelector('#detail .fold-block').open"), true, "the history stays unfolded");
        await page.click("#detail .further[data-list='timeline']");
        await page.until("return document.querySelectorAll('#detail .timeline li').length === 106", "the earlier statuses");
        assert.deepEqual([(await records()).timelineNote, (await records()).buttons], [null, []]);
        assert.equal(await text("#detail .timeline li:first-child .pill"), "open", "the timeline starts where the task started");
        await layout("in a panel whose lists were read to their end");
        await page.key("Escape");
      } finally {
        for (const id of made.reverse()) await run("delete", { id, version: (await run("get", { id })).version });
        await load();
      }
    });

    it("sets the panel's sections apart as blocks, and folds the history", async () => {
      for (const [width, scheme] of [[1280, "light"], [1280, "dark"], [360, "light"], [360, "dark"]] as const) {
        await page.scheme(scheme);
        await page.size(width, 900, width < 640);
        await load(`/#board/${ids.many}`);
        await page.until("return document.querySelector('.detail-title')?.textContent === 'Depends on twelve other tasks'", "the panel");
        const blocks = await page.run<Array<{ title: string; apart: boolean; padded: boolean; bordered: boolean; gap: number }>>(`
          const card = getComputedStyle(document.querySelector('.panel-card')).backgroundColor;
          const all = [...document.querySelectorAll('#detail .block')];
          return all.map((b, i) => { const s = getComputedStyle(b); return {
            title: b.querySelector('h3')?.textContent ?? 'top',
            apart: s.backgroundColor !== card && s.backgroundColor !== 'rgba(0, 0, 0, 0)',
            padded: parseFloat(s.paddingLeft) >= 10 && parseFloat(s.paddingTop) >= 10,
            bordered: parseFloat(s.borderLeftWidth) >= 1 && parseFloat(s.borderRadius) >= 8,
            gap: i ? Math.round(b.getBoundingClientRect().top - all[i - 1].getBoundingClientRect().bottom) : 8,
          }; });
        `);
        assert.deepEqual(blocks.map((b) => b.title), ["top", "Description", "Links", "Details", "Status timeline", "History"], `the sections at ${width}px, ${scheme}`);
        for (const b of blocks) assert.deepEqual([b.apart, b.padded, b.bordered, b.gap >= 8], [true, true, true, true], `${b.title} is a block of its own at ${width}px, ${scheme}`);
        assert.deepEqual(await page.run("return [...document.querySelectorAll('#detail .relation h4')].map((h) => h.textContent)"), ["Inside1", "Depends on12"], "links are grouped by what they say");
        await layout(`in a panel made of blocks at ${width}px, ${scheme}`);
      }
      await page.scheme("light");
      await page.size(1280, 900);
      await load(`/#board/${ids.checkout}`);
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Checkout'", "a task with a reason");
      assert.equal(await page.run<string>("return document.querySelector('#detail .block.why h3').textContent"), "Why");
      const history = () => page.run<{ open: boolean; height: number }>("const d = document.querySelector('#detail .fold-block'); return { open: d.open, height: Math.round(d.getBoundingClientRect().height) }");
      const folded = await history();
      assert.ok(!folded.open && folded.height < 60, `the history is folded until asked for: ${folded.height}px`);
      const changes = async () => Number(/^History(\d+) changes?$/.exec(await text("#detail .fold-block summary"))?.[1]);
      const before = await changes();
      assert.ok(before >= 1, "the fold says how many changes there are");
      await page.click("#detail .fold-block summary");
      assert.equal((await history()).open, true);
      assert.ok((await history()).height > folded.height + 20, "unfolded, it shows its entries");
      await move(ids.checkout!, "in_progress");
      await page.run("document.getElementById('refresh').click()");
      await page.until(`return document.querySelector('#detail .fold-block summary').textContent === 'History${before + 1} changes'`, "the panel to show the change");
      assert.equal((await history()).open, true, "a refresh keeps the history unfolded");
      await layout("in a panel with its history unfolded");
      await move(ids.checkout!, "open");
      await page.key("Escape");
    });

    it("shows extreme titles and text without breaking the card or the panel, at phone and desktop widths", async () => {
      for (const width of [360, 1280]) {
        await page.size(width, 900, width < 640);
        await load();
        for (const key of ["long", "unbroken"]) {
          const index = await page.run<number>(`for (const m of document.querySelectorAll('.more[aria-expanded="false"]')) m.click(); return [...document.querySelectorAll('.card')].findIndex((c) => c.querySelector('.id').textContent === ${JSON.stringify(ids[key])})`);
          assert.ok(index >= 0);
          const card = await page.box(".card", index);
          assert.ok(card.height < 220, `the ${key} card stays compact: ${card.height}px`);
          if (width < 640) await page.tap(".card", index);
          else await page.click(".card", index);
          await page.until("return !document.getElementById('panel').hidden", "the panel");
          await layout(`in the panel of the ${key} task at ${width}px`);
          await page.key("Escape");
        }
        await layout(`on the board with extreme titles at ${width}px`);
      }
    });

    it("filters as you type, says when nothing matches, and restores the board when cleared", async () => {
      await page.size(1280, 900);
      await load();
      await page.click("#filter");
      await page.type("Prerequisite");
      assert.deepEqual(await columns(), { "In progress": 0, Next: 12, Done: 0 });
      await page.run("document.getElementById('filter').select()");
      await page.type("zzz no such task");
      assert.equal(await count(".column"), 0);
      assert.equal(await text("#empty"), 'No task matches "zzz no such task".');
      await layout("with a filter that matches nothing");
      await page.run("document.getElementById('filter').select()");
      await page.key("Backspace");
      assert.equal((await columns()).Next, 23);
    });

    it("narrows to a project when its card is clicked, and shows an empty project as empty", async () => {
      await load();
      await page.click(".project-main", 2);
      assert.match(await text("#scope"), /in WEB · Website relaunch/);
      assert.match(await text("#summary"), /^53 tasks/);
      await page.click(".project-main", 0);
      assert.equal(await text("#empty"), "No tasks in this project.");
      assert.equal(await count(".column"), 0);
      await layout("in an empty project");
      await page.click(".project-main", 1);
      assert.match(await text("#summary"), /^1 tasks/);
      await layout("in the project with a very long title");
      await page.click(".project-main", 1);
      assert.match(await text("#scope"), /in all projects/);
    });

    it("folds the projects into one small row, which still selects a project, and remembers it", async () => {
      await page.size(1280, 800);
      await load();
      const boardTop = () => page.run<number>("return Math.round(document.getElementById('board').getBoundingClientRect().top)");
      const open = await boardTop();
      assert.equal(await count(".project"), 3);
      await page.click("#projects-fold");
      assert.equal(await page.run<string | null>("return document.getElementById('projects-fold').getAttribute('aria-expanded')"), "false");
      assert.deepEqual(await page.run<string[]>("return [...document.querySelectorAll('.project-chip')].map((c) => c.textContent)"), ["EMPTY0/0", "LONGNAME0/1", "WEB23/53"]);
      assert.equal(await count(".project"), 0);
      const folded = await boardTop();
      assert.ok(open - folded > 90, `the board moves up by the room the cards took: ${open - folded}px`);
      assert.ok(await page.run<boolean>("const b = document.getElementById('board').getBoundingClientRect(); return b.bottom <= innerHeight && b.bottom > innerHeight - 30"), "and still reaches the bottom of the window");
      const row = await page.run<number>("return Math.round(document.getElementById('projects-section').getBoundingClientRect().height)");
      assert.ok(row <= 40, `the folded projects are one small row: ${row}px`);
      await page.click(".project-chip", 2);
      assert.match(await text("#scope"), /in WEB · Website relaunch/);
      assert.equal(await page.run<string | null>("return document.querySelectorAll('.project-chip')[2].getAttribute('aria-pressed')"), "true");
      await layout("with the projects folded");
      await page.click(".project-chip", 2);
      assert.match(await text("#scope"), /in all projects/);
      await load("/#graph");
      await graphReady();
      assert.equal(await count(".project-chip"), 3, "the choice survives a reload, and holds in the graph view");
      await layout("in the graph with the projects folded");
      await page.size(360, 780, true);
      await load();
      await layout("with the projects folded on a phone");
      await page.size(1280, 800);
      await page.run("document.getElementById('projects-fold').focus()");
      await page.key("Enter");
      assert.equal(await count(".project"), 3, "unfolded again, from the keyboard");
      assert.equal(await page.run<string | null>("return localStorage.getItem('vigile.projects')"), "open");
      await page.run("localStorage.removeItem('vigile.projects')");
      await page.size(1280, 900);
    });

    it("shows a long column's first 12 cards and the rest on request, when the page scrolls as a whole", async () => {
      await wholePage(async () => {
        assert.equal(await count(".column[data-tone='go'] .card"), 24);
        await page.click(".column[data-tone='go'] .more", 0);
        assert.equal(await count(".column[data-tone='go'] .card"), 35);
        await page.click(".column[data-tone='go'] .more", 0);
        assert.equal(await count(".column[data-tone='go'] .card"), 24);
        await layout("on a board that scrolls as a whole");
      });
    });

    it("scrolls each column by itself and keeps the rest of the page in view, unless switched off", async () => {
      await page.size(1280, 800);
      await load();
      assert.equal(await page.run<boolean>("return document.getElementById('column-scroll').checked"), true, "columns scroll by themselves unless switched off");
      const fit = () => page.run<{ pageScrolls: boolean; bottom: number; height: number }>("const b = document.getElementById('board').getBoundingClientRect(); return { pageScrolls: document.documentElement.scrollHeight > innerHeight, bottom: Math.round(b.bottom), height: Math.round(b.height) }");
      const first = await fit();
      assert.equal(first.pageScrolls, false, "the page itself has nothing to scroll");
      assert.ok(first.bottom <= 800 && first.bottom > 770, `the board reaches the bottom of the window: ${first.bottom}`);

      const next = "[...document.querySelectorAll('.column')].find((c) => c.querySelector('.column-head').childNodes[1].textContent === 'Next')";
      assert.deepEqual(await page.run(`const c = ${next}; const cards = c.querySelector('.cards'); return { cards: c.querySelectorAll('.card').length, scrolls: cards.scrollHeight > cards.clientHeight, more: Boolean(c.querySelector('.more')), inside: c.getBoundingClientRect().bottom <= document.getElementById('board').getBoundingClientRect().bottom }`), { cards: 23, scrolls: true, more: false, inside: true });
      const headTop = () => page.run<number>(`return Math.round(${next}.querySelector('.column-head').getBoundingClientRect().top)`);
      const before = await headTop();
      const middle = await page.run<{ x: number; y: number }>(`const r = ${next}.querySelector('.cards').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }`);
      await page.wheelUntil(middle.x, middle.y, 500, 0, `return ${next}.querySelector('.cards').scrollTop > 100`, "the column to scroll under the wheel");
      assert.deepEqual(await page.run(`return { page: scrollY, others: [...document.querySelectorAll('.cards')].filter((c) => c.scrollTop > 0).length }`), { page: 0, others: 1 }, "only that column moved");
      assert.equal(await headTop(), before, "the column's title stays where it is");
      await page.run(`${next}.querySelector('.cards').scrollTop = 1e6`);
      const last = await page.run<number>(`const cards = [...document.querySelectorAll('.card')]; return cards.indexOf([...${next}.querySelectorAll('.card')].at(-1))`);
      await page.click(".card", last);
      await page.until("return !document.getElementById('panel').hidden", "the panel of the column's last card");
      await page.key("Escape");
      await layout("with columns that scroll by themselves");

      await page.size(1280, 1100);
      await page.until("return Math.abs(document.getElementById('board').getBoundingClientRect().bottom - 1088) < 3", "the board to follow a taller window");
      await page.size(1280, 560);
      await page.until("return Math.round(document.getElementById('board').getBoundingClientRect().height) === 360", "the board to keep a usable height in a short window");
      assert.equal((await fit()).pageScrolls, true, "in a short window the page scrolls the little that is needed");
      await layout("with scrolling columns in a short window");
      await page.size(1280, 800);

      await setting("column-scroll");
      assert.deepEqual(await page.run(`const c = ${next}; return { cards: c.querySelectorAll('.card').length, more: c.querySelector('.more')?.textContent, pageScrolls: document.documentElement.scrollHeight > innerHeight, stored: localStorage.getItem('vigile.scroll') }`), { cards: 12, more: "Show all 23", pageScrolls: true, stored: "page" });
      await load();
      assert.equal(await page.run<boolean>("return document.getElementById('column-scroll').checked"), false, "the choice survives a reload");
      await setting("column-scroll");
      assert.equal((await fit()).pageScrolls, false);

      await page.size(390, 844, true);
      await load();
      await page.tap("#settings");
      assert.equal(await settingsOpen(), true);
      assert.deepEqual(await page.run(`return { choice: Math.round(document.getElementById('column-scroll-choice').getBoundingClientRect().width), pageScrolls: document.documentElement.scrollHeight > innerHeight, cards: ${next}.querySelectorAll('.card').length }`), { choice: 0, pageScrolls: true, cards: 12 }, "on a phone the columns are stacked and the page scrolls, so the settings do not offer the choice");
      await page.run("localStorage.removeItem('vigile.scroll')");
      await page.size(1280, 900);
    });

    it("shows a group's progress, opens only that group, and leaves it again", async () => {
      await load();
      const index = await page.run<number>(`return [...document.querySelectorAll('.card')].findIndex((c) => c.querySelector('.id').textContent === ${JSON.stringify(ids.checkout)})`);
      assert.match(await page.run<string>(`return document.querySelectorAll('.card')[${index}].textContent`), /1\/7 done/);
      await page.click(".card", index);
      await page.until("return Boolean(document.querySelector('.open-group'))", "the group's panel");
      await page.click(".open-group");
      assert.equal(await panelOpen(), false);
      assert.match(await text("#summary"), /^7 tasks/);
      assert.match(await text("#scope"), /Checkout/);
      await layout("inside a group");
      await page.click("#scope .tag-button");
      assert.match(await text("#summary"), /^55 tasks/);
    });

    it("greys out the other projects while one is selected, as cards and as the folded row", async () => {
      await page.size(1280, 900);
      await load();
      /** Runs in the page: each project as drawn, and whether its name can be read on its background. */
      const LOOK = `
        const lum = (colour) => { const scale = colour.startsWith("color(") ? 1 : 1 / 255; const [r, g, b] = colour.match(/[\\d.]+/g).slice(0, 3).map((v) => Number(v) * scale).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
        return [...document.querySelectorAll(".project, .project-chip")].map((p) => {
          const style = getComputedStyle(p);
          const name = getComputedStyle(p.querySelector(".project-title, .project-id"));
          return [p.querySelector(".project-id").textContent, p.classList.contains("selected") ? "selected" : style.filter.includes("grayscale") ? "grey" : "plain", ratio(name.color, style.backgroundColor) >= 4.5 ? "readable" : "hard to read: " + name.color + " on " + style.backgroundColor].join(" ");
        });
      `;
      try {
        assert.deepEqual(await page.run<string[]>(LOOK), ["EMPTY plain readable", "LONGNAME plain readable", "WEB plain readable"], "with no project selected, all look as usual");
        await page.click(".project-main", 2);
        for (const scheme of ["light", "dark"] as const) {
          await page.scheme(scheme);
          for (const name of ["vigile", "dado", "jeev", "gito"]) {
            await page.run(`document.documentElement.dataset.theme = ${JSON.stringify(name)}`);
            assert.deepEqual(await page.run<string[]>(LOOK), ["EMPTY grey readable", "LONGNAME grey readable", "WEB selected readable"], `the others are greyed out and can still be read in ${name}, ${scheme}`);
          }
        }
        await page.scheme("light");
        await page.run("document.documentElement.dataset.theme = 'vigile'");
        await layout("with one project selected and the others greyed out");
        // Folded into one row, the same.
        await page.click("#projects-fold");
        assert.deepEqual(await page.run<string[]>(LOOK), ["EMPTY grey readable", "LONGNAME grey readable", "WEB selected readable"]);
        await layout("with the projects folded, one selected");
        await page.click("#projects-fold");
        // A greyed-out project can still be chosen, and choosing the selected one again shows them all as usual.
        await page.click(".project-main", 0);
        assert.deepEqual((await page.run<string[]>(LOOK)).map((line) => line.split(" ").slice(0, 2).join(" ")), ["EMPTY selected", "LONGNAME grey", "WEB grey"]);
        await page.click(".project-main", 0);
        assert.deepEqual(await page.run<string[]>(LOOK), ["EMPTY plain readable", "LONGNAME plain readable", "WEB plain readable"]);
      } finally {
        await page.scheme("light");
        await page.run("document.documentElement.dataset.theme = 'vigile'; localStorage.removeItem('vigile.projects')");
      }
    });

    it("uses one kind of switch for every on/off choice", async () => {
      for (const view of ["/", "/#graph"]) {
        await load(view);
        if (view !== "/") await graphReady();
        await openSettings();
        const choices = await page.run<Array<{ id: string; role: string | null; track: string; label: string; seen: boolean }>>(`
          return [...document.querySelectorAll('input[type="checkbox"]')].map((input) => {
            const label = input.closest('label');
            const track = label?.querySelector('.track');
            const box = track?.getBoundingClientRect();
            return { id: input.id, role: input.getAttribute('role'), track: track ? Math.round(box.width) + 'x' + Math.round(box.height) : '', label: label?.textContent.trim() ?? '', seen: Boolean(box && box.width) };
          });
        `);
        assert.deepEqual(choices.map((c) => c.id), ["auto", "column-scroll", "bugs-apart", "sound-created", "sound-started", "sound", "motion", "lights-on", "scheme-system", "scheme-dark", "collapse-groups", "hide-finished"]);
        for (const choice of choices) assert.deepEqual([choice.role, choice.label.length > 3], ["switch", true], `${choice.id} is a switch with a label`);
        assert.deepEqual(
          await page.run("return ['sound-created', 'sound-started', 'sound', 'lights-on'].map((id) => document.getElementById(id).getAttribute('aria-label'))"),
          ["Sound when a task is created", "Sound when a task is started", "Sound when a task is completed", "Moving background"],
          "a switch whose name on screen leans on its drawing has a full name for those who cannot see it",
        );
        assert.equal(new Set(choices.filter((c) => c.seen).map((c) => c.track)).size, 1, "every switch in sight is drawn the same");
        assert.deepEqual(choices.filter((c) => c.seen).map((c) => c.id), view === "/" ? ["auto", "column-scroll", "bugs-apart", "sound-created", "sound-started", "sound", "motion", "lights-on", "scheme-system"] : ["auto", "column-scroll", "bugs-apart", "sound-created", "sound-started", "sound", "motion", "lights-on", "scheme-system", "collapse-groups", "hide-finished"]);
      }
      await load();
      await openSettings();
      await page.run("document.getElementById('bugs-apart').focus()");
      await page.key("Space");
      assert.equal(await count(".column[data-tone='bug']"), 1, "a switch is turned with the space bar");
      await page.key("Space");
      assert.equal(await count(".column[data-tone='bug']"), 0);
      await closeSettings();
    });

    it("can be used with the keyboard alone", async () => {
      await load();
      await page.run("document.querySelector('.card').focus()");
      await page.key("Enter");
      await page.until("return !document.getElementById('panel').hidden", "the panel, opened with Enter");
      await page.key("Escape");
      assert.equal(await panelOpen(), false);
      await page.run("document.getElementById('view-graph').focus()");
      await page.key("Enter");
      await page.until("return location.hash === '#graph'", "the graph, chosen with Enter");
      await page.run("document.getElementById('view-board').focus()");
      await page.key("Enter");
      await page.until("return location.hash === '#board'", "the board, chosen with Enter");
    });

    it("gives the keyboard to the panel when it opens, keeps it there, and gives it back when it closes", async () => {
      await page.size(1280, 900);
      await load();
      const where = () => page.run<string>("const at = document.activeElement; return at === document.body ? 'body' : at.closest('#panel') ? 'panel:' + (at.id || at.className.split(' ')[0] || at.tagName) : at.closest('#board') ? 'board:' + (at.dataset.id ?? at.className) : at.tagName");
      await page.run(`document.querySelector('.card[data-id="${ids.card}"]').focus({ preventScroll: true })`);
      await page.key("Enter");
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Card form'", "the panel, opened with Enter");
      assert.equal(await where(), "panel:panel-card", "the keyboard is in the panel, on the dialog itself");
      // Tab walks the panel's controls and comes round again, without ever reaching the board behind it.
      const seen: string[] = [];
      for (let press = 0; press < 12; press++) {
        await page.key("Tab");
        seen.push(await where());
      }
      assert.equal(seen[0], "panel:close", "the first control is the one that closes the panel");
      assert.deepEqual(seen.filter((place) => !place.startsWith("panel:")), [], `Tab stayed in the panel: ${seen.join(", ")}`);
      assert.ok(seen.slice(1).includes("panel:close"), "and came round to the first control again");
      // Backwards from the first control goes to the last one.
      await page.run("document.getElementById('close').focus()");
      await page.key("Tab", true);
      const last = await where();
      assert.ok(last.startsWith("panel:") && last !== "panel:close", `Shift and Tab from the first control went to ${last}`);
      // Closed, the keyboard is back on the card the panel was opened from, and Enter opens it again.
      await page.key("Escape");
      assert.equal(await panelOpen(), false);
      assert.equal(await where(), `board:${ids.card}`);
      await page.key("Enter");
      await page.until("return !document.getElementById('panel').hidden", "the panel, opened again from where the keyboard was put back");
      await page.key("Escape");

      // An item that cannot be shown, such as one from a bookmark that was deleted for good since: the panel says
      // so, and it is a dialog all the same. The keyboard is in it, and Tab does not reach the page behind it.
      await load("/#board/WEB-999");
      await page.until("return Boolean(document.querySelector('#detail .empty')) && !document.getElementById('panel').hidden", "the panel to say that there is no such item");
      assert.equal(await where(), "panel:panel-card", "the keyboard is in the panel");
      const tabbed: string[] = [];
      for (let press = 0; press < 4; press++) {
        await page.key("Tab");
        tabbed.push(await where());
      }
      assert.deepEqual(tabbed.filter((place) => !place.startsWith("panel:")), [], `Tab stayed in the panel: ${tabbed.join(", ")}`);
      await page.key("Escape");
      assert.equal(await panelOpen(), false);

      // Opened from a control that is neither on the board nor among the projects, such as the header's
      // "watching": the keyboard goes back to that one too.
      // A task that is not finished: a finished one is no longer watched.
      await page.run(`sessionStorage.setItem('vigile.watching', ${JSON.stringify(JSON.stringify([ids.address]))})`);
      try {
        await load();
        await page.until("return !document.getElementById('watching').hidden", "the header to say what is watched");
        await page.run("document.getElementById('watching').focus({ preventScroll: true })");
        await page.key("Enter");
        await page.until("return document.querySelector('.detail-title')?.textContent === 'Address form'", "the panel, opened from the header");
        assert.equal(await where(), "panel:panel-card");
        await page.key("Escape");
        assert.equal(await panelOpen(), false);
        assert.equal(await page.run<string>("return document.activeElement.id"), "watching", "the keyboard is back on the control the panel was opened from");
      } finally {
        await page.run("sessionStorage.removeItem('vigile.watching')");
      }
    });

    it("leaves the open panel as it is when something else changes: what is selected stays selected, and the keyboard stays put", async () => {
      await page.size(1280, 900);
      const panel = () =>
        page.run<{ same: boolean; selected: number; focus: string; priority: string }>(
          "const watch = [...document.querySelectorAll('#detail button')].find((b) => /Tell me when/.test(b.textContent)); return { same: document.querySelector('#detail .detail').dataset.mark === 'kept', selected: String(getSelection()).length, focus: document.activeElement === watch ? 'watch' : document.activeElement.tagName, priority: [...document.querySelectorAll('#detail dt')].find((dt) => dt.textContent === 'Priority')?.nextElementSibling.textContent ?? '' }",
        );
      const other = (await run("create_task", { title: "Changes elsewhere", description: "d", project: "WEB" })) as { id: string };
      const twice: string[] = [];
      try {
        await load();
        await setting("auto");
        await closeSettings();
        await load(`/#board/${ids.address}`);
        await page.until("return document.querySelector('.detail-title')?.textContent === 'Address form'", "the panel");
        await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
        // Someone has text of the panel selected, and the keyboard on its watch button.
        await page.run("document.querySelector('#detail .detail').dataset.mark = 'kept'; [...document.querySelectorAll('#detail button')].find((b) => /Tell me when/.test(b.textContent)).focus(); getSelection().selectAllChildren(document.querySelector('#detail .detail-title'))");
        const before = await panel();
        assert.deepEqual([before.same, before.selected > 0, before.focus], [true, true, "watch"]);
        // Another task changes. The board shows it; the panel is not touched.
        await move(other.id, "in_progress");
        await page.until(`return document.querySelector('.column[data-key="in_progress"] .card[data-id="${other.id}"]') !== null`, "the change to appear on the board", 4000);
        await page.wait(800);
        assert.deepEqual(await panel(), before, "the panel is the very same, with its selection and the keyboard where they were");
        // The open task itself changes: the panel is drawn again, and the keyboard is on the same button of the new drawing.
        const current = await run("get", { id: ids.address });
        await run("update_task", { id: ids.address, version: current.version, priority: current.priority + 1 });
        await page.until(`return [...document.querySelectorAll('#detail dt')].find((dt) => dt.textContent === 'Priority')?.nextElementSibling.textContent === '${current.priority + 1}'`, "the panel to show the new priority", 4000);
        const after = await panel();
        assert.deepEqual([after.same, after.focus], [false, "watch"], "drawn anew, with the keyboard on the watch button again");
        // The fold of the history counts its entries in its label, which every change makes say something else:
        // the keyboard stays on it all the same.
        const label = () => text("#detail .fold-block summary");
        await page.run("document.querySelector('#detail .fold-block summary').focus()");
        const counted = await label();
        await run("update_task", { id: ids.address, version: current.version + 1, priority: current.priority });
        await page.until(`return document.querySelector('#detail .fold-block summary').textContent !== ${JSON.stringify(counted)}`, "the history to count one more change", 4000);
        assert.equal(await page.run<string>("return document.activeElement.tagName + ' ' + (document.activeElement.closest('.fold-block') ? 'of the history' : 'elsewhere')"), "SUMMARY of the history");

        // A task that both holds another and waits for it has two links to it, one under each heading. The
        // keyboard stays on the one it was on, not on the first that leads to the same task.
        const group = (await run("create_task", { title: "Holds and waits for the same task", description: "d", project: "WEB" })) as { id: string };
        const inside = (await run("create_task", { title: "Held and waited for", description: "d", parent: group.id })) as { id: string };
        twice.push(inside.id, group.id);
        await run("add_link", { from: group.id, type: "depends_on", to: inside.id });
        await load(`/#board/${group.id}`);
        const both = `[...document.querySelectorAll('#detail .relation button.link')].filter((link) => link.querySelector('.id').textContent === ${JSON.stringify(inside.id)})`;
        await page.until(`return document.querySelector('.detail-title')?.textContent === 'Holds and waits for the same task' && ${both}.length === 2`, "the panel with both links");
        const relations = await page.run<string[]>(`return ${both}.map((link) => link.closest('.relation').dataset.relation)`);
        assert.equal(new Set(relations).size, 2, `a link to it under each of two headings: ${relations.join(", ")}`);
        await page.run(`${both}.at(-1).focus()`);
        const held = (await run("get", { id: group.id })) as { version: number; priority: number };
        await run("update_task", { id: group.id, version: held.version, priority: held.priority + 1 });
        await page.until(`return [...document.querySelectorAll('#detail dt')].find((dt) => dt.textContent === 'Priority')?.nextElementSibling.textContent === '${held.priority + 1}'`, "the panel to be drawn again", 4000);
        assert.equal(await page.run<string>("return document.activeElement.closest('.relation')?.dataset.relation ?? 'elsewhere'"), relations.at(-1), "the keyboard is on the link under the same heading");
      } finally {
        for (const id of twice) await run("delete", { id, version: (await run("get", { id })).version });
        await run("delete", { id: other.id, version: (await run("get", { id: other.id })).version });
        await page.run("localStorage.removeItem('vigile.auto-refresh')");
        await load();
      }
    });

    it("works by touch on a phone", async () => {
      await page.size(390, 844, true);
      await load();
      await page.tap(".card");
      await page.until("return !document.getElementById('panel').hidden", "the panel, opened with a tap");
      const panel = await page.box(".panel-card");
      assert.ok(panel.width >= 388, "the panel fills a phone screen");
      await layout("in the panel on a phone");
      await page.tap("#close");
      assert.equal(await panelOpen(), false);
      await page.tap("#view-graph");
      await graphReady();
      await layout("in the graph on a phone");
      await page.tap("#view-board");
      await page.until("return document.querySelectorAll('.card').length > 0 && document.getElementById('board').getBoundingClientRect().height > 0", "the board");
      await page.size(1280, 900);
    });
  });

  browserSuite("reading on in the panel, while other things happen", () => {
    /** A group of 205 tasks: three pages of what it contains, and a history of 206 changes. */
    let group: string;
    const made: string[] = [];
    const create = async (title: string, extra: Record<string, unknown> = {}) => {
      const id = (await run("create_task", { title, description: "d", ...extra })).id as string;
      made.push(id);
      return id;
    };

    before(async () => {
      group = await create("A group to read on in");
      for (let n = 1; n <= 205; n++) await create(`Part ${n}`, { parent: group });
    });
    after(async () => {
      for (const id of made.reverse()) await run("delete", { id, version: (await run("get", { id })).version }).catch(() => {});
      await load();
    });

    /**
     * Puts a gate in front of the page's requests, for a test to hold an answer back, to keep a request from
     * being sent until the test lets it go, to make a request fail, to answer in the service's place or to change
     * what is sent. `whole` is a reading of an item from the start,
     * `further` one of a next page; `once` lets a test apply to the first request it fits and to no later one.
     */
    const GATE = `
      window.realFetch ??= window.fetch;
      const get = (call) => call.path === '/api/get';
      window.whole = (call) => get(call) && !call.body.continuation;
      window.further = (call) => get(call) && Boolean(call.body.continuation);
      window.once = (test) => { let done = false; return (call) => !done && Boolean(test(call)) && (done = true); };
      window.gate = { hold: null, wait: null, fail: null, answer: null, change: null, held: [], waiting: [], calls: [] };
      window.fetch = async (url, options) => {
        const call = { path: new URL(String(url), location.href).pathname, body: options?.body ? JSON.parse(options.body) : null };
        window.gate.calls.push(call);
        if (window.gate.fail?.(call)) throw new TypeError('Failed to fetch');
        const made = window.gate.answer?.(call, url, options);
        if (made) return made;
        const changed = window.gate.change?.(call);
        if (window.gate.wait?.(call)) await new Promise((go) => window.gate.waiting.push(go));
        const response = await window.realFetch(url, changed ? { ...options, body: JSON.stringify(changed) } : options);
        if (window.gate.hold?.(call)) await new Promise((release) => window.gate.held.push(release));
        return response;
      };
    `;
    const gate = (set: string) => page.run(`window.gate.${set}`);
    const held = (answers: number) => page.until(`return window.gate.held.length === ${answers}`, `${answers} answer(s) to be held back`);
    const release = () => page.run("window.gate.held.splice(0).forEach((release) => release())");
    const waiting = (requests: number) => page.until(`return window.gate.waiting.length === ${requests}`, `${requests} request(s) to wait before being sent`);
    const letGo = () => page.run("window.gate.waiting.splice(0).forEach((go) => go())");
    const asked = (which: "whole" | "further") => page.run<number>(`return window.gate.calls.filter(window.${which}).length`);
    const press = (selector: string) => page.run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const MORE = '#detail .relation[data-relation="contains"] .further';
    const EARLIER = "#detail .fold-block .further";
    const shown = () =>
      page.run<{ hidden: boolean; title: string | null; version: string | null; priority: string | null; contains: string | null; links: number; more: string | null; history: number; changes: string | null; trouble: string | null; empty: string | null; retry: boolean }>(`
        const detail = document.getElementById('detail');
        const relation = detail.querySelector('.relation[data-relation="contains"]');
        const fact = (name) => [...detail.querySelectorAll('.facts dt')].find((dt) => dt.textContent === name)?.nextElementSibling.textContent ?? null;
        const history = detail.querySelector('.fold-block');
        return {
          hidden: document.getElementById('panel').hidden,
          title: detail.querySelector('.detail-title')?.textContent ?? null,
          version: fact('Version'), priority: fact('Priority'),
          contains: relation?.querySelector('h4 .count').textContent ?? null,
          links: relation ? relation.querySelectorAll('.link').length : 0,
          more: relation?.querySelector('.further')?.textContent ?? null,
          history: history ? history.querySelectorAll('.history li').length : 0,
          changes: history?.querySelector('summary .count').textContent ?? null,
          trouble: detail.querySelector('.not-read p')?.textContent ?? null,
          empty: detail.querySelector('.empty')?.textContent ?? null,
          retry: Boolean(detail.querySelector('.retry')),
        };
      `);
    const links = (count: number, what: string) => page.until(`return document.querySelectorAll('#detail .relation[data-relation="contains"] .link').length === ${count} && !document.getElementById('panel').hidden`, what);
    /** Opens the group in a page that was loaded anew, at its first page, with the gate in place. */
    const open = async (id = group) => {
      await page.scheme("light");
      await page.size(1280, 900);
      await load(`/#board/${id}`);
      await page.until("return Boolean(document.querySelector('#detail .detail-title'))", "the panel");
      await page.run(GATE);
      return (await shown()).title!;
    };
    const rename = async (title: string) => (await run("update_task", { id: group, version: (await run("get", { id: group })).version, title })).version as number;
    /** The panel as it opens: the first page of each list, each saying that it is a part. A change to the group adds to its history, which is counted where it matters. */
    const first = { contains: "100 of 205", links: 100, more: "Show more", history: 100, trouble: null, empty: null, retry: false };
    const part = (state: Awaited<ReturnType<typeof shown>>) => ({ contains: state.contains, links: state.links, more: state.more, history: state.history, trouble: state.trouble, empty: state.empty, retry: state.retry });
    const changes = async () => (await run("get", { id: group, history: true })).more.history.total as number;

    it("shows the item as it is now, with the page that was asked for, when \"Show more\" is clicked while the panel is being read again", async () => {
      const was = await open();
      assert.deepEqual(part(await shown()), first);
      // The item changes, and the reading of it that the refresh sets off is on its way when more is asked for.
      await gate("hold = window.once(window.whole)");
      const version = await rename(`${was}, renamed while read`);
      await press("#refresh");
      await held(1);
      await press(MORE);
      await page.wait(300);
      assert.deepEqual([(await shown()).title, (await shown()).links, await asked("further")], [was, 100, 0], "the page that was asked for waits for the reading that is under way");
      await release();
      await links(200, "the item as it is now, with two pages");
      const now = await shown();
      assert.deepEqual([now.title, now.version, now.contains, now.more, now.trouble], [`${was}, renamed while read`, String(version), "200 of 205", "Show more", null]);
      assert.deepEqual([await asked("whole"), await asked("further")], [1, 1], "one reading read the item and the page");
      await rename(was);
    });

    it("never draws a page that was asked for earlier over the item as it was read since, nor over the panel opened anew", async () => {
      const was = await open();
      // A page is on its way when the item changes and the panel is read again: the later reading has the page too.
      await gate("hold = window.once(window.further)");
      await press(MORE);
      await held(1);
      const version = await rename(`${was}, renamed since`);
      await press("#refresh");
      await page.until(`return document.querySelector('#detail .detail-title')?.textContent === ${JSON.stringify(`${was}, renamed since`)}`, "the item as it is now");
      await links(200, "with the page that was asked for");
      await release();
      await page.wait(400);
      const now = await shown();
      assert.deepEqual([now.title, now.version, now.contains], [`${was}, renamed since`, String(version), "200 of 205"], "the earlier answer changed nothing when it came");
      await rename(was);

      // The panel is closed while a page is on its way: the answer is dropped, and nothing opens by itself.
      await gate("hold = window.once(window.further)");
      await press(MORE);
      await held(1);
      await page.key("Escape");
      await release();
      await page.wait(300);
      assert.equal((await shown()).hidden, true);
      // Opened again, the item starts at its first page.
      await page.click(`.card[data-id="${group}"]`);
      await links(100, "the group opened again");
      assert.deepEqual(part(await shown()), first);

      // Closed and opened again while a page is on its way: the page belongs to the panel that was closed.
      await gate("hold = window.once(window.further)");
      await press(MORE);
      await held(1);
      await page.key("Escape");
      await page.click(`.card[data-id="${group}"]`);
      await links(100, "the group opened anew");
      await release();
      await page.wait(400);
      assert.deepEqual(part(await shown()), first, "the page that was asked for in the panel that was closed is not added to this one");

      // Another item is opened while a page is on its way: it stays, and coming back starts at the first page.
      await gate("hold = window.once(window.further)");
      await press(MORE);
      await held(1);
      await press('#detail .relation[data-relation="contains"] .link');
      await page.until("return document.querySelector('#detail .detail-title')?.textContent === 'Part 1'", "the task that was opened from the panel");
      await release();
      await page.wait(300);
      assert.equal((await shown()).title, "Part 1");
      await press("#detail .back");
      await links(100, "the group again");
      assert.deepEqual([(await shown()).title, part(await shown())], [was, first]);
    });

    it("reads every page that was asked for while another was on its way, of the same list and of another, and reads nothing twice", async () => {
      await open();
      const recorded = await changes();
      await gate("hold = window.once(window.further)");
      await press(MORE);
      await held(1);
      // Twice more of what the group contains, which is all there is of it, and once more of its history.
      await press(MORE);
      await press(EARLIER);
      await release();
      await page.until("return document.querySelectorAll('#detail .history li').length === 200", "the earlier changes");
      await links(205, "all that the group contains");
      const now = await shown();
      assert.deepEqual([part(now), now.changes], [{ contains: "205", links: 205, more: null, history: 200, trouble: null, empty: null, retry: false }, `${recorded} changes`]);
      assert.equal(await text("#detail .fold-block .partial"), `The latest 200 of ${recorded}.`);
      assert.deepEqual([await asked("whole"), await asked("further")], [0, 3], "three pages were read, and what the panel showed was not read again");
      // A list that has ended is asked for no further, however often it was asked for: the rest of the history comes alone.
      await press(EARLIER);
      await page.until(`return document.querySelectorAll('#detail .history li').length === ${recorded}`, "the history to its beginning");
      assert.deepEqual([(await shown()).links, await asked("further"), await count("#detail .further")], [205, 4, 0]);
    });

    it("says so when a further page cannot be read, keeps what was read, and reads on when asked again or at the next refresh", async () => {
      const was = await open();
      await gate("fail = window.further");
      // With the keyboard, from the button under the list.
      await page.run(`document.querySelector(${JSON.stringify(MORE)}).focus()`);
      await page.key("Enter");
      await page.until("return Boolean(document.querySelector('#detail .not-read'))", "the panel to say that it could not read on");
      const failed = await shown();
      assert.deepEqual([failed.title, part(failed)], [was, { ...first, trouble: "Cannot reach the service. This is the item as it was read before.", retry: true }], "what was read is all there, and the list still says that it is a part");
      assert.equal(await page.run<string>("return document.activeElement.className"), "further", "the keyboard is where it was");
      // The message is in sight wherever the panel is scrolled to.
      for (const top of [0, 1_000_000]) {
        const inSight = await page.run<boolean>(`
          const card = document.querySelector('.panel-card'); card.scrollTop = ${top};
          const note = document.querySelector('#detail .not-read').getBoundingClientRect(); const box = card.getBoundingClientRect();
          return note.top >= box.top && note.bottom <= box.bottom && note.height > 20;
        `);
        assert.equal(inSight, true, `the message is in sight with the panel scrolled to ${top}`);
      }
      await layout("in a panel that could not read on");
      // Asked again while it still cannot: said again, once, and nothing is lost.
      await press("#detail .retry");
      await page.wait(300);
      assert.deepEqual([part(await shown()), await count("#detail .not-read")], [{ ...first, trouble: "Cannot reach the service. This is the item as it was read before.", retry: true }, 1]);
      // Asked again when it can: the item with the page that was asked for, and no message.
      await gate("fail = null");
      await page.run("document.querySelector('#detail .retry').focus()");
      await page.key("Enter");
      await links(200, "the page that could not be read before");
      assert.deepEqual([(await shown()).contains, (await shown()).trouble, (await shown()).retry], ["200 of 205", null, false]);
      assert.equal(await page.run<boolean>("return document.querySelector('.panel-card').contains(document.activeElement)"), true, "the keyboard stays in the panel when the button it was on is gone");

      // The service answers with an error of its own: said in its words. The refresh button then reads the panel
      // again although nothing on the board has changed.
      await gate(`answer = (call) => window.further(call) && new Response(JSON.stringify({ error: { code: 'internal', message: 'The service hit an unexpected error.' } }), { status: 500, headers: { 'content-type': 'application/json' } })`);
      await press(MORE);
      await page.until("return Boolean(document.querySelector('#detail .not-read'))", "the panel to say that the service failed");
      assert.deepEqual([(await shown()).trouble, (await shown()).links, (await shown()).contains], ["The service answered with an error: The service hit an unexpected error. This is the item as it was read before.", 200, "200 of 205"]);
      await gate("answer = null");
      await press("#refresh");
      await links(205, "the rest, read at the refresh");
      assert.deepEqual([(await shown()).contains, (await shown()).more, (await shown()).trouble], ["205", null, null]);

      // The item changes and cannot be read again: the panel says so beside the item as it was read, pages and
      // all, and shows it as it is once it can be read.
      await gate("fail = window.whole");
      const version = await rename(`${was}, renamed out of reach`);
      await press("#refresh");
      await page.until("return Boolean(document.querySelector('#detail .not-read'))", "the panel to say that it could not read the item again");
      assert.deepEqual([(await shown()).title, (await shown()).links, (await shown()).trouble], [was, 205, "Cannot reach the service. This is the item as it was read before."]);
      await gate("fail = null");
      await press("#refresh");
      await page.until(`return document.querySelector('#detail .detail-title')?.textContent === ${JSON.stringify(`${was}, renamed out of reach`)}`, "the item as it is now");
      assert.deepEqual([(await shown()).version, (await shown()).links, (await shown()).trouble, (await shown()).retry], [String(version), 205, null, false]);
      await rename(was);
    });

    it("says so when an item cannot be read at all, and reads it when asked again or at the next refresh", async () => {
      const was = await open();
      await page.key("Escape");
      for (const again of ["#detail .retry", "#refresh"]) {
        await gate("fail = (call) => call.path === '/api/get'");
        await page.click(`.card[data-id="${group}"]`);
        await page.until("return Boolean(document.querySelector('#detail .empty'))", "the panel to say that it could not read the item");
        const failed = await shown();
        assert.deepEqual([failed.hidden, failed.title, failed.empty, failed.retry, failed.links], [false, null, "Cannot reach the service.", true, 0]);
        assert.equal(await page.run<boolean>("return document.querySelector('.panel-card').contains(document.activeElement)"), true, "the keyboard is in the panel");
        if (again === "#refresh") await layout("in a panel that could not read its item");
        await gate("fail = null");
        await press(again);
        await links(100, `the item, read after ${again}`);
        assert.deepEqual([(await shown()).title, part(await shown())], [was, first]);
        await page.key("Escape");
      }
    });

    it("reads the item again from the start when the service does not take a token, and when the item has changed since it was read", async () => {
      const was = await open();
      // A token that the service refuses: the page asks for the item anew and reads on with the token it then gets.
      await gate("change = window.once((call) => window.further(call) && { ...call.body, continuation: 'bm90IGEgdG9rZW4' })");
      await press(MORE);
      await links(200, "the page, read with a token that is taken");
      assert.deepEqual([(await shown()).title, (await shown()).contains, (await shown()).trouble, await asked("whole"), await asked("further")], [was, "200 of 205", null, 1, 2]);

      // The item changes while the page neither listens nor asks. The next page says so by its version: the
      // panel does not put it beside the item as it was, it reads the item as it is.
      const moved = await run("update_task", { id: group, version: (await run("get", { id: group })).version, priority: 7 });
      await press(MORE);
      await links(205, "the item as it is now, with all its pages");
      const now = await shown();
      assert.deepEqual([now.version, now.priority, now.contains, now.trouble], [String(moved.version), "7", "205", null]);
      await run("update_task", { id: group, version: moved.version, priority: 0 });
    });

    it("restarts an already-open page when its continuation boundary disappeared before a refresh", async () => {
      const was = await open();
      await press(MORE);
      await links(200, "two pages before the boundary disappears");
      await gate(`answer = (() => { let done = false; return (call) => !done && window.further(call) ? (done = true, new Response(JSON.stringify({ error: { code: 'invalid_input', message: 'The continuation token names an entry that is no longer in the list.' } }), { status: 400, headers: { 'content-type': 'application/json' } })) : null; })()`);
      const before = await run("get", { id: group });
      try {
        await run("update_task", { id: group, version: before.version, priority: before.priority + 1 });
        await press("#refresh");
        await page.until(`return [...document.querySelectorAll('#detail .facts dt')].find((dt) => dt.textContent === 'Priority')?.nextElementSibling.textContent === ${JSON.stringify(String(before.priority + 1))} && !document.querySelector('#detail .not-read') && document.querySelectorAll('#detail .relation[data-relation="contains"] .link').length === 200`, "the rejected continuation to be replaced by a fresh one");
        await links(200, "the already-open page after a fresh reading");
        const [whole, further] = [await asked("whole"), await asked("further")];
        assert.deepEqual([(await shown()).title, (await shown()).trouble], [was, null]);
        assert.ok(whole >= 1 && further === whole + 1, `${whole} fresh item reads and ${further} page reads: the rejected continuation alone is extra`);
      } finally {
        const current = await run("get", { id: group });
        await run("update_task", { id: group, version: current.version, priority: before.priority });
      }
    });

    it("draws an item and its pages of one version: an item that changes between its reading and that of a page is read again from the start, whichever way the reading began", async () => {
      const was = await open();
      await press(MORE);
      await links(200, "two pages of what the group contains");
      const titled = (title: string) => page.until(`return document.querySelector('#detail .detail-title')?.textContent === ${JSON.stringify(title)}`, `the item called ${title}`);
      /** A test for the gate that fits the request for a page that is the given one of those sent from now on. */
      const nth = (which: number) => `(() => { let sent = 0; return (call) => window.further(call) && ++sent === ${which}; })()`;

      // A refresh reads the item, and the item changes before its second page is asked for: the page is of a
      // later version than the item in hand. The two are not drawn together: the item is read again.
      await gate(`wait = ${nth(1)}`);
      await rename(`${was}, first`);
      await press("#refresh");
      await waiting(1);
      assert.equal((await shown()).title, was, "nothing is drawn of a reading that is not whole");
      const second = await rename(`${was}, second`);
      await letGo();
      await titled(`${was}, second`);
      assert.deepEqual([(await shown()).version, (await shown()).contains, (await shown()).links, (await shown()).trouble], [String(second), "200 of 205", 200, null]);
      assert.deepEqual([await asked("whole"), await asked("further")], [2, 3], "the item was read twice, each time with its second page");

      // "Show more" on an item that has changed without the page knowing: the page says so by its version and
      // the item is read from the start. It changes again while that is done, and is read from the start again.
      await run("update_task", { id: group, version: second, priority: 5 });
      await gate(`wait = ${nth(2)}`);
      await press(MORE);
      await waiting(1);
      const third = await rename(`${was}, third`);
      await letGo();
      await titled(`${was}, third`);
      await links(205, "all three pages, of the item as it is");
      assert.deepEqual([(await shown()).version, (await shown()).priority, (await shown()).contains, (await shown()).trouble], [String(third), "5", "205", null]);

      // A token that the service does not take sends the reading to the start as well, and the same holds there.
      await gate("change = window.once((call) => window.further(call) && { ...call.body, continuation: 'bm90IGEgdG9rZW4' })");
      await gate(`wait = ${nth(2)}`);
      await press(EARLIER);
      await waiting(1);
      const fourth = await rename(`${was}, fourth`);
      await letGo();
      await titled(`${was}, fourth`);
      await page.until("return document.querySelectorAll('#detail .history li').length === 200", "two pages of the history");
      assert.deepEqual([(await shown()).version, (await shown()).links, (await shown()).trouble], [String(fourth), 205, null]);
      await run("update_task", { id: group, version: fourth, priority: 0, title: was });
    });

    it("shows an item that goes on changing as it was read last, by itself, says that its further pages are not shown, and stops reading", async () => {
      const was = await open();
      await press(MORE);
      await links(200, "two pages of what the group contains");
      const before = [await asked("whole"), await asked("further")];
      // Every request for a page waits, and the item is changed before each is sent: as an agent would that
      // changes the task again and again while someone looks at it.
      await gate("wait = window.further");
      let version = await rename(`${was}, changed 0 times more`);
      await press("#refresh");
      for (let times = 1; times <= 3; times++) {
        await waiting(1);
        assert.equal((await shown()).title, was, "nothing is drawn while the item and its page do not belong together");
        version = await rename(`${was}, changed ${times} times more`);
        await letGo();
      }
      await page.until("return Boolean(document.querySelector('#detail .not-read'))", "the panel to say that the item is changing");
      const given = await shown();
      assert.deepEqual(
        [given.title, given.version, part(given)],
        [`${was}, changed 3 times more`, String(version), { ...first, trouble: "The item is being changed while it is read. This is the item as it was read last; the further pages of its lists are not shown.", retry: true }],
        "the item as it was read last, with the first page of each list, each saying that it is a part",
      );
      // Three readings with a page each, and one of the item by itself: then no more, however long one waits.
      assert.deepEqual([(await asked("whole")) - before[0]!, (await asked("further")) - before[1]!], [4, 3]);
      await page.wait(500);
      assert.deepEqual([(await asked("whole")) - before[0]!, (await asked("further")) - before[1]!, await page.run<number>("return window.gate.waiting.length")], [4, 3, 0]);
      await layout("in a panel whose item goes on changing");
      // Left alone, the item is read with the pages that were opened, when asked again.
      await gate("wait = null");
      await press("#detail .retry");
      await links(200, "the pages that were opened");
      assert.deepEqual([(await shown()).title, (await shown()).contains, (await shown()).trouble, (await shown()).retry], [`${was}, changed 3 times more`, "200 of 205", null, false]);
      await rename(was);
    });

    /** One list of links in the panel: what its heading counts, how many it shows, whether it offers more, and whether a given item is in it. */
    const listed = (relation: string, id: string) =>
      page.run<{ count: string | null; links: number; more: boolean; has: boolean }>(`
        const relation = document.querySelector('#detail .relation[data-relation=${JSON.stringify(relation)}]');
        return {
          count: relation?.querySelector('h4 .count').textContent ?? null,
          links: relation ? relation.querySelectorAll('.link').length : 0,
          more: Boolean(relation?.querySelector('.further')),
          has: Boolean(relation && [...relation.querySelectorAll('.link .id')].some((id) => id.textContent === ${JSON.stringify(id)})),
        };
      `);

    it("does not show a list as whole that has changed since its first page was read: a link of the first page that went before \"Show more\" sends the reading back to the start", async () => {
      // 105 tasks in a group, all waiting for one task: one page and five more of what the group contains and
      // of what needs the task. Neither the group nor the task changes its version when one of them leaves.
      const small = await create("A group of 105");
      const needed = await create("Needed by 105");
      const members: string[] = [];
      for (let n = 1; n <= 105; n++) members.push(await create(`One of 105, number ${n}`, { parent: small, depends_on: [needed] }));
      for (const [item, relation, gone, remove] of [
        [small, "contains", members[0]!, () => run("remove_link", { from: small, type: "contains", to: members[0] })],
        [needed, "is depended on by", members[1]!, () => run("remove_link", { from: members[1], type: "depends on", to: needed })],
      ] as const) {
        await open(item);
        assert.deepEqual(await listed(relation, gone), { count: "100 of 105", links: 100, more: true, has: true }, relation);
        const version = (await shown()).version;
        // The page neither listens nor asks, and does not know of the change. The next page tells it: it was
        // read of the item as it is after the change, and the five it holds do not make the list whole.
        await remove();
        await press(`#detail .relation[data-relation="${relation}"] .further`);
        await page.until(`return document.querySelectorAll('#detail .relation[data-relation="${relation}"] .link').length === 104`, `the ${relation} list as it is now`);
        assert.deepEqual(await listed(relation, gone), { count: "104", links: 104, more: false, has: false }, `${relation}: the 104 that are left, and not the one that went`);
        assert.deepEqual([(await shown()).version, (await shown()).trouble], [version, null], "the item's version is what it was: it did not tell");
        assert.deepEqual([await asked("whole"), await asked("further")], [1, 2], "the page that did not fit was dropped, and the item read once from the start with its second page");
      }
    });

    it("reads the item again from the start when a task on one of its pages has changed since the first page was read: no two pages are shown that never were together", async () => {
      await open();
      const first = await run("get", { id: group });
      const onFirst = first.links.contains[0].id as string;
      const onSecond = (await run("get", { id: group, continuation: first.more.links.contains.continuation })).links.contains[0].id as string;
      const pill = (id: string) => page.run<string | null>(`
        const link = [...document.querySelectorAll('#detail .relation[data-relation="contains"] .link')].find((link) => link.querySelector('.id').textContent === ${JSON.stringify(id)});
        return link?.querySelector('.pill')?.textContent ?? null;
      `);
      assert.deepEqual([await pill(onFirst), await pill(onSecond)], ["open", null], "the first page shows its first task as open, and the second page is not read yet");
      try {
        // A task of the first page becomes a draft, then one of the second. The page neither listens nor asks,
        // and the group is at the version it was. The second page alone would show its task as a draft beside
        // the first page's task as open, which the group never was.
        await move(onFirst, "draft");
        await move(onSecond, "draft");
        await press(MORE);
        await links(200, "two pages of the group as it is now");
        assert.deepEqual([await pill(onFirst), await pill(onSecond), (await shown()).contains, (await shown()).trouble], ["draft", "draft", "200 of 205", null]);
        assert.deepEqual([await asked("whole"), await asked("further")], [1, 2], "the page that did not fit was dropped, and the group read once from the start with its second page");
      } finally {
        await move(onFirst, "open");
        await move(onSecond, "open");
      }
    });

    it("shows the links that lead somewhere when most of an item's links lead nowhere, as damage to the data leaves them", async () => {
      const waits = await create("Waits for what is partly gone");
      for (let n = 0; n < 5; n++) await run("add_link", { from: waits, type: "depends on", to: await create(`Is there, number ${n + 1}`) });
      // 120 links to projects that are not there, which stand before every task in a list: a page of them and more.
      const { storage, engine } = service;
      const gone = Array.from({ length: 120 }, (_, n) => ({ fromKind: "task", fromId: waits, type: "depends on", toKind: "project", toId: `GONE${String.fromCharCode(65 + Math.floor(n / 26))}${String.fromCharCode(65 + (n % 26))}` }));
      const written = async (changes: Array<{ op: "put_link"; record: any } | { op: "delete_link"; key: any }>) => {
        for (let from = 0; from < changes.length; from += 90) {
          const { head } = (await storage.load("default"))!;
          await storage.commit("default", { expectedRevision: head.revision, counters: head.counters, changes: changes.slice(from, from + 90) });
        }
        await engine.reload();
      };
      await written(gone.map((key) => ({ op: "put_link" as const, record: { ...key, data: { at: "2026-01-01T00:00:00.000Z", by: "1" } } })));
      try {
        await open(waits);
        assert.deepEqual(await listed("depends on", "nothing"), { count: "5", links: 5, more: false, has: false }, "the five that are there, counted as five, with nothing more to ask for");
        assert.deepEqual([(await shown()).trouble, await count("#detail .further")], [null, 0]);
      } finally {
        await written(gone.map((key) => ({ op: "delete_link" as const, key })));
      }
    });

    it("reads no list on that is none of the service's, on the board or in the panel: it stops at the answer that shows it, says that what answered is not the service, keeps what it had, and asks for nothing more", async () => {
      // The table of ways in which a list can be none, which is held against every reader of lists, is run in
      // the page with the rules the page itself reads by: the service's own, handed over as they are.
      const source = readFileSync(new URL("./adversary.js", import.meta.url), "utf8").replace(/^export /gm, "").replace(/^\/\/# sourceMappingURL=.*$/m, "");
      const mark = (question: unknown, key: unknown) => paging.sealToken({ q: paging.questionMark(question), k: key });
      const arm = async (target: Target) => {
        await page.run(`const paging = await import('/shared/paging.js'); ${source}; window.attacks = adversary(paging, ${JSON.stringify(target)});`);
        // The shared paging rules and the command-line readers hold the whole adversary table. Here the page
        // proves its integration with one case from each failure class, without repeating hundreds of requests.
        const all = adversary(paging, target).map((attack, at) => ({ ...attack, at }));
        const classes = [
          /^two tokens that lead to each other$/,
          /^a token of /,
          /^what is no token: "the next page"$/,
          /^a token of this list with no key of it: \{\}$/,
          /^an entry twice in one page$/,
          /^an entry of a page before$/,
          /^a page that holds nothing and goes on$/,
          /^a token that passes entries over:/,
        ];
        const selected = classes.map((pattern) => all.find((attack) => attack.why !== null && pattern.test(attack.name)));
        assert.ok(selected.every(Boolean), `every browser adversary class exists for ${target.list}`);
        return selected as Array<(typeof all)[number]>;
      };
      const answered = (body: string) => `new Response(JSON.stringify(${body}), { status: 200, headers: { 'content-type': 'application/json' } })`;
      const said = "The service answered with an error: What answered ";
      const changed = (which: string, change: string) =>
        gate(`answer = (call, url, options) => ${which}(call) && window.realFetch(url, options).then((real) => real.json()).then((body) => { ${change}; return ${answered("body")}; })`);

      // The board, which reads the list of tasks to its end by itself.
      await open();
      const cards = await count(".card");
      const board = await arm({
        list: "tasks",
        entries: "tasks",
        question: paging.questionOfList("list_tasks"),
        owner: "nobody",
        remembers: true,
        first: 0,
        held: 0,
        foreign: {
          "the list of projects": mark(paging.questionOfList("list_projects"), "ZZZ-1001"),
          "the list of tasks asked with a filter": mark(paging.questionOfList("list_tasks", { status: "open" }), "ZZZ-1001"),
          "a list of an item": mark(paging.itemListQuestion({ kind: "task", id: group }, ["links", "contains"]), "task:ZZZ-1001"),
          "the list of tasks, as a service gives it under a filter": (await run("list_tasks", { status: "open" })).continuation,
        },
      });
      assert.equal(board.length, 8, `${board.length} representative ways`);
      const notice = () => page.run<string | null>("const notice = document.getElementById('notice'); return notice.hidden ? null : notice.textContent");
      for (const attack of board) {
        await page.run(`window.attack = window.attacks[${attack.at}]; window.attackAsked = 0`);
        await gate(`answer = (call) => call.path === '/api/list-tasks' && (() => { const made = window.attack.page(++window.attackAsked, call.body.continuation); return ${answered("{ tasks: made.entries, ...(Object.hasOwn(made, 'continuation') ? { continuation: made.continuation } : {}) }")}; })()`);
        await press("#refresh");
        await page.until("return !document.getElementById('notice').hidden", `the page to say that the list of tasks is none: ${attack.name}`, 30000);
        const [text, requests] = [await notice(), await page.run<number>("return window.attackAsked")];
        assert.ok(text?.startsWith(`${said}list-tasks did not answer as this Vigile service does: ${attack.why}. Trying again every few seconds. Showing what was loaded at `), `${attack.name}: ${text}`);
        assert.equal(requests, attack.requests, `${attack.name}: ${requests} pages were asked for`);
        assert.equal(await count(".card"), cards, `${attack.name}: the board is as it was loaded`);
        // The service answers as it does again: the page reads the plan, and says nothing more.
        await gate("answer = null");
        await press("#refresh");
        await page.until("return document.getElementById('notice').hidden", "the notice to go");
      }
      assert.equal(await count(".card"), cards);

      // The panel, which reads a list of the item on when the person asks for it: its links, and its history.
      const item = await run("get", { id: group, history: true });
      const other = made.find((id) => id !== group)!;
      const ref = { kind: "task", id: group };
      const ofLinks: Target = {
        list: "links",
        entries: "links",
        question: paging.itemListQuestion(ref, ["links", "contains"]),
        owner: "nobody",
        remembers: true,
        first: 1,
        held: 100,
        seen: item.links.contains[0],
        foreign: {
          "the list of tasks": (await run("list_tasks", {})).continuation,
          "that list of another item": mark(paging.itemListQuestion({ kind: "task", id: other }, ["links", "contains"]), "task:ZZZ-1001"),
          "another list of links of the item": mark(paging.itemListQuestion(ref, ["links", "depends on"]), "task:ZZZ-1001"),
          "the history of the item": item.more.history.continuation,
          "that list of a project of the same ID": mark(paging.itemListQuestion({ kind: "project", id: group }, ["links", "contains"]), "task:ZZZ-1001"),
        },
      };
      const ofHistory: Target = {
        list: "history",
        entries: "changes",
        question: paging.itemListQuestion(ref, ["history"]),
        owner: "nobody",
        remembers: true,
        first: 1,
        held: 100,
        seen: item.history[0],
        foreign: {
          "the list of tasks": ofLinks.foreign["the list of tasks"]!,
          "the history of another item": mark(paging.itemListQuestion({ kind: "task", id: other }, ["history"]), [0, 5]),
          "the links of the item": item.more.links.contains.continuation,
          "the timeline of the item": mark(paging.itemListQuestion(ref, ["timeline"]), 5),
        },
      };
      const inPanel: Array<[target: Target, button: string, shape: string]> = [
        [ofLinks, MORE, "links: { contains: made.entries }, ...(Object.hasOwn(made, 'continuation') ? { more: { links: { contains: { total: 205, continuation: made.continuation } } } } : {})"],
        [ofHistory, EARLIER, "history: made.entries, ...(Object.hasOwn(made, 'continuation') ? { more: { history: { total: 900, continuation: made.continuation } } } : {})"],
      ];
      let was = await open();
      for (const [target, button, shape] of inPanel) {
        const table = await arm(target);
        assert.equal(table.length, 8, `${target.entries}: representative ways`);
        for (const attack of table) {
          was = await open();
          await arm(target);
          await page.run(`window.attack = window.attacks[${attack.at}]; window.attackAsked = 0`);
          await gate(`answer = (call) => window.further(call) && (() => { const made = window.attack.page(++window.attackAsked, call.body.continuation); return ${answered(`{ kind: 'task', id: ${JSON.stringify(group)}, version: ${item.version}, unchanged_since: ${item.unchanged_since}, ${shape} }`)}; })()`);
          // As many pages are asked for as the way takes, and more: the reading that is under way reads them all.
          await page.run(`for (let clicks = 0; clicks < ${attack.requests + 2}; clicks++) document.querySelector(${JSON.stringify(button)})?.click()`);
          await page.until("return Boolean(document.querySelector('#detail .not-read'))", `the panel to say that the list of ${target.entries} is none: ${attack.name}`, 30000);
          const state = await shown();
          assert.deepEqual(
            [state.title, part(state), await page.run<number>("return window.attackAsked")],
            [was, { ...first, trouble: `${said}for a list of ${group} did not answer as this Vigile service does: ${attack.why}. This is the item as it was read before.`, retry: true }, attack.requests],
            `${target.entries}, ${attack.name}: what was read stays, the list still says that it is a part, and no page more was asked for`,
          );
        }
      }

      // A continuation page that names another list as going on is not the end of the requested list, nor can
      // unrelated continuation metadata be ignored beside the right metadata. In either case the old panel stays.
      for (const [what, change] of [
        ["another list instead", "body.more.links = { 'depends on': body.more.links.contains }"],
        ["another list as well", "body.more.links['depends on'] = body.more.links.contains"],
      ] as const) {
        was = await open();
        await changed("window.further", change);
        await press(MORE);
        await page.until("return Boolean(document.querySelector('#detail .not-read'))", `the panel to reject continuation metadata for ${what}`);
        assert.deepEqual([(await shown()).contains, (await shown()).links, (await shown()).more, (await shown()).trouble], ["100 of 205", 100, "Show more", `${said}for a list of ${group} did not answer as this Vigile service does: it names another list among those that go on. This is the item as it was read before.`], what);
        await gate("answer = null");
      }

      was = await open();
      await page.run(`document.querySelector(${JSON.stringify(MORE)}).click()`);
      await links(200, "the next page, as the service gives it");
      // As the service answers, the same clicks read on: the reader that refuses what is none takes what is one.
      assert.deepEqual([(await shown()).contains, (await shown()).trouble], ["200 of 205", null]);

      // The item itself, read with a list that goes on in a way no list of the service's does: the button is
      // there, and what it finds is said before anything is sent. It is not a list that has ended, and what was
      // given as a token is not sent to be refused.
      const firstPages: Array<[what: string, change: string, why: string]> = [
        ["no token", "delete body.more.links.contains.continuation", "it goes on with what is no continuation token"],
        ["words where the token is", "body.more.links.contains.continuation = 'the next page'", "it goes on with what is no continuation token"],
        ["the token of its history", "body.more.links.contains.continuation = body.more.history.continuation", "it goes on with the token of another list"],
        ["the token of that list of another item", `body.more.links.contains.continuation = ${JSON.stringify(ofLinks.foreign["that list of another item"])}`, "it goes on with the token of another list"],
        ["the token of the list of tasks", `body.more.links.contains.continuation = ${JSON.stringify(ofLinks.foreign["the list of tasks"])}`, "it goes on with the token of another list"],
        ["a link twice in its first page", "body.links.contains[7] = body.links.contains[3]", `it holds task:${item.links.contains[3].id} twice`],
      ];
      for (const [what, change, why] of firstPages) {
        await open();
        await changed("window.whole", change);
        await rename(`${was}, read with ${what}`);
        await press("#refresh");
        await page.until(`return document.querySelector('#detail .detail-title')?.textContent === ${JSON.stringify(`${was}, read with ${what}`)}`, "the item as it was read again");
        assert.deepEqual([(await shown()).contains, (await shown()).more, (await shown()).trouble], ["100 of 205", "Show more", null], what);
        await press(MORE);
        await page.until("return Boolean(document.querySelector('#detail .not-read'))", `the panel to say that the list goes on with ${what}`);
        assert.deepEqual([(await shown()).trouble, (await shown()).contains, (await shown()).links], [`${said}for a list of ${group} did not answer as this Vigile service does: ${why}. This is the item as it was read before.`, "100 of 205", 100], what);
        assert.equal(await asked("further"), 0, `${what}: nothing was sent`);
        await gate("answer = null");
      }
      await rename(was);
    });

    it("shows that the item is gone when it was deleted for good while its panel was open, whichever reading finds out", async () => {
      // A task of its own, with a timeline longer than a page.
      const busy = (await run("create_task", { title: "Soon gone", description: "d" })).id as string;
      let version = 1;
      for (let n = 1; n <= 105; n++) version = (await run("set_task_status", { id: busy, version, status: n % 2 ? "draft" : "open" })).version;
      await open(busy);
      assert.equal(await text("#detail .partial"), "The latest 100 of 106.");
      await run("delete", { id: busy, version });
      await service.engine.execute("delete", "admin", { id: busy, version: version + 1, permanent: true });
      await press("#detail .further[data-list='timeline']");
      await page.until("return Boolean(document.querySelector('#detail .empty'))", "the panel to say that the task is not there");
      const gone = await shown();
      assert.deepEqual([gone.title, gone.retry, gone.trouble], [null, true, null]);
      assert.match(gone.empty!, /^No task matches/);
      assert.equal(await count("#detail .timeline li"), 0, "nothing of the task is left in the panel");
    });

    it("empties the panel when the key is refused while a page is asked for, and opens the item at its first page once the page is let in again", async () => {
      const was = await open();
      const locked = () => page.until("return Boolean(document.querySelector('#notice input')) && document.getElementById('main').hidden", "the key form");
      const nothing = async (why: string) => assert.deepEqual([(await shown()).hidden, await page.run<number>("return document.getElementById('detail').childElementCount")], [true, 0], why);
      const letIn = async () => {
        await page.click("#notice input");
        await page.type(adminKey);
        await page.click("#notice button");
        await links(100, "the item named in the address, once let in");
        assert.deepEqual([(await shown()).title, part(await shown())], [was, first]);
      };
      try {
        // The page is locked out while a page of a list is on its way: the answer, which was given before, shows nothing.
        await gate("hold = window.once(window.further)");
        await press(MORE);
        await held(1);
        setValue(config, "auth.keyless_user", "");
        await press("#refresh");
        await locked();
        await release();
        await page.wait(300);
        await nothing("the answer that was on its way puts nothing of the item into the page");
        await letIn();
        // The key is refused to the request for the page itself.
        await page.run("localStorage.removeItem('vigile.key')");
        await press(MORE);
        await locked();
        await nothing("nothing of the item stays in the page");
        await letIn();
      } finally {
        setValue(config, "auth.keyless_user", "agent1");
        await page.run("localStorage.clear()");
      }
    });
  });

  browserSuite("collapsed columns", () => {
    type Column = { key: string; collapsed: boolean; width: number; height: number; cards: number };
    /** The columns as the board shows them: which are collapsed, how large each is, and how many cards each has drawn. */
    const board = () =>
      page.run<Column[]>(
        "return [...document.querySelectorAll('.board > .column')].map((c) => { const r = c.getBoundingClientRect(); return { key: c.dataset.key, collapsed: c.classList.contains('collapsed'), width: Math.round(r.width), height: Math.round(r.height), cards: c.querySelectorAll('.card').length }; })",
      );
    const column = async (key: string) => (await board()).find((c) => c.key === key)!;
    const collapsed = async () => (await board()).filter((c) => c.collapsed).map((c) => c.key);
    /** The control in a column's heading that collapses it; on a collapsed column, the one that opens it. */
    const control = (key: string) => `.column[data-key="${key}"] .column-fold`;
    const named = (key: string) => page.run<[string | null, string | null]>(`const b = document.querySelector(${JSON.stringify(control(key))}); return [b.getAttribute('aria-label'), b.getAttribute('aria-expanded')]`);
    const stored = () => page.run<string | null>("return localStorage.getItem('vigile.collapsed')");
    /** Opens the page as a browser does that remembers these columns as collapsed. */
    const loadCollapsed = async (keys: string[], path = "/") => {
      await load();
      await page.run(`localStorage.setItem('vigile.collapsed', ${JSON.stringify(JSON.stringify(keys))})`);
      await load(path);
    };
    const forget = () => page.run("for (const name of ['vigile.collapsed', 'vigile.bugs-apart', 'vigile.auto-refresh', 'vigile.motion', 'vigile.sound', 'vigile.scroll']) localStorage.removeItem(name)");
    const ALL = ["in_progress", "in_review", "next", "waiting", "paused", "draft", "done", "cancelled"];
    const sideways = () => page.run<boolean>("const b = document.getElementById('board'); return b.scrollWidth > b.clientWidth");
    /** Counts the copies of cards that float across the page while a card travels or leaves. */
    const watchGhosts = () => page.run("window.ghosts = 0; window.ghostWatch?.disconnect(); window.ghostWatch = new MutationObserver((changes) => { for (const c of changes) for (const n of c.addedNodes) if (n.classList?.contains('card-ghost')) window.ghosts++; }); window.ghostWatch.observe(document.body, { childList: true });");
    const ghosts = () => page.run<number>("return window.ghosts");
    const settled = () => page.until("return document.querySelectorAll('.card-ghost').length === 0 && [...document.querySelectorAll('.card')].every((c) => getComputedStyle(c).visibility === 'visible')", "the movement to finish", 12_000);
    const live = () => page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
    const ringed = (key: string) => page.run<boolean>(`return document.querySelector('.column[data-key="${key}"]').classList.contains('changed')`);

    it("collapses a column to a narrow strip that keeps its name and its count, gives its room to the other columns, and opens it again with a click anywhere on the strip", async () => {
      await page.size(1440, 900);
      await load();
      try {
        const before = await board();
        assert.deepEqual(before.map((c) => [c.key, c.collapsed, c.width]), ALL.map((key) => [key, false, 270]), "eight open columns, more than the window holds, each at its least width");
        const counts = await columns();
        const summary = await text("#summary");
        // Every column has the control, a button at the end of its heading that says what it will do.
        const controls = await page.run<Array<[string, string | null, string | null, boolean]>>(
          "return [...document.querySelectorAll('.board > .column')].map((c) => { const all = c.querySelectorAll('.column-fold'); const b = all[0]; return [b.tagName + ' ' + b.type + ' ' + all.length, b.getAttribute('aria-label'), b.getAttribute('aria-expanded'), b === c.querySelector('.column-head').lastElementChild]; })",
        );
        assert.deepEqual(
          controls,
          ["In progress", "In review", "Next", "Waiting for dependencies", "Paused", "Draft", "Done", "Cancelled"].map((title) => ["BUTTON button 1", `Collapse the ${title} column`, "true", true]),
        );

        await page.click(control("done"));
        const strip = await column("done");
        assert.deepEqual([strip.collapsed, strip.width, strip.cards], [true, 40, 0], "Done is a strip 40 pixels wide, with none of its cards drawn");
        assert.equal(strip.height, (await column("next")).height, "as tall as the columns it stands among");
        assert.deepEqual(await columns(), counts, "every column still says its name and how many cards it holds, the collapsed one too");
        assert.equal(await text("#summary"), summary, "and the counts above the board are what they were");
        assert.deepEqual(await named("done"), [`Open the Done column, ${counts.Done} cards`, "false"], "its control now says that it opens the column, and how many cards are in it");
        assert.deepEqual(
          await page.run("const c = document.querySelector('.column[data-key=\"done\"]'); const head = c.querySelector('.column-head').getBoundingClientRect(); return [c.children.length, getComputedStyle(c.querySelector('.column-head')).writingMode, head.height > 2 * head.width, getComputedStyle(c.querySelector('.count')).writingMode]"),
          [1, "vertical-rl", true, "horizontal-tb"],
          "the strip is the heading alone, its name written from top to bottom and its count upright",
        );
        assert.equal(await stored(), '["done"]');
        await layout("with one column collapsed");

        // With enough of them collapsed, the open ones are wider than they were: they share the room that was freed.
        for (const key of ["paused", "draft", "cancelled"]) await page.click(control(key));
        const some = await board();
        assert.deepEqual(some.filter((c) => c.collapsed).map((c) => [c.key, c.width]), [["paused", 40], ["draft", 40], ["done", 40], ["cancelled", 40]]);
        const open = some.filter((c) => !c.collapsed);
        assert.deepEqual(open.map((c) => c.key), ["in_progress", "in_review", "next", "waiting"]);
        for (const c of open) assert.ok(c.width > 275 && c.width <= 380 && Math.abs(c.width - open[0]!.width) <= 1, `${c.key} is ${c.width}px wide, as wide as the other open ones and wider than before`);
        assert.equal(await sideways(), false, "and the board no longer scrolls sideways");
        await layout("with four columns collapsed");

        // A click anywhere on the strip opens the column: here near its lower end, far from the arrowhead.
        const at = await page.run<{ x: number; y: number; control: boolean }>(
          "const r = document.querySelector('.column[data-key=\"done\"]').getBoundingClientRect(); const x = r.left + r.width / 2, y = r.bottom - 30; return { x, y, control: Boolean(document.elementFromPoint(x, y)?.closest('.column[data-key=\"done\"] .column-fold')) }",
        );
        assert.equal(at.control, true, "the control reaches over the whole strip");
        await page.clickAt(at.x, at.y);
        const again = await column("done");
        assert.deepEqual([again.collapsed, again.cards, again.width >= 270], [false, counts.Done, true], "Done is open again, with its cards");
        assert.deepEqual(await named("done"), ["Collapse the Done column", "true"]);
        assert.equal(await stored(), '["paused","draft","cancelled"]');
        assert.deepEqual(await columns(), counts);
        assert.deepEqual(page.errors, []);
      } finally {
        await forget();
      }
    });

    it("writes the name on a strip so that it can be read in every theme, light and dark, and the column for bugs is a column like the others", async () => {
      await page.size(1280, 900);
      await load();
      /** Runs in the page: how well the name and the count of each strip stand out from what is behind them. */
      const READ = `
        const lum = (colour) => { const scale = colour.startsWith("color(") ? 1 : 1 / 255; const [r, g, b] = colour.match(/[\\d.]+/g).slice(0, 3).map((v) => Number(v) * scale).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
        const clear = (colour) => colour === "transparent" || /^rgba\\(.*, 0\\)$/.test(colour);
        return [...document.querySelectorAll(".column.collapsed")].map((c) => {
          let behind = c;
          while (clear(getComputedStyle(behind).backgroundColor)) behind = behind.parentElement;
          const bg = getComputedStyle(behind).backgroundColor;
          const name = getComputedStyle(c.querySelector(".column-head")).color;
          const count = getComputedStyle(c.querySelector(".count")).color;
          return c.dataset.key + (ratio(name, bg) >= 4.5 ? "" : " name hard to read: " + name + " on " + bg) + (ratio(count, bg) >= 4.5 ? "" : " count hard to read: " + count + " on " + bg);
        });
      `;
      try {
        await setting("bugs-apart");
        const counts = await columns();
        await page.click(control("trouble"));
        await page.click(control("done"));
        const bugs = await column("trouble");
        assert.deepEqual([bugs.collapsed, bugs.width, bugs.cards], [true, 40, 0], "the column for bugs collapses to a strip like any other");
        assert.deepEqual(await named("trouble"), [`Open the Bugs, issues and incidents column, ${counts["Bugs, issues and incidents"]} cards`, "false"]);
        assert.equal(await count(".column[data-key='trouble'] .lane, .column[data-key='trouble'] .column-note"), 0, "without its note and the headings of its states");
        assert.deepEqual(await columns(), counts);
        for (const scheme of ["light", "dark"] as const) {
          await page.scheme(scheme);
          for (const name of ["vigile", "dado", "jeev", "gito"]) {
            await page.run(`document.documentElement.dataset.theme = ${JSON.stringify(name)}`);
            assert.deepEqual(await page.run<string[]>(READ), ["trouble", "done"], `the strips can be read in ${name}, ${scheme}`);
            const strips = (await board()).filter((c) => c.collapsed);
            assert.deepEqual(strips.map((c) => c.width), [40, 40], `a strip is 40 pixels wide in ${name}`);
            const fits = await page.run<boolean>("return [...document.querySelectorAll('.column.collapsed')].every((c) => c.querySelector('.column-head').getBoundingClientRect().bottom <= c.getBoundingClientRect().bottom)");
            assert.equal(fits, true, `the name and the count fit the strip in ${name}`);
            await layout(`with strips in ${name}, ${scheme}`);
          }
        }
        await page.click(control("trouble"));
        assert.equal(await count(".column[data-key='trouble'] .lane"), 3, "opened, the column for bugs has the headings of its states again");
      } finally {
        await page.scheme("light");
        await page.run("document.documentElement.dataset.theme = 'vigile'");
        await forget();
      }
    });

    it("counts the cards of a collapsed column above the board and under the filter, as it counts those of an open one", async () => {
      await page.size(1280, 900);
      await load();
      try {
        const counts = await columns();
        const summary = await text("#summary");
        await loadCollapsed(["next", "done"]);
        assert.deepEqual(await collapsed(), ["next", "done"]);
        assert.equal(await text("#summary"), summary, "the counts above the board count the collapsed columns too");
        assert.deepEqual(await columns(), counts);
        // The filter finds the cards of a collapsed column, and the strip counts what it found.
        await page.click("#filter");
        await page.type("Finished thing");
        assert.match(await text("#summary"), /^20 tasks\s*0 in progress\s*0 next\s*0 waiting\s*20 done/);
        assert.deepEqual(await columns(), { "In progress": 0, Next: 0, Done: 20 });
        assert.deepEqual((await board()).map((c) => [c.key, c.collapsed, c.cards]), [["in_progress", false, 0], ["next", true, 0], ["done", true, 0]]);
        assert.deepEqual(await named("done"), ["Open the Done column, 20 cards", "false"]);
        await page.run("document.getElementById('filter').select()");
        await page.type("Finished thing 7");
        assert.deepEqual(await named("done"), ["Open the Done column, 1 card", "false"], "one card is one card");
        // Nothing matches: the message says so, and no strip is left standing over it.
        await page.run("document.getElementById('filter').select()");
        await page.type("no such task");
        assert.deepEqual([await count(".board > *"), await text("#empty")], [0, 'No task matches "no such task".']);
        await page.run("document.getElementById('filter').select()");
        await page.key("Backspace");
        assert.deepEqual(await columns(), counts);
        assert.deepEqual(await collapsed(), ["next", "done"]);
      } finally {
        await forget();
      }
    });

    it("remembers which columns are collapsed in the browser and nowhere else, ignores a value damaged by hand and a name that no column has, and works for the visit where the browser stores nothing", async () => {
      await page.size(1280, 900);
      await load();
      try {
        assert.equal(await stored(), null, "nothing is stored until a column is collapsed");
        const address = await page.run<string>("return location.href");
        const asked = page.requests.length;
        await page.click(control("next"));
        await page.click(control("cancelled"));
        await page.wait(300);
        assert.equal(await stored(), '["next","cancelled"]', "one stored value: the names of the collapsed columns, in the order of the board");
        assert.equal(await page.run<string>("return location.href"), address, "the address of the page is what it was: a shared link collapses nobody else's columns");
        assert.equal(page.requests.length, asked, "and nothing was sent to the service");
        await load();
        assert.deepEqual(await collapsed(), ["next", "cancelled"], "a reload shows the same columns collapsed");
        assert.equal(page.requests.slice(asked).some((url) => /collapsed|cancelled/.test(url)), false, "no request names them");

        // Something else under the name is taken for no collapsed columns, and the page works.
        for (const damaged of ["{", "null", '"done"', '{"done":true}', "[[\"done\"]]", "7", ""]) {
          await page.run(`localStorage.setItem('vigile.collapsed', ${JSON.stringify(damaged)})`);
          await load();
          assert.deepEqual([await collapsed(), (await count(".card")) > 0], [[], true], `stored as ${damaged}`);
        }
        // Names that no column has are left out, whatever they are; the ones that are columns count.
        await page.run(`localStorage.setItem('vigile.collapsed', ${JSON.stringify(JSON.stringify(["done", "gone", "__proto__", 7, null, "constructor", ["next"], "done", "paused"]))})`);
        await load();
        assert.deepEqual(await collapsed(), ["paused", "done"]);
        await page.click(control("paused"));
        assert.equal(await stored(), '["done"]', "and they are gone from what is stored at the next change");
        // With nothing but such names stored, no column counts as collapsed: the settings do not offer to open any.
        await page.run(`localStorage.setItem('vigile.collapsed', '["gone", "__proto__", 7]')`);
        await load();
        await openSettings();
        assert.deepEqual([await collapsed(), await page.run<number>("return document.getElementById('columns-open').getBoundingClientRect().width")], [[], 0]);
        await closeSettings();
        // A column that is remembered and not on the board, as the one for bugs while it is switched off, is collapsed when it comes.
        await page.run(`localStorage.setItem('vigile.collapsed', '["trouble"]')`);
        await load();
        assert.deepEqual(await collapsed(), []);
        await setting("bugs-apart");
        assert.deepEqual(await collapsed(), ["trouble"]);
        assert.deepEqual(page.errors, []);
        await forget();

        // A browser that refuses storage altogether: every use of it throws.
        const refusing = (await page.send("Page.addScriptToEvaluateOnNewDocument", {
          source: "for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name, { configurable: true, get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });",
        })) as { identifier: string };
        try {
          await load();
          await page.click(control("done"));
          await page.click(control("next"));
          assert.deepEqual(await collapsed(), ["next", "done"], "the columns collapse for as long as the page is open");
          await page.click(".column[data-key='next']");
          assert.deepEqual(await collapsed(), ["done"], "and open again");
          await load();
          assert.deepEqual(await collapsed(), [], "a reload starts with every column open, since nothing could be stored");
          assert.deepEqual(page.errors, []);
        } finally {
          await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: refusing.identifier });
          await load();
        }
      } finally {
        await forget();
      }
    });

    it("leaves no empty board when every column is collapsed: the strips stay, and a line says so and opens them all, as the settings do while any column is collapsed", async () => {
      await page.size(1920, 900);
      await load();
      const offered = () => page.run<boolean>("return document.getElementById('columns-open').getBoundingClientRect().width > 0");
      const done = () =>
        page.run<{ span: string; perRow: number; width: number }>(
          "const c = document.querySelector('.column[data-key=\"done\"]'); const cards = [...c.querySelectorAll('.card')].map((k) => k.getBoundingClientRect()); return { span: c.style.getPropertyValue('--span').trim(), perRow: cards.filter((k) => Math.abs(k.top - cards[0].top) < 2).length, width: Math.round(c.getBoundingClientRect().width) }",
        );
      try {
        const counts = await columns();
        const summary = await text("#summary");
        await openSettings();
        assert.equal(await offered(), false, "with every column open, the settings have nothing to offer");
        await closeSettings();

        // All but three: Done takes the room that is spare now, and lays its cards out side by side.
        for (const key of ["in_review", "waiting", "paused", "draft", "cancelled"]) await page.click(control(key));
        assert.deepEqual(await done(), { span: "2", perRow: 2, width: 774 }, "Done is two cards wide once the strips leave it the room");
        assert.equal(await sideways(), false);
        await layout("with five strips and a Done column two cards wide");
        // A narrower window has no room to spare, and Done is one card wide again.
        await page.size(1440, 900);
        await page.until("return document.querySelector('.column[data-key=\"done\"]').style.getPropertyValue('--span') === ''", "the Done column to give the room back");
        assert.equal((await done()).perRow, 1);
        await page.size(1920, 900);
        await page.until("return document.querySelector('.column[data-key=\"done\"]').style.getPropertyValue('--span').trim() === '2'", "the Done column to take the room again");

        // All but one.
        await page.click(control("in_progress"));
        await page.click(control("next"));
        assert.deepEqual(await done(), { span: "3", perRow: 3, width: 1168 }, "alone among strips, Done takes all the cards' widths that fit beside them");
        assert.equal(await count(".columns-note"), 0);
        await layout("with every column but one collapsed");

        // All of them: the strips stay, each with its name and count, and a line beside them says what happened.
        await page.click(control("done"));
        assert.deepEqual((await board()).map((c) => [c.key, c.collapsed, c.width]), ALL.map((key) => [key, true, 40]));
        assert.deepEqual(await columns(), counts);
        assert.equal(await text("#summary"), summary);
        assert.deepEqual(await page.run("const note = document.querySelector('#board > .columns-note'); return [note.firstChild.textContent, note.querySelector('button').textContent, note === document.getElementById('board').lastElementChild, note.getBoundingClientRect().left > document.querySelector('.column[data-key=\"cancelled\"]').getBoundingClientRect().right]"), [
          "Every column is collapsed.",
          "Open all",
          true,
          true,
        ]);
        assert.equal(await stored(), JSON.stringify(ALL));
        await layout("with every column collapsed");
        await page.click(".columns-note button");
        assert.deepEqual([await collapsed(), await count(".columns-note"), await stored()], [[], 0, "[]"], "one click opens them all, and the line goes");
        assert.deepEqual(await columns(), counts);
        assert.deepEqual((await board()).map((c) => c.cards > 0), ALL.map(() => true), "every column has its cards again");

        // The settings offer the same while any column is collapsed, and only then.
        await page.click(control("next"));
        await page.click(control("draft"));
        await openSettings();
        assert.equal(await offered(), true);
        assert.equal(await text("#columns-open"), "Open all columns");
        await layout("with the settings offering to open all columns");
        await page.click("#columns-open");
        assert.deepEqual([await collapsed(), await offered(), await settingsOpen(), await stored()], [[], false, true, "[]"], "all open, the offer gone, the menu still open");
        assert.equal(await page.run<string>("return document.activeElement.id"), "settings", "the keyboard is on the button of the menu, not lost with the row that went");
        await closeSettings();
        // In the graph view there is no board to draw: the choice is made all the same, and the board shows it.
        await loadCollapsed(["next"], "/#graph");
        await graphReady();
        await openSettings();
        assert.equal(await offered(), true);
        await page.click("#columns-open");
        await closeSettings();
        assert.equal(await stored(), "[]");
        await page.click("#view-board");
        await page.until("return document.querySelectorAll('.card').length > 0 && document.getElementById('board').getBoundingClientRect().height > 0", "the board");
        assert.deepEqual(await collapsed(), []);
        assert.deepEqual(page.errors, []);
      } finally {
        await forget();
        await page.size(1280, 900);
      }
    });

    it("can be collapsed and opened with the keyboard: the control says what it will do, shows where the keyboard is, and keeps it after it is used", async () => {
      await page.size(1280, 900);
      await load();
      const at = () =>
        page.run<{ where: string; name: string | null; expanded: string | null; shown: boolean }>(
          "const a = document.activeElement; return { where: a.matches('.column-fold') ? a.closest('.column').dataset.key : a.closest('.columns-note') ? 'note' : a.dataset.id ? 'card' : a.tagName, name: a.getAttribute('aria-label'), expanded: a.getAttribute('aria-expanded'), shown: a.matches(':focus-visible') }",
        );
      /** The line drawn around what has the keyboard: around the control in an open column, around the whole strip of a collapsed one. */
      const outline = (key: string) =>
        page.run<{ control: string; strip: string }>(
          `const c = document.querySelector('.column[data-key="${key}"]'); const b = c.querySelector('.column-fold'); const line = (el) => getComputedStyle(el).outlineStyle === 'none' ? 'none' : getComputedStyle(el).outlineWidth + ' ' + getComputedStyle(el).outlineStyle; return { control: line(b), strip: line(c) }`,
        );
      try {
        const counts = await columns();
        // The keyboard comes to the control of the first column from whatever is before it.
        await page.run(`document.querySelector(${JSON.stringify(control("in_progress"))}).focus()`);
        await page.key("Tab", true);
        await page.key("Tab");
        assert.deepEqual(await at(), { where: "in_progress", name: "Collapse the In progress column", expanded: "true", shown: true });
        assert.deepEqual(await outline("in_progress"), { control: "2px solid", strip: "none" });
        // Enter collapses the column. The keyboard is on its control still, which now opens it, and the strip shows it.
        await page.key("Enter");
        assert.deepEqual(await collapsed(), ["in_progress"]);
        assert.deepEqual(await at(), { where: "in_progress", name: `Open the In progress column, ${counts["In progress"]} cards`, expanded: "false", shown: true });
        assert.deepEqual(await outline("in_progress"), { control: "none", strip: "2px solid" }, "the line is around the whole strip, which is the control now");
        await layout("with the keyboard on a strip");
        // A second press undoes the first, with the space bar as well as with Enter.
        await page.key("Space");
        assert.deepEqual(await collapsed(), []);
        assert.deepEqual(await at(), { where: "in_progress", name: "Collapse the In progress column", expanded: "true", shown: true });
        await page.key("Space");
        assert.deepEqual(await collapsed(), ["in_progress"]);
        // From a strip, Tab goes on to the next column: none of the collapsed column's cards is in the way.
        await page.key("Tab");
        assert.equal((await at()).where, "in_review");
        await page.key("Enter");
        await page.key("Tab");
        assert.equal((await at()).where, "next", "from one strip to the control of the column after it");
        await page.key("Tab");
        assert.equal((await at()).where, "card", "and in an open column the cards come after the control");

        // With every column collapsed, Tab visits the strips in the order of the columns, then the line that opens them all.
        await loadCollapsed(ALL);
        await page.run(`document.querySelector(${JSON.stringify(control("in_progress"))}).focus()`);
        const visited = ["in_progress"];
        for (let press = 0; press < 8; press++) {
          await page.key("Tab");
          visited.push((await at()).where);
        }
        assert.deepEqual(visited, [...ALL, "note"]);
        // Enter on "Open all" opens them. The line is gone, and the keyboard is on the first column's control.
        await page.key("Enter");
        assert.deepEqual(await collapsed(), []);
        assert.deepEqual(await at(), { where: "in_progress", name: "Collapse the In progress column", expanded: "true", shown: true });
        assert.deepEqual(page.errors, []);
      } finally {
        await forget();
      }
    });

    it("on a phone, where the columns are stacked, makes a collapsed column a short bar across the screen, and a strip again on a wide window", async () => {
      await page.size(390, 844, true);
      await load();
      try {
        const counts = await columns();
        const wide = (await column("next")).width;
        await page.tap(control("next"));
        const bar = await column("next");
        assert.deepEqual([bar.collapsed, bar.width, bar.cards], [true, wide, 0], "as wide as the screen leaves, like the columns above and below it");
        assert.ok(bar.height >= 36 && bar.height <= 56, `and as low as its heading: ${bar.height}px`);
        assert.equal(await page.run<string>("return getComputedStyle(document.querySelector('.column[data-key=\"next\"] .column-head')).writingMode"), "horizontal-tb", "its name is written across");
        assert.deepEqual(await columns(), counts);
        const tops = await page.run<number[]>("return [...document.querySelectorAll('.board > .column')].map((c) => Math.round(c.getBoundingClientRect().top))");
        assert.equal(new Set(tops).size, tops.length, "the columns are still one under the other");
        await layout("with a column collapsed on a phone");
        await page.scheme("dark");
        await layout("with a column collapsed on a phone, dark");
        await page.scheme("light");
        // Every column a bar, and the line under them.
        for (const key of ALL.filter((key) => key !== "next")) await page.tap(control(key));
        assert.deepEqual((await board()).map((c) => [c.collapsed, c.width, c.height <= 56]), ALL.map(() => [true, wide, true]));
        assert.equal(await page.run<boolean>("const note = document.querySelector('.columns-note').getBoundingClientRect(); return note.top >= document.querySelector('.column[data-key=\"cancelled\"]').getBoundingClientRect().bottom && note.width > 0"), true, "the line that opens them all is under the bars");
        await layout("with every column collapsed on a phone");
        // A tap anywhere on a bar opens it.
        await page.tap(".column[data-key='next']");
        assert.deepEqual(await collapsed(), ALL.filter((key) => key !== "next"));
        assert.ok((await column("next")).cards > 0);
        // The same page on a wide window: the bars are strips.
        await page.size(1280, 900);
        await page.until("return Math.round(document.querySelector('.column[data-key=\"done\"]').getBoundingClientRect().width) === 40", "the bars to become strips");
        assert.deepEqual((await board()).filter((c) => c.collapsed).map((c) => [c.key, c.width]), ALL.filter((key) => key !== "next").map((key) => [key, 40]));
        await layout("with the bars of a phone turned into strips");
        for (const width of [320, 640, 641, 768, 1024, 1920]) {
          await page.size(width, 900, width <= 640);
          await layout(`with all but one column collapsed at ${width}px`);
        }
        assert.deepEqual(page.errors, []);
      } finally {
        await forget();
        await page.size(1280, 900);
      }
    });

    it("sends the card of a task that goes into a collapsed column to the strip, which takes it in, and brings one that comes out of it from the strip", async () => {
      await page.size(1500, 900);
      const mine = `[...document.querySelectorAll('.card-ghost')].find((g) => g.querySelector('.id').textContent === ${JSON.stringify(ids.address)})`;
      const card = `document.querySelector('.card[data-id="${ids.address}"]')`;
      type Spot = { x: number; y: number; width: number; opacity: number };
      /** The travelling copy at the start of its journey, once it has lifted off, and as it lands. */
      const journey = () =>
        page.run<{ start: Spot; lifted: Spot; end: Spot }>(`
          const ghost = ${mine}; const flight = ghost.getAnimations()[0];
          const total = flight.effect.getComputedTiming().duration; const was = flight.currentTime;
          const at = (time) => { flight.currentTime = time; const r = ghost.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, opacity: Number(getComputedStyle(ghost).opacity) }; };
          const seen = { start: at(0), lifted: at(150), end: at(total - 1) };
          flight.currentTime = was;
          return seen;
        `);
      const strip = () => page.run<{ left: number; right: number; top: number; bottom: number }>("const r = document.querySelector('.column.collapsed[data-key=\"done\"]').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }");
      // Counts the notes played, in place of listening to them.
      const COUNT = "window.notes = 0; const start = OscillatorNode.prototype.start; OscillatorNode.prototype.start = function (...args) { window.notes++; return start.apply(this, args); };";
      let other: { id: string; version: number } | null = null;
      try {
        await load();
        await page.run("localStorage.setItem('vigile.auto-refresh', 'on'); localStorage.setItem('vigile.sound', 'on')");
        await loadCollapsed(["waiting", "paused", "draft", "done", "cancelled"]);
        await page.run(COUNT);
        await live();
        const counts = await columns();
        const from = await page.run<{ x: number; width: number }>(`const r = ${card}.getBoundingClientRect(); return { x: r.left + r.width / 2, width: r.width }`);

        // Into the collapsed column: the card lifts off where it was, travels to the strip, and shrinks into it.
        await move(ids.address!, "done");
        await page.until(`return Boolean(${mine})`, "the card to set off for the strip", 1500);
        const into = await journey();
        const room = await strip();
        assert.ok(Math.abs(into.start.x - from.x) <= 2 && Math.abs(into.start.width - from.width) <= 2 && into.start.opacity === 1, `it sets off from where the card was: ${JSON.stringify(into.start)}`);
        assert.ok(into.end.x > room.left && into.end.x < room.right && into.end.y > room.top && into.end.y < room.bottom, `and lands on the strip: at ${Math.round(into.end.x)}, ${Math.round(into.end.y)}, the strip being ${JSON.stringify(room)}`);
        assert.ok(into.end.width < 60 && into.end.opacity < 0.05, `where it is taken in: ${Math.round(into.end.width)}px wide and no longer seen`);
        assert.deepEqual(await page.run(`return [${card}, document.querySelector('.column[data-key="done"]').classList.contains('changed')]`), [null, true], "there is no card of it on the board, and the strip is ringed");
        assert.equal((await columns()).Done, counts.Done! + 1, "the strip counts one card more");
        await page.until("return window.notes === 2", "the sound for the completed task", 2500);
        // Another change arrives while the copy is on its way, which is slowed down here to be sure of that: the
        // board is drawn again under it, and its journey is not cut short.
        await page.run(`${mine}.getAnimations()[0].playbackRate = 0.1; ${mine}.dataset.mark = 'first';`);
        other = (await run("create_task", { title: "Arrives during the journey to the strip", description: "d", project: "WEB" })) as { id: string; version: number };
        await page.until(`return document.querySelector('.card[data-id="${other.id}"]') !== null`, "the board to be drawn again", 1500);
        assert.equal(await page.run<string | undefined>(`return ${mine}?.dataset.mark`), "first", "the same copy is still on its way");
        await page.run(`${mine}.getAnimations()[0].playbackRate = 1`);
        await settled();
        assert.equal(await count(`.card[data-id="${ids.address}"]`), 0);
        await layout("after a card went into a collapsed column");

        // Out of it: the card grows out of the strip, and travels to its place in the column it now belongs to.
        await move(ids.address!, "open");
        await page.until(`return Boolean(${mine})`, "the card to set off from the strip", 1500);
        const out = await journey();
        assert.ok(out.start.x > room.left && out.start.x < room.right && out.start.y > room.top && out.start.y < room.bottom, `it sets off from the strip: at ${Math.round(out.start.x)}, ${Math.round(out.start.y)}`);
        assert.ok(out.start.width < 60 && out.start.opacity < 0.05, `out of which it grows: ${Math.round(out.start.width)}px wide at first`);
        assert.ok(out.lifted.opacity === 1 && out.lifted.width > 250, `to its own size before it leaves: ${Math.round(out.lifted.width)}px`);
        assert.deepEqual(await page.run(`return [${card}.closest('.column').dataset.key, getComputedStyle(${card}).visibility, ${card}.classList.contains('changed'), document.querySelector('.column[data-key="done"]').classList.contains('changed')]`), ["next", "hidden", true, true], "the card waits unseen where it will land, ringed, and the strip it left is ringed too");
        assert.equal((await columns()).Done, counts.Done, "the strip counts one card fewer");
        await settled();
        assert.equal(await page.run<string>(`return getComputedStyle(${card}).visibility`), "visible");

        // A column is collapsed while a card is on its way between two others: the columns move, so the journey
        // ends there and then, with the card in its place.
        await move(ids.address!, "in_progress");
        await page.until(`return Boolean(${mine})`, "the card to set off for its column", 1500);
        await page.run(`${mine}.getAnimations()[0].playbackRate = 0.1`);
        assert.equal(await page.run<string>(`return getComputedStyle(${card}).visibility`), "hidden");
        await page.click(control("in_review"));
        assert.deepEqual(await page.run(`return [document.querySelectorAll('.card-ghost').length, ${card}.closest('.column').dataset.key, getComputedStyle(${card}).visibility, ${card}.classList.contains('changed')]`), [0, "in_progress", "visible", true], "no copy is left in the air, and the card is where it belongs, ringed");
        assert.deepEqual(page.errors, []);
      } finally {
        await move(ids.address!, "open").catch(() => {});
        await move(ids.address!, "in_progress").catch(() => {});
        if (other) await run("delete", { id: other.id, version: (await run("get", { id: other.id })).version }).catch(() => {});
        await forget();
        await load();
      }
    });

    it("rings the strip of a collapsed column for as long as it rings a card, when a card in it changes state, arrives from another strip or leaves, and when animations are off", async () => {
      await page.size(1280, 900);
      const card = `document.querySelector('.card[data-id="${ids.review}"]')`;
      try {
        // A second task is in review, so that the column is still there when the first one leaves it.
        await move(ids.paused!, "in_progress", "in_review");
        await load();
        await page.run("localStorage.setItem('vigile.auto-refresh', 'on'); localStorage.setItem('vigile.bugs-apart', 'on')");
        await loadCollapsed(["trouble", "in_review", "done"]);
        await live();
        const counts = await columns();

        // A bug goes to review and stays in the column for bugs: its state changed there. Nothing travels.
        await watchGhosts();
        const began = Date.now();
        await move(ids.bugBusy!, "in_review");
        await page.until(`return document.querySelector('.column[data-key="trouble"]').classList.contains('changed')`, "the strip of the bugs to be ringed", 2000);
        assert.deepEqual([await ringed("in_review"), await ringed("done"), await ghosts()], [false, false, 0], "that strip alone, and no card travels");
        assert.deepEqual(await columns(), counts);
        // The mark is the one a changed card gets: the same ring, for the same six seconds, drawn on the inside of the strip.
        assert.deepEqual(
          await page.run("const s = getComputedStyle(document.querySelector('.column[data-key=\"trouble\"]')); return [s.animationName, s.animationDuration, /inset/.test(s.boxShadow) && /3px/.test(s.boxShadow)]"),
          ["changed-strip", "6s", true],
        );
        // Under reduced motion the ring does not fade: it is there, then gone, in every theme.
        await page.motion("reduce");
        for (const name of ["vigile", "dado", "jeev", "gito"]) {
          const shadow = await page.run<string>(`document.documentElement.dataset.theme = ${JSON.stringify(name)}; const s = getComputedStyle(document.querySelector('.column[data-key="trouble"]')); return s.animationName + ' ' + s.boxShadow`);
          assert.match(shadow, /^none .*0px 0px 0px 3px inset$/, `the strip is ringed in ${name} under reduced motion: ${shadow}`);
        }
        await page.run("document.documentElement.dataset.theme = 'vigile'");
        await page.motion("no-preference");
        // The keyboard is on a strip while the board is drawn again for the next change: it stays there.
        await page.run(`document.querySelector(${JSON.stringify(control("in_review"))}).focus({ preventScroll: true })`);

        // From one strip to another: the one it left and the one it came to are ringed, and nothing travels.
        await move(ids.review!, "done");
        await page.until(`return document.querySelector('.column[data-key="done"]').classList.contains('changed')`, "the strip of Done to be ringed", 2000);
        assert.deepEqual([await ringed("in_review"), await ghosts()], [true, 0]);
        const now = await columns();
        assert.deepEqual([now["In review"], now.Done], [counts["In review"]! - 1, counts.Done! + 1], "and both count what they hold now");
        assert.deepEqual(await page.run("const a = document.activeElement; return [a.matches('.column-fold'), a.closest('.column')?.dataset.key, a.getAttribute('aria-label')]"), [true, "in_review", "Open the In review column, 1 card"], "the keyboard is still on the strip it was on, whose control says the new count");
        // Opened in time, the column shows which card it was.
        await page.click(".column[data-key='done']");
        assert.deepEqual(await page.run(`return [${card}.closest('.column').dataset.key, ${card}.classList.contains('changed'), document.querySelectorAll('.column[data-key="done"] .card.changed').length]`), ["done", true, 1], "the card that arrived is ringed, and no other");
        await page.click(control("done"));
        assert.equal(await ringed("done"), true, "collapsed again, the strip is still ringed");

        // Drawing the same strip again synchronizes the running ring to its age; it does not count that age a
        // second time through a negative delay. Folding another column keeps this DOM node and redraws its mark.
        await page.wait(Math.max(0, 3000 - (Date.now() - began)));
        await page.click(control("done"));
        const progress = await page.run<number>(`return document.querySelector('.column[data-key="trouble"]').getAnimations().find((one) => one.animationName === 'changed-strip').effect.getComputedTiming().progress`);
        assert.ok(progress > 0.3 && progress < 0.7, `the three-second-old ring is half-way through, not at ${progress}`);
        // The first strip is ringed for as long as a card is: still after four seconds, no longer after seven.
        await page.wait(Math.max(0, 4000 - (Date.now() - began)));
        assert.equal(await ringed("trouble"), true, "still marked after 4 seconds");
        await page.wait(Math.max(0, 7000 - (Date.now() - began)));
        assert.equal(await ringed("trouble"), false, "no longer marked after 7 seconds");

        // With animations off nothing travels to a strip either, and the ring alone says what changed.
        await page.until(`return !document.querySelector('.column[data-key="in_review"]').classList.contains('changed')`, "the earlier rings to fade", 9000);
        await setting("motion");
        await watchGhosts();
        assert.equal(await count(`.column[data-key="in_progress"] .card[data-id="${ids.address}"]`), 1);
        await move(ids.address!, "in_review");
        await page.until(`return document.querySelector('.column[data-key="in_review"]').classList.contains('changed')`, "the strip to be ringed", 2000);
        assert.deepEqual([await ghosts(), await count(`.card[data-id="${ids.address}"]`), (await columns())["In review"]], [0, 0, 2], "the card is gone from its column without a journey, and the strip counts it");
        assert.deepEqual(page.errors, []);
      } finally {
        await page.motion("no-preference");
        await page.run("document.documentElement.dataset.theme = 'vigile'");
        await move(ids.address!, "in_progress").catch(() => {});
        await move(ids.bugBusy!, "in_progress").catch(() => {});
        await move(ids.review!, "open", "in_progress", "in_review").catch(() => {});
        await move(ids.paused!, "in_progress", "paused").catch(() => {});
        await forget();
        await load();
      }
    });

    it("opens the panel of a task that is in a collapsed column, from the address and from a link, and leaves the column collapsed", async () => {
      await page.size(1280, 900);
      try {
        // Card form is done, and Done is collapsed: the address of the task opens its panel all the same.
        await loadCollapsed(["done"], `/#board/${ids.card}`);
        await page.until("return document.querySelector('.detail-title')?.textContent === 'Card form'", "the panel of a task in a collapsed column");
        assert.deepEqual(await collapsed(), ["done"], "the column stays collapsed");
        assert.equal(await count(`.card[data-id="${ids.card}"]`), 0);
        await layout("with the panel of a task in a collapsed column");
        await page.key("Escape");
        assert.equal(await panelOpen(), false);
        assert.deepEqual(await collapsed(), ["done"]);
        // From a link in the panel of another task: Receipts waits for Card form.
        await page.run(`document.querySelector('.card[data-id="${ids.receipts}"]').focus({ preventScroll: true })`);
        await page.key("Enter");
        await page.until("return document.querySelector('.detail-title')?.textContent === 'Receipts'", "the panel of a task on the board");
        const link = await page.run<number>("return [...document.querySelectorAll('#detail .link')].findIndex((l) => l.querySelector('.name').textContent === 'Card form')");
        assert.ok(link >= 0, "a link to the task in the collapsed column");
        await page.click("#detail .link", link);
        await page.until("return document.querySelector('.detail-title')?.textContent === 'Card form'", "the linked task");
        assert.deepEqual(await collapsed(), ["done"]);
        // Closed, the keyboard is back on the card the first panel was opened from.
        await page.key("Escape");
        assert.equal(await panelOpen(), false);
        assert.equal(await page.run<string | undefined>("return document.activeElement.dataset.id"), ids.receipts);
        assert.deepEqual(await collapsed(), ["done"]);
        assert.deepEqual(page.errors, []);
      } finally {
        await forget();
      }
    });

    it("collapses and opens a column at once on a board of hundreds of cards, and leaves the cards of the other columns as they are", async () => {
      // A window in which Done has no spare width to take, with or without the first column: it is then not drawn again either.
      await page.size(1260, 900);
      const folder = mkdtempSync(join(tmpdir(), "vigile-browser-test-columns-"));
      let many: Service | null = null;
      try {
        initConfig(join(folder, "config.toml"), { name: "columns", port: await freePort() });
        many = await startService({ loaded: loadConfig(join(folder, "config.toml"), {}), log: () => {}, warn: () => {} });
        const plan = (operation: string, input: Record<string, unknown>) => many!.engine.execute(operation, "agent1", input) as Promise<any>;
        await plan("create_project", { title: "Many cards", prefix: "MANY" });
        for (let i = 0; i < 620; i++) {
          const { id, version } = await plan("create_task", { title: `Card ${i}`, description: "d", project: "MANY" });
          if (i < 300) await plan("set_task_status", { id, version, status: "done" });
          else if (i < 320) await plan("set_task_status", { id, version, status: "in_progress" });
        }
        await page.open("about:blank");
        await page.open(`${many.urls.base}/`);
        await page.until("return /^(Updated|Live)/.test(document.getElementById('sync').textContent)", "the page to show its data", 20_000);
        // Every card of the two long columns is on the board, and Next is scrolled a long way down.
        await page.run(`for (const more of document.querySelectorAll('.more[aria-expanded="false"]')) more.click()`);
        assert.deepEqual((await board()).map((c) => [c.key, c.cards]), [["in_progress", 20], ["next", 300], ["done", 300]]);
        await page.run("for (const card of document.querySelectorAll('.card')) card.kept = true; document.querySelector('.column[data-key=\"next\"] .cards').scrollTop = 5000;");
        /** Presses a column's control and says how long the page took over it, and what became of the cards that were there. */
        const press = (key: string) =>
          page.run<{ ms: number; kept: Record<string, number>; drawn: Record<string, number>; next: number }>(`
            const began = performance.now();
            document.querySelector(${JSON.stringify(control(key))}).click();
            const ms = performance.now() - began;
            const cards = (column, kept) => [...column.querySelectorAll('.card')].filter((card) => Boolean(card.kept) === kept).length;
            const columns = [...document.querySelectorAll('.board > .column')];
            return { ms, kept: Object.fromEntries(columns.map((c) => [c.dataset.key, cards(c, true)])), drawn: Object.fromEntries(columns.map((c) => [c.dataset.key, cards(c, false)])), next: Math.round(document.querySelector('.column[data-key="next"] .cards')?.scrollTop ?? -1) };
          `);
        // Collapsing the short column draws no card at all: the 600 cards of the others are the very ones that were there.
        const first = await press("in_progress");
        assert.deepEqual([first.kept, first.drawn, first.next], [{ in_progress: 0, next: 300, done: 300 }, { in_progress: 0, next: 0, done: 0 }, 5000], "the other columns keep their cards, and their place");
        assert.ok(first.ms < 150, `collapsing took ${Math.round(first.ms)} ms`);
        // Collapsing a column of 300 cards is no more work, and its strip says how many it holds.
        const second = await press("done");
        assert.deepEqual([second.kept, second.drawn, second.next], [{ in_progress: 0, next: 300, done: 0 }, { in_progress: 0, next: 0, done: 0 }, 5000]);
        assert.ok(second.ms < 150, `collapsing 300 cards took ${Math.round(second.ms)} ms`);
        assert.deepEqual(await named("done"), ["Open the Done column, 300 cards", "false"]);
        assert.deepEqual((await board()).map((c) => [c.key, c.collapsed, c.width, c.cards]), [["in_progress", true, 40, 0], ["next", false, 380, 300], ["done", true, 40, 0]]);
        await layout("with a column of 300 cards collapsed");
        // Opening it draws its own cards and no others.
        const third = await press("done");
        assert.deepEqual([third.kept, third.drawn, third.next], [{ in_progress: 0, next: 300, done: 0 }, { in_progress: 0, next: 0, done: 300 }, 5000], "only the cards of the column that was opened are drawn");
        assert.ok(third.ms < 400, `opening 300 cards took ${Math.round(third.ms)} ms`);
        assert.deepEqual(page.errors, []);
      } finally {
        await page.run("localStorage.removeItem('vigile.collapsed')").catch(() => {});
        await many?.stop();
        rmSync(folder, { recursive: true, force: true });
        await page.size(1280, 900);
        await load();
      }
    });

    /** The copy of a task's card that is in the air, as the page finds it. */
    const copyOf = (id: string) => `[...document.querySelectorAll('.card-ghost')].find((g) => g.querySelector('.id').textContent === ${JSON.stringify(id)})`;
    type Spot = { x: number; y: number; width: number; opacity: number };
    /** A travelling copy at the start of its journey, once it has lifted off, and as it lands. */
    const journeyOf = (id: string) =>
      page.run<{ start: Spot; lifted: Spot; end: Spot }>(`
        const ghost = ${copyOf(id)}; const flight = ghost.getAnimations()[0];
        const total = flight.effect.getComputedTiming().duration; const was = flight.currentTime;
        const at = (time) => { flight.currentTime = time; const r = ghost.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, opacity: Number(getComputedStyle(ghost).opacity) }; };
        const seen = { start: at(0), lifted: at(150), end: at(total - 1) };
        flight.currentTime = was;
        return seen;
      `);
    type Room = { left: number; right: number; top: number; bottom: number };
    const roomOf = (key: string) => page.run<Room>(`const r = document.querySelector('.column.collapsed[data-key="${key}"]').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }`);
    const within = (spot: Spot, room: Room) => spot.x > room.left && spot.x < room.right && spot.y > room.top && spot.y < room.bottom;
    /** What a card does by itself besides being ringed: the fade of a new card, or the slide of one that moved in its column. */
    const ownMoves = (id: string) => page.run<number>(`return document.querySelector('.card[data-id="${id}"]').getAnimations().filter((a) => !a.animationName).length`);
    const cardAt = (id: string) => page.run<[string, string, boolean] | null>(`const c = document.querySelector('.card[data-id="${id}"]'); return c ? [c.closest('.column').dataset.key, getComputedStyle(c).visibility, c.classList.contains('changed')] : null`);
    /** Whether the page has read the plan and shown it without failing: a failure while it shows what changed is reported as a service that cannot be reached. */
    const connected = () => page.run<boolean>("return document.getElementById('notice').hidden && !document.getElementById('sync').textContent.startsWith('Not connected')");
    /** Puts a task in a state, from whichever of the states on the way it is in: for putting the plan back. */
    const back = async (id: string, ...statuses: string[]) => {
      for (const status of statuses) await move(id, status).catch(() => {});
    };

    it("starts a card's journey where its strip was when the last task leaves a collapsed column and the strip goes with it, and lands one on a strip that its arrival makes", async () => {
      await page.size(1280, 900);
      const id = ids.review!;
      try {
        await load();
        await page.run("localStorage.setItem('vigile.auto-refresh', 'on')");
        await loadCollapsed(["in_review"]);
        await live();
        assert.deepEqual([await collapsed(), (await columns())["In review"]], [["in_review"], 1], "In review is collapsed and holds one task: the column is there for that task alone");

        // The last task leaves: the strip is gone from the new drawing, and the card sets off from where it stood.
        const stood = await roomOf("in_review");
        await move(id, "in_progress");
        await page.until(`return Boolean(${copyOf(id)})`, "the card to set off from where the strip was", 1500);
        const out = await journeyOf(id);
        assert.equal(await count(".column[data-key='in_review']"), 0, "the column went with its last task");
        assert.ok(within(out.start, stood), `the card sets off from where the strip stood: at ${Math.round(out.start.x)}, ${Math.round(out.start.y)}, the strip having been ${JSON.stringify(stood)}`);
        assert.ok(out.start.width < 60 && out.start.opacity < 0.05 && out.lifted.width > 250 && out.lifted.opacity === 1, `out of which it grows: ${Math.round(out.start.width)}px wide at first, ${Math.round(out.lifted.width)}px when it leaves`);
        assert.deepEqual([await cardAt(id), await ownMoves(id)], [["in_progress", "hidden", true], 0], "the card waits unseen where it will land, ringed, and does not fade in as a new card does");
        await settled();

        // The first task enters: its arrival makes the strip, and the card lands on it.
        await move(id, "in_review");
        await page.until(`return Boolean(${copyOf(id)})`, "the card to set off for the strip that its arrival makes", 1500);
        const into = await journeyOf(id);
        const made = await roomOf("in_review");
        assert.ok(within(into.end, made) && into.end.width < 60 && into.end.opacity < 0.05, `the card lands on the new strip and is taken in: at ${Math.round(into.end.x)}, ${Math.round(into.end.y)}, ${Math.round(into.end.width)}px wide`);
        assert.deepEqual([await cardAt(id), await ringed("in_review"), (await columns())["In review"]], [null, true, 1], "the new strip is ringed and counts the task");
        await settled();

        // With no choice saved, the system's reduced-motion preference leaves only the ring.
        await page.motion("reduce");
        await watchGhosts();
        await move(id, "in_progress");
        await page.until(`return document.querySelector('.card[data-id="${id}"]') !== null`, "the card to appear without travelling under reduced motion", 1500);
        assert.deepEqual([await ghosts(), await cardAt(id), await ownMoves(id)], [0, ["in_progress", "visible", true], 0]);
        await page.motion("no-preference");

        // With animations switched off nothing travels, in either direction: the rings say it.
        await setting("motion");
        await watchGhosts();
        await move(id, "in_review");
        await page.until("return document.querySelector('.column[data-key=\"in_review\"]')?.classList.contains('changed')", "the new strip to be ringed", 2000);
        await move(id, "in_progress");
        await page.until(`return document.querySelector('.card[data-id="${id}"]') !== null`, "the card to be back", 2000);
        assert.deepEqual([await ghosts(), await cardAt(id), await ownMoves(id)], [0, ["in_progress", "visible", true], 0]);
        await setting("motion");

        // A strip that has no place on the page is no place to set off from. There is then no journey, which is
        // not the same as a new card: the card is in its place at once, ringed, and does not fade in.
        await move(id, "in_review");
        await page.until("return document.querySelector('.column.collapsed[data-key=\"in_review\"]') !== null", "the strip to be back", 2000);
        await settled();
        await page.run("document.querySelector('.column[data-key=\"in_review\"]').style.display = 'none'");
        await watchGhosts();
        await move(id, "in_progress");
        await page.until(`return document.querySelector('.card[data-id="${id}"]') !== null`, "the card to be back", 2000);
        assert.deepEqual([await ghosts(), await cardAt(id), await ownMoves(id)], [0, ["in_progress", "visible", true], 0], "no journey, no fade: the card is there, ringed");
        assert.equal(await connected(), true, "and the page has shown the change without failing over it");
        assert.deepEqual(page.errors, []);
      } finally {
        await page.motion("no-preference");
        await back(id, "in_progress", "in_review");
        await forget();
        await load();
      }
    });

    it("in one refresh sends two tasks that swap between a column and a strip on their two journeys, and nothing between a strip that goes and a strip that comes", async () => {
      await page.size(1280, 900);
      const [a, b] = [ids.address!, ids.review!];
      const drawnAgain = async () => {
        await page.run("window.drawn = 0; window.drawnWatch?.disconnect(); window.drawnWatch = new MutationObserver(() => window.drawn++); window.drawnWatch.observe(document.getElementById('board'), { childList: true })");
        await page.click("#refresh");
        await page.until("return window.drawn > 0", "the board to be drawn again");
      };
      try {
        // Nothing is paused, so that column is not on the board; were it there, it would be a strip.
        await move(ids.paused!, "in_progress");
        await loadCollapsed(["in_review", "paused"]);
        assert.deepEqual([await collapsed(), (await columns())["In review"], await cardAt(a)], [["in_review"], 1, ["in_progress", "visible", false]]);
        const strip = await roomOf("in_review");

        // One task goes into the strip while the one that was in it comes out, and the page reads both at once.
        await move(a, "in_review");
        await move(b, "in_progress");
        await watchGhosts();
        await drawnAgain();
        await page.until(`return Boolean(${copyOf(a)}) && Boolean(${copyOf(b)})`, "both cards to be on their way", 1500);
        const [into, out] = [await journeyOf(a), await journeyOf(b)];
        assert.ok(within(into.end, strip) && into.end.width < 60 && !within(into.start, strip), "one lands on the strip, from its column");
        assert.ok(within(out.start, strip) && out.start.width < 60 && !within(out.end, strip), "the other sets off from the strip, for its column");
        assert.deepEqual([await ghosts(), await cardAt(a), await cardAt(b), await ringed("in_review"), (await columns())["In review"]], [2, null, ["in_progress", "hidden", true], true, 1], "two copies in the air, the strip ringed and holding one task as before");
        await settled();

        // From a strip that goes with its last task to a strip that comes with its first: there is no card at
        // either end, so nothing travels, and the strip that came says what happened.
        await move(a, "in_progress", "paused");
        await watchGhosts();
        await drawnAgain();
        assert.deepEqual(await collapsed(), ["paused"], "In review is gone, and Paused has come, collapsed as the browser remembers it");
        assert.deepEqual([await ghosts(), await cardAt(a), await ringed("paused"), (await columns()).Paused, await named("paused")], [0, null, true, 1, ["Open the Paused column, 1 card", "false"]]);
        assert.equal(await connected(), true);
        assert.deepEqual(page.errors, []);
      } finally {
        await back(a, "in_progress");
        await back(b, "in_progress", "in_review");
        await back(ids.paused!, "in_progress", "paused");
        await forget();
        await load();
      }
    });

    it("ends a journey to a strip or from one when its column is opened or collapsed under it", async () => {
      await page.size(1280, 900);
      const id = ids.address!;
      try {
        await load();
        await page.run("localStorage.setItem('vigile.auto-refresh', 'on')");
        await loadCollapsed(["in_review"]);
        await live();
        // On its way into the strip, and the strip is opened: the card is in the open column, in sight.
        await move(id, "in_review");
        await page.until(`return Boolean(${copyOf(id)})`, "the card to set off for the strip", 1500);
        await page.run(`${copyOf(id)}.getAnimations()[0].playbackRate = 0.05`);
        await page.click(".column[data-key='in_review']");
        assert.deepEqual([await count(".card-ghost"), await cardAt(id), await collapsed()], [0, ["in_review", "visible", true], []], "no copy is left in the air, and the card is in the column that was opened, ringed");
        // On its way out of the strip, and the column it is going to is collapsed: it is in that strip now.
        await page.click(control("in_review"));
        await move(id, "in_progress");
        await page.until(`return Boolean(${copyOf(id)})`, "the card to set off from the strip", 1500);
        await page.run(`${copyOf(id)}.getAnimations()[0].playbackRate = 0.05`);
        const held = (await columns())["In progress"];
        await page.click(control("in_progress"));
        assert.deepEqual([await count(".card-ghost"), await cardAt(id), await collapsed(), (await columns())["In progress"]], [0, null, ["in_progress", "in_review"], held]);
        assert.equal(await connected(), true);
        assert.deepEqual(page.errors, []);
      } finally {
        await back(id, "in_progress");
        await forget();
        await load();
      }
    });

    it("rings a strip for every change that rings a card: whatever a card shows, and nothing that it does not show", async () => {
      await page.size(1280, 900);
      const made: string[] = [];
      const create = async (title: string, extra: Record<string, unknown> = {}) => {
        const { id } = (await run("create_task", { title, description: "d", project: "WEB", ...extra })) as { id: string };
        made.unshift(id);
        return id;
      };
      /** Changes an item at its present version, as another client would. */
      const change = async (operation: string, input: { id: string } & Record<string, unknown>) => run(operation, { ...input, version: (await run("get", { id: input.id })).version });
      let broken = false;
      try {
        // A task that waits, so that it stays in one column through all that is done to it.
        const first = await create("Waited for");
        const second = await create("Waited for as well");
        const task = await create("Shows a good deal", { depends_on: [first] });
        const [groupOne, groupTwo] = [await create("Holds it"), await create("Holds it too")];
        const [goesOpen, goesCollapsed] = [await create("Deleted while its column is open", { depends_on: [first] }), await create("Deleted while its column is collapsed", { depends_on: [first] })];
        await load();
        await page.run("localStorage.removeItem('vigile.auto-refresh')");
        /**
         * Makes one change while the task's column is open or collapsed, has the page read the plan, and says what
         * is ringed for it: the task's card in the open column; the strip of the collapsed one, and the task's
         * card once that strip is opened.
         */
        const rings = async (how: "open" | "collapsed", make: () => Promise<unknown>) => {
          await page.run(`localStorage.setItem('vigile.collapsed', ${JSON.stringify(how === "collapsed" ? '["waiting"]' : "[]")})`);
          await load();
          assert.equal(await count(".changed"), 0, "nothing is ringed on a page that was just opened");
          await page.run("window.drawn = 0; new MutationObserver(() => window.drawn++).observe(document.getElementById('board'), { childList: true })");
          await make();
          await page.click("#refresh");
          await page.until("return window.drawn > 0", "the board to be drawn again");
          if (how === "open") return page.run<boolean | null>(`return document.querySelector('.column[data-key="waiting"] .card[data-id="${task}"]')?.classList.contains('changed') ?? null`);
          const strip = await ringed("waiting");
          await page.click(".column[data-key='waiting']");
          const card = await page.run<boolean | null>(`return document.querySelector('.column[data-key="waiting"] .card[data-id="${task}"]')?.classList.contains('changed') ?? null`);
          return card === null ? null : [strip, card];
        };
        const link = (from: string, type: string, to: string) => () => run("add_link", { from, type, to });
        /** Each thing a card shows, changed once with the column open and once more with it collapsed. */
        const shown: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
          ["the title", () => change("update_task", { id: task, title: "Shows a good deal, and more" }), () => change("update_task", { id: task, title: "Shows a good deal, and more still" })],
          ["the kind", () => change("update_task", { id: task, type: "bug" }), () => change("update_task", { id: task, type: "incident" })],
          ["the priority", () => change("update_task", { id: task, priority: 3 }), () => change("update_task", { id: task, priority: 7 })],
          ["who it is assigned to", link(task, "assigned to", "user"), link(task, "assigned to", "agent1")],
          ["the groups it is in", link(groupOne, "contains", task), link(groupTwo, "contains", task)],
          ["what it waits for", link(task, "depends on", second), link(task, "depends on", "EMPTY")],
          ["that it has a problem", () => change("set_project_status", { id: "EMPTY", status: "broken" }).then(() => (broken = true)), () => change("set_project_status", { id: "EMPTY", status: "open" }).then(() => (broken = false))],
          ["how far the tasks inside it are", () => create("Inside it", { parent: task }), () => create("Inside it too", { parent: task })],
        ];
        const seen: Record<string, unknown> = {};
        for (const [what, whileOpen, whileCollapsed] of shown) seen[what] = [await rings("open", whileOpen), await rings("collapsed", whileCollapsed)];
        assert.deepEqual(seen, Object.fromEntries(shown.map(([what]) => [what, [true, [true, true]]])), "each change rings the card, and with the column collapsed the strip and the card in it");

        // What no card shows rings nothing, open or collapsed: the description, the reason, the size, the value.
        assert.deepEqual(
          [await rings("open", () => change("update_task", { id: task, description: "Another description.", why: "Another reason." })), await rings("collapsed", () => change("update_task", { id: task, size: 3, value: 5 }))],
          [false, [false, false]],
          "a change that no card shows rings neither the card nor the strip",
        );
        // A task that is deleted leaves its column. With the column open its card goes and no other card is ringed;
        // collapsed, the strip is ringed for the card that left it, counts one fewer, and no card in it is ringed.
        const waiting = (await columns())["Waiting for dependencies"]!;
        assert.equal(await rings("open", () => change("delete", { id: goesOpen })), false);
        assert.equal(await count(`.card[data-id="${goesOpen}"]`), 0);
        assert.deepEqual(await rings("collapsed", () => change("delete", { id: goesCollapsed })), [true, false]);
        assert.equal((await columns())["Waiting for dependencies"], waiting - 2);
        assert.deepEqual(page.errors, []);
      } finally {
        if (broken) await run("set_project_status", { id: "EMPTY", status: "open", version: (await run("get", { kind: "project", id: "EMPTY" })).version }).catch(() => {});
        for (const id of made) await run("delete", { id, version: (await run("get", { id })).version }).catch(() => {});
        await forget();
        await load();
      }
    });

    it("rings nothing for what the person does to the page: the filter, a project, the theme, a column collapsed or opened", async () => {
      await page.size(1280, 900);
      const id = ids.launch!;
      /** Has the page read the plan, and waits until it has drawn the board for it. */
      const read = async () => {
        await page.run("window.drawn = 0; window.drawnWatch?.disconnect(); window.drawnWatch = new MutationObserver(() => window.drawn++); window.drawnWatch.observe(document.getElementById('board'), { childList: true })");
        await page.click("#refresh");
        await page.until("return window.drawn > 0", "the board to be drawn again");
      };
      const priority = (await run("get", { id })).priority as number;
      try {
        await loadCollapsed(["waiting", "done"]);
        assert.equal(await count(`.card[data-id="${id}"]`), 0, "the task is in a collapsed column");
        // The filter leaves fewer cards, a project takes its name off every card, a theme draws them otherwise,
        // and a column is collapsed and opened: none of it is news of the plan.
        await page.click("#filter");
        await page.type("e");
        assert.equal(await count(".changed"), 0, "after typing in the filter");
        await page.run("document.getElementById('filter').select()");
        await page.key("Backspace");
        await page.run("[...document.querySelectorAll('#projects .project-main')].find((card) => card.querySelector('.project-id').textContent === 'WEB').click()");
        assert.equal(await count(".changed"), 0, "after selecting a project");
        await theme("gito");
        await page.click(control("next"));
        await page.click(".column[data-key='next']");
        assert.equal(await count(".changed"), 0, "after a theme, and a column collapsed and opened");
        // The plan is read after all that, and something no card shows has changed in it: still nothing is ringed,
        // although every card and every strip is drawn otherwise than when the page was opened.
        await run("update_task", { id, version: (await run("get", { id })).version, description: "Another description of the launch." });
        await read();
        assert.equal(await count(".changed"), 0, "after the plan was read with the project selected");
        // And then something a card shows: the strip of its column is ringed, and that strip alone.
        await run("update_task", { id, version: (await run("get", { id })).version, priority: priority + 1 });
        await read();
        assert.deepEqual(await page.run("return [...document.querySelectorAll('.changed')].map((el) => el.dataset.key ?? el.dataset.id)"), ["waiting"]);
        assert.deepEqual(page.errors, []);
      } finally {
        await run("update_task", { id, version: (await run("get", { id })).version, priority, description: "Description of Launch the checkout." }).catch(() => {});
        await page.run("localStorage.removeItem('vigile.theme'); document.documentElement.dataset.theme = 'vigile'");
        await forget();
        await load();
      }
    });

    it("leaves the keyboard on the strip when the card it was on is taken into a collapsed column, also into one that the task's arrival makes", async () => {
      await page.size(1280, 900);
      const where = () => page.run<[string, string | null, string | null]>("const a = document.activeElement; return [a.matches('.column-fold') ? 'strip ' + a.closest('.column').dataset.key : a.dataset.id ? 'card ' + a.dataset.id : a.tagName, a.getAttribute('aria-label'), a.getAttribute('aria-expanded')]");
      try {
        // Nothing is paused, so that column is not on the board; were it there, it would be a strip.
        await move(ids.paused!, "in_progress");
        await load();
        await page.run("localStorage.setItem('vigile.auto-refresh', 'on')");
        await loadCollapsed(["in_review", "paused"]);
        await live();
        const reviewed = (await columns())["In review"]!;
        // The keyboard is on a card, and its task goes into the collapsed column: the strip stands for the card now.
        await page.run(`document.querySelector('.card[data-id="${ids.address}"]').focus({ preventScroll: true })`);
        assert.equal((await where())[0], `card ${ids.address}`);
        await move(ids.address!, "in_review");
        await page.until(`return document.querySelector('.card[data-id="${ids.address}"]') === null`, "the card to be taken into the strip", 2000);
        assert.deepEqual(await where(), ["strip in_review", `Open the In review column, ${reviewed + 1} cards`, "false"], "the keyboard is on the strip that holds the task");
        // From there Enter opens the column, and the card is one Tab away.
        await page.key("Enter");
        assert.deepEqual([await collapsed(), (await where())[0]], [[], "strip in_review"]);
        await settled();
        // Into a column that was not on the board: the strip that the arrival makes takes the keyboard.
        await page.run(`document.querySelector('.card[data-id="${ids.paused}"]').focus({ preventScroll: true })`);
        await move(ids.paused!, "paused");
        await page.until("return document.querySelector('.column.collapsed[data-key=\"paused\"]') !== null", "the strip that the task's arrival makes", 2000);
        assert.deepEqual(await where(), ["strip paused", "Open the Paused column, 1 card", "false"]);
        // A card that goes to an open column keeps the keyboard itself, as it always did.
        await settled();
        await page.run(`document.querySelector('.card[data-id="${ids.bugBusy}"]').focus({ preventScroll: true })`);
        await move(ids.bugBusy!, "in_review");
        await page.until(`return document.querySelector('.column[data-key="in_review"] .card[data-id="${ids.bugBusy}"]') !== null`, "the card to be in its new column", 2000);
        assert.equal((await where())[0], `card ${ids.bugBusy}`);
        assert.equal(await connected(), true);
        assert.deepEqual(page.errors, []);
      } finally {
        await back(ids.address!, "in_progress");
        await back(ids.bugBusy!, "in_progress");
        await back(ids.paused!, "in_progress", "paused");
        await forget();
        await load();
      }
    });

    it("rings a strip for a change in any task it holds, the fifty-first as the first and the last of 2,000, and builds no card to know it", async () => {
      await page.size(1280, 900);
      const folder = mkdtempSync(join(tmpdir(), "vigile-browser-test-held-"));
      let many: Service | null = null;
      try {
        initConfig(join(folder, "config.toml"), { name: "held", port: await freePort() });
        many = await startService({ loaded: loadConfig(join(folder, "config.toml"), {}), log: () => {}, warn: () => {} });
        const plan = (operation: string, input: Record<string, unknown>) => many!.engine.execute(operation, "agent1", input) as Promise<any>;
        await plan("create_project", { title: "Many tasks", prefix: "MANY" });
        const [busy, next]: [string[], string[]] = [[], []];
        for (let i = 0; i < 2003; i++) {
          const { id, version } = await plan("create_task", { title: `Task ${i}`, description: "d", project: "MANY" });
          if (i < 3) await plan("set_task_status", { id, version, status: "in_progress" });
          (i < 3 ? busy : next).push(id);
        }
        /** Opens the page of the large plan as a browser does that remembers these settings and no others. */
        const open = async (settings: Record<string, string> = {}) => {
          await page.open("about:blank");
          await page.open(`${many!.urls.base}/`);
          await page.run(`localStorage.clear(); for (const [name, value] of Object.entries(${JSON.stringify(settings)})) localStorage.setItem(name, value);`);
          await page.open("about:blank");
          await page.open(`${many!.urls.base}/`);
          await page.until("return /^(Updated|Live)/.test(document.getElementById('sync').textContent)", "the page to show its data", 20_000);
        };
        const drawn = () => page.run<string[]>("return [...document.querySelectorAll('.column[data-key=\"next\"] .card')].map((c) => c.dataset.id)");
        // Open, the column has a card for its first 50 tasks, and for its first 12 where the page scrolls as a whole.
        await open();
        assert.deepEqual(await drawn(), next.slice(0, 50));
        await open({ "vigile.scroll": "page" });
        assert.deepEqual(await drawn(), next.slice(0, 12));

        // Collapsed, it holds all 2,000, and the board is drawn without one card being built for them.
        await open({ "vigile.collapsed": '["next"]' });
        assert.deepEqual(await named("next"), ["Open the Next column, 2,000 cards", "false"]);
        const cost = await page.run<{ made: number; ms: number; cards: number }>(`
          const real = document.createElement; let made = 0;
          document.createElement = function (...args) { made++; return real.apply(this, args); };
          const began = performance.now();
          document.getElementById('filter').dispatchEvent(new Event('input'));
          const ms = performance.now() - began;
          document.createElement = real;
          return { made, ms, cards: document.querySelectorAll('.card').length };
        `);
        assert.equal(cost.cards, 3, "the three cards of the open column are all there are");
        assert.ok(cost.made < 150, `drawing the page again made ${cost.made} elements: the three cards and what is around them, none for the 2,000`);
        assert.ok(cost.ms < 150, `and took ${Math.round(cost.ms)} ms`);

        /** Changes one task while Next is collapsed, has the page read the plan, and says whether the strip is ringed. */
        const rings = async (settings: Record<string, string>, id: string, change: Record<string, unknown>) => {
          await open({ "vigile.collapsed": '["next"]', ...settings });
          await page.run("window.drawn = 0; new MutationObserver(() => window.drawn++).observe(document.getElementById('board'), { childList: true })");
          await plan("update_task", { id, version: (await plan("get", { id })).version, ...change });
          await page.click("#refresh");
          await page.until("return window.drawn > 0", "the board to be drawn again", 20_000);
          return ringed("next");
        };
        const whole = { "vigile.scroll": "page" };
        assert.deepEqual(
          {
            "the 50th task": await rings({}, next[49]!, { title: "Task 50, renamed" }),
            "the 51st, which an open column shows only on request": await rings({}, next[50]!, { title: "Task 51, renamed" }),
            "the last of 2,000": await rings({}, next[1999]!, { priority: 0, title: "The last task, renamed" }),
            "the 12th where the page scrolls as a whole": await rings(whole, next[11]!, { title: "Task 12, renamed" }),
            "the 13th there": await rings(whole, next[12]!, { title: "Task 13, renamed" }),
            "what no card shows, of the 51st": await rings({}, next[50]!, { description: "Another description." }),
            "a task of another column": await rings({}, busy[0]!, { title: "A task in progress, renamed" }),
          },
          {
            "the 50th task": true,
            "the 51st, which an open column shows only on request": true,
            "the last of 2,000": true,
            "the 12th where the page scrolls as a whole": true,
            "the 13th there": true,
            "what no card shows, of the 51st": false,
            "a task of another column": false,
          },
        );
        assert.deepEqual(page.errors, []);
      } finally {
        await many?.stop();
        rmSync(folder, { recursive: true, force: true });
        await load();
      }
    });

    it("rings a strip for the tasks the filter leaves in it and for one that a change brings under the filter, not for one that the filter hides", async () => {
      await page.size(1280, 900);
      const [hidden, found] = [ids.rates!, ids.launch!];
      const priorities = [(await run("get", { id: hidden })).priority as number, (await run("get", { id: found })).priority as number];
      const change = async (id: string, input: Record<string, unknown>) => run("update_task", { id, version: (await run("get", { id })).version, ...input });
      /** Opens the board with Waiting collapsed and "launch" in the filter, makes a change, has the page read the plan, and says what is ringed. */
      const rings = async (make: () => Promise<unknown>) => {
        await loadCollapsed(["waiting"]);
        await page.click("#filter");
        await page.type("launch");
        await page.run("window.drawn = 0; new MutationObserver(() => window.drawn++).observe(document.getElementById('board'), { childList: true })");
        await make();
        await page.click("#refresh");
        await page.until("return window.drawn > 0", "the board to be drawn again");
        return [(await columns())["Waiting for dependencies"], await ringed("waiting")];
      };
      try {
        assert.deepEqual(await rings(() => change(hidden, { priority: priorities[0]! + 1 })), [1, false], "a task that the filter hides is not on the strip, and what changes on it rings nothing");
        assert.deepEqual(await rings(() => change(found, { priority: priorities[1]! + 1 })), [1, true], "the task that the filter leaves rings the strip");
        assert.deepEqual(await rings(() => change(hidden, { title: "Rates, for the launch" })), [2, true], "a task whose new title the filter finds has come to the strip, which counts it and is ringed");
        assert.deepEqual(await rings(() => change(hidden, { title: "Rates" })), [1, true], "and one whose new title it no longer finds has left it");
        assert.deepEqual(page.errors, []);
      } finally {
        await change(hidden, { title: "Rates", priority: priorities[0] }).catch(() => {});
        await change(found, { priority: priorities[1] }).catch(() => {});
        await forget();
        await load();
      }
    });

    it("puts the keyboard, when the panel closes, on what stands for a task now: its card, the strip that holds it, or the link to the view when it has neither", async () => {
      await page.size(1280, 900);
      const [a, b] = [ids.address!, ids.review!];
      const at = () =>
        page.run<string>("const a = document.activeElement; return a.matches('.column-fold') ? 'strip ' + a.closest('.column').dataset.key + ': ' + a.getAttribute('aria-label') : a.dataset.id ? 'card ' + a.dataset.id : a.closest('#panel') ? 'panel' : a.id || a.tagName");
      const shown = (title: string) => page.until(`return !document.getElementById('panel').hidden && document.querySelector('.detail-title')?.textContent === ${JSON.stringify(title)}`, `the panel of ${title}`);
      const gone = (id: string) => page.until(`return document.querySelector('.card[data-id="${id}"]') === null`, "the card to be taken into the strip", 2000);
      let other: string | null = null;
      try {
        await load();
        await page.run("localStorage.setItem('vigile.auto-refresh', 'on')");
        await loadCollapsed(["in_review"]);
        await live();
        // Opened from a card, and the task goes into a collapsed column while the panel is open.
        await page.run(`document.querySelector('.card[data-id="${a}"]').focus({ preventScroll: true })`);
        await page.key("Enter");
        await shown("Address form");
        assert.equal(await at(), "panel");
        await move(a, "in_review");
        await gone(a);
        assert.equal(await at(), "panel", "the board is drawn again behind the panel, which keeps the keyboard");
        await page.key("Escape");
        assert.equal(await at(), "strip in_review: Open the In review column, 2 cards", "closed, the keyboard is on the strip that holds the task the panel was opened from");

        // Opened from a card and gone on to a linked item: the card it started from is what counts, as it is now.
        await move(a, "in_progress");
        await page.until(`return document.querySelector('.card[data-id="${a}"]') !== null`, "the card to be back", 2000);
        await settled();
        await page.run(`document.querySelector('.card[data-id="${a}"]').focus({ preventScroll: true })`);
        await page.key("Enter");
        await shown("Address form");
        await page.click("#detail .link", await page.run<number>("return [...document.querySelectorAll('#detail .link')].findIndex((l) => l.querySelector('.name').textContent === 'Shipping')"));
        await shown("Shipping");
        await move(a, "in_review");
        await gone(a);
        await page.key("Escape");
        assert.equal(await at(), "strip in_review: Open the In review column, 2 cards");
        await move(a, "in_progress");

        // Opened from the address, for a task in a collapsed column: there is nothing it was opened from, and the
        // strip stands for the task.
        await load(`/#board/${b}`);
        await shown("In review item");
        await page.key("Escape");
        assert.equal(await at(), "strip in_review: Open the In review column, 1 card");
        // The task leaves while its panel is open, the last of its column: the strip is gone and the task has a
        // card, on its way to its place. The keyboard wants it, so it lands at once.
        await load(`/#board/${b}`);
        await shown("In review item");
        await live();
        await move(b, "in_progress");
        await page.until(`return document.querySelector('.card[data-id="${b}"]') !== null`, "the card of the task that left the strip", 2000);
        await page.key("Escape");
        assert.deepEqual([await at(), await cardAt(b), await page.run<boolean>(`return Boolean(${copyOf(b)})`), await count(".column[data-key='in_review']")], [`card ${b}`, ["in_progress", "visible", true], false, 0]);
        await move(b, "in_review");

        // The task is deleted while its panel is open: it has no card and no strip, and the keyboard goes to the
        // link of the view, which is always there.
        other = ((await run("create_task", { title: "Deleted while its panel is open", description: "d", project: "WEB" })) as { id: string }).id;
        await move(other, "in_progress", "in_review");
        await load(`/#board/${other}`);
        await shown("Deleted while its panel is open");
        await live();
        await run("delete", { id: other, version: (await run("get", { id: other })).version });
        await page.until("return [...document.querySelectorAll('#detail .pill')].some((pill) => pill.textContent === 'deleted')", "the panel to say that the task is deleted", 3000);
        await page.key("Escape");
        assert.equal(await at(), "view-board");

        // A column is collapsed under the card that has the keyboard, by a click that does not take it: the strip has it.
        await load();
        await page.run(`document.querySelector('.card[data-id="${a}"]').focus({ preventScroll: true }); document.querySelector(${JSON.stringify(control("in_progress"))}).click();`);
        assert.match(await at(), /^strip in_progress: Open the In progress column, \d cards$/);
        await page.key("Enter");

        // In the graph there is no board for a task to be on: closed, the panel leaves the keyboard on the link of the view.
        await load("/#graph");
        await graphReady();
        await page.run("document.getElementById('zoom-fit').click()");
        const launch = await nodeAt(`task:${ids.launch}`);
        await page.clickAt(launch.x, launch.y);
        await shown("Launch the checkout");
        await page.key("Escape");
        assert.equal(await at(), "view-graph");
        assert.equal(await connected(), true);
        assert.deepEqual(page.errors, []);
      } finally {
        await back(a, "in_progress");
        await back(b, "in_progress", "in_review");
        if (other) await run("delete", { id: other, version: (await run("get", { id: other })).version }).catch(() => {});
        await forget();
        await load();
      }
    });

    it("takes a card into the middle of a collapsed column's bar on a phone and of its strip on a wide window, and brings it out from there", async () => {
      const id = ids.address!;
      type Rect = { left: number; right: number; top: number; bottom: number };
      /** Where the travelling copy is, as it is drawn, at the start of its journey and at its end. */
      const flightOf = () =>
        page.run<{ start: Rect; end: Rect }>(`
          const ghost = ${copyOf(id)}; const flight = ghost.getAnimations()[0];
          const total = flight.effect.getComputedTiming().duration; const was = flight.currentTime;
          const at = (time) => { flight.currentTime = time; const r = ghost.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
          const seen = { start: at(0), end: at(total - 0.01) };
          flight.currentTime = was;
          return seen;
        `);
      const middle = (r: Rect) => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
      const inside = (r: Rect, room: Rect) => r.left >= room.left - 1.5 && r.right <= room.right + 1.5 && r.top >= room.top - 1.5 && r.bottom <= room.bottom + 1.5;
      const say = (r: Rect) => `${Math.round(r.left)}..${Math.round(r.right)} across, ${Math.round(r.top)}..${Math.round(r.bottom)} down`;
      /** Holds the copy still a moment before the end of its journey or after its start, for a picture. */
      const picture = async (name: string, part: number) => {
        if (!shots) return;
        await page.run(`const flight = ${copyOf(id)}.getAnimations()[0]; window.flightWas = flight.currentTime; flight.pause(); flight.currentTime = flight.effect.getComputedTiming().duration * ${part};`);
        await page.shot(join(shots, `${name}.png`));
        await page.run(`const flight = ${copyOf(id)}.getAnimations()[0]; flight.currentTime = window.flightWas; flight.play();`);
      };
      try {
        await load();
        await page.run("localStorage.setItem('vigile.auto-refresh', 'on')");
        for (const [width, height, phone] of [[390, 844, true], [1280, 900, false]] as const) {
          const where = `at ${width}px`;
          await page.size(width, height, phone);
          await loadCollapsed(["in_review"]);
          await live();
          // Into the collapsed column: the copy ends shrunk inside the bar or the strip, around a point of it.
          await move(id, "in_review");
          await page.until(`return Boolean(${copyOf(id)})`, `the card to set off ${where}`, 1500);
          const into = await flightOf();
          const room = await roomOf("in_review");
          assert.ok(inside(into.end, room), `${where} the card ends inside the collapsed column: ${say(into.end)}, the column being ${say(room)}`);
          if (phone) assert.ok(Math.abs(middle(into.end).y - middle(room).y) <= 1.5 && Math.abs(middle(into.end).x - middle(into.start).x) <= 1.5, `${where} it ends in the middle of the bar from top to bottom, straight under where it was`);
          else assert.ok(Math.abs(middle(into.end).x - middle(room).x) <= 1.5 && Math.abs(middle(into.end).y - middle(into.start).y) <= 1.5, `${where} it ends in the middle of the strip across, level with where it was`);
          await picture(`a-card-goes-into-a-collapsed-column-${where.replaceAll(" ", "-")}`, 0.93);
          await settled();
          // Out of it: the copy starts shrunk inside the bar or the strip, and ends as the card in its place.
          await move(id, "in_progress");
          await page.until(`return Boolean(${copyOf(id)})`, `the card to set off from the collapsed column ${where}`, 1500);
          const out = await flightOf();
          const place = await page.run<Rect>(`const r = document.querySelector('.card[data-id="${id}"]').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }`);
          assert.ok(inside(out.start, room), `${where} the card starts inside the collapsed column: ${say(out.start)}, the column being ${say(room)}`);
          assert.ok(inside(out.end, place) && inside(place, out.end), `${where} and ends as the card in its place: ${say(out.end)}, the card being ${say(place)}`);
          await picture(`a-card-comes-out-of-a-collapsed-column-${where.replaceAll(" ", "-")}`, 0.07);
          await settled();
        }
        assert.equal(await connected(), true);
        assert.deepEqual(page.errors, []);
      } finally {
        await page.motion("no-preference");
        await page.size(1280, 900);
        await back(id, "in_progress");
        await forget();
        await load();
      }
    });

    it("keeps the mark of a task that changed whether or not a card is drawn for it: one that left a collapsed column for a place its new column shows only on request is ringed when it is shown in time", async () => {
      await page.size(1280, 900);
      const folder = mkdtempSync(join(tmpdir(), "vigile-browser-test-marks-"));
      let many: Service | null = null;
      try {
        initConfig(join(folder, "config.toml"), { name: "marks", port: await freePort() });
        many = await startService({ loaded: loadConfig(join(folder, "config.toml"), {}), log: () => {}, warn: () => {} });
        const plan = (operation: string, input: Record<string, unknown>) => many!.engine.execute(operation, "agent1", input) as Promise<any>;
        const change = async (operation: string, input: { id: string } & Record<string, unknown>) => plan(operation, { ...input, version: (await plan("get", { id: input.id })).version });
        await plan("create_project", { title: "Marks", prefix: "MARK" });
        await plan("create_project", { title: "Another project", prefix: "OTHER" });
        await plan("create_task", { title: "Elsewhere", description: "d", project: "OTHER" });
        /** Makes a task. One that is busy is in progress, the column that is collapsed here; the others are next. */
        const make = async (title: string, priority: number, busy = false) => {
          const { id, version } = await plan("create_task", { title, description: "d", project: "MARK", priority });
          if (busy) await plan("set_task_status", { id, version, status: "in_progress" });
          return id as string;
        };
        // Next is in the order of its priorities, and of making among equals. Each task that will move is made so
        // that it comes to a known place: the 12th and the 13th, the 50th and the 51st, and the last of 2,000.
        await make("Stays in progress", 0, true);
        const leaves = await make("Mover that is deleted", 0, true);
        for (let i = 1; i <= 11; i++) await make(`In line ${i}`, 4);
        const twelfth = await make("Mover to the 12th place", 3, true);
        await make("In line 12", 3);
        const thirteenth = await make("Mover to the 13th place", 3, true);
        for (let i = 13; i <= 49; i++) await make(`In line ${i}`, 2);
        const fiftieth = await make("Mover to the 50th place", 1, true);
        await make("In line 50", 1);
        const fiftyFirst = await make("Mover to the 51st place", 1, true);
        for (let i = 51; i <= 1999; i++) await make(`In line ${i}`, 0);
        const last = await make("Mover to the last place", 0, true);

        /** Opens the page of this plan as a browser does that remembers these settings and no others. */
        const open = async (settings: Record<string, string> = {}) => {
          await page.open("about:blank");
          await page.open(`${many!.urls.base}/`);
          await page.run(`localStorage.clear(); for (const [name, value] of Object.entries(${JSON.stringify(settings)})) localStorage.setItem(name, value);`);
          await page.open("about:blank");
          await page.open(`${many!.urls.base}/`);
          await page.until("return /^(Updated|Live)/.test(document.getElementById('sync').textContent)", "the page to show its data", 20_000);
        };
        /** Has the page read the plan, and waits until it has drawn the board for it. */
        const read = async () => {
          await page.run("window.drawn = 0; window.drawnWatch?.disconnect(); window.drawnWatch = new MutationObserver(() => window.drawn++); window.drawnWatch.observe(document.getElementById('board'), { childList: true })");
          await page.click("#refresh");
          await page.until("return window.drawn > 0", "the board to be drawn again", 20_000);
        };
        const goes = async (id: string) => {
          await change("set_task_status", { id, status: "open" });
          await read();
        };
        const comesBack = (id: string) => change("set_task_status", { id, status: "in_progress" });
        /** Whether a task's card is ringed, or nothing when no card is drawn for it. */
        const card = (id: string) => page.run<boolean | null>(`return document.querySelector('.card[data-id="${id}"]')?.classList.contains('changed') ?? null`);
        const place = (id: string) => page.run<number>(`return [...document.querySelectorAll('.column[data-key="next"] .card')].findIndex((c) => c.dataset.id === "${id}") + 1`);
        const showAll = () => page.run(`document.querySelector('.column[data-key="next"] .more').click()`);
        const strip = (key: string) => page.run<boolean>(`return document.querySelector('.column[data-key="${key}"]').classList.contains('changed')`);
        const SOURCE = { "vigile.collapsed": '["in_progress"]' };
        const WHOLE = { ...SOURCE, "vigile.scroll": "page" };
        /**
         * A task leaves the collapsed column for Next. Says whether the strip it left is ringed, whether its card
         * is ringed as the board is drawn, and whether it is ringed, and where it is, once the whole column is shown.
         */
        const moved = async (settings: Record<string, string>, id: string, before: () => Promise<unknown> = async () => {}) => {
          await open(settings);
          await goes(id);
          const seen = { strip: await strip("in_progress"), drawn: await card(id) };
          await before();
          await showAll();
          const shown = { ...seen, shown: await card(id), place: await place(id) };
          await comesBack(id);
          return shown;
        };
        assert.deepEqual(
          {
            "to the 50th place, which the column shows": await moved(SOURCE, fiftieth),
            "to the 51st, which it shows on request": await moved(SOURCE, fiftyFirst),
            "to the last of 2,000": await moved(SOURCE, last),
            "to the 12th place where the page scrolls as a whole": await moved(WHOLE, twelfth),
            "to the 13th there": await moved(WHOLE, thirteenth),
            "to the 51st, shown when the time of the mark is up": await moved(SOURCE, fiftyFirst, () => page.wait(6300)),
          },
          {
            "to the 50th place, which the column shows": { strip: true, drawn: true, shown: true, place: 50 },
            "to the 51st, which it shows on request": { strip: true, drawn: null, shown: true, place: 51 },
            "to the last of 2,000": { strip: true, drawn: null, shown: true, place: 2000 },
            "to the 12th place where the page scrolls as a whole": { strip: true, drawn: true, shown: true, place: 12 },
            "to the 13th there": { strip: true, drawn: null, shown: true, place: 13 },
            "to the 51st, shown when the time of the mark is up": { strip: true, drawn: null, shown: false, place: 51 },
          },
        );

        // Under reduced motion the ring of the card that is shown on request does not fade: it is there.
        await page.motion("reduce");
        await open(SOURCE);
        await goes(fiftyFirst);
        await showAll();
        assert.match(await page.run<string>(`const s = getComputedStyle(document.querySelector('.card[data-id="${fiftyFirst}"]')); return s.animationName + ' ' + s.boxShadow`), /^none .*0px 0px 0px 3px$/);
        await page.motion("no-preference");
        await comesBack(fiftyFirst);

        // The column it goes to is collapsed too: both strips are ringed, and the card when that column is opened and shown whole.
        await open({ "vigile.collapsed": '["in_progress","next"]' });
        await goes(fiftyFirst);
        assert.deepEqual([await strip("in_progress"), await strip("next"), await card(fiftyFirst)], [true, true, null]);
        await page.click(".column[data-key='next']");
        assert.equal(await card(fiftyFirst), null, "opened, the column shows its first 50");
        await showAll();
        assert.deepEqual([await card(fiftyFirst), await place(fiftyFirst)], [true, 51]);
        await comesBack(fiftyFirst);
        // From an open column the card goes, and is ringed where it is shown on request.
        await open();
        assert.equal(await card(fiftyFirst), false);
        await goes(fiftyFirst);
        assert.equal(await card(fiftyFirst), null);
        await showAll();
        assert.equal(await card(fiftyFirst), true);
        await comesBack(fiftyFirst);

        // The filter hides the task: it is not on the board when it moves, and there is no mark to show when the filter is cleared.
        await open(SOURCE);
        await page.click("#filter");
        await page.type("In line");
        await goes(fiftyFirst);
        assert.deepEqual([await strip("in_progress"), await count(".changed")], [false, 0], "nothing is ringed for a task that the filter hides");
        await page.run("document.getElementById('filter').select()");
        await page.key("Backspace");
        await showAll();
        assert.deepEqual([await card(fiftyFirst), await place(fiftyFirst), await count(".changed")], [false, 51, 0], "clearing the filter shows the task where it is, and makes no mark");
        await comesBack(fiftyFirst);
        // Another project is selected when it moves: the same. And a mark that was made is gone once the board is
        // narrowed to a project the task is not in, also when the board is widened again in time.
        const choose = (project: string) => page.run(`[...document.querySelectorAll('#projects .project-main')].find((card) => card.querySelector('.project-id').textContent === ${JSON.stringify(project)}).click()`);
        await open(SOURCE);
        await choose("OTHER");
        await goes(fiftyFirst);
        await choose("OTHER");
        await showAll();
        assert.deepEqual([await card(fiftyFirst), await count(".changed")], [false, 0], "a task that moved while another project was selected");
        await comesBack(fiftyFirst);
        await open(SOURCE);
        await goes(fiftyFirst);
        assert.equal(await strip("in_progress"), true);
        await choose("OTHER");
        await choose("OTHER");
        await showAll();
        assert.equal(await card(fiftyFirst), false, "a mark does not outlast the board that it was made on");
        await comesBack(fiftyFirst);

        // A task that is deleted leaves its strip ringed and has no mark of its own; one that the plan takes off the
        // board and puts back, here by a title the filter finds or not, is marked when it is back.
        await open(SOURCE);
        await page.click("#filter");
        await page.type("Mover");
        const held = (await columns())["In progress"]!;
        await change("delete", { id: leaves });
        await change("update_task", { id: fiftyFirst, title: "Renamed, and not found" });
        await read();
        assert.deepEqual([await strip("in_progress"), (await columns())["In progress"], await count(".card.changed")], [true, held - 2, 0], "the strip is ringed for the two that left it, and counts them out");
        await open(SOURCE);
        await page.click("#filter");
        await page.type("Mover");
        await change("update_task", { id: fiftyFirst, title: "Mover to the 51st place" });
        await read();
        assert.deepEqual([await strip("in_progress"), (await columns())["In progress"]], [true, held - 1], "back on the board by a later change, it rings the strip that holds it");
        await page.click(".column[data-key='in_progress']");
        assert.equal(await card(fiftyFirst), true, "and its card, when the column is opened");
        assert.deepEqual(page.errors, []);
      } finally {
        await page.motion("no-preference");
        await many?.stop();
        rmSync(folder, { recursive: true, force: true });
        await load();
      }
    });

    it("keeps a mark to the board it was made on: narrowed to another project, group or filter the board shows no ring of the board before, a strip's no more than a card's, nor when it is widened again in time or let in again after a refused key", async () => {
      await page.size(1280, 900);
      const id = ids.card!;
      let turn = 0;
      /** Has the page read the plan, and waits until it has drawn the board for it. */
      const read = async () => {
        await page.run("window.drawn = 0; window.drawnWatch?.disconnect(); window.drawnWatch = new MutationObserver(() => window.drawn++); window.drawnWatch.observe(document.getElementById('board'), { childList: true })");
        await page.click("#refresh");
        await page.until("return window.drawn > 0", "the board to be drawn again");
      };
      /** Everything that is ringed: a strip by its column, a card by its task. */
      const rings = () => page.run<string[]>("return [...document.querySelectorAll('.changed')].map((el) => el.dataset.key ?? el.dataset.id)");
      /** Opens the whole board with Done collapsed or open, and has a task that is done show another title: its strip, or its card, is ringed. */
      const ring = async (keys: string[]) => {
        await loadCollapsed(keys);
        await run("update_task", { id, version: (await run("get", { id })).version, title: `Card form, as it is called at turn ${++turn}` });
        await read();
        assert.deepEqual(await rings(), keys.length ? ["done"] : [id], "ringed on the board it changed on");
      };
      const done = () => page.run<[boolean, number] | null>("const c = document.querySelector('.column[data-key=\"done\"]'); return c ? [c.classList.contains('collapsed'), Number(c.querySelector('.count').textContent)] : null");
      const choose = (project: string) => page.run(`[...document.querySelectorAll('#projects .project-main')].find((card) => card.querySelector('.project-id').textContent === ${JSON.stringify(project)}).click()`);
      try {
        // A later reading of the plan on the same board leaves the ring where it is.
        await ring(["done"]);
        await run("update_task", { id: ids.launch, version: (await run("get", { id: ids.launch })).version, description: `Another description, at turn ${turn}.` });
        await read();
        assert.deepEqual(await rings(), ["done"], "the same board, read again: the strip is still ringed");

        // Another project, which has nothing that is done: its board has a Done column too, collapsed and empty,
        // and no ring on it. Nor is there one when all projects are shown again, well within the six seconds.
        await choose("LONGNAME");
        assert.deepEqual([await done(), await rings()], [[true, 0], []], "the strip of the same column on the board of another project is not ringed");
        await choose("LONGNAME");
        assert.deepEqual([(await done())?.[0], await rings()], [true, []], "and the ring does not come back with the board it was made on");

        // A filter that finds nothing that is done, and the filter cleared again.
        await ring(["done"]);
        await page.click("#filter");
        await page.type("Prerequisite");
        assert.deepEqual([await done(), await rings()], [[true, 0], []], "under a filter");
        await page.run("document.getElementById('filter').select()");
        await page.key("Backspace");
        assert.deepEqual(await rings(), [], "and with the filter cleared");

        // A group, which holds the very task that changed: its Done column holds it, and is not ringed for it.
        await ring(["done"]);
        await page.run(`document.querySelector('.card[data-id="${ids.checkout}"]').click()`);
        await page.until("return Boolean(document.querySelector('#detail .open-group'))", "the group's panel");
        await page.click("#detail .open-group");
        assert.deepEqual([(await done())?.[0], (await done())![1] > 0, await rings()], [true, true, []], "inside a group");
        await page.click("#scope .tag-button");
        assert.deepEqual(await rings(), [], "and out of it again");

        // The ring of a card is of its board as well: the card is still there under the filter, without it.
        await ring([]);
        await page.click("#filter");
        await page.type("Card form");
        assert.deepEqual([await count(`.card[data-id="${id}"]`), await rings()], [1, []], "a card that the filter leaves on the board");
        await page.run("document.getElementById('filter').select()");
        await page.key("Backspace");
        assert.deepEqual(await rings(), []);

        // The key is refused: the page keeps nothing of the plan, and no ring is there when it is let in again in time.
        await ring(["done"]);
        setValue(config, "auth.keyless_user", "");
        try {
          await page.click("#refresh");
          await page.until("return !document.getElementById('notice').hidden && document.getElementById('main').hidden", "the page to be locked out");
          await page.click("#notice input");
          await page.type(adminKey);
          await page.key("Enter");
          await page.until("return document.querySelectorAll('.card').length > 0 && document.getElementById('notice').hidden", "the board, once the key is right");
          assert.deepEqual([(await done())?.[0], await rings()], [true, []], "let in again, the board has no ring from before");
        } finally {
          setValue(config, "auth.keyless_user", "agent1");
          await page.run("localStorage.clear()");
        }
        assert.deepEqual(page.errors, []);
      } finally {
        await run("update_task", { id, version: (await run("get", { id })).version, title: "Card form" }).catch(() => {});
        await run("update_task", { id: ids.launch, version: (await run("get", { id: ids.launch })).version, description: "Description of Launch the checkout." }).catch(() => {});
        await forget();
        await load();
      }
    });
  });

  browserSuite("the keyboard, when the control that had it goes", () => {
    /** What has the keyboard, and whether it can be seen: never the page itself, never something hidden. */
    const keyboard = () =>
      page.run<string>(
        "const a = document.activeElement; const seen = a !== document.body && a.isConnected && !a.disabled && !a.closest('[hidden], [inert]') && a.getClientRects().length > 0 && getComputedStyle(a).visibility !== 'hidden' && (() => { const r = a.getBoundingClientRect(); const at = document.elementFromPoint(Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1)); return r.bottom < 0 || r.top > innerHeight || Boolean(at && (a.contains(at) || at.contains(a))); })(); return (a === document.body ? 'nothing' : a.matches('.column-fold') ? 'strip ' + a.closest('.column').dataset.key : a.dataset.id ? 'card ' + a.dataset.id : a.closest('#panel') ? 'panel' : a.id || a.className || a.tagName) + (seen ? '' : ', which cannot be seen')",
      );
    const shown = (title: string) => page.until(`return !document.getElementById('panel').hidden && document.querySelector('.detail-title')?.textContent === ${JSON.stringify(title)}`, `the panel of ${title}`);
    const live = () => page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
    const full = () => page.run<boolean>("return document.body.classList.contains('graph-full')");
    /**
     * Waits until the browser itself has left full screen. It says so a moment after the page has, and the page
     * takes that word for a wish to leave: full screen entered again before it would be left at once.
     */
    const left = async () => {
      await page.until("return !document.body.classList.contains('graph-full') && !document.fullscreenElement", "the page to come back from full screen");
      await page.wait(150);
    };
    /**
     * Waits for the graph to have the size of its box, and clicks the box of a task in it with the keyboard
     * nowhere, as it is for someone who has only used the mouse: the panel then has nothing it was opened from.
     */
    const press = async (id: string) => {
      await graphReady();
      await page.until("return Math.abs(window.vigileGraph.height() - document.getElementById('graph-box').clientHeight) < 2", "the drawing to take the size of its box");
      await page.run("document.getElementById('zoom-fit').click(); document.activeElement.blur();");
      const at = await nodeAt(`task:${id}`);
      await page.clickAt(at.x, at.y);
    };
    const remove = async (id: string) => run("delete", { id, version: (await run("get", { id })).version });
    const create = async (title: string) => ((await run("create_task", { title, description: "d", project: "WEB" })) as { id: string }).id;

    it("leaves it on a control that can be seen when the panel closes over the graph, at full screen as in the window: opened from a box, the address or a link, with the task deleted meanwhile, with full screen switched under it", async () => {
      await page.size(1280, 800);
      const made = [await create("Deleted while its panel is open over the graph"), await create("Deleted while its panel is open at full screen")];
      try {
        await load();
        await page.run("localStorage.setItem('vigile.auto-refresh', 'on')");
        const seen: Record<string, string> = {};
        // In the window the header is there, and the link of the view takes the keyboard.
        await load("/#graph");
        await press(ids.launch!);
        await shown("Launch the checkout");
        await page.key("Escape");
        seen["a box, in the window"] = await keyboard();
        await press(ids.launch!);
        await shown("Launch the checkout");
        await page.click("#detail .link", await page.run<number>("return [...document.querySelectorAll('#detail .link')].findIndex((l) => l.querySelector('.name').textContent === 'Checkout')"));
        await shown("Checkout");
        await page.key("Escape");
        seen["a link, in the window"] = await keyboard();
        await load(`/#graph/${ids.launch}`);
        await shown("Launch the checkout");
        await page.key("Escape");
        seen["the address"] = await keyboard();
        await live();
        await press(made[0]!);
        await shown("Deleted while its panel is open over the graph");
        await remove(made[0]!);
        await page.until("return [...document.querySelectorAll('#detail .pill')].some((pill) => pill.textContent === 'deleted')", "the panel to say that the task is deleted", 3000);
        await page.key("Escape");
        seen["a box whose task was deleted, in the window"] = await keyboard();

        // Full screen is entered with the keyboard on its button, which keeps it.
        await graphReady();
        await page.run("document.getElementById('graph-full').focus({ preventScroll: true })");
        await page.key("Enter");
        await page.until("return document.body.classList.contains('graph-full')", "full screen");
        seen["the button, once full screen is entered with it"] = await keyboard();
        // At full screen the header is gone and its link with it: the button that leaves full screen is there.
        await press(ids.launch!);
        await shown("Launch the checkout");
        await page.key("Escape");
        assert.deepEqual([await panelOpen(), await full()], [false, true], "Escape closed the panel and left the full screen as it is");
        seen["a box, at full screen"] = await keyboard();
        await press(ids.launch!);
        await shown("Launch the checkout");
        await page.click("#detail .link", await page.run<number>("return [...document.querySelectorAll('#detail .link')].findIndex((l) => l.querySelector('.name').textContent === 'Checkout')"));
        await shown("Checkout");
        await page.key("Escape");
        seen["a link, at full screen"] = await keyboard();
        await press(made[1]!);
        await shown("Deleted while its panel is open at full screen");
        await remove(made[1]!);
        await page.until("return [...document.querySelectorAll('#detail .pill')].some((pill) => pill.textContent === 'deleted')", "the panel to say that the task is deleted", 3000);
        await page.key("Escape");
        seen["a box whose task was deleted, at full screen"] = await keyboard();
        // Full screen is left while the panel is open, and entered while it is open: what counts is what is there when it closes.
        await press(ids.launch!);
        await shown("Launch the checkout");
        await page.run("document.getElementById('graph-full').click()");
        await left();
        await page.key("Escape");
        seen["full screen left under the open panel"] = await keyboard();
        await press(ids.launch!);
        await shown("Launch the checkout");
        await page.run("document.getElementById('graph-full').click()");
        assert.equal(await full(), true);
        await page.key("Escape");
        seen["full screen entered under the open panel"] = await keyboard();
        // Escape leaves full screen, and the button, which says something else now, still has the keyboard.
        await page.key("Escape");
        await left();
        seen["the button, once full screen is left with Escape"] = await keyboard();
        // The keyboard is in the header when full screen takes the header away.
        await page.run("document.getElementById('settings').focus({ preventScroll: true }); document.getElementById('graph-full').click();");
        assert.equal(await full(), true);
        seen["a control of the header that full screen hides"] = await keyboard();
        await page.run("document.getElementById('graph-full').click()");

        assert.deepEqual(seen, {
          "a box, in the window": "view-graph",
          "a link, in the window": "view-graph",
          "the address": "view-graph",
          "a box whose task was deleted, in the window": "view-graph",
          "the button, once full screen is entered with it": "graph-full",
          "a box, at full screen": "graph-full",
          "a link, at full screen": "graph-full",
          "a box whose task was deleted, at full screen": "graph-full",
          "full screen left under the open panel": "view-graph",
          "full screen entered under the open panel": "graph-full",
          "the button, once full screen is left with Escape": "graph-full",
          "a control of the header that full screen hides": "graph-full",
        });
        assert.deepEqual(page.errors, []);
      } finally {
        for (const id of made) await remove(id).catch(() => {});
        await page.run("localStorage.removeItem('vigile.auto-refresh')");
        await page.size(1280, 900);
        await load();
      }
    });

    it("leaves it on a control that can be seen on the board: when a strip goes with its last task, a card with its task, a group is entered or left, a notice is dismissed, and the key is taken", async () => {
      await page.size(1280, 900);
      const made: string[] = [];
      const seen: Record<string, string> = {};
      try {
        const gone = await create("Deleted under the keyboard");
        made.push(gone);
        await load();
        await page.run("localStorage.setItem('vigile.auto-refresh', 'on'); localStorage.setItem('vigile.collapsed', '[\"in_review\"]')");
        await load();
        await live();
        // The strip that has the keyboard holds one task, which leaves: the strip is gone with it.
        await page.run("document.querySelector('.column[data-key=\"in_review\"] .column-fold').focus({ preventScroll: true })");
        await move(ids.review!, "in_progress");
        await page.until("return document.querySelector('.column[data-key=\"in_review\"]') === null", "the strip to go with its last task", 2000);
        seen["a strip that went with its last task"] = await keyboard();
        // The card that has the keyboard is of a task that is deleted.
        await page.run(`document.querySelector('.card[data-id="${gone}"]').focus({ preventScroll: true })`);
        await remove(gone);
        await page.until(`return document.querySelector('.card[data-id="${gone}"]') === null`, "the card to go with its task", 2000);
        seen["a card whose task was deleted"] = await keyboard();
        await page.until("return document.querySelectorAll('.card-ghost').length === 0", "the cards to settle", 12_000);

        // A group is entered from its panel, with the keyboard: the card the panel was opened from is not among what the group holds.
        await page.run(`document.querySelector('.card[data-id="${ids.checkout}"]').focus({ preventScroll: true })`);
        await page.key("Enter");
        await shown("Checkout");
        await page.run("document.querySelector('#detail .open-group').focus({ preventScroll: true })");
        await page.key("Enter");
        assert.deepEqual([await panelOpen(), await count(`.card[data-id="${ids.checkout}"]`)], [false, 0]);
        seen["the card a group was entered from"] = await keyboard();
        // And left again with the button that says so, which goes once it is used.
        await page.run("document.querySelector('#scope .tag-button').focus({ preventScroll: true })");
        await page.key("Enter");
        assert.equal(await count("#scope .tag-button"), 0);
        seen["the button that leaves a group"] = await keyboard();

        // Notices: dismissed with the keyboard, the next one has it; the last one gone, or all closed at once, the page has it.
        const watched = [await create("Watched, first"), await create("Watched, second"), await create("Watched, third"), await create("Watched, fourth")];
        made.push(...watched);
        const notices = async (ids: string[]) => {
          await page.run(`sessionStorage.setItem('vigile.watching', ${JSON.stringify(JSON.stringify(ids))})`);
          await load();
          for (const id of ids) await move(id, "in_progress", "done");
          await page.until(`return document.querySelectorAll('.toast.done').length === ${ids.length}`, "the notices that the watched tasks are done", 5000);
        };
        await notices(watched.slice(0, 2));
        await page.run("document.querySelector('.toast .toast-close').focus({ preventScroll: true })");
        await page.key("Enter");
        assert.equal(await count(".toast"), 1);
        seen["a notice that was dismissed, with another left"] = await keyboard();
        await page.key("Enter");
        assert.equal(await count(".toast"), 0);
        seen["the last notice, dismissed"] = await keyboard();
        await notices(watched.slice(2));
        await page.run("document.getElementById('toasts-clear').focus({ preventScroll: true })");
        await page.key("Enter");
        assert.equal(await count(".toast"), 0);
        seen["the button that closes all notices"] = await keyboard();

        // The form that asks for a key goes once the key is taken.
        await page.run("localStorage.removeItem('vigile.auto-refresh'); sessionStorage.removeItem('vigile.watching')");
        setValue(config, "auth.keyless_user", "");
        try {
          await page.open("about:blank");
          await page.open(`${base}/`);
          await page.until("return !document.getElementById('notice').hidden", "the key form");
          await page.click("#notice input");
          await page.type(adminKey);
          await page.key("Enter");
          await page.until("return document.querySelectorAll('.card').length > 0 && document.getElementById('notice').hidden", "the board, once the key is right");
          seen["the form that asked for a key"] = await keyboard();
        } finally {
          setValue(config, "auth.keyless_user", "agent1");
          await page.run("localStorage.clear()");
        }

        assert.deepEqual(seen, {
          "a strip that went with its last task": "view-board",
          "a card whose task was deleted": "level-out",
          "the card a group was entered from": "tag-button leave",
          "the button that leaves a group": `card ${ids.checkout}`,
          "a notice that was dismissed, with another left": "toast-close",
          "the last notice, dismissed": "view-board",
          "the button that closes all notices": "view-board",
          "the form that asked for a key": "view-board",
        });
        assert.deepEqual(page.errors, []);
      } finally {
        await move(ids.review!, "in_review").catch(() => {});
        for (const id of made) await remove(id).catch(() => {});
        await page.run("for (const name of ['vigile.collapsed', 'vigile.auto-refresh']) localStorage.removeItem(name); sessionStorage.removeItem('vigile.watching')");
        await load();
      }
    });

    it("leaves it on a control of the graph when the line that says a large graph is being worked out has said all it had to say", async () => {
      await page.size(1280, 900);
      const folder = mkdtempSync(join(tmpdir(), "vigile-browser-test-status-"));
      let many: Service | null = null;
      try {
        initConfig(join(folder, "config.toml"), { name: "status", port: await freePort() });
        many = await startService({ loaded: loadConfig(join(folder, "config.toml"), {}), log: () => {}, warn: () => {} });
        await many.engine.execute("create_project", "agent1", { title: "A large graph", prefix: "LARGE" });
        for (let i = 0; i < 320; i++) await many.engine.execute("create_task", "agent1", { title: `Task ${i}`, description: "d", project: "LARGE" });
        await page.open("about:blank");
        await page.open(`${many.urls.base}/#graph`);
        await page.until("return !document.getElementById('graph-draw').hidden", "the button that draws the graph", 20_000);
        // The button is pressed with the keyboard. It goes with the question, and the line that took its place has
        // the keyboard while the graph is worked out.
        await page.run("document.getElementById('graph-draw').focus({ preventScroll: true })");
        await page.key("Enter");
        await page.until("return Boolean(window.vigileGraph && window.vigileGraph.scratch('settled')) && document.getElementById('graph-status').hidden", "the graph to be drawn and the line to go", 60_000);
        assert.equal(await keyboard(), "zoom-fit", "the line went, and a control of the graph has the keyboard");
        assert.deepEqual(page.errors, []);
      } finally {
        await many?.stop();
        rmSync(folder, { recursive: true, force: true });
        await load();
      }
    });
  });

  browserSuite("refreshing", () => {
    const loads = () => page.requests.filter((url) => url.endsWith("/api/list-tasks")).length;
    const listeners = async () => ((await (await fetch(`${base}/api/admin/status`, { headers: { authorization: `Bearer ${adminKey}` } })).json()) as { listeners: number }).listeners;
    /** Counts the copies of cards that float across the page while a card travels or leaves. */
    const watchGhosts = () => page.run("window.ghosts = 0; window.ghostWatch?.disconnect(); window.ghostWatch = new MutationObserver((changes) => { for (const c of changes) for (const n of c.addedNodes) if (n.classList?.contains('card-ghost')) window.ghosts++; }); window.ghostWatch.observe(document.body, { childList: true });");
    const ghosts = () => page.run<number>("return window.ghosts");
    const settled = () => page.until("return document.querySelectorAll('.card-ghost').length === 0 && [...document.querySelectorAll('.card')].every((c) => getComputedStyle(c).visibility === 'visible')", "the movement to finish", 12_000);

    it("says how long ago in the unit that fits, once the seconds have run into minutes and hours", async () => {
      await page.size(1280, 900);
      await load();
      try {
        await setting("auto");
        await closeSettings();
        await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
        // The clock of the page is put forward; the page is as it would be after that long without a change.
        const after = async (ms: number) => {
          await page.run(`const real = window.realNow ?? (window.realNow = Date.now.bind(Date)); Date.now = () => real() + ${ms};`);
          await page.wait(1200);
          return text("#sync");
        };
        assert.match(await after(0), /^Live, updated \d secs? ago$/);
        // Half a minute on: thirty-something seconds, with room for however long the test itself has taken.
        assert.match(await after(30_000), /^Live, updated 3\d secs ago$/);
        assert.equal(await after(61_000), "Live, updated 1 min ago");
        assert.equal(await after(5 * 60_000 + 2000), "Live, updated 5 mins ago");
        assert.equal(await after(3600_000 + 5000), "Live, updated 1 hr ago");
        assert.equal(await after(3 * 3600_000 + 5000), "Live, updated 3 hrs ago");
      } finally {
        await page.run("if (window.realNow) Date.now = window.realNow; localStorage.removeItem('vigile.auto-refresh')");
        await load();
      }
    });

    it("does not reload by itself while the switch is off", async () => {
      await page.size(1280, 900);
      await load();
      await page.run("localStorage.removeItem('vigile.auto-refresh')");
      // Counted from before the page is opened with the switch off: earlier tests have listened, with it on.
      const listened = () => page.requests.filter((url) => url.endsWith("/api/events")).length;
      const before = listened();
      await load();
      assert.equal(await page.run<boolean>("return document.getElementById('auto').checked"), false);
      const quiet = loads();
      // The header's status is read out whenever it is written, so it is not written again while it says the same.
      await page.run("window.statusWrites = 0; window.statusWatch = new MutationObserver((changes) => (window.statusWrites += changes.length)); window.statusWatch.observe(document.getElementById('sync'), { childList: true, characterData: true, subtree: true });");
      await page.wait(3600);
      assert.equal(await page.run<number>("window.statusWatch.disconnect(); return window.statusWrites"), 0, "the status was not written again in 3.6 seconds");
      assert.equal(loads(), quiet, "no load while the switch is off");
      assert.equal(listened(), before, "and no listening either");
      assert.equal(await page.run<boolean>("return document.getElementById('refresh').getBoundingClientRect().width > 0"), true, "the refresh button is there for it");
      await page.click("#refresh");
      await page.wait(300);
      assert.equal(loads(), quiet + 1, "the refresh button loads once");
    });

    it("with the switch on, listens for changes, shows one within a second, and moves the card to its new column", async () => {
      await page.size(1280, 900);
      await load();
      await setting("auto");
      await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
      assert.equal(await page.run<boolean>("return document.getElementById('refresh').getBoundingClientRect().width > 0"), false, "a page that keeps itself up to date shows no refresh button");
      await layout("in the header with auto-refresh on");
      assert.equal(await listeners(), 1, "the page is listening to the service's stream of changes");
      await page.wait(400);
      const quiet = loads();
      // The header says how long ago the page was updated, and counts by itself.
      const age = async () => Number(/^Live, updated (\d+) secs? ago$/.exec(await text("#sync"))?.[1]);
      const first = await age();
      assert.ok(first >= 0 && first <= 3, `"${await text("#sync")}"`);
      await page.wait(3600);
      assert.equal(loads(), quiet, "while it listens, it does not ask again and again");
      const later = await age();
      assert.ok(later >= first + 3 && later <= first + 5, `the count went from ${first} to ${later} in 3.6 seconds, with nothing loaded`);
      // The count is not read out every second: it is kept out of what a screen reader hears of the status.
      assert.deepEqual(await page.run("const sync = document.getElementById('sync'); return [sync.firstChild.nodeValue, sync.querySelector('.age').getAttribute('aria-hidden'), /Last update at \\d/.test(sync.title)]"), ["Live, updated ", "true", true]);

      // A card goes from one column to another.
      await watchGhosts();
      const began = Date.now();
      await move(ids.address!, "in_review");
      await page.until(`return document.querySelector('.column[data-key="in_review"] .card[data-id="${ids.address}"]') !== null`, "the change to appear", 1500);
      const took = Date.now() - began;
      assert.ok(took < 1000, `the change appeared after ${took} ms, without a reload`);
      const moving = await page.run<{ ghosts: number; hidden: boolean; changed: boolean; animations: number }>(
        `const card = document.querySelector('.card[data-id="${ids.address}"]'); const ghost = document.querySelector('.card-ghost'); return { ghosts: window.ghosts, hidden: getComputedStyle(card).visibility === 'hidden', changed: card.classList.contains('changed'), animations: ghost ? ghost.getAnimations().length : 0 }`,
      );
      assert.deepEqual(moving, { ghosts: 1, hidden: true, changed: true, animations: 1 }, "a copy of the card travels to the new column while the card itself waits there, ringed");
      // The copy is for the eye only: the keyboard cannot reach it, and screen readers do not hear of it.
      assert.deepEqual(
        await page.run("const ghost = document.querySelector('.card-ghost'); const was = document.activeElement; ghost.focus(); return [ghost.inert, ghost.tabIndex, ghost.getAttribute('aria-hidden'), document.activeElement === ghost, document.activeElement === was]"),
        [true, -1, "true", false, true],
        "the travelling copy cannot be focused and is hidden from assistive technology",
      );
      // The journey can be followed. The card stays lifted where it was for a moment, so the eye can find it;
      // then it travels at a steady pace, half way there at half of the travelling time.
      const journey = await page.run<{ total: number; start: number; waiting: number; half: number; end: number }>(`
        const ghost = document.querySelector('.card-ghost'); const flight = ghost.getAnimations()[0];
        const total = flight.effect.getComputedTiming().duration; const was = flight.currentTime;
        const at = (time) => { flight.currentTime = time; return Math.round(ghost.getBoundingClientRect().left + ghost.getBoundingClientRect().width / 2); };
        const seen = { total, start: at(0), waiting: at(130), half: at(150 + (total - 450) / 2), end: at(total) };
        flight.currentTime = was;
        return seen;
      `);
      assert.ok(journey.total >= 800 && journey.total <= 1700, `the journey takes ${journey.total} ms`);
      assert.ok(Math.abs(journey.waiting - journey.start) <= 4, "for the first moment the card lifts off where it was");
      const covered = (journey.half - journey.start) / (journey.end - journey.start);
      assert.ok(covered > 0.35 && covered < 0.65, `half way through its travelling time, the card is ${Math.round(covered * 100)}% of the way: it does not jump`);
      if (shots) {
        await page.wait(400);
        await page.shot(join(shots, "while-a-card-travels.png"));
      }
      await layout("after a card travelled to another column");
      await settled();
      assert.equal(loads(), quiet + 1, "one change, one load");
      assert.deepEqual([(await columns())["In progress"], (await columns())["In review"]], [1, 2]);

      // A new card appears, and a deleted one goes.
      await watchGhosts();
      // Important enough to be at the top of its column, where it can be seen.
      const added = (await run("create_task", { title: "Arrives while you watch", description: "d", project: "WEB", priority: 99 })) as { id: string; version: number };
      await page.until(`return document.querySelector('.card[data-id="${added.id}"]') !== null`, "the new card", 1500);
      assert.deepEqual(await page.run(`const card = document.querySelector('.card[data-id="${added.id}"]'); return [card.classList.contains('changed'), card.getAnimations().length > 0, window.ghosts]`), [true, true, 0], "a new card fades in, ringed");
      await run("delete", { id: added.id, version: added.version });
      await page.until(`return document.querySelector('.card[data-id="${added.id}"]') === null`, "the card to go", 1500);
      assert.equal(await ghosts(), 1, "a deleted card fades out where it was");
      await settled();

      // With no explicit animation choice, reduced motion leaves the changed card in place and ringed.
      await page.motion("reduce");
      await watchGhosts();
      await move(ids.address!, "in_progress");
      await page.until(`return document.querySelector('.column[data-key="in_progress"] .card[data-id="${ids.address}"]') !== null`, "the change to appear", 1500);
      assert.deepEqual(await page.run(`const card = document.querySelector('.card[data-id="${ids.address}"]'); return [window.ghosts, card.classList.contains('changed'), getComputedStyle(card).visibility]`), [0, true, "visible"], "the ring alone says what changed under reduced motion");
      await page.motion("no-preference");

      // The choice survives a reload; switching off stops the listening.
      await load();
      assert.equal(await page.run<boolean>("return document.getElementById('auto').checked"), true);
      await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to be live again after a reload");
      assert.equal(await page.run<boolean>("return document.getElementById('refresh').getBoundingClientRect().width > 0"), false, "and still without the refresh button");
      await setting("auto");
      await page.until("return document.getElementById('sync').textContent.startsWith('Updated')", "the page to stop saying it is live");
      assert.equal(await page.run<boolean>("return document.getElementById('refresh').getBoundingClientRect().width > 0"), true, "switched off, the refresh button is back");
      await page.until("return true", "a tick");
      const end = Date.now() + 2000;
      while ((await listeners()) !== 0 && Date.now() < end) await page.wait(50);
      assert.equal(await listeners(), 0, "nothing listens once the switch is off");
      await page.run("localStorage.removeItem('vigile.auto-refresh')");
      assert.deepEqual(page.errors, []);
    });

    it("keeps a card marked for a few seconds after it lands, and is not cut short by the next change", async () => {
      await page.size(1280, 900);
      await load();
      await setting("auto");
      await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
      await watchGhosts();
      const card = `document.querySelector('.card[data-id="${ids.address}"]')`;
      const began = Date.now();
      await move(ids.address!, "in_review");
      await page.until("return document.querySelectorAll('.card-ghost').length === 1", "the card to set off", 1500);
      // A second change arrives while the card is on its way: the board is drawn again under it.
      await page.wait(100);
      const other = (await run("create_task", { title: "Arrives during the journey", description: "d", project: "WEB" })) as { id: string; version: number };
      await page.until(`return document.querySelector('.card[data-id="${other.id}"]') !== null`, "the board to be drawn again", 1500);
      assert.deepEqual(
        await page.run(`return [document.querySelectorAll('.card-ghost').length, getComputedStyle(${card}).visibility, ${card}.closest('.column').dataset.key, window.ghosts]`),
        [1, "hidden", "in_review", 1],
        "the same copy is still on its way, and the card still waits unseen where it will land",
      );
      await settled();
      const landed = Date.now() - began;
      assert.ok(landed >= 750, `the card was on its way for ${landed} ms, not cut short`);
      assert.deepEqual(await page.run(`return [getComputedStyle(${card}).visibility, ${card}.classList.contains('changed')]`), ["visible", true], "landed, it is in sight and ringed");
      // The ring is still there four seconds after the change, and gone after seven.
      await page.wait(Math.max(0, 4000 - (Date.now() - began)));
      assert.equal(await page.run<boolean>(`return ${card}.classList.contains('changed')`), true, "still marked after 4 seconds");
      await page.wait(Math.max(0, 7000 - (Date.now() - began)));
      assert.equal(await page.run<boolean>(`return ${card}.classList.contains('changed') || document.querySelectorAll('.card.changed').length > 0`), false, "no longer marked after 7 seconds");
      await run("delete", { id: other.id, version: other.version });

      // The pace is the same for every journey, so a longer way takes longer: here, back across one column, then
      // on to a column several columns away.
      const timeOf = async (status: string) => {
        await move(ids.address!, status);
        // Finishing a task can free another, which then travels too: this looks at the copy of this task's card.
        const mine = `[...document.querySelectorAll('.card-ghost')].find((g) => g.querySelector('.id').textContent === ${JSON.stringify(ids.address)})`;
        await page.until(`return Boolean(${mine})`, `the card to set off for ${status}`, 1500);
        const seen = await page.run<{ total: number; distance: number }>(`const ghost = ${mine}; const flight = ghost.getAnimations()[0]; const total = flight.effect.getComputedTiming().duration; const was = flight.currentTime; flight.currentTime = 0; const from = ghost.getBoundingClientRect(); flight.currentTime = total; const to = ghost.getBoundingClientRect(); flight.currentTime = was; return { total, distance: Math.round(Math.hypot(to.left - from.left, to.top - from.top)) }`);
        await settled();
        return seen;
      };
      const near = await timeOf("in_progress");
      const far = await timeOf("done");
      assert.ok(far.distance > near.distance * 3, `the second journey is much longer: ${near.distance}px and ${far.distance}px`);
      assert.ok(far.total - near.total > 100, `and takes longer: ${near.total} ms and ${far.total} ms`);
      const pace = far.distance / (far.total - 450);
      assert.ok(pace > 1.45 && pace < 1.75, `the card travels at about 1,600 pixels a second: ${Math.round(pace * 1000)}`);
      await move(ids.address!, "open", "in_progress");
      await page.until(`return document.querySelector('.column[data-key="in_progress"] .card[data-id="${ids.address}"]') !== null`, "the plan put back");
      await settled();
      await setting("auto");
      await page.run("localStorage.removeItem('vigile.auto-refresh')");
      assert.deepEqual(page.errors, []);
    });

    it("moves cards unless animations are switched off in the settings, and remembers the choice", async () => {
      await page.size(1280, 900);
      await load();
      await page.run("localStorage.removeItem('vigile.motion')");
      await load();
      const card = `document.querySelector('.card[data-id="${ids.address}"]')`;
      const there = (column: string) => page.until(`return document.querySelector('.column[data-key="${column}"] .card[data-id="${ids.address}"]') !== null`, `the card to be in ${column}`, 1500);
      try {
        await openSettings();
        assert.deepEqual(await page.run("return [document.getElementById('motion').checked, localStorage.getItem('vigile.motion')]"), [true, null], "animations are on unless switched off");
        await page.click("label:has(#auto)");
        await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
        // Off: nothing travels, and the ring alone says what changed.
        await page.click("label:has(#motion)");
        await closeSettings();
        assert.equal(await page.run<string | null>("return localStorage.getItem('vigile.motion')"), "off");
        await watchGhosts();
        await move(ids.address!, "in_review");
        await there("in_review");
        assert.deepEqual(await page.run(`return [window.ghosts, ${card}.classList.contains('changed'), ${card}.getAnimations().filter((a) => !a.animationName).length, getComputedStyle(${card}).visibility]`), [0, true, 0, "visible"], "nothing travels, and the ring says what changed");
        // The choice is remembered in this browser.
        await load();
        assert.equal(await page.run<boolean>("return document.getElementById('motion').checked"), false);
        // On again: the card travels, ringed and lifted in every theme.
        await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to be live again after a reload");
        await setting("motion");
        assert.equal(await page.run<string | null>("return localStorage.getItem('vigile.motion')"), "on");
        await watchGhosts();
        await move(ids.address!, "in_progress");
        await there("in_progress");
        assert.deepEqual(await page.run(`return [window.ghosts, getComputedStyle(${card}).visibility]`), [1, "hidden"], "the card travels again");
        for (const name of ["vigile", "dado", "jeev", "gito"]) {
          const shadow = await page.run<string>(`document.documentElement.dataset.theme = ${JSON.stringify(name)}; return getComputedStyle(document.querySelector('.card-ghost')).boxShadow`);
          assert.match(shadow, /0px 0px 0px 3px.*0px 14px 34px/, `the travelling card is ringed and lifted in ${name}: ${shadow}`);
        }
        await page.run("document.documentElement.dataset.theme = 'vigile'");
        await settled();
        await setting("auto");
      } finally {
        await page.run("document.documentElement.dataset.theme = 'vigile'; localStorage.removeItem('vigile.motion'); localStorage.removeItem('vigile.auto-refresh')");
      }
      assert.deepEqual(page.errors, []);
    });

    it("asks every 3 seconds instead when it cannot listen, and listens again when it can", async () => {
      await load();
      await page.block(["*/api/events"]);
      try {
        const quiet = loads();
        await setting("auto");
        await page.wait(3700);
        assert.ok(loads() >= quiet + 2, "it loads at once and again after 3 seconds");
        assert.match(await text("#sync"), /^Updated/, "and does not claim to be live");
        await move(ids.address!, "in_review");
        await page.until(`return document.querySelector('.column[data-key="in_review"] .card[data-id="${ids.address}"]') !== null`, "the change to appear by asking", 4000);
        await move(ids.address!, "in_progress");
      } finally {
        await page.block([]);
      }
      await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to listen once it can", 20_000);
      await page.until(`return document.querySelector('.column[data-key="in_progress"] .card[data-id="${ids.address}"]') !== null`, "the page to be up to date");
      await setting("auto");
      await page.run("localStorage.removeItem('vigile.auto-refresh')");
    });

    it("with the sound switched on, plays two notes when any task is completed, with or without auto-refresh", async () => {
      await page.size(1280, 900);
      await load();
      await page.run("localStorage.removeItem('vigile.sound'); sessionStorage.removeItem('vigile.watching')");
      await load();
      // Counts the notes played, in place of listening to them.
      const COUNT = "window.notes = 0; const start = OscillatorNode.prototype.start; OscillatorNode.prototype.start = function (...args) { window.notes++; return start.apply(this, args); };";
      const notes = () => page.run<number>("return window.notes");
      const column = () => page.run<string>(`return document.querySelector('.card[data-id="${ids.address}"]').closest('.column').dataset.key`);
      const idle = async (count: number) => {
        const end = Date.now() + 2000;
        while ((await listeners()) !== count && Date.now() < end) await page.wait(50);
        return listeners();
      };
      const putBack = () => move(ids.address!, "open", "in_progress");
      try {
        await page.run(COUNT);
        assert.deepEqual(await page.run("return [document.getElementById('sound').checked, document.getElementById('auto').checked]"), [false, false], "the sound is off unless turned on");
        assert.equal(await idle(0), 0, "and the page does not follow the service for it");

        // Turned on, it is played once, and the page follows the service without auto-refresh.
        await setting("sound");
        assert.equal(await notes(), 2, "turning it on plays the two notes once");
        assert.equal(await page.run<string | null>("return localStorage.getItem('vigile.sound')"), "on");
        assert.equal(await idle(1), 1, "the page now listens for changes");
        await page.wait(300);
        await move(ids.address!, "done");
        await page.until("return window.notes === 4", "the sound for the completed task", 2500);
        assert.equal(await column(), "in_progress", "the board is not drawn again: auto-refresh is off");
        // Other changes are silent.
        await putBack();
        await page.wait(700);
        assert.equal(await notes(), 4, "a task that is reopened and started makes no sound");

        // The choice is remembered. A watched task has its own chime and notice, and the two are not played together.
        await page.run(`sessionStorage.setItem('vigile.watching', ${JSON.stringify(JSON.stringify([ids.address]))})`);
        await load();
        await page.run(COUNT);
        assert.equal(await page.run<boolean>("return document.getElementById('sound').checked"), true, "the choice survives a reload");
        await move(ids.address!, "done");
        await page.until("return document.querySelectorAll('.toast.done').length === 1", "the notice that the watched task is done", 2500);
        await page.wait(400);
        assert.equal(await notes(), 3, "the three notes of the watch, and not the two notes on top of them");
        await putBack();

        // With auto-refresh on, the sound comes with the change on the board.
        await load();
        await page.run(COUNT);
        await setting("auto");
        await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
        await move(ids.address!, "done");
        await page.until("return window.notes === 2", "the sound for the completed task", 2500);
        await page.until(`return document.querySelector('.column[data-key="done"] .card[data-id="${ids.address}"]') !== null`, "the card to be in Done", 2500);
        await putBack();
        await page.until(`return document.querySelector('.column[data-key="in_progress"] .card[data-id="${ids.address}"]') !== null`, "the plan put back", 2500);
        await settled();
        assert.equal(await notes(), 2);
        await setting("auto");

        // Switched off, a completed task is silent again and the page stops following the service.
        await setting("sound");
        assert.equal(await page.run<string | null>("return localStorage.getItem('vigile.sound')"), "off");
        assert.equal(await idle(0), 0, "nothing listens once the sound is off");
        await move(ids.address!, "done");
        await page.wait(700);
        assert.equal(await notes(), 2, "no sound while it is off");
        await putBack();
      } finally {
        await page.run("localStorage.removeItem('vigile.sound'); localStorage.removeItem('vigile.auto-refresh'); sessionStorage.removeItem('vigile.watching')");
      }
      assert.deepEqual(page.errors, []);
    });

    it("plays a sound of its own when a task is created and when one is started, each behind its own switch", async () => {
      await page.size(1280, 900);
      await load();
      await page.run("for (const name of ['vigile.sound', 'vigile.sound-created', 'vigile.sound-started']) localStorage.removeItem(name); sessionStorage.removeItem('vigile.watching')");
      await load();
      await page.run("window.notes = 0; const start = OscillatorNode.prototype.start; OscillatorNode.prototype.start = function (...args) { window.notes++; return start.apply(this, args); };");
      const notes = () => page.run<number>("return window.notes");
      const heard = (count: number, what: string) => page.until(`return window.notes === ${count}`, what, 2500);
      let made: { id: string; version: number } | null = null;
      try {
        assert.deepEqual(await page.run("return ['sound-created', 'sound-started', 'sound'].map((id) => document.getElementById(id).checked)"), [false, false, false], "every sound is off unless turned on");
        // Each switch plays its own sound once when turned on: one note for a new task, two for a started one.
        await setting("sound-created");
        assert.equal(await notes(), 1, "the pop is one note");
        await setting("sound-started");
        assert.equal(await notes(), 3, "the knock is two notes");
        assert.deepEqual(await page.run("return ['vigile.sound-created', 'vigile.sound-started', 'vigile.sound'].map((name) => localStorage.getItem(name))"), ["on", "on", null]);
        await page.wait(400);
        // A task is created by someone else, then started, then completed.
        made = (await run("create_task", { title: "Heard when created", description: "d", project: "WEB" })) as { id: string; version: number };
        await heard(4, "the sound for the new task");
        assert.equal(await count(`.card[data-id="${made.id}"]`), 0, "the board is not drawn again: auto-refresh is off");
        await move(made.id, "in_progress");
        await heard(6, "the sound for the started task");
        await move(made.id, "done");
        await page.wait(700);
        assert.equal(await notes(), 6, "a completed task is silent while its switch is off");
        // The choices are remembered. With all three on, one reading of the tasks makes one sound: the completed task's.
        await load();
        await page.run("window.notes = 0; const start = OscillatorNode.prototype.start; OscillatorNode.prototype.start = function (...args) { window.notes++; return start.apply(this, args); };");
        assert.deepEqual(await page.run("return ['sound-created', 'sound-started', 'sound'].map((id) => document.getElementById(id).checked)"), [true, true, false]);
        await setting("sound");
        assert.equal(await notes(), 2, "the coin is two notes");
        await page.wait(400);
        // Three things happen while the page cannot read the tasks: a task is created, one is started, one is
        // completed. When it reads them again it makes one sound, the completed task's, and not three on top of each other.
        const second = (await run("create_task", { title: "Started while the page is cut off", description: "d", project: "WEB" })) as { id: string; version: number };
        await heard(3, "the sound for the new task");
        await page.block(["*/api/list-tasks"]);
        const third = (await run("create_task", { title: "Created while the page is cut off", description: "d", project: "WEB" })) as { id: string; version: number };
        await move(second.id, "in_progress");
        await move(ids.address!, "done");
        await page.wait(400);
        assert.equal(await notes(), 3, "nothing is heard while the tasks cannot be read");
        await page.block([]);
        await run("update_task", { id: third.id, version: third.version, title: "Created while the page was cut off" });
        await heard(5, "one sound for the three things that happened");
        await page.wait(600);
        assert.equal(await notes(), 5, "two notes, the completed task's, and nothing after them");
        await move(ids.address!, "open", "in_progress");
        for (const task of [second, third]) await run("delete", { id: task.id, version: (await run("get", { id: task.id })).version });
        await page.wait(500);
        // Switched off, they are silent again.
        await setting("sound-created");
        await setting("sound-started");
        await setting("sound");
        const quiet = await notes();
        const last = (await run("create_task", { title: "Not heard", description: "d", project: "WEB" })) as { id: string; version: number };
        await page.wait(700);
        assert.equal(await notes(), quiet, "no sound while the switches are off");
        await run("delete", { id: last.id, version: last.version });
      } finally {
        await page.block([]);
        if (made) await run("delete", { id: made.id, version: (await run("get", { id: made.id })).version });
        await page.run("for (const name of ['vigile.sound', 'vigile.sound-created', 'vigile.sound-started']) localStorage.removeItem(name)");
      }
      assert.deepEqual(page.errors.filter((e) => !/Failed to load resource|net::ERR/.test(e)), []);
    });

    it("never draws the answer to an earlier question over a later one", async () => {
      await page.size(1280, 900);
      await load();
      const column = () => page.run<string>(`return document.querySelector('.card[data-id="${ids.address}"]').closest('.column').dataset.key`);
      try {
        assert.equal(await page.run<boolean>("return document.getElementById('auto').checked"), false);
        // The next answer with the tasks is held back for more than a second after the service gave it.
        await page.run("window.realFetch = window.fetch; let held = 1; window.fetch = async (url, options) => { const response = await window.realFetch(url, options); if (String(url).includes('/api/list-tasks') && held-- > 0) await new Promise((done) => setTimeout(done, 1200)); return response; };");
        await page.click("#refresh");
        await page.wait(150);
        // A task changes after that answer was given, and the plan is asked for again before the answer arrives.
        await move(ids.address!, "in_review");
        await setting("auto");
        await page.wait(1800);
        assert.equal(await column(), "in_review", "the later answer is the one on screen");
      } finally {
        await page.run("if (window.realFetch) window.fetch = window.realFetch;");
        if (await page.run<boolean>("return document.getElementById('auto').checked")) await setting("auto");
        await move(ids.address!, "in_progress");
        await page.run("localStorage.removeItem('vigile.auto-refresh')");
      }
    });

    it("rings a card that changed state without leaving its column, as a bug does in the column for bugs", async () => {
      await page.size(1280, 900);
      await load();
      const card = `document.querySelector('.column[data-tone="bug"] .card[data-id="${ids.bugBusy}"]')`;
      const lane = () => page.run<string>(`const all = [...document.querySelector('.column[data-tone="bug"] .cards').children]; const at = all.indexOf(${card}); return all.slice(0, at).reverse().find((n) => n.matches('.lane')).childNodes[1].textContent`);
      try {
        await setting("bugs-apart");
        await setting("auto");
        await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
        assert.equal(await lane(), "In progress");
        // With animations on: the bug goes to review and stays in its column. It is ringed, and nothing travels across the board.
        await watchGhosts();
        await move(ids.bugBusy!, "in_review");
        await page.until(`return Boolean(${card}) && ${card}.dataset.status === 'in_review'`, "the change to appear", 2000);
        assert.deepEqual([await lane(), await page.run<boolean>(`return ${card}.classList.contains('changed')`), await ghosts()], ["In review", true, 0]);
        await page.until(`return !${card}.classList.contains('changed')`, "the ring to fade", 9000);
        // With animations off the ring is all there is to say that it changed.
        await setting("motion");
        await move(ids.bugBusy!, "in_progress");
        await page.until(`return Boolean(${card}) && ${card}.dataset.status === 'in_progress'`, "the change to appear", 2000);
        assert.deepEqual([await lane(), await page.run<boolean>(`return ${card}.classList.contains('changed')`), await ghosts()], ["In progress", true, 0]);
      } finally {
        await move(ids.bugBusy!, "in_progress").catch(() => {});
        await page.run("for (const name of ['vigile.bugs-apart', 'vigile.auto-refresh', 'vigile.motion']) localStorage.removeItem(name)");
      }
    });

    it("looks again when the stream of changes connects, for what changed since the page last read", async () => {
      await page.size(1280, 900);
      const watched = (await run("create_task", { title: "Done before the stream connects", description: "d", project: "WEB" })) as { id: string; version: number };
      await load();
      await page.run(`sessionStorage.setItem('vigile.watching', ${JSON.stringify(JSON.stringify([watched.id]))})`);
      // The stream of changes takes a second and a half to connect: the page has read the plan long before.
      const slow = (await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: "const real = window.fetch; window.fetch = async (url, options) => { if (String(url).includes('/api/events')) await new Promise((done) => setTimeout(done, 1500)); return real(url, options); };",
      })) as { identifier: string };
      try {
        await load();
        assert.equal(await text("#watching"), "watching 1");
        // The task is finished after the page read the plan and before the stream is connected.
        await move(watched.id, "in_progress", "done");
        // Before the fallback of asking every 3 seconds would have noticed: the stream's first word prompts a look.
        await page.until("return document.querySelectorAll('.toast.done').length === 1", "the notice, prompted by the stream connecting", 2300);
      } finally {
        await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: slow.identifier });
        await run("delete", { id: watched.id, version: (await run("get", { id: watched.id })).version });
        await page.run("sessionStorage.removeItem('vigile.watching')");
        await load();
      }
    });

    it("tries again by itself when a look at a watched task fails while the stream of changes is fine", async () => {
      await page.size(1280, 900);
      const watched = (await run("create_task", { title: "Read fails at first", description: "d", project: "WEB" })) as { id: string; version: number };
      await load();
      await page.run(`sessionStorage.setItem('vigile.watching', ${JSON.stringify(JSON.stringify([watched.id]))})`);
      await load();
      try {
        const end = Date.now() + 3000;
        while ((await listeners()) !== 1 && Date.now() < end) await page.wait(50);
        assert.equal(await listeners(), 1, "the page listens, so it no longer asks every 3 seconds");
        await page.wait(300);
        // Reading a task fails, while the stream goes on telling of changes.
        await page.block(["*/api/get"]);
        await move(watched.id, "in_progress", "done");
        await page.wait(800);
        assert.equal(await count(".toast"), 0, "the task cannot be read, so nothing is announced yet");
        await page.block([]);
        // No further change is made: the page must come back to it by itself.
        await page.until("return document.querySelectorAll('.toast.done').length === 1", "the notice, once the task can be read again", 5000);
      } finally {
        await page.block([]);
        await run("delete", { id: watched.id, version: (await run("get", { id: watched.id })).version });
        await page.run("sessionStorage.removeItem('vigile.watching')");
        await load();
      }
    });

    it("shares one stream of changes among the tabs of a browser, and hands it on when the tab that holds it goes", async () => {
      await page.size(1280, 900);
      await load();
      // Other tabs of the same browser, here as frames: each is the whole page, with its own board.
      const open = (name: string) => page.run(`const frame = document.createElement('iframe'); frame.id = ${JSON.stringify(name)}; frame.src = '/'; frame.style.cssText = 'position: fixed; left: 0; bottom: 0; width: 900px; height: 300px; opacity: 0.01; pointer-events: none;'; document.body.append(frame);`);
      const inTab = (name: string, body: string) => page.run<any>(`const doc = document.getElementById(${JSON.stringify(name)})?.contentDocument; if (!doc) return null; ${body}`);
      const live = (name: string) => page.until(`const doc = document.getElementById(${JSON.stringify(name)})?.contentDocument; return Boolean(doc?.getElementById('sync')?.textContent.startsWith('Live'))`, `${name} to say it is live`, 8000);
      const columnIn = (name: string) => inTab(name, `return doc.querySelector('.card[data-id="${ids.address}"]')?.closest('.column').dataset.key ?? null`);
      const settle = async (count: number, within: number) => {
        const end = Date.now() + within;
        while ((await listeners()) !== count && Date.now() < end) await page.wait(100);
        return listeners();
      };
      try {
        await setting("auto");
        await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
        assert.equal(await listeners(), 1);
        // Three more tabs open with auto-refresh on, two of them at the same moment. All are live on one connection.
        await open("tab-two");
        await live("tab-two");
        await open("tab-three");
        await open("tab-four");
        await live("tab-three");
        await live("tab-four");
        assert.equal(await settle(1, 3000), 1, "four tabs are live, and the service has one listener");
        await page.wait(600);
        assert.equal(await listeners(), 1, "and it stays at one");
        // A change reaches every tab.
        await move(ids.address!, "in_review");
        for (const name of ["tab-two", "tab-three", "tab-four"]) {
          await page.until(`return document.getElementById(${JSON.stringify(name)}).contentDocument.querySelector('.column[data-key="in_review"] .card[data-id="${ids.address}"]') !== null`, `the change to reach ${name}`, 3000);
        }
        assert.equal(await page.run<string>(`return document.querySelector('.card[data-id="${ids.address}"]').closest('.column').dataset.key`), "in_review");
        // The tab that holds the stream stops listening: another takes over, and all of them still hear of changes.
        await setting("auto");
        // The explicit handoff is normally immediate. If its broadcast is lost, the remaining tabs recover by
        // their bounded liveness check; allow that real fallback rather than failing before its first interval.
        assert.equal(await settle(1, 20_000), 1, "one of the other tabs listens now");
        await move(ids.address!, "in_progress");
        for (const name of ["tab-two", "tab-three", "tab-four"]) {
          await page.until(`return document.getElementById(${JSON.stringify(name)}).contentDocument.querySelector('.column[data-key="in_progress"] .card[data-id="${ids.address}"]') !== null`, `the next change to reach ${name}`, 3000);
        }
        // Tabs are closed without a word, the one that listens perhaps among them: the one that is left finds out and listens itself.
        await page.run("document.getElementById('tab-two').remove(); document.getElementById('tab-three').remove();");
        assert.equal(await settle(1, 20_000), 1, "the tab that is left listens");
        await move(ids.address!, "in_review");
        await page.until(`return document.getElementById('tab-four').contentDocument.querySelector('.column[data-key="in_review"] .card[data-id="${ids.address}"]') !== null`, "the change to reach the tab that is left", 20_000);
        assert.equal(await columnIn("tab-four"), "in_review");
      } finally {
        await page.run("for (const frame of document.querySelectorAll('iframe')) frame.remove(); localStorage.removeItem('vigile.auto-refresh')");
        await move(ids.address!, "in_progress").catch(() => {});
        await load();
      }
    });

    it("looks at a task the moment it is watched, in case it was finished since the page last read it", async () => {
      await page.size(1280, 900);
      const already = (await run("create_task", { title: "Finished before it is watched", description: "d", project: "WEB" })) as { id: string; version: number };
      const other = (await run("create_task", { title: "Watched all along", description: "d", project: "WEB" })) as { id: string; version: number };
      await load();
      await page.run(`sessionStorage.setItem('vigile.watching', ${JSON.stringify(JSON.stringify([other.id]))})`);
      await load();
      try {
        const end = Date.now() + 3000;
        while ((await listeners()) !== 1 && Date.now() < end) await page.wait(50);
        // The task's panel is open, and still says it is unfinished, when the task is finished by someone else.
        const index = await page.run<number>(`return [...document.querySelectorAll('.card')].findIndex((c) => c.dataset.id === ${JSON.stringify(already.id)})`);
        await page.click(".card", index);
        await page.until("return document.querySelector('.detail-title')?.textContent === 'Finished before it is watched'", "the task's panel");
        await move(already.id, "in_progress", "done");
        await page.wait(600);
        assert.equal(await text("#detail .watch"), "Tell me when it is done", "auto-refresh is off, so the panel has not changed");
        await page.click("#detail .watch");
        // No further change is made: the watch itself must find out.
        await page.until("return document.querySelectorAll('.toast.done').length === 1", "the notice that the task is already done", 2500);
        assert.match(await text(".toast.done .toast-what"), new RegExp(`${already.id} is done`));
        assert.equal(await text("#watching"), "watching 1", "the other task is still watched");
      } finally {
        for (const task of [already, other]) await run("delete", { id: task.id, version: (await run("get", { id: task.id })).version });
        await page.run("sessionStorage.removeItem('vigile.watching')");
        await load();
      }
    });

    it("does not announce the same completion twice when an older reading of the tasks arrives late", async () => {
      await page.size(1280, 900);
      await load();
      await page.run("for (const name of ['vigile.sound', 'vigile.sound-created', 'vigile.sound-started']) localStorage.removeItem(name); sessionStorage.removeItem('vigile.watching')");
      await load();
      const spare = (await run("create_task", { title: "Changed to prompt a reading", description: "d", project: "WEB" })) as { id: string; version: number };
      try {
        await page.click("#refresh");
        await page.wait(400);
        await page.run("window.notes = 0; const start = OscillatorNode.prototype.start; OscillatorNode.prototype.start = function (...args) { window.notes++; return start.apply(this, args); };");
        await setting("sound");
        assert.equal(await page.run<number>("return window.notes"), 2, "turning the sound on plays it once");
        const end = Date.now() + 3000;
        while ((await listeners()) !== 1 && Date.now() < end) await page.wait(50);
        await page.wait(500);
        // The next reading of the tasks is answered at once by the service, and held back for over a second on its way.
        await page.run("window.realFetch = window.fetch; let held = 1; window.fetch = async (url, options) => { const response = await window.realFetch(url, options); if (String(url).includes('/api/list-tasks') && held-- > 0) await new Promise((done) => setTimeout(done, 1300)); return response; };");
        await run("update_task", { id: spare.id, version: spare.version, title: "Changed, to prompt a reading" });
        await page.wait(200);
        // Meanwhile a task is completed, and the plan is asked for with the refresh button: that reading announces it.
        await move(ids.address!, "done");
        await page.click("#refresh");
        await page.until("return window.notes === 4", "the sound for the completed task", 1000);
        // The reading that was held back arrives now, older than what was announced. Nothing is announced again.
        await page.wait(2200);
        assert.equal(await page.run<number>("return window.notes"), 4, "the completion is announced once");
      } finally {
        await page.run("if (window.realFetch) window.fetch = window.realFetch; for (const name of ['vigile.sound', 'vigile.sound-created', 'vigile.sound-started']) localStorage.removeItem(name)");
        await move(ids.address!, "open", "in_progress").catch(() => {});
        await run("delete", { id: spare.id, version: (await run("get", { id: spare.id })).version });
        await load();
      }
    });

    it("keeps the ring on a changed card under reduced motion, in every theme and on a group", async () => {
      await page.size(1280, 900);
      await load();
      try {
        await page.motion("reduce");
        for (const scheme of ["light", "dark"] as const) {
          await page.scheme(scheme);
          for (const name of ["vigile", "dado", "jeev", "gito"]) {
            const shadows = await page.run<string[]>(`
              document.documentElement.dataset.theme = ${JSON.stringify(name)};
              return [".card:not(.is-group):not(.trouble)", ".card.is-group", ".card.trouble"].map((selector) => {
                const card = document.querySelector(selector); card.classList.add("changed");
                const shadow = getComputedStyle(card).boxShadow; card.classList.remove("changed");
                return shadow;
              });
            `);
            for (const shadow of shadows) assert.match(shadow, /^[a-z]+\([^)]*\) 0px 0px 0px 3px$/, `a changed card is ringed, and only ringed, in ${name}, ${scheme}: ${shadow}`);
          }
        }
      } finally {
        await page.motion("no-preference");
        await page.scheme("light");
        await page.run("document.documentElement.dataset.theme = 'vigile'");
      }
    });

    it("plays the sound for started or completed, not for created, when a new task went that far between two readings", async () => {
      await page.size(1280, 900);
      await load();
      await page.run("for (const name of ['vigile.sound', 'vigile.sound-created', 'vigile.sound-started']) localStorage.removeItem(name); sessionStorage.removeItem('vigile.watching')");
      await load();
      const made: Array<{ id: string }> = [];
      const fresh = async (title: string, ...statuses: string[]) => {
        const task = (await run("create_task", { title, description: "d", project: "WEB" })) as { id: string };
        made.push(task);
        if (statuses.length) await move(task.id, ...statuses);
      };
      // The wave of each note played says which sound it was: a sine for created, triangles for started, squares for completed.
      const WAVES = "window.waves = []; const start = OscillatorNode.prototype.start; OscillatorNode.prototype.start = function (...args) { window.waves.push(this.type); return start.apply(this, args); };";
      const waves = () => page.run<string[]>("return window.waves");
      const heard = (count: number, what: string) => page.until(`return window.waves.length === ${count}`, what, 6000);
      try {
        await page.run(WAVES);
        await setting("sound");
        assert.deepEqual(await waves(), ["square", "square"]);
        const end = Date.now() + 3000;
        while ((await listeners()) !== 1 && Date.now() < end) await page.wait(50);
        await page.wait(400);
        // Only "Completed" is on. A task is created and completed while the tasks cannot be read: it is heard as completed.
        await page.block(["*/api/list-tasks"]);
        await fresh("Created and completed in one go", "in_progress", "done");
        await page.wait(300);
        await page.block([]);
        await heard(4, "the sound for the task that was created and completed");
        assert.deepEqual((await waves()).slice(2), ["square", "square"]);
        // With all three on, a task created and started in one go is heard as started, not as created.
        await setting("sound-created");
        await setting("sound-started");
        assert.deepEqual((await waves()).slice(4), ["sine", "triangle", "triangle"], "each switch plays its own sound when turned on");
        await page.wait(400);
        await page.block(["*/api/list-tasks"]);
        await fresh("Created and started in one go", "in_progress");
        await page.wait(300);
        await page.block([]);
        await heard(9, "the sound for the task that was created and started");
        assert.deepEqual((await waves()).slice(7), ["triangle", "triangle"]);
        // A task that is only created is still heard as created.
        await fresh("Only created");
        await heard(10, "the sound for the new task");
        assert.deepEqual((await waves()).slice(9), ["sine"]);
      } finally {
        await page.block([]);
        for (const task of made) await run("delete", { id: task.id, version: (await run("get", { id: task.id })).version });
        await page.run("for (const name of ['vigile.sound', 'vigile.sound-created', 'vigile.sound-started']) localStorage.removeItem(name)");
        await load();
      }
    });

    it("gives up a stream of changes that has gone silent, and learns of changes by asking instead", async () => {
      await page.size(1280, 900);
      await load();
      // In this page a stream delivers its first message and then nothing more, without ending; and the 45 seconds
      // the page waits before it takes a silent stream for stalled last a second and a half.
      const stalling = (await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
          const realTimeout = window.setTimeout;
          window.setTimeout = (run, ms, ...rest) => realTimeout(run, ms === 45000 ? 1500 : ms, ...rest);
          const realFetch = window.fetch;
          window.fetch = async (url, options) => {
            const response = await realFetch(url, options);
            if (!String(url).includes("/api/events") || !response.body) return response;
            const reader = response.body.getReader();
            let sent = false;
            const body = new ReadableStream({
              start(controller) { options?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError"))); },
              async pull(controller) { if (sent) return new Promise(() => {}); const { value } = await reader.read(); controller.enqueue(value); sent = true; },
            });
            return new Response(body, { status: response.status, headers: response.headers });
          };
        `,
      })) as { identifier: string };
      try {
        await page.run("localStorage.setItem('vigile.auto-refresh', 'on')");
        await load();
        await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live", 5000);
        assert.equal(await listeners(), 1);
        // Nothing more arrives. The page stops saying it is live, and lets the connection go.
        await page.until("return document.getElementById('sync').textContent.startsWith('Updated')", "the page to stop saying it is live", 4000);
        const end = Date.now() + 2000;
        while ((await listeners()) !== 0 && Date.now() < end) await page.wait(50);
        assert.equal(await listeners(), 0, "the silent connection is closed");
        // A change still reaches the board: the page asks every 3 seconds until a stream works again.
        await move(ids.address!, "in_review");
        await page.until(`return document.querySelector('.column[data-key="in_review"] .card[data-id="${ids.address}"]') !== null`, "the change to appear by asking", 5000);
      } finally {
        await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: stalling.identifier });
        await page.run("localStorage.removeItem('vigile.auto-refresh')");
        await move(ids.address!, "in_progress").catch(() => {});
        await load();
      }
    });

    it("does not act on an answer about a watched task that is older than what it already knows, or than the watch itself", async () => {
      await page.size(1280, 900);
      const watched = (await run("create_task", { title: "Done, then reopened", description: "d", project: "WEB" })) as { id: string; version: number };
      await load();
      await page.run(`sessionStorage.setItem('vigile.watching', ${JSON.stringify(JSON.stringify([watched.id]))})`);
      await load();
      const hold = "window.realFetch ??= window.fetch; let held = 1; window.fetch = async (url, options) => { const response = await window.realFetch(url, options); if (String(url).includes('/api/get') && held-- > 0) await new Promise((done) => setTimeout(done, 1400)); return response; };";
      const cardOf = (id: string) => page.run<number>(`return [...document.querySelectorAll('.card')].findIndex((c) => c.dataset.id === ${JSON.stringify(id)})`);
      try {
        const end = Date.now() + 3000;
        while ((await listeners()) !== 1 && Date.now() < end) await page.wait(50);
        await page.wait(300);
        // The task is done, and the answer that says so is held back on its way. Meanwhile the task is reopened,
        // and the page reads the plan with the refresh button: it knows the task is open.
        await page.run(hold);
        await move(watched.id, "in_progress", "done");
        await page.wait(250);
        await move(watched.id, "open");
        await page.click("#refresh");
        await page.wait(1800);
        assert.deepEqual([await count(".toast"), await text("#watching")], [0, "watching 1"], "the late answer that said done is not acted on: the task is open and still watched");

        // The same again, and this time the watch is stopped and started anew while the answer is on its way.
        await page.run(hold);
        await move(watched.id, "in_progress", "done");
        await page.wait(250);
        await move(watched.id, "open");
        await page.click("#refresh");
        await page.wait(300);
        await page.click(".card", await cardOf(watched.id));
        await page.until("return document.querySelector('#detail .watch')?.getAttribute('aria-pressed') === 'true'", "the task's panel, watching");
        await page.click("#detail .watch");
        await page.until("return document.querySelector('#detail .watch')?.getAttribute('aria-pressed') === 'false'", "the watch stopped");
        await page.click("#detail .watch");
        await page.until("return document.getElementById('panel').hidden", "the watch started anew");
        await page.wait(1800);
        assert.deepEqual([await count(".toast"), await text("#watching")], [0, "watching 1"], "the answer from before the new watch does not use it up");
        // The new watch works: the next completion is announced.
        await move(watched.id, "in_progress", "done");
        await page.until("return document.querySelectorAll('.toast.done').length === 1", "the notice for the real completion", 3000);
      } finally {
        await page.run("if (window.realFetch) window.fetch = window.realFetch; sessionStorage.removeItem('vigile.watching')");
        await run("delete", { id: watched.id, version: (await run("get", { id: watched.id })).version });
        await load();
      }
    });

    it("keeps every column scrolled where it was when the board is drawn again, and a travelling card under an open panel", async () => {
      await page.size(1280, 800);
      const watched = (await run("create_task", { title: "Finished while a column is scrolled", description: "d", project: "WEB" })) as { id: string; version: number };
      await load();
      await page.run(`sessionStorage.setItem('vigile.watching', ${JSON.stringify(JSON.stringify([watched.id]))})`);
      await load();
      const next = `document.querySelector('.column[data-key="next"] .cards')`;
      const done = `document.querySelector('.column[data-key="done"] .cards')`;
      const places = () => page.run<number[]>(`return [Math.round(${next}.scrollTop), Math.round(${done}.scrollTop)]`);
      try {
        // Two columns are scrolled part of the way down, as by someone reading them.
        await page.run(`${next}.scrollTop = 180; ${done}.scrollTop = 120;`);
        assert.deepEqual(await places(), [180, 120], "the columns scroll by themselves");
        // Auto-refresh is off. A watched task is finished: the notice appears and the card's watch mark goes, which draws the board again.
        await move(watched.id, "in_progress", "done");
        await page.until("return document.querySelectorAll('.toast.done').length === 1", "the notice that the watched task is done", 3000);
        assert.equal(await count(".tag.watched"), 0);
        assert.deepEqual(await places(), [180, 120], "the reader keeps their place in both columns");
        await page.click(".toast-close");

        // With auto-refresh on, a change elsewhere on the board leaves them where they are too.
        await setting("auto");
        await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
        // The finished task's card was far down its column, out of sight: it sets off from the column's edge, inside the window.
        await page.until("return document.querySelectorAll('.card-ghost').length === 1", "the finished task's card to set off for Done", 2000);
        const start = await page.run<{ top: number; bottom: number }>("const flight = document.querySelector('.card-ghost').getAnimations()[0]; const was = flight.currentTime; flight.currentTime = 0; const r = document.querySelector('.card-ghost').getBoundingClientRect(); flight.currentTime = was; return { top: r.top, bottom: r.bottom }");
        assert.ok(start.top >= 0 && start.bottom <= 800, `a card scrolled out of sight sets off from inside the window: ${Math.round(start.top)} to ${Math.round(start.bottom)} of 800`);
        await settled();
        await page.run(`${next}.scrollTop = 180; ${done}.scrollTop = 120;`);
        // A task's panel is open while another task changes column: its card travels under the panel, not over it.
        await page.click(".card", await page.run<number>(`return [...document.querySelectorAll('.card')].findIndex((c) => c.dataset.id === ${JSON.stringify(ids.bugBusy)})`));
        await page.until("return !document.getElementById('panel').hidden", "a task's panel");
        await watchGhosts();
        await move(ids.address!, "in_review");
        await page.until("return document.querySelectorAll('.card-ghost').length === 1", "the card to set off", 2000);
        const layers = await page.run<{ ghost: number; panel: number; top: string }>(
          "const ghost = document.querySelector('.card-ghost'); const r = ghost.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { ghost: Number(getComputedStyle(ghost).zIndex), panel: Number(getComputedStyle(document.getElementById('panel')).zIndex), top: at?.closest('#panel') ? 'panel' : (at ? at.tagName + '#' + at.id + '.' + at.className : 'nothing') + ' at ' + Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2) }",
        );
        assert.ok(layers.ghost < layers.panel, `the travelling card is under the panel: ${layers.ghost} under ${layers.panel}`);
        assert.equal(layers.top, "panel", "where the card travels, it is the panel that is in front");
        await settled();
        assert.deepEqual(await places(), [180, 120], "and the columns are still where they were");
        await page.key("Escape");
      } finally {
        await move(ids.address!, "in_progress").catch(() => {});
        await run("delete", { id: watched.id, version: (await run("get", { id: watched.id })).version });
        await page.run("localStorage.removeItem('vigile.auto-refresh'); sessionStorage.removeItem('vigile.watching')");
        await load();
      }
    });

    it("plays the chime of a watched task and not the sound for a completed task on top of it, whichever answer comes first", async () => {
      await page.size(1280, 900);
      const task = (await run("create_task", { title: "Watched after it was done", description: "d", project: "WEB" })) as { id: string; version: number };
      await move(task.id, "in_progress");
      await load();
      await page.run("for (const name of ['vigile.sound', 'vigile.sound-created', 'vigile.sound-started']) localStorage.removeItem(name); sessionStorage.removeItem('vigile.watching')");
      await load();
      // The wave of each note says which sound it was: squares for a completed task, sines for the chime of a watched one.
      const waves = () => page.run<string[]>("return window.waves");
      try {
        await page.run("window.waves = []; const start = OscillatorNode.prototype.start; OscillatorNode.prototype.start = function (...args) { window.waves.push(this.type); return start.apply(this, args); };");
        await setting("sound");
        assert.deepEqual(await waves(), ["square", "square"], "turning the sound on plays it once");
        const end = Date.now() + 3000;
        while ((await listeners()) !== 1 && Date.now() < end) await page.wait(50);
        await page.wait(400);
        // The task's panel is open, still saying it is unfinished, when the task is completed. The reading of all the
        // tasks that this prompts is answered at once and held back on its way for over a second.
        await page.click(".card", await page.run<number>(`return [...document.querySelectorAll('.card')].findIndex((c) => c.dataset.id === ${JSON.stringify(task.id)})`));
        await page.until("return document.querySelector('.detail-title')?.textContent === 'Watched after it was done'", "the task's panel");
        await page.run("window.realFetch = window.fetch; let held = 1; window.fetch = async (url, options) => { const response = await window.realFetch(url, options); if (String(url).includes('/api/list-tasks') && held-- > 0) await new Promise((done) => setTimeout(done, 1300)); return response; };");
        await move(task.id, "done");
        await page.wait(250);
        // Meanwhile the task is watched: that reads it at once, finds it done, and plays the chime of the watch.
        await page.click("#detail .watch");
        await page.until("return document.querySelectorAll('.toast.done').length === 1", "the notice that the watched task is done", 1000);
        assert.deepEqual((await waves()).slice(2), ["sine", "sine", "sine"], "the three notes of the watch");
        // The held answer arrives, older than what the watch found. It must not announce the same completion again.
        await page.wait(1800);
        assert.deepEqual((await waves()).slice(2), ["sine", "sine", "sine"], "and no sound for a completed task after them");
        // Another task completed afterwards is still announced as usual.
        await move(ids.address!, "done");
        await page.until("return window.waves.length === 7", "the sound for another completed task", 3000);
        assert.deepEqual((await waves()).slice(5), ["square", "square"]);
      } finally {
        await page.run("if (window.realFetch) window.fetch = window.realFetch; for (const name of ['vigile.sound', 'vigile.sound-created', 'vigile.sound-started']) localStorage.removeItem(name); sessionStorage.removeItem('vigile.watching')");
        await move(ids.address!, "open", "in_progress").catch(() => {});
        await run("delete", { id: task.id, version: (await run("get", { id: task.id })).version });
        await load();
      }
    });

    it("announces a task's next completion after the watch announced an earlier one and the task was reopened", async () => {
      await page.size(1280, 900);
      const task = (await run("create_task", { title: "Completed, reopened, completed", description: "d", project: "WEB" })) as { id: string; version: number };
      await load();
      await page.run(`for (const name of ['vigile.sound', 'vigile.sound-created', 'vigile.sound-started']) localStorage.removeItem(name); sessionStorage.setItem('vigile.watching', ${JSON.stringify(JSON.stringify([task.id]))})`);
      await load();
      const waves = () => page.run<string[]>("return window.waves");
      try {
        await page.run("window.waves = []; const start = OscillatorNode.prototype.start; OscillatorNode.prototype.start = function (...args) { window.waves.push(this.type); return start.apply(this, args); };");
        const end = Date.now() + 3000;
        while ((await listeners()) !== 1 && Date.now() < end) await page.wait(50);
        await page.wait(300);
        // Sounds and auto-refresh are off. The watched task is completed: the watch chimes.
        await move(task.id, "in_progress", "done");
        await page.until("return document.querySelectorAll('.toast.done').length === 1", "the notice that the watched task is done", 3000);
        assert.deepEqual(await waves(), ["sine", "sine", "sine"]);
        // The task is reopened, and only then is the sound for completed tasks switched on.
        await move(task.id, "open");
        await setting("sound");
        assert.deepEqual((await waves()).slice(3), ["square", "square"], "turning the sound on plays it once");
        await page.wait(600);
        // Its next completion is another one, and is heard.
        await move(task.id, "in_progress", "done");
        await page.until("return window.waves.length === 7", "the sound for the second completion", 4000);
        assert.deepEqual((await waves()).slice(5), ["square", "square"]);
      } finally {
        await page.run("for (const name of ['vigile.sound', 'vigile.sound-created', 'vigile.sound-started']) localStorage.removeItem(name); sessionStorage.removeItem('vigile.watching')");
        await run("delete", { id: task.id, version: (await run("get", { id: task.id })).version });
        await load();
      }
    });

    it("leaves the keyboard where it was when the board is drawn again", async () => {
      await page.size(1280, 800);
      const watched = (await run("create_task", { title: "Finished while the keyboard is elsewhere", description: "d", project: "WEB" })) as { id: string; version: number };
      await load();
      await page.run(`sessionStorage.setItem('vigile.watching', ${JSON.stringify(JSON.stringify([watched.id]))})`);
      await load();
      const focused = () => page.run<string>("const at = document.activeElement; return at.dataset?.id ?? (at.closest?.('.project') ? 'project ' + at.closest('.project').querySelector('.project-id').textContent + ' ' + at.className : at.tagName)");
      try {
        // The keyboard is on a card that has nothing to do with the watched task, in a column scrolled part of the way.
        await page.run(`const column = document.querySelector('.column[data-key="next"] .cards'); column.scrollTop = 150; document.querySelector('.card[data-id="${ids.card}"]').focus({ preventScroll: true });`);
        const before = await page.run<number[]>(`return [Math.round(document.querySelector('.column[data-key="next"] .cards').scrollTop), Math.round(scrollY)]`);
        assert.equal(await focused(), ids.card);
        // Auto-refresh is off. The watched task is finished, which draws the board again to take its mark away.
        await move(watched.id, "in_progress", "done");
        await page.until("return document.querySelectorAll('.toast.done').length === 1", "the notice that the watched task is done", 3000);
        assert.equal(await count(".tag.watched"), 0);
        assert.equal(await focused(), ids.card, "the keyboard is still on the same card");
        assert.deepEqual(await page.run<number[]>(`return [Math.round(document.querySelector('.column[data-key="next"] .cards').scrollTop), Math.round(scrollY)]`), before, "and nothing scrolled to put it there");
        // Enter still opens that card.
        await page.key("Enter");
        await page.until("return document.querySelector('.detail-title')?.textContent === 'Card form'", "the card under the keyboard to open");
        await page.key("Escape");
        await page.click(".toast-close");

        // With auto-refresh on, a change elsewhere leaves the keyboard on a project's button too.
        await setting("auto");
        await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
        await page.run("[...document.querySelectorAll('.project')].find((p) => p.querySelector('.project-id').textContent === 'WEB').querySelector('.project-main').focus({ preventScroll: true })");
        assert.equal(await focused(), "project WEB project-main");
        await move(ids.address!, "in_review");
        await page.until(`return document.querySelector('.column[data-key="in_review"] .card[data-id="${ids.address}"]') !== null`, "the change to appear", 3000);
        assert.equal(await focused(), "project WEB project-main", "the keyboard is still on the project's button");
        await settled();
      } finally {
        await move(ids.address!, "in_progress").catch(() => {});
        await run("delete", { id: watched.id, version: (await run("get", { id: watched.id })).version });
        await page.run("localStorage.removeItem('vigile.auto-refresh'); sessionStorage.removeItem('vigile.watching')");
        await load();
      }
    });

    it("turns a card that is on its way towards its new place when its task changes again, and leaves the card with the keyboard where it is", async () => {
      await page.size(1280, 900);
      await load();
      const card = `document.querySelector('.card[data-id="${ids.address}"]')`;
      const mine = `[...document.querySelectorAll('.card-ghost')].filter((g) => g.querySelector('.id').textContent === ${JSON.stringify(ids.address)})`;
      try {
        await setting("auto");
        await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
        await watchGhosts();
        // The task goes to review, and on to done while its card is still on the way to review.
        await move(ids.address!, "in_review");
        await page.until(`return ${mine}.length === 1`, "the card to set off for review", 2000);
        await page.wait(200);
        await move(ids.address!, "done");
        await page.until(`return ${card}.closest('.column').dataset.key === 'done'`, "the second change to arrive", 2000);
        const flight = await page.run<{ copies: number; hidden: string; lands: number; column: { left: number; right: number } }>(`
          const copies = ${mine};
          const flying = copies[0].getAnimations()[0];
          const was = flying.currentTime;
          flying.currentTime = flying.effect.getComputedTiming().duration - 1;
          const lands = copies[0].getBoundingClientRect().left + copies[0].getBoundingClientRect().width / 2;
          flying.currentTime = was;
          const column = ${card}.closest('.column').getBoundingClientRect();
          return { copies: copies.length, hidden: getComputedStyle(${card}).visibility, lands, column: { left: column.left, right: column.right } };
        `);
        assert.equal(flight.copies, 1, "there is still one copy of the card in the air, not two");
        assert.equal(flight.hidden, "hidden", "the card waits unseen in Done");
        assert.ok(flight.lands > flight.column.left && flight.lands < flight.column.right, `the copy now heads for Done: it lands at ${Math.round(flight.lands)}, inside ${Math.round(flight.column.left)} to ${Math.round(flight.column.right)}`);
        await settled();
        assert.deepEqual(await page.run(`return [${card}.closest('.column').dataset.key, getComputedStyle(${card}).visibility, document.querySelectorAll('.card-ghost').length]`), ["done", "visible", 0]);
        await move(ids.address!, "open", "in_progress");
        await page.until(`return ${card}.closest('.column').dataset.key === 'in_progress'`, "the plan put back", 3000);
        await settled();

        // The card that has the keyboard does not travel: it is in its new place at once, ringed, still with the keyboard.
        await page.run(`${card}.focus({ preventScroll: true })`);
        await watchGhosts();
        await move(ids.address!, "in_review");
        await page.until(`return ${card}.closest('.column').dataset.key === 'in_review'`, "the change to appear", 2000);
        assert.deepEqual(
          await page.run(`return [document.activeElement === ${card}, getComputedStyle(${card}).visibility, ${card}.classList.contains('changed'), window.ghosts]`),
          [true, "visible", true, 0],
          "it keeps the keyboard, is in sight and ringed, and no copy travels",
        );
        await page.key("Enter");
        await page.until("return document.querySelector('.detail-title')?.textContent === 'Address form'", "Enter to open the card that has the keyboard");
        await page.key("Escape");
      } finally {
        await move(ids.address!, "in_progress").catch(() => {});
        await page.run("localStorage.removeItem('vigile.auto-refresh')");
        await load();
      }
    });

    it("shows at most five notices at a time, says how many there are, and closes them all with one button", async () => {
      await page.size(1280, 900);
      const made: Array<{ id: string }> = [];
      for (let i = 1; i <= 7; i++) made.push(await run("create_task", { title: `Watched task ${i}`, description: "d", project: "WEB" }));
      const said = (from: number, to: number) => made.slice(from, to).map((task) => `${task.id} is done`);
      const seen = () => page.run<{ shown: string[]; head: string }>("const head = document.getElementById('toasts-head'); return { shown: [...document.querySelectorAll('.toast .toast-what')].map((t) => t.textContent), head: head.hidden || !head.getBoundingClientRect().width ? '' : document.getElementById('toasts-count').textContent }");
      const finish = async (index: number, notices: number) => {
        await move(made[index]!.id, "in_progress", "done");
        await page.until(`return document.querySelectorAll('.toast').length === ${Math.min(notices, 5)} && (${notices} < 2 || document.getElementById('toasts-count').textContent.startsWith('${notices} '))`, `notice number ${notices}`, 3000);
      };
      await load();
      await page.run(`sessionStorage.setItem('vigile.watching', ${JSON.stringify(JSON.stringify(made.map((task) => task.id)))})`);
      await load();
      try {
        assert.equal(await text("#watching"), "watching 7");
        // One notice stands by itself; from two on, a line says how many there are and offers to close them all.
        await finish(0, 1);
        assert.deepEqual(await seen(), { shown: said(0, 1), head: "" }, "one notice needs no count");
        await finish(1, 2);
        assert.deepEqual(await seen(), { shown: said(0, 2), head: "2 notifications" });
        for (let i = 2; i < 7; i++) await finish(i, i + 1);
        // Seven notices: the latest five are on screen, and the line says there are seven.
        assert.deepEqual(await seen(), { shown: said(2, 7), head: "7 notifications, showing the latest 5" });
        const box = await page.run<{ top: number; bottom: number }>("const r = document.getElementById('toasts').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }");
        assert.ok(box.top >= 0 && box.bottom <= 900, "the notices fit in the window");
        await layout("with seven notices, five of them on screen");
        // Dismissing one brings an earlier one into view.
        await page.click(".toast .toast-close", 4);
        assert.deepEqual(await seen(), { shown: said(1, 6), head: "6 notifications, showing the latest 5" });
        // In a short window, a phone held sideways, the stack is no taller than the window: it scrolls, and the line
        // with the count and the button that closes them all stays in reach.
        await page.size(844, 390, true);
        const short = await page.run<{ top: number; bottom: number; scrolls: boolean; head: { top: number; bottom: number } }>(
          "const box = document.getElementById('toasts'); const r = box.getBoundingClientRect(); const h = document.getElementById('toasts-head').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, scrolls: box.scrollHeight > box.clientHeight + 1 && getComputedStyle(box).overflowY === 'auto', head: { top: h.top, bottom: h.bottom } }",
        );
        assert.ok(short.top >= 0 && short.bottom <= 390, `the stack is inside the short window: from ${short.top} to ${short.bottom} of 390`);
        assert.equal(short.scrolls, true, "six notices need more room than there is, so the stack scrolls");
        assert.ok(short.head.top >= 0 && short.head.bottom <= 390, "the count and the button are in sight");
        await page.run("document.getElementById('toasts').scrollTop = 99999");
        const scrolled = await page.run<{ head: { top: number; bottom: number }; last: { top: number; bottom: number } }>(
          "const h = document.getElementById('toasts-head').getBoundingClientRect(); const l = [...document.querySelectorAll('.toast')].at(-1).getBoundingClientRect(); return { head: { top: h.top, bottom: h.bottom }, last: { top: l.top, bottom: l.bottom } }",
        );
        assert.ok(scrolled.head.top >= 0 && scrolled.head.bottom <= 390, "scrolled to the last notice, the count and the button are still in sight");
        assert.ok(scrolled.last.bottom <= 390, "and the last notice can be reached");
        await layout("with six notices in a short window");
        // On a phone they fit too.
        await page.size(360, 780, true);
        const small = await page.run<{ top: number; bottom: number; left: number; right: number }>("const r = document.getElementById('toasts').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }");
        assert.ok(small.top >= 0 && small.bottom <= 780 && small.left >= 0 && small.right <= 360, `the notices fit on a phone: ${JSON.stringify(small)}`);
        await layout("on a phone with six notices, five of them on screen");
        await page.size(1280, 900);
        // One button closes them all, those on screen and those behind them.
        await page.click("#toasts-clear");
        assert.deepEqual(await seen(), { shown: [], head: "" });
        assert.equal(await page.run<string | null>("return sessionStorage.getItem('vigile.watching')"), "[]");
      } finally {
        for (const task of made) await run("delete", { id: task.id, version: (await run("get", { id: task.id })).version });
        await page.run("sessionStorage.removeItem('vigile.watching')");
      }
      assert.deepEqual(page.errors, []);
    });

    it("watches a task in this tab only, plays a sound when it is done, and tells the service nothing about it", async () => {
      await page.size(1280, 900);
      await load();
      // Counts the notes played, in place of listening to them.
      await page.run("window.notes = 0; const start = OscillatorNode.prototype.start; OscillatorNode.prototype.start = function (...args) { window.notes++; return start.apply(this, args); };");
      const stored = () => page.run<string | null>("return sessionStorage.getItem('vigile.watching')");
      const toasts = () => page.run<string[]>("return [...document.querySelectorAll('.toast')].map((t) => t.className.replace('toast ', '') + ': ' + t.querySelector('.toast-what').textContent)");
      const revision = async () => ((await (await fetch(`${base}/api/admin/status`, { headers: { authorization: `Bearer ${adminKey}` } })).json()) as { engine: { revision: number } }).engine.revision;
      /** Presses the refresh button and waits until the plan has been loaded again. */
      const reload = async () => {
        const count = loads();
        await page.click("#refresh");
        const end = Date.now() + 3000;
        while (loads() === count && Date.now() < end) await page.wait(20);
        await page.wait(150);
      };
      const cardOf = (id: string) => page.run<number>(`return [...document.querySelectorAll('.card')].findIndex((c) => c.dataset.id === ${JSON.stringify(id)})`);

      assert.equal(await page.run<boolean>("return document.getElementById('auto').checked"), false, "auto-refresh is off for this test");
      const before = await revision();
      const sent = page.requests.length;
      await page.click(".card", await cardOf(ids.paused!));
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Paused item'", "the task's panel");
      assert.equal(await text("#detail .watch"), "Tell me when it is done");
      await page.click("#detail .watch");
      await page.until("return document.getElementById('panel').hidden", "the panel to close: there is nothing more to do in it", 2000);
      assert.equal(await stored(), JSON.stringify([ids.paused]), "the watch is kept in the tab's session storage");
      assert.equal(await page.run<string | null>("return localStorage.getItem('vigile.watching')"), null, "and not where it would outlive the tab");
      assert.equal(await text(`.card[data-id="${ids.paused}"] .tag.watched`), "watching", "the card says it is watched");
      // Opened again, the panel says the task is watched.
      await page.click(".card", await cardOf(ids.paused!));
      await page.until("return document.querySelector('#detail .watch')?.getAttribute('aria-pressed') === 'true'", "the button to say it is watching");
      assert.equal(await text("#detail .watch"), "Watching. Stop");
      await page.key("Escape");
      assert.equal(await text("#watching"), "watching 1");
      await layout("with a watched task");

      // A second one, to be cancelled, and a third, to be deleted.
      await page.click(".card", await cardOf(ids.review!));
      await page.until("return document.querySelector('.detail-title')?.textContent === 'In review item'", "the second task's panel");
      await page.click("#detail .watch");
      await page.until("return document.getElementById('panel').hidden", "the panel to close", 2000);
      const extra = (await run("create_task", { title: "Watched, then deleted", description: "d", project: "WEB" })) as { id: string; version: number };
      await reload();
      await page.until(`return document.querySelector('.card[data-id="${extra.id}"]') !== null`, "the new task");
      await page.click(".card", await cardOf(extra.id));
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Watched, then deleted'", "the third task's panel");
      await page.click("#detail .watch");
      await page.until("return document.getElementById('panel').hidden", "the panel to close", 2000);
      assert.equal(await text("#watching"), "watching 3");

      // The watches survive a reload of the tab.
      await load();
      assert.equal(await text("#watching"), "watching 3");
      await page.run("window.notes = 0; const start = OscillatorNode.prototype.start; OscillatorNode.prototype.start = function (...args) { window.notes++; return start.apply(this, args); };");
      await reload();

      // Watching sends the service nothing but reads, and changes nothing in it.
      const asked = [...new Set(page.requests.slice(sent).map((url) => new URL(url).pathname).filter((path) => path.startsWith("/api/")))].sort();
      assert.deepEqual(asked, ["/api/events", "/api/get", "/api/instance", "/api/list-projects", "/api/list-tasks"], "only reads, and the stream of changes");
      assert.equal(await revision(), before + 1, "the only change stored was the task this test created");

      // The task is finished by someone else. The board is not drawn again, but the watch notices.
      const loaded = loads();
      const began = Date.now();
      await move(ids.paused!, "in_progress", "done");
      await page.until("return document.querySelectorAll('.toast.done').length === 1", "the notice that the task is done", 2500);
      assert.ok(Date.now() - began < 2000, `noticed after ${Date.now() - began} ms`);
      assert.deepEqual(await toasts(), [`done: ${ids.paused} is done`]);
      assert.equal(await page.run<number>("return window.notes"), 3, "three notes were played");
      assert.equal(await stored(), JSON.stringify([ids.review, extra.id]), "the watch on it is gone");
      assert.equal(await text("#watching"), "watching 2");
      assert.equal(loads(), loaded, "the board was not loaded again: auto-refresh is off");
      await layout("with a notice that a watched task is done");

      // Cancelled and deleted tasks are said so, without the sound.
      await move(ids.review!, "cancelled");
      await page.until("return document.querySelectorAll('.toast').length === 2", "the notice that a watched task was cancelled", 2500);
      await run("delete", { id: extra.id, version: extra.version });
      await page.until("return document.querySelectorAll('.toast').length === 3", "the notice that a watched task was deleted", 2500);
      assert.deepEqual(await toasts(), [`done: ${ids.paused} is done`, `gone: ${ids.review} was cancelled`, `gone: ${extra.id} was deleted`]);
      assert.equal(await page.run<number>("return window.notes"), 3, "no sound for those");
      assert.equal(await stored(), "[]");
      assert.equal(await page.run<number>("return Math.round(document.getElementById('watching').getBoundingClientRect().width)"), 0);
      const end = Date.now() + 2000;
      while ((await listeners()) !== 0 && Date.now() < end) await page.wait(50);
      assert.equal(await listeners(), 0, "with nothing left to watch, the page stops listening");

      // The notice opens the task, and can be dismissed.
      await page.click(".toast.done button");
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Paused item'", "the task, opened from the notice");
      assert.equal(await count("#detail .watch"), 0, "a finished task cannot be watched");
      await page.key("Escape");
      await page.click(".toast .toast-close");
      await page.click(".toast .toast-close");
      assert.equal(await count(".toast"), 0);

      // A watch can be stopped by hand.
      await reload();
      await page.click(".card", await cardOf(ids.draft!));
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Draft item'", "another task");
      await page.click("#detail .watch");
      await page.until("return document.getElementById('panel').hidden", "the panel to close", 2000);
      await page.click(".card", await cardOf(ids.draft!));
      await page.until("return document.querySelector('#detail .watch')?.getAttribute('aria-pressed') === 'true'", "watching");
      await page.click("#detail .watch");
      await page.until("return document.querySelector('#detail .watch')?.getAttribute('aria-pressed') === 'false'", "not watching");
      assert.equal(await panelOpen(), true, "stopping a watch leaves the panel open");
      assert.equal(await stored(), "[]");
      await page.key("Escape");

      // Put the plan back as the other tests expect it.
      await move(ids.paused!, "open", "in_progress", "paused");
      await move(ids.review!, "open", "in_progress", "in_review");
      assert.deepEqual(page.errors, []);
    });

    it("picks up a change on refresh, and keeps the scroll position and the open panel", async () => {
      await wholePage(async () => {
      await page.run("scrollTo(0, 300)");
      await page.click(".column[data-tone='busy'] .card");
      await page.until("return !document.getElementById('panel').hidden", "the panel");
      await page.run("scrollTo(0, 300)");
      const scrolled = await page.run<number>("return scrollY");
      assert.ok(scrolled > 100);
      await move(ids.address!, "in_review");
      await page.run("document.getElementById('refresh').click()");
      await page.until("return document.querySelector('#detail .pill')?.textContent === 'in review'", "the panel to show the new status");
      await page.key("Escape");
      assert.deepEqual([(await columns())["In progress"], (await columns())["In review"]], [1, 2]);
      assert.equal(await page.run<number>("return scrollY"), scrolled, "the page did not jump");
      });
      await move(ids.address!, "in_progress");
    });

    it("says so when the data on screen is old, and when the service cannot be reached", async () => {
      await load();
      await page.run("const real = Date.now; Date.now = () => real() + 5 * 60000; await new Promise((r) => setTimeout(r, 16000)); Date.now = real;");
      assert.match(await text("#sync"), /Loaded 5 min ago, may be out of date/);
      await page.block(["*/api/*"]);
      try {
        await page.click("#refresh");
        await page.until("return !document.getElementById('notice').hidden", "the notice");
        assert.match(await text("#notice"), /Cannot reach the service\. Trying again every few seconds\. Showing what was loaded at/);
        assert.ok((await count(".card")) > 0, "what was loaded stays on screen");
        await layout("while the service cannot be reached");
      } finally {
        await page.block([]);
      }
      await page.until("return document.getElementById('notice').hidden", "the notice to go away by itself, without a click", 5000);
    });

    it("finds the service again by itself after it was stopped and started, with auto-refresh off and on", async () => {
      await page.size(1280, 900);
      await load();
      const again = async () => {
        service = await startService({ loaded: loadConfig(config, {}), log: () => {}, warn: () => {} });
      };
      const notice = () => page.run<string>("const n = document.getElementById('notice'); return n.hidden ? '' : n.textContent");
      try {
        // Auto-refresh off: the person asks for the plan while the service is away.
        assert.equal(await page.run<boolean>("return document.getElementById('auto').checked"), false);
        await service.stop();
        await page.click("#refresh");
        await page.until("return !document.getElementById('notice').hidden", "the notice", 3000);
        assert.match(await notice(), /Cannot reach the service\. Trying again every few seconds\./);
        assert.match(await text("#sync"), /Not connected/);
        const asked = loads();
        await page.wait(3500);
        assert.ok(loads() > asked, "the page asks again by itself while the service is away");
        // A change is made while the page is cut off, and the service comes back.
        await again();
        await move(ids.address!, "in_review");
        await page.until("return document.getElementById('notice').hidden", "the page to find the service again without a click", 5000);
        assert.match(await text("#sync"), /^Updated/);
        assert.equal(await count(`.column[data-key="in_review"] .card[data-id="${ids.address}"]`), 1, "and shows the plan as it is now");
        const settledAt = loads();
        await page.wait(3500);
        assert.equal(loads(), settledAt, "once it has the plan, it stops asking: auto-refresh is off");
        await move(ids.address!, "in_progress");

        // Opened while the service is away, the page shows the plan as soon as the service is there.
        await service.stop();
        await page.open("about:blank");
        await page.open(`${base}/`).catch(() => {});
        await again();
        await page.open(`${base}/`);
        await page.until("return /^(Updated|Live)/.test(document.getElementById('sync').textContent)", "the page to show its data");

        // Auto-refresh on: the page says it is live again, by itself.
        await setting("auto");
        await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
        await service.stop();
        await page.until("return !document.getElementById('notice').hidden", "the notice", 8000);
        await again();
        await page.until("return document.getElementById('notice').hidden", "the notice to go away", 6000);
        await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to be live again", 20_000);
        await setting("auto");
      } finally {
        await service.stop().catch(() => {});
        await again();
        await page.run("localStorage.removeItem('vigile.auto-refresh')").catch(() => {});
      }
      assert.deepEqual(page.errors.filter((e) => !/Failed to load resource|net::ERR/.test(e)), []);
    });
  });

  browserSuite("graph", () => {
    it("is reached from the header, shows only itself, and is part of the address", async () => {
      await page.size(1280, 900);
      await load();
      await page.click("#view-graph");
      await graphReady();
      assert.equal(await page.run<string>("return location.hash"), "#graph");
      assert.equal(await page.run<number>("return Math.round(document.getElementById('board').getBoundingClientRect().height)"), 0, "the board is not on screen");
      assert.equal(await text(".views [aria-current]"), "Graph");
      await layout("in the graph");
      await load("/#graph");
      await graphReady();
      await page.click("#view-board");
      await page.until("return document.getElementById('board').getBoundingClientRect().height > 0", "the board");
      await page.run("history.back()");
      await page.until("return location.hash === '#graph' && document.getElementById('board').getBoundingClientRect().height === 0", "the graph after going back");
      await page.run("history.forward()");
      await page.until("return location.hash === '#board' && document.getElementById('graph-panel').getBoundingClientRect().height === 0", "the board after going forward");
      assert.deepEqual(page.errors, []);
    });

    it("shows groups as single items by default, and their contents when expanded", async () => {
      await load("/#graph");
      await graphReady();
      const nodes = () => page.run<string[]>("return window.vigileGraph.nodes('[ref]').map((n) => n.id()).sort()");
      const collapsed = await nodes();
      assert.ok(collapsed.includes(`task:${ids.checkout}`) && !collapsed.includes(`task:${ids.card}`), "the group stands for its contents");
      assert.equal(collapsed.length, 55 - 7 + 2, "every task outside a group, the group, and two projects");
      assert.match(await page.run<string>(`return window.vigileGraph.getElementById('task:${ids.checkout}').data('label')`), /1\/7/);
      assert.equal(await page.run<number>(`return window.vigileGraph.edges('[source = "task:${ids.checkout}"][target = "task:${ids.launch}"]').length`), 1, "the launch waits for the whole group");

      await page.click("label:has(#collapse-groups)");
      await page.until(`return window.vigileGraph.getElementById('task:${ids.card}').length === 1 && window.vigileGraph.scratch('settled')`, "the expanded graph", 20_000);
      assert.equal((await nodes()).length, 57);
      assert.equal(await page.run<string>(`return window.vigileGraph.getElementById('task:${ids.card}').parent().id()`), `task:${ids.payments}`);
      assert.equal(await page.run<string>(`return window.vigileGraph.getElementById('task:${ids.payments}').parent().id()`), `task:${ids.checkout}`);
      assert.equal(await page.run<number>(`return window.vigileGraph.getElementById('task:${ids.refunds}').data('trouble')`), 1);
      await layout("in the expanded graph");

      await page.click("label:has(#hide-finished)");
      await page.until(`return window.vigileGraph.getElementById('task:${ids.card}').length === 0`, "finished tasks to go");
      assert.equal(await page.run<number>("return window.vigileGraph.nodes('[state = \"done\"], [state = \"cancelled\"]').length"), 0);
      await page.click("label:has(#hide-finished)");
      await page.click("label:has(#collapse-groups)");
      assert.deepEqual(page.errors, []);
    });

    it("never draws one item on top of another", async () => {
      for (const expand of [false, true]) {
        await load("/#graph");
        await graphReady();
        if (expand) {
          await page.click("label:has(#collapse-groups)");
          await page.until(`return window.vigileGraph.getElementById('task:${ids.card}').length === 1 && window.vigileGraph.scratch('settled')`, "the expanded graph", 20_000);
        }
        const overlaps = await page.run<string[]>(`
          const leaves = window.vigileGraph.nodes().filter((n) => !n.isParent());
          const found = [];
          for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
            const a = leaves[i].boundingBox({ includeLabels: false }), b = leaves[j].boundingBox({ includeLabels: false });
            if (Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > 1 && Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > 1) found.push(leaves[i].id() + " over " + leaves[j].id());
          }
          for (const leaf of leaves) for (const box of leaf.ancestors()) {
            const a = leaf.boundingBox({ includeLabels: false }), b = box.boundingBox({ includeLabels: false });
            if (a.x1 < b.x1 - 1 || a.x2 > b.x2 + 1 || a.y1 < b.y1 - 1 || a.y2 > b.y2 + 1) found.push(leaf.id() + " outside its box " + box.id());
          }
          return found.slice(0, 5);
        `);
        assert.deepEqual(overlaps, [], expand ? "expanded" : "collapsed");
        const covered = await page.run<string[]>(`
          const cy = window.vigileGraph;
          const names = cy.nodes(':parent[ref]').map((box) => ({ id: box.id(), at: box.boundingBox({ includeNodes: false, includeEdges: false, includeLabels: true, includeOverlays: false }) }));
          const items = cy.nodes('[ref]').filter((n) => !n.isParent()).map((n) => ({ id: n.id(), at: n.boundingBox({ includeLabels: false }) })).concat(names);
          const found = [];
          for (const name of names) for (const item of items) {
            if (item === name) continue;
            if (Math.min(name.at.x2, item.at.x2) - Math.max(name.at.x1, item.at.x1) > 1 && Math.min(name.at.y2, item.at.y2) - Math.max(name.at.y1, item.at.y1) > 1) found.push("the name of " + name.id + " and " + item.id);
          }
          return [names.length, ...found.slice(0, 5)];
        `);
        assert.deepEqual(covered, [expand ? 5 : 2], `no box's name is covered by a task or another name, ${expand ? "expanded" : "collapsed"}`);
        if (shots) {
          await page.size(1920, 1080);
          await page.wait(400);
          await page.run("document.getElementById('zoom-fit').click(); document.getElementById('graph-box').scrollIntoView()");
          await page.wait(300);
          await page.shot(join(shots, `whole-graph-${expand ? "expanded" : "collapsed"}.png`));
          await page.size(1280, 900);
        }
      }
    });

    it("opens a task, a group and a project when clicked", async () => {
      await load("/#graph");
      await graphReady();
      await page.run("document.getElementById('zoom-fit').click()");
      const launch = await nodeAt(`task:${ids.launch}`);
      await page.clickAt(launch.x, launch.y);
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Launch the checkout'", "the clicked task's panel");
      await page.key("Escape");
      const group = await nodeAt(`task:${ids.checkout}`);
      await page.clickAt(group.x, group.y);
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Checkout' && Boolean(document.querySelector('.open-group'))", "the group's panel");
      await page.click(".open-group");
      await page.until("return window.vigileGraph.nodes('[kind = \"task\"]').length === 2 && window.vigileGraph.scratch('settled')", "the graph of the group alone", 20_000);
      assert.deepEqual(await page.run<string[]>("return window.vigileGraph.nodes('[kind = \"task\"]').map((n) => n.data('ref')).sort()"), [ids.payments, ids.shipping].sort(), "inside the group, its two sub-groups");
      await page.click("#scope .tag-button");
      await page.until("return window.vigileGraph.nodes('[kind = \"project\"]').length === 2 && window.vigileGraph.scratch('settled')", "the whole graph again", 20_000);
      await page.run("document.getElementById('zoom-fit').click()");
      const project = await nodeAt("project:WEB", true);
      await page.clickAt(project.x, project.y);
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Website relaunch'", "the project's panel");
      await page.key("Escape");
    });

    it("stays where the person put it when a task is added somewhere, and is placed afresh when they had not moved it", async () => {
      await page.size(1280, 900);
      await load("/#graph");
      await graphReady();
      // A task that is drawn as a box of its own, whichever it is.
      const ref = await page.run<string>("return window.vigileGraph.nodes().filter((n) => !n.isParent() && n.data('kind') === 'task')[0].data('ref')");
      const node = `window.vigileGraph.nodes().filter((n) => n.data('ref') === ${JSON.stringify(ref)})`;
      const view = () => page.run<{ zoom: number; x: number; y: number; moved: boolean; nodes: number }>(`const g = window.vigileGraph; const at = ${node}.renderedPosition(); return { zoom: Math.round(g.zoom() * 100) / 100, x: Math.round(at.x), y: Math.round(at.y), moved: Boolean(g.scratch('moved')), nodes: g.nodes().length }`);
      const redrawn = async (nodes: number) => {
        await page.run("document.getElementById('refresh').click()");
        await page.until(`return window.vigileGraph.nodes().length === ${nodes} && window.vigileGraph.scratch('settled')`, "the graph to be drawn again with the new task", 20_000);
      };
      const made: string[] = [];
      try {
        // Left where it was placed, a new drawing is placed afresh.
        const placed = await view();
        assert.equal(placed.moved, false);
        made.push((await run("create_task", { title: "Added while the graph is open", description: "d", project: "WEB" })).id);
        await redrawn(placed.nodes + 1);
        assert.equal((await view()).moved, false);

        // The person zooms in on a task and puts it in the middle.
        await page.run(`const g = window.vigileGraph; g.zoom(1.6); g.center(${node}); g.scratch('moved', true);`);
        const before = await view();
        assert.equal(before.zoom, 1.6);
        made.push((await run("create_task", { title: "Added after the graph was moved", description: "d", project: "WEB" })).id);
        await redrawn(before.nodes + 1);
        const after = await view();
        assert.deepEqual([after.zoom, after.moved], [1.6, true], "the zoom is the person's own still");
        assert.ok(Math.abs(after.x - before.x) <= 2 && Math.abs(after.y - before.y) <= 2, `the task they were looking at is where it was: ${JSON.stringify(before)} then ${JSON.stringify(after)}`);

        // Two changes one upon the other, the second before the drawing for the first has found its place.
        made.push((await run("create_task", { title: "The first of two in a row", description: "d", project: "WEB" })).id);
        await page.run("document.getElementById('refresh').click()");
        made.push((await run("create_task", { title: "The second of two in a row", description: "d", project: "WEB" })).id);
        await redrawn(after.nodes + 2);
        const last = await view();
        assert.deepEqual([last.zoom, last.moved], [1.6, true], "the zoom outlives a drawing that never got to find its place");
        assert.ok(Math.abs(last.x - before.x) <= 2 && Math.abs(last.y - before.y) <= 2, `and so does the place: ${JSON.stringify(before)} then ${JSON.stringify(last)}`);

        // "Fit" is the person's choice as well: everything in view. In a window too small to read the whole graph
        // in, a drawing placed afresh would open at a readable size on one corner; with Fit chosen, a task added
        // somewhere leaves everything in view, the new task with it.
        await page.size(640, 480);
        await load("/#graph");
        await graphReady();
        const all = () =>
          page.run<{ inside: boolean; zoom: number; fitted: boolean; moved: boolean; nodes: number }>(
            "const g = window.vigileGraph; const b = g.elements().renderedBoundingBox(); return { inside: b.x1 >= -1 && b.y1 >= -1 && b.x2 <= g.width() + 1 && b.y2 <= g.height() + 1, zoom: g.zoom(), fitted: g.scratch('fitted') === true, moved: g.scratch('moved') === true, nodes: g.nodes().length }",
          );
        const opened = await all();
        assert.deepEqual([opened.inside, opened.fitted], [false, false], `placed afresh, the graph does not fit this window: zoom ${opened.zoom}`);
        await page.click("#zoom-fit");
        const fitted = await all();
        assert.deepEqual([fitted.inside, fitted.fitted, fitted.moved], [true, true, false]);
        made.push((await run("create_task", { title: "Added after Fit was chosen", description: "d", project: "WEB" })).id);
        await redrawn(fitted.nodes + 1);
        const still = await all();
        assert.deepEqual([still.inside, still.fitted], [true, true], `everything is in view still, the new task too: zoom ${still.zoom}`);
        // A move of the person's own ends it: from then on the view is where they put it.
        await page.click("#zoom-in");
        assert.deepEqual([(await all()).fitted, (await all()).moved], [false, true]);

        // Fit chosen while the layout of a new drawing is still under way: there is nothing to fit yet, and the
        // choice holds all the same when the layout has finished, in place of the view the drawing before had.
        let underWay = false;
        for (let attempt = 0; attempt < 5 && !underWay; attempt++) {
          await page.click("#zoom-in");
          made.push((await run("create_task", { title: `Added while Fit is chosen ${attempt}`, description: "d", project: "WEB" })).id);
          underWay = await page.run<boolean>(
            "const before = window.vigileGraph; document.getElementById('refresh').click(); await new Promise((done) => { const look = () => (window.vigileGraph !== before ? done() : setTimeout(look, 1)); look(); }); const underWay = window.vigileGraph.scratch('settled') !== true; document.getElementById('zoom-fit').click(); return underWay;",
          );
          await page.until("return window.vigileGraph.scratch('settled') === true", "the layout to finish", 20_000);
        }
        assert.equal(underWay, true, "Fit was chosen while a layout was under way");
        const chosen = await all();
        assert.deepEqual([chosen.inside, chosen.fitted, chosen.moved], [true, true, false], `everything is in view: zoom ${chosen.zoom}`);

        // A zoom button pressed while a layout is under way does what it would do once the drawing is there: the
        // view the person had is put back first, and then it is made larger around the middle of the box, so a
        // task that was to the side of the middle moves outwards by as much.
        await page.size(1280, 900);
        await load("/#graph");
        await graphReady();
        const count = await page.run<number>("return window.vigileGraph.nodes().length");
        await page.run(`const g = window.vigileGraph; g.zoom(1); g.center(${node}); g.panBy({ x: 80, y: 40 }); g.scratch('moved', true); g.scratch('fitted', false);`);
        const aside = await view();
        let pressed = false;
        for (let attempt = 0; attempt < 5 && !pressed; attempt++) {
          if (attempt) await page.run(`const g = window.vigileGraph; g.zoom(1); g.center(${node}); g.panBy({ x: 80, y: 40 }); g.scratch('moved', true);`);
          made.push((await run("create_task", { title: `Added while zooming ${attempt}`, description: "d", project: "WEB" })).id);
          pressed = await page.run<boolean>(
            "const before = window.vigileGraph; document.getElementById('refresh').click(); await new Promise((done) => { const look = () => (window.vigileGraph !== before ? done() : setTimeout(look, 1)); look(); }); const underWay = window.vigileGraph.scratch('settled') !== true; if (underWay) document.getElementById('zoom-in').click(); return underWay;",
          );
          await page.until("return window.vigileGraph.scratch('settled') === true", "the layout to finish", 20_000);
        }
        assert.equal(pressed, true, "the button was pressed while a layout was under way");
        assert.ok(count > 0);
        const larger = await view();
        const middle = await page.run<{ x: number; y: number }>("const g = window.vigileGraph; return { x: g.width() / 2, y: g.height() / 2 }");
        assert.deepEqual([larger.zoom, larger.moved], [1.25, true]);
        const expected = { x: middle.x + (aside.x - middle.x) * 1.25, y: middle.y + (aside.y - middle.y) * 1.25 };
        assert.ok(Math.abs(larger.x - expected.x) <= 3 && Math.abs(larger.y - expected.y) <= 3, `the task moved outwards from the middle: was ${JSON.stringify(aside)}, is ${JSON.stringify(larger)}, expected ${JSON.stringify(expected)}`);

        // At the largest the graph allows, a press on + does nothing and a press on − after it makes it smaller:
        // the same two presses while a layout is under way end the same way, not where the graph was.
        const largest = await page.run<number>("const g = window.vigileGraph; g.zoom(g.maxZoom()); g.scratch('moved', true); return g.zoom()");
        await page.click("#zoom-in");
        await page.click("#zoom-out");
        const settled = await page.run<number>("return window.vigileGraph.zoom()");
        assert.ok(Math.abs(settled - largest * 0.8) < 0.01, `on a drawing that is there: ${largest} then ${settled}`);
        let both = false;
        for (let attempt = 0; attempt < 5 && !both; attempt++) {
          await page.run("const g = window.vigileGraph; g.zoom(g.maxZoom()); g.scratch('moved', true);");
          made.push((await run("create_task", { title: `Added at the limit ${attempt}`, description: "d", project: "WEB" })).id);
          both = await page.run<boolean>(
            "const before = window.vigileGraph; document.getElementById('refresh').click(); await new Promise((done) => { const look = () => (window.vigileGraph !== before ? done() : setTimeout(look, 1)); look(); }); const underWay = window.vigileGraph.scratch('settled') !== true; if (underWay) { document.getElementById('zoom-in').click(); document.getElementById('zoom-out').click(); } return underWay;",
          );
          await page.until("return window.vigileGraph.scratch('settled') === true", "the layout to finish", 20_000);
        }
        assert.equal(both, true, "both buttons were pressed while a layout was under way");
        const after2 = await page.run<number>("return window.vigileGraph.zoom()");
        assert.ok(Math.abs(after2 - largest * 0.8) < 0.01, `during a layout the two presses end where they do on a drawing that is there: ${largest} then ${after2}`);
      } finally {
        await page.size(1280, 900);
        for (const id of made) await run("delete", { id, version: (await run("get", { id })).version });
        await load();
      }
    });

    it("zooms with the buttons and the wheel, pans by dragging, and fits on request", async () => {
      await page.size(1280, 600);
      await load("/#graph");
      await graphReady();
      const zoom = () => page.run<number>("return window.vigileGraph.zoom()");
      const pan = () => page.run<{ x: number; y: number }>("return window.vigileGraph.pan()");
      const start = await zoom();
      await page.click("#zoom-in");
      assert.ok((await zoom()) > start);
      await page.click("#zoom-out");
      await page.click("#zoom-out");
      assert.ok((await zoom()) < start);
      const box = await page.box("#graph-box");
      const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const beforeWheel = await zoom();
      const pageY = await page.run<number>("return scrollY");
      // Right after the page has scrolled, the graph leaves the wheel to the page for a moment, as it should.
      await page.wait(500);
      await page.wheelUntil(middle.x, middle.y, -300, 0, `return window.vigileGraph.zoom() !== ${beforeWheel}`, "the wheel to zoom");
      assert.equal(await page.run<number>("return scrollY"), pageY, "the wheel over the graph zooms it and leaves the page where it is");
      const beforeDrag = await pan();
      await page.drag({ x: box.x + 20, y: box.y + box.height - 20 }, { x: box.x + 140, y: box.y + box.height - 90 });
      const afterDrag = await pan();
      assert.ok(Math.abs(afterDrag.x - beforeDrag.x) > 50 && Math.abs(afterDrag.y - beforeDrag.y) > 30, "dragging the background moves the graph");
      // Zoomed in, the window is covered by boxes and tasks: dragging has to work from on top of them too.
      await page.run(`const cy = window.vigileGraph; cy.zoom(1.6); cy.center(cy.getElementById('task:${ids.long}'))`);
      const covered = await page.run<number>("const cy = window.vigileGraph; const e = cy.extent(); const b = cy.nodes(':parent').boundingBox(); return Math.round(100 * (Math.min(e.x2, b.x2) - Math.max(e.x1, b.x1)) * (Math.min(e.y2, b.y2) - Math.max(e.y1, b.y1)) / (e.w * e.h))");
      assert.ok(covered > 60, `zoomed in, most of what is in sight is boxes and tasks: ${covered}%`);
      const spot = await nodeAt(`task:${ids.long}`);
      const grabbed = { ...spot, id: ids.long! };
      const beforeGrab = await pan();
      await page.drag(grabbed, { x: grabbed.x + 150, y: grabbed.y + 90 });
      const afterGrab = await pan();
      const grabMoved = [Math.round(afterGrab.x - beforeGrab.x), Math.round(afterGrab.y - beforeGrab.y)];
      assert.ok(Math.abs(grabMoved[0]! - 150) <= 6 && Math.abs(grabMoved[1]! - 90) <= 6, `dragging from on top of a task moves the graph with the pointer: moved ${grabMoved}`);
      assert.equal(await panelOpen(), false, "a drag is not a click");
      await page.clickAt(grabbed.x + 150, grabbed.y + 90);
      await page.until("return !document.getElementById('panel').hidden", "a click on the same task to open it");
      assert.equal(await text(".detail-head .id"), grabbed.id);
      await page.key("Escape");
      await page.click("#zoom-fit");
      const fitted = await page.run<{ inside: boolean; seen: string }>(
        "const cy = window.vigileGraph; const b = cy.elements().renderedBoundingBox(); return { inside: b.x1 >= 0 && b.y1 >= 0 && b.x2 <= cy.width() && b.y2 <= cy.height(), seen: JSON.stringify([b, cy.width(), cy.height(), cy.zoom()]) }",
      );
      assert.equal(fitted.inside, true, `after Fit the whole graph is inside the box: ${fitted.seen}`);
      await page.run("scrollTo(0, 1e6)");
      await page.wait(500);
      const low = await page.run<number>("return scrollY");
      assert.ok(low > 0, "the page is taller than the window");
      await page.wheelUntil(middle.x, 20, -300, 0, `return scrollY < ${low}`, "the wheel outside the graph to scroll the page");
      await page.size(1280, 900);
    });

    it("fills the room left in the window, keeps a small graph in the middle, and stays there when the window changes", async () => {
      await page.size(2560, 1300);
      await load("/#graph");
      await graphReady();
      await page.click(".project-main", 1);
      await page.until("return window.vigileGraph.nodes().length === 2 && window.vigileGraph.scratch('settled')", "the graph of the small project", 20_000);
      /** How far the drawing's middle is from the middle of its box, and the box's size. */
      const placed = () => page.run<{ dx: number; dy: number; width: number; height: number; zoom: number }>(
        "const cy = window.vigileGraph; const b = cy.elements().renderedBoundingBox(); const box = document.getElementById('graph-box'); return { dx: Math.round((b.x1 + b.x2) / 2 - box.clientWidth / 2), dy: Math.round((b.y1 + b.y2) / 2 - box.clientHeight / 2), width: box.clientWidth, height: box.clientHeight, zoom: cy.zoom() }",
      );
      /** Where the box ends against the window, and whether the page has anything to scroll. */
      const room = () => page.run<{ gap: number; scrolls: boolean }>("const b = document.getElementById('graph-box').getBoundingClientRect(); return { gap: Math.round(innerHeight - b.bottom), scrolls: document.documentElement.scrollHeight > innerHeight }");
      const wide = await placed();
      assert.deepEqual([wide.dx, wide.dy, wide.zoom], [0, 0, 1], "a small graph is drawn at its natural size in the middle of the box");
      const end = await room();
      assert.ok(Math.abs(end.gap - 12) <= 1 && !end.scrolls, `the box reaches the bottom of the window, whatever the graph's size: ${JSON.stringify(end)}`);
      assert.ok(wide.height > 800, `the box uses the room there is: ${wide.height}px`);
      await layout("in a small graph on a very wide window");
      for (const [width, height] of [[1280, 800], [1600, 1000]] as const) {
        await page.size(width, height);
        await page.until("const b = document.getElementById('graph-box').getBoundingClientRect(); return Math.abs(innerHeight - b.bottom - 12) <= 1.5 && Math.abs(window.vigileGraph.height() - document.getElementById('graph-box').clientHeight) < 2", `the box to reach the bottom of a ${width}x${height} window`);
        assert.equal((await room()).scrolls, false);
      }
      // In a window too short to leave it room, the box keeps a usable height and the page scrolls the rest.
      await page.size(1000, 560);
      await page.until("return document.getElementById('graph-box').getBoundingClientRect().height === 360", "the box to keep its smallest height in a short window");
      assert.equal((await room()).scrolls, true);
      await page.size(2560, 1300);
      for (const width of [1500, 3440, 1920]) {
        await page.size(width, 1300);
        await page.until(`const box = document.getElementById('graph-box'); const cy = window.vigileGraph; const b = cy.elements().renderedBoundingBox(); return Math.abs(cy.width() - box.clientWidth) < 2 && Math.abs((b.x1 + b.x2) / 2 - box.clientWidth / 2) < 2`, `the graph to be in the middle again at ${width}px`);
        await layout(`in a small graph after resizing to ${width}px`);
      }
      // Once the person has moved the graph, resizing the window leaves it where they put it.
      const box = await page.box("#graph-box");
      await page.wait(500);
      await page.drag({ x: box.x + 30, y: box.y + 30 }, { x: box.x + 330, y: box.y + 60 });
      const moved = await placed();
      assert.ok(moved.dx > 200, "dragging moved the graph");
      await page.size(1700, 1300);
      await page.wait(600);
      assert.ok((await placed()).dx > 100, "the graph was not put back in the middle");
      await page.click("#zoom-fit");
      assert.equal((await placed()).dx, 0, "Fit puts it back");
      await page.click(".project-main", 1);
      await page.size(1280, 900);
    });

    it("follows the window as it is resized, and survives switching views back and forth", async () => {
      await page.size(1600, 900);
      await load("/#graph");
      await graphReady();
      for (const width of [1600, 1200, 900, 700, 500, 360, 800, 1400]) {
        await page.size(width, 900);
        await page.until("const cy = window.vigileGraph; return Math.abs(cy.width() - document.getElementById('graph-box').clientWidth) < 2", `the graph to take the box's width at ${width}px`);
        await layout(`in the graph after resizing to ${width}px`);
      }
      for (let round = 0; round < 4; round++) {
        await page.click("#view-board");
        await page.until("return document.getElementById('board').getBoundingClientRect().height > 0", "the board");
        await layout("on the board after leaving the graph");
        await page.click("#view-graph");
        await page.until("return document.getElementById('graph-box').getBoundingClientRect().height > 0 && window.vigileGraph.nodes().length > 0", "the graph");
        await layout("in the graph after coming back");
      }
      assert.equal(await count("#graph-box canvas"), 3, "the graph is not drawn twice");
      assert.deepEqual(page.errors, []);
    });

    it("follows the project selection and the filter, and says when there is nothing to draw", async () => {
      await page.size(1280, 900);
      await load("/#graph");
      await graphReady();
      await page.click(".project-main", 1);
      await page.until("return window.vigileGraph.nodes().length === 2", "the graph of one project");
      assert.deepEqual(await page.run<string[]>("return window.vigileGraph.nodes().map((n) => n.id()).sort()"), ["project:LONGNAME", `task:${ids.elsewhere}`]);
      await page.click(".project-main", 1);
      await page.click("#filter");
      await page.type("zzz nothing");
      assert.equal(await text("#empty"), 'No task matches "zzz nothing".');
      assert.equal(await page.run<number>("return Math.round(document.getElementById('graph-panel').getBoundingClientRect().height)"), 0);
      await page.run("document.getElementById('filter').select()");
      await page.type("Finished thing");
      await page.until("return window.vigileGraph.nodes('[kind = \"task\"]').length === 20", "the graph of finished things");
      await page.click("label:has(#hide-finished)");
      await page.until("return !document.getElementById('graph-note').hidden", "the note");
      assert.match(await text("#graph-note"), /Every task here is finished/);
      await layout("with every task hidden");
      await page.click("label:has(#hide-finished)");
      await page.until("return document.getElementById('graph-note').hidden && document.getElementById('graph-box').getBoundingClientRect().height > 0", "the graph to come back");
    });

    it("explains every colour it uses in the legend", async () => {
      await load("/#graph");
      await graphReady();
      await page.click("label:has(#collapse-groups)");
      await page.until(`return window.vigileGraph.getElementById('task:${ids.card}').length === 1 && window.vigileGraph.scratch('settled')`, "the expanded graph", 20_000);
      const seen = await page.run<Array<{ state: string; drawn: string[]; legend: string[] | null; label: string }>>(`
        const cy = window.vigileGraph;
        const states = [...new Set(cy.nodes('[kind = "task"]').map((n) => n.data('state')))].sort();
        return states.map((state) => {
          const node = cy.nodes('[kind = "task"][state = "' + state + '"][trouble = 0][problem = 0]').filter((n) => !n.isParent()).first();
          const entry = document.querySelector('#legend li[data-state="' + state + '"]');
          const swatch = entry && getComputedStyle(entry.querySelector('.swatch'));
          const plain = (colour) => colour.replaceAll(" ", "");
          return { state, drawn: [plain(node.style('border-color')), plain(node.style('background-color')), node.style('border-style')], legend: swatch && [plain(swatch.borderTopColor), plain(swatch.backgroundColor), swatch.borderTopStyle], label: entry ? entry.textContent : "" };
        });
      `);
      assert.deepEqual(seen.map((s) => s.state), ["cancelled", "done", "draft", "in_progress", "in_review", "next", "paused", "waiting"], "the test data has a task in every state");
      for (const entry of seen) {
        assert.ok(entry.label.length > 3, `the legend names ${entry.state}`);
        assert.deepEqual(entry.legend, entry.drawn, `the legend shows ${entry.state} as the graph draws it`);
      }
      assert.match(await text("#legend"), /bug, issue or incident.*has a problem.*must finish first.*already finished.*also contains/s);
      await layout("in the graph with its legend");
      await page.size(360, 780, true);
      await layout("in the graph with its legend on a phone");
      await page.size(1280, 900);
      await page.click("label:has(#collapse-groups)");
    });

    it("can be dragged with a finger on a phone", async () => {
      await page.size(390, 844, true);
      await load("/#graph");
      await graphReady();
      const box = await page.box("#graph-box");
      await page.wait(500);
      // Once from empty background and once from on top of a task: the graph follows the finger both times.
      const spots = await page.run<Array<{ x: number; y: number }>>(`
        const cy = window.vigileGraph; const at = cy.container().getBoundingClientRect();
        const node = cy.nodes('[kind = "task"]').filter((n) => { const r = n.renderedBoundingBox({ includeLabels: false }); return !n.isParent() && r.x1 > 130 && r.y1 > 100 && r.x2 < cy.width() && r.y2 < cy.height(); }).first();
        const r = node.renderedBoundingBox({ includeLabels: false });
        return [{ x: at.left + (r.x1 + r.x2) / 2, y: at.top + (r.y1 + r.y2) / 2 }, { x: at.left + at.width - 12, y: at.top + at.height - 12 }];
      `);
      assert.ok(box.width > 300 && spots.length === 2);
      for (const [index, from] of spots.entries()) {
        const before = await page.run<{ x: number; y: number }>("return window.vigileGraph.pan()");
        await page.swipe(from, { x: from.x - 120, y: from.y - 80 });
        const after = await page.run<{ x: number; y: number }>("return window.vigileGraph.pan()");
        const moved = [Math.round(after.x - before.x), Math.round(after.y - before.y)];
        assert.ok(Math.abs(moved[0]! + 120) <= 14 && Math.abs(moved[1]! + 80) <= 14, `the graph follows the finger from ${index === 0 ? "a task" : "the background"}: moved ${moved}`);
        assert.equal(await panelOpen(), false, "a drag is not a tap");
        await page.wait(400);
      }
      await page.size(1280, 900);
    });

    it("routes its arrows around boxes, their names and the tasks they do not belong to", async () => {
      // The plan of the README's pictures: three groups that a launch waits for. Drawn straight, the arrow from
      // one group ran across the name of another.
      const planDirectory = mkdtempSync(join(tmpdir(), "vigile-browser-plan-"));
      const planConfig = join(planDirectory, "config.toml");
      initConfig(planConfig, { name: "plan", port: await freePort() });
      const plan = await startService({ loaded: loadConfig(planConfig, {}), log: () => {}, warn: () => {} });
      try {
        await seedDemoPlan(plan.engine);

        /** Runs in the page: the number of arrows, then every arrow that runs across a name or a task that is not one of its ends. */
        const CROSSINGS = `
            const cy = window.vigileGraph;
            const cuts = (a, b, r) => {
              // Whether the line from a to b passes through the rectangle r.
              let t0 = 0, t1 = 1; const dx = b.x - a.x, dy = b.y - a.y;
              for (const [p, q] of [[-dx, a.x - r.x1], [dx, r.x2 - a.x], [-dy, a.y - r.y1], [dy, r.y2 - a.y]]) {
                if (p === 0) { if (q < 0) return false; continue; }
                const t = q / p;
                if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
              }
              return t1 - t0 > 0.001;
            };
            const shrink = (r, by) => ({ x1: r.x1 + by, y1: r.y1 + by, x2: r.x2 - by, y2: r.y2 - by });
            const names = cy.nodes(':parent[ref]').map((box) => ({ what: "the name of " + box.id(), box, at: shrink(box.boundingBox({ includeNodes: false, includeEdges: false, includeLabels: true, includeOverlays: false }), 1) }));
            const tasks = cy.nodes('[ref]').filter((n) => !n.isParent()).map((n) => ({ what: n.id(), box: n, at: shrink(n.boundingBox({ includeLabels: false }), 1) }));
            const found = [];
            for (const edge of cy.edges()) {
              const between = edge.segmentPoints() ?? edge.controlPoints() ?? [];
              const path = [edge.sourceEndpoint(), ...between, edge.targetEndpoint()];
              const ends = edge.connectedNodes();
              for (const item of [...names, ...tasks]) {
                // An arrow touches its own two ends, and whatever is inside them.
                if (ends.some((end) => end.same(item.box) || item.box.ancestors().contains(end))) continue;
                for (let i = 1; i < path.length; i++) if (cuts(path[i - 1], path[i], item.at)) { found.push(edge.source().id() + " -> " + edge.target().id() + " runs across " + item.what); break; }
              }
            }
            return [cy.edges().length, ...found];
          `;
        for (const [width, collapsed] of [[1520, false], [1520, true], [900, false], [390, false]] as const) {
          await page.size(width, 900, width < 640);
          await page.open("about:blank");
          await page.open(`${plan.urls.base}/#graph`);
          await graphReady();
          if (!collapsed) {
            await page.click("label:has(#collapse-groups)");
            await page.until("return window.vigileGraph.nodes('[kind = \"task\"]').length === 17 && window.vigileGraph.scratch('settled')", "the groups to open", 20_000);
          }
          const crossings = await page.run<string[]>(CROSSINGS);
          assert.deepEqual(crossings, [collapsed ? 4 : 9], `no arrow runs across a name or a task at ${width}px, ${collapsed ? "collapsed" : "opened"}`);
          await layout(`in a graph with routed arrows at ${width}px ${collapsed ? "collapsed" : "opened"}`);
          if (width === 1520 && !collapsed) {
            // The routes are kept when the graph is only coloured again, as it is when the system goes dark.
            const routed = () => page.run<number>("return window.vigileGraph.edges().filter((e) => e.style('curve-style') === 'round-segments').length");
            const before = await routed();
            assert.ok(before >= 3, `some arrows go round corners: ${before}`);
            const colour = await page.run<string>("return window.vigileGraph.nodes('[kind = \"task\"]').first().style('background-color')");
            await page.scheme("dark");
            await page.until(`return window.vigileGraph.nodes('[kind = "task"]').first().style('background-color') !== ${JSON.stringify(colour)}`, "the graph to change colours");
            assert.equal(await routed(), before);
            assert.deepEqual(await page.run<string[]>(CROSSINGS), [9]);
            await page.scheme("light");
          }
        }
        assert.deepEqual(page.errors, []);
      } finally {
        await plan.stop();
        rmSync(planDirectory, { recursive: true, force: true });
        await page.size(1280, 900);
      }
    });

    it("takes its colours from light and dark mode", async () => {
      await load("/#graph");
      await graphReady();
      const colour = () => page.run<string>(`return window.vigileGraph.getElementById('task:${ids.launch}').style('background-color')`);
      const light = await colour();
      await page.scheme("dark");
      await page.until(`return window.vigileGraph.getElementById('task:${ids.launch}').style('background-color') !== ${JSON.stringify(light)}`, "the graph to change colours");
      assert.notEqual(await colour(), light);
      await layout("in the graph in dark mode");
      await page.scheme("light");
    });

    it("says what to do when the service cannot serve the graph library, and recovers", async () => {
      await page.block(["*/vendor/*"]);
      try {
        await load("/#graph");
        await page.until("return !document.getElementById('graph-note').hidden", "the note");
        assert.match(await text("#graph-note"), /did not serve the graph library.*restart the service, then reload this page/);
        await layout("when the graph cannot be drawn");
        await page.click("#view-board");
        await page.until("return document.querySelectorAll('.card').length > 0 && document.getElementById('board').getBoundingClientRect().height > 0", "the board, which still works");
      } finally {
        await page.block([]);
      }
      await page.click("#view-graph");
      await graphReady();
      assert.equal(await page.run<boolean>("return document.getElementById('graph-note').hidden"), true);
    });

    it("says what to do when the service cannot serve the worker that lays the graph out, and recovers", async () => {
      await load();
      // The libraries are there, and the worker they hand the layout to is not: as on a service that was not
      // restarted after an update. No answer would ever come, and the page must not wait for one.
      await page.run("window.RealWorker = window.Worker; window.Worker = class extends window.RealWorker { constructor() { super('/vendor/elk-worker-of-another-version.js'); } };");
      await page.click("#view-graph");
      await page.until("return !document.getElementById('graph-note').hidden", "the note");
      assert.match(await text("#graph-note"), /^The graph could not be drawn: the service did not serve the graph library \(\/vendor\/elk-worker\.min\.js\).*restart the service, then reload this page$/);
      assert.equal(await page.run<boolean>("return window.vigileGraph === undefined && document.getElementById('graph-box').hidden"), true, "no drawing is left without its places");
      await layout("when the graph cannot be laid out");
      // The next time the graph is drawn, it is tried again.
      await page.run("window.Worker = window.RealWorker");
      await page.click("#view-board");
      await page.click("#view-graph");
      await graphReady();
      assert.equal(await page.run<boolean>("return document.getElementById('graph-note').hidden && !document.getElementById('graph-box').hidden"), true);
    });

    it("keeps the drawing in sight until the next one has its places, so the graph does not blink at every change", async () => {
      await page.size(1280, 900);
      await load();
      // Each layout is held back here until the test lets it go, so that the time it takes can be looked at.
      await page.run("window.RealWorker = window.Worker; window.held = []; window.Worker = class extends window.RealWorker { postMessage(message) { if (message.cmd === 'layout') window.held.push(() => super.postMessage(message)); else super.postMessage(message); } };");
      const letGo = () => page.run("window.held.pop()(); window.held.length = 0;");
      const asked = (layouts: number) => page.until(`return window.held.length === ${layouts}`, `${layouts} layouts to have been asked for`);
      /** What is in the graph's box: how many drawings, and whether the one the test remembers is still among them. */
      const box = () =>
        page.run<{ drawings: number; canvases: number; remembered: string; settled: boolean }>(
          "const g = window.remembered; return { drawings: document.querySelectorAll('#graph-box > div').length, canvases: document.querySelectorAll('#graph-box canvas').length, remembered: g.destroyed() ? 'gone' : g === window.vigileGraph ? 'the drawing' : g.container().isConnected && g.container().getBoundingClientRect().height > 0 ? 'in sight under the drawing' : 'out of sight', settled: window.vigileGraph.scratch('settled') === true }",
        );
      const made: string[] = [];
      try {
        await page.click("#view-graph");
        await asked(1);
        await letGo();
        await graphReady();
        await page.run("window.remembered = window.vigileGraph");
        assert.deepEqual(await box(), { drawings: 1, canvases: 3, remembered: "the drawing", settled: true });

        // A task is added. Until the new drawing has its places, the one that was there is what is seen.
        made.push((await run("create_task", { title: "Added while the graph is looked at", description: "d", project: "WEB" })).id);
        await page.run("document.getElementById('refresh').click()");
        await asked(1);
        assert.deepEqual(await box(), { drawings: 2, canvases: 6, remembered: "in sight under the drawing", settled: false });
        // Another, before the first of the two new drawings got anywhere: that one is dropped, not the one in sight.
        made.push((await run("create_task", { title: "And one more", description: "d", project: "WEB" })).id);
        await page.run("document.getElementById('refresh').click()");
        await asked(2);
        assert.deepEqual(await box(), { drawings: 2, canvases: 6, remembered: "in sight under the drawing", settled: false });

        // The layout arrives: the new drawing is the only one.
        await letGo();
        await page.until("return window.vigileGraph.scratch('settled') === true", "the new drawing to have its places", 20_000);
        assert.deepEqual(await box(), { drawings: 1, canvases: 3, remembered: "gone", settled: true });
        assert.equal(await page.run<number>(`return window.vigileGraph.nodes('[ref = "${made[1]}"]').length`), 1);
        assert.deepEqual(page.errors, []);
      } finally {
        await page.run("window.Worker = window.RealWorker");
        for (const id of made) await run("delete", { id, version: (await run("get", { id })).version });
        await load();
      }
    });

    it("does not lay the graph out again when the service lists the same links, projects and tasks in another order", async () => {
      await page.size(1280, 900);
      const undo: Array<() => Promise<unknown>> = [];
      const item = (id: string) => `window.vigileGraph.getElementById('task:${id}')`;
      const numbered = () => page.run<number>("return window.vigileGraph.scratch('drawing')");
      /** Changes a title and waits for it in the graph, which is when the page has read the plan again. */
      const reread = async (id: string, title: string) => {
        const { version } = await run("get", { id });
        await run("update_task", { id, version, title });
        await page.run("document.getElementById('refresh').click()");
        await page.until(`return ${item(id)}.length === 1 && ${item(id)}.style('label').endsWith(${JSON.stringify(title)})`, "the new title in the graph");
      };
      try {
        // A task that is in two projects, neither of them the one its ID names, and so is drawn in one of the two.
        const { id: moved } = await run("create_task", { title: "In two other projects", description: "d", project: "WEB" });
        undo.push(async () => run("delete", { id: moved, version: (await run("get", { id: moved })).version }));
        for (const project of ["LONGNAME", "EMPTY"]) await run("add_link", { from: project, type: "contains", to: moved });
        await run("remove_link", { from: "WEB", type: "contains", to: moved });
        undo.push(async () => {
          await run("add_link", { from: "WEB", type: "contains", to: moved });
          for (const project of ["LONGNAME", "EMPTY"]) await run("remove_link", { from: project, type: "contains", to: moved });
        });
        // The order in which the service lists a task's links is that of the task's summary, which is what the
        // page draws from: the links of `get` are in the order of their IDs whatever was linked first.
        const listed = async (id: string) => (await run("get", { id })) as { contained_in: string[]; depends_on: string[] };
        assert.deepEqual((await listed(moved)).contained_in, ["EMPTY", "LONGNAME"]);
        await load("/#graph");
        await graphReady();
        const first = await numbered();
        const home = await page.run<string>(`return ${item(moved)}.parent().id()`);

        // Removing and adding links in another order leaves the service's deterministic ID order unchanged.
        await run("remove_link", { from: "LONGNAME", type: "contains", to: moved });
        await run("add_link", { from: "LONGNAME", type: "contains", to: moved });
        assert.deepEqual((await listed(moved)).contained_in, ["EMPTY", "LONGNAME"]);
        const waited = (await listed(ids.many!)).depends_on;
        await run("remove_link", { from: ids.many, type: "depends on", to: waited[0] });
        await run("add_link", { from: ids.many, type: "depends on", to: waited[0] });
        assert.deepEqual((await listed(ids.many!)).depends_on, waited);
        // The plan is the same, and so is the drawing: not another one, and the task in the box it was in.
        await reread(moved, "In two other projects, listed the other way round");
        assert.deepEqual([await numbered(), await page.run<string>(`return ${item(moved)}.parent().id()`)], [first, home]);
        assert.equal(await page.run<boolean>("return window.vigileGraph.scratch('settled') === true"), true);

        // The same with every list the page reads turned round, tasks and projects too.
        await page.run("window.turned = 0; window.realFetch = window.fetch; window.fetch = async (...asked) => { const response = await window.realFetch(...asked); if (!/\\/api\\/list-(tasks|projects)$/.test(String(asked[0]))) return response; const body = await response.json(); for (const list of ['tasks', 'projects']) if (Array.isArray(body[list])) { body[list].reverse(); window.turned++; } return new Response(JSON.stringify(body), { status: response.status, headers: response.headers }); };");
        await reread(moved, "In two other projects, in lists that are turned round");
        assert.ok((await page.run<number>("return window.turned")) > 0);
        assert.deepEqual([await numbered(), await page.run<string>(`return ${item(moved)}.parent().id()`)], [first, home]);
        assert.deepEqual(page.errors, []);
      } finally {
        await page.run("if (window.realFetch) window.fetch = window.realFetch");
        for (const step of undo.reverse()) await step().catch(() => {});
        await load();
      }
    });

    it("works its layout out in a worker of the page's own, the only kind the page's policy lets start", async () => {
      await load("/#graph");
      await graphReady();
      // The layout came from a worker, started from a file the service serves under the page's own policy.
      assert.deepEqual(await page.run<string[]>("return performance.getEntriesByType('resource').map((entry) => new URL(entry.name).pathname).filter((path) => path.startsWith('/vendor/elk'))"), ["/vendor/elk-api.js", "/vendor/elk-worker.min.js"]);
      const policy = (await fetch(`${base}/vendor/elk-worker.min.js`)).headers.get("content-security-policy") ?? "";
      assert.equal(/(?:^|; )worker-src ([^;]*)/.exec(policy)?.[1], "'self'");
      assert.equal(/unsafe-inline|unsafe-eval/.test(policy), false, "nothing written into the worker may run either");
      // A worker made from text the page holds, as a script that got into the page would make one, is refused.
      for (const kind of ["blob", "data"]) {
        const refused = await page.run<string>(`
          const seen = new Promise((done) => document.addEventListener("securitypolicyviolation", (event) => done(event.violatedDirective + " " + event.blockedURI.slice(0, 4)), { once: true }));
          const address = ${JSON.stringify(kind)} === "blob" ? URL.createObjectURL(new Blob(["postMessage(1)"], { type: "text/javascript" })) : "data:text/javascript,postMessage(1)";
          let worker;
          try { worker = new Worker(address); } catch (error) { return "refused: " + error.name; }
          const ran = new Promise((done) => (worker.onmessage = () => done("it ran")));
          return Promise.race([seen, ran, new Promise((done) => setTimeout(() => done("nothing happened"), 3000))]);
        `);
        assert.match(refused, new RegExp(`^(worker-src ${kind}|refused: SecurityError)$`), `a worker from a ${kind} address`);
      }
    });
  });

  browserSuite("themes", () => {
    const THEMES = ["vigile", "dado", "jeev", "gito"] as const;
    /** Runs in the page: the theme's colours as the page uses them, and how well text can be read on them. */
    const COLOURS = `
      const style = getComputedStyle(document.documentElement);
      const read = (name) => style.getPropertyValue("--" + name).trim();
      const light = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const contrast = (a, b) => { const [hi, lo] = [light(read(a)), light(read(b))].sort((x, y) => y - x); return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100; };
      const pairs = [["text", "surface"], ["text", "bg"], ["text", "raised"], ["muted", "surface"], ["muted", "bg"], ["muted", "raised"], ["go", "go-soft"], ["wait", "wait-soft"], ["stop", "stop-soft"], ["busy", "busy-soft"], ["review", "review-soft"], ["bug", "bug-soft"]];
      return {
        theme: document.documentElement.dataset.theme,
        page: getComputedStyle(document.body).backgroundColor,
        font: getComputedStyle(document.body).fontFamily.split(",")[0].replaceAll('"', ""),
        corner: getComputedStyle(document.querySelector(".card")).borderRadius,
        colours: ["bg", "surface", "text", "busy", "go", "review", "bug"].map(read).join(" "),
        hardToRead: pairs.map(([a, b]) => [a + " on " + b, contrast(a, b)]).filter(([, ratio]) => ratio < 4.5),
        pressed: [...document.querySelectorAll("#themes button")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.themeChoice),
      };
    `;
    type Seen = { theme: string; page: string; font: string; corner: string; colours: string; hardToRead: Array<[string, number]>; pressed: string[] };

    it("switches between four themes on the fly, each with its own colours, font and corners, in light and in dark", async () => {
      await page.size(1280, 900);
      await load();
      await page.run("localStorage.removeItem('vigile.theme')");
      await load();
      assert.deepEqual(await page.run("return [...document.querySelectorAll('#themes button')].map((b) => [b.dataset.themeChoice, b.title])"), [
        ["vigile", "Theme: Vigile"],
        ["dado", "Theme: Dado"],
        ["jeev", "Theme: Jeev"],
        ["gito", "Theme: Gito"],
      ]);
      const seen: Record<string, Seen> = {};
      const loaded = page.requests.length;
      // The menu stays open while themes are tried, so its own layout is checked in each of them.
      await openSettings();
      for (const scheme of ["light", "dark"] as const) {
        await page.scheme(scheme);
        for (const theme of THEMES) {
          await page.click(`#themes [data-theme-choice="${theme}"]`);
          const now = (seen[`${theme} ${scheme}`] = await page.run<Seen>(COLOURS));
          assert.deepEqual([now.theme, now.pressed], [theme, [theme]], "the theme is on, and its button says so");
          assert.deepEqual(now.hardToRead, [], `text can be read on its background in ${theme}, ${scheme}`);
          await layout(`on the board with the settings open in the ${theme} theme, ${scheme}`);
        }
      }
      assert.equal(page.requests.length, loaded, "switching themes loads nothing: it happens on the spot");
      assert.equal(new Set(Object.values(seen).map((s) => s.colours)).size, 8, "four themes, each different in light and in dark");
      assert.deepEqual(THEMES.map((theme) => seen[`${theme} light`]!.corner), ["10px", "3px", "3px", "6px"], "each theme has its own corners");
      assert.deepEqual(THEMES.map((theme) => seen[`${theme} light`]!.font), ["Inter", "Segoe UI", "Atlassian Sans", "-apple-system"]);
      // The colours the three are named after: Azure DevOps' blue, Jira's blue and navy text, GitHub's blue and green.
      assert.match(seen["dado light"]!.colours, /#f8f8f8 #ffffff #1b1a19 #005a9e/);
      assert.match(seen["jeev light"]!.colours, /#ffffff #ffffff #172b4d #0c66e4/);
      assert.match(seen["gito light"]!.colours, /#ffffff #ffffff #1f2328 #0969da #1a7f37/);
      assert.match(seen["gito dark"]!.colours, /#0d1117 #151b23 #f0f6fc #4493f8/);
      await page.scheme("light");

      // The choice is remembered, and is already there when the page is first drawn.
      await page.click('#themes [data-theme-choice="jeev"]');
      await load();
      assert.deepEqual([(await page.run<Seen>(COLOURS)).theme, await page.run<string | null>("return localStorage.getItem('vigile.theme')")], ["jeev", "jeev"]);
      assert.match(await page.run<string>("const boot = document.head.querySelector('script[src=\"/boot.js\"]:not([defer]):not([async]):not([type=module])'); return boot ? (await fetch(boot.src)).text() : ''"), /dataset\.theme = localStorage\.getItem\("vigile\.theme"\)/, "the theme is set before the page is drawn");

      // The panel takes the theme too.
      await page.click(".card");
      await page.until("return !document.getElementById('panel').hidden", "the panel");
      await layout("in the panel in the Jeev theme");
      await page.key("Escape");
      await theme("vigile");
      await page.run("localStorage.removeItem('vigile.theme')");
      assert.deepEqual(page.errors, []);
    });

    it("shows in every theme when the page is out of date or not connected, whatever colour the theme gives the dot", async () => {
      await page.size(1280, 900);
      await load();
      try {
        for (const scheme of ["light", "dark"] as const) {
          await page.scheme(scheme);
          for (const name of ["vigile", "dado", "jeev", "gito"]) {
            const dots = await page.run<string[]>(`
              document.documentElement.dataset.theme = ${JSON.stringify(name)};
              const sync = document.getElementById("sync");
              const dot = (...classes) => { sync.classList.remove("old", "stale", "live"); sync.classList.add(...classes); const colour = getComputedStyle(sync, "::before").backgroundColor; sync.classList.remove(...classes); return colour; };
              return [dot(), dot("old"), dot("stale")];
            `);
            assert.equal(new Set(dots).size, 3, `the dot has a colour of its own when up to date, out of date and not connected in ${name}, ${scheme}: ${dots.join(" | ")}`);
          }
        }
      } finally {
        await page.scheme("light");
        await page.run("document.documentElement.dataset.theme = 'vigile'");
        await load();
      }
    });

    it("gives each theme its own header, columns, cards and labels, so that no two look alike", async () => {
      await page.size(1280, 900);
      await load();
      await page.run("localStorage.removeItem('vigile.theme')");
      await load();
      /** Runs in the page: how the parts that make a theme recognisable are drawn. */
      const SHAPES = `
        const css = (selector, pseudo) => getComputedStyle(document.querySelector(selector), pseudo);
        const top = css(".top"), title = css(".brand h1"), column = css(".column"), head = css(".column-head"), dot = css(".column-head .dot"), count = css(".column-head .count");
        const card = css(".card:not(.trouble):not(.is-group)"), pill = css(".project .pill"), mark = css(".project .pill", "::before"), tag = css(".card .tag"), id = css(".card .id", "::before");
        // How light a colour is, from 0 to 255. Colours are given as rgb(r, g, b) or, when mixed, as color(srgb r g b / a) with parts from 0 to 1.
        const light = (colour) => { const scale = colour.startsWith("color(") ? 255 : 1; const [r, g, b, a = 1] = colour.match(/[\\d.]+/g).map(Number); return a < 0.5 ? null : Math.round((0.2126 * r + 0.7152 * g + 0.0722 * b) * scale); };
        return {
          "header bar": top.backgroundColor,
          "header text": title.color,
          "column fill": column.backgroundColor,
          "column border": [column.borderTopWidth, column.borderLeftWidth, column.borderRadius].join(" "),
          "column title": [head.textTransform, head.fontSize, head.borderBottomWidth].join(" "),
          "column mark": dot.display === "none" ? "none" : dot.backgroundColor === "rgba(0, 0, 0, 0)" ? "ring" : "dot",
          "column count": count.backgroundColor === "rgba(0, 0, 0, 0)" ? "plain" : "pill",
          "card edge": [card.borderLeftWidth, card.borderLeftColor].join(" "),
          "card border": card.borderTopColor === "rgba(0, 0, 0, 0)" ? "none" : "line",
          "card shadow": card.boxShadow === "none" ? "none" : "shadow",
          "card type mark": id.content === "none" ? "none" : "square",
          "label fill": pill.backgroundColor === "rgba(0, 0, 0, 0)" ? "none" : light(pill.backgroundColor) < 140 ? "solid" : "tint",
          "label text": [pill.textTransform, pill.fontWeight].join(" "),
          "label dot": mark.display === "none" || mark.content === "none" ? "none" : "dot",
          "tag border": tag.borderTopWidth,
          "header contrast": (() => { const bar = light(top.backgroundColor) ?? light(getComputedStyle(document.body).backgroundColor); const text = light(css("#sync").color); return Math.abs(bar - text) > 110; })(),
        };
      `;
      const shapes: Record<string, Record<string, unknown>> = {};
      await openSettings();
      for (const theme of THEMES) {
        await page.click(`#themes [data-theme-choice="${theme}"]`);
        shapes[theme] = await page.run<Record<string, unknown>>(SHAPES);
        assert.equal(shapes[theme]!["header contrast"], true, `the header's text stands out from its bar in ${theme}`);
      }
      // What each theme is known by.
      assert.deepEqual([shapes.dado!["header bar"], shapes.gito!["header bar"], shapes.jeev!["header bar"]], ["rgb(0, 120, 212)", "rgb(36, 41, 47)", "rgb(255, 255, 255)"], "a blue bar, a near-black bar and a white bar");
      assert.deepEqual([shapes.dado!["card edge"], shapes.dado!["label fill"], shapes.dado!["column border"]], ["4px rgb(242, 203, 29)", "none", "0px 1px 0px"], "Dado: cards with a coloured edge, states as plain text, columns divided by rules");
      assert.deepEqual([shapes.jeev!["column title"], shapes.jeev!["card type mark"], shapes.jeev!["label text"], shapes.jeev!["card border"]], ["uppercase 11px 0px", "square", "uppercase 700", "none"], "Jeev: small capitals, a type square, lozenges, cards on a shadow");
      assert.deepEqual([shapes.gito!["column mark"], shapes.gito!["column count"], shapes.gito!["label fill"], shapes.gito!["card shadow"], shapes.gito!["tag border"]], ["ring", "pill", "solid", "none", "1px"], "Gito: a ring and a counter, solid labels, flat cards, outlined tags");
      // No two themes alike: every pair differs in most of what was measured.
      const measured = Object.keys(shapes.vigile!).filter((key) => key !== "header contrast");
      for (const [i, a] of THEMES.entries()) {
        for (const b of THEMES.slice(i + 1)) {
          const differing = measured.filter((key) => JSON.stringify(shapes[a]![key]) !== JSON.stringify(shapes[b]![key]));
          assert.ok(differing.length >= 8, `${a} and ${b} differ in ${differing.length} of ${measured.length} ways: ${differing.join(", ")}`);
          console.log(`${a} and ${b} differ in ${differing.length} of the ${measured.length} things measured`);
        }
      }
      await page.click('#themes [data-theme-choice="vigile"]');
      await closeSettings();
      await page.run("localStorage.removeItem('vigile.theme')");
    });

    it("colours the graph and its legend in the theme, without laying the graph out again", async () => {
      await load();
      await page.run("localStorage.removeItem('vigile.theme')");
      await load("/#graph");
      await graphReady();
      const drawn = () =>
        page.run<{ node: string; legend: string; variable: string; at: string; font: string }>(
          `const cy = window.vigileGraph; const node = cy.nodes('[kind = "task"][state = "next"][trouble = 0]').first(); const plain = (c) => c.replaceAll(" ", ""); const swatch = getComputedStyle(document.querySelector('#legend li[data-state="next"] .swatch')); const probe = document.createElement("i"); probe.style.color = "var(--go)"; document.body.append(probe); const variable = plain(getComputedStyle(probe).color); probe.remove(); return { node: plain(node.style("border-color")), legend: plain(swatch.borderTopColor), variable, at: JSON.stringify(node.position()), font: node.style("font-family").split(",")[0].replaceAll('"', "") }`,
        );
      const before = await drawn();
      assert.deepEqual([before.node, before.legend], [before.variable, before.variable]);
      const borders = new Set([before.node]);
      await openSettings();
      for (const theme of ["dado", "jeev", "gito"] as const) {
        await page.click(`#themes [data-theme-choice="${theme}"]`);
        await page.until(`return window.vigileGraph.nodes('[kind = "task"][state = "next"][trouble = 0]').first().style("border-color").replaceAll(" ", "") !== ${JSON.stringify([...borders].at(-1))}`, `the graph to take the ${theme} colours`);
        const now = await drawn();
        assert.deepEqual([now.node, now.legend], [now.variable, now.variable], `the graph and the legend use the ${theme} theme's colour`);
        assert.equal(now.at, before.at, "the tasks stay where they were");
        borders.add(now.node);
        await layout(`in the graph in the ${theme} theme`);
      }
      assert.equal(borders.size, 4);
      assert.equal((await drawn()).font, "-apple-system", "the graph's text takes the theme's font");
      await page.click('#themes [data-theme-choice="vigile"]');
      await closeSettings();
      await page.run("localStorage.removeItem('vigile.theme')");
    });

    it("on a phone offers the four themes in the settings, and a tap puts one on", async () => {
      await page.size(390, 844, true);
      await load();
      await page.run("localStorage.removeItem('vigile.theme')");
      await load();
      await page.tap("#settings");
      const shown = () => page.run<string[]>("return [...document.querySelectorAll('#themes button')].filter((b) => b.getBoundingClientRect().width >= 24).map((b) => b.dataset.themeChoice)");
      assert.deepEqual(await shown(), ["vigile", "dado", "jeev", "gito"], "all four can be tapped");
      for (const name of ["dado", "jeev", "gito", "vigile"]) {
        await page.tap(`#themes [data-theme-choice="${name}"]`);
        assert.equal(await page.run<string>("return document.documentElement.dataset.theme"), name);
        assert.equal(await settingsOpen(), true, "the menu stays open while its choices are used");
        await layout(`on a phone with the settings open in the ${name} theme`);
      }
      for (const width of [320, 360]) {
        await page.size(width, 780, true);
        await load();
        await layout(`in the header at ${width}px`);
        await page.tap("#settings");
        await layout(`at ${width}px with the settings open`);
      }
      await page.run("localStorage.removeItem('vigile.theme')");
      await page.size(1280, 900);
    });
  });

  browserSuite("background lights", () => {
    const canvas = () =>
      page.run<{ shown: boolean; frames: number; time: number; at: number; lit: boolean }>(
        "const c = document.getElementById('lights'); return { shown: !c.hidden && c.getBoundingClientRect().width > 0, frames: Number(c.dataset.frames ?? 0), time: Number(c.dataset.time ?? 0), at: performance.now(), lit: document.body.classList.contains('lit') }",
      );
    /**
     * Runs in the page. Draws the lights at many moments of their course and returns the lowest contrast that the
     * page's main text and its quiet text ever have with what is behind them, and the lights' average colour.
     */
    const COURSE = `
      const canvas = document.getElementById("lights");
      const strength = Number(getComputedStyle(canvas).opacity);
      const probe = document.createElement("span"); document.body.append(probe);
      const rgb = (name) => { probe.style.color = "var(--" + name + ")"; const c = getComputedStyle(probe).color; const scale = c.startsWith("color(") ? 255 : 1; return c.match(/[\\d.]+/g).slice(0, 3).map((v) => Number(v) * scale); };
      const bg = rgb("bg"), inks = { text: rgb("text"), muted: rgb("muted") };
      probe.remove();
      const lum = (c) => { const [r, g, b] = c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
      const small = document.createElement("canvas"); small.width = 64; small.height = 36;
      const ctx = small.getContext("2d", { willReadFrequently: true });
      const worst = { text: 99, muted: 99 }; let red = 0, green = 0, blue = 0, lit = 0;
      for (let moment = 0; moment < 900; moment += 5) {
        window.vigileLights.at(moment);
        ctx.clearRect(0, 0, 64, 36); ctx.drawImage(canvas, 0, 0, 64, 36);
        const data = ctx.getImageData(0, 0, 64, 36).data;
        for (let i = 0; i < data.length; i += 4) {
          const a = (data[i + 3] / 255) * strength;
          const under = [0, 1, 2].map((k) => data[i + k] * a + bg[k] * (1 - a));
          for (const ink in inks) worst[ink] = Math.min(worst[ink], ratio(inks[ink], under));
          if (data[i + 3] > 40) { red += data[i]; green += data[i + 1]; blue += data[i + 2]; lit++; }
        }
      }
      return { text: Math.round(worst.text * 100) / 100, muted: Math.round(worst.muted * 100) / 100, red: Math.round(red / lit), green: Math.round(green / lit), blue: Math.round(blue / lit), strength };
    `;

    it("are off unless switched on, then move behind the board at seven tenths of their speed, and are remembered", async () => {
      await page.size(1280, 900);
      await load();
      await page.run("localStorage.removeItem('vigile.lights')");
      await load();
      try {
        assert.deepEqual([await page.run<boolean>("return document.getElementById('lights-on').checked"), (await canvas()).shown, (await canvas()).frames, (await canvas()).lit], [false, false, 0, false], "no lights, and nothing drawn, unless switched on");
        await setting("lights-on");
        assert.equal(await page.run<string | null>("return localStorage.getItem('vigile.lights')"), "on");
        await page.until("return Number(document.getElementById('lights').dataset.frames) > 3", "the lights to be drawn", 4000);
        // Behind everything, as large as the window, and never in the way of a click.
        assert.deepEqual(
          await page.run("const c = document.getElementById('lights'); const r = c.getBoundingClientRect(); const s = getComputedStyle(c); return [Math.round(r.width), Math.round(r.height), s.position, s.zIndex, s.pointerEvents, document.elementFromPoint(innerWidth - 4, innerHeight - 4) === c, c.getAttribute('aria-hidden')]"),
          [1280, 900, "fixed", "-1", "none", false, "true"],
        );
        // Their time runs at seven tenths of the clock's, and they are drawn at most 24 times a second.
        const first = await canvas();
        await page.wait(2500);
        const second = await canvas();
        const seconds = (second.at - first.at) / 1000;
        const pace = (second.time - first.time) / seconds;
        assert.ok(pace > 0.55 && pace < 0.75, `the lights move at ${pace.toFixed(2)} times their speed`);
        assert.ok((second.frames - first.frames) / seconds <= 25, `drawn ${((second.frames - first.frames) / seconds).toFixed(1)} times a second`);
        assert.equal(second.lit, true);
        await layout("on the board with the lights behind it");
        // They are behind the board only: the graph has none, and nothing is drawn while it is shown.
        await page.click("#view-graph");
        await graphReady();
        const hidden = await canvas();
        await page.wait(500);
        assert.deepEqual([hidden.shown, hidden.lit, (await canvas()).frames], [false, false, hidden.frames], "no lights behind the graph");
        await page.click("#view-board");
        await page.until("return !document.getElementById('lights').hidden", "the lights to come back with the board", 2000);
        // The switch is this page's own: the lights also move where the system asks for reduced motion.
        await page.motion("reduce");
        const still = await canvas();
        await page.wait(600);
        assert.ok((await canvas()).frames > still.frames, "the lights keep moving under reduced motion");
        await page.motion("no-preference");
        // Remembered, and fitting a phone too.
        await page.size(360, 780, true);
        await load();
        assert.deepEqual([await page.run<boolean>("return document.getElementById('lights-on').checked"), (await canvas()).shown], [true, true], "the choice survives a reload");
        await layout("on a phone with the lights behind the board");
        await page.size(1280, 900);
        await setting("lights-on");
        assert.deepEqual([(await canvas()).shown, (await canvas()).lit, await page.run<string | null>("return localStorage.getItem('vigile.lights')")], [false, false, "off"]);
      } finally {
        await page.motion("no-preference");
        await page.size(1280, 900);
        await page.run("localStorage.removeItem('vigile.lights')");
      }
      assert.deepEqual(page.errors, []);
    });

    it("are teal and violet, and leave the page's text readable over their whole course, in every theme, light and dark", async () => {
      await page.size(1280, 900);
      await load();
      await page.run("localStorage.setItem('vigile.lights', 'on')");
      await load();
      try {
        for (const scheme of ["light", "dark"] as const) {
          await page.scheme(scheme);
          for (const name of ["vigile", "dado", "jeev", "gito"]) {
            await page.run(`document.documentElement.dataset.theme = ${JSON.stringify(name)}`);
            const seen = await page.run<{ text: number; muted: number; red: number; green: number; blue: number; strength: number }>(COURSE);
            assert.ok(seen.text >= 4.5 && seen.muted >= 4.5, `text keeps a contrast of 4.5 to 1 over the lights in ${name}, ${scheme}: ${seen.text} for the main text, ${seen.muted} for the quiet text`);
            assert.ok(seen.red < seen.green * 0.75 && seen.red < seen.blue * 0.75, `the lights are teal and violet, with little red, in ${name}, ${scheme}: ${seen.red} ${seen.green} ${seen.blue}`);
          }
        }
      } finally {
        await page.scheme("light");
        await page.run("document.documentElement.dataset.theme = 'vigile'; localStorage.removeItem('vigile.lights')");
      }
      assert.deepEqual(page.errors, []);
    });
  });

  browserSuite("settings", () => {
    const pressed = () => page.run<string | null>("return document.getElementById('settings').getAttribute('aria-expanded')");

    it("keeps the page's choices behind one button in the header, and nowhere else", async () => {
      await page.size(1280, 900);
      await load();
      assert.deepEqual([await settingsOpen(), await pressed()], [false, "false"], "the menu is closed until asked for");
      assert.deepEqual(
        await page.run("return [...document.querySelectorAll('.top .controls > *')].map((el) => el.id || el.className)"),
        ["refresh", "focus", "settings"],
        "the header holds three buttons: refresh, room for the board, and settings",
      );
      assert.equal(await page.run<number>("return [...document.querySelectorAll('.switch, .theme, select')].filter((el) => !el.closest('#settings-menu, #graph-panel')).length"), 0, "no switch or theme button is left outside the menu");
      await page.click("#settings");
      assert.deepEqual([await settingsOpen(), await pressed()], [true, "true"]);
      assert.deepEqual(
        await page.run("return [...document.querySelectorAll('#settings-menu .switch, #settings-menu .setting')].filter((el) => el.getBoundingClientRect().width > 0).map((el) => el.querySelector('span:not(.track)').textContent)"),
        ["Auto-refresh", "Scroll columns", "Show bugs column", "Created", "Started", "Completed", "Board animations", "Background", "System light/dark", "Theme"],
      );
      // Four sections divided by lines: the board, the sounds, the looks, and the theme. Each row of the first three
      // starts with the drawing of its section.
      assert.deepEqual(
        await page.run("return [...document.querySelectorAll('#settings-menu .setting-section')].map((section) => section.getAttribute('aria-label') + ': ' + [...section.querySelectorAll('.switch use')].map((use) => use.getAttribute('href').replace('#icon-', '')).join(' '))"),
        ["Board: board board board", "Sounds: sound sound sound", "Looks: eye eye eye eye"],
      );
      assert.deepEqual(
        await page.run("return [...document.querySelectorAll('#settings-menu .switch:not([hidden]) .setting-icon')].map((icon) => Math.round(icon.getBoundingClientRect().width) + 'x' + Math.round(icon.getBoundingClientRect().height)).filter((size, index, all) => all.indexOf(size) === index)"),
        ["16x16"],
        "every drawing is there, and the same size",
      );
      const box = await page.run<{ left: number; right: number; top: number; bottom: number; under: number }>("const m = document.getElementById('settings-menu').getBoundingClientRect(); return { left: m.left, right: m.right, top: m.top, bottom: m.bottom, under: document.getElementById('settings').getBoundingClientRect().bottom }");
      assert.ok(box.top >= box.under && box.left >= 0 && box.right <= 1280 && box.bottom <= 900, "the menu opens under its button, inside the window");
      await layout("with the settings open");
      // A choice made there takes effect at once, and the menu stays open for the next one.
      await page.click("label:has(#bugs-apart)");
      assert.equal(await count(".column[data-tone='bug']"), 1);
      assert.equal(await settingsOpen(), true);
      await page.click("label:has(#bugs-apart)");
      assert.equal(await count(".column[data-tone='bug']"), 0);
      // The button closes it again.
      await page.click("#settings");
      assert.deepEqual([await settingsOpen(), await pressed()], [false, "false"]);
      await page.run("localStorage.removeItem('vigile.bugs-apart')");
      assert.deepEqual(page.errors, []);
    });

    it("is light or dark as the system says, unless that is switched off and one is chosen by hand", async () => {
      await page.size(1280, 900);
      await load();
      await page.run("localStorage.removeItem('vigile.scheme'); localStorage.removeItem('vigile.theme')");
      await page.scheme("light");
      await load();
      const seen = () =>
        page.run<{ scheme: string; bg: string; controls: string; follows: boolean; dark: boolean; choice: boolean; stored: string | null }>(
          "const root = document.documentElement; return { scheme: root.dataset.scheme, bg: getComputedStyle(document.body).backgroundColor, controls: getComputedStyle(root).colorScheme, follows: document.getElementById('scheme-system').checked, dark: document.getElementById('scheme-dark').checked, choice: !document.getElementById('scheme-dark-choice').hidden, stored: localStorage.getItem('vigile.scheme') }",
        );
      const LIGHT = "rgb(246, 245, 241)";
      const DARK = "rgb(16, 18, 20)";
      try {
        // Left alone, the page follows the system, and offers nothing more to choose.
        assert.deepEqual(await seen(), { scheme: "light", bg: LIGHT, controls: "light", follows: true, dark: false, choice: false, stored: null });
        await page.scheme("dark");
        assert.deepEqual(await seen(), { scheme: "dark", bg: DARK, controls: "dark", follows: true, dark: true, choice: false, stored: null });
        await page.scheme("light");
        // Switched off, the page stays as it is, and a second switch chooses.
        await openSettings();
        await page.click("label:has(#scheme-system)");
        assert.deepEqual(await seen(), { scheme: "light", bg: LIGHT, controls: "light", follows: false, dark: false, choice: true, stored: "light" });
        await layout("with the settings open and light or dark chosen by hand");
        await page.click("label:has(#scheme-dark)");
        assert.deepEqual(await seen(), { scheme: "dark", bg: DARK, controls: "dark", follows: false, dark: true, choice: true, stored: "dark" });
        await layout("with dark chosen by hand on a light system");
        await closeSettings();
        // The system no longer decides, in either direction.
        await page.scheme("dark");
        await page.scheme("light");
        assert.equal((await seen()).bg, DARK, "the page stays dark while the system is light");
        // Remembered, and applied before the page is drawn, so that it never flashes in the other one.
        await load();
        assert.deepEqual(await seen(), { scheme: "dark", bg: DARK, controls: "dark", follows: false, dark: true, choice: true, stored: "dark" });
        assert.match(await page.run<string>("const boot = document.head.querySelector('script[src=\"/boot.js\"]:not([defer]):not([async]):not([type=module])'); return boot ? (await fetch(boot.src)).text() : ''"), /localStorage\.getItem\("vigile\.scheme"\)/, "light or dark is set before the page is drawn");
        // Every theme has its dark side by hand too, and the graph is coloured to match.
        await openSettings();
        for (const name of ["dado", "jeev", "gito", "vigile"]) {
          await page.click(`#themes [data-theme-choice="${name}"]`);
          const bg = (await seen()).bg;
          const [r, g, b] = bg.match(/\d+/g)!.map(Number);
          assert.ok(r! + g! + b! < 150, `the ${name} theme is dark when dark is chosen by hand: ${bg}`);
        }
        await closeSettings();
        await page.click("#view-graph");
        await graphReady();
        const node = () => page.run<string>(`return window.vigileGraph.nodes('[kind = "task"]').first().style("background-color")`);
        const inDark = await node();
        await setting("scheme-dark");
        await page.until(`return window.vigileGraph.nodes('[kind = "task"]').first().style("background-color") !== ${JSON.stringify(inDark)}`, "the graph to take the light colours", 5000);
        assert.equal((await seen()).bg, LIGHT);
        await page.click("#view-board");
        // Light by hand on a dark system.
        await page.scheme("dark");
        assert.deepEqual([(await seen()).scheme, (await seen()).bg], ["light", LIGHT], "the page stays light while the system is dark");
        // Switched on again, the system decides once more, and nothing is left stored.
        await setting("scheme-system");
        assert.deepEqual(await seen(), { scheme: "dark", bg: DARK, controls: "dark", follows: true, dark: true, choice: false, stored: null });
      } finally {
        await page.scheme("light");
        await page.run("localStorage.removeItem('vigile.scheme'); localStorage.removeItem('vigile.theme')");
      }
      assert.deepEqual(page.errors, []);
    });

    it("fits a window that is shorter than its rows, and scrolls so that every setting can be reached", async () => {
      // A phone held sideways.
      await page.size(844, 390, true);
      await load();
      try {
        await page.tap("#settings");
        const menu = () =>
          page.run<{ top: number; bottom: number; under: number; scrolls: boolean; scrolled: number }>(
            "const m = document.getElementById('settings-menu'); const r = m.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), under: Math.round(document.getElementById('settings').getBoundingClientRect().bottom), scrolls: m.scrollHeight > m.clientHeight + 1 && getComputedStyle(m).overflowY === 'auto', scrolled: Math.round(m.scrollTop) }",
          );
        const first = await menu();
        assert.ok(first.top >= first.under && first.bottom <= 390, `the menu ends inside the window: from ${first.top} to ${first.bottom} of 390`);
        assert.equal(first.scrolls, true, "its rows need more room than there is, so it scrolls");
        // The last thing in it, the theme, can be reached and used.
        await page.tap('#themes [data-theme-choice="dado"]');
        assert.equal(await page.run<string>("return document.documentElement.dataset.theme"), "dado");
        const last = await menu();
        assert.ok(last.scrolled > 0 && last.bottom <= 390, "scrolled to its end, still inside the window");
        const button = await page.run<{ top: number; bottom: number }>("const r = document.querySelector('#themes [data-theme-choice=\"gito\"]').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }");
        assert.ok(button.top >= 0 && button.bottom <= 390, "the theme buttons are in sight");
        await layout("with the settings open in a short window");
        // A taller window gives it its whole height back.
        await page.size(844, 900, true);
        assert.equal((await menu()).scrolls, false);
      } finally {
        await page.run("localStorage.removeItem('vigile.theme'); document.documentElement.dataset.theme = 'vigile'");
        await page.size(1280, 900);
      }
    });

    it("closes with a click elsewhere, with Escape, and when the keyboard moves on", async () => {
      await page.size(1280, 900);
      await load();
      await page.click("#settings");
      await page.click("#board-heading");
      assert.equal(await settingsOpen(), false, "a click elsewhere closes it");
      // By keyboard: Enter opens it, Tab goes through its choices in order, Escape closes it and returns to the button.
      await page.run("document.getElementById('settings').focus()");
      await page.key("Enter");
      assert.equal(await settingsOpen(), true);
      const reached: string[] = [];
      for (let i = 0; i < 13; i++) {
        await page.key("Tab");
        reached.push(await page.run<string>("return document.activeElement.id || document.activeElement.dataset.themeChoice || document.activeElement.tagName"));
      }
      assert.deepEqual(reached, ["auto", "column-scroll", "bugs-apart", "sound-created", "sound-started", "sound", "motion", "lights-on", "scheme-system", "vigile", "dado", "jeev", "gito"]);
      assert.equal(await settingsOpen(), true);
      await page.key("Escape");
      assert.deepEqual([await settingsOpen(), await page.run<string>("return document.activeElement.id")], [false, "settings"], "Escape closes it and focus returns to the button");
      // Tabbing past the last choice leaves the menu, which closes behind.
      await page.key("Enter");
      for (let i = 0; i < 14; i++) await page.key("Tab");
      assert.equal(await settingsOpen(), false, "moving on with the keyboard closes it");
      // With an item open, Escape closes the menu first and the item next.
      await page.click(".card");
      await page.until("return !document.getElementById('panel').hidden", "the panel");
      await page.run("document.getElementById('settings').click()");
      assert.equal(await settingsOpen(), true);
      await page.key("Escape");
      assert.deepEqual([await settingsOpen(), await panelOpen()], [false, true]);
      await page.key("Escape");
      assert.equal(await panelOpen(), false);
      assert.deepEqual(page.errors, []);
    });
  });

  browserSuite("room", () => {
    const place = (id: string) => page.run<{ top: number; bottom: number; height: number }>(`const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }`);
    const header = () => page.run<number>("return Math.round(document.querySelector('.top').getBoundingClientRect().bottom)");

    it("folds away everything above the board with the header's toggle, and brings it back", async () => {
      await page.size(1280, 800);
      await load();
      const open = await place("board");
      assert.equal(await page.run<string | null>("return document.getElementById('focus').getAttribute('aria-pressed')"), "false");
      await page.click("#focus");
      const folded = await place("board");
      assert.equal(await page.run<string | null>("return document.getElementById('focus').getAttribute('aria-pressed')"), "true");
      assert.deepEqual(await page.run("return ['projects-section', 'summary', 'filter', 'board-heading'].map((id) => Math.round(document.getElementById(id).getBoundingClientRect().height))"), [0, 0, 0, 0], "the projects, the heading, the filter and the counts are gone");
      assert.ok(folded.top - (await header()) <= 14, `the board starts right under the header: ${folded.top - (await header())}px below it`);
      assert.ok(800 - folded.bottom <= 14 && folded.bottom <= 800, "and reaches the bottom of the window");
      assert.ok(folded.height - open.height > 250, `the board gained ${folded.height - open.height}px`);
      assert.equal(await page.run<boolean>("return document.documentElement.scrollHeight > innerHeight"), false);
      await layout("with everything above the board folded away");

      // A card still opens; the choice survives a reload; the graph gets the room too.
      await page.click(".card");
      await page.until("return !document.getElementById('panel').hidden", "the panel");
      await page.key("Escape");
      await load();
      assert.equal(await page.run<string | null>("return localStorage.getItem('vigile.focus')"), "on");
      assert.ok((await place("board")).top - (await header()) <= 14, "still folded after a reload");
      await page.click("#view-graph");
      await graphReady();
      const graph = await place("graph-box");
      assert.ok(Math.abs(800 - graph.bottom - 12) <= 1 && graph.top - (await header()) < 110, `the graph has the room, under its controls and legend: ${JSON.stringify(graph)}`);
      await layout("in the graph with everything above it folded away");
      await page.click("#view-board");
      await page.until("return document.getElementById('board').getBoundingClientRect().height > 0", "the board");

      // While a filter or a project narrows the board, one line says so.
      await page.click("#focus");
      await page.click("#filter");
      await page.type("Prerequisite");
      await page.click(".project-main", 2);
      await page.click("#focus");
      assert.equal(await text("#scope .scope-text"), 'in WEB · Website relaunch, matching "Prerequisite"');
      assert.ok((await place("board")).top - (await header()) < 50, "and the board is still near the top");
      await layout("folded away while a filter narrows the board");
      await page.click("#focus");
      assert.equal(await text("#scope .scope-text"), "in WEB · Website relaunch", "with the filter in sight, the line does not repeat it");
      await page.click(".project-main", 2);
      await page.run("document.getElementById('filter').select()");
      await page.key("Backspace");
      assert.deepEqual(await place("board"), open, "everything is back where it was");
      assert.equal(await page.run<string | null>("return localStorage.getItem('vigile.focus')"), "off");

      // On a phone, and with the keyboard.
      await page.size(390, 844, true);
      await load();
      const phone = await place("board");
      await page.tap("#focus");
      assert.ok(phone.top - (await place("board")).top > 250, "on a phone the board moves up by what was above it");
      await layout("on a phone with everything above the board folded away");
      await page.run("document.getElementById('focus').focus()");
      await page.key("Enter");
      assert.equal((await place("board")).top, phone.top, "unfolded with the keyboard");
      await page.run("localStorage.removeItem('vigile.focus')");
      await page.size(1280, 900);
    });

    it("leaves full screen when a change takes away the last task that was shown, so there is always a way out", async () => {
      await page.size(1280, 800);
      const only = (await run("create_task", { title: "The only task of its project", description: "d", project: "EMPTY" })) as { id: string; version: number };
      await load();
      try {
        await setting("auto");
        await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
        const index = await page.run<number>("return [...document.querySelectorAll('.project')].findIndex((p) => p.querySelector('.project-id').textContent === 'EMPTY')");
        await page.click(".project-main", index);
        await page.click("#view-graph");
        await page.until("return Boolean(window.vigileGraph && window.vigileGraph.scratch('settled') && window.vigileGraph.nodes('[kind = \"task\"]').length === 1)", "the graph of the one task", 20_000);
        await page.click("#graph-full");
        await page.until("return document.body.classList.contains('graph-full')", "full screen");
        assert.equal(await page.run<number>("return Math.round(document.getElementById('view-board').getBoundingClientRect().height)"), 0, "in full screen the header and its views are out of sight");
        // The task is deleted by someone else: there is no graph left to show, and no button on it to leave by.
        await run("delete", { id: only.id, version: only.version });
        await page.until("return !document.body.classList.contains('graph-full')", "the page to leave full screen", 3000);
        assert.ok((await page.run<number>("return Math.round(document.getElementById('view-board').getBoundingClientRect().height)")) > 0, "the header and its views are back");
        assert.match(await text("#empty"), /No tasks in this project/);
        await layout("after the last task shown in full screen was taken away");
      } finally {
        await page.run("localStorage.removeItem('vigile.auto-refresh')");
        await run("delete", { id: only.id, version: (await run("get", { id: only.id })).version }).catch(() => {});
        await load();
      }
    });

    it("puts the graph full screen on request, keeps it usable there, and comes back", async () => {
      await page.size(1280, 800);
      await load("/#graph");
      await graphReady();
      const before = await place("graph-box");
      assert.equal(await text("#graph-full"), "Full screen");
      await page.click("#graph-full");
      await page.until("return document.body.classList.contains('graph-full') && document.getElementById('graph-box').getBoundingClientRect().top < 120", "the graph to take the screen");
      const full = await place("graph-box");
      assert.deepEqual(await page.run("return ['.top', '#projects-section', '.board-head', '.filters'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().height))"), [0, 0, 0, 0], "the header and everything above the graph are gone");
      assert.ok(full.height - before.height > 250 && Math.abs(800 - full.bottom - 12) <= 1, `the graph has the whole window: ${JSON.stringify(full)}`);
      assert.deepEqual([await text("#graph-full"), await page.run("return document.getElementById('graph-full').getAttribute('aria-pressed')")], ["Leave full screen", "true"]);
      await page.until("return Math.abs(window.vigileGraph.height() - document.getElementById('graph-box').clientHeight) < 2", "the drawing to take the box's new size");
      await layout("in the graph on the full screen");

      // A task still opens there. Escape closes the panel first, and leaves full screen next.
      await page.click("#zoom-fit");
      const launch = await nodeAt(`task:${ids.launch}`);
      await page.clickAt(launch.x, launch.y);
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Launch the checkout'", "the task's panel, on the full screen");
      await page.key("Escape");
      assert.deepEqual([await panelOpen(), await page.run("return document.body.classList.contains('graph-full')")], [false, true]);
      await page.key("Escape");
      await page.until("return !document.body.classList.contains('graph-full')", "the page to come back");
      await page.until(`return Math.abs(document.getElementById('graph-box').getBoundingClientRect().height - ${before.height}) < 3`, "the box to be as before");
      assert.equal(await text("#graph-full"), "Full screen");

      // The button leaves it too; so does going to the board.
      await page.click("#graph-full");
      await page.until("return document.body.classList.contains('graph-full')", "full screen");
      await page.click("#graph-full");
      await page.until("return !document.body.classList.contains('graph-full')", "back, by the button");
      await page.click("#graph-full");
      await page.run("location.hash = '#board'");
      await page.until("return !document.body.classList.contains('graph-full') && document.getElementById('board').getBoundingClientRect().height > 0 && document.querySelector('.top').getBoundingClientRect().height > 0", "the board, with the header back");

      // On a phone, where the box otherwise keeps a fixed height, full screen gives it the screen.
      await page.size(390, 844, true);
      await load("/#graph");
      await graphReady();
      const small = await place("graph-box");
      await page.tap("#graph-full");
      await page.until("return document.body.classList.contains('graph-full')", "full screen on a phone");
      await page.until("const r = document.getElementById('graph-box').getBoundingClientRect(); return Math.abs(innerHeight - r.bottom - 12) <= 1.5", "the box to reach the bottom of the phone's screen");
      assert.ok((await place("graph-box")).height > small.height, "the graph is larger than before");
      await layout("in the graph on a phone's full screen");
      await page.tap("#graph-full");
      await page.size(1280, 900);
      assert.deepEqual(page.errors, []);
    });

    it("draws the cross of the close button, and every other icon, in the middle of its button", async () => {
      for (const [width, phone] of [[1280, false], [360, true]] as const) {
        await page.size(width, 800, phone);
        await load();
        if (phone) await page.tap(".card");
        else await page.click(".card");
        await page.until("return !document.getElementById('panel').hidden", "the panel");
        const off = await page.run<Array<[string, number, number]>>(
          "return [...document.querySelectorAll('button > svg')].filter((i) => i.getBoundingClientRect().width > 0).map((i) => { const b = i.parentElement.getBoundingClientRect(); const r = i.getBoundingClientRect(); const shape = i.querySelector('path').getBoundingClientRect(); return [i.parentElement.id || i.parentElement.className, Math.round(Math.max(Math.abs((b.left + b.right - r.left - r.right) / 2), Math.abs((b.top + b.bottom - r.top - r.bottom) / 2)) * 10) / 10, Math.round(Math.max(Math.abs((b.left + b.right - shape.left - shape.right) / 2), Math.abs((b.top + b.bottom - shape.top - shape.bottom) / 2)) * 10) / 10]; })",
        );
        // The control that collapses a column is in every column's heading, and is held to the same rule.
        assert.deepEqual(off.map(([id]) => id).filter((id) => id !== "column-fold").sort(), ["close", "focus", "refresh", "settings"]);
        assert.equal(off.filter(([id]) => id === "column-fold").length, await count(".board > .column"));
        for (const [id, box, shape] of off) assert.ok(box <= 0.5 && shape <= (id === "refresh" ? 1.2 : 0.5), `the drawing in #${id} is ${box}px off the middle, its shape ${shape}px, at ${width}px`);
        await page.key("Escape");
      }
      await page.size(1280, 900);
    });
  });

  browserSuite("access", () => {
    it("asks for a key when one is needed, says when it is wrong, and shows nothing until it is right", async () => {
      await page.size(1280, 900);
      await load();
      setValue(config, "auth.keyless_user", "");
      try {
        await page.open(`${base}/`);
        await page.until("return !document.getElementById('notice').hidden", "the key form");
        assert.match(await text("#notice"), /needs an API key/);
        assert.equal(await page.run<boolean>("return document.getElementById('main').hidden"), true);
        await layout("while a key is needed");
        await page.click("#notice input");
        await page.type("vig_wrongwrongwrongwrongwrong");
        await page.key("Enter");
        await page.until("return /not valid/.test(document.getElementById('notice').textContent)", "the wrong-key message");
        assert.equal(await count(".card"), 0);
        // The message stays: the page does not go and ask again by itself, which would put another message in its place.
        const asked = page.requests.length;
        await page.wait(700);
        assert.match(await text("#notice"), /not valid/);
        assert.equal(page.requests.length, asked, "nothing more is asked once the key was refused");
        await page.click("#notice input");
        await page.type(adminKey);
        await page.click("#notice button");
        await page.until("return document.querySelectorAll('.card').length > 0", "the board, once the key is right");
        assert.equal(await text("#you"), "admin");
        await layout("signed in with a key");
      } finally {
        setValue(config, "auth.keyless_user", "agent1");
        await page.run("localStorage.clear()");
      }
    });

    it("lets a tab in when the key is given in another tab, and does not take the key away with an empty field", async () => {
      await page.size(1280, 900);
      await load();
      setValue(config, "auth.keyless_user", "");
      const stored = () => page.run<string | null>("return localStorage.getItem('vigile.key')");
      const board = () => page.until("return !document.getElementById('main').hidden && document.querySelectorAll('.card').length > 0", "the board", 5000);
      try {
        await page.open(`${base}/`);
        await page.until("return Boolean(document.querySelector('#notice input'))", "the key form");
        // The key is given in another tab of the same browser: this one hears of it and is let in, with nothing typed here.
        await page.run(`localStorage.setItem('vigile.key', ${JSON.stringify(adminKey)}); window.dispatchEvent(new StorageEvent('storage', { key: 'vigile.key', newValue: ${JSON.stringify(adminKey)}, storageArea: localStorage }))`);
        await board();
        assert.equal(await text("#you"), "admin");

        // A tab that still shows the form, with its field empty, while the key is stored: Connect tries that key.
        await page.open("about:blank");
        await page.open(`${base}/`);
        await board();
        await page.run("localStorage.removeItem('vigile.key')");
        await page.run("document.getElementById('refresh').click()");
        await page.until("return Boolean(document.querySelector('#notice input')) && document.getElementById('main').hidden", "the key form again");
        await page.run(`localStorage.setItem('vigile.key', ${JSON.stringify(adminKey)})`);
        assert.equal(await page.run<string>("return document.querySelector('#notice input').value"), "");
        await page.click("#notice button");
        await board();
        assert.equal(await stored(), adminKey, "the key that was stored is still there");

        // A wrong key is tried here, and while its refusal is on its way the right one is stored by another tab.
        // The refusal is of the wrong key: the right one is not thrown away with it, and lets the page in.
        await page.run("localStorage.removeItem('vigile.key')");
        await page.run("document.getElementById('refresh').click()");
        await page.until("return Boolean(document.querySelector('#notice input')) && document.getElementById('main').hidden", "the key form once more");
        await page.run("window.realFetch = window.fetch; window.fetch = async (url, options) => { const response = await window.realFetch(url, options); if (response.status === 401) await new Promise((done) => setTimeout(done, 800)); return response; };");
        await page.click("#notice input");
        await page.type("vig_wrongwrongwrongwrongwrong");
        await page.click("#notice button");
        await page.wait(200);
        await page.run(`localStorage.setItem('vigile.key', ${JSON.stringify(adminKey)})`);
        await board();
        assert.equal(await stored(), adminKey, "the right key outlived the refusal of the wrong one");

        // A key the browser had no room to store is kept by the page itself. While its refusal is on its way,
        // another tab stores a key that works. What the page kept for itself gives way to that, and the refusal
        // of the old key does not take the new one out of the browser, for this tab or any other.
        await page.run("localStorage.removeItem('vigile.key')");
        await page.run("document.getElementById('refresh').click()");
        await page.until("return Boolean(document.querySelector('#notice input')) && document.getElementById('main').hidden", "the key form again");
        await page.run("window.realSet = Storage.prototype.setItem; Storage.prototype.setItem = function () { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };");
        try {
          await page.click("#notice input");
          await page.type("vig_wrongwrongwrongwrongwrong");
          await page.click("#notice button");
          await page.wait(200);
          assert.equal(await stored(), null, "the browser took nothing");
          await page.run(
            `window.realSet.call(window.localStorage, 'vigile.key', ${JSON.stringify(adminKey)}); window.dispatchEvent(new StorageEvent('storage', { key: 'vigile.key', newValue: ${JSON.stringify(adminKey)}, storageArea: window.localStorage }));`,
          );
          await board();
          await page.wait(1000);
          assert.equal(await stored(), adminKey, "the key the other tab stored is still in the browser after the old one was refused");
        } finally {
          await page.run("if (window.realSet) Storage.prototype.setItem = window.realSet");
        }

        // The browser has an older key and has no room for the one that is typed in its place. That one is refused:
        // the older key does not come back with it. Connect with an empty field, which tries what is stored,
        // then finds nothing to try, where it would have gone in as whoever the older key belongs to.
        await page.run("localStorage.removeItem('vigile.key')");
        await page.run("document.getElementById('refresh').click()");
        await page.until("return /needs an API key/.test(document.getElementById('notice').textContent) && document.getElementById('main').hidden", "the key form again, asking for a key");
        await page.run(`window.realSet = Storage.prototype.setItem; window.realSet.call(window.localStorage, 'vigile.key', ${JSON.stringify(adminKey)}); Storage.prototype.setItem = function () { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };`);
        try {
          await page.click("#notice input");
          await page.type("vig_wrongwrongwrongwrongwrong");
          await page.click("#notice button");
          await page.until("return /not valid/.test(document.getElementById('notice').textContent)", "the refusal of the key that was typed", 5000);
          await page.run("document.querySelector('#notice input').value = ''");
          await page.click("#notice button");
          await page.until("return /needs an API key/.test(document.getElementById('notice').textContent)", "the page to find that it has no key to try", 5000);
          await page.wait(1200);
          assert.equal(await page.run<boolean>("return document.getElementById('main').hidden"), true, "the older key was not used to go in");
          assert.equal(await stored(), adminKey, "the browser still has it, and the page leaves it be");
        } finally {
          await page.run("if (window.realSet) Storage.prototype.setItem = window.realSet");
        }
        // With room in the browser again, a key that is typed is stored and lets the page in.
        await page.click("#notice input");
        await page.type(adminKey);
        await page.click("#notice button");
        await board();

        // A key is given and stored, and while its refusal is on its way another is given, which the browser has
        // no room for and the page keeps for itself. The refusal is of the first: the second is not thrown away
        // with it, and lets the page in.
        await page.run("localStorage.removeItem('vigile.key')");
        await page.run("document.getElementById('refresh').click()");
        await page.until("return /needs an API key/.test(document.getElementById('notice').textContent) && document.getElementById('main').hidden", "the key form, asking for a key");
        await page.click("#notice input");
        await page.type("vig_wrongwrongwrongwrongwrong");
        await page.click("#notice button");
        await page.run("window.realSet = Storage.prototype.setItem; Storage.prototype.setItem = function () { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };");
        try {
          assert.equal(await stored(), "vig_wrongwrongwrongwrongwrong", "the first key is in the browser, and its refusal has not arrived");
          await page.run(`document.querySelector('#notice input').value = ${JSON.stringify(adminKey)}`);
          await page.click("#notice button");
          await board();
        } finally {
          // The browser has room again, and holds what the page uses: as it is after another tab stored the key.
          await page.run(
            `if (window.realSet) Storage.prototype.setItem = window.realSet; window.localStorage.setItem('vigile.key', ${JSON.stringify(adminKey)}); window.dispatchEvent(new StorageEvent('storage', { key: 'vigile.key', newValue: ${JSON.stringify(adminKey)}, storageArea: window.localStorage }));`,
          );
        }

        // The key this page is in with is refused in another tab, which forgets it. This page has had no refusal
        // itself: it locks all the same and asks for a key, where its next request would have gone without one.
        await page.run(`window.localStorage.removeItem('vigile.key'); window.dispatchEvent(new StorageEvent('storage', { key: 'vigile.key', oldValue: ${JSON.stringify(adminKey)}, newValue: null, storageArea: window.localStorage }));`);
        await page.until("return Boolean(document.querySelector('#notice input')) && document.getElementById('main').hidden && /not valid/.test(document.getElementById('notice').textContent)", "the page to lock when its key is taken away elsewhere", 4000);
        await page.click("#notice input");
        await page.type(adminKey);
        await page.click("#notice button");
        await board();

        // Two tabs have the same key refused. The first forgets it, so the second finds no key stored when its own
        // refusal arrives. No key is not a key someone gave: the page stays locked, also on a service that would
        // let it in without one.
        setValue(config, "auth.keyless_user", "agent1");
        await page.run("localStorage.setItem('vigile.key', 'vig_wrongwrongwrongwrongwrong')");
        await page.run("document.getElementById('refresh').click()");
        await page.wait(200);
        await page.run("localStorage.removeItem('vigile.key')");
        await page.until("return Boolean(document.querySelector('#notice input')) && document.getElementById('main').hidden", "the key form, when the refusal has arrived", 4000);
        await page.wait(1200);
        assert.deepEqual(await page.run("return [Boolean(document.querySelector('#notice input')), document.getElementById('main').hidden]"), [true, true], "the page did not go in without a key by itself");

        // News that another tab was given a key arrives after that tab has had the key refused and has forgotten
        // it: nothing is stored any more. The page does not try without a key for that either.
        await page.run("window.dispatchEvent(new StorageEvent('storage', { key: 'vigile.key', newValue: 'vig_wrongwrongwrongwrongwrong', storageArea: window.localStorage }))");
        await page.wait(1500);
        assert.deepEqual(await page.run("return [Boolean(document.querySelector('#notice input')), document.getElementById('main').hidden]"), [true, true], "late news of a key that is gone lets nobody in");
      } finally {
        await page.run("if (window.realFetch) window.fetch = window.realFetch");
        setValue(config, "auth.keyless_user", "agent1");
        await page.run("localStorage.clear()");
      }
    });

    it("says in its panel that an item is deleted, and does not offer to watch it", async () => {
      await page.size(1280, 900);
      const gone = (await run("create_task", { title: "Deleted, then looked at", description: "d", project: "WEB" })) as { id: string };
      const head = () => page.run<{ pills: string[]; watch: boolean }>("return { pills: [...document.querySelectorAll('#detail .detail-head .pill')].map((p) => p.textContent), watch: Boolean(document.querySelector('#detail .watch')) }");
      try {
        await load(`/#board/${gone.id}`);
        await page.until("return document.querySelector('.detail-title')?.textContent === 'Deleted, then looked at'", "the panel");
        assert.deepEqual(await head(), { pills: ["open", "next"], watch: true });
        // Deleted while its panel is open, and the panel read again.
        await run("delete", { id: gone.id, version: 1 });
        await page.run("document.getElementById('close').click()");
        await load(`/#board/${gone.id}`);
        await page.until("return document.querySelector('.detail-title')?.textContent === 'Deleted, then looked at'", "the panel of the deleted task");
        assert.deepEqual(await head(), { pills: ["open", "deleted"], watch: false });
      } finally {
        await load();
      }
    });

    it("takes away the notices and the watched tasks, which name tasks, when the key is no longer accepted", async () => {
      await page.size(1280, 900);
      const done = (await run("create_task", { title: "Named in a notice", description: "d", project: "WEB" })) as { id: string; version: number };
      const kept = (await run("create_task", { title: "Still watched", description: "d", project: "WEB" })) as { id: string; version: number };
      await load();
      await page.run(`sessionStorage.setItem('vigile.watching', ${JSON.stringify(JSON.stringify([done.id, kept.id]))})`);
      await load();
      try {
        await move(done.id, "in_progress", "done");
        await page.until("return document.querySelectorAll('.toast.done').length === 1", "the notice that the watched task is done", 3000);
        assert.match(await text("#toasts"), /Named in a notice/);
        assert.equal(await text("#watching"), "watching 1");
        await page.click(".card");
        await page.until("return !document.getElementById('panel').hidden", "a task's panel");
        // From now on everyone needs a key, and this page has none.
        setValue(config, "auth.keyless_user", "");
        await page.run("document.getElementById('refresh').click()");
        await page.until("return document.getElementById('main').hidden && !document.getElementById('notice').hidden", "the key form");
        const left = await page.run<{ toasts: number; notices: number; watching: string; shown: number; title: string; panel: boolean }>(
          "const w = document.getElementById('watching'); return { toasts: Math.round(document.getElementById('toasts').getBoundingClientRect().height), notices: document.querySelectorAll('.toast').length, watching: w.textContent + w.title, shown: Math.round(w.getBoundingClientRect().width), title: document.title, panel: !document.getElementById('panel').hidden }",
        );
        // The header says the page is not connected, and goes on saying so.
        const header = () => page.run<[string, boolean, boolean]>("const sync = document.getElementById('sync'); return [sync.textContent, sync.classList.contains('stale'), sync.classList.contains('live')]");
        assert.deepEqual(await header(), ["Not connected", true, false]);
        assert.deepEqual(left, { toasts: 0, notices: 0, watching: "", shown: 0, title: "Vigile", panel: false }, "nothing that names a task is left on screen");
        assert.deepEqual(
          await page.run("return [document.querySelectorAll('.card, .project').length, document.getElementById('detail').textContent, /Named in a notice|Still watched|Website relaunch/.test(document.body.textContent)]"),
          [0, "", false],
          "and nothing of it is left in the page behind what is hidden",
        );
        assert.equal(await page.run<number>("return document.getElementById('toasts-head').getBoundingClientRect().width"), 0);
        // While it is locked out the page reads nothing: it does not go on asking for the tasks it watched.
        const asked = page.requests.filter((url) => /\/api\/(get|list-tasks)$/.test(url)).length;
        await page.wait(3600);
        assert.equal(page.requests.filter((url) => /\/api\/(get|list-tasks)$/.test(url)).length, asked, "no task is asked for while the key is refused");
        assert.deepEqual(await header(), ["Not connected", true, false], "and the header still says that the page is not connected");
        // Accepted again, the page shows the plan and says once more what is watched.
        setValue(config, "auth.keyless_user", "agent1");
        await page.click("#notice button");
        await page.until("return !document.getElementById('main').hidden && document.querySelectorAll('.card').length > 0", "the board, once the page is let in again");
        assert.equal(await text("#watching"), "watching 1");
        assert.equal(await count(".toast"), 0, "the notice that was taken away does not come back");
      } finally {
        setValue(config, "auth.keyless_user", "agent1");
        for (const task of [done, kept]) await run("delete", { id: task.id, version: (await run("get", { id: task.id })).version });
        await page.run("localStorage.clear(); sessionStorage.clear()");
      }
    });

    it("keeps an answer that was on its way when the key was refused from putting a task's name back on screen", async () => {
      await page.size(1280, 900);
      const watched = (await run("create_task", { title: "Answer arrives too late", description: "d", project: "WEB" })) as { id: string; version: number };
      const listeners = async () => ((await (await fetch(`${base}/api/admin/status`, { headers: { authorization: `Bearer ${adminKey}` } })).json()) as { listeners: number }).listeners;
      await load();
      await page.run(`sessionStorage.setItem('vigile.watching', ${JSON.stringify(JSON.stringify([watched.id]))})`);
      await load();
      try {
        const end = Date.now() + 3000;
        while ((await listeners()) !== 1 && Date.now() < end) await page.wait(50);
        await page.wait(300);
        // The next answer about a watched task is given by the service at once, and takes a second and a half to arrive.
        await page.run("window.realFetch = window.fetch; let held = 1; window.fetch = async (url, options) => { const response = await window.realFetch(url, options); if (String(url).includes('/api/get') && held-- > 0) await new Promise((done) => setTimeout(done, 1500)); return response; };");
        await move(watched.id, "in_progress", "done");
        await page.wait(300);
        // Meanwhile the service stops letting this page in, and the page finds out.
        setValue(config, "auth.keyless_user", "");
        await page.run("document.getElementById('refresh').click()");
        await page.until("return document.getElementById('main').hidden && !document.getElementById('notice').hidden", "the key form");
        await page.wait(2000);
        assert.deepEqual(
          await page.run("return [document.querySelectorAll('.toast').length, Math.round(document.getElementById('toasts').getBoundingClientRect().height), /Answer arrives too late/.test(document.body.textContent)]"),
          [0, 0, false],
          "the late answer is not shown",
        );
      } finally {
        setValue(config, "auth.keyless_user", "agent1");
        await run("delete", { id: watched.id, version: (await run("get", { id: watched.id })).version });
        await page.run("if (window.realFetch) window.fetch = window.realFetch; localStorage.clear(); sessionStorage.clear()");
      }
    });

    it("leaves nothing on its way to the screen when the key is refused, and does not let itself back in", async () => {
      await page.size(1280, 900);
      const listeners = async () => ((await (await fetch(`${base}/api/admin/status`, { headers: { authorization: `Bearer ${adminKey}` } })).json()) as { listeners: number }).listeners;
      const reads = () => page.requests.filter((url) => /\/api\/(get|list-tasks|list-projects|events)$/.test(url)).length;
      const lockedOut = () => page.until("return document.getElementById('main').hidden && !document.getElementById('notice').hidden", "the key form", 4000);
      await load();
      try {
        // 1. A task's panel is being read when the key is refused: the answer arrives afterwards.
        await page.run("window.realFetch = window.fetch; let held = 1; window.fetch = async (url, options) => { const response = await window.realFetch(url, options); if (String(url).includes('/api/get') && held-- > 0) await new Promise((done) => setTimeout(done, 1500)); return response; };");
        await page.run(`document.querySelector('.card[data-id="${ids.address}"]').click()`);
        await page.wait(250);
        setValue(config, "auth.keyless_user", "");
        await page.run("document.getElementById('refresh').click()");
        await lockedOut();
        await page.wait(1900);
        assert.deepEqual(
          await page.run("return [document.getElementById('panel').hidden, document.getElementById('detail').textContent, document.title, /Address form/.test(document.body.textContent)]"),
          [true, "", "Vigile", false],
          "the answer that was on its way does not open the panel or name the task",
        );
        // 2. Locked out, the page does not read by itself when it is seen again, even though it would now be let in.
        setValue(config, "auth.keyless_user", "agent1");
        const before = reads();
        await page.run("document.dispatchEvent(new Event('visibilitychange'))");
        await page.wait(3600);
        assert.equal(reads(), before, "no reading and no listening while the key form is shown");
        assert.equal(await page.run<boolean>("return document.getElementById('main').hidden"), true, "the page is still locked: only the person lets it in again");
        assert.equal(await listeners(), 0);
        // The person does: the page shows the plan and listens again as it did.
        await page.run("window.fetch = window.realFetch; localStorage.setItem('vigile.auto-refresh', 'on')");
        await page.click("#notice button");
        await page.until("return !document.getElementById('main').hidden && document.querySelectorAll('.card').length > 0", "the board, once the page is let in again");
        await load();
        await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live", 5000);

        // 3. A card is travelling across the page when the key is refused: its copy goes at once.
        await move(ids.address!, "done");
        await page.until("return document.querySelectorAll('.card-ghost').length === 1", "the card to set off", 2000);
        setValue(config, "auth.keyless_user", "");
        await page.run("document.getElementById('refresh').click()");
        await lockedOut();
        assert.deepEqual(await page.run("return [document.querySelectorAll('.card-ghost').length, /Address form/.test(document.body.textContent)]"), [0, false], "nothing of the task is left travelling");
        assert.equal(await page.run<boolean>("return Boolean(window.vigileGraph)"), false, "and no graph is kept behind the scenes");
        assert.equal(await page.run<number>("return Math.round(document.getElementById('refresh').getBoundingClientRect().width)"), 0, "the refresh button is gone while only a key lets the page read");

        // 4. The key is refused while the graph is showing: the board behind it is emptied too.
        setValue(config, "auth.keyless_user", "agent1");
        await page.run("localStorage.removeItem('vigile.auto-refresh')");
        await page.click("#notice button");
        await page.until("return !document.getElementById('main').hidden && document.querySelectorAll('.card').length > 0", "the board, once the page is let in again");
        await page.click("#view-graph");
        await graphReady();
        assert.ok((await count(".card")) > 0, "the board's cards are still in the page, behind the graph");
        setValue(config, "auth.keyless_user", "");
        await page.run("document.getElementById('refresh').click()");
        await lockedOut();
        assert.deepEqual(
          await page.run("return [document.querySelectorAll('.card').length, document.getElementById('board').children.length, Boolean(window.vigileGraph), /Address form|Checkout|Website relaunch/.test(document.body.textContent)]"),
          [0, 0, false, false],
          "neither view keeps anything of the plan",
        );

        // 5. A load that was waiting its turn when the key was refused does not run afterwards and let the page in.
        setValue(config, "auth.keyless_user", "agent1");
        await page.click("#notice button");
        await page.until("return !document.getElementById('main').hidden", "the page, let in again");
        await page.click("#view-board");
        setValue(config, "auth.keyless_user", "");
        // The refusal takes a second to arrive. Meanwhile the plan is asked for again, which waits its turn, and the
        // service goes back to letting everyone in.
        await page.run("window.realFetch = window.fetch; let held = 3; window.fetch = async (url, options) => { const response = await window.realFetch(url, options); if (response.status === 401 && held-- > 0) await new Promise((done) => setTimeout(done, 1000)); return response; };");
        await page.run("document.getElementById('refresh').click()");
        await page.wait(150);
        await page.run("document.getElementById('refresh').click()");
        await page.wait(150);
        setValue(config, "auth.keyless_user", "agent1");
        await lockedOut();
        const after = reads();
        await page.wait(1500);
        assert.deepEqual([await page.run<boolean>("return document.getElementById('main').hidden"), reads()], [true, after], "the load that was waiting is dropped: the page stays locked and reads nothing");
        // Only the person lets it in.
        await page.click("#notice button");
        await page.until("return !document.getElementById('main').hidden && document.querySelectorAll('.card').length > 0", "the board, once the person connects");
      } finally {
        setValue(config, "auth.keyless_user", "agent1");
        await move(ids.address!, "open", "in_progress").catch(() => {});
        await page.run("if (window.realFetch) window.fetch = window.realFetch; localStorage.clear(); sessionStorage.clear()");
      }
    });

    it("keeps the key form when an attempt to get in does not reach the service, and gets in on the next try", async () => {
      await page.size(1280, 900);
      const reads = () => page.requests.filter((url) => /\/api\//.test(url)).length;
      const form = () =>
        page.run<{ text: string; input: boolean; kept: number; main: boolean; refresh: number }>(
          "const n = document.getElementById('notice'); const i = n.querySelector('input'); return { text: n.hidden ? '' : n.querySelector('span')?.textContent ?? n.textContent, input: Boolean(i), kept: i?.value.length ?? 0, main: document.getElementById('main').hidden, refresh: Math.round(document.getElementById('refresh').getBoundingClientRect().width) }",
        );
      await load();
      setValue(config, "auth.keyless_user", "");
      try {
        await page.run("document.getElementById('refresh').click()");
        await page.until("return document.getElementById('main').hidden && Boolean(document.querySelector('#notice input'))", "the key form", 4000);
        // The service cannot be reached when the key is given.
        await page.block(["*/api/*"]);
        await page.click("#notice input");
        await page.type(adminKey);
        await page.click("#notice button");
        await page.until("return /Cannot reach the service/.test(document.getElementById('notice').textContent)", "the page to say it could not reach the service", 4000);
        const stuck = await form();
        assert.match(stuck.text, /^Cannot reach the service\. Press Connect to try again\.$/);
        assert.deepEqual([stuck.input, stuck.kept > 10, stuck.main], [true, true, true], "the form is still there, with the key that was tried, and nothing of the plan is shown");
        await layout("with the key form after an attempt that did not reach the service");
        // The page does not try by itself: only the person lets it in.
        const before = reads();
        await page.wait(3600);
        assert.equal(reads(), before, "no attempt is made in the background while the page is locked");
        // The service is back: pressing Connect again, with the key still in the form, gets in.
        await page.block([]);
        await page.click("#notice button");
        await page.until("return !document.getElementById('main').hidden && document.querySelectorAll('.card').length > 0", "the board, on the next try", 5000);
        assert.equal(await text("#you"), "admin");
        assert.equal(await page.run<boolean>("return document.getElementById('notice').hidden"), true);
      } finally {
        await page.block([]);
        setValue(config, "auth.keyless_user", "agent1");
        await page.run("localStorage.clear(); sessionStorage.clear()");
      }
    });

    it("stops looking at the watched tasks, one after the other, the moment the key is refused", async () => {
      await page.size(1280, 900);
      const made: Array<{ id: string }> = [];
      for (const name of ["first", "second", "third"]) made.push(await run("create_task", { title: `Watched, the ${name}`, description: "d", project: "WEB" }));
      const asked = () => page.requests.filter((url) => url.endsWith("/api/get")).length;
      await load();
      await page.run(`sessionStorage.setItem('vigile.watching', ${JSON.stringify(JSON.stringify(made.map((task) => task.id)))})`);
      await load();
      try {
        assert.equal(await text("#watching"), "watching 3");
        await page.wait(1200);
        // The answer about the first watched task takes a second to arrive. Meanwhile the key is refused.
        await page.run("window.realFetch = window.fetch; let held = 1; window.fetch = async (url, options) => { const response = await window.realFetch(url, options); if (String(url).includes('/api/get') && held-- > 0) await new Promise((done) => setTimeout(done, 1000)); return response; };");
        const before = asked();
        await move(made[0]!.id, "in_progress");
        await page.until(`return true`, "a moment");
        const end = Date.now() + 2000;
        while (asked() === before && Date.now() < end) await page.wait(20);
        assert.equal(asked(), before + 1, "the first of the three is being read");
        setValue(config, "auth.keyless_user", "");
        await page.run("document.getElementById('refresh').click()");
        await page.until("return document.getElementById('main').hidden && Boolean(document.querySelector('#notice input'))", "the key form", 4000);
        await page.wait(1800);
        assert.equal(asked(), before + 1, "the other two are not asked for once the page is locked out");
        assert.equal(await count(".toast"), 0);
      } finally {
        setValue(config, "auth.keyless_user", "agent1");
        for (const task of made) await run("delete", { id: task.id, version: (await run("get", { id: task.id })).version });
        await page.run("if (window.realFetch) window.fetch = window.realFetch; localStorage.clear(); sessionStorage.clear()");
      }
    });

    it("shows a new instance with no data as empty, not broken", async () => {
      const emptyDirectory = mkdtempSync(join(tmpdir(), "vigile-browser-empty-"));
      const emptyConfig = join(emptyDirectory, "config.toml");
      initConfig(emptyConfig, { name: "empty", port: await freePort() });
      const empty = await startService({ loaded: loadConfig(emptyConfig, {}), log: () => {}, warn: () => {} });
      try {
        for (const width of [360, 1280]) {
          await page.size(width, 900, width < 640);
          for (const view of ["/", "/#graph"]) {
            await page.open("about:blank");
            await page.open(`${empty.urls.base}${view}`);
            await page.until("return document.getElementById('sync').textContent.startsWith('Updated')", "the empty page");
            assert.equal(await text("#projects"), "No projects yet.");
            assert.equal(await text("#empty"), "No tasks yet.");
            assert.equal(await count(".column"), 0);
            await layout(`on an empty instance at ${width}px, ${view}`);
          }
        }
        assert.deepEqual(page.errors, []);
      } finally {
        await empty.stop();
        rmSync(emptyDirectory, { recursive: true, force: true });
        await page.size(1280, 900);
      }
    });
  });

  /**
   * Zooming the board, on a service of its own with a small plan made for it: two groups at the top; a group that
   * sits inside both of them and holds a group which holds another; a task in two groups; a task that one group
   * holds directly and also through its sub-group; tasks in no group; and a second project in which nothing holds
   * anything. Eighteen tasks, five levels deep.
   */
  describe("zoom", () => {
    let zooDirectory: string;
    let zooConfig: string;
    let zoo: Service;
    const z: Record<string, string> = {};
    const plan = (operation: string, input: Record<string, unknown>) => zoo.engine.execute(operation, "agent1", input) as Promise<any>;
    const add = async (key: string, title: string, extra: Record<string, unknown> = {}) => (z[key] = (await plan("create_task", { title, description: "d", project: "ZOO", ...extra })).id as string);
    const to = async (id: string, ...statuses: string[]) => {
      let version = (await plan("get", { id })).version;
      for (const status of statuses) version = (await plan("set_task_status", { id, version, status })).version;
    };
    const open = async (path = "/") => {
      await page.open("about:blank");
      await page.open(`${zoo.urls.base}${path}`);
      await page.until("return /^(Updated|Live)/.test(document.getElementById('sync').textContent)", "the page to show its data");
    };
    const hash = () => page.run<string>("return location.hash");
    /** What the control above the board says, or nothing when it has stepped aside. */
    const level = () => page.run<string | null>("return document.getElementById('levels').hidden ? null : document.getElementById('level').textContent");
    /** Whether each end of the control says there is nothing further: out, in. */
    const ends = () => page.run<string[]>("return ['level-out', 'level-in'].map((id) => document.getElementById(id).getAttribute('aria-disabled'))");
    /** The cards on the board by their task, in order of ID, a closed group marked with a star. */
    const cards = () => page.run<string[]>("return [...document.querySelectorAll('#board .card')].map((c) => c.dataset.id + (c.matches('.closed') ? '*' : '')).sort()");
    const these = (...keys: string[]) => keys.map((key) => (key.endsWith("*") ? `${z[key.slice(0, -1)]}*` : z[key]!)).sort();
    const card = (key: string) => `document.querySelector('#board .card[data-id="${z[key]}"]')`;
    /** What a card says: its column, what it calls itself, its tags, its bar, and the button beside it that zooms in. */
    const says = (key: string) =>
      page.run<{ column: string; kind: string | null; tags: string[]; bar: string | null; button: string | null; name: string | null }>(
        `const card = ${card(key)}; const beside = card.nextElementSibling?.matches('.zoom-into') ? card.nextElementSibling : null;
         return { column: card.closest('.column').dataset.key, kind: card.querySelector('.kind')?.textContent ?? null, tags: [...card.querySelectorAll('.tag')].map((t) => t.textContent), bar: card.querySelector('.bar')?.getAttribute('aria-label') ?? null, button: beside ? [...beside.children].map((part) => part.textContent).join(' / ') : null, name: beside?.getAttribute('aria-label') ?? null }`,
      );
    const into = (key: string) => page.click(`#board .zoom-into[data-id="${z[key]}"]`);
    const trail = () => text("#scope");
    /** Which control has the keyboard: the task of a card or of a button beside one, with the button's class, or else its id or its class. */
    const focused = () => page.run<string>("const at = document.activeElement; return at.dataset?.id ? at.dataset.id + (at.matches('.zoom-into') ? ' zoom-into' : '') : at.id || at.className || at.tagName");
    /** Where the keyboard is, and whether that is something a person can see: never the page itself, never a hidden control. */
    const keyboard = () =>
      page.run<string>(
        "const at = document.activeElement; const seen = at !== document.body && at.getClientRects().length > 0 && getComputedStyle(at).visibility !== 'hidden'; const name = at.dataset?.id ? at.dataset.id + (at.matches('.zoom-into') ? ' zoom-into' : '') : at.id || at.className || at.tagName; return name + (seen ? '' : ' (not in sight)')",
      );
    const focusOn = (selector: string) => page.run(`document.querySelector(${JSON.stringify(selector)}).focus({ preventScroll: true })`);
    const on = (key: string) => `#board .card[data-id="${z[key]}"]`;
    const zoomOf = (key: string) => `#board .zoom-into[data-id="${z[key]}"]`;
    /** Goes back or forward in the browser's history, and waits for the address that is expected there. */
    const travel = async (direction: "back" | "forward", address: string) => {
      await page.run(`history.${direction}()`);
      await page.until(`return location.hash === ${JSON.stringify(address)}`, `${direction} to ${address}`);
    };
    /** Changes an item at its present version, as another client would. */
    const alter = async (operation: string, input: { id: string } & Record<string, unknown>) => plan(operation, { ...input, version: (await plan("get", { id: input.id })).version });
    const live = () => page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
    const TOP = ["alpha*", "beta*", "loose", "free", "f1", "f2"];
    const TWO = ["alpha", "beta", "loose", "free", "f1", "f2", "a1", "a2", "sub*", "both", "near", "b1"];
    const THREE = ["alpha", "beta", "loose", "free", "f1", "f2", "a1", "a2", "sub", "both", "near", "b1", "s1", "s2", "s3", "deep*"];
    const FOUR = ["alpha", "beta", "loose", "free", "f1", "f2", "a1", "a2", "sub", "both", "near", "b1", "s1", "s2", "s3", "deep", "pit*"];
    const ALL = ["alpha", "beta", "loose", "free", "f1", "f2", "a1", "a2", "sub", "both", "near", "b1", "s1", "s2", "s3", "deep", "pit", "d1"];

    before(async () => {
      zooDirectory = mkdtempSync(join(tmpdir(), "vigile-browser-test-zoom-"));
      zooConfig = join(zooDirectory, "config.toml");
      initConfig(zooConfig, { name: "zoom", port: await freePort() });
      zoo = await startService({ loaded: loadConfig(zooConfig, {}), log: () => {}, warn: () => {} });
      await plan("create_project", { title: "Zoo", prefix: "ZOO" });
      await plan("create_project", { title: "Flat", prefix: "FLAT" });
      await add("alpha", "Alpha", { priority: 3 });
      await add("a1", "First of alpha", { parent: z.alpha });
      await add("a2", "Second of alpha", { parent: z.alpha });
      await add("sub", "Shared sub-group", { parent: z.alpha });
      await add("s1", "Sub one", { parent: z.sub });
      await add("s2", "Sub two", { parent: z.sub, depends_on: [z.s1] });
      await add("s3", "Sub bug", { parent: z.sub, type: "bug" });
      await add("deep", "Deep group", { parent: z.sub });
      await add("pit", "Pit group", { parent: z.deep });
      await add("d1", "Deepest task", { parent: z.pit });
      await add("both", "In two groups", { parent: z.alpha });
      await add("near", "Near and far", { parent: z.alpha });
      await add("beta", "Beta");
      await add("b1", "Only of beta", { parent: z.beta });
      await add("loose", "In no group");
      z.free = (await plan("create_task", { title: "In no project", description: "d" })).id;
      await add("f1", "Flat one", { project: "FLAT" });
      await add("f2", "Flat two", { project: "FLAT" });
      // The task in two groups, the group in two groups, and the task that its group holds both directly and through the sub-group.
      await plan("add_link", { from: z.beta, type: "contains", to: z.both });
      await plan("add_link", { from: z.beta, type: "contains", to: z.sub });
      await plan("add_link", { from: z.sub, type: "contains", to: z.near });
      await to(z.a1!, "in_progress", "done");
      await to(z.a2!, "in_progress");
      await to(z.s3!, "in_progress");
    });

    after(async () => {
      await zoo?.stop();
      if (zooDirectory) rmSync(zooDirectory, { recursive: true, force: true });
    });

    it("shows everything unless zoomed out; each step out closes one more level of groups, whose cards then stand for what they hold, and each step in opens it again", async () => {
      await page.size(1440, 900);
      await open();
      // As the page opens, nothing is closed: every task has its card, as before there was a zoom.
      assert.deepEqual([await hash(), await level(), await ends()], ["", "Everything", ["false", "true"]]);
      assert.deepEqual(await cards(), these(...ALL));
      assert.equal(await count("#board .zoom-into, #board .kind, #board .holder"), 0);
      assert.match(await text("#summary"), /^18 tasks\s*2 in progress\s*14 next\s*1 waiting\s*1 done\s*1 open bug, issue or incident$/);
      assert.deepEqual((await says("alpha")).tags, ["1/11 done", "ZOO"], "an open group's card is the one it always had");
      await layout("on the board with everything shown and the zoom above it");

      // One step out closes the deepest groups, and only those.
      await page.click("#level-out");
      assert.deepEqual([await hash(), await level(), await ends()], ["#board?zoom=4", "4 levels", ["false", "false"]]);
      assert.deepEqual(await cards(), these(...FOUR));
      assert.deepEqual(await says("pit"), { column: "next", kind: "group", tags: ["0/1 done", `in ${z.deep}`, "ZOO"], bar: "0% finished", button: "Zoom in / holds 1 task", name: `Zoom into ${z.pit}: show only the 1 task it holds` });
      assert.match(await text("#summary"), /^17 cards for 18 tasks\s*2 in progress\s*13 next\s*1 waiting\s*1 done/);
      await page.click("#level-out");
      assert.deepEqual([await hash(), await level()], ["#board?zoom=3", "3 levels"]);
      assert.deepEqual(await cards(), these(...THREE));
      assert.equal((await says("deep")).button, "Zoom in / holds 2 tasks", "a closed group counts what it holds at any depth");

      // At two levels the task that Alpha holds directly, and also through its sub-group, is still there: it
      // shows as soon as one way to it is open. The sub-group stands for the rest of what it holds.
      await page.click("#level-out");
      assert.deepEqual([await hash(), await level()], ["#board?zoom=2", "2 levels"]);
      assert.deepEqual(await cards(), these(...TWO));
      assert.deepEqual((await says("sub")).tags, ["0/7 done", "1 in progress", "1 waiting", "1 open bug or issue", `in ${z.alpha}`, `in ${z.beta}`, "ZOO"]);
      assert.deepEqual((await says("near")).tags, [`in ${z.alpha}`, `in ${z.sub}`, "ZOO"]);
      assert.match(await text("#summary"), /^12 cards for 18 tasks\s*1 in progress\s*10 next\s*0 waiting\s*1 done$/, "the counts are of the cards, and the bug inside the closed group is not among them");

      // All the way out: the groups that are in nothing, and the tasks that are in no group.
      await page.click("#level-out");
      assert.deepEqual([await hash(), await level(), await ends()], ["#board?zoom=1", "Top level", ["true", "false"]]);
      assert.deepEqual(await cards(), these(...TOP));
      assert.deepEqual(await says("alpha"), {
        // A group's card stands in the column of the group's own state, at every zoom.
        column: "next",
        kind: "group",
        tags: ["1/11 done", "2 in progress", "1 waiting", "1 open bug or issue", "ZOO"],
        bar: "9% finished",
        button: "Zoom in / holds 11 tasks",
        name: `Zoom into ${z.alpha}: show only the 11 tasks it holds`,
      });
      // The group and the task that are in both groups are counted in each, and once in the total.
      assert.deepEqual((await says("beta")).tags, ["0/10 done", "1 in progress", "1 waiting", "1 open bug or issue", "ZOO"]);
      assert.match(await text("#summary"), /^6 cards for 18 tasks\s*0 in progress\s*6 next\s*0 waiting\s*0 done$/);
      assert.deepEqual(await columns(), { "In progress": 0, Next: 6, Done: 0 });
      assert.deepEqual(await page.run<string[]>("return [...document.querySelectorAll('.column[data-key=\"next\"] .card')].slice(0, 2).map((c) => c.dataset.id)"), [z.alpha, z.beta], "the closed groups come first in their column");
      await layout("on the board zoomed out to the top level");
      // There is nothing further out: the button says so and does nothing.
      assert.match(await page.run<string>("return document.getElementById('level-out').title"), /nothing further to zoom out to/);
      await page.click("#level-out");
      assert.deepEqual([await hash(), await level(), await cards()], ["#board?zoom=1", "Top level", these(...TOP)]);

      // And in again, a level at a time, back to every task.
      await page.click("#level-in");
      assert.deepEqual([await hash(), await cards()], ["#board?zoom=2", these(...TWO)]);
      for (const step of [3, 4]) {
        await page.click("#level-in");
        assert.equal(await hash(), `#board?zoom=${step}`);
      }
      await page.click("#level-in");
      assert.deepEqual([await hash(), await level(), await ends(), await cards()], ["#board", "Everything", ["false", "true"], these(...ALL)]);
      await page.click("#level-in");
      assert.equal(await hash(), "#board", "nothing further in");
      assert.deepEqual(page.errors, []);
    });

    it("zooms into one group from the button on its card, shows where it is as a trail that leads back out, and treats the panel's button as the same thing", async () => {
      await page.size(1440, 900);
      await open("/#board?zoom=1");
      // A click on the card itself opens its panel, as on any card.
      await page.click(`#board .card[data-id="${z.alpha}"]`);
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Alpha'", "the group's panel");
      assert.equal(await hash(), `#board/${z.alpha}?zoom=1`);
      assert.deepEqual(await cards(), these(...TOP), "and the board behind it stays as it was");
      await page.key("Escape");
      assert.equal(await hash(), "#board?zoom=1");

      // The button beside it zooms into the group: what it holds, with as many levels open as before.
      await into("alpha");
      assert.deepEqual([await hash(), await level(), await panelOpen()], [`#board?in=${z.alpha}&zoom=1`, "Top level", false]);
      assert.deepEqual(await cards(), these("a1", "a2", "sub*", "both", "near"));
      assert.match(await text("#summary"), /^5 cards for 11 tasks/);
      assert.equal(await trail(), `in all projects › ${z.alpha} · Alpha✕ leave group`);
      await layout("inside a group at its top level");
      await into("sub");
      assert.equal(await hash(), `#board?in=${z.alpha}/${z.sub}&zoom=1`);
      assert.deepEqual(await cards(), these("s1", "s2", "s3", "deep*", "near"));
      assert.equal(await trail(), `in all projects › ${z.alpha} › ${z.sub} · Shared sub-group✕ leave group`);
      await into("deep");
      await into("pit");
      // Four groups in: the trail shows the last three, and the board holds one task with nothing to zoom.
      assert.equal(await hash(), `#board?in=${z.alpha}/${z.sub}/${z.deep}/${z.pit}&zoom=1`);
      assert.equal(await trail(), `in all projects › … › ${z.sub} › ${z.deep} › ${z.pit} · Pit group✕ leave group`);
      assert.deepEqual([await cards(), await level()], [these("d1"), null]);
      assert.match(await text("#summary"), /^1 tasks/);
      await layout("four groups in");

      // The browser's Back zooms out a step at a time, and Forward in again.
      await page.run("history.back()");
      await page.until(`return location.hash === '#board?in=${z.alpha}/${z.sub}/${z.deep}&zoom=1'`, "one step back");
      assert.deepEqual([await cards(), await level()], [these("pit*"), "Top level"]);
      await page.run("history.back()");
      await page.until(`return location.hash === '#board?in=${z.alpha}/${z.sub}&zoom=1'`, "two steps back");
      assert.deepEqual(await cards(), these("s1", "s2", "s3", "deep*", "near"));
      await page.run("history.forward()");
      await page.until(`return location.hash === '#board?in=${z.alpha}/${z.sub}/${z.deep}&zoom=1'`, "one step forward");
      assert.deepEqual(await cards(), these("pit*"));

      // A step of the trail leads back out to that group, and "leave group" one step out.
      await page.click(`#scope .crumb[data-step="1"]`);
      assert.deepEqual([await hash(), await cards()], [`#board?in=${z.alpha}&zoom=1`, these("a1", "a2", "sub*", "both", "near")]);
      await into("sub");
      await page.click("#scope .leave");
      assert.equal(await hash(), `#board?in=${z.alpha}&zoom=1`);
      await into("sub");
      await page.click(`#scope .crumb[data-step="0"]`);
      assert.deepEqual([await hash(), await cards(), await trail()], ["#board?zoom=1", these(...TOP), "in all projects"]);

      // The level and the group are two halves of one thing: inside a group, the control opens the levels of that group.
      await into("alpha");
      await page.click("#level-in");
      assert.deepEqual([await hash(), await level()], [`#board?in=${z.alpha}&zoom=2`, "2 levels"]);
      assert.deepEqual(await cards(), these("a1", "a2", "sub", "both", "near", "s1", "s2", "s3", "deep*"));
      await page.click("#scope .leave");
      assert.deepEqual([await hash(), await cards()], ["#board?zoom=2", these(...TWO)], "and the level stays when the group is left");

      // With everything shown, the button in a group's panel does what it always did, and is now in the address.
      await open();
      await page.click(`#board .card[data-id="${z.beta}"]`);
      await page.until("return Boolean(document.querySelector('.open-group'))", "the group's panel");
      assert.equal(await text(".open-group"), "Show only this group (10 tasks)");
      await page.click(".open-group");
      assert.deepEqual([await hash(), await panelOpen(), await level()], [`#board?in=${z.beta}`, false, "Everything"]);
      assert.match(await text("#summary"), /^10 tasks/);
      // The task and the group that are in both groups are under this one too, and are one card each on the whole board.
      assert.deepEqual(await cards(), these("b1", "both", "sub", "s1", "s2", "s3", "deep", "pit", "d1", "near"));
      await page.click("#scope .leave");
      assert.deepEqual([await hash(), await cards()], ["#board", these(...ALL)]);
      assert.match(await text("#summary"), /^18 tasks/);
      // Opened from the panel of a group that is inside the one in view, the trail goes on; from elsewhere it starts anew.
      await open(`/#board/${z.sub}?in=${z.alpha}`);
      await page.until("return Boolean(document.querySelector('.open-group'))", "the panel of the sub-group");
      await page.click(".open-group");
      assert.equal(await hash(), `#board?in=${z.alpha}/${z.sub}`);
      await open(`/#board/${z.beta}?in=${z.alpha}`);
      await page.until("return Boolean(document.querySelector('.open-group'))", "the panel of another group");
      await page.click(".open-group");
      assert.equal(await hash(), `#board?in=${z.beta}`);
      assert.deepEqual(page.errors, []);
    });

    it("keeps the level and the group in the address: a reload and a shared link show the same board, the graph the same group, and an address that names what is not there is put right", async () => {
      await page.size(1280, 900);
      const inside = `#board?in=${z.alpha}/${z.sub}&zoom=1`;
      await open(`/${inside}`);
      assert.deepEqual([await hash(), await level(), await cards()], [inside, "Top level", these("s1", "s2", "s3", "deep*", "near")]);
      assert.equal(await trail(), `in all projects › ${z.alpha} › ${z.sub} · Shared sub-group✕ leave group`);
      // An item opened over a zoomed board has the zoom in its address too, and closing it leaves the zoom alone.
      await page.click(`#board .card[data-id="${z.s1}"]`);
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Sub one'", "a task's panel");
      assert.equal(await hash(), `#board/${z.s1}?in=${z.alpha}/${z.sub}&zoom=1`);
      await open(`/#board/${z.s1}?in=${z.alpha}/${z.sub}&zoom=1`);
      await page.until("return document.querySelector('.detail-title')?.textContent === 'Sub one'", "the task named in the address, after a reload");
      assert.deepEqual(await cards(), these("s1", "s2", "s3", "deep*", "near"));
      await page.key("Escape");
      assert.equal(await hash(), inside);

      // The graph shows the same group. The level is the board's alone, and is still there on the way back.
      assert.deepEqual(await page.run<string[]>("return ['view-board', 'view-graph'].map((id) => document.getElementById(id).getAttribute('href'))"), [inside, inside.replace("#board", "#graph")]);
      await page.click("#view-graph");
      await graphReady();
      assert.equal(await hash(), inside.replace("#board", "#graph"));
      assert.equal(await page.run<boolean>("return document.getElementById('levels').hidden"), true, "the board's zoom is not offered over the graph");
      assert.deepEqual(await page.run<string[]>("return window.vigileGraph.nodes('[kind = \"task\"]').map((n) => n.data('ref')).sort()"), these("s1", "s2", "s3", "deep", "near"), "the graph draws the group's tasks its own way: its groups closed");
      assert.match(await text("#summary"), /^7 tasks/, "and counts every task in the group");
      await page.click("#view-board");
      await page.until("return document.getElementById('board').getBoundingClientRect().height > 0", "the board");
      assert.deepEqual([await hash(), await level(), await cards()], [inside, "Top level", these("s1", "s2", "s3", "deep*", "near")]);

      // A group that is not there is left out of the address, and the board shows what the rest of it says.
      await open("/#board?in=NOPE-9&zoom=1");
      assert.deepEqual([await hash(), await cards(), await trail()], ["#board?zoom=1", these(...TOP), "in all projects"]);
      // A trail whose steps do not hold one another starts at the last one that does.
      await open(`/#board?in=${z.loose}/${z.alpha}/${z.sub}`);
      assert.equal(await hash(), `#board?in=${z.alpha}/${z.sub}`);
      await open(`/#board?in=${z.alpha}/${z.alpha}/NOPE-9`);
      assert.equal(await hash(), `#board?in=${z.alpha}`);
      // A step may hold the next through a group in between.
      await open(`/#board?in=${z.beta}/${z.deep}`);
      assert.deepEqual([await hash(), await cards()], [`#board?in=${z.beta}/${z.deep}`, these("pit", "d1")]);
      // A task that holds nothing can be named: the page says so, and there is a way out.
      await open(`/#board?in=${z.loose}`);
      assert.deepEqual([await text("#empty"), await count("#board .card"), await level()], [`${z.loose} holds no tasks.`, 0, null]);
      await layout("inside a task that holds nothing");
      await page.click("#scope .leave");
      assert.deepEqual([await hash(), await cards()], ["#board", these(...ALL)]);
      // More levels than the plan has is everything; what is not a number, or is cut off, is no zoom at all.
      for (const address of ["/#board?zoom=99", "/#board?zoom=0", "/#board?zoom=two&in=%E0%A4%A", "/#board?zoom", "/#board?&&=&in="]) {
        await open(address);
        assert.deepEqual([await level(), await cards(), await trail()], ["Everything", these(...ALL), "in all projects"], address);
      }
      await open("/#board?zoom=99");
      await page.click("#level-out");
      assert.equal(await hash(), "#board?zoom=4", "one step out of everything, whatever the address said before");
      // An address from before there was a zoom means what it meant.
      await open(`/#board/${z.a1}`);
      await page.until("return document.querySelector('.detail-title')?.textContent === 'First of alpha'", "a task named the old way");
      assert.deepEqual(await cards(), these(...ALL));
      assert.deepEqual(page.errors, []);
    });

    it("keeps a closed group in sight under the filter when something it holds matches, and says how many do", async () => {
      await page.size(1280, 900);
      await open("/#board?zoom=1");
      const filter = async (words: string) => {
        await page.click("#filter");
        await page.run("document.getElementById('filter').select()");
        if (words) await page.type(words);
        else await page.key("Backspace");
      };
      // Four tasks match, all of them inside both groups: each group stays, and says so.
      await filter("sub");
      assert.deepEqual(await cards(), these("alpha*", "beta*"));
      assert.deepEqual((await says("alpha")).tags, ["1/11 done", "4 inside match", "2 in progress", "1 waiting", "1 open bug or issue", "ZOO"]);
      assert.deepEqual((await says("beta")).tags.slice(0, 2), ["0/10 done", "4 inside match"]);
      assert.match(await text("#summary"), /^2 cards for 4 tasks\s*0 in progress\s*2 next/, "the cards stand for the four tasks that match, each counted once");
      await layout("zoomed out with a filter that matches inside closed groups");
      // One match inside one group: the other group goes.
      await filter("only of beta");
      assert.deepEqual(await cards(), these("beta*"));
      assert.equal((await says("beta")).tags[1], "1 inside matches");
      assert.match(await text("#summary"), /^1 card for 1 task\s*0 in progress/);
      // A group that matches by its own title says what matches inside it as well; a task in no group is found as ever.
      await filter("alpha");
      assert.deepEqual(await cards(), these("alpha*"));
      assert.equal((await says("alpha")).tags[1], "2 inside match");
      assert.match(await text("#summary"), /^1 card for 3 tasks/);
      await filter("in no");
      assert.deepEqual(await cards(), these("loose", "free"));
      // A level further in, the groups that are open are filtered like any card, and the closed one below stands for its matches.
      await filter("sub");
      await page.click("#level-in");
      assert.deepEqual(await cards(), these("sub*"));
      assert.equal((await says("sub")).tags[1], "3 inside match");
      await page.click("#level-out");
      await filter("zzz no such task");
      assert.deepEqual([await count("#board .card"), await text("#empty"), await level()], [0, 'No task matches "zzz no such task".', "Top level"], "the control stays when nothing matches: the levels are those of the plan");
      await filter("");
      assert.deepEqual(await cards(), these(...TOP));
      assert.match(await text("#summary"), /^6 cards for 18 tasks/);
    });

    it("goes by what is shown for the column of bugs, the line that says what is in view, and a project in which nothing holds anything", async () => {
      await page.size(1280, 900);
      await open("/#board?zoom=1");
      const bugs = () => page.run<string[]>("return [...document.querySelectorAll('.column[data-tone=\"bug\"] .card')].map((c) => c.dataset.id)");
      try {
        // The one unfinished bug is inside a closed group: the column for bugs has nothing to show, and the group says what it holds.
        await setting("bugs-apart");
        assert.deepEqual([await bugs(), await count(".column[data-tone='bug']")], [[], 0]);
        assert.equal(await count("#summary .tag.trouble"), 0);
        assert.ok((await says("alpha")).tags.includes("1 open bug or issue"));
        await page.click("#level-in");
        assert.deepEqual(await bugs(), [], "two levels: the bug is one level further down");
        await page.click("#level-in");
        assert.deepEqual([await bugs(), await text("#summary .tag.trouble")], [[z.s3], "1 open bug, issue or incident"]);
        await layout("at three levels with a column for bugs");
        await setting("bugs-apart");

        // With everything above the board folded away, the line that stays says how far the board is zoomed out.
        await open(`/#board?in=${z.alpha}&zoom=1`);
        await page.click("#focus");
        assert.equal(await text("#scope .scope-text"), `in all projects › ${z.alpha} · Alpha, top level only`);
        await page.click("#scope .leave");
        assert.equal(await text("#scope .scope-text"), "in all projects, top level only");
        assert.ok(await page.run<boolean>("return document.querySelector('.board-head').getBoundingClientRect().height > 0"), "the line is there for the zoom alone");
        await layout("zoomed out with everything above the board folded away");
        await open("/#board?zoom=3");
        assert.equal(await text("#scope .scope-text"), "in all projects, 3 levels deep");
        await open("/");
        assert.equal(await page.run<number>("return Math.round(document.querySelector('.board-head').getBoundingClientRect().height)"), 0, "with everything shown there is nothing to say");
        await page.click("#focus");
        assert.equal(await text("#scope .scope-text"), "in all projects");

        // In a project where nothing holds anything there is one level only: the control steps aside, and a level
        // asked for in the address shows every task.
        await open("/#board?zoom=1");
        const choose = (project: string) => page.run(`[...document.querySelectorAll('#projects .project-main')].find((main) => main.querySelector('.project-id').textContent === ${JSON.stringify(project)}).click()`);
        await choose("FLAT");
        assert.deepEqual([await level(), await cards(), await hash()], [null, these("f1", "f2"), "#board?zoom=1"]);
        assert.match(await text("#summary"), /^2 tasks/);
        await layout("in a project with nothing to zoom");
        // The levels are those of what is in view: in the other project the groups are back, closed as the address says.
        await choose("ZOO");
        assert.deepEqual([await level(), await cards()], ["Top level", these("alpha*", "beta*", "loose")]);
        assert.match(await text("#summary"), /^3 cards for 15 tasks/);
        assert.equal(await trail(), "in ZOO · Zoo");
        await into("alpha");
        assert.equal(await trail(), `in ZOO › ${z.alpha} · Alpha✕ leave group`, "inside a group the project is named by its ID, to leave room for the trail");
        await choose("ZOO");
        assert.deepEqual(page.errors, []);
      } finally {
        await page.run("for (const name of ['vigile.bugs-apart', 'vigile.focus']) localStorage.removeItem(name)");
      }
    });

    it("can be zoomed with the keyboard alone: the control and the button on a card are reached with Tab, show where the keyboard is, are named for a screen reader, and keep the keyboard as the board is drawn again", async () => {
      await page.size(1280, 900);
      await open();
      assert.deepEqual(
        await page.run("const group = document.getElementById('levels'); return [group.getAttribute('role'), group.getAttribute('aria-label'), document.getElementById('level-out').getAttribute('aria-label'), document.getElementById('level-in').getAttribute('aria-label')]"),
        ["group", "Zoom of the board: how many levels of groups are open", "Zoom out", "Zoom in"],
      );
      const ring = () => page.run<string>("const style = getComputedStyle(document.activeElement); return style.outlineStyle + ' ' + style.outlineWidth");
      // From the filter, Tab reaches the control; Enter and Space work it, and the keyboard stays on the button.
      await page.click("#filter");
      await page.key("Tab");
      assert.deepEqual([await focused(), await ring()], ["level-out", "solid 2px"]);
      await page.key("Enter");
      assert.deepEqual([await hash(), await focused()], ["#board?zoom=4", "level-out"]);
      for (let step = 0; step < 3; step++) await page.key("Enter");
      // At the end the button says there is nothing further, and is still where the keyboard is.
      assert.deepEqual([await hash(), await focused(), await ends()], ["#board?zoom=1", "level-out", ["true", "false"]]);
      await page.key("Enter");
      assert.equal(await hash(), "#board?zoom=1");
      await page.key("Tab");
      assert.deepEqual([await focused(), await ring()], ["level-in", "solid 2px"]);
      await page.key("Space");
      assert.deepEqual([await hash(), await focused()], ["#board?zoom=2", "level-in"]);
      await page.key("Tab", true);
      await page.key("Enter");
      assert.equal(await hash(), "#board?zoom=1");

      // On a closed group's card, Enter opens the panel; the next Tab is on the button that zooms in.
      await page.run(`${card("alpha")}.focus()`);
      await page.key("Enter");
      await page.until("return !document.getElementById('panel').hidden", "the panel, opened with Enter");
      await page.key("Escape");
      assert.equal(await focused(), z.alpha, "the keyboard is back on the card");
      await page.key("Tab");
      assert.deepEqual([await focused(), await ring()], [`${z.alpha} zoom-into`, "solid 2px"]);
      // Zoomed in, the keyboard is on the way back out; taking it, on the button it came from.
      await page.key("Enter");
      assert.deepEqual([await hash(), await focused()], [`#board?in=${z.alpha}&zoom=1`, "tag-button leave"]);
      assert.equal(await ring(), "solid 2px");
      await page.key("Enter");
      assert.deepEqual([await hash(), await focused()], ["#board?zoom=1", `${z.alpha} zoom-into`]);
      // A step of the trail is reached and shown the same way.
      await page.key("Enter");
      await page.run(`document.querySelector('#board .zoom-into[data-id="${z.sub}"]').focus()`);
      await page.key("Enter");
      // Back changes the leave button from Sub to Alpha. It is not the same control: the keyboard returns to the
      // button that represents Sub, so Enter would re-enter it rather than unexpectedly leave Alpha.
      await page.run("document.querySelector('#scope .leave').focus({ preventScroll: true }); history.back()");
      await page.until(`return location.hash === '#board?in=${z.alpha}&zoom=1'`, "Back from Sub to Alpha");
      assert.equal(await focused(), `${z.sub} zoom-into`);
      await page.key("Enter");
      await page.key("Tab", true);
      assert.deepEqual([await page.run<string>("return document.activeElement.textContent"), await ring()], [z.alpha, "solid 2px"]);
      await page.key("Enter");
      assert.deepEqual([await hash(), await focused()], [`#board?in=${z.alpha}&zoom=1`, `${z.sub} zoom-into`]);
      assert.deepEqual(page.errors, []);
    });

    it("reveals the closed group that represents a focused child beyond a column's card limit", async () => {
      await page.size(1280, 900);
      const made: string[] = [];
      try {
        for (let n = 0; n < 13; n++) {
          const group = (await plan("create_task", { title: `Focus holder ${n}`, description: "d", project: "ZOO" })).id as string;
          const child = (await plan("create_task", { title: `Focus child ${n}`, description: "d", parent: group })).id as string;
          made.push(child, group);
        }
        const target = made.at(-2)!;
        const holder = made.at(-1)!;
        await to(target, "in_progress", "in_review");
        await open();
        await page.run("localStorage.setItem('vigile.scroll', 'page')");
        await open();
        await page.run("const more = document.querySelector('.column[data-key=\"next\"] .more[aria-expanded=\"true\"]'); more?.click()");
        // Keep the keyboard on the child while the board closes to its top level. Its holder is after the first
        // twelve cards in Next, so restoring focus must open that column and render the holder first.
        await page.run(`document.querySelector('#board .card[data-id="${target}"]').focus({ preventScroll: true }); for (let n = 0; n < 4; n++) document.getElementById('level-out').click()`);
        await page.until("return location.hash === '#board?zoom=1'", "the top level with the child represented by its group");
        assert.deepEqual([await focused(), await page.run("return document.querySelector('.column[data-key=\"next\"] .more')?.getAttribute('aria-expanded')")], [holder, "true"]);
      } finally {
        await page.run("localStorage.removeItem('vigile.scroll')");
        for (const id of made) {
          const item = await plan("get", { id });
          if (!item.deleted_at) await plan("delete", { id, version: item.version });
        }
        await open();
      }
    });

    it("shows a change inside a closed group on the group's card, in place and ringed, plays the sounds as ever, and moves the card when the group itself changes state", async () => {
      await page.size(1280, 900);
      await open("/#board?zoom=1");
      const COUNT = "window.notes = 0; const start = OscillatorNode.prototype.start; OscillatorNode.prototype.start = function (...args) { window.notes++; return start.apply(this, args); };";
      const ringed = () => page.run<string[]>("return [...document.querySelectorAll('#board .card.changed')].map((c) => c.dataset.id).sort()");
      const calm = () => page.until("return document.querySelectorAll('#board .card.changed, .card-ghost').length === 0", "the rings to fade", 12_000);
      try {
        await page.run(COUNT);
        await setting("sound-started");
        assert.equal(await page.run<number>("return window.notes"), 2, "turning the sound on plays it once");
        await setting("auto");
        await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
        await page.run("window.ghosts = 0; new MutationObserver((changes) => { for (const c of changes) for (const n of c.addedNodes) if (n.classList?.contains('card-ghost')) window.ghosts++; }).observe(document.body, { childList: true });");
        // The keyboard is on the button of a group that is about to change.
        await page.run(`document.querySelector('#board .zoom-into[data-id="${z.alpha}"]').focus({ preventScroll: true })`);

        // A task two groups down is started. It has no card; the two groups that hold it say so, where they stand.
        await to(z.s1!, "in_progress");
        await page.until(`return ${card("alpha")}.querySelector('.tag.inside').textContent === '3 in progress'`, "the change to show on the group's card", 3000);
        assert.deepEqual(await ringed(), these("alpha", "beta"), "both groups that hold the task are ringed");
        assert.deepEqual([(await says("alpha")).column, (await says("beta")).tags[1], await cards()], ["next", "2 in progress", these(...TOP)]);
        assert.equal(await page.run<number>("return window.ghosts"), 0, "nothing travels: no card changed column");
        assert.equal(await focused(), `${z.alpha} zoom-into`, "the keyboard is still on the same button");
        assert.match(await text("#summary"), /^6 cards for 18 tasks\s*0 in progress\s*6 next/, "the counts above the board are still those of its cards");
        await page.until("return window.notes === 4", "the sound for a started task, though the task has no card", 2500);
        await calm();

        // A task inside is finished: the group's progress moves, and the card is ringed again.
        await to(z.s1!, "done");
        await page.until(`return ${card("alpha")}.querySelector('.tag.group').textContent === '2/11 done'`, "the progress to show on the group's card", 3000);
        assert.deepEqual([await ringed(), (await says("alpha")).bar, (await says("alpha")).tags.slice(0, 3)], [these("alpha", "beta"), "18% finished", ["2/11 done", "2 in progress", "1 open bug or issue"]]);
        assert.equal(await page.run<number>("return window.notes"), 4, "only the sound that is switched on is played");
        await calm();

        // A change that leaves what the card says as it was does not ring it: a task inside gets another title.
        await plan("update_task", { id: z.b1, version: (await plan("get", { id: z.b1 })).version, title: "Only one of beta" });
        await page.wait(900);
        assert.deepEqual(await ringed(), []);

        // Under reduced motion the ring is there all the same, around the whole card.
        await page.motion("reduce");
        await to(z.a2!, "in_review");
        await page.until(`return ${card("alpha")}.querySelector('.tag.inside').textContent === '1 in progress'`, "the change to show under reduced motion", 3000);
        assert.deepEqual(await ringed(), these("alpha"));
        assert.match(await page.run<string>(`return getComputedStyle(${card("alpha")}).boxShadow`), /^[a-z]+\([^)]*\) 0px 0px 0px 3px$/);
        await page.motion("no-preference");
        await calm();

        // The group itself is started: its card travels to the column of its new state, and is a closed group there too.
        await to(z.beta!, "in_progress");
        await page.until(`return ${card("beta")}?.closest('.column').dataset.key === 'in_progress'`, "the group's card in its new column", 3000);
        assert.ok((await page.run<number>("return window.ghosts")) >= 1, "the card travels");
        assert.deepEqual(await page.run<string[]>(`const card = ${card("beta")}; return [card.style.visibility, card.nextElementSibling.style.visibility]`), ["hidden", "hidden"], "while the copy travels, the button waits unseen with its card");
        await calm();
        assert.deepEqual([await cards(), (await says("beta")).button], [these(...TOP), "Zoom in / holds 10 tasks"]);
        assert.deepEqual(await page.run<string[]>(`const card = ${card("beta")}; return [card.style.visibility, card.nextElementSibling.style.visibility]`), ["", ""]);

        // A group in view is deleted while the board is in it: the board is then in the group before it.
        await open(`/#board?in=${z.alpha}/${z.sub}/${z.deep}/${z.pit}&zoom=1`);
        await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
        await plan("delete", { id: z.pit, version: (await plan("get", { id: z.pit })).version });
        await page.until(`return location.hash === '#board?in=${z.alpha}/${z.sub}/${z.deep}&zoom=1'`, "the board to step out of the group that is gone", 3000);
        assert.equal(await count("#board .card.changed"), 0, "the cards that are there now did not change");
        await plan("restore", { id: z.pit });
        assert.deepEqual(page.errors, []);
      } finally {
        await page.motion("no-preference");
        await to(z.s1!, "open").catch(() => {});
        await to(z.a2!, "in_progress").catch(() => {});
        await to(z.beta!, "open").catch(() => {});
        await plan("update_task", { id: z.b1, version: (await plan("get", { id: z.b1 })).version, title: "Only of beta" }).catch(() => {});
        await page.run("for (const name of ['vigile.auto-refresh', 'vigile.sound-started']) localStorage.removeItem(name)");
      }
    });

    it("rings the card of a closed group when the plan changes anything the card shows, and not when the filter or the zoom the person works themselves changes it", async () => {
      await page.size(1280, 900);
      const ringed = () => page.run<string[]>("return [...document.querySelectorAll('#board .card.changed')].map((c) => c.dataset.id).sort()");
      /** Opens the board afresh at its top level, so that no card is ringed from before, and waits until it follows the plan. */
      const afresh = async () => {
        await open("/#board?zoom=1");
        await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
        assert.deepEqual(await ringed(), []);
      };
      const type = async (words: string) => {
        await page.click("#filter");
        await page.run("document.getElementById('filter').select()");
        if (words) await page.type(words);
        else await page.key("Backspace");
      };
      const change = alter;
      /** Waits until the board shows a change made in the plan, and says which cards are ringed for it. */
      const shows = async (what: string, script: string) => {
        await page.until(script, what, 3000);
        return ringed();
      };
      const undo: Array<() => Promise<unknown>> = [];
      try {
        await open("/#board?zoom=1");
        await setting("auto");
        await afresh();

        // What the person changes themselves rings nothing, though the cards say something else after it: the filter,
        // letter by letter, the level, a group entered and left.
        for (const words of ["a", "al", "alp", "alpha", "alph", ""]) {
          await type(words);
          assert.deepEqual(await ringed(), [], `after typing "${words}"`);
        }
        await type("sub");
        assert.equal((await says("alpha")).tags[1], "4 inside match");
        await type("");
        for (const control of ["#level-in", "#level-in", "#level-out", "#level-out"]) {
          await page.click(control);
          assert.deepEqual(await ringed(), [], `after ${control}`);
        }
        await into("alpha");
        await page.click("#scope .leave");
        assert.deepEqual([await ringed(), await cards()], [[], these(...TOP)]);

        // How many inside match the filter: a task inside is renamed and now matches. The group that already showed
        // says one more, and is ringed; the other group comes into sight for it.
        await type("alpha");
        assert.deepEqual([await cards(), (await says("alpha")).tags[1]], [these("alpha*"), "2 inside match"]);
        await change("update_task", { id: z.near!, title: "Alpha child" });
        undo.push(() => change("update_task", { id: z.near!, title: "Near and far" }));
        assert.deepEqual(await shows("one more match inside", `return ${card("alpha")}.querySelector('.tag.match').textContent === '3 inside match'`), these("alpha", "beta"));
        // Under the same filter, a change inside that leaves every count as it was rings nothing.
        await afresh();
        await type("alpha");
        await change("update_task", { id: z.b1!, title: "Only one of beta" });
        undo.push(() => change("update_task", { id: z.b1!, title: "Only of beta" }));
        await page.wait(900);
        assert.deepEqual([await ringed(), (await says("alpha")).tags[1]], [[], "3 inside match"]);
        await undo.pop()!();
        await undo.pop()!();

        // The group's own title.
        await afresh();
        await change("update_task", { id: z.alpha!, title: "Alpha, renamed" });
        undo.push(() => change("update_task", { id: z.alpha!, title: "Alpha" }));
        assert.deepEqual(await shows("the new title", `return ${card("alpha")}.querySelector('.card-title').textContent === 'Alpha, renamed'`), these("alpha"));
        await undo.pop()!();
        // Its priority, which is also its place among the closed groups of its column: it was first, and comes second.
        await afresh();
        assert.deepEqual(await page.run<string[]>("return [...document.querySelectorAll('.column[data-key=\"next\"] .card.closed')].map((c) => c.dataset.id)"), [z.alpha, z.beta]);
        await change("update_task", { id: z.beta!, priority: 7 });
        undo.push(() => change("update_task", { id: z.beta!, priority: 0 }));
        assert.deepEqual(await shows("the new priority", `return ${card("beta")}.querySelector('.priority')?.textContent === 'P7'`), these("beta"));
        assert.deepEqual(await page.run<string[]>("return [...document.querySelectorAll('.column[data-key=\"next\"] .card.closed')].map((c) => c.dataset.id)"), [z.beta, z.alpha], "the group that slid down for it is not ringed");
        await undo.pop()!();
        // Its kind: the group becomes an issue, and its card carries the mark.
        await afresh();
        await change("update_task", { id: z.alpha!, type: "issue" });
        undo.push(() => change("update_task", { id: z.alpha!, type: "task" }));
        assert.deepEqual(await shows("the mark of its kind", `return ${card("alpha")}.querySelector('.type')?.textContent === 'issue'`), these("alpha"));
        await undo.pop()!();

        // A problem inside: a task that is in progress comes to depend on one that is not finished.
        await afresh();
        await plan("add_link", { from: z.a2, type: "depends on", to: z.loose });
        undo.push(() => plan("remove_link", { from: z.a2, type: "depends on", to: z.loose }));
        assert.deepEqual(await shows("the problem inside", `return ${card("alpha")}.querySelector('.tag.warn')?.textContent === '⚠ 1 problem inside'`), these("alpha"));
        await undo.pop()!();
        // An unfinished bug inside: the task in both groups becomes one, and both groups say two.
        await afresh();
        await change("update_task", { id: z.both!, type: "bug" });
        undo.push(() => change("update_task", { id: z.both!, type: "task" }));
        assert.deepEqual(await shows("one more open bug inside", `return ${card("beta")}.querySelector('.tag.trouble')?.textContent === '2 open bugs and issues'`), these("alpha", "beta"));
        await undo.pop()!();
        // How many it holds: a task is created four groups down.
        await afresh();
        const extra = (await plan("create_task", { title: "One more, far down", description: "d", project: "ZOO", parent: z.pit })).id as string;
        undo.push(() => change("delete", { id: extra }));
        assert.deepEqual(await shows("one more task inside", `return ${card("alpha")}.nextElementSibling.querySelector('.holds').textContent === 'holds 12 tasks'`), these("alpha", "beta"));
        assert.deepEqual([(await says("alpha")).tags[0], (await says("beta")).button], ["1/12 done", "Zoom in / holds 11 tasks"]);
        await undo.pop()!();

        // Its place among the finished, which goes by when it was completed and is written nowhere on the card: a
        // finished group's completion is set to an earlier day.
        const gamma = (await plan("create_task", { title: "Gamma", description: "d", project: "ZOO" })).id as string;
        const inGamma = (await plan("create_task", { title: "Only of gamma", description: "d", project: "ZOO", parent: gamma })).id as string;
        undo.push(() => change("delete", { id: gamma }));
        undo.push(() => change("delete", { id: inGamma }));
        await to(inGamma, "in_progress", "done");
        await to(gamma, "in_progress", "done");
        await afresh();
        assert.deepEqual(await page.run<string[]>("return [...document.querySelectorAll('.column[data-key=\"done\"] .card')].map((c) => c.dataset.id + (c.matches('.closed') ? '*' : ''))"), [`${gamma}*`]);
        z.gamma = gamma;
        const drawn = await says("gamma");
        const { created_at } = await plan("get", { id: gamma });
        await change("override_timestamp", { id: gamma, name: "completed_at", value: created_at });
        await page.until(`return ${card("gamma")}.classList.contains('changed')`, "the finished group to be ringed for its new completion date", 3000);
        assert.deepEqual(await says("gamma"), drawn, "nothing written on the card changed");
        assert.deepEqual(page.errors, []);
      } finally {
        for (const step of undo.reverse()) await step().catch(() => {});
        await page.run("localStorage.removeItem('vigile.auto-refresh')");
      }
    });

    it("keeps the keyboard on the same item, or on the group that closes over it, when the board is zoomed with Back and Forward, when a group is left, and when the board's zoom steps aside", async () => {
      await page.size(1280, 900);
      // Zooming out with the browser's Back while the keyboard is on a card: the group that closes over the card
      // has the keyboard, and the nearest one that does when two levels close one after the other.
      await open("/#board?zoom=1");
      await page.click("#level-in");
      await page.click("#level-in");
      await focusOn(on("s1"));
      await travel("back", "#board?zoom=2");
      assert.equal(await keyboard(), z.sub, "the closed group that now holds the task");
      await focusOn(zoomOf("sub"));
      await travel("back", "#board?zoom=1");
      assert.equal(await keyboard(), z.alpha, "the closed group that now holds the group");
      // Zooming in: a closed group opens, and the button that zoomed into it is gone. The group's own card has the keyboard.
      await focusOn(zoomOf("alpha"));
      await travel("forward", "#board?zoom=2");
      assert.equal(await keyboard(), z.alpha);
      // Into a group and back out with Back and Forward, the keyboard still on what was pressed: the way out of
      // the group stands for it while the board is in it, and its button when it is back on the board.
      await travel("back", "#board?zoom=1");
      await focusOn(zoomOf("alpha"));
      await page.key("Enter");
      assert.deepEqual([await hash(), await keyboard()], [`#board?in=${z.alpha}&zoom=1`, "tag-button leave"]);
      await travel("back", "#board?zoom=1");
      assert.equal(await keyboard(), `${z.alpha} zoom-into`);
      await travel("forward", `#board?in=${z.alpha}&zoom=1`);
      assert.equal(await keyboard(), "tag-button leave");

      // Leaving a group with everything shown: the group's card, which has no button to zoom.
      await open(`/#board?in=${z.alpha}/${z.sub}`);
      await focusOn("#scope .leave");
      await page.key("Enter");
      assert.deepEqual([await hash(), await keyboard()], [`#board?in=${z.alpha}`, z.sub]);

      // The board's zoom steps aside where nothing holds anything: the keyboard was on it, and is on the way out of the group.
      await open(`/#board?in=${z.alpha}/${z.sub}/${z.deep}&zoom=1`);
      await focusOn(zoomOf("pit"));
      await page.key("Enter");
      await travel("back", `#board?in=${z.alpha}/${z.sub}/${z.deep}&zoom=1`);
      await focusOn("#level-in");
      await travel("forward", `#board?in=${z.alpha}/${z.sub}/${z.deep}/${z.pit}&zoom=1`);
      assert.deepEqual([await level(), await keyboard()], [null, "tag-button leave"]);
      assert.deepEqual(page.errors, []);
    });

    it("leaves a group over the graph, and changes view, with the keyboard on something in sight: the way out of the group that is left, or the line that says what is in view", async () => {
      await page.size(1280, 900);
      // The board has drawn its top level and is hidden behind the graph, with its cards still in it. A group is
      // entered from its panel and left again: the hidden card of that group cannot take the keyboard, and the
      // line that says what is in view does.
      await open("/#board?zoom=1");
      await page.click("#view-graph");
      await graphReady();
      assert.equal(await count(zoomOf("alpha")), 1, "the hidden board still holds its cards");
      await page.run(`location.hash = '#graph/${z.alpha}?zoom=1'`);
      await page.until("return Boolean(document.querySelector('.open-group'))", "the group's panel over the graph");
      await page.click(".open-group");
      assert.deepEqual([await hash(), await keyboard()], [`#graph?in=${z.alpha}&zoom=1`, "tag-button leave"]);
      await page.key("Enter");
      assert.deepEqual([await hash(), await keyboard()], ["#graph?zoom=1", "scope-text"]);
      assert.match(await page.run<string>("const style = getComputedStyle(document.activeElement); return style.outlineStyle + ' ' + style.outlineWidth"), /^solid 2px$/, "and the line shows that the keyboard is there");
      // The line is written again with every drawing, and keeps the keyboard.
      await page.run("document.getElementById('hide-finished').click(); document.getElementById('hide-finished').click()");
      assert.equal(await keyboard(), "scope-text");

      // Two groups in: leaving one, the keyboard is on the way out of the group the graph is still in.
      await open("/#board?zoom=1");
      await focusOn(zoomOf("alpha"));
      await page.key("Enter");
      await focusOn(zoomOf("sub"));
      await page.key("Enter");
      await page.click("#view-graph");
      await graphReady();
      await focusOn("#scope .leave");
      await page.key("Enter");
      assert.deepEqual([await hash(), await keyboard()], [`#graph?in=${z.alpha}&zoom=1`, "tag-button leave"]);
      await page.key("Enter");
      assert.deepEqual([await hash(), await keyboard()], ["#graph?zoom=1", "scope-text"]);
      // The same from a step of the trail, which leads out of two groups at once.
      await travel("back", `#graph?in=${z.alpha}&zoom=1`);
      await travel("back", `#graph?in=${z.alpha}/${z.sub}&zoom=1`);
      await focusOn(`#scope .crumb[data-step="0"]`);
      await page.key("Enter");
      assert.deepEqual([await hash(), await keyboard()], ["#graph?zoom=1", "scope-text"]);

      // A change of view under the keyboard, with Back and Forward: from the graph's tools to the board, the
      // board's zoom; from a card of the board to the graph, the way out of the group.
      await travel("back", `#graph?in=${z.alpha}/${z.sub}&zoom=1`);
      await focusOn("#collapse-groups");
      await travel("back", `#board?in=${z.alpha}/${z.sub}&zoom=1`);
      assert.equal(await keyboard(), "level-in");
      await focusOn(on("s1"));
      await travel("forward", `#graph?in=${z.alpha}/${z.sub}&zoom=1`);
      assert.equal(await keyboard(), "tag-button leave");
      assert.deepEqual(page.errors, []);
    });

    it("keeps the keyboard in sight when the plan changes under it: on a group's button to zoom while the group changes column, on the group that closes over a card, on a card that lands at once, and on the board's zoom when nothing stands for what is gone", async () => {
      await page.size(1280, 900);
      const undo: Array<() => Promise<unknown>> = [];
      const back = () => page.until(`return document.querySelector(${JSON.stringify(on("b1"))}) !== null && document.querySelector(${JSON.stringify(on("near"))}) !== null`, "the cards to be back", 3000);
      const gone = (key: string) => page.until(`return document.querySelector(${JSON.stringify(on(key))}) === null`, "the card to go", 3000);
      try {
        await open("/#board?zoom=1");
        await setting("auto");
        await live();
        await page.run("window.ghosts = 0; new MutationObserver((changes) => { for (const c of changes) for (const n of c.addedNodes) if (n.classList?.contains('card-ghost')) window.ghosts++; }).observe(document.body, { childList: true });");
        // A closed group changes column while the keyboard is on its button to zoom: the button stays in sight with
        // the keyboard on it, nothing travels, and the card is ringed where it now stands.
        await focusOn(zoomOf("beta"));
        await to(z.beta!, "in_progress");
        undo.push(() => to(z.beta!, "open"));
        await page.until(`return document.querySelector(${JSON.stringify(on("beta"))})?.closest('.column').dataset.key === 'in_progress'`, "the group's card in its new column", 3000);
        assert.deepEqual([await keyboard(), await page.run<number>("return window.ghosts")], [`${z.beta} zoom-into`, 0]);
        assert.deepEqual(await page.run(`const card = document.querySelector(${JSON.stringify(on("beta"))}); return [card.style.visibility, card.nextElementSibling.style.visibility, card.classList.contains('changed')]`), ["", "", true]);
        await page.key("Enter");
        assert.equal(await hash(), `#board?in=${z.beta}&zoom=1`, "and Enter still zooms into the group");
        await undo.pop()!();

        // A card with the keyboard goes deeper than the board shows: the task that Alpha held directly is now held
        // by its sub-group only. The closed sub-group has the keyboard.
        await open("/#board?zoom=2");
        await live();
        await focusOn(on("near"));
        await plan("remove_link", { from: z.alpha, type: "contains", to: z.near });
        undo.push(() => plan("add_link", { from: z.alpha, type: "contains", to: z.near }));
        await gone("near");
        assert.equal(await keyboard(), z.sub);
        await undo.pop()!();
        // A card with the keyboard is gone for good: its task is deleted, and nothing stands for it. The board's zoom has the keyboard.
        await back();
        await focusOn(on("b1"));
        await alter("delete", { id: z.b1! });
        undo.push(() => plan("restore", { id: z.b1 }));
        await gone("b1");
        assert.equal(await keyboard(), "level-in");
        await undo.pop()!();
        // The same when the panel was opened from that card and is closed after the card has gone: the panel's own
        // rule gives the keyboard back to what the panel was opened from, and now to what stands for that.
        await back();
        await focusOn(on("b1"));
        await page.key("Enter");
        await page.until("return document.querySelector('.detail-title')?.textContent === 'Only of beta'", "the panel, opened with Enter");
        await alter("delete", { id: z.b1! });
        undo.push(() => plan("restore", { id: z.b1 }));
        await gone("b1");
        assert.equal(await page.run<boolean>("return document.getElementById('panel').contains(document.activeElement)"), true, "while the panel is open the keyboard stays in it");
        await page.key("Escape");
        assert.deepEqual([await panelOpen(), await keyboard()], [false, "level-in"]);
        await undo.pop()!();
        // The filter hides a card with the keyboard: its task is renamed and no longer matches.
        await back();
        await page.click("#filter");
        await page.type("only of");
        assert.deepEqual(await cards(), these("b1"));
        await focusOn(on("b1"));
        await alter("update_task", { id: z.b1!, title: "The one of beta" });
        undo.push(() => alter("update_task", { id: z.b1!, title: "Only of beta" }));
        await gone("b1");
        assert.deepEqual([await count("#board .card"), await keyboard()], [0, "level-in"]);
        await undo.pop()!();

        // A card is on its way to another column, unseen where it will land while its copy travels, when the keyboard
        // has to go to it: it lands at once, in sight, with the keyboard on it.
        await open("/#board?zoom=1");
        await live();
        await page.click("#level-in");
        await focusOn(on("a1"));
        await to(z.alpha!, "in_progress");
        undo.push(() => to(z.alpha!, "open"));
        await page.until(`return document.querySelectorAll('.card-ghost').length === 1 && document.querySelector(${JSON.stringify(on("alpha"))}).style.visibility === 'hidden'`, "the group's card to set off", 3000);
        await travel("back", "#board?zoom=1");
        assert.equal(await keyboard(), z.alpha, "the closed group that now holds the task, landed");
        assert.deepEqual(await page.run(`const card = document.querySelector(${JSON.stringify(on("alpha"))}); return [card.style.visibility, card.nextElementSibling.style.visibility, document.querySelectorAll('.card-ghost').length]`), ["", "", 0]);
        await undo.pop()!();

        // A step of the trail goes because the group after it is deleted: the keyboard was on the step that named
        // the group the board is now in, and is on the way out of that group.
        await open(`/#board?in=${z.alpha}/${z.sub}/${z.deep}&zoom=1`);
        await live();
        await focusOn(`#scope .crumb[data-step="2"]`);
        assert.equal(await page.run<string>("return document.activeElement.textContent"), z.sub);
        await alter("delete", { id: z.deep! });
        undo.push(() => plan("restore", { id: z.deep }));
        await page.until(`return location.hash === '#board?in=${z.alpha}/${z.sub}&zoom=1'`, "the board to step out of the group that is gone", 3000);
        assert.equal(await keyboard(), "tag-button leave");
        await undo.pop()!();
        assert.deepEqual(page.errors, []);
      } finally {
        for (const step of undo.reverse()) await step().catch(() => {});
        await page.run("localStorage.removeItem('vigile.auto-refresh')");
      }
    });

    it("says a zoom, a group entered and a group left to a screen reader once and in a few words, and nothing when the board is only filtered or drawn again", async () => {
      await page.size(1280, 900);
      await open();
      // Everything the page says by itself, in the order it was said: the regions a screen reader reads out when
      // they change. The header's own line, which says when the page was last updated, is left out.
      const listen = () =>
        page.run(`window.said = []; new MutationObserver((changes) => {
          for (const change of changes) {
            const region = (change.target.nodeType === 1 ? change.target : change.target.parentElement)?.closest('[aria-live], [role="status"], [role="alert"]');
            if (region && region.id !== 'sync' && region.textContent.trim()) window.said.push(region.id + ': ' + region.textContent.trim());
          }
        }).observe(document.body, { subtree: true, childList: true, characterData: true });`);
      await listen();
      const said = async () => {
        await page.wait(80);
        return page.run<string[]>("const all = window.said; window.said = []; return all");
      };
      // Neither the cards nor the counts nor the trail are read out when they change: only what is said on purpose.
      assert.deepEqual(await page.run("return ['board', 'summary', 'scope', 'level'].map((id) => document.getElementById(id).closest('[aria-live], [role=\"status\"], [role=\"alert\"]') === null)"), [true, true, true, true]);
      // The level is read with each of the two buttons instead.
      assert.deepEqual(await page.run("return ['level-out', 'level-in'].map((id) => document.getElementById(id).getAttribute('aria-describedby'))"), ["level", "level"]);

      await page.click("#level-out");
      assert.deepEqual(await said(), ["zoom-said: 4 levels in all projects: 17 cards for 18 tasks."]);
      for (let more = 0; more < 3; more++) await page.click("#level-out");
      assert.deepEqual(await said(), ["zoom-said: 3 levels in all projects: 16 cards for 18 tasks.", "zoom-said: 2 levels in all projects: 12 cards for 18 tasks.", "zoom-said: Top level in all projects: 6 cards for 18 tasks."]);
      await page.click("#level-out");
      assert.deepEqual(await said(), [], "nothing further out, and nothing to say");
      await into("alpha");
      assert.deepEqual(await said(), [`zoom-said: Top level in ${z.alpha} Alpha: 5 cards for 11 tasks.`]);
      await page.click("#scope .leave");
      assert.deepEqual(await said(), ["zoom-said: Top level in all projects: 6 cards for 18 tasks."]);
      // The filter, the column for bugs and a reading of the plan draw the board again: none of it is read out.
      await page.click("#filter");
      await page.type("sub");
      await setting("bugs-apart");
      await setting("bugs-apart");
      await page.click("#refresh");
      await page.wait(300);
      assert.deepEqual(await said(), []);
      await page.run("document.getElementById('filter').select()");
      await page.key("Backspace");
      // Back and Forward are a zoom too.
      await page.run("history.back()");
      await page.until(`return location.hash === '#board?in=${z.alpha}&zoom=1'`, "back into the group");
      assert.deepEqual(await said(), [`zoom-said: Top level in ${z.alpha} Alpha: 5 cards for 11 tasks.`]);
      // Over the graph, a group that is left is said as well.
      await page.click("#view-graph");
      await graphReady();
      assert.deepEqual(await said(), [], "a change of view is not a zoom");
      await page.click("#scope .leave");
      assert.deepEqual(await said(), ["zoom-said: Graph of all projects: 18 tasks."]);
      // What was said is taken off the page a few seconds later, so that it is not found there when it no longer holds.
      await page.until("return document.getElementById('zoom-said').textContent === ''", "what was said to be taken away", 7000);

      // A group the board is in is deleted: the plan zooms the board out, and that is said once, among all that changed.
      await page.run("localStorage.setItem('vigile.auto-refresh', 'on')");
      try {
        await open(`/#board?in=${z.alpha}/${z.sub}/${z.deep}/${z.pit}&zoom=1`);
        await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
        await listen();
        await plan("delete", { id: z.pit, version: (await plan("get", { id: z.pit })).version });
        await page.until(`return location.hash === '#board?in=${z.alpha}/${z.sub}/${z.deep}&zoom=1'`, "the board to step out of the group that is gone", 3000);
        // The task the deleted group held is still inside the group above it, which the board is now in.
        assert.deepEqual(await said(), [`zoom-said: Everything in ${z.deep} Deep group: 1 tasks.`]);
        assert.deepEqual(page.errors, []);
      } finally {
        await plan("restore", { id: z.pit }).catch(() => {});
        await page.run("localStorage.removeItem('vigile.auto-refresh')");
      }
    });

    it("keeps nothing of the plan when its key is refused, not in the page, its title or its address, at once and after every timer has run, and is in the same place when it is let in again", async () => {
      await page.size(1280, 900);
      // Every name the plan has: the IDs and titles of its projects and of its tasks. The one task that is in no
      // project has a bare number for an ID, which says nothing by itself; its title is looked for.
      const names = ["ZOO-\\d+", "FLAT-\\d+", "\\bZOO\\b", "\\bFLAT\\b", "\\bZoo\\b", "\\bFlat\\b"];
      for (const { title } of (await plan("list_tasks", {})).tasks as Array<{ title: string }>) names.push(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      assert.equal(names.length, 6 + 18);
      /** Where anything of the plan is left: in the page with all its text and attributes, in what is typed into it, in its title, in its address. */
      const left = () =>
        page.run<string[]>(
          `const names = ${JSON.stringify(names)}; const places = { page: document.documentElement.outerHTML, typed: [...document.querySelectorAll("input, textarea")].map((field) => field.value).join(" "), title: document.title, address: location.href };
           return Object.entries(places).flatMap(([place, text]) => names.filter((name) => new RegExp(name).test(text)).map((name) => place + ": " + name));`,
        );
      const lockedOut = () => page.until("return document.getElementById('main').hidden && !document.getElementById('notice').hidden", "the key form");
      const refuse = async () => {
        setValue(zooConfig, "auth.keyless_user", "");
        await page.run("document.getElementById('refresh').click()");
        await lockedOut();
      };
      const letIn = async () => {
        setValue(zooConfig, "auth.keyless_user", "agent1");
        await page.click("#notice button");
        await page.until("return !document.getElementById('main').hidden && document.querySelectorAll('#board .card, #graph-box canvas').length > 0", "the page, once it is let in again");
      };
      const choose = (project: string) => page.run(`[...document.querySelectorAll('#projects .project-main')].find((main) => main.querySelector('.project-id').textContent === ${JSON.stringify(project)}).click()`);
      const place = `#board?in=${z.alpha}/${z.sub}&zoom=1`;
      const shown = async () => [await hash(), await level(), await cards(), await trail(), await page.run<string>("return document.title")];
      const there = [place, "Top level", these("s1", "s2", "s3", "deep*", "near"), `in ZOO › ${z.alpha} › ${z.sub} · Shared sub-group✕ leave group`, "zoom · Vigile"];
      try {
        // A refresh whose authorized answers are already on their way cannot put the plan or its route back after
        // another tab removes that credential and locks this page out.
        const admin = loadConfig(zooConfig, {}).config.auth.keys.admin!;
        await open(`/${place}`);
        await page.run(`localStorage.setItem('vigile.key', ${JSON.stringify(admin)})`);
        await open(`/${place}`);
        await page.run(`
          window.oldRefreshFetch = window.fetch;
          window.oldRefreshHeld = new Promise((resolve) => (window.releaseOldRefresh = resolve));
          window.oldRefreshStarted = false;
          window.fetch = async (url, options) => {
            const response = await window.oldRefreshFetch(url, options);
            if (!window.oldRefreshStarted && String(url).endsWith('/api/list-tasks')) {
              window.oldRefreshStarted = true;
              await window.oldRefreshHeld;
            }
            return response;
          };
          document.getElementById('refresh').click();
        `);
        await page.until("return window.oldRefreshStarted", "the old authorized refresh to have its final answer");
        await page.run(`localStorage.removeItem('vigile.key'); window.dispatchEvent(new StorageEvent('storage', { key: 'vigile.key', oldValue: ${JSON.stringify(admin)}, newValue: null, storageArea: localStorage }))`);
        await lockedOut();
        assert.deepEqual(await left(), []);
        await page.run("window.releaseOldRefresh()");
        await page.wait(200);
        assert.deepEqual([await left(), await hash()], [[], "#board"], "the stale authorized answer restores neither plan nor route");
        await page.run("window.fetch = window.oldRefreshFetch; delete window.oldRefreshFetch; delete window.oldRefreshHeld; delete window.releaseOldRefresh; delete window.oldRefreshStarted");
        await letIn();

        // A project is selected and the board is two groups in, at its top level; the last zoom was a moment ago.
        await open("/#board?zoom=1");
        await choose("ZOO");
        await into("alpha");
        await into("sub");
        assert.deepEqual(await shown(), there);
        assert.match(await text("#zoom-said"), /Shared sub-group/, "what was said of the zoom is still in the page");
        const before = await left();
        for (const found of ["page: Sub one", "page: Shared sub-group", "page: \\bZoo\\b", "address: ZOO-\\d+"]) assert.ok(before.includes(found), `the page shows the plan, and the search finds it: ${found} among ${before.join(", ")}`);

        // The key is refused. Nothing of the plan is left, and the address names the view alone.
        await refuse();
        assert.deepEqual(await left(), []);
        assert.deepEqual(await page.run("return [location.hash, document.title, document.getElementById('zoom-said').textContent, document.getElementById('level').textContent, document.getElementById('scope').textContent, document.getElementById('view-graph').getAttribute('href')]"), ["#board", "Vigile", "", "", "in all projects", "#graph"]);
        // Where the page was is kept with the entry in the browser's history, and nowhere a person or a screen reader comes by.
        assert.deepEqual(await page.run("return history.state.kept"), { route: place, project: "ZOO" });
        // Nothing comes back when the timers that were running have run: the one that empties what was said of a
        // zoom, the ones that take the rings off the cards.
        await page.wait(6600);
        assert.deepEqual(await left(), []);
        // Back and Forward lead to addresses that name a group: they are put away as well, and nothing is shown for them.
        await travel("back", "#board");
        assert.deepEqual([await left(), await page.run("return history.state.kept")], [[], { route: `#board?in=${z.alpha}&zoom=1`, project: "ZOO" }]);
        await travel("forward", "#board");
        assert.deepEqual([await left(), await page.run("return history.state.kept.route")], [[], place]);
        // An address typed by hand while the page is locked out is put away too.
        await page.run(`location.hash = '#graph/${z.s1}?in=${z.alpha}'`);
        await page.until("return location.hash === '#graph'", "the typed address to be put away");
        assert.deepEqual(await left(), []);
        await travel("back", "#board");

        // Let in again, the page is where it was: the same groups, the same level, the same project, and the address says so.
        await letIn();
        assert.deepEqual(await shown(), there);
        assert.equal(await page.run("return history.state.kept"), undefined);
        assert.equal(await text("#zoom-said"), "", "and nothing is said of a zoom that was not made");

        // Locked out and loaded again, the page still shows nothing of the plan, and is where it was once it is let in.
        await refuse();
        await page.run("window.before = true; location.reload()");
        await page.until("return !window.before && document.readyState === 'complete' && Boolean(document.getElementById('main')?.hidden) && !document.getElementById('notice').hidden", "the key form of the page that was loaded again");
        assert.deepEqual([await left(), await hash()], [[], "#board"]);
        await letIn();
        assert.deepEqual(await shown(), there);

        // A group it was in is deleted while it is locked out: let in, it is as far in as the plan still goes.
        await refuse();
        await alter("delete", { id: z.sub! });
        await letIn();
        assert.deepEqual([await hash(), await trail()], [`#board?in=${z.alpha}&zoom=1`, `in ZOO › ${z.alpha} · Alpha✕ leave group`]);
        await plan("restore", { id: z.sub });

        // The project is selected for the whole page and not for one entry of the history. Locked out two groups
        // in and gone back one entry, the page comes back in that entry's place, in the same project: the entry is
        // given the selection the page was locked out with, not the one it was emptied of.
        await open("/#board?zoom=1");
        await choose("ZOO");
        await into("alpha");
        await into("sub");
        await refuse();
        await travel("back", "#board");
        assert.deepEqual(await page.run("return history.state.kept"), { route: `#board?in=${z.alpha}&zoom=1`, project: "ZOO" });
        await letIn();
        assert.deepEqual([await hash(), await trail(), await cards()], [`#board?in=${z.alpha}&zoom=1`, `in ZOO › ${z.alpha} · Alpha✕ leave group`, these("a1", "a2", "sub*", "both", "near")]);
        assert.equal(await page.run<string>("return document.querySelector('#projects .project.selected .project-id')?.textContent"), "ZOO");
        // The entry the page was locked out on still has its address put away. Come back to, it has it again.
        await travel("forward", place);
        assert.deepEqual([await shown(), await page.run("return history.state.kept")], [there, undefined]);
        // The same after the page was loaded again while locked out, when all it knows is what was put away.
        await refuse();
        await page.run("window.before = true; location.reload()");
        await page.until("return !window.before && document.readyState === 'complete' && Boolean(document.getElementById('main')?.hidden) && !document.getElementById('notice').hidden", "the key form of the page that was loaded again");
        await travel("back", "#board");
        assert.deepEqual([await left(), await page.run("return history.state.kept")], [[], { route: `#board?in=${z.alpha}&zoom=1`, project: "ZOO" }]);
        await letIn();
        assert.deepEqual([await hash(), await trail()], [`#board?in=${z.alpha}&zoom=1`, `in ZOO › ${z.alpha} · Alpha✕ leave group`]);
        // And when the other view was gone to while locked out, which is an entry of its own.
        await refuse();
        await page.click("#view-graph");
        await page.until("return location.hash === '#graph'", "the other view");
        assert.deepEqual(await left(), []);
        await letIn();
        assert.deepEqual([await hash(), await trail()], ["#graph", "in ZOO · Zoo"]);

        // What was typed into the filter is often a title. With everything above the board folded away it is also
        // in the line that says what is in view, and where the page says that nothing matches: all of it goes.
        await open(`/${place}`);
        await page.click("#filter");
        await page.type("Shared sub-group zzz");
        await page.click("#focus");
        assert.deepEqual(await page.run("return [document.querySelector('#scope .scope-text').textContent, document.getElementById('empty').textContent]"), [
          `in all projects › ${z.alpha} › ${z.sub} · Shared sub-group, matching "Shared sub-group zzz", top level only`,
          'No task matches "Shared sub-group zzz".',
        ]);
        await refuse();
        assert.deepEqual(await left(), []);
        assert.deepEqual(await page.run("return [document.getElementById('filter').value, document.querySelector('#scope .scope-text').textContent, document.getElementById('empty').textContent]"), ["", "in all projects", "No tasks yet."]);
        await letIn();
        assert.deepEqual([await hash(), await cards(), await page.run("return document.getElementById('filter').value")], [place, these("s1", "s2", "s3", "deep*", "near"), ""]);
        await page.click("#focus");
        // Over the graph, a drawing waits for the typing to pause: locked out meanwhile, it draws nothing of what was typed.
        await page.click("#view-graph");
        await graphReady();
        await page.click("#filter");
        await page.type("Sub one");
        await refuse();
        await page.wait(600);
        assert.deepEqual([await left(), await page.run("return document.getElementById('filter').value")], [[], ""]);
        await letIn();

        // The same with an item open over the graph: its ID leaves the address and its title the tab, and both are back afterwards.
        await open(`/#graph/${z.s1}?in=${z.alpha}/${z.sub}`);
        await page.until("return document.querySelector('.detail-title')?.textContent === 'Sub one'", "the task's panel over the graph");
        await graphReady();
        await refuse();
        assert.deepEqual([await left(), await hash(), await panelOpen()], [[], "#graph", false]);
        await letIn();
        await page.until("return document.querySelector('.detail-title')?.textContent === 'Sub one' && !document.getElementById('panel').hidden", "the task's panel again");
        assert.deepEqual([await hash(), await trail()], [`#graph/${z.s1}?in=${z.alpha}/${z.sub}`, `in all projects › ${z.alpha} › ${z.sub} · Shared sub-group✕ leave group`]);
        assert.deepEqual(page.errors, []);
      } finally {
        setValue(zooConfig, "auth.keyless_user", "agent1");
        await plan("restore", { id: z.sub }).catch(() => {});
        await open().catch(() => {});
        await page.run("localStorage.clear()");
      }
    });

    it("keeps what a deleted group holds inside the group above it, as the service counts it: on the board at every zoom, under the filter, when the group is entered, in a project and in the graph", async () => {
      await page.size(1280, 900);
      const made: string[] = [];
      try {
        // Alpha holds a group, which holds a group of its own with one task. The group in between is deleted, and
        // not for good: what it held is still there, and still inside Alpha.
        await add("mid", "Middle group", { parent: z.alpha });
        await add("under", "Under a deleted group", { parent: z.mid });
        await add("leaf", "Leaf below", { parent: z.under });
        made.push(z.leaf!, z.under!);
        await alter("delete", { id: z.mid! });
        assert.deepEqual((await plan("get", { id: z.alpha })).progress, { finished: 1, total: 13 }, "the service counts both inside Alpha");
        await open(`/#board/${z.mid}`);
        await page.until("return document.querySelector('.detail-title')?.textContent === 'Middle group'", "the deleted group's panel");
        assert.equal(await count("#detail .open-group"), 0, "a deleted group has no action that would immediately remove it from the route");

        // With everything shown the two have their cards, and say they are in Alpha: the deleted group is not named.
        await open();
        assert.deepEqual(await cards(), these(...ALL, "under", "leaf"));
        assert.deepEqual([(await says("under")).tags, (await says("leaf")).tags], [["0/1 done", `in ${z.alpha}`, "ZOO"], [`in ${z.under}`, "ZOO"]]);
        assert.match(await text("#summary"), /^20 tasks/);
        // At the top level they are inside Alpha, whose card holds what the service says it holds.
        await page.click("#level-out");
        for (let more = 0; more < 3; more++) await page.click("#level-out");
        assert.deepEqual([await hash(), await cards()], ["#board?zoom=1", these(...TOP)]);
        assert.deepEqual([(await says("alpha")).tags[0], (await says("alpha")).button], ["1/13 done", "Zoom in / holds 13 tasks"]);
        assert.match(await text("#summary"), /^6 cards for 20 tasks/);
        // One level in, the group that was two levels down is one level down, closed over its task.
        await page.click("#level-in");
        assert.deepEqual(await cards(), these(...TWO, "under*"));
        assert.equal((await says("under")).button, "Zoom in / holds 1 task");
        // The filter finds the task through the deleted group: at the top level Alpha stays in sight for it.
        await page.click("#level-out");
        await page.click("#filter");
        await page.type("leaf below");
        assert.deepEqual([await cards(), (await says("alpha")).tags[1]], [these("alpha*"), "1 inside matches"]);
        await page.run("document.getElementById('filter').select()");
        await page.key("Backspace");
        // Entered, Alpha shows the group among what it holds, and the trail goes on through it.
        await into("alpha");
        assert.deepEqual(await cards(), these("a1", "a2", "sub*", "both", "near", "under*"));
        assert.match(await text("#summary"), /^6 cards for 13 tasks/);
        await into("under");
        assert.deepEqual([await hash(), await cards(), await trail()], [`#board?in=${z.alpha}/${z.under}&zoom=1`, these("leaf"), `in all projects › ${z.alpha} › ${z.under} · Under a deleted group✕ leave group`]);
        // A trail that names the deleted group loses that step and keeps the ones around it.
        await open(`/#board?in=${z.alpha}/${z.mid}/${z.under}`);
        assert.deepEqual([await hash(), await cards()], [`#board?in=${z.alpha}/${z.under}`, these("leaf")]);
        // In its project the same: the tasks are in the project through the deleted group and Alpha.
        await open("/#board?zoom=1");
        await page.run("[...document.querySelectorAll('#projects .project-main')].find((main) => main.querySelector('.project-id').textContent === 'ZOO').click()");
        assert.match(await text("#summary"), /^3 cards for 17 tasks/);
        assert.match(await text("#projects .project.selected .project-foot"), /^1 of 17 finished/, "which is the project's own count");

        // A group is deleted while the board is in a group below it: the board stays where it is, and the trail
        // keeps the group above, which still holds this one.
        await page.run("localStorage.setItem('vigile.auto-refresh', 'on')");
        await open(`/#board?in=${z.alpha}/${z.sub}/${z.deep}`);
        await live();
        await alter("delete", { id: z.sub! });
        await page.until(`return location.hash === '#board?in=${z.alpha}/${z.deep}'`, "the deleted group to leave the trail", 3000);
        assert.deepEqual([await cards(), await trail()], [these("pit", "d1"), `in all projects › ${z.alpha} › ${z.deep} · Deep group✕ leave group`]);
        await page.click("#scope .leave");
        assert.deepEqual(await cards(), these("a1", "a2", "both", "near", "under", "leaf", "s1", "s2", "s3", "deep", "pit", "d1"), "everything the deleted group held is in Alpha");
        await plan("restore", { id: z.sub });
        await page.run("localStorage.removeItem('vigile.auto-refresh')");

        // The graph draws them inside Alpha too: closed into Alpha's box, and in it when groups are shown open.
        await open(`/#graph?in=${z.alpha}`);
        await graphReady();
        assert.ok((await page.run<string[]>("return window.vigileGraph.nodes('[kind = \"task\"]').map((n) => n.data('ref'))")).includes(z.under!), "inside Alpha, the group is drawn");
        await page.click("#scope .leave");
        await page.click("label:has(#collapse-groups)");
        await page.until(`return Boolean(window.vigileGraph?.scratch('settled')) && window.vigileGraph.getElementById('task:${z.leaf}').nonempty()`, "the graph with its groups open", 20_000);
        assert.deepEqual(await page.run(`const cy = window.vigileGraph; const boxes = (id) => cy.getElementById(id).ancestors().map((box) => box.id()); return [boxes('task:${z.under}').includes('task:${z.alpha}'), boxes('task:${z.leaf}').includes('task:${z.under}'), boxes('task:${z.leaf}').includes('task:${z.alpha}')]`), [true, true, true]);
        assert.deepEqual(page.errors, []);
      } finally {
        await plan("restore", { id: z.sub }).catch(() => {});
        for (const id of made) await alter("delete", { id }).catch(() => {});
        await page.run("localStorage.removeItem('vigile.auto-refresh')");
      }
    });

    it("takes any whole number of levels from the address, with no limit of its own: a plan 1,002 groups deep is shown at 1,001 levels, and what is not a whole number that can be counted with is no zoom", async () => {
      await page.size(1280, 900);
      // What is not a number of levels: nothing is closed, and the page does not stumble.
      await open();
      for (const zoom of ["0", "-1", "+5", "05", "1.0", "1e3", "0x10", "%205", "5x", "Infinity", "NaN", "", "9007199254740992", "99999999999999999999"]) {
        await page.run(`location.hash = '#board?zoom=${zoom}'`);
        await page.until(`return location.hash === '#board?zoom=${zoom}'`, "the address");
        assert.deepEqual([await level(), (await cards()).length], ["Everything", 18], `zoom=${zoom}`);
      }
      // The largest whole number there is to count with is a number of levels: more than the plan has, so everything, and one step out from there.
      await page.run("location.hash = '#board?zoom=9007199254740991'");
      await page.until("return location.hash === '#board?zoom=9007199254740991'", "the address");
      assert.deepEqual([await level(), (await cards()).length], ["Everything", 18]);
      await page.click("#level-out");
      assert.equal(await hash(), "#board?zoom=4");
      assert.deepEqual(page.errors, []);

      // A plan of its own: 1,002 groups, each inside the one before.
      const deepDirectory = mkdtempSync(join(tmpdir(), "vigile-browser-test-deep-"));
      const deepConfig = join(deepDirectory, "config.toml");
      initConfig(deepConfig, { name: "deep", port: await freePort() });
      const deep = await startService({ loaded: loadConfig(deepConfig, {}), log: () => {}, warn: () => {} });
      try {
        await deep.engine.execute("create_project", "agent1", { title: "Deep", prefix: "DEEP" });
        const chain: string[] = [];
        for (let depth = 1; depth <= 1002; depth++) chain.push(((await deep.engine.execute("create_task", "agent1", { title: `Level ${depth}`, description: "d", project: "DEEP", ...(depth > 1 ? { parent: chain.at(-1) } : {}) })) as { id: string }).id);
        const at = async (address: string) => {
          await page.open("about:blank");
          await page.open(`${deep.urls.base}/${address}`);
          await page.until("return /^Updated/.test(document.getElementById('sync').textContent)", "the deep plan", 20_000);
        };
        const closed = () => page.run<string[]>("return [...document.querySelectorAll('#board .card.closed')].map((card) => card.dataset.id + ' ' + card.nextElementSibling.querySelector('.holds').textContent)");
        await at("#board?zoom=1001");
        assert.deepEqual([await hash(), await level(), await closed()], ["#board?zoom=1001", "1001 levels", [`${chain[1000]} holds 1 task`]]);
        assert.match(await text("#summary"), /^1001 cards for 1002 tasks/);
        // In and out again with the control, each a drawing of the whole board, and neither slow.
        const timed = (step: string) => page.run<number>(`const start = performance.now(); ${step}; return performance.now() - start;`);
        const inward = await timed("document.getElementById('level-in').click()");
        assert.deepEqual([await hash(), await level(), await closed()], ["#board", "Everything", []]);
        const outward = await timed("document.getElementById('level-out').click()");
        assert.deepEqual([await hash(), await level()], ["#board?zoom=1001", "1001 levels"]);
        // More levels than there are is everything; one level is the first group, which stands for all the others.
        await at("#board?zoom=1002");
        assert.deepEqual([await level(), await closed()], ["Everything", []]);
        await at("#board?zoom=1");
        assert.deepEqual([await level(), await closed()], ["Top level", [`${chain[0]} holds 1,001 tasks`]]);
        // Half-way down, entered: the board is in the group at level 500, and shows the level under it.
        const entered = await timed(`location.hash = '#board?in=${chain[499]}&zoom=1'; window.dispatchEvent(new HashChangeEvent('hashchange'))`);
        assert.deepEqual([await closed(), await trail()], [[`${chain[500]} holds 501 tasks`], `in all projects › ${chain[499]} · Level 500✕ leave group`]);
        assert.match(await text("#summary"), /^1 card for 502 tasks/);
        // The last group but one, entered from its card: one task, and nothing further to zoom.
        await at("#board?zoom=1001");
        await page.run(`for (const more of document.querySelectorAll('.more[aria-expanded="false"]')) more.click()`);
        await page.click(`#board .zoom-into[data-id="${chain[1000]}"]`);
        assert.deepEqual([await hash(), await level(), await page.run<string[]>("return [...document.querySelectorAll('#board .card')].map((card) => card.dataset.id)")], [`#board?in=${chain[1000]}&zoom=1001`, null, [chain[1001]]]);
        // The whole way down as a trail, a thousand groups one in the other: the address is taken as it is, the
        // board is in the last of them, and each step out is one group.
        await at(`#board?in=${chain.slice(0, 1001).join("/")}`);
        assert.deepEqual([await trail(), await page.run<string[]>("return [...document.querySelectorAll('#board .card')].map((card) => card.dataset.id)")], [`in all projects › … › ${chain[998]} › ${chain[999]} › ${chain[1000]} · Level 1001✕ leave group`, [chain[1001]]]);
        assert.ok((await page.run<string>("return document.querySelector('#scope .scope-text').title")).length < 200, "the line's full text names the steps it shows, not a thousand");
        const left = await timed("document.querySelector('#scope .leave').click()");
        assert.equal(await hash(), `#board?in=${chain.slice(0, 1000).join("/")}`);
        // A trail of as many steps that do not hold one another is cut to the last one that does.
        await at(`#board?in=${Array.from({ length: 5000 }, () => chain[5]).join("/")}/${chain[0]}/${chain[3]}`);
        assert.equal(await hash(), `#board?in=${chain[0]}/${chain[3]}`);
        assert.ok(inward < 2000 && outward < 2000 && entered < 2000 && left < 2000, `zooming in took ${Math.round(inward)} ms, out ${Math.round(outward)} ms, entering a group ${Math.round(entered)} ms`);
        assert.deepEqual(page.errors, []);
      } finally {
        await deep.stop();
        rmSync(deepDirectory, { recursive: true, force: true });
      }
    });

    it("cannot be asked for a loop of groups: the service refuses one, so the levels always end", async () => {
      await assert.rejects(plan("add_link", { from: z.d1, type: "contains", to: z.alpha }), (error: any) => error.details?.rule === "loop");
      await assert.rejects(plan("add_link", { from: z.sub, type: "contains", to: z.beta }), (error: any) => error.details?.rule === "loop");
      await assert.rejects(plan("add_link", { from: z.alpha, type: "contains", to: z.alpha }), (error: any) => error.details?.rule === "self_link");
      // A group may be in two groups, and a task reached two ways: that is a graph, not a loop, and it is five levels deep.
      await page.size(1280, 900);
      await open("/#board?zoom=4");
      assert.deepEqual([await level(), await cards()], ["4 levels", these(...FOUR)]);
    });

    it("keeps its layout zoomed out and inside a group, in every theme, in light and dark, on a wide window and on a phone", async () => {
      try {
        for (const [width, height, touch] of [[1440, 900, false], [360, 780, true]] as const) {
          await page.size(width, height, touch);
          for (const scheme of ["light", "dark"] as const) {
            await page.scheme(scheme);
            for (const name of ["vigile", "dado", "jeev", "gito"]) {
              await open("/#board?zoom=1");
              await page.run(`localStorage.setItem('vigile.theme', ${JSON.stringify(name)})`);
              await open("/#board?zoom=1");
              assert.deepEqual([await page.run<string>("return document.documentElement.dataset.theme"), await cards()], [name, these(...TOP)]);
              // The button that zooms in lies within its card, under everything the card says, and is large enough to press.
              const fit = await page.run<{ inside: boolean; below: boolean; height: number }>(
                `const card = ${card("alpha")}; const button = card.nextElementSibling; const c = card.getBoundingClientRect(), b = button.getBoundingClientRect(), last = card.lastElementChild.getBoundingClientRect();
                 return { inside: b.left >= c.left && b.right <= c.right && b.bottom <= c.bottom, below: b.top >= last.bottom, height: Math.round(b.height) }`,
              );
              assert.deepEqual(fit, { inside: true, below: true, height: 28 }, `${name}, ${scheme}, ${width}px`);
              await layout(`zoomed out in ${name}, ${scheme}, at ${width}px`);
              await open(`/#board?in=${z.alpha}/${z.sub}/${z.deep}&zoom=1`);
              await layout(`inside three groups in ${name}, ${scheme}, at ${width}px`);
            }
          }
        }
        // On a phone the trail takes a second line before the group in view is cut off.
        assert.ok(await page.run<boolean>("const line = document.querySelector('#scope .scope-text'); return line.scrollWidth <= line.clientWidth + 1 && line.getBoundingClientRect().height < 50"));
        assert.deepEqual(page.errors, []);
      } finally {
        await page.scheme("light");
        await page.run("localStorage.removeItem('vigile.theme')");
        await page.size(1280, 900);
      }
    });
  });

  /**
   * The graph of a plan of 2,000 tasks, on a service of its own. Working out where that many items go takes many
   * seconds, during which the page must go on answering, and it is work the page does not start by itself.
   */
  browserSuite("a large plan", () => {
    let largeDirectory: string;
    let large: Service;
    /** The ten letters typed into the filter: each one more leaves a tenth fewer of the tasks. */
    const LETTERS = "zyxwvutsrq";
    /** The tasks of each project that are not groups, in the order they were made. */
    const firsts: Record<string, string[]> = {};
    /** How many tasks sit inside a group, and so are not drawn while groups are collapsed. */
    let inGroups = 0;
    /** The whole plan as the graph counts it: every task that is drawn, and the four projects. */
    const whole = () => (2000 - inGroups + 4).toLocaleString("en-US");
    const plan = (operation: string, input: Record<string, unknown>) => large.engine.execute(operation, "agent1", input) as Promise<any>;
    const open = async (path = "/") => {
      await page.open("about:blank");
      await page.open(`${large.urls.base}${path}`);
      await page.until("return /^(Updated|Live)/.test(document.getElementById('sync').textContent)", "the page to show its data", 20_000);
    };
    /** What the line over the graph says, or nothing when it is not shown. */
    const line = () => page.run<string | null>("const status = document.getElementById('graph-status'); return status.hidden ? null : document.getElementById('graph-status-text').textContent");
    /** The button in that line, or nothing when it has none. */
    const button = () => page.run<string | null>("const draw = document.getElementById('graph-draw'); return draw.hidden || document.getElementById('graph-status').hidden ? null : draw.textContent");
    /** Which drawing is on the page, counted from when it was opened, whether it has all its places yet, and how many items it has. */
    const drawing = () =>
      page.run<{ number: number; settled: boolean; items: number } | null>(
        "const g = window.vigileGraph; return g ? { number: g.scratch('drawing'), settled: g.scratch('settled') === true, items: g.nodes('[ref]').length } : null",
      );
    const settled = (items: number) => page.until(`const g = window.vigileGraph; return Boolean(g && g.scratch('settled') && g.nodes('[ref]').length === ${items})`, `the graph of ${items} items to be drawn`, 120_000);
    const choose = (project: string) => page.run(`[...document.querySelectorAll('#projects .project-main')].find((card) => card.querySelector('.project-id').textContent === ${JSON.stringify(project)}).click()`);
    const node = (id: string) => `window.vigileGraph.getElementById('task:${id}')`;
    /** Opens the graph of MID with auto-refresh on and has it drawn: 399 tasks in their project, every second one waiting for the one before it. Answers with which drawing it is. */
    /** Opens the graph with auto-refresh on. The whole plan is large, so nothing is drawn yet. */
    const openLive = async () => {
      await open("/");
      await setting("auto");
      await open("/#graph");
      await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
    };
    const drawMid = async (items = 400) => {
      await openLive();
      await choose("MID");
      await page.until("return !document.getElementById('graph-draw').hidden", "the button that draws the graph");
      await page.click("#graph-draw");
      await settled(items);
      return (await drawing())!.number;
    };
    /** Changes an item at its present version, as another client would. */
    const change = async (operation: string, input: { id: string } & Record<string, unknown>) => plan(operation, { ...input, version: (await plan("get", { id: input.id })).version });
    /** What the line over a kept drawing says when the plan has moved on in the ways given. */
    const since = (changes: string) => `The plan has changed since this graph was drawn: ${changes}. Everything else in it shows the plan as it is now.`;
    /** Waits for the line over the graph to say that, and for nothing else. */
    const says = async (changes: string | null) => {
      const wanted = changes === null ? null : since(changes);
      await page.until(`const status = document.getElementById('graph-status'); return (status.hidden ? null : document.getElementById('graph-status-text').textContent) === ${JSON.stringify(wanted)}`, "the line over the graph").catch(() => {});
      assert.equal(await line(), wanted);
    };
    /** What the box of a task shows in the drawing. */
    const box = (id: string) =>
      page.run<{ label: string; state: string; type: string; problem: number; group: number; gone: boolean; opacity: number; border: string }>(
        `const n = ${node(id)}; return { label: n.data('label'), state: n.data('state'), type: n.data('type'), problem: n.data('problem'), group: n.data('group'), gone: n.hasClass('gone'), opacity: Number(n.style('opacity')), border: n.style('border-style') }`,
      );
    /** What the arrow from a task to one that waits for it shows, or nothing when the drawing has none. */
    const arrow = (from: string, to: string) =>
      page.run<{ kind: string; gone: boolean; line: string } | null>(
        `const e = window.vigileGraph.getElementById('edge:task:${from}|task:${to}|d'); return e.empty() ? null : { kind: e.data('kind'), gone: e.hasClass('gone'), line: e.style('line-style') }`,
      );
    /** Puts a task's box in the middle of the graph and clicks it. */
    const press = async (id: string) => {
      const at = await page.run<{ x: number; y: number }>(`const g = window.vigileGraph; const n = ${node(id)}; g.zoom(1); g.center(n); const at = n.renderedPosition(); const frame = g.container().getBoundingClientRect(); return { x: frame.left + at.x, y: frame.top + at.y }`);
      await page.clickAt(at.x, at.y);
    };
    /** Runs what was pushed onto it, the last first, so that a test leaves the plan as it found it, also when it fails half-way. */
    const takeBack = async (undo: Array<() => Promise<unknown>>) => {
      for (const step of undo.reverse()) await step().catch(() => {});
    };

    before(async () => {
      largeDirectory = mkdtempSync(join(tmpdir(), "vigile-browser-test-large-"));
      const largeConfig = join(largeDirectory, "config.toml");
      initConfig(largeConfig, { name: "large", port: await freePort() });
      large = await startService({ loaded: loadConfig(largeConfig, {}), log: () => {}, warn: () => {} });
      // 2,000 tasks. BIG is what makes the layout long to work out: fifty groups, and tasks that each wait for up
      // to three of the forty before them, three in ten of them inside a group. The titles carry the first letters
      // of LETTERS, one more for each task in ten.
      let seed = 12345;
      const random = (below: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % below);
      const groups: string[] = [];
      let made = 0;
      for (const [prefix, size] of Object.entries({ BIG: 1002, MID: 399, EVEN: 299, OVER: 300 })) {
        await plan("create_project", { title: `${prefix[0]}${prefix.slice(1).toLowerCase()} one`, prefix });
        const tasks: string[] = (firsts[prefix] = []);
        for (let i = 0; i < size; i++, made++) {
          const big = prefix === "BIG";
          const group = big && i < 50;
          const waits = group ? [] : big ? [0, 1, 2].map(() => tasks[tasks.length - 1 - random(40)]) : prefix === "MID" && i % 2 ? [tasks[i - 1]] : [];
          const depends_on = [...new Set(waits.filter((id): id is string => Boolean(id)))];
          const parent = big && !group && [1, 2, 3].includes(made % 10) ? groups[random(groups.length)] : undefined;
          if (parent) inGroups++;
          const { id } = await plan("create_task", { title: `${LETTERS.slice(0, 1 + (made % 10))} ${made}`, description: "d", project: prefix, depends_on, ...(parent ? { parent } : {}) });
          (group ? groups : tasks).push(id);
        }
      }
      assert.equal(made, 2000);
    });

    after(async () => {
      await large?.stop();
      if (largeDirectory) rmSync(largeDirectory, { recursive: true, force: true });
    });

    it("zooms the board of 2,000 tasks out to its groups and in again at once, and filters it zoomed out letter by letter", async () => {
      await page.size(1440, 900);
      await open("/");
      /** Runs a step in the page and says how long the page was busy with it, in milliseconds. */
      const timed = (step: string) => page.run<number>(`const start = performance.now(); ${step}; return performance.now() - start;`);
      const summary = () => text("#summary");
      assert.match(await summary(), /^2000 tasks/);
      // Out: the tasks inside a group give way to their group's card. No task is deeper than one level.
      const out = await timed("document.getElementById('level-out').click()");
      assert.equal(await page.run<string>("return location.hash + ' ' + document.getElementById('level').textContent"), "#board?zoom=1 Top level");
      assert.match(await summary(), new RegExp(`^${2000 - inGroups} cards for 2000 tasks`));
      await page.run(`for (const more of document.querySelectorAll('.more[aria-expanded="false"]')) more.click()`);
      const closed = await page.run<Array<{ id: string; holds: string }>>("return [...document.querySelectorAll('#board .card.closed')].map((card) => ({ id: card.dataset.id, holds: card.nextElementSibling.querySelector('.holds').textContent }))");
      assert.ok(closed.length > 0 && closed.length <= 50, `of the fifty groups, those that hold something are closed: ${closed.length}`);
      let held = 0;
      for (const group of closed) held += Number(/^holds (\d+) tasks?$/.exec(group.holds)![1]);
      assert.equal(held, inGroups, "between them the closed groups hold every task that is not on the board, each task being in one group");
      const { progress } = await plan("get", { id: closed[0]!.id });
      assert.equal(closed[0]!.holds, `holds ${progress.total} tasks`, "a group's count is the service's own");
      await page.run(`for (const more of document.querySelectorAll('.more[aria-expanded="true"]')) more.click()`);
      // The filter, zoomed out: each letter is one drawing of the board, with the closed groups looked into.
      const typed = await timed(`const filter = document.getElementById('filter'); for (const word of ["z", "zy", "zyx", "zyxw"]) { filter.value = word; filter.dispatchEvent(new Event("input", { bubbles: true })); }`);
      assert.match(await summary(), /^\d+ cards for 1400 tasks/, "seven tasks in ten carry the four letters");
      assert.ok((await count("#board .tag.match")) > 0, "and closed groups say how many of theirs match");
      await timed(`const filter = document.getElementById('filter'); filter.value = ""; filter.dispatchEvent(new Event("input", { bubbles: true }));`);
      const back = await timed("document.getElementById('level-in').click()");
      assert.equal(await page.run<string>("return location.hash + ' ' + document.getElementById('level').textContent"), "#board Everything");
      assert.match(await summary(), /^2000 tasks/);
      // Far more room than is needed: each of these is a few hundredths of a second, and seconds if the work grew with the square of the plan.
      assert.ok(out < 1500 && back < 1500 && typed < 3000, `zooming out took ${Math.round(out)} ms, in ${Math.round(back)} ms, four letters ${Math.round(typed)} ms`);
      assert.deepEqual(page.errors, []);
    });

    it("says how large the graph is and draws it when asked, not by itself; the choice holds from the board and back", async () => {
      await page.size(1280, 900);
      await open("/#graph");
      // The tasks outside the groups, the groups and the four projects. Nothing is drawn, nothing is being worked out.
      await page.until("return !document.getElementById('graph-status').hidden", "the line that says how large the graph is");
      assert.match((await line()) ?? "", new RegExp(`^This graph has ${whole()} items and [\\d,]+ arrows\\. A graph of more than 300 items is drawn when you ask for it, because working out where everything goes takes a while\\.$`));
      assert.equal(await button(), "Draw the graph");
      assert.equal(await drawing(), null);
      assert.equal(await count("#graph-box canvas"), 0);
      await layout("in the graph of a large plan that waits to be asked for");

      // Up to 300 items a graph is drawn at once, as it always was: 299 tasks in their project.
      await choose("EVEN");
      await settled(300);
      assert.equal(await line(), null);
      // One more, and the page asks.
      await choose("OVER");
      await page.until("return !document.getElementById('graph-status').hidden", "the line, for 301 items");
      assert.match((await line()) ?? "", /^This graph has 301 items and 0 arrows\./);
      assert.equal(await drawing(), null, "the smaller graph is not left there under another project's name");

      // Asked for with the keyboard, it is drawn.
      await page.run("document.getElementById('graph-draw').focus()");
      await page.key("Enter");
      await settled(301);
      assert.equal(await line(), null);
      const first = (await drawing())!.number;

      // The choice was to see large graphs: it holds on the way to the board and back, and for the next one.
      await page.click("#view-board");
      await page.until("return document.getElementById('board').getBoundingClientRect().height > 0", "the board");
      await page.click("#view-graph");
      await page.until("return document.getElementById('graph-box').getBoundingClientRect().height > 0", "the graph again");
      assert.deepEqual([await line(), (await drawing())!.number], [null, first], "the same drawing, and no question");
      await choose("MID");
      await settled(400);
      assert.equal(await line(), null);
      assert.equal((await drawing())!.number, first + 1);
      await layout("in the graph of 400 items");
      assert.deepEqual(page.errors, []);
    });

    it("keeps answering while the graph of 2,000 tasks is worked out, and gives that up for a newer drawing", async () => {
      await page.size(1280, 900);
      await open("/");
      // The workers the page starts and ends are counted, and those ended while they still owed an answer.
      await page.run(
        "window.workers = { started: 0, ended: 0, givenUp: 0 }; const Real = window.Worker; window.Worker = class extends Real { constructor(...given) { super(...given); window.workers.started++; this.owed = 0; this.addEventListener('message', () => this.owed--); } postMessage(...given) { this.owed++; super.postMessage(...given); } terminate() { window.workers.ended++; if (this.owed > 0) window.workers.givenUp++; super.terminate(); } };",
      );
      await page.click("#view-graph");
      await page.until("return !document.getElementById('graph-draw').hidden", "the button that draws the graph");
      await page.click("#graph-draw");
      // The layout is under way, and the page says so.
      await page.until("return Boolean(window.vigileGraph) && /^Working out where/.test(document.getElementById('graph-status-text').textContent)", "the layout to be under way", 20_000);
      assert.match((await line()) ?? "", new RegExp(`^Working out where ${whole()} items and [\\d,]+ arrows go\\. The rest of the page can be used meanwhile\\.$`));
      assert.equal(await button(), null);
      assert.equal((await drawing())!.settled, false);
      // The button went with the question. The keyboard is in the line that took its place, not lost.
      assert.equal(await page.run<string>("return document.activeElement.id"), "graph-status");

      // A click on Board: how long from the click to the board on screen, as the page itself saw it.
      await page.run(
        "window.answered = null; document.getElementById('view-board').addEventListener('click', (event) => { const look = () => (document.querySelectorAll('.card').length > 0 && document.getElementById('board').getBoundingClientRect().height > 0 ? (window.answered = performance.now() - event.timeStamp) : requestAnimationFrame(look)); requestAnimationFrame(look); }, { once: true });",
      );
      await page.click("#view-board");
      await page.until("return window.answered !== null", "the board");
      const answered = await page.run<number>("return window.answered");
      const then = (await drawing())!;
      assert.equal(then.settled, false, "the board is there while the graph is still being worked out");
      assert.ok(answered < 1000, `the click was acted on within a second: ${Math.round(answered)} ms`);

      // Back in the graph, the same drawing is still on its way: it was not started again.
      await page.click("#view-graph");
      await page.until("return document.getElementById('graph-box').getBoundingClientRect().height > 0", "the graph again");
      assert.equal((await drawing())!.number, then.number);
      assert.deepEqual(await page.run("return window.workers"), { started: 1, ended: 0, givenUp: 0 });

      // Another graph is asked for. It does not wait behind the large one, whose worker is ended.
      await choose("EVEN");
      await settled(300);
      assert.equal((await drawing())!.number, then.number + 1);
      assert.deepEqual(await page.run("return window.workers"), { started: 2, ended: 1, givenUp: 1 }, "the layout that was under way was given up, and the new one got a worker of its own");
      assert.equal(await line(), null);
      assert.deepEqual(page.errors, []);
    });

    it("waits for the typing in the filter to pause before it draws the graph again: ten letters, one drawing", async () => {
      await page.size(1280, 900);
      await open("/#graph");
      await page.until("return !document.getElementById('graph-draw').hidden", "the button that draws the graph");
      await page.click("#graph-draw");
      await page.until("return Boolean(window.vigileGraph)", "the first drawing to be started", 20_000);
      const first = (await drawing())!.number;
      // The pause is held here for as long as the test wants, so that it does not depend on how fast it types.
      await page.run(
        "window.pauses = new Map(); const set = window.setTimeout, clear = window.clearTimeout; window.setTimeout = (run, ms, ...rest) => { if (ms !== 300) return set(run, ms, ...rest); const id = set(() => {}, 0); window.pauses.set(id, run); return id; }; window.clearTimeout = (id) => { window.pauses.delete(id); clear(id); };",
      );
      await page.click("#filter");
      const shown: string[] = [];
      for (const letter of LETTERS) {
        await page.type(letter);
        shown.push(await text("#summary"));
      }
      assert.equal(await page.run<string>("return document.getElementById('filter').value"), LETTERS);
      // The counts above the graph followed every letter at once: 2,000 tasks, then a tenth fewer with each.
      assert.deepEqual(shown.map((counts) => Number(/^(\d+) tasks?/.exec(counts)?.[1])), [2000, 1800, 1600, 1400, 1200, 1000, 800, 600, 400, 200]);
      // The graph did not: no drawing was started, and one pause is running, begun again by each letter.
      assert.equal((await drawing())!.number, first, "no drawing was started while the letters were typed");
      assert.equal(await page.run<number>("return window.pauses.size"), 1);
      // The pause ends: one drawing, of what the whole word leaves.
      await page.run("const [run] = window.pauses.values(); window.pauses.clear(); run();");
      await settled(204);
      assert.equal((await drawing())!.number, first + 1, "ten letters started one drawing");

      // The board has nothing to wait for: it follows each letter, and starts no pause.
      await page.click("#view-board");
      await page.until("return document.getElementById('board').getBoundingClientRect().height > 0", "the board");
      await page.click("#filter");
      await page.key("Backspace");
      assert.equal(Number(/^(\d+) tasks?/.exec(await text("#summary"))?.[1]), 400);
      assert.equal(await page.run<number>("return window.pauses.size"), 0);
      assert.deepEqual(page.errors, []);
    });

    it("leaves a large graph as it is when the plan changes under it, says so, and draws it again when asked", async () => {
      await page.size(1280, 900);
      const added: string[] = [];
      let renamed: { id: string; title: string } | null = null;
      try {
        const first = await drawMid();
        // The person looks closer at something.
        await page.click("#zoom-in");
        const view = () => page.run<{ zoom: number; moved: boolean }>("const g = window.vigileGraph; return { zoom: Math.round(g.zoom() * 100) / 100, moved: g.scratch('moved') === true }");
        const before = await view();
        assert.equal(before.moved, true);

        // A task changes state, and then its title: the drawing shows both, and is the same drawing.
        const started = firsts.MID![0]!;
        const was = await plan("get", { id: started });
        const fill = await page.run<string>(`return ${node(started)}.style('background-color')`);
        const busy = await plan("set_task_status", { id: started, version: was.version, status: "in_progress" });
        await page.until(`return ${node(started)}.data('state') === 'in_progress' && ${node(started)}.style('background-color') !== ${JSON.stringify(fill)}`, "the new state in the graph");
        renamed = { id: started, title: was.title };
        await plan("update_task", { id: started, version: busy.version, title: "Renamed while it is drawn" });
        await page.until(`return ${node(started)}.style('label').endsWith('Renamed while it is drawn')`, "the new title in the graph");
        assert.deepEqual([(await drawing())!.number, await line()], [first, null]);

        // Tasks are added, one after the other, as agents at work add them. None of them starts a layout.
        for (const title of ["Added by an agent", "And another"]) {
          added.push((await plan("create_task", { title, description: "d", project: "MID" })).id);
          await page.until(`return /^${399 + added.length} tasks/.test(document.getElementById('summary').textContent)`, "the new task in the counts");
          await says(added.length === 1 ? "1 item is new and not drawn" : "2 items are new and not drawn");
          assert.equal(await button(), "Draw it again");
          assert.deepEqual(await drawing(), { number: first, settled: true, items: 400 }, "the drawing that was there is there still");
        }
        // It takes the page's colours all the same.
        const colour = () => page.run<string>(`return ${node(started)}.style('background-color')`);
        const light = await colour();
        await page.scheme("dark");
        await page.until(`return ${node(started)}.style('background-color') !== ${JSON.stringify(light)}`, "the graph to change colours");
        await page.scheme("light");
        await page.until(`return ${node(started)}.style('background-color') === ${JSON.stringify(light)}`, "the graph to change colours back");
        assert.equal((await drawing())!.number, first);

        // To the board and back: still that drawing, still said to be out of date.
        await page.click("#view-board");
        await page.until("return document.getElementById('board').getBoundingClientRect().height > 0", "the board");
        await page.click("#view-graph");
        await page.until("return document.getElementById('graph-box').getBoundingClientRect().height > 0", "the graph again");
        assert.deepEqual([(await drawing())!.number, await line()], [first, since("2 items are new and not drawn")]);
        await layout("in a large graph that is out of date");

        // Asked for, it is drawn again, where the person had it.
        await page.click("#graph-draw");
        await settled(402);
        assert.deepEqual([(await drawing())!.number, await line()], [first + 1, null]);
        assert.deepEqual(await view(), before, "at the zoom the person chose");
        assert.deepEqual(page.errors, []);
      } finally {
        await page.run("localStorage.removeItem('vigile.auto-refresh')");
        for (const id of added) await plan("delete", { id, version: (await plan("get", { id })).version });
        if (renamed) await plan("update_task", { id: renamed.id, version: (await plan("get", { id: renamed.id })).version, title: renamed.title });
      }
    });
    it("shows the present in a large graph that is kept: a state, a title, a kind and a problem mark arrive after the plan has grown", async () => {
      await page.size(1280, 900);
      const M = firsts.MID!;
      const undo: Array<() => Promise<unknown>> = [];
      try {
        const first = await drawMid();
        // A task is added: from here on the drawing is one of an earlier plan, kept because it is large.
        const { id: added } = await plan("create_task", { title: "Added by an agent", description: "d", project: "MID" });
        undo.push(() => change("delete", { id: added }));
        await says("1 item is new and not drawn");

        // What the plan says of the items that are drawn goes on arriving in the drawing. A state:
        const before = await box(M[2]!);
        assert.deepEqual([before.state, before.type, before.problem, before.gone], ["next", "task", 0, false]);
        await change("set_task_status", { id: M[2]!, status: "in_progress" });
        await page.until(`return ${node(M[2]!)}.data('state') === 'in_progress'`, "the new state in the kept drawing");
        // A title:
        const title = (await plan("get", { id: M[4]! })).title;
        await change("update_task", { id: M[4]!, title: "Renamed after the plan grew" });
        undo.push(() => change("update_task", { id: M[4]!, title }));
        await page.until(`return ${node(M[4]!)}.style('label').endsWith('Renamed after the plan grew')`, "the new title in the kept drawing");
        // A kind:
        await change("update_task", { id: M[6]!, type: "bug" });
        undo.push(() => change("update_task", { id: M[6]!, type: "task" }));
        await page.until(`return ${node(M[6]!)}.data('trouble') === 1`, "the new kind in the kept drawing");
        assert.deepEqual([(await box(M[6]!)).type, (await box(M[6]!)).border, /· bug/.test((await box(M[6]!)).label)], ["bug", "double", true]);
        // The box of the project says what the project is, too.
        const project = () => page.run<{ label: string; state: string; problem: number }>("const n = window.vigileGraph.getElementById('project:MID'); return { label: n.data('label'), state: n.data('state'), problem: n.data('problem') }");
        assert.deepEqual(await project(), { label: "MID · Mid one   open", state: "open", problem: 0 });
        await change("set_project_status", { id: "MID", status: "broken" });
        undo.push(() => change("set_project_status", { id: "MID", status: "open" }));
        await page.until("return window.vigileGraph.getElementById('project:MID').data('state') === 'broken'", "the project's new status in the kept drawing");
        assert.deepEqual(await project(), { label: "MID · Mid one   broken", state: "broken", problem: 1 });

        // A problem: a task that was started is made to wait for one that is not finished. Its mark arrives; the
        // arrow between the two, which are both drawn, has no route in this drawing and is counted as not drawn.
        await change("set_task_status", { id: M[10]!, status: "in_progress" });
        await plan("add_link", { from: M[10]!, type: "depends on", to: M[12]! });
        undo.push(() => plan("remove_link", { from: M[10]!, type: "depends on", to: M[12]! }));
        await page.until(`return ${node(M[10]!)}.data('problem') === 1`, "the problem mark in the kept drawing");
        assert.deepEqual([(await box(M[10]!)).state, (await box(M[10]!)).border], ["in_progress", "dashed"]);
        assert.equal(await arrow(M[12]!, M[10]!), null);
        await says("1 item and 1 arrow are new and not drawn");

        // A priority and an assignment are not drawn in the graph, so nothing in it can be behind on them. They
        // are in the panel, which asks the service: opened from the kept drawing, it follows them.
        const seen = await page.run<string>(`return JSON.stringify(${node(M[8]!)}.data())`);
        await press(M[8]!);
        await page.until(`return document.querySelector('.detail-title')?.textContent === ${JSON.stringify((await plan("get", { id: M[8]! })).title)}`, "the panel of the task that was clicked");
        const priority = (await plan("get", { id: M[8]! })).priority;
        await change("update_task", { id: M[8]!, priority: 9 });
        undo.push(() => change("update_task", { id: M[8]!, priority }));
        await plan("add_link", { from: M[8]!, type: "assigned to", to: "agent1" });
        undo.push(() => plan("remove_link", { from: M[8]!, type: "assigned to", to: "agent1" }));
        await page.until("return [...document.querySelectorAll('#detail dt')].find((dt) => dt.textContent === 'Priority')?.nextElementSibling.textContent === '9' && /agent1/.test(document.querySelector('#detail .relation[data-relation=\"assigned to\"]')?.textContent ?? '')", "the new priority and assignment in the panel");
        await page.key("Escape");
        assert.equal(await page.run<string>(`return JSON.stringify(${node(M[8]!)}.data())`), seen);

        // All of it in the drawing that was there, and none of it by a new layout.
        assert.deepEqual(await drawing(), { number: first, settled: true, items: 400 });
        assert.equal(await line(), since("1 item and 1 arrow are new and not drawn"));
        assert.deepEqual(page.errors, []);
      } finally {
        await page.run("localStorage.removeItem('vigile.auto-refresh')");
        await takeBack(undo);
      }
    });

    it("greys out what is gone from a kept large graph, counts what is new, and clears every mark when the plan comes back to what was drawn", async () => {
      await page.size(1280, 900);
      const M = firsts.MID!;
      const undo: Array<() => Promise<unknown>> = [];
      try {
        const first = await drawMid();
        const drawnAs = { gone: await box(M[18]!), waiting: await box(M[19]!), arrow: await arrow(M[18]!, M[19]!) };
        assert.deepEqual([drawnAs.gone.gone, drawnAs.gone.opacity, drawnAs.waiting.state, drawnAs.arrow], [false, 1, "waiting", { kind: "open", gone: false, line: "solid" }]);

        // A task is deleted. Its box cannot be taken out without a new layout: it is greyed out and says that it
        // is no longer here, and so is the arrow from it. The task that waited for it shows that it can start.
        await change("delete", { id: M[18]! });
        undo.push(() => plan("restore", { id: M[18]! }));
        await says("1 item and 1 arrow are no longer there and greyed out");
        assert.deepEqual(await box(M[18]!), { ...drawnAs.gone, label: `${M[18]} · no longer here`, gone: true, opacity: 0.5, border: "dashed" });
        assert.deepEqual(await arrow(M[18]!, M[19]!), { kind: "open", gone: true, line: "dotted" });
        assert.equal((await box(M[19]!)).state, "next");

        // A link between two tasks that are both drawn is removed: its arrow is greyed out, and the task is free.
        await plan("remove_link", { from: M[21]!, type: "depends on", to: M[20]! });
        undo.push(() => plan("add_link", { from: M[21]!, type: "depends on", to: M[20]! }));
        await says("1 item and 2 arrows are no longer there and greyed out");
        assert.deepEqual([(await arrow(M[20]!, M[21]!))!.gone, (await box(M[21]!)).state], [true, "next"]);
        // A link between two that are both drawn is added: the task waits, and the arrow is counted as not drawn.
        await plan("add_link", { from: M[24]!, type: "depends on", to: M[22]! });
        undo.push(() => plan("remove_link", { from: M[24]!, type: "depends on", to: M[22]! }));
        await says("1 arrow is new and not drawn; 1 item and 2 arrows are no longer there and greyed out");
        assert.deepEqual([await arrow(M[22]!, M[24]!), (await box(M[24]!)).state], [null, "waiting"]);

        // Somewhere else a task is put inside another, which makes that one a group. With groups collapsed the
        // task has no box of its own any more, and the arrow from it now starts at the group.
        const drawnApart = { group: await box(M[30]!), inside: await box(M[32]!) };
        await plan("add_link", { from: M[30]!, type: "contains", to: M[32]! });
        undo.push(() => plan("remove_link", { from: M[30]!, type: "contains", to: M[32]! }));
        await says("2 arrows are new and not drawn; 2 items and 3 arrows are no longer there and greyed out");
        assert.deepEqual([(await box(M[32]!)).gone, (await box(M[32]!)).label, (await arrow(M[32]!, M[33]!))!.gone], [true, `${M[32]} · no longer here`, true]);
        assert.deepEqual([(await box(M[30]!)).group, /^\S+ {3}0\/1\n/.test((await box(M[30]!)).label), (await box(M[30]!)).gone], [1, true, false]);
        // The group is dissolved again: the task has its box back, and the group is a task like any other.
        await undo.pop()!();
        await says("1 arrow is new and not drawn; 1 item and 2 arrows are no longer there and greyed out");
        assert.deepEqual({ group: await box(M[30]!), inside: await box(M[32]!) }, drawnApart);
        assert.equal((await arrow(M[32]!, M[33]!))!.gone, false);

        // The two links are put back as they were, one after the other.
        await undo.pop()!();
        await says("1 item and 2 arrows are no longer there and greyed out");
        await undo.pop()!();
        await says("1 item and 1 arrow are no longer there and greyed out");
        assert.deepEqual([(await arrow(M[20]!, M[21]!))!.gone, (await box(M[21]!)).state, (await box(M[24]!)).state], [false, "waiting", "next"]);

        // The deleted task is brought back: the plan is what was drawn. The line goes, and so does every mark.
        await undo.pop()!();
        await says(null);
        assert.deepEqual({ gone: await box(M[18]!), waiting: await box(M[19]!), arrow: await arrow(M[18]!, M[19]!) }, drawnAs, "the drawing shows what it was drawn as, which is the plan again");
        assert.equal(await page.run<number>("return window.vigileGraph.elements('.gone').length"), 0);
        assert.deepEqual(await drawing(), { number: first, settled: true, items: 400 }, "all of it in the one drawing");
        assert.deepEqual(page.errors, []);
      } finally {
        await page.run("localStorage.removeItem('vigile.auto-refresh')");
        await takeBack(undo);
      }
    });

    it("says in the kept graph and in the panel that an item is gone, also when its box is clicked, in another theme and under reduced motion", async () => {
      await page.size(1280, 900);
      const M = firsts.MID!;
      const undo: Array<() => Promise<unknown>> = [];
      /** What the open panel says of its item: the title, and the pills beside it. */
      const head = () => page.run<string>("return [document.querySelector('.detail-title')?.textContent ?? '', ...[...document.querySelectorAll('#detail .detail-head .pill')].map((pill) => pill.textContent)].join(' | ')");
      try {
        // One task more than the others have, to be deleted for good further down.
        const extra = await plan("create_task", { title: "Deleted for good while it is drawn", description: "d", project: "MID" });
        let forGood = false;
        undo.push(async () => forGood || change("delete", { id: extra.id }));
        const first = await drawMid(401);
        const title = (await plan("get", { id: M[40]! })).title;
        // The panel of a drawn task is open when the task is deleted somewhere else.
        await press(M[40]!);
        await page.until(`return document.querySelector('.detail-title')?.textContent === ${JSON.stringify(title)}`, "the panel of the task that was clicked");
        assert.equal(await head(), `${title} | open | next`);
        await change("delete", { id: M[40]! });
        undo.push(() => plan("restore", { id: M[40]! }));
        await says("1 item and 1 arrow are no longer there and greyed out");
        // The panel says that it is deleted, and the box that it is no longer here.
        await page.until("return [...document.querySelectorAll('#detail .detail-head .pill')].some((pill) => pill.textContent === 'deleted')", "the panel to say that the task is deleted");
        assert.equal(await head(), `${title} | open | deleted`);
        assert.deepEqual([(await box(M[40]!)).gone, (await box(M[40]!)).label], [true, `${M[40]} · no longer here`]);
        await page.key("Escape");
        assert.equal(await panelOpen(), false);

        // The greyed box can still be clicked, and the panel says what has become of the task.
        await press(M[40]!);
        await page.until("return !document.getElementById('panel').hidden && [...document.querySelectorAll('#detail .detail-head .pill')].some((pill) => pill.textContent === 'deleted')", "the panel of the task that is gone");
        assert.equal(await head(), `${title} | open | deleted`);
        assert.equal(await page.run<string>("return location.hash"), `#graph/${M[40]}`);
        await page.key("Escape");

        // The same for a task that is deleted for good, of which the service knows nothing any more: the panel that
        // was open on it says that there is no such item, and so does the one opened from its greyed box.
        const nothing = () => page.run<string>("return document.getElementById('panel').hidden ? '' : (document.querySelector('#detail .empty')?.textContent ?? 'something else')");
        await press(extra.id);
        await page.until("return document.querySelector('.detail-title')?.textContent === 'Deleted for good while it is drawn'", "the panel of the other task");
        await large.engine.execute("delete", "admin", { id: extra.id, version: extra.version, permanent: true });
        forGood = true;
        await says("2 items and 1 arrow are no longer there and greyed out");
        await page.until("return Boolean(document.querySelector('#detail .empty'))", "the panel to say that there is no such task");
        assert.match(await nothing(), new RegExp(`No .* matches "${extra.id}"`));
        assert.deepEqual([(await box(extra.id)).gone, (await box(extra.id)).label], [true, `${extra.id} · no longer here`]);
        await page.key("Escape");
        assert.equal(await panelOpen(), false);
        await press(extra.id);
        await page.until("return !document.getElementById('panel').hidden && Boolean(document.querySelector('#detail .empty'))", "the panel opened from the box of a task that does not exist");
        assert.match(await nothing(), new RegExp(`No .* matches "${extra.id}"`));
        // The panel offers to read again, as it does whenever it could not read: asked, it says the same, and
        // the drawing with its greyed box stays as it is.
        const numbered = await page.run<number>("return window.vigileGraph.scratch('drawing')");
        await page.run("document.querySelector('#detail .retry').click()");
        await page.wait(300);
        assert.match(await nothing(), new RegExp(`No .* matches "${extra.id}"`));
        assert.deepEqual([await page.run<number>("return document.querySelectorAll('#detail .retry').length"), await page.run<number>("return window.vigileGraph.scratch('drawing')"), (await box(extra.id)).gone], [1, numbered, true]);
        await page.key("Escape");

        // Another theme, dark, and reduced motion: the box is as grey in that theme's colours, and the line says the same.
        const look = () => page.run<string>(`const n = ${node(M[40]!)}; return [n.style('border-color'), n.style('color'), n.style('background-color')].join(' ')`);
        // The pointer is taken off the box it clicked first, onto empty background: with the pointer on a box,
        // everything that is not next to that box is faded, greyed or not.
        const empty = await page.run<{ x: number; y: number }>("const g = window.vigileGraph; g.pan({ x: g.width() * 4, y: 0 }); const frame = g.container().getBoundingClientRect(); return { x: frame.left + frame.width / 2, y: frame.top + frame.height / 2 }");
        await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: empty.x + 6, y: empty.y + 6 });
        await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: empty.x, y: empty.y });
        await page.until("return window.vigileGraph.elements('.faded').length === 0", "nothing to be faded");
        const light = await look();
        await theme("gito");
        await page.scheme("dark");
        await page.until(`const n = ${node(M[40]!)}; return [n.style('border-color'), n.style('color'), n.style('background-color')].join(' ') !== ${JSON.stringify(light)}`, "the kept drawing to take the theme's colours");
        await page.motion("reduce");
        const still = await box(M[40]!);
        assert.deepEqual([still.gone, still.label, still.opacity, still.border], [true, `${M[40]} · no longer here`, 0.5, "dashed"]);
        assert.equal(await line(), since("2 items and 1 arrow are no longer there and greyed out"));
        assert.equal(await button(), "Draw it again");
        assert.deepEqual(await drawing(), { number: first, settled: true, items: 401 });
        await layout("in a kept graph with an item that is gone, in the dark Gito theme");
        assert.deepEqual(page.errors, []);
      } finally {
        await page.motion("no-preference");
        await page.scheme("light");
        await page.run("localStorage.removeItem('vigile.auto-refresh'); localStorage.removeItem('vigile.theme')");
        await takeBack(undo);
      }
    });

    it("starts from the plan as it is when the graph is drawn again half-way through such changes, and counts from there", async () => {
      await page.size(1280, 900);
      const M = firsts.MID!;
      const undo: Array<() => Promise<unknown>> = [];
      try {
        const first = await drawMid();
        // A task goes, one is added, and one is started.
        await change("delete", { id: M[50]! });
        undo.push(() => plan("restore", { id: M[50]! }));
        const { id: added } = await plan("create_task", { title: "Added half-way", description: "d", project: "MID" });
        undo.push(() => change("delete", { id: added }));
        await change("set_task_status", { id: M[52]!, status: "in_progress" });
        await says("1 item is new and not drawn; 1 item and 1 arrow are no longer there and greyed out");
        await page.until(`return ${node(M[52]!)}.data('state') === 'in_progress'`, "the new state in the kept drawing");

        // Drawn again: the plan as it is, with nothing greyed out and nothing left to say.
        await page.click("#graph-draw");
        await settled(400);
        await says(null);
        assert.equal((await drawing())!.number, first + 1);
        assert.deepEqual(await page.run(`const g = window.vigileGraph; return [g.elements('.gone').length, ${node(M[50]!)}.length, ${node(added)}.length, ${node(M[52]!)}.data('state'), ${node(M[51]!)}.data('state')]`), [0, 0, 1, "in_progress", "next"]);

        // What happens next is counted from this drawing. The deleted task comes back: to this drawing it is new.
        await undo.shift()!();
        await says("1 item and 1 arrow are new and not drawn");
        assert.equal((await box(M[51]!)).state, "waiting");
        // The added one goes: here it has a box, which is greyed out.
        await undo.shift()!();
        await says("1 item and 1 arrow are new and not drawn; 1 item is no longer there and greyed out");
        assert.deepEqual([(await box(added)).gone, (await box(added)).label], [true, `${added} · no longer here`]);
        // And a title still arrives.
        const title = (await plan("get", { id: M[54]! })).title;
        await change("update_task", { id: M[54]!, title: "Renamed after it was drawn again" });
        undo.push(() => change("update_task", { id: M[54]!, title }));
        await page.until(`return ${node(M[54]!)}.style('label').endsWith('Renamed after it was drawn again')`, "the new title in the kept drawing");
        assert.deepEqual(await drawing(), { number: first + 1, settled: true, items: 400 });
        assert.deepEqual(page.errors, []);
      } finally {
        await page.run("localStorage.removeItem('vigile.auto-refresh')");
        await takeBack(undo);
      }
    });
    it("marks a task that was moved into another box as no longer here when groups are shown open, and its arrows with it", async () => {
      await page.size(1280, 900);
      const M = firsts.MID!;
      const undo: Array<() => Promise<unknown>> = [];
      try {
        const first = await drawMid();
        // Groups are shown as boxes around their tasks. MID has none, so the drawing is the one that is there.
        await page.click("label:has(#collapse-groups)");
        undo.push(() => page.click("label:has(#collapse-groups)"));
        assert.deepEqual([await line(), (await drawing())!.number], [null, first]);
        const drawnApart = { group: await box(M[60]!), inside: await box(M[62]!), arrow: await arrow(M[62]!, M[63]!) };

        // A task is put inside another. Its box in the project is not where it is any more, and the box it is in
        // now would have to be drawn around it: both that and its arrow are counted as new, and as gone from here.
        await plan("add_link", { from: M[60]!, type: "contains", to: M[62]! });
        undo.push(() => plan("remove_link", { from: M[60]!, type: "contains", to: M[62]! }));
        await says("1 item and 1 arrow are new and not drawn; 1 item and 1 arrow are no longer there and greyed out");
        assert.deepEqual([(await box(M[62]!)).gone, (await box(M[62]!)).label, (await arrow(M[62]!, M[63]!))!.gone], [true, `${M[62]} · no longer here`, true]);
        // The task that holds it is where it was, and says that it is a group now.
        const group = await box(M[60]!);
        assert.deepEqual([group.gone, group.group, / {3}0\/1$/.test(group.label)], [false, 1, true]);
        // The task that waits for the one inside is where it was, and still waits.
        assert.deepEqual([(await box(M[63]!)).gone, (await box(M[63]!)).state], [false, "waiting"]);

        // Taken out again, everything is as it was drawn.
        await undo.pop()!();
        await says(null);
        assert.deepEqual({ group: await box(M[60]!), inside: await box(M[62]!), arrow: await arrow(M[62]!, M[63]!) }, drawnApart);
        assert.equal((await drawing())!.number, first);

        // Now the group is drawn as one, a box around its task. When that box is moved into yet another task, what
        // is inside it is not where it is drawn either, though it is in the same box as before.
        await plan("add_link", { from: M[60]!, type: "contains", to: M[62]! });
        undo.push(() => plan("remove_link", { from: M[60]!, type: "contains", to: M[62]! }));
        await says("1 item and 1 arrow are new and not drawn; 1 item and 1 arrow are no longer there and greyed out");
        await page.click("#graph-draw");
        await settled(400);
        await says(null);
        assert.equal(await page.run<string>(`return ${node(M[62]!)}.parent().id()`), `task:${M[60]}`);
        await plan("add_link", { from: M[64]!, type: "contains", to: M[60]! });
        undo.push(() => plan("remove_link", { from: M[64]!, type: "contains", to: M[60]! }));
        await says("2 items and 2 arrows are new and not drawn; 2 items and 2 arrows are no longer there and greyed out");
        assert.deepEqual([(await box(M[60]!)).gone, (await box(M[62]!)).gone, (await box(M[62]!)).label, (await box(M[64]!)).gone], [true, true, `${M[62]} · no longer here`, false]);
        assert.deepEqual([(await arrow(M[60]!, M[61]!))!.gone, (await arrow(M[62]!, M[63]!))!.gone, (await arrow(M[64]!, M[65]!))!.gone], [true, true, false]);
        await undo.pop()!();
        await says(null);
        assert.equal(await page.run<number>("return window.vigileGraph.elements('.gone').length"), 0);
        assert.equal((await drawing())!.number, first + 1);
        assert.deepEqual(page.errors, []);
      } finally {
        await takeBack(undo);
        await page.run("localStorage.removeItem('vigile.auto-refresh')");
      }
    });

    it("says of a large graph that is still being worked out that the plan has moved on, and works it out again when asked", async () => {
      await page.size(1280, 900);
      const undo: Array<() => Promise<unknown>> = [];
      const working = (items: number) => `Working out where ${items} items and 199 arrows go. The rest of the page can be used meanwhile.`;
      const asked = (changes: string) => since(changes).replace("was drawn", "was asked for");
      const shows = async (wanted: string) => {
        await page.until(`return document.getElementById('graph-status-text').textContent === ${JSON.stringify(wanted)}`, "the line over the graph").catch(() => {});
        assert.equal(await line(), wanted);
      };
      try {
        await open("/");
        await setting("auto");
        await open("/#graph");
        await page.until("return document.getElementById('sync').textContent.startsWith('Live')", "the page to say it is live");
        // Each layout is held back here until the test lets it go, so that it is under way for as long as it takes to look.
        await page.run("window.held = []; const Real = window.Worker; window.Worker = class extends Real { postMessage(message) { if (message.cmd === 'layout') window.held.push(() => super.postMessage(message)); else super.postMessage(message); } };");
        await choose("MID");
        await page.until("return !document.getElementById('graph-draw').hidden", "the button that draws the graph");
        await page.click("#graph-draw");
        await shows(working(400));
        const first = (await drawing())!.number;

        // A task is added while the layout is worked out. The layout is of the plan before, and the page says so.
        const { id: one } = await plan("create_task", { title: "Added while the layout is worked out", description: "d", project: "MID" });
        undo.push(() => change("delete", { id: one }));
        await shows(`${working(400)} ${asked("1 item is new and not drawn")}`);
        assert.equal(await button(), "Draw it again");
        assert.deepEqual(await drawing(), { number: first, settled: false, items: 400 }, "the layout that was under way goes on");

        // Asked for, the layout is started again, for the plan as it is.
        await page.click("#graph-draw");
        await shows(working(401));
        assert.equal(await button(), null);
        assert.deepEqual(await drawing(), { number: first + 1, settled: false, items: 401 });
        // Another task, and then the layout arrives: the drawing is there, of the plan before that task.
        const { id: two } = await plan("create_task", { title: "And one more", description: "d", project: "MID" });
        undo.push(() => change("delete", { id: two }));
        await shows(`${working(401)} ${asked("1 item is new and not drawn")}`);
        await page.run("window.held.pop()()");
        await settled(401);
        await says("1 item is new and not drawn");
        assert.deepEqual([await button(), (await drawing())!.number, await page.run<number>(`return ${node(one)}.length + ${node(two)}.length`)], ["Draw it again", first + 1, 1]);
        assert.deepEqual(page.errors, []);
      } finally {
        await page.run("localStorage.removeItem('vigile.auto-refresh')");
        await takeBack(undo);
      }
    });
    it("keeps a graph when the plan crosses 300 items by itself, whichever way, says what it does not show, and draws a small one again by itself", async () => {
      await page.size(1280, 900);
      const E = firsts.EVEN!;
      const undo: Array<() => Promise<unknown>> = [];
      const make = async (title: string) => {
        const { id } = await plan("create_task", { title, description: "d", project: "EVEN" });
        const step = () => change("delete", { id });
        undo.push(step);
        return { id, gone: async () => (undo.splice(undo.indexOf(step), 1), step()) };
      };
      const redrawn = async (number: number, items: number) => {
        await page.until(`const g = window.vigileGraph; return Boolean(g && g.scratch('drawing') === ${number} && g.scratch('settled') && g.nodes('[ref]').length === ${items})`, `drawing ${number}, of ${items} items`, 20_000);
        await says(null);
      };
      try {
        // 299 tasks in their project: 300 items, which is small, and drawn without asking.
        await openLive();
        await choose("EVEN");
        await settled(300);
        const first = (await drawing())!.number;
        assert.equal(await line(), null);

        // One more makes 301. That layout is not started unasked. The drawing stays, and says that one is missing.
        const one = await make("The 301st");
        await says("1 item is new and not drawn");
        assert.equal(await button(), "Draw it again");
        assert.deepEqual(await drawing(), { number: first, settled: true, items: 300 });
        // It is kept, not left behind: what it shows goes on following the plan.
        await change("set_task_status", { id: E[0]!, status: "in_progress" });
        await page.until(`return ${node(E[0]!)}.data('state') === 'in_progress'`, "the new state in the drawing");
        // Back to 300, the same 300: nothing is missing, and the drawing is the one that was there.
        await one.gone();
        await says(null);
        assert.deepEqual(await drawing(), { number: first, settled: true, items: 300 });

        // 301 again, and then another task goes: 300, but not the 300 that are drawn. Both the drawing and the
        // plan's graph are small, and a small graph is drawn again by itself.
        const two = await make("The 301st, again");
        await says("1 item is new and not drawn");
        await change("delete", { id: E[1]! });
        undo.push(() => plan("restore", { id: E[1]! }));
        await redrawn(first + 1, 300);
        assert.deepEqual(await page.run(`return [${node(E[1]!)}.length, ${node(two.id)}.length]`), [0, 1]);
        // 299, and 300 again: each drawn by itself.
        await two.gone();
        await redrawn(first + 2, 299);
        await undo.pop()!();
        await redrawn(first + 3, 300);

        // Now the other way. A graph of 301 items is on screen, because it was asked for.
        const three = await make("The 301st, to be drawn");
        await says("1 item is new and not drawn");
        await page.click("#graph-draw");
        await redrawn(first + 4, 301);
        // It loses one and would be small. A large drawing is not replaced unasked either: the item is greyed
        // out where it is, and the page says so.
        await three.gone();
        await says("1 item is no longer there and greyed out");
        assert.deepEqual(await drawing(), { number: first + 4, settled: true, items: 301 });
        assert.deepEqual([(await box(three.id)).gone, (await box(three.id)).label], [true, `${three.id} · no longer here`]);
        // 299, 300 and 301 by other tasks: still that drawing, which says what has come and gone.
        await change("delete", { id: E[2]! });
        undo.push(() => plan("restore", { id: E[2]! }));
        await says("2 items are no longer there and greyed out");
        await undo.pop()!();
        await says("1 item is no longer there and greyed out");
        const four = await make("Another 301st");
        await says("1 item is new and not drawn; 1 item is no longer there and greyed out");
        assert.deepEqual(await drawing(), { number: first + 4, settled: true, items: 301 });
        await four.gone();
        await says("1 item is no longer there and greyed out");

        // Large graphs were asked for once, by that button. That holds for what the person asks for: another
        // project of 301 items is drawn without a question. It never meant layouts started by the plan.
        await choose("OVER");
        await redrawn(first + 5, 301);
        await choose("EVEN");
        await redrawn(first + 6, 300);
        const five = await make("The 301st, after large graphs were asked for");
        await says("1 item is new and not drawn");
        assert.deepEqual(await drawing(), { number: first + 6, settled: true, items: 300 });
        await five.gone();
        await says(null);
        assert.deepEqual(page.errors, []);
      } finally {
        await page.run("localStorage.removeItem('vigile.auto-refresh')");
        await takeBack(undo);
      }
    });

    it("asks at 301 items and draws at 300 when the project, the filter or one of the two switches crosses the line, until large graphs were asked for", async () => {
      await page.size(1280, 900);
      const E = firsts.EVEN!;
      const undo: Array<() => Promise<unknown>> = [];
      const asks = async (items: number) => {
        await page.until(`return new RegExp('^This graph has ${items} items').test(document.getElementById('graph-status').hidden ? '' : document.getElementById('graph-status-text').textContent)`, `the page to ask before it draws ${items} items`);
        assert.deepEqual([await button(), await drawing()], ["Draw the graph", null], "nothing of the graph before is left under the question");
      };
      const draws = async (items: number) => {
        await settled(items);
        assert.equal(await line(), null);
      };
      try {
        // EVEN gets a 300th task, which is finished: 301 items with it, 300 without.
        const { id: finished } = await plan("create_task", { title: "Finished, the 300th", description: "d", project: "EVEN" });
        undo.push(() => change("delete", { id: finished }));
        await change("set_task_status", { id: finished, status: "in_progress" });
        await change("set_task_status", { id: finished, status: "done" });
        await open("/#graph");

        // The project: OVER has 301 items, MID 400, EVEN 301 now.
        await choose("EVEN");
        await asks(301);
        // "Hide finished tasks" takes it to 300, which is drawn, and back to 301, which is asked about.
        await page.click("label:has(#hide-finished)");
        await draws(300);
        await page.click("label:has(#hide-finished)");
        await asks(301);

        // The filter: all but one in ten of the tasks of OVER is 271 items, drawn once the typing has paused.
        await choose("OVER");
        await asks(301);
        await page.click("#filter");
        await page.type(LETTERS.slice(0, 2));
        await draws(271);
        await page.run("document.getElementById('filter').select()");
        await page.key("Backspace");
        await asks(301);

        // "Collapse groups": a task of EVEN is put inside another. As one item with what is inside it, that is
        // 300 items; with the group shown open, 301.
        await plan("add_link", { from: E[10]!, type: "contains", to: E[12]! });
        undo.push(() => plan("remove_link", { from: E[10]!, type: "contains", to: E[12]! }));
        await page.run("document.getElementById('refresh').click()");
        await choose("EVEN");
        await draws(300);
        await page.click("label:has(#collapse-groups)");
        await asks(301);
        await page.click("label:has(#collapse-groups)");
        await draws(300);

        // Asked for once, a large graph is drawn whenever the person crosses the line again.
        await page.click("label:has(#collapse-groups)");
        await asks(301);
        await page.click("#graph-draw");
        await draws(301);
        const asked = (await drawing())!.number;
        await page.click("label:has(#collapse-groups)");
        await draws(300);
        await page.click("label:has(#collapse-groups)");
        await draws(301);
        await choose("OVER");
        await draws(301);
        await choose("EVEN");
        await draws(301);
        assert.equal((await drawing())!.number, asked + 4);
        assert.deepEqual(page.errors, []);
      } finally {
        await takeBack(undo);
      }
    });

    it("takes the same plan, with its links or its tasks listed in another order, for the plan that is drawn: no notice, no marks, no new drawing", async () => {
      await page.size(1280, 900);
      const M = firsts.MID!;
      const undo: Array<() => Promise<unknown>> = [];
      const waitsFor = async (id: string) => (await plan("list_tasks", { project: "MID" })).tasks.find((task: { id: string }) => task.id === id).depends_on as string[];
      try {
        // A task that waits for two others, drawn as that.
        await plan("add_link", { from: M[71]!, type: "depends on", to: M[68]! });
        undo.push(() => plan("remove_link", { from: M[71]!, type: "depends on", to: M[68]! }));
        assert.deepEqual(await waitsFor(M[71]!), [M[68], M[70]]);
        const first = await drawMid();
        const drawnAs = { task: await box(M[71]!), one: await arrow(M[70]!, M[71]!), other: await arrow(M[68]!, M[71]!) };

        // Both links are taken away and put back, the other one first.
        await plan("remove_link", { from: M[71]!, type: "depends on", to: M[70]! });
        await says("1 arrow is no longer there and greyed out");
        await plan("remove_link", { from: M[71]!, type: "depends on", to: M[68]! });
        await says("2 arrows are no longer there and greyed out");
        assert.equal((await box(M[71]!)).state, "next");
        await plan("add_link", { from: M[71]!, type: "depends on", to: M[68]! });
        await says("1 arrow is no longer there and greyed out");
        await plan("add_link", { from: M[71]!, type: "depends on", to: M[70]! });
        // Link insertion order changed, but the service's deterministic ID order did not. The line goes, with
        // its button, and nothing in the drawing is greyed out.
        assert.deepEqual(await waitsFor(M[71]!), [M[68], M[70]]);
        await says(null);
        assert.equal(await button(), null);
        assert.equal(await page.run<number>("return window.vigileGraph.elements('.gone').length"), 0);
        assert.deepEqual({ task: await box(M[71]!), one: await arrow(M[70]!, M[71]!), other: await arrow(M[68]!, M[71]!) }, drawnAs);
        assert.deepEqual(await drawing(), { number: first, settled: true, items: 400 });

        // The service lists tasks and projects by their IDs. Were they to arrive in another order, as here, where
        // every list the page reads is turned round, it is the same plan still. A title changes with it, so that
        // the test can tell when the page has read it.
        await page.run("window.turned = 0; const real = window.fetch; window.fetch = async (...asked) => { const response = await real(...asked); if (!/\\/api\\/list-(tasks|projects)$/.test(String(asked[0]))) return response; const body = await response.json(); for (const list of ['tasks', 'projects']) if (Array.isArray(body[list])) { body[list].reverse(); window.turned++; } return new Response(JSON.stringify(body), { status: response.status, headers: response.headers }); };");
        const title = (await plan("get", { id: M[73]! })).title;
        await change("update_task", { id: M[73]!, title: "Renamed while the lists are turned round" });
        undo.push(() => change("update_task", { id: M[73]!, title }));
        await page.until(`return ${node(M[73]!)}.style('label').endsWith('Renamed while the lists are turned round')`, "the new title in the drawing");
        assert.ok((await page.run<number>("return window.turned")) > 0);
        assert.deepEqual([await line(), await button(), await page.run<number>("return window.vigileGraph.elements('.gone').length")], [null, null, 0]);
        assert.deepEqual(await drawing(), { number: first, settled: true, items: 400 });
        assert.deepEqual(page.errors, []);
      } finally {
        await page.run("localStorage.removeItem('vigile.auto-refresh')");
        await takeBack(undo);
      }
    });
  });
});
