// What the site does once a page is there: the switch between light and dark, the buttons that copy a code
// sample, the mark on the section being read, and the search. Every page works without it; this only adds.

const root = document.documentElement;
const KEY = "vigile-site.scheme";
const system = matchMedia("(prefers-color-scheme: dark)");

// ---- Light and dark ----
function stored() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function paint(dark) {
  root.dataset.scheme = dark ? "dark" : "light";
  for (const button of document.querySelectorAll("[data-scheme-switch]")) {
    button.hidden = false;
    button.title = dark ? "Switch to light" : "Switch to dark";
    button.querySelector("[data-scheme-word]").textContent = button.title;
  }
}
function showScheme() {
  const chosen = stored();
  paint(chosen === "dark" || (chosen !== "light" && system.matches));
}
for (const button of document.querySelectorAll("[data-scheme-switch]")) {
  button.addEventListener("click", () => {
    const dark = root.dataset.scheme !== "dark";
    try {
      // A choice that is what the system says anyway is no choice: the page goes on following the system.
      if (dark === system.matches) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, dark ? "dark" : "light");
    } catch {
      // No storage: the choice holds for this page.
    }
    paint(dark);
  });
}
system.addEventListener("change", showScheme);
showScheme();

// ---- Copying a code sample ----
if (navigator.clipboard) {
  for (const block of document.querySelectorAll("pre")) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy";
    button.textContent = "Copy";
    button.setAttribute("aria-label", "Copy this code");
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(block.querySelector("code").textContent);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Not copied";
      }
      setTimeout(() => (button.textContent = "Copy"), 1600);
    });
    block.append(button);
  }
}

// ---- Which section is being read ----
// The list "On this page" marks the section that is being read. Which one that is, is worked out from where
// the headings stand, each time something moves: the last heading that has gone up past the line where
// reading starts, just under the header. It stays marked through a long section, whose heading is far out of
// sight, until the next heading crosses that line, and comes back when the page is moved the other way. At the
// end of a page, where the last sections are too short to reach the line, the last heading in sight is the
// one; a section that was asked for by its address, and is in sight there, goes first. Without this script the
// list is a list of links, and nothing is marked.
const onPage = [...document.querySelectorAll(".onpage a")];
if (onPage.length) {
  const sections = onPage.map((link) => ({ link, heading: document.getElementById(decodeURIComponent(link.hash.slice(1))) })).filter((section) => section.heading);
  const list = document.querySelector(".onpage");
  /** The section that was asked for by name: by the address of the page, or by a click in the list. */
  let asked = null;
  const named = () => sections.find((section) => section.heading.id === decodeURIComponent(location.hash.slice(1))) ?? null;

  /** The line where reading starts: where the browser puts a heading that is asked for by its address, and a little more. */
  const line = () => {
    const padding = parseFloat(getComputedStyle(root).scrollPaddingTop);
    return (Number.isFinite(padding) ? padding : 0) + 12;
  };

  const reading = () => {
    const at = line();
    const tops = sections.map((section) => section.heading.getBoundingClientRect().top);
    const onScreen = (top) => top >= 0 && top < window.innerHeight;
    let last = null;
    tops.forEach((top, index) => {
      if (top <= at) last = sections[index];
    });
    // Where the page cannot be moved further up, no more headings can cross the line: at its end, or when all of
    // it fits in the window.
    const fits = root.scrollHeight <= window.innerHeight + 2;
    const atEnd = !fits && Math.ceil(window.scrollY + window.innerHeight) >= root.scrollHeight - 2;
    if (!fits && !atEnd) return last;
    // There, what was asked for by name is being read while its heading is in sight.
    if (asked && onScreen(tops[sections.indexOf(asked)])) return asked;
    if (fits) return last;
    // Otherwise, at the end, the last heading that is in sight.
    for (let index = sections.length - 1; index >= 0; index--) if (tops[index] < window.innerHeight) return tops[index] > at ? sections[index] : last;
    return last;
  };

  let marked = null;
  const mark = () => {
    const now = list.offsetParent === null ? null : reading();
    if (now === marked) return;
    marked = now;
    for (const section of sections) {
      // One link is the current one, and says so to those who do not see it.
      if (section === now) section.link.setAttribute("aria-current", "location");
      else section.link.removeAttribute("aria-current");
    }
    // The list scrolls by itself when it is longer than the window: the marked link is kept in sight, in the list only.
    if (now && list.scrollHeight > list.clientHeight) {
      const box = now.link.getBoundingClientRect();
      const frame = list.getBoundingClientRect();
      if (box.top < frame.top) list.scrollTop -= frame.top - box.top + 12;
      else if (box.bottom > frame.bottom) list.scrollTop += box.bottom - frame.bottom + 12;
    }
  };

  // Once for each frame in which something moved, however many things moved.
  let waiting = false;
  const soon = () => {
    if (waiting) return;
    waiting = true;
    requestAnimationFrame(() => {
      waiting = false;
      mark();
    });
  };
  const scrolled = () => {
    // Once the reader moves the page so that the section they asked for is out of sight, it is no longer asked for.
    if (asked) {
      const top = asked.heading.getBoundingClientRect().top;
      if (top < 0 || top >= window.innerHeight) asked = null;
    }
    soon();
  };
  asked = named();
  window.addEventListener("scroll", scrolled, { passive: true });
  window.addEventListener("resize", soon);
  window.addEventListener("load", soon);
  window.addEventListener("hashchange", () => {
    asked = named();
    soon();
  });
  // Where the headings stand changes without any scrolling when a picture or a font arrives, or the text is set larger.
  if ("ResizeObserver" in window) new ResizeObserver(soon).observe(document.querySelector("main") ?? document.body);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(soon);
  mark();
}

// ---- Search ----
// The index is a small file made with the site: every page by its sections. It is fetched the first time the
// search is opened, and searched here: every word of the question must be in a section for it to be found.
const dialog = document.getElementById("search");
const opener = document.querySelector("[data-search]");
if (dialog && opener && typeof dialog.showModal === "function" && window.vigileMarks) {
  const input = dialog.querySelector("input");
  const results = dialog.querySelector(".search-results");
  const status = dialog.querySelector(".search-status");
  const base = root.dataset.root || "./";
  let index = null;
  let loading = null;

  const load = () =>
    (loading ??= fetch(`${base}search.json`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((entries) => {
        index = entries.map(([url, title, heading, text, area]) => ({ url, title, heading, text, area, low: { title: title.toLowerCase(), heading: heading.toLowerCase(), text: text.toLowerCase() } }));
      })
      .catch(() => {
        loading = null;
        status.textContent = "The search could not be loaded. The documentation has a table of contents.";
      }));

  /**
   * A text with the words that were asked for marked in it, as nodes: text, and <mark> around what was found.
   * It is never written as markup, so nothing in a text of the index or in what was typed can become markup.
   */
  const marked = (text, words) => {
    const whole = document.createDocumentFragment();
    for (const piece of window.vigileMarks.pieces(text, words)) {
      if (!piece.marked) whole.append(piece.text);
      else {
        const mark = document.createElement("mark");
        mark.textContent = piece.text;
        whole.append(mark);
      }
    }
    return whole;
  };
  const part = (className, ...children) => {
    const span = document.createElement("span");
    span.className = className;
    span.append(...children);
    return span;
  };

  function search() {
    // What was typed, word by word: as it was typed, for marking it, and in small letters, for finding it.
    const typed = input.value.split(/\s+/).filter(Boolean);
    const words = typed.map((word) => word.toLowerCase());
    results.replaceChildren();
    if (!index || !words.length) {
      status.textContent = index ? "Type what you are looking for: an operation, a setting, an error code, a word." : status.textContent;
      return;
    }
    const found = [];
    for (const entry of index) {
      let score = 0;
      for (const word of words) {
        const inHeading = entry.low.heading.includes(word);
        const inTitle = entry.low.title.includes(word);
        const inText = entry.low.text.includes(word);
        if (!inHeading && !inTitle && !inText) {
          score = 0;
          break;
        }
        score += (entry.low.title === word ? 12 : 0) + (inTitle ? 6 : 0) + (inHeading ? 5 : 0) + (inText ? 1 : 0) + (entry.heading ? 0 : 1);
      }
      if (score) found.push({ entry, score });
    }
    found.sort((a, b) => b.score - a.score);
    status.textContent = found.length ? `${found.length} place${found.length === 1 ? "" : "s"}${found.length > 14 ? ", the first 14 shown" : ""}` : "Nothing found. Every word has to be there; try fewer, or another.";
    for (const { entry } of found.slice(0, 14)) {
      const at = Math.max(0, entry.low.text.indexOf(words[0]) - 50);
      const snippet = `${at > 0 ? "…" : ""}${entry.text.slice(at, at + 150)}${entry.text.length > at + 150 ? "…" : ""}`;
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = base + entry.url;
      link.append(part("search-where", `${entry.area}${entry.heading ? ` · ${entry.title}` : ""}`), part("search-title", marked(entry.heading || entry.title, typed)), part("search-text", marked(snippet, typed)));
      item.append(link);
      results.append(item);
    }
  }

  const open = () => {
    if (dialog.open) return;
    dialog.showModal();
    input.select();
    if (!index) status.textContent = "Loading the index…";
    load().then(search);
  };
  opener.setAttribute("role", "button");
  opener.setAttribute("aria-label", "Search the site");
  opener.setAttribute("aria-haspopup", "dialog");
  opener.addEventListener("click", (event) => {
    event.preventDefault();
    open();
  });
  // It is a button now, and a button is pressed with the space bar as well.
  opener.addEventListener("keydown", (event) => {
    if (event.key !== " ") return;
    event.preventDefault();
    open();
  });
  input.addEventListener("input", search);
  // A click beside the box closes it, as on any dialog.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  // A result on this very page: the address changes only after its #, and the dialog would stay open.
  results.addEventListener("click", (event) => {
    if (event.target.closest("a")) dialog.close();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      results.querySelector("a")?.focus();
    }
  });
  results.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const links = [...results.querySelectorAll("a")];
    const at = links.indexOf(document.activeElement);
    const next = event.key === "ArrowDown" ? links[at + 1] : at > 0 ? links[at - 1] : input;
    next?.focus();
  });
  document.addEventListener("keydown", (event) => {
    const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName));
    if ((event.key === "/" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) || (event.key === "k" && (event.ctrlKey || event.metaKey))) {
      event.preventDefault();
      open();
    }
  });
}
