// Looks at a built site as a visitor's browser would find it: every link leads to a page that is there and to
// an anchor that page has, every picture is there and says what it shows, and every page has what a page needs.
// Returns what is wrong, in words; nothing when all is well.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";

const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]));

const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([a-z-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));

export function checkSite(out, { basePath = "/" } = {}) {
  const problems = [];
  const files = walk(out);
  const pages = new Map();
  for (const file of files.filter((one) => one.endsWith(".html"))) {
    const html = readFileSync(file, "utf8");
    pages.set(relative(out, file).replaceAll("\\", "/"), { html, ids: [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]) });
  }

  /** The file a link leads to, from the page it is on. A folder is its index page. */
  const target = (from, href) => {
    const [path] = href.split("#");
    // The 404 page is served at any depth: its links start at the path the site is published under.
    const resolved = path.startsWith("/") ? (path.startsWith(basePath) ? path.slice(basePath.length) : null) : posix.normalize(posix.join(posix.dirname(from), path));
    if (resolved === null || resolved.startsWith("..")) return null;
    // The first folder of the site is written "" here, however a link comes to it: as "./", as "../" from one
    // folder down, as "." or as the path the site is published under. A page is known by its path without
    // "./" in front, and a link to the first page has to find it, with its anchors.
    const plain = resolved.replace(/^\.(\/|$)/, "");
    if (plain === "" || plain.endsWith("/")) return `${plain}index.html`;
    return existsSync(join(out, plain)) && statSync(join(out, plain)).isDirectory() ? null : plain;
  };

  const titles = new Map();
  const descriptions = new Map();
  for (const [name, { html, ids }] of pages) {
    const say = (what) => problems.push(`${name}: ${what}`);
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) say(`the id "${id}" is used twice`);
      seen.add(id);
    }
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
    const description = /<meta name="description" content="([^"]*)">/.exec(html)?.[1];
    if (!title) say("has no title");
    else if (titles.has(title)) say(`has the same title as ${titles.get(title)}`);
    else titles.set(title, name);
    if (!description) say("has no description");
    else if (descriptions.has(description)) say(`has the same description as ${descriptions.get(description)}`);
    else descriptions.set(description, name);
    if (!/<html lang="en"/.test(html)) say("does not say which language it is in");
    if ((html.match(/<h1[ >]/g) ?? []).length !== 1) say("needs exactly one h1");
    if (!/<main id="main"/.test(html)) say("has no main part");
    // Headings go down one level at a time, inside the main part.
    const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
    let level = 0;
    for (const match of main.matchAll(/<h([1-6])[ >]/g)) {
      const next = Number(match[1]);
      if (next > level + 1) say(`a heading of level ${next} follows one of level ${level}`);
      level = next;
    }
    // The page lets nothing run or apply that is written into it, so nothing may be.
    if (/\sstyle="/.test(html)) say("has a style written into an element, which the page's own policy forbids");
    if (/<script(?![^>]*\ssrc=)[^>]*>/.test(html)) say("has a script written into it, which the page's own policy forbids");
    if (/\son[a-z]+="/.test(html)) say("has a handler written into an element, which the page's own policy forbids");

    for (const match of html.matchAll(/<(a|link|script|img|source)\s[^>]*>/g)) {
      const tag = match[0];
      const given = attributes(tag);
      if (match[1] === "img") {
        if (given.alt === undefined) say(`a picture has no alternative text: ${given.src}`);
        if (!given.width || !given.height) say(`a picture does not say its size: ${given.src}`);
      }
      const links = [given.href, given.src, ...(given.srcset ? given.srcset.split(",").map((part) => part.trim().split(/\s+/)[0]) : [])].filter((link) => link !== undefined);
      for (const link of links) {
        if (/^(https:|mailto:)/.test(link)) continue;
        if (/^[a-z]+:/.test(link) || link.startsWith("//")) {
          say(`links to ${link}, which is neither inside the site nor https`);
          continue;
        }
        if (link.startsWith("#")) {
          if (link.length > 1 && !seen.has(link.slice(1))) say(`links to ${link}, and the page has no such anchor`);
          continue;
        }
        const file = target(name, link);
        if (file === null || !existsSync(join(out, file))) {
          say(`links to ${link}, and there is nothing there`);
          continue;
        }
        const anchor = link.split("#")[1];
        if (!anchor) continue;
        // A page that is linked to is a page that was read: one that is not known here would have its anchors left unchecked.
        if (file.endsWith(".html") && !pages.has(file)) say(`links to ${link}, which leads to ${file}, and that is no page this check has read: its anchor cannot be looked for`);
        else if (pages.has(file) && !pages.get(file).ids.includes(anchor)) say(`links to ${link}, and that page has no anchor "${anchor}"`);
      }
    }
  }

  for (const name of ["index.html", "404.html", "sitemap.xml", "robots.txt", "search.json", ".nojekyll", "assets/site.css", "assets/site.js", "assets/marks.js", "assets/fold.js", "assets/theme.js", "assets/favicon.svg", "assets/og.jpg"]) {
    if (!existsSync(join(out, name))) problems.push(`${name} is missing`);
  }
  return problems;
}

/** The pages of a built site that the sitemap names, as paths inside the site. */
export function sitemapPaths(out, siteUrl) {
  const xml = readFileSync(join(out, "sitemap.xml"), "utf8");
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => (match[1].startsWith(siteUrl) ? match[1].slice(siteUrl.length) : match[1]));
}
