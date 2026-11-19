// A small Markdown reader for the site's hand-written pages: headings, paragraphs, lists, tables, fenced code,
// notes, and the inline marks. It knows what these pages use and nothing else, so the site needs no dependency
// to be built.
//
// Three things hold for whatever it is given:
//   - It ends. Every block it reads takes at least one line, and the one place that hands out the next line
//     checks that it did; a block that would take none is a mistake in this file and is said to be one.
//   - It drops nothing. Every word of the source is in what it returns, or it throws.
//   - It writes no markup of the page's own. What it does not know is refused, with the file and the line:
//     a callout it has no name for, a quote, a rule, a picture, a tag of HTML, a link that leads off elsewhere.
//     Nothing unknown is passed through as text in the hope that it was meant as text.

export const escapeHtml = (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The anchor of a heading: its words in lower case, joined by hyphens. */
export const slug = (text) =>
  text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** What is wrong with a page's Markdown, and where: `website/content/how/statuses.md:14: …`. */
export class MarkdownError extends Error {
  constructor(file, line, message) {
    super(`${file}:${line}: ${message}`);
    this.name = "MarkdownError";
    this.file = file;
    this.line = line;
  }
}

/**
 * The text of a page's first lines between two rules of three hyphens, as names and values. `line` is the line
 * of the file the body starts at, for the reader of the body to say where something is.
 */
export function frontMatter(source, file = "page") {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(source);
  if (!match) return { data: {}, body: source, line: 1 };
  const data = {};
  match[1].split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    const colon = line.indexOf(":");
    if (colon < 1) throw new MarkdownError(file, index + 2, `a line of the page's first lines has no name before a colon: ${line}`);
    data[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  });
  return { data, body: source.slice(match[0].length), line: match[0].split("\n").length };
}

/** Where a link may lead: a page of the site, an anchor of this page, or another site over https, or a mail address. */
const LINK = /^(\/(?!\/)[^\s"'<>\\]*|#[A-Za-z0-9_-]+|https:\/\/[^\s"'<>\\]+|mailto:[^\s"'<>\\]+)$/;

/**
 * The marks inside a line: code, links, strong and emphasised words. Everything else is text, written so that
 * the browser shows it and does not read it. `refuse` is told what is not taken.
 */
export function inline(text, refuse = notInAPage) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) refuse("a character that cannot be shown is in the text");
  const kept = [];
  const keep = (html) => `\u0001${kept.push(html) - 1}\u0001`;
  // Code first: nothing inside it is a mark.
  let out = text.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${escapeHtml(code)}</code>`));
  out = out.replace(/\\([*_`[\]\\|{}<>!])/g, (_, character) => keep(escapeHtml(character)));
  // The words of a link, and of a picture, have no [ in them: so a line of many [ is looked over once, not once for each.
  if (/!\[[^[\]]*\]\(/.test(out)) refuse("a picture is not written as ![…](…) here: use {{picture <name> | what it shows}} on a line of its own");
  if (/<\/?[A-Za-z!?]/.test(out)) refuse("HTML is not taken here. Write a tag that is meant as text as code, between backticks, or put a backslash before its <");
  if (/\{\{|\}\}/.test(out)) refuse("{{…}} stands on a line of its own, starting in the first column; here it would be shown as text");
  out = out.replace(/\[([^[\]\n]+)\]\(([^)\n]*)\)/g, (_, label, href) => {
    if (!LINK.test(href)) refuse(`the link to "${href}" is none this site takes: a link leads to a page of the site (/docs/cli/), an anchor of this page (#exit-codes), or https://…`);
    return keep(`<a href="${escapeHtml(href)}">${marks(escapeHtml(label))}</a>`);
  });
  out = marks(escapeHtml(out));
  return out.replace(/\u0001(\d+)\u0001/g, (_, index) => restore(kept, Number(index)));
}

/** What is said of text that is not in a page's Markdown, when nobody says where it is from. */
function notInAPage(message) {
  throw new Error(`${message}.`);
}

const restore = (kept, index) => kept[index].replace(/\u0001(\d+)\u0001/g, (_, inner) => restore(kept, Number(inner)));

const marks = (text) =>
  text
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=$|[\s).,;:!?])/g, "$1<em>$2</em>");

const isRule = (line) => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line) && line.includes("|");
const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());

const LIST_ITEM = /^([-*]|\d+\.)\s+(.*)$/;
const HEADING = /^(#{1,4})\s+(.*?)(?:\s+\{#([a-z0-9-]+)\})?\s*$/;
const FENCE = /^(`{3,})\s*([A-Za-z0-9_-]*)((?:\s+[a-z-]+=[A-Za-z0-9_.~\/-]+)*)\s*$/;
const NOTE = /^:::\s*(note|warn|today|direction)(?:\s+(.*))?$/;
const NOTES = ["note", "warn", "today", "direction"];
/**
 * The two notes that say whether what is in them can be used today or is a direction that is not built. Their
 * labels are their own, so that one cannot be written to read like the other, and they are marked for the test
 * that holds what is said of the future to the places that are labelled so.
 */
const HORIZONS = { today: "Today", direction: "Direction: not built, no date" };

/** Why a line that starts no block this reader knows is not taken, or null when it is plain text. */
function notTaken(line) {
  if (/^:::/.test(line)) return line.trim() === ":::" ? 'a ":::" closes a note, and none is open here' : `"${line.trim().slice(0, 40)}" is no note this site has. A note starts with ":::" and one of: ${NOTES.join(", ")}`;
  if (/^(`{3,}|~{3,})/.test(line)) return 'a code block starts with three backticks, then at most one word for its language and name=value words after it, as in "```sh terminal=first"';
  if (/^#{5,}(\s|$)/.test(line)) return "headings go four deep, and this one has more than four #";
  if (/^#{1,4}$/.test(line)) return "a heading has words after its #";
  if (/^>/.test(line)) return "a quote, written with >, is not taken. Use a note: :::note … :::";
  if (/^([-*_=])\1{2,}\s*$/.test(line)) return "a rule or an underline of ---, ***, ___ or === is not taken. Headings start with #";
  if (/^\+\s/.test(line)) return "a list item starts with - or with a number and a dot, not with +";
  if (/^\|/.test(line)) return "a line that starts with | is a row of a table, and a table starts with its headings and a line of |---|";
  if (/^\s/.test(line)) return "this line is indented and belongs to no list item above it. Text starts in the first column; what continues a list item is indented as far as the item's words";
  return null;
}

/**
 * Turns Markdown into HTML. Returns the HTML and the headings it found.
 *
 * `file` and `line` say where the source is from, for what is said when something in it is not taken. `isToken`
 * tells lines the caller has put in the place of something it renders itself: they pass through whole.
 */
export function markdown(source, options = {}) {
  const file = options.file ?? "markdown";
  const first = options.line ?? 1;
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const headings = [];
  const used = new Set(options.reservedIds ?? []);
  const isToken = options.isToken ?? (() => false);
  const fail = (index, message) => {
    throw new MarkdownError(file, index + first, message);
  };
  const marked = (index, text) => inline(text, (message) => fail(index, message));

  const anchor = (index, text, given) => {
    let id = given ?? slug(text);
    if (!id) id = "section";
    if (!given) {
      let n = 2;
      const base = id;
      while (used.has(id)) id = `${base}-${n++}`;
    } else if (used.has(id)) fail(index, `the anchor "${id}" is used twice on one page`);
    used.add(id);
    return id;
  };

  /** How far a line is indented. */
  const depth = (index) => lines[index].length - lines[index].trimStart().length;
  /** A line as its block sees it: without the indentation of the block. A line that is indented less is not the block's. */
  const at = (index, indent) => lines[index].slice(Math.min(indent, depth(index)));
  const blank = (index) => !lines[index].trim();

  /** Whether a block other than a paragraph starts at this line. */
  const starts = (index, to, indent) => {
    const line = at(index, indent);
    return HEADING.test(line) || /^(`{3,}|~{3,}|:::)/.test(line) || isToken(line.trim()) || LIST_ITEM.test(line) || (line.includes("|") && index + 1 < to && isRule(at(index + 1, indent)));
  };

  /** Reads the block that starts at `i`, adds its HTML to `html`, and returns the line after it. */
  function block(i, to, indent, html) {
    const line = at(i, indent);
    if (isToken(line.trim())) {
      html.push(line.trim());
      return i + 1;
    }
    if (/^(`{3,}|~{3,})/.test(line)) {
      const fence = FENCE.exec(line);
      if (!fence) fail(i, notTaken(line));
      const body = [];
      let end = i + 1;
      // The block ends at a line of the same backticks and nothing else. Any other line is code, also one that starts with backticks.
      while (end < to && at(end, indent).trimEnd() !== fence[1]) body.push(at(end++, indent));
      if (end >= to) fail(i, `the code block that starts with ${fence[1]} is never closed by a line of ${fence[1]} alone`);
      const attributes = fence[3].trim() ? fence[3].trim().split(/\s+/).map((pair) => pair.split("=")) : [];
      if (attributes.length && !fence[2]) fail(i, "a code block with name=value words says its language first");
      if (new Set(attributes.map(([name]) => name)).size !== attributes.length) fail(i, "a code block says each name=value once");
      html.push(`<pre${fence[2] ? ` data-language="${fence[2]}"` : ""}${attributes.map(([name, value]) => ` data-${name}="${escapeHtml(value)}"`).join("")}><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      return end + 1;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      if (!text.trim()) fail(i, "a heading has words after its #");
      const words = marked(i, text);
      const id = anchor(i, text, heading[3]);
      if (level > 1) headings.push({ level, id, text: words.replace(/<[^>]+>/g, ""), html: words });
      html.push(level === 1 ? `<h1>${words}</h1>` : `<h${level} id="${id}"><a class="anchor" href="#${id}">${words}</a></h${level}>`);
      return i + 1;
    }
    if (line.startsWith(":::")) {
      const note = NOTE.exec(line.trimEnd());
      if (!note) fail(i, notTaken(line));
      let end = i + 1;
      while (end < to && at(end, indent).trim() !== ":::") end++;
      if (end >= to) fail(i, 'the note that starts here is never closed by a line of ":::" alone');
      const horizon = Object.hasOwn(HORIZONS, note[1]);
      if (horizon && note[2]?.trim()) fail(i, `a ":::${note[1]}" note has its own label, "${HORIZONS[note[1]]}", and takes no other`);
      const label = horizon ? HORIZONS[note[1]] : note[2]?.trim() || (note[1] === "warn" ? "Take care" : "Note");
      html.push(`<aside class="callout callout-${note[1]}"${horizon ? ` data-horizon="${note[1]}"` : ""}><p class="callout-label">${marked(i, label)}</p>${blocks(i + 1, end, indent)}</aside>`);
      return end + 1;
    }
    if (line.includes("|") && i + 1 < to && isRule(at(i + 1, indent))) {
      const head = cells(line);
      if (cells(at(i + 1, indent)).length !== head.length) fail(i + 1, `the table has ${head.length} headings, and its line of hyphens has another number of cells`);
      const rows = [];
      let end = i + 2;
      while (end < to && !blank(end) && at(end, indent).includes("|")) {
        const row = cells(at(end, indent));
        if (row.length !== head.length) fail(end, `the table has ${head.length} headings, and this row has ${row.length} cells. A | inside a cell is written \\|`);
        rows.push(row.map((cell) => marked(end, cell.replaceAll("\\|", "|"))));
        end++;
      }
      const titles = head.map((cell) => marked(i, cell));
      // A table that is wider than its place is moved sideways, also with the keyboard: it says what it is a table of.
      const label = `Table: ${titles.map((cell) => cell.replace(/<[^>]+>/g, "")).filter(Boolean).join(", ")}`;
      html.push(
        `<div class="table-scroll" tabindex="0" role="group" aria-label="${escapeHtml(label)}"><table><thead><tr>${titles.map((cell) => `<th scope="col">${cell}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
      );
      return end;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[1]);
      const items = [];
      let next = i;
      while (next < to) {
        const here = blank(next) || depth(next) < indent ? null : LIST_ITEM.exec(at(next, indent));
        if (!here || /\d/.test(here[1]) !== ordered) break;
        // The item's words start after its mark. What is indented that far, or is an empty line among such, is the item's.
        const inner = indent + here[1].length + 1;
        let end = next + 1;
        while (end < to && (blank(end) || depth(end) >= inner)) end++;
        while (end > next + 1 && blank(end - 1)) end--;
        const words = marked(next, here[2]);
        const rest = end > next + 1 ? blocks(next + 1, end, inner) : "";
        // A line that goes on under its item, without an empty line between, is more of the same paragraph.
        const goesOn = rest.startsWith("<p>") && !blank(next + 1);
        items.push(`<li>${words}${goesOn ? ` ${rest.replace(/^<p>/, "").replace("</p>", "")}` : rest}</li>`);
        next = end;
        // Empty lines between two items do not end the list.
        let after = next;
        while (after < to && blank(after)) after++;
        if (after < to && depth(after) >= indent && LIST_ITEM.test(at(after, indent))) next = after;
      }
      html.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      return next;
    }
    // A paragraph: up to the next empty line, or the next line that starts something else.
    const refused = notTaken(line);
    if (refused) fail(i, refused);
    const text = [];
    let end = i;
    while (end < to && !blank(end) && depth(end) >= indent && !(end > i && starts(end, to, indent))) {
      const here = at(end, indent);
      const why = notTaken(here);
      if (why) fail(end, why);
      text.push(marked(end, here.trim()));
      end++;
    }
    html.push(`<p>${text.join(" ")}</p>`);
    return end;
  }

  function blocks(from, to, indent) {
    const html = [];
    let i = from;
    while (i < to) {
      if (blank(i)) {
        i++;
        continue;
      }
      if (depth(i) < indent) fail(i, "this line is indented less than the list item it is under");
      const next = block(i, to, indent, html);
      // Every block takes at least one line. One that took none would be read again, for ever.
      if (!(next > i) || next > to) throw new MarkdownError(file, i + first, `the reader of Markdown did not move on from this line. That is a mistake in website/lib/markdown.mjs, not in the page: "${lines[i].slice(0, 60)}"`);
      i = next;
    }
    return html.join("\n");
  }

  return { html: blocks(0, lines.length, 0), headings };
}
