// Holds the reader of the pages' Markdown to what it promises: it ends, it drops nothing, it writes no markup
// that is not its own, and what it does not take it refuses with the file and the line.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "./build.mjs";
import { MarkdownError, frontMatter, inline, markdown } from "./lib/markdown.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * Runs the reader in a thread of its own and gives it a time to end in. A reader that goes round for ever
 * cannot be stopped from the thread it runs in; from here its thread is ended and the test fails.
 */
function inItsOwnThread(workerData, within) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./lib/markdown.fuzz.mjs", import.meta.url), { workerData });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`The reader of Markdown did not end within ${within / 1000} seconds.`));
    }, within);
    worker.once("message", (message) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(message);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const refusal = (source, options) => {
  try {
    markdown(source, { file: "page.md", ...options });
  } catch (error) {
    assert.ok(error instanceof MarkdownError, `refused as a mistake in the page, not as: ${error.stack}`);
    return error.message;
  }
  return null;
};

describe("the reader of the pages' Markdown", () => {
  it("refuses a note it has no name for, with the file and the line, where it once went round for ever", async () => {
    const answer = await inItsOwnThread({ source: "Some words.\n\n:::tip\nA tip.\n:::\n", file: "content/docs/install.md", line: 7 }, 5000);
    assert.equal(answer.html, undefined, "nothing is made of it");
    assert.equal(answer.isRefusal, true);
    assert.equal(answer.refused, 'content/docs/install.md:9: ":::tip" is no note this site has. A note starts with ":::" and one of: note, warn, today, direction');
    // The other lines that the reader of a paragraph once stopped at without taking them.
    for (const [source, line, says] of [
      [":::", 1, /closes a note, and none is open/],
      ["Text.\n:::\nmore", 2, /closes a note, and none is open/],
      ["``` sh two words\ncode\n```", 1, /a code block starts with three backticks/],
      ["Text.\n```sh not=ALLOWED!\nx\n```", 2, /a code block starts with three backticks/],
      ["~~~\ncode\n~~~", 1, /a code block starts with three backticks/],
    ]) {
      const one = await inItsOwnThread({ source, file: "page.md" }, 5000);
      assert.match(one.refused ?? "", new RegExp(`^page\\.md:${line}: `), `${JSON.stringify(source)} is refused at line ${line}: ${one.refused ?? one.html}`);
      assert.match(one.refused, says);
    }
  });

  it("refuses what it does not take, each with the line it is on, and never shows it as text", () => {
    for (const [source, line, says] of [
      ["> a quote", 1, /a quote, written with >, is not taken/],
      ["Words.\n\n---\n\nMore.", 3, /a rule or an underline/],
      ["A title\n=======", 2, /a rule or an underline/],
      ["***", 1, /a rule or an underline/],
      ["+ a plus", 1, /starts with - or with a number and a dot/],
      ["##### too deep", 1, /headings go four deep/],
      ["##", 1, /a heading has words/],
      ["## ", 1, /a heading has words/],
      ["| a | b |\n| c | d |", 1, /a table starts with its headings and a line of \|---\|/],
      ["| a | b |\n|---|---|\n| only one |", 3, /this row has 1 cells/],
      ["| a | b |\n|---|\n| c | d |", 2, /its line of hyphens has another number of cells/],
      ["<div>markup</div>", 1, /HTML is not taken here/],
      ["Words with <b>bold</b> in them.", 1, /HTML is not taken here/],
      ["- an item with <script>alert(1)</script>", 1, /HTML is not taken here/],
      ["| a |\n|---|\n| <img src=x onerror=alert(1)> |", 3, /HTML is not taken here/],
      ["## A heading with <i>markup</i>", 1, /HTML is not taken here/],
      ["![a picture](/assets/x.png)", 1, /a picture is not written as/],
      ["[a link](javascript:alert(1))", 1, /the link to "javascript:alert\(1" is none this site takes/],
      ["[a link](http://example.org/)", 1, /is none this site takes/],
      ['[a link](/docs/" onclick="alert(1))', 1, /is none this site takes/],
      ["[a link](//example.org/)", 1, /is none this site takes/],
      ["{{settings}} in the middle of words", 1, /stands on a line of its own/],
      ["   {{settings}}", 1, /indented and belongs to no list item/],
      ["    indented, under nothing", 1, /indented and belongs to no list item/],
      ["- an item\n      - far too deep", 2, /indented and belongs to no list item/],
      ["```sh\nnever closed", 1, /is never closed by a line of ``` alone/],
      ["```sh\ncode\n``` trailing", 1, /is never closed/],
      [":::note\nnever closed", 1, /is never closed by a line of ":::" alone/],
      [":::note\ninner\n::: trailing\n:::", 3, /is no note this site has/],
      ["```sh terminal=first terminal=second\nx\n```", 1, /says each name=value once/],
      ["``` terminal=first\nx\n```", 1, /says its language first/],
      ["## Twice {#same}\n\n## Again {#same}", 3, /the anchor "same" is used twice/],
      ["Words \u0001 with what cannot be shown", 1, /a character that cannot be shown/],
    ]) {
      const said = refusal(source);
      assert.ok(said, `${JSON.stringify(source)} is refused`);
      assert.match(said, new RegExp(`^page\\.md:${line}: `), `${JSON.stringify(source)} is refused at line ${line}: ${said}`);
      assert.match(said, says, JSON.stringify(source));
    }
    // The line is the line of the file: the first lines of a page, between its two rules, count.
    const page = "---\ntitle: A page\ndescription: Of something.\n---\n\nWords.\n\n:::tip\nNo.\n:::\n";
    const { body, line } = frontMatter(page, "content/x.md");
    assert.equal(line, 5);
    assert.match(refusal(body, { file: "content/x.md", line }), /^content\/x\.md:8: ":::tip" is no note/);
    assert.throws(() => frontMatter("---\ntitle: A page\nno colon here\n---\n", "content/x.md"), /^MarkdownError: content\/x\.md:3: a line of the page's first lines has no name before a colon/);
  });

  it("reads what the pages are written in, and writes signs as text", () => {
    const html = (source) => markdown(source, { file: "page.md" }).html;
    assert.equal(html("One line\nand another.\n\nA second paragraph."), "<p>One line and another.</p>\n<p>A second paragraph.</p>");
    assert.equal(html("## Exit codes"), '<h2 id="exit-codes"><a class="anchor" href="#exit-codes">Exit codes</a></h2>');
    assert.equal(html("### `vigile serve` {#serve}"), '<h3 id="serve"><a class="anchor" href="#serve"><code>vigile serve</code></a></h3>');
    assert.equal(html("- one\n- two\n  goes on\n\n- three"), "<ul><li>one</li><li>two goes on</li><li>three</li></ul>");
    assert.equal(html("1. one\n2. two\n\n   Its paragraph.\n\nAfter the list."), "<ol><li>one</li><li>two<p>Its paragraph.</p></li></ol>\n<p>After the list.</p>");
    assert.equal(html("- out\n  - in\n  - in too\n- out again"), "<ul><li>out<ul><li>in</li><li>in too</li></ul></li><li>out again</li></ul>");
    assert.equal(html("```sh terminal=first stays=running\nvigile serve\n```"), '<pre data-language="sh" data-terminal="first" data-stays="running"><code>vigile serve</code></pre>');
    assert.equal(html("````\n```\nfenced\n```\n````"), "<pre><code>```\nfenced\n```</code></pre>");
    assert.equal(html("```text\n# no heading\n> no quote\n:::tip\n<b>no markup</b>\n```"), '<pre data-language="text"><code># no heading\n&gt; no quote\n:::tip\n&lt;b&gt;no markup&lt;/b&gt;</code></pre>');
    // The two notes that say whether something can be used today or is a direction have their own labels, and a mark for the test.
    assert.equal(html(":::direction\nAccess by team.\n:::"), '<aside class="callout callout-direction" data-horizon="direction"><p class="callout-label">Direction: not built, no date</p><p>Access by team.</p></aside>');
    assert.equal(html(":::today\nOne service.\n:::"), '<aside class="callout callout-today" data-horizon="today"><p class="callout-label">Today</p><p>One service.</p></aside>');
    assert.match(refusal(":::direction Shipping in spring\nAccess by team.\n:::"), /^page\.md:1: a ":::direction" note has its own label, "Direction: not built, no date", and takes no other/);
    assert.equal(html(":::warn Before a network\nRequire keys.\n:::"), '<aside class="callout callout-warn"><p class="callout-label">Before a network</p><p>Require keys.</p></aside>');
    assert.match(html("| Code | Means |\n|---|---|\n| `1` | a \\| b |"), /<th scope="col">Code<\/th><th scope="col">Means<\/th><\/tr><\/thead><tbody><tr><td><code>1<\/code><\/td><td>a \| b<\/td><\/tr>/);
    assert.equal(html("**strong**, *stressed*, `code`, [a page](/docs/cli/#exit-codes), [elsewhere](https://example.org/a?b=1&c=2)."), '<p><strong>strong</strong>, <em>stressed</em>, <code>code</code>, <a href="/docs/cli/#exit-codes">a page</a>, <a href="https://example.org/a?b=1&amp;c=2">elsewhere</a>.</p>');
    // Signs that are text stay text: nothing the browser would read as markup comes out of them.
    assert.equal(html('3 < 4 & 5 > 2, "quoted", a \\<tag\\>, `<agent|person>` and 1 * 2 * 3.'), "<p>3 &lt; 4 &amp; 5 &gt; 2, &quot;quoted&quot;, a &lt;tag&gt;, <code>&lt;agent|person&gt;</code> and 1 * 2 * 3.</p>");
    assert.equal(inline('"><script>x</script>'.replaceAll("<", "\\<")), "&quot;&gt;&lt;script&gt;x&lt;/script&gt;");
    // A line the caller put in the place of something it renders itself passes through, between paragraphs or inside one.
    const token = "\u00007\u0000";
    assert.equal(markdown(`Before.\n${token}\nAfter.`, { isToken: (line) => line === token }).html, `<p>Before.</p>\n${token}\n<p>After.</p>`);
  });

  it("reads or refuses whatever it is given: it always ends, drops no word, and writes no markup that is not its own", async () => {
    let read = 0;
    let refused = 0;
    for (const seed of [1, 2, 3, 4]) {
      const result = await inItsOwnThread({ fuzz: { seed, count: 1500 } }, 30_000);
      assert.deepEqual(result.failures.slice(0, 3), [], `seed ${seed}`);
      read += result.read;
      refused += result.refused;
    }
    // Both happened, often: the documents were neither all taken nor all refused.
    assert.ok(read > 1500 && refused > 1500, `${read} read, ${refused} refused`);
  });

  it("ends on lines of any length: its work does not grow faster than the line", async () => {
    // Lines of 80,000 pieces. Read once over, they take about a second; a reader whose work grew with the
    // square of the length took minutes for them, and is ended by the time limit.
    const result = await inItsOwnThread({ long: 80_000 }, 20_000);
    assert.deepEqual(result.failures, []);
    assert.ok(result.read > 20 && result.refused > 20, `${result.documents} long documents: ${result.read} read, ${result.refused} refused`);
  });

  it("stops the build at the line of a page, in the file's own count, also below what the build puts in", async () => {
    const folder = mkdtempSync(join(tmpdir(), "vigile-site-markdown-"));
    try {
      const content = join(folder, "content");
      const broken = async (page, change, says) => {
        rmSync(content, { recursive: true, force: true });
        cpSync(join(here, "content"), content, { recursive: true });
        const file = join(content, page);
        writeFileSync(file, change(readFileSync(file, "utf8")));
        await assert.rejects(build({ out: join(folder, "site"), content }), (error) => {
          assert.match(error.message, says);
          return true;
        });
      };
      // The page has parts made by the build above the line that is wrong; the line is still its own.
      const statuses = readFileSync(join(here, "content", "how", "statuses.md"), "utf8");
      assert.match(statuses, /\{\{statuses-diagram\}\}[\s\S]*\{\{task-statuses\}\}/);
      const lines = statuses.split("\n").length;
      await broken("how/statuses.md", (text) => `${text}\n:::tip\nA tip.\n:::\n`, new RegExp(`^content/how/statuses\\.md:${lines + 1}: ":::tip" is no note this site has`));
      await broken("how/statuses.md", (text) => text.replace("{{task-statuses}}", "{{task-statuses-of-old}}"), /^content\/how\/statuses\.md:\d+: there is nothing called \{\{task-statuses-of-old\}\}/);
      await broken("docs/cli.md", (text) => text.replace("## Exit codes", "## Exit codes\n\n> Read this first."), /^content\/docs\/cli\.md:\d+: a quote, written with >, is not taken/);
      await broken("docs/operations/get.md", (text) => `${text}\n<details>hidden</details>\n`, /^content\/docs\/operations\/get\.md:\d+: HTML is not taken here/);
      await broken("docs/install.md", (text) => text.replace("```sh terminal=second\nvigile doctor", "```sh\nvigile doctor"), /content\/docs\/install\.md: the block of commands that starts with "vigile doctor" has to say which terminal it is typed in/);
      assert.ok(!readFileSync(join(here, "content", "how", "statuses.md"), "utf8").includes(":::tip"), "the pages themselves were not touched");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
