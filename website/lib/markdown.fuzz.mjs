// Throws made-up Markdown at the reader of website/lib/markdown.mjs and holds it to what it promises: it ends,
// it drops no word, it writes no markup that was not its own, and what it does not take it refuses with the
// file and the line. The documents come from a seed, so one that fails can be made again.
//
// It is run by the site's test in a thread of its own, with a time limit: a reader that never ends cannot be
// stopped from inside the thread it runs in.

import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { MarkdownError, markdown } from "./markdown.mjs";

/** Numbers that look random and are the same for the same seed. */
function numbers(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The tags the reader writes. Anything else between < and > in what it returns came from the source. */
const OWN_TAG = /^<\/?(p|h[1-4]|ul|ol|li|pre|code|a|strong|em|table|thead|tbody|tr|th|td|div|aside)(\s+[a-z-]+="[^"<>]*")*>$/;

/** What is wrong with what the reader returned for a source, or null. `words` are the words the source had. */
function wrongWith(html, words) {
  for (const tag of html.match(/<[^>]*>?/g) ?? []) if (!OWN_TAG.test(tag)) return `markup that is not the reader's own: ${tag.slice(0, 60)}`;
  for (const word of words) if (!html.includes(word)) return `the word ${word} of the source is not in what was returned`;
  return null;
}

/** Blocks the reader takes, each with words of its own. Every line starts in the first column. */
const TAKEN = [
  (w) => [`A paragraph of ${w()} and ${w()}.`],
  (w) => [`Two lines of ${w()}`, `that are one paragraph of ${w()}.`],
  (w) => [`## A heading of ${w()}`],
  (w) => [`### A smaller heading, ${w()} {#${w()}}`],
  (w) => [`#### The fourth level: ${w()}`],
  (w) => [`- an item, ${w()}`, `- another, ${w()}`, `  that goes on with ${w()}`],
  (w) => [`- an item, ${w()}`, `  - one inside it, ${w()}`, `  - and one more, ${w()}`, `- back out, ${w()}`],
  (w) => [`1. first, ${w()}`, `2. second, ${w()}`, "", `   A paragraph of the second: ${w()}.`],
  (w) => ["```sh terminal=first", `echo ${w()}`, "# not a heading: code", "> not a quote either", "```"],
  (w) => ["````", "```", `three backticks inside four: ${w()}`, "```", "````"],
  (w) => [`:::note About ${w()}`, `What the note says of ${w()}.`, "", `- and a list in it, ${w()}`, ":::"],
  (w) => [":::warn", `Take care with ${w()}.`, ":::"],
  (w) => [`| ${w()} | ${w()} |`, "|---|---|", `| ${w()} | a \\| b ${w()} |`, `| \`${w()}\` | **${w()}** |`],
  (w) => [`Marks: **${w()}**, *${w()}*, \`<${w()}>\`, [${w()}](/docs/${w()}/#${w()}), [${w()}](https://example.org/${w()}).`],
  (w) => [`Signs that are text: 3 < 4, ${w()} & ${w()}, "quoted ${w()}", a \\<${w()}\\> and a #${w()}.`],
];

/** Lines the reader does not take. Each stands in the first column, outside any code block. */
const REFUSED = [
  (w) => `:::tip ${w()}`,
  () => ":::",
  (w) => `> a quote of ${w()}`,
  () => "---",
  () => "***",
  () => "===",
  (w) => `+ a plus for ${w()}`,
  (w) => `##### five deep, ${w()}`,
  () => "##",
  (w) => `\`\`\`sh two ${w()}`,
  () => "~~~",
  (w) => `| a row of ${w()} | with no table |`,
  (w) => `<div>${w()}</div>`,
  (w) => `Text with <script>alert("${w()}")</script> in it.`,
  (w) => `![a picture of ${w()}](/assets/${w()}.png)`,
  (w) => `[a link to ${w()}](javascript:alert(1))`,
  (w) => `[a link to ${w()}](http://example.org/)`,
  (w) => `[a link to ${w()}](" onclick="x)`,
  (w) => `{{${w()}}}`,
  (w) => `         indented ${w()}, further than anything above it`,
  (w) => `A character that cannot be shown: \u0001 ${w()}`,
];

/** Pieces to make lines of that mean nothing in particular: marks, prefixes, signs. */
const PIECES = ["", " ", "  ", "    ", "\t", "- ", "* ", "+ ", "1. ", "12. ", "# ", "## ", "##### ", "#", "> ", ":::", ":::note", ":::tip ", "::: warn", "```", "````", "```sh", "~~~", "|", " | ", "|---|---|", "---", "===", "{{", "}}", "{#x}", "<", ">", "<b>", "</p>", "&", '"', "'", "[", "]", "(", ")", "](", "![", "`", "``", "**", "*", "_", "\\", "\\|", "https://", "/docs/", "é", "日本", "😀", "\u0000", "\u0001"];

/**
 * Runs `count` made-up documents from a seed. Returns what did not hold, in words; nothing when all held.
 * A third are made of blocks the reader takes and must be read whole; a third have one line it does not take
 * and must be refused at that line; a third are made of pieces and must be read or refused, and never anything else.
 */
export function fuzz(seed, count) {
  const random = numbers(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const failures = [];
  let read = 0;
  let refused = 0;
  for (let n = 0; n < count; n++) {
    let word = 0;
    const words = [];
    const w = () => {
      const made = `w${seed}x${n}x${word++}q`;
      words.push(made);
      return made;
    };
    const kind = n % 3;
    const lines = [];
    let refusedAt = null;
    if (kind < 2) {
      const blocks = 1 + Math.floor(random() * 6);
      const bad = kind === 1 ? Math.floor(random() * blocks) : -1;
      for (let b = 0; b < blocks; b++) {
        if (lines.length) lines.push("");
        if (b === bad) {
          refusedAt = lines.length + 1;
          lines.push(pick(REFUSED)(w));
        } else lines.push(...pick(TAKEN)(w));
      }
    } else {
      const length = 1 + Math.floor(random() * 14);
      for (let l = 0; l < length; l++) {
        let line = "";
        const pieces = Math.floor(random() * 5);
        for (let p = 0; p < pieces; p++) line += pick(PIECES) + (random() < 0.5 ? w() : "");
        lines.push(line);
      }
    }
    const source = lines.join("\n");
    const say = (what) => failures.push(`seed ${seed}, document ${n}: ${what}\n${source}`);
    let html;
    try {
      html = markdown(source, { file: "fuzz.md" }).html;
    } catch (error) {
      refused++;
      if (!(error instanceof MarkdownError)) say(`it failed with something else than a refusal: ${error.stack}`);
      else if (!/^fuzz\.md:\d+: \S/.test(error.message) || error.line < 1 || error.line > lines.length) say(`the refusal does not say where: ${error.message}`);
      else if (kind === 0) say(`a document of blocks the reader takes was refused: ${error.message}`);
      else if (kind === 1 && error.line !== refusedAt) say(`the refusal names line ${error.line}, and the line that is not taken is ${refusedAt}: ${error.message}`);
      continue;
    }
    read++;
    if (kind === 1) say(`a line the reader does not take was read as if it did, at line ${refusedAt}`);
    const wrong = wrongWith(html, words);
    if (wrong) say(wrong);
  }
  return { failures, read, refused };
}

/**
 * Documents of very long lines, each made of one piece or two said thousands of times: a reader that looks back
 * and forth over a line more often the longer it is would never end on these. Returns how many were read and how
 * many refused; ending at all is what is asked.
 */
export function long(times) {
  let read = 0;
  let refused = 0;
  const failures = [];
  const sources = [];
  for (const piece of PIECES.filter((one) => one !== "")) sources.push(piece.repeat(times), `${piece} word `.repeat(times), `words ${piece}`.repeat(times), Array.from({ length: Math.min(times, 2000) }, () => piece).join("\n"));
  sources.push(`${"| a ".repeat(times)}|\n${"|---".repeat(times)}|\n${"| b ".repeat(times)}|`, `${"- ".repeat(times)}x`, `${" ".repeat(times)}- x`, `[${"a".repeat(times)}](${"/b".repeat(times)})`, `${"**a".repeat(times)}`, `${"`a".repeat(times)}`, `${"\\".repeat(times)}`, `## ${"x ".repeat(times)}{#${"a".repeat(times)}}`);
  for (const source of sources) {
    try {
      markdown(source, { file: "long.md" });
      read++;
    } catch (error) {
      refused++;
      if (!(error instanceof MarkdownError)) failures.push(`a long document failed with something else than a refusal: ${String(error.stack).slice(0, 300)}`);
    }
  }
  return { read, refused, failures, documents: sources.length };
}

if (!isMainThread && workerData?.fuzz) parentPort.postMessage(fuzz(workerData.fuzz.seed, workerData.fuzz.count));
if (!isMainThread && workerData?.long) parentPort.postMessage(long(workerData.long));
// One document, for the test that a source which once made the reader go round for ever is now refused.
if (!isMainThread && workerData?.source !== undefined) {
  try {
    parentPort.postMessage({ html: markdown(workerData.source, { file: workerData.file ?? "page.md", line: workerData.line ?? 1 }).html });
  } catch (error) {
    parentPort.postMessage({ refused: error.message, isRefusal: error instanceof MarkdownError });
  }
}
