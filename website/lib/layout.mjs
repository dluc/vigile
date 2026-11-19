// The frame every page stands in: the head, the header with the three areas, the navigation of the area, the
// list of what is on the page, and the footer. Links are written from the root of the site ("/docs/cli/") and
// turned into relative ones when the page is written, so the site works under any path.

import { AREAS } from "../site.mjs";
import { escapeHtml } from "./markdown.mjs";

const SIGNAL = '<span class="signal" aria-hidden="true"><i></i><i></i><i></i></span>';

const ICON = {
  search: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m10.6 10.6 3.4 3.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  sun: '<svg class="when-dark" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="3.1" fill="currentColor"/><path d="M8 1.2v1.9M8 12.9v1.9M1.2 8h1.9M12.9 8h1.9M3.2 3.2l1.3 1.3M11.5 11.5l1.3 1.3M3.2 12.8l1.3-1.3M11.5 4.5l1.3-1.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  moon: '<svg class="when-light" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M13.4 9.8A5.9 5.9 0 0 1 6.2 2.6a5.9 5.9 0 1 0 7.2 7.2z" fill="currentColor"/></svg>',
};

/** The list of an area's pages, with the place of the current page marked. */
function sideNav(area, groups, current, pages) {
  const item = (path) => {
    const page = pages.get(path);
    const here = path === current.path;
    const children = page.children?.length && (here || current.parent === path) ? `<ul class="side-children">${page.children.map(item).join("")}</ul>` : "";
    return `<li><a href="/${path}"${here ? ' aria-current="page"' : ""}${current.parent === path ? ' class="open"' : ""}>${escapeHtml(page.nav)}</a>${children}</li>`;
  };
  const lists = groups.map((group) => `${group.title ? `<p class="side-title">${escapeHtml(group.title)}</p>` : ""}<ul>${group.pages.map(item).join("")}</ul>`).join("");
  // The list is open as it is written, so that it is there without any script. The script right after it, which
  // runs before the page is drawn, folds it away on a small screen, where it would stand between the reader and
  // the page; if that script does not run, the list stays open.
  return `<nav class="side" aria-label="${escapeHtml(area.title)}"><details class="side-fold" open><summary><span class="side-where">${escapeHtml(area.title)}</span><span class="side-here">${escapeHtml(current.nav)}</span></summary><div class="side-lists">${lists}</div></details><script src="/assets/fold.js"></script></nav>`;
}

function onThisPage(headings) {
  const shown = headings.filter((heading) => heading.level === 2 || heading.level === 3);
  if (shown.length < 2) return "";
  return `<nav class="onpage" aria-label="On this page"><p class="side-title">On this page</p><ul>${shown.map((heading) => `<li class="level-${heading.level}"><a href="#${heading.id}">${heading.html}</a></li>`).join("")}</ul></nav>`;
}

function pager(previous, next) {
  if (!previous && !next) return "";
  const link = (page, rel, label) => (page ? `<a class="pager-${rel}" rel="${rel}" href="/${page.path}"><span class="pager-label">${label}</span><span class="pager-title">${escapeHtml(page.nav)}</span></a>` : "<span></span>");
  return `<nav class="pager" aria-label="Previous and next page">${link(previous, "prev", "Before")}${link(next, "next", "Next")}</nav>`;
}

/**
 * A whole page of HTML. `page` holds its title, description, path and content; `site` the addresses the site
 * is published at; `pages` every page, for the navigation.
 */
export function layout(page, { site, pages, nav, version }) {
  const area = AREAS.find((one) => one.id === page.area);
  const home = page.path === "";
  const title = home ? "Vigile: a shared plan for people and AI agents" : `${page.title} · Vigile`;
  const address = `${site.SITE_URL}${page.path}`;
  const picture = `${site.SITE_URL}assets/og.jpg`;
  const areas = AREAS.map((one) => {
    const current = page.area !== one.id || page.notFound ? "" : page.path === one.path ? ' aria-current="page"' : ' aria-current="true"';
    return `<a href="/${one.path}" data-area="${one.id}"${current}>${escapeHtml(one.title)}</a>`;
  }).join("");

  let main;
  if (page.layout === "home" || page.layout === "plain") {
    main = `<main id="main" tabindex="-1" class="${page.layout}">${page.html}</main>`;
  } else {
    const order = nav[page.area].flatMap((group) => group.pages.flatMap((path) => [path, ...(pages.get(path).children ?? [])]));
    const at = order.indexOf(page.path);
    const crumbs = [`<a href="/${area.path}">${escapeHtml(area.title)}</a>`, ...(page.parent ? [`<a href="/${page.parent}">${escapeHtml(pages.get(page.parent).nav)}</a>`] : [])];
    main = `<div class="shell">
${sideNav(area, nav[page.area], page, pages)}
<main id="main" tabindex="-1">
<article class="prose">
<header class="page-head">
${page.path === area.path ? `<p class="crumbs"><span>${escapeHtml(area.says)}</span></p>` : `<p class="crumbs">${crumbs.join('<span aria-hidden="true"> / </span>')}</p>`}
<h1>${page.titleHtml ?? escapeHtml(page.title)}</h1>
${page.lead ? `<p class="lead">${page.lead}</p>` : ""}
</header>
${page.html}
</article>
${pager(at > 0 ? pages.get(order[at - 1]) : null, at >= 0 && at < order.length - 1 ? pages.get(order[at + 1]) : null)}
</main>
${onThisPage(page.headings)}
</div>`;
  }

  return `<!doctype html>
<html lang="en" data-area="${page.notFound ? "none" : page.area}" data-root="/">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(page.description)}">
${page.notFound ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${escapeHtml(address)}">`}
<meta property="og:type" content="website">
<meta property="og:site_name" content="Vigile">
<meta property="og:title" content="${escapeHtml(home ? title : page.title)}">
<meta property="og:description" content="${escapeHtml(page.description)}">
<meta property="og:url" content="${escapeHtml(address)}">
<meta property="og:image" content="${escapeHtml(picture)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The board of Vigile: tasks in columns by state, from in progress to done">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/assets/favicon.png" type="image/png" sizes="48x48">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link rel="stylesheet" href="/assets/site.css">
<script src="/assets/theme.js"></script>
<script src="/assets/marks.js" defer></script>
<script src="/assets/site.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to the content</a>
<header class="top">
<div class="top-in">
<a class="brand" href="/"${home ? ' aria-current="page"' : ""}>${SIGNAL}<span class="brand-name">Vigile</span></a>
<nav class="areas" aria-label="Areas of the site">${areas}</nav>
<div class="tools">
<a class="tool search-open" href="/docs/#contents" data-search aria-label="Search, or the contents of the documentation">${ICON.search}<span class="tool-word when-script">Search</span><span class="tool-word without-script">Contents</span><kbd class="when-script" aria-hidden="true">/</kbd></a>
<button class="tool scheme" type="button" data-scheme-switch hidden>${ICON.sun}${ICON.moon}<span class="visually-hidden" data-scheme-word>Switch between light and dark</span></button>
</div>
</div>
</header>
${main}
<footer class="foot">
<div class="foot-in">
<div class="foot-brand">${SIGNAL}<p><strong>Vigile</strong> keeps the plan that people and AI agents work from. You run it yourself: one process, one folder, no account anywhere.</p></div>
<nav class="foot-nav" aria-label="The site, by area">
${AREAS.map((one) => `<div><p class="side-title"><a href="/${one.path}">${escapeHtml(one.title)}</a></p><ul>${footLinks(one.id, nav, pages)}</ul></div>`).join("")}
</nav>
<p class="foot-note">This site describes Vigile ${escapeHtml(version)}. The reference pages are made from its code. MIT licence. <a href="${escapeHtml(site.REPO_URL)}">Source on GitHub</a>.</p>
</div>
</footer>
<dialog id="search" class="search" aria-label="Search the site">
<form method="dialog" class="search-form">
<label for="search-input" class="visually-hidden">Search the site</label>
${ICON.search}
<input id="search-input" type="text" role="searchbox" placeholder="An operation, a setting, an error code…" autocomplete="off" spellcheck="false" enterkeyhint="search">
<button type="submit" class="search-close">Close</button>
</form>
<p class="search-status" role="status" aria-live="polite"></p>
<ol class="search-results"></ol>
</dialog>
</body>
</html>
`;
}

/** A few pages of each area, for the footer. */
function footLinks(area, nav, pages) {
  if (area === "product") {
    return [
      ["/#today", "Use today"],
      ["/vision/", "The vision, and the direction"],
      ["/#start", "Try it in two minutes"],
      ["/#limits", "What it does not do"],
    ]
      .map(([href, text]) => `<li><a href="${href}">${text}</a></li>`)
      .join("");
  }
  return nav[area]
    .flatMap((group) => group.pages)
    .filter((path) => path !== (area === "how" ? "how/" : "docs/"))
    .slice(0, 9)
    .map((path) => `<li><a href="/${path}">${escapeHtml(pages.get(path).nav)}</a></li>`)
    .join("");
}

/** Turns the links that start at the root of the site into links from where the page is. */
export function relativeLinks(html, path, basePath = null) {
  const depth = path.split("/").filter(Boolean).length - (path.endsWith(".html") ? 1 : 0);
  const up = basePath ?? (depth ? "../".repeat(depth) : "./");
  return html
    .replace(/\b(href|src|data-root)="\/(?!\/)([^"]*)"/g, (_, name, rest) => `${name}="${rest === "" || rest.startsWith("#") ? `${up}${rest}` : `${up === "./" ? "" : up}${rest}`}"`)
    .replace(/\bsrcset="([^"]+)"/g, (_, set) => `srcset="${set.replace(/(^|,\s*)\/(?!\/)/g, (__, lead) => `${lead}${up === "./" ? "" : up}`)}"`);
}
