// Builds the web site into a folder that is not committed: website/dist unless told otherwise.
//
//   pnpm build && node website/build.mjs [--out <folder>] [--base /vigile/] [--site-url https://example.org/vigile/] [--vigile <program>]
//
// It needs the `vigile` program, which `pnpm build` makes, and nothing else of the product: it reads no file
// of the product's code. It asks the program to describe itself (`vigile describe`), and it runs the program:
// it starts services on 127.0.0.1, each on a free port with its config and data in a temporary folder of its
// own, speaks to them over their HTTP API, and stops them and removes their folders before it ends. It needs
// no browser: the pictures are files in the repository, kept by the project's maintainers.
//
// The program is `bin/vigile` of this repository unless the variable VIGILE_BIN or the option --vigile names
// another: see website/lib/program.mjs.
//
// The pages are the hand-written ones in website/content, in Markdown, and the reference pages, which are made
// from the description: the operations, the settings, the commands, the error codes, the statuses and the
// link types. The build stops, saying why, and ends with an error when a page is missing from the navigation,
// when a part made from the description has no words for something the program has, when an example is
// refused by the service, or when a link or a picture leads nowhere.
//
// Every link inside the site is relative, so the built folder works under any path. The base path is only for
// what has to be absolute: the links of the 404 page, which is served at any depth, and with the address of
// the site (--site-url, or SITE_URL) the sitemap and the picture of a shared link. See website/site.mjs.
//
// The site is built in a new folder beside the one asked for and put in its place at the end, so a build can
// run while the one before it is being served.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { basePath } from "./lib/base.mjs";
import { checkSite } from "./lib/check.mjs";
import { closeExamples } from "./lib/examples.mjs";
import { readFacts } from "./lib/facts.mjs";
import { generators, notesPath, operationPage } from "./lib/generate.mjs";
import { layout, relativeLinks } from "./lib/layout.mjs";
import { MarkdownError, escapeHtml, frontMatter, inline, markdown } from "./lib/markdown.mjs";
import { useProgram } from "./lib/program.mjs";
import * as site from "./site.mjs";

const here = dirname(fileURLToPath(import.meta.url));
/** Where the hand-written pages are, unless a test says otherwise. */
const contentRoot = join(here, "content");
const assetsRoot = join(here, "assets");
const diagramsRoot = join(here, "diagrams");

const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]));

/** The address of a page inside the site, from the place of its file: how/statuses.md is how/statuses/. */
function pathOf(file, root) {
  const name = relative(root, file).replaceAll("\\", "/").replace(/\.(md|html)$/, "");
  if (name === "404") return "404.html";
  if (name === "index") return "";
  return name.endsWith("/index") ? `${name.slice(0, -"index".length)}` : `${name}/`;
}

const text = (html) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Builds the site into `out` and returns what it wrote. `siteUrl` is where it will be published, and `vigile`
 * the program the site describes, when it is another than the one of this repository.
 * Throws, with what to do, when something does not fit.
 */
export async function build({ out = join(here, "dist"), siteUrl = site.SITE_URL, base, repoUrl = site.REPO_URL, content = contentRoot, vigile } = {}) {
  out = resolve(out);
  if (vigile) useProgram(vigile);
  // The base path alone moves the site under the same host; an address of the site says both.
  let address;
  try {
    address = new URL(siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`);
  } catch {
    throw new Error(`The address of the site, "${siteUrl}", is not an address. It is written whole, as in https://example.org/vigile/.`);
  }
  if (address.protocol !== "https:" && address.protocol !== "http:") throw new Error(`The address of the site, "${siteUrl}", has to start with https://.`);
  address.pathname = basePath(base ?? address.pathname);
  address.search = "";
  address.hash = "";
  // Where the code is: an address, written into the pages. It is read as one, so that nothing in it is anything else.
  let code;
  try {
    code = new URL(repoUrl);
  } catch {
    throw new Error(`The address of the code, "${repoUrl}", is not an address. It is written whole, as in https://github.com/dluc/vigile.`);
  }
  if (code.protocol !== "https:") throw new Error(`The address of the code, "${repoUrl}", has to start with https://.`);
  const settings = { SITE_URL: address.href, REPO_URL: code.href.replace(/\/$/, "") };
  // Built beside its place and moved there when it is whole: whatever serves the folder never sees half a site.
  const working = `${out}.building-${process.pid}`;
  // A build that was killed left its folder behind. One whose process is gone is cleared away; one that is
  // still at work is left alone.
  for (const name of existsSync(dirname(out)) ? readdirSync(dirname(out)) : []) {
    const left = /^(.*)\.(?:building|old)-(\d+)$/.exec(name);
    if (!left || join(dirname(out), left[1]) !== out || alive(Number(left[2]))) continue;
    rmSync(join(dirname(out), name), { recursive: true, force: true });
  }
  let written;
  try {
    written = await write(working, settings, address.pathname, content);
  } catch (error) {
    // What was begun is not left behind, and the site that was there before stays as it was.
    rmSync(working, { recursive: true, force: true });
    throw error;
  } finally {
    // No service that was started for the examples outlives the build.
    await closeExamples();
  }
  // The new site takes the place of the old one: two renames, and the old one is removed after.
  const old = `${out}.old-${process.pid}`;
  if (existsSync(out)) renameSync(out, old);
  renameSync(working, out);
  rmSync(old, { recursive: true, force: true });
  return { out, ...written };
}

/** Whether a process of this number runs. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Writes the whole site into a folder, which it empties first. */
async function write(out, settings, under, contentRoot) {
  const code = await readFacts();
  const made = generators(code, settings);
  const pictures = JSON.parse(readFileSync(join(assetsRoot, "pictures", "pictures.json"), "utf8"));

  /** A picture of the page, in the sizes it was taken in, light and dark where it has both. */
  function picture(args) {
    const [first, alt, caption] = args.split("|").map((part) => part.trim());
    const [name, ...flags] = first.split(/\s+/);
    const known = Object.hasOwn(pictures, name) ? pictures[name] : null;
    if (!known) throw new Error(`{{picture ${name}}}: there is no such picture. There are: ${Object.keys(pictures).join(", ")}, in website/assets/pictures.`);
    if (!alt) throw new Error(`{{picture ${name}}} has no alternative text. Say what the picture shows, after a "|".`);
    // How wide the picture is drawn, for the browser to choose a file: a phone's is small, the first one of the
    // home page is as wide as the page, one beside a text of the home page a little over half of it, and one in
    // running text as wide as the text, or 640 pixels on a narrow screen, where it is moved sideways.
    const sizes =
      known.kind === "phone"
        ? "(min-width: 720px) 300px, 70vw"
        : flags.includes("eager")
          ? "(min-width: 1290px) 1240px, 96vw"
          : flags.includes("half")
            ? "(min-width: 1290px) 720px, (min-width: 900px) 56vw, 94vw"
            : "(max-width: 820px) 640px, (min-width: 1180px) 800px, 70vw";
    const largest = known.widths.at(-1);
    const image = (scheme, only) => {
      const file = (width) => `/assets/pictures/${name}-${scheme}-${width}.webp`;
      const eager = flags.includes("eager");
      return `<img${only ? ` class="only-${scheme}"` : ""} src="${file(largest)}" srcset="${known.widths.map((width) => `${file(width)} ${width}w`).join(", ")}" sizes="${sizes}" width="${known.width}" height="${known.height}" alt="${escapeHtml(alt)}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">`;
    };
    const images = known.schemes.length > 1 ? known.schemes.map((scheme) => image(scheme, true)).join("") : image(known.schemes[0], false);
    return `<figure class="figure shot shot-${known.kind}${flags.includes("bare") ? " bare" : ""}"><div class="frame">${images}</div>${caption ? `<figcaption>${inline(caption)}</figcaption>` : ""}</figure>`;
  }

  /** A diagram drawn by hand, put into the page itself so that it takes the page's colours. */
  function diagram(args) {
    const [name, caption] = args.split("|").map((part) => part.trim());
    const file = join(diagramsRoot, `${name}.svg`);
    if (!existsSync(file)) throw new Error(`{{diagram ${name}}}: there is no ${relative(here, file)}.`);
    const svg = readFileSync(file, "utf8").replace(/<\?xml[^>]*\?>\s*/, "").trim();
    if (!/<title[ >]/.test(svg)) throw new Error(`${relative(here, file)} has no <title>: say what the diagram shows.`);
    const title = /<title[^>]*>([^<]*)<\/title>/.exec(svg)[1];
    // A caption that is made from the diagram's scenario and from what a service worked out of it: {{diagram next | from the scenario}}.
    const words = caption === "from the scenario" ? code.contract.diagrams[name]?.caption : caption;
    if (caption === "from the scenario" && !words) throw new Error(`{{diagram ${name} | from the scenario}}: website/diagrams/${name}.json has no scenario a caption is made from.`);
    // On a narrow screen the drawing keeps a size it can be read at, and is moved sideways with a finger or the keyboard.
    return `<figure class="figure diagram"><div class="diagram-scroll" tabindex="0" role="group" aria-label="Diagram: ${escapeHtml(title)}">${svg}</div>${words ? `<figcaption>${inline(words)}</figcaption>` : ""}</figure>`;
  }

  /**
   * Puts what the page asks for in the place of each {{…}}, and turns the rest from Markdown into HTML. `line`
   * is the line of the file the source starts at: every line of the source stays on its line, so that what is
   * wrong in a page is said with the line it is on.
   */
  function expand(source, { asMarkdown = true, file = "", line: first = 1 } = {}) {
    const tokens = [];
    const lines = source.split("\n");
    const body = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const open = /^\{\{([a-z-]+)(.*)$/.exec(line);
      if (!open) {
        body.push(line);
        continue;
      }
      const at = i + first;
      let args = open[2];
      let inner = null;
      let taken = 0;
      if (args.trimEnd().endsWith("}}")) args = args.trimEnd().slice(0, -2);
      else {
        const rows = [];
        i++;
        while (i < lines.length && lines[i].trim() !== "}}") rows.push(lines[i++]);
        if (i >= lines.length) throw new MarkdownError(file, at, `{{${open[1]} is never closed with }}`);
        inner = rows.join("\n");
        taken = rows.length + 1;
      }
      const name = open[1];
      let html;
      try {
        html = name === "picture" ? picture(args) : name === "diagram" ? diagram(args) : name === "toc" ? toc(args.trim()) : Object.hasOwn(made.block, name) ? made.block[name](args, inner) : null;
      } catch (error) {
        throw error instanceof MarkdownError ? error : new MarkdownError(file, at, `{{${name}}}: ${error.message}`);
      }
      if (html === null) throw new MarkdownError(file, at, `there is nothing called {{${name}}}`);
      body.push(`\u0000${tokens.push(html) - 1}\u0000`, ...Array.from({ length: taken }, () => ""));
    }
    const withValues = body.map((line, index) =>
      line.replace(/\{\{=([a-z.]+)\}\}/g, (_, name) => {
        if (!Object.hasOwn(made.inlineValues, name)) throw new MarkdownError(file, index + first, `there is no value called {{=${name}}}`);
        // In a page of Markdown the value is text like the rest. In a page of HTML it is written as text here.
        return asMarkdown ? made.inlineValues[name] : escapeHtml(made.inlineValues[name]);
      }),
    );
    const html = asMarkdown ? markdown(withValues.join("\n"), { file, line: first, isToken: (line) => /^\u0000\d+\u0000$/.test(line) }).html : withValues.join("\n");
    return html.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
  }

  // The hand-written pages.
  const pages = new Map();
  /** The pages of an area as cards, for its first page. Filled in once every page is known. */
  const tocs = [];
  function toc(area) {
    tocs.push(area);
    return `\u0002toc:${area}\u0002`;
  }
  for (const file of walk(contentRoot)) {
    if (!/\.(md|html)$/.test(file)) continue;
    // The notes of the operations are parts of generated pages, not pages.
    if (dirname(file) === join(contentRoot, "docs", "operations") && !file.endsWith("index.md")) continue;
    // A page is called by its place in the content folder, wherever that folder is.
    const source = join("content", relative(contentRoot, file)).replaceAll("\\", "/");
    const { data, body, line } = frontMatter(readFileSync(file, "utf8"), source);
    const path = pathOf(file, contentRoot);
    if (!data.title || !data.description) throw new MarkdownError(source, 1, "the page needs a title and a description in its first lines");
    const area = path.startsWith("how/") ? "how" : path.startsWith("docs/") ? "docs" : "product";
    pages.set(path, {
      path,
      area,
      title: data.title,
      nav: data.nav ?? data.title,
      description: data.description,
      card: data.card ?? data.description,
      lead: data.lead
        ? inline(data.lead, (message) => {
            throw new MarkdownError(source, 1, `in "lead": ${message}`);
          })
        : null,
      layout: data.layout ?? (path === "404.html" ? "plain" : "page"),
      notFound: path === "404.html",
      source,
      terminals: data.terminals ?? null,
      body,
      line,
      asMarkdown: file.endsWith(".md"),
    });
  }

  // The page of each operation, under the page that lists them. Their examples are run side by side, each
  // against a service: the pages are made at once, and put in the order of the operations.
  const operationsIndex = pages.get("docs/operations/");
  if (!operationsIndex) throw new Error("There is no content/docs/operations/index.md.");
  operationsIndex.children = [];
  const operationPages = await Promise.allSettled(code.operations.map((operation) => operationPage(operation, notesPath(contentRoot, operation), (body, line) => expand(body, { file: `content/docs/operations/${operation.command}.md`, line }), code.contract, code.limits)));
  // The first page that could not be made says why, once all of them have ended and no service is left at work.
  for (const made of operationPages) if (made.status === "rejected") throw made.reason;
  for (const [index, operation] of code.operations.entries()) {
    const path = `docs/operations/${operation.command}/`;
    const page = operationPages[index].value;
    pages.set(path, { ...page, path, area: "docs", parent: "docs/operations/", layout: "page", titleHtml: `<code>${escapeHtml(operation.name)}</code>`, generated: true, source: `content/docs/operations/${operation.command}.md` });
    operationsIndex.children.push(path);
  }
  for (const file of readdirSync(join(contentRoot, "docs", "operations"))) {
    if (file !== "index.md" && !code.operations.some((operation) => `${operation.command}.md` === file)) throw new Error(`content/docs/operations/${file} is the notes of no operation. Remove it, or name it after one.`);
  }

  // Every page has its place in the navigation, and every place its page.
  const listed = new Set(Object.values(site.NAV).flatMap((groups) => groups.flatMap((group) => group.pages)));
  for (const path of listed) if (!pages.has(path)) throw new Error(`website/site.mjs lists the page "${path}", and there is no such page in website/content.`);
  for (const page of pages.values()) if (!listed.has(page.path) && !page.parent && !page.notFound) throw new Error(`${page.source} is not in the navigation. Add "${page.path}" to NAV in website/site.mjs.`);

  for (const page of pages.values()) {
    if (page.body !== undefined) page.html = expand(page.body, { asMarkdown: page.asMarkdown, file: page.source, line: page.line });
  }
  made.block["commands-check"]();
  const shell = [...pages.values()].flatMap((page) => {
    const blocks = shellBlocks(page);
    // A page whose commands count on a terminal that is set up says so, and where the setting up is described.
    if (blocks.some((block) => block.terminal) && page.terminals !== "fresh" && !page.html.includes('href="/docs/install/#in-every-terminal"')) {
      throw new Error(`${page.source} has commands that count on a terminal with vigile on its PATH and VIGILE_CONFIG set, and does not say so. Say it, with a link to /docs/install/#in-every-terminal.`);
    }
    return blocks;
  });
  for (const page of pages.values()) {
    page.html = page.html.replace(/\u0002toc:([a-z]+)\u0002/g, (_, area) => {
      const groups = site.NAV[area];
      if (!groups) throw new Error(`{{toc ${area}}}: there is no such area.`);
      return groups
        .filter((group) => group.title)
        .map((group) => `<h3 id="${group.title.toLowerCase().replace(/[^a-z]+/g, "-")}"><a class="anchor" href="#${group.title.toLowerCase().replace(/[^a-z]+/g, "-")}">${escapeHtml(group.title)}</a></h3><ul class="cards">${group.pages.map((path) => `<li><a class="card" href="/${path}"><span class="card-title">${escapeHtml(pages.get(path).title)}</span><span class="card-says">${escapeHtml(pages.get(path).card)}</span></a></li>`).join("")}</ul>`)
        .join("\n");
    });
    page.headings = [...page.html.matchAll(/<h([23]) id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g)].map((match) => ({ level: Number(match[1]), id: match[2], html: match[3].replace(/<a class="anchor"[^>]*>|<\/a>/g, "") }));
  }

  // Write everything.
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(assetsRoot, join(out, "assets"), { recursive: true, filter: (source) => !source.endsWith("pictures.json") });

  const search = [];
  for (const page of pages.values()) {
    const html = layout(page, { site: settings, pages, nav: site.NAV, version: code.version });
    const file = join(out, page.path.endsWith(".html") ? page.path : join(page.path, "index.html"));
    mkdirSync(dirname(file), { recursive: true });
    // The 404 page is served at any depth, so its links start at the path the site is published under.
    writeFileSync(file, relativeLinks(html, page.path, page.notFound ? under : null));
    if (page.notFound) continue;
    // The index of the search: each page by its sections, with the words of each.
    const area = site.AREAS.find((one) => one.id === page.area).title;
    const parts = page.html.replace(/<pre[^>]* data-noindex[^>]*>[\s\S]*?<\/pre>/g, " ").split(/(?=<h[23] id=")/);
    for (const part of parts) {
      const heading = /^<h[23] id="([^"]+)"[^>]*>([\s\S]*?)<\/h[23]>/.exec(part);
      const words = text(heading ? part.slice(heading[0].length) : part);
      if (!heading && !words && page.path !== "") continue;
      search.push([heading ? `${page.path}#${heading[1]}` : page.path, page.title, heading ? text(heading[2]) : "", heading ? words : `${page.description} ${words}`, area]);
    }
  }
  writeFileSync(join(out, "search.json"), JSON.stringify(search));

  const indexed = [...pages.values()].filter((page) => !page.notFound);
  writeFileSync(join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${indexed.map((page) => `  <url><loc>${settings.SITE_URL}${page.path}</loc></url>`).join("\n")}\n</urlset>\n`);
  writeFileSync(join(out, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${settings.SITE_URL}sitemap.xml\n`);
  // GitHub Pages runs a site through Jekyll unless told not to, which would drop files whose names start with "_".
  writeFileSync(join(out, ".nojekyll"), "");

  const files = walk(out);
  const bytes = files.reduce((sum, file) => sum + statSync(file).size, 0);
  const names = files.map((file) => relative(out, file).replaceAll("\\", "/"));
  return {
    siteUrl: settings.SITE_URL,
    basePath: under,
    // Every block of commands of the hand-written pages, with the terminal it is typed in, for the test that types them.
    shell,
    // The example of each operation as the page shows it, for the test that types it against a real service.
    examples: [...pages.values()].filter((page) => page.example).map((page) => ({ path: page.path, ...page.example })),
    pages: [...pages.values()].map(({ path, area, title, description, generated, source }) => ({ path, area, title, description, generated: Boolean(generated), source })),
    files: names,
    bytes,
    // What the program says of itself and what a service was seen to do: what the pages were made from.
    facts: code,
  };
}

/** What a block of commands may be left out of the test for, and what a page's terminals may start with. */
export const SKIPS = {
  network: "it fetches from the network",
  "other-program": "it is a command of another program",
  placeholder: "it has a part that stands for something else: a key, a token, a file named after a moment",
  "second-service": "it would start the service a second time on the same data",
};
export const SETTINGS_OF_TERMINALS = {
  fresh: "nothing is there but the command at ~/code/vigile/bin/vigile: no instance, nothing on the PATH",
  running: "an instance called main runs, and the terminal has vigile on its PATH and VIGILE_CONFIG set, as Install and first run leaves it",
  "running-demo": "the same, and the instance holds the made-up plan the pictures show",
};

/**
 * The blocks of shell commands of a page, in order, each with what the page says of where it is typed. A block
 * says its terminal, or why it is not run: the test types every block that names a terminal, in that terminal,
 * and a page cannot have one that says neither.
 */
function shellBlocks(page) {
  const found = [];
  for (const match of page.html.matchAll(/<pre data-language="sh"([^>]*)><code>([\s\S]*?)<\/code><\/pre>/g)) {
    const given = Object.fromEntries([...match[1].matchAll(/data-([a-z-]+)="([^"]*)"/g)].map((one) => [one[1], one[2]]));
    const text = match[2].replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
    const where = `${page.source}: the block of commands that starts with "${text.split("\n")[0].slice(0, 50)}"`;
    // The examples of the operations' pages are made and run by the build, and typed by their own test.
    if (given.example) continue;
    for (const name of Object.keys(given)) if (!["terminal", "stays", "skip"].includes(name)) throw new Error(`${where} says ${name}=, which is nothing a block of commands says. It says terminal=, stays= or skip=.`);
    if (Boolean(given.terminal) === Boolean(given.skip)) {
      throw new Error(`${where} has to say which terminal it is typed in, as in "\`\`\`sh terminal=first", or why it is not run, as in "\`\`\`sh skip=network" (${Object.keys(SKIPS).join(", ")}). It says ${given.terminal ? "both" : "neither"}.`);
    }
    if (given.skip && !Object.hasOwn(SKIPS, given.skip)) throw new Error(`${where} is left out for "${given.skip}", which is no reason there is. The reasons: ${Object.keys(SKIPS).join(", ")}.`);
    if (given.stays && (given.stays !== "running" || !given.terminal)) throw new Error(`${where} says stays=${given.stays}. A block whose last command keeps running says its terminal and stays=running.`);
    if (given.terminal && !/^[a-z]+$/.test(given.terminal)) throw new Error(`${where} names its terminal "${given.terminal}". A terminal is named in small letters: first, second.`);
    if (given.terminal && !(page.terminals && Object.hasOwn(SETTINGS_OF_TERMINALS, page.terminals))) {
      throw new Error(`${page.source} has commands to type and does not say what its terminals start with. Add "terminals:" to its first lines, with one of: ${Object.keys(SETTINGS_OF_TERMINALS).join(", ")}.`);
    }
    found.push({ page: page.path, source: page.source, setting: page.terminals, terminal: given.terminal ?? null, stays: given.stays === "running", skip: given.skip ?? null, text });
  }
  return found;
}

/** The options of the command: --out, --base, --site-url and --vigile, each with a value. */
function options(argv) {
  const known = { "--out": "out", "--base": "base", "--site-url": "siteUrl", "--vigile": "vigile" };
  const given = {};
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = argv[i].split(/=(.*)/s);
    if (!Object.hasOwn(known, name)) throw new Error(`There is no option ${argv[i]}. Usage: node website/build.mjs [--out <folder>] [--base /vigile/] [--site-url <address>] [--vigile <program>]`);
    const value = inline ?? argv[++i];
    if (value === undefined || value === "") throw new Error(`${name} needs a value.`);
    given[known[name]] = value;
  }
  return given;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const started = performance.now();
  try {
    const built = await build(options(process.argv.slice(2)));
    const problems = checkSite(built.out, { basePath: built.basePath });
    if (problems.length) {
      console.error(`The site was built into ${built.out}, and ${problems.length} thing${problems.length === 1 ? " is" : "s are"} wrong in it:`);
      for (const problem of problems) console.error(`  ${problem}`);
      process.exit(1);
    }
    const by = (area) => built.pages.filter((page) => page.area === area && page.path !== "404.html").length;
    console.log(`Built ${built.pages.length} pages into ${built.out} in ${((performance.now() - started) / 1000).toFixed(1)} s: ${by("product")} of the product, ${by("how")} of how it works, ${by("docs")} of the documentation (${built.pages.filter((page) => page.generated).length} made from what the program says of itself), and the 404 page.`);
    console.log(`${built.files.length} files, ${(built.bytes / 1024 / 1024).toFixed(1)} MB. Published at ${built.siteUrl}`);
    console.log(`Look at it: node website/serve.mjs --dir ${relative(process.cwd(), built.out) || "."} --base ${built.basePath}`);
  } catch (error) {
    console.error(`The site was not built: ${error.message}`);
    process.exit(1);
  }
}
