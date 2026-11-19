// Looks at the built site in a real browser, for what only a browser can say: that the search marks what was
// asked for without ever turning text into markup, and that every page can be used with scripts switched off.
// It drives a Chromium with the site's own small driver (website/lib/browser.mjs), and is skipped, saying so,
// when there is none.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "./build.mjs";
import { Page, findBrowser } from "./lib/browser.mjs";
import { freePorts } from "./lib/terminals.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const browser = findBrowser();

/** Entries put into the index for the test: text that would do harm if it were ever read as markup. */
const HOSTILE = [
  ["docs/cli/#put-in-by-the-test", "A page with <i>markup</i> in its name", "<img src=x onerror=window.pwned=1> <script>window.pwned = 1</script> & \"quotes\" 'single'", "Text to create a task with <b>bold</b> & <mark>a mark</mark>, an a, an é, a 😀 and a $1 [group] (x) a.b* \\ back.", "Documentation"],
  ["docs/#put-in-by-the-test-too", "Another page", "Ünïcödé heading 日本語, İstanbul and STRASSE", "Résumé of the naïve façade: 日本語のテキスト, ΑΒΓ and αβγ, 😀😀.", "Documentation"],
];

describe("the built site in a browser", { skip: browser ? false : "No Chromium found: install one (npx playwright install chromium-headless-shell) or set VIGILE_TEST_BROWSER." }, () => {
  let folder;
  let server;
  let base;
  let page;
  let index;

  before(async () => {
    folder = mkdtempSync(join(tmpdir(), "vigile-site-browser-"));
    const out = join(folder, "site");
    await build({ out, siteUrl: "https://site.example/vigile/" });
    index = [...JSON.parse(readFileSync(join(out, "search.json"), "utf8")), ...HOSTILE];
    writeFileSync(join(out, "search.json"), JSON.stringify(index));
    const [port] = await freePorts(1);
    server = spawn(process.execPath, [join(here, "serve.mjs"), "--dir", out, "--base", "/vigile/", "--host", "127.0.0.1", "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve, reject) => {
      server.stdout.once("data", resolve);
      server.once("exit", () => reject(new Error("The preview server did not start.")));
    });
    base = `http://127.0.0.1:${port}/vigile/`;
    page = await Page.launch(browser);
    // The site scrolls smoothly where the system has not asked for less motion, and a click made by this test
    // would then be aimed at where its target was before the scroll. Less motion is asked for.
    await page.motion("reduce");
  });
  after(async () => {
    await page?.close();
    server?.kill("SIGTERM");
    rmSync(folder, { recursive: true, force: true });
  });

  /** Opens the search on a page and asks it for something. Returns each result as the browser has it. */
  async function search(words) {
    await page.run("document.getElementById('search').close(); document.querySelector('#search-input').value = ''");
    await page.click("[data-search]");
    await page.until("return document.getElementById('search').open", "the search to open");
    await page.type(words);
    await page.until(`return document.querySelector('.search-status').textContent !== '' && !document.querySelector('.search-status').textContent.startsWith('Loading')`, "the search to answer");
    return page.run(`
      return [...document.querySelectorAll(".search-results a")].map((link) => ({
        href: link.getAttribute("href"),
        where: link.querySelector(".search-where").textContent,
        title: link.querySelector(".search-title").textContent,
        text: link.querySelector(".search-text").textContent,
        marks: [...link.querySelectorAll("mark")].map((mark) => mark.textContent),
        // Everything inside a result is one of these: a part, or a mark in a part. Anything else was made of text.
        elements: [...link.querySelectorAll("*")].map((element) => element.tagName.toLowerCase() + (element.attributes.length > (element.className ? 1 : 0) ? "!" : "")),
        marksOutside: [...link.querySelectorAll("mark")].filter((mark) => !mark.parentElement.matches(".search-title, .search-text")).length,
      }));
    `);
  }

  /** What the index says of a result, to hold what is shown against. */
  const entryOf = (result) => index.find((entry) => entry[0] === result.href.replace(/^(\.\.\/)*/, "").replace(/^\/vigile\//, ""));

  it("marks what was asked for in the results, as text in nodes: for words of any length, in any order, that overlap", async () => {
    await page.size(1280, 900);
    await page.open(`${base}docs/cli/`);
    for (const words of ["create a task", "task a create", "a", "m a r k", "create creat crea", "set_task_status --status", "e t a o i n"]) {
      const results = await search(words);
      assert.ok(results.length > 0, `"${words}" finds something`);
      const asked = words.toLowerCase().split(/\s+/);
      for (const result of results) {
        const entry = entryOf(result);
        assert.ok(entry, `"${words}": ${result.href} is a place of the index`);
        // The title is the entry's own words, whole and unchanged: marking added nodes and no characters.
        assert.equal(result.title, entry[2] || entry[1], `"${words}": the title of ${result.href} is what the index has`);
        assert.equal(result.where, `${entry[4]}${entry[2] ? ` · ${entry[1]}` : ""}`);
        assert.ok(entry[3].includes(result.text.replace(/^…|…$/g, "")), `"${words}": the text shown is a piece of the entry's text, unchanged: ${result.text}`);
        assert.deepEqual([...new Set(result.elements)].sort(), ["mark", "span"].filter((name) => result.elements.includes(name)), `"${words}": nothing but parts and marks is in a result`);
        assert.equal(result.marksOutside, 0);
        // Each mark is made of what was asked for: every character of it lies in an occurrence of one of the words.
        for (const mark of result.marks) {
          assert.ok(mark.length > 0);
          const low = mark.toLowerCase();
          const covered = new Array(low.length).fill(false);
          for (const word of asked) for (let at = low.indexOf(word); at >= 0; at = low.indexOf(word, at + 1)) covered.fill(true, at, at + word.length);
          assert.ok(covered.every(Boolean), `"${words}": the mark "${mark}" is made of the words asked for`);
        }
        // Where a word that was asked for is in what is shown, it is marked. (A word can also be found in the name of the page alone.)
        if (asked.some((word) => `${result.title} ${result.text}`.toLowerCase().includes(word))) assert.ok(result.marks.length > 0, `"${words}": something is marked in ${result.href}`);
      }
    }
    // Words that overlap are one mark, not one inside another, and not two side by side.
    const overlapping = await search("creat eate");
    const marks = overlapping.flatMap((result) => result.marks.map((mark) => mark.toLowerCase()));
    assert.ok(marks.includes("create"), `"creat" and "eate" overlap in "create", which is marked as one: ${marks.slice(0, 8).join(" | ")}`);
    assert.ok(overlapping.every((result) => result.marksOutside === 0 && !result.elements.some((name) => name.endsWith("!"))));
  });

  it("never makes markup of the text of the index or of what was typed", async () => {
    await page.open(`${base}docs/cli/`);
    // Signs that mean something in markup or in a pattern, each with a word that only the entry put in by the test has.
    for (const words of ["script pwned", "<script> quotes", "img onerror", "< > single", "& quotes", '" single', "' quotes", "b bold mark", "</mark> bold", "$1 group", "[group] back", "(x) back", "a.b* back", "\\ back", "b* a.b", "😀", "é façade", "日本語", "İstanbul", "αβγ", "ΑΒΓ", "strasse", "ünïcödé"]) {
      const results = await search(words);
      const mine = results.filter((result) => HOSTILE.some((entry) => result.href.endsWith(entry[0])));
      assert.ok(mine.length > 0, `"${words}" finds the entry it is in (${results.length} results)`);
      for (const result of results) {
        const entry = entryOf(result);
        assert.equal(result.title, entry[2] || entry[1], `"${words}": the title is the entry's text, sign for sign`);
        assert.ok(entry[3].includes(result.text.replace(/^…|…$/g, "")), `"${words}": the text is the entry's text, sign for sign: ${result.text}`);
        assert.deepEqual([...new Set(result.elements)].sort(), ["mark", "span"].filter((name) => result.elements.includes(name)), `"${words}": no element was made of text: ${result.elements.join(",")}`);
      }
      // In the entry it was put into, it is marked where it stands.
      const low = words.toLowerCase().split(/\s+/);
      const where = mine.filter((result) => low.some((word) => `${result.title} ${result.text}`.toLowerCase().includes(word)));
      assert.ok(where.length > 0, `"${words}" is shown in the entry it is in`);
      for (const result of where) assert.ok(result.marks.some((mark) => low.includes(mark.toLowerCase()) || low.some((word) => mark.toLowerCase().includes(word))), `"${words}": it is marked where it stands: ${result.marks.join(" | ")}`);
      assert.equal(await page.run("return window.pwned"), undefined, `"${words}": nothing in the index ran`);
      assert.equal(await page.run("return document.querySelectorAll('#search img, #search script, #search b').length"), 0);
    }
    assert.deepEqual(page.errors, [], "the page threw nothing");
    // What is typed is shown nowhere as markup either: a question that finds nothing leaves no trace of itself.
    const none = await search('<img src=x onerror="window.pwned=2">zzzz');
    assert.deepEqual(none, []);
    assert.equal(await page.run("return window.pwned"), undefined);
    assert.match(await page.run("return document.querySelector('.search-status').textContent"), /^Nothing found/);
  });

  describe("with scripts switched off", () => {
    // The scripts of the page do not run. What is asked of the browser here is asked by its own tools.
    before(() => page.send("Emulation.setScriptExecutionDisabled", { value: true }));
    after(() => page.send("Emulation.setScriptExecutionDisabled", { value: false }));
    const go = async (url) => {
      await page.open(url);
      assert.equal(await page.run("return document.documentElement.classList.contains('js')"), false, "no script of the page has run");
    };
    /** How many of the elements can be seen: drawn, with a size, and not inside something that is folded away. */
    const seen = (selector) => page.run(`return [...document.querySelectorAll(${JSON.stringify(selector)})].filter((element) => element.checkVisibility({ visibilityProperty: true }) && element.getBoundingClientRect().height > 0).length`);
    const count = (selector) => page.run(`return document.querySelectorAll(${JSON.stringify(selector)}).length`);

    it("shows the list of an area's pages on a wide window, and every link of it leads on", async () => {
      await page.size(1280, 900);
      await go(`${base}docs/cli/`);
      assert.ok((await count(".side a")) >= 14, "the list of the documentation's pages is in the page");
      assert.equal(await seen(".side a"), await count(".side a"), "every link of it can be seen, without a script having opened anything");
      assert.equal(await seen(".side-fold > summary"), 0, "there is nothing to open on a wide window");
      await page.click('.side a[href$="docs/http-api/"]');
      await page.until(`return location.href === ${JSON.stringify(`${base}docs/http-api/`)}`, "the browser to follow the link");
      // The content, the code and the list of what is on the page are there.
      assert.ok((await seen("main h1")) === 1 && (await seen("main pre")) >= 4 && (await seen("main table")) >= 2 && (await seen(".onpage a")) >= 5);
      // Nothing that only a script could bring out stands in the way: the search's box is closed, and stays so.
      assert.equal(await seen("dialog"), 0);
    });

    it("shows the list of pages open on a phone, where the script would have folded it, and lets it be folded by hand", async () => {
      await page.size(390, 800, true);
      await go(`${base}docs/operations/get/`);
      assert.equal(await page.run("return document.querySelector('.side-fold').open"), true, "the list is open as it is written");
      assert.ok((await count(".side a")) > 30, "every page of the documentation, and every operation");
      assert.equal(await seen(".side a"), await count(".side a"), "each of them can be reached");
      // The browser itself folds and opens it: the heading of the list is a summary, large enough for a finger.
      assert.ok((await page.box(".side-fold > summary")).height >= 40);
      await page.tap(".side-fold > summary");
      await page.until("return !document.querySelector('.side-fold').open", "the list to fold");
      assert.equal(await seen(".side a"), 0, "tapped, the list folds away");
      await page.tap(".side-fold > summary");
      await page.until("return document.querySelector('.side-fold').open", "the list to open");
      assert.equal(await seen(".side a"), await count(".side a"), "tapped again, it opens");
      assert.ok((await seen("main h1")) === 1 && (await seen("main pre")) >= 3, "and the page itself is below it");
    });

    it("leads from the place of the search to the contents of the documentation, and says so", async () => {
      await page.size(1280, 900);
      await go(`${base}how/statuses/`);
      assert.equal(await page.run("return document.querySelector('[data-search]').innerText.trim()"), "Contents", 'the place of the search says "Contents", not "Search", which it could not do');
      assert.equal(await seen("[data-scheme-switch]"), 0, "the switch between light and dark, which needs the script, is not shown");
      await page.click("[data-search]");
      await page.until(`return location.href === ${JSON.stringify(`${base}docs/#contents`)}`, "the browser to go to the contents");
      assert.ok((await seen(".cards .card")) >= 13, "every page of the documentation is one step from there");
      // On a phone the word has no room, and the place still leads there and still has a name.
      await page.size(390, 800, true);
      await go(`${base}how/statuses/`);
      assert.equal(await seen("[data-search]"), 1);
      assert.equal(await page.run("return document.querySelector('[data-search]').getAttribute('aria-label')"), "Search, or the contents of the documentation");
    });

    it("can be walked with the keyboard, and what the browser folds by itself unfolds", async () => {
      await page.size(1280, 900);
      await go(`${base}docs/cli/`);
      const stops = [];
      for (let i = 0; i < 8; i++) {
        await page.key("Tab");
        stops.push(await page.run("const at = document.activeElement; return `${at.tagName.toLowerCase()} ${at.className} ${at.dataset.area ?? ''} ${at.getAttribute('href') ?? ''}`.replace(/\\s+/g, ' ').trim()"));
      }
      assert.deepEqual(stops, ["a skip #main", "a brand ../../", "a product ../../", "a how ../../how/", "a docs ../../docs/", "a tool search-open ../../docs/#contents", "a ../../docs/", "a ../../docs/install/"], "the skip link, the name, the three areas, the contents, then the pages of the area");
      // The focus can be seen where it is.
      assert.notEqual(await page.run("return getComputedStyle(document.activeElement).outlineStyle"), "none");
      // The instructions on the page about MCP are folded by the browser, and unfold without a script.
      await go(`${base}docs/mcp/`);
      assert.equal(await seen("details.fold pre"), 0);
      await page.click("details.fold > summary");
      await page.until("return document.querySelector('details.fold').open", "the instructions to unfold");
      assert.equal(await seen("details.fold pre"), 1);
    });
  });

  describe("the mark on the section that is being read", () => {
    // What the list "On this page" marks, and what the headings say it should mark: asked of the page each time.
    const frames = "await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done))));";
    const marked = () => page.run(`${frames} return [...document.querySelectorAll(".onpage a[aria-current]")].map((link) => decodeURIComponent(link.hash.slice(1)));`);
    /** The headings the list names, each with where its top stands in the window, and what there is to scroll. */
    const layout = () =>
      page.run(`${frames}
        const line = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) + 12;
        const headings = [...document.querySelectorAll(".onpage a")].map((link) => { const id = decodeURIComponent(link.hash.slice(1)); return { id, top: document.getElementById(id).getBoundingClientRect().top, at: document.getElementById(id).getBoundingClientRect().top + scrollY }; });
        return { line, headings, y: scrollY, height: innerHeight, end: document.documentElement.scrollHeight - innerHeight };`);
    /** The last heading that has gone up past the line where reading starts: what is being read, away from the end of the page. */
    const above = ({ headings, line }) => headings.filter((heading) => heading.top <= line).at(-1)?.id ?? null;
    const moveTo = (y) => page.run(`scrollTo({ top: ${Math.round(y)}, behavior: "instant" });`);
    const one = async (expected, when) => assert.deepEqual(await marked(), expected === null ? [] : [expected], when);

    it("stays on a long section while its heading is out of sight, in both directions, and is one mark at most", async () => {
      await page.size(1280, 700);
      await page.open(`${base}docs/cli/`);
      const start = await layout();
      assert.ok(start.headings.length >= 6, "the page has a list of its sections");
      await one(null, "at the top of the page, before any section, nothing is marked");
      // A section that is longer than two windows: its heading and the next are both out of sight in its middle.
      const long = start.headings.findIndex((heading, index) => index + 1 < start.headings.length && start.headings[index + 1].at - heading.at > start.height * 2);
      assert.ok(long >= 0, "the page has a section longer than two windows");
      const [section, next] = [start.headings[long], start.headings[long + 1]];
      await moveTo((section.at + next.at) / 2);
      const middle = await layout();
      assert.ok(middle.headings.every((heading) => heading.top < 0 || heading.top > middle.height), "in the middle of the long section no heading is in the window");
      await one(section.id, "the long section stays marked while none of its headings is in sight");
      // Onwards, a window at a time, to the next section and beyond; then all the way back. At each stop the mark is the last heading above the line.
      const stops = [];
      for (let y = section.at - 300; y < Math.min(next.at + 900, start.end - 50); y += 260) stops.push(y);
      for (const y of [...stops, ...stops.toReversed()]) {
        await moveTo(y);
        await one(above(await layout()), `moved to ${Math.round(y)}`);
      }
      // The heading crosses the line: just under it the section before is still being read, just over it this one.
      await moveTo(next.at - start.line - 40);
      await one(section.id, "the next heading is just below the line");
      await moveTo(next.at - start.line + 40);
      await one(next.id, "the next heading is just above the line");
      await moveTo(next.at - start.line - 40);
      await one(section.id, "and back below it");
      // With the wheel, as a reader moves the page.
      await moveTo(section.at + 400);
      for (let turn = 0; turn < 6; turn++) {
        await page.wheel(640, 400, 500);
        await one(above(await layout()), `after ${turn + 1} turns of the wheel down`);
      }
      for (let turn = 0; turn < 6; turn++) {
        await page.wheel(640, 400, -500);
        await one(above(await layout()), `after ${turn + 1} turns of the wheel up`);
      }
      assert.deepEqual(page.errors, []);
    });

    it("is right at the top, at the end, and for a section that is asked for by its address", async () => {
      // A tall window: at the end of the page the last sections are all in sight, and none of them can reach the line.
      await page.size(1280, 1500);
      await page.open(`${base}how/versions-and-history/`);
      const start = await layout();
      await one(null, "at the top");
      // The end of the page: the last heading in sight is marked.
      await moveTo(start.end + 500);
      const end = await layout();
      const last = end.headings.at(-1);
      assert.ok(last.top > end.line && last.top < end.height, "at the end the last heading is in sight, below the line");
      await one(last.id, "the end of the page");
      await moveTo(0);
      await one(null, "and at the top again");
      // Asked for by its address, on loading: the browser puts the heading at the line.
      const deep = start.headings[2].id;
      await page.open(`${base}how/versions-and-history/#${deep}`);
      await one(deep, `loaded at #${deep}`);
      // A section near the end, asked for by its address: the page cannot move far enough, and it is still the one.
      const below = end.headings.filter((heading) => heading.top > end.line + 40 && heading.top < end.height);
      assert.ok(below.length >= 2, "at the end of the page several headings are in sight below the line");
      const late = below[0];
      assert.notEqual(late.id, last.id);
      await page.open(`${base}how/versions-and-history/#${late.id}`);
      const there = await layout();
      assert.ok(there.y >= there.end - 2 && there.headings.find((heading) => heading.id === late.id).top > there.line, "the section that was asked for cannot reach the line");
      await one(late.id, "a section near the end that was asked for");
      // The reader moves away: the mark goes by where the headings stand again.
      await moveTo(there.end - 900);
      await one(above(await layout()), "moved away from the end");
      await page.size(1280, 700);
      // A click in the list, with and without the page gliding there.
      for (const motion of ["no-preference", "reduce"]) {
        await page.motion(motion);
        await page.open(`${base}how/versions-and-history/`);
        const target = start.headings[3].id;
        await page.click(`.onpage a[href="#${target}"]`);
        await page.until(`return Math.abs(document.getElementById(${JSON.stringify(target)}).getBoundingClientRect().top - parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop)) < 3`, `the page to reach #${target}`);
        await one(target, `clicked in the list, motion ${motion}`);
        assert.equal(await page.run("return document.querySelectorAll('.onpage a[aria-current=\"location\"]').length"), 1, "the one that is marked says so as the current location");
      }
      await page.motion("reduce");
    });

    it("follows the page when its layout changes without any scrolling: the window, the size of the text, a picture that arrives", async () => {
      await page.size(1280, 700);
      await page.open(`${base}docs/cli/`);
      const start = await layout();
      await moveTo(start.headings[4].at + 300);
      await one(above(await layout()), "before anything changes");
      // A window too narrow for the list: nothing is marked while the list is away, and the mark is back, and right, when it returns.
      await page.size(960, 600);
      assert.equal(await page.run("return getComputedStyle(document.querySelector('.onpage')).display"), "none");
      await one(null, "while the window has no room for the list");
      await page.size(1280, 700);
      await one(above(await layout()), "and wide again");
      // A shorter window, and a wider one: the line stays under the header, and the mark with it.
      await page.size(1280, 420);
      await one(above(await layout()), "in a short window");
      await page.size(1700, 900);
      await one(above(await layout()), "in a large window");
      await page.size(1280, 700);
      // Larger text, as a reader sets it or a font that arrives late does.
      await page.run("document.documentElement.style.fontSize = '125%';");
      await one(above(await layout()), "after the text was set larger");
      await page.run("document.documentElement.style.fontSize = '';");
      // Something tall arrives above, as a picture does: the page stays where it is, and what is under the line is another section.
      await moveTo(start.headings[2].at - start.line - 4);
      const steady = await layout();
      await page.run("const block = document.createElement('div'); block.id = 'arrived'; block.style.height = '2600px'; document.querySelector('main h1').after(block); document.documentElement.style.overflowAnchor = 'none';");
      const shifted = await layout();
      assert.notEqual(above(shifted), above(steady), "what is under the line is another section now");
      await one(above(shifted), "after something tall arrived above");
      await page.run("document.getElementById('arrived').remove();");
      await one(above(await layout()), "and after it went again");
      assert.deepEqual(page.errors, []);
    });

    it("marks nothing where there is no list, and nothing breaks: on a phone, and with scripts switched off", async () => {
      await page.size(390, 800, true);
      await page.open(`${base}docs/cli/`);
      await moveTo(3000);
      assert.equal(await page.run("return getComputedStyle(document.querySelector('.onpage')).display"), "none", "a phone has no room for the list");
      await one(null, "on a phone");
      assert.deepEqual(page.errors, []);
      // Without scripts the list is a list of links, each to its section, and none is marked.
      await page.size(1280, 700);
      await page.send("Emulation.setScriptExecutionDisabled", { value: true });
      try {
        // Another page than the one that is open, so that it is loaded anew and not only moved.
        await page.open(`${base}docs/errors/`);
        await page.open(`${base}docs/cli/#exit-codes`);
        assert.equal(await page.run("return document.documentElement.classList.contains('js')"), false);
        assert.equal(await page.run("return document.querySelectorAll('.onpage a[aria-current]').length"), 0);
        assert.ok((await page.run("return [...document.querySelectorAll('.onpage a')].filter((link) => link.checkVisibility() && document.getElementById(decodeURIComponent(link.hash.slice(1)))).length")) >= 6, "every link of the list is in sight and leads to a heading of the page");
        assert.ok(Math.abs(await page.run("return document.getElementById('exit-codes').getBoundingClientRect().top - parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop)")) < 3, "the browser itself goes to the section that was asked for");
      } finally {
        await page.send("Emulation.setScriptExecutionDisabled", { value: false });
      }
    });
  });

  it("has its styles, its links and its search on the page of what is not there, at any depth", async () => {
    await page.size(1280, 900);
    await page.open(`${base}nothing/here/at/all/`);
    assert.equal(await page.run("return document.querySelector('h1').textContent"), "This page is not here");
    assert.notEqual(await page.run("return getComputedStyle(document.querySelector('.top')).position"), "static", "the styles are found from four folders down");
    const results = await search("restore-backup");
    assert.ok(results.length > 0 && results.every((result) => result.href.startsWith("/vigile/")), "the search is found too, and leads into the site from where the page was asked for");
    await page.run("document.getElementById('search').close()");
    await page.click('main a[href="/vigile/docs/"]');
    await page.until(`return location.href === ${JSON.stringify(`${base}docs/`)}`, "the link to the documentation to be followed");
  });

  it("folds the list of pages away on a phone when the script runs, before the page is seen, and leaves it open on a wide window", async () => {
    await page.size(390, 800, true);
    await page.open(`${base}docs/operations/get/`);
    assert.equal(await page.run("return document.querySelector('.side-fold').open"), false);
    assert.equal(await page.run("return [...document.querySelectorAll('.side a')].filter((a) => a.checkVisibility()).length"), 0);
    await page.tap(".side-fold > summary");
    await page.until("return document.querySelector('.side-fold').open", "the list to open");
    await page.size(1280, 900);
    await page.open(`${base}docs/operations/get/`);
    assert.equal(await page.run("return document.querySelector('.side-fold').open"), true);
    assert.equal(await page.run("return getComputedStyle(document.querySelector('[data-search] .when-script')).display !== 'none' && getComputedStyle(document.querySelector('[data-search] .without-script')).display === 'none'"), true, 'with the script, the place of the search says "Search"');
  });
});
