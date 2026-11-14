import { LARGE, STATES, clearGraph, renderGraph, resizeGraph, zoomGraph } from "./graph.js";
import { lights } from "./lights.js";

/**
 * What the browser remembers for the page. A browser may refuse to remember anything, as one that blocks all
 * cookies does, or run out of room: the page then keeps its choices for as long as it is open, and works.
 */
function remembering(name) {
  let real = null;
  try {
    real = window[name];
    real.getItem("vigile.key");
  } catch {
    real = null;
  }
  // What the browser would not take is kept here, and answers for as long as the page is open: a value it would
  // not store, and also nothing, for a value it would not let go of.
  const kept = new Map();
  // What another tab stores is newer than what this page kept for itself, and takes its place.
  window.addEventListener("storage", (event) => {
    if (!real || event.storageArea !== real) return;
    if (event.key === null) kept.clear();
    else kept.delete(event.key);
  });
  const inBrowser = (key) => {
    try {
      return real ? real.getItem(key) : null;
    } catch {
      return null;
    }
  };
  return {
    getItem(key) {
      if (kept.has(key)) return kept.get(key);
      try {
        return real ? real.getItem(key) : null;
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        if (!real) throw new Error("refused");
        real.setItem(key, value);
        kept.delete(key);
      } catch {
        kept.set(key, String(value));
      }
    },
    /**
     * Takes a value away if it is this very one: from what the page kept for itself, and from the browser only
     * when that is what the browser has. Another tab may have stored another value under the name meanwhile,
     * and that one is not this page's to take away.
     */
    removeItemIf(key, value) {
      // What the page keeps for itself under the name, if anything: a value the browser would not store, or
      // nothing, for one it would not let go of.
      const own = kept.has(key) ? kept.get(key) : undefined;
      let stored = inBrowser(key);
      let stuck = false;
      if (stored === value) {
        try {
          real.removeItem(key);
          stored = null;
        } catch {
          stuck = true;
        }
      }
      if (own === value) {
        // The value was the page's own. Under it the browser may still have an older one, which this value had
        // taken the place of: that one must not come back now.
        if (stored === null) kept.delete(key);
        else kept.set(key, null);
      } else if (own === undefined && stuck) {
        // The browser has the value and would not let go of it: to the page it is gone.
        kept.set(key, null);
      }
      // A different value that the page keeps for itself is a newer one, and stays; so does a different value
      // in the browser, which another tab stored.
    },
    removeItem(key) {
      try {
        real?.removeItem(key);
        kept.delete(key);
      } catch {
        // The browser still has a value under the name and would not let go of it. To the page it is gone: an
        // older value must not come back in place of the one that was just taken away.
        kept.set(key, null);
      }
    },
  };
}
const localStorage = remembering("localStorage");
const sessionStorage = remembering("sessionStorage");

const REFRESH_MS = 3000;
const SCROLL_NAME = "vigile.scroll";
const PROJECTS_NAME = "vigile.projects";
const FOCUS_NAME = "vigile.focus";
const THEME_NAME = "vigile.theme";
const WATCH_NAME = "vigile.watching";
const MOTION_NAME = "vigile.motion";
const LIGHTS_NAME = "vigile.lights";
const SCHEME_NAME = "vigile.scheme";
/** Where each sound's switch is remembered. */
const SOUND_NAMES = { created: "vigile.sound-created", started: "vigile.sound-started", done: "vigile.sound" };
const THEMES = ["vigile", "dado", "jeev", "gito"];
const narrow = matchMedia("(max-width: 640px)");
const KEY_NAME = "vigile.key";
const AUTO_NAME = "vigile.auto-refresh";
const BUGS_NAME = "vigile.bugs-apart";

const $ = (id) => document.getElementById(id);

/** Builds an element. Text always goes in as text, never as markup. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === "class") node.className = value;
    // Set as the element's own style, not as text in an attribute: the page's policy lets no style written
    // into the markup apply, so that nothing slipped into the page can restyle it.
    else if (name === "style") node.style.cssText = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else if (name in node && typeof value !== "string") node[name] = value;
    else node.setAttribute(name, value);
  }
  node.append(...present(children));
  return node;
}

/** Children as they can be appended: nested lists flattened, and nothing for null, undefined or false. */
const present = (children) => children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);

class ApiError extends Error {
  constructor(status, body, key) {
    super(body?.message ?? `The service answered ${status}`);
    this.status = status;
    this.code = body?.code;
    /** The key the request was sent with, or nothing: a refusal is of that key, not of whichever is stored by now. */
    this.key = key ?? "";
  }
}

async function api(path, input) {
  const key = localStorage.getItem(KEY_NAME);
  const response = await fetch(`/api/${path}`, {
    method: input === undefined ? "GET" : "POST",
    headers: { ...(input === undefined ? {} : { "content-type": "application/json" }), ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: input === undefined ? undefined : JSON.stringify(input),
    // A request that gets no answer at all is given up, so that the page can ask again instead of waiting for ever.
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body?.error, key);
  keyInUse = key ?? "";
  return body;
}

/** The key the service last answered to, or nothing when it answered without one. */
let keyInUse = "";

async function all(path, field, input = {}) {
  const items = [];
  const session = sessions;
  let continuation;
  do {
    // A list comes in pages. Should the key be refused between two of them, the rest is not asked for.
    if (session !== sessions) throw new Error("The page was locked out while it was reading.");
    const page = await api(path, { ...input, ...(continuation ? { continuation } : {}) });
    items.push(...page[field]);
    continuation = page.continuation;
  } while (continuation);
  return items;
}

const COLUMNS = [
  { key: "trouble", title: "Bugs, issues and incidents", tone: "bug", note: "Not finished yet, in any state" },
  { key: "in_progress", title: "In progress", tone: "busy" },
  { key: "in_review", title: "In review", tone: "review" },
  { key: "next", title: "Next", tone: "go" },
  { key: "waiting", title: "Waiting for dependencies", tone: "wait" },
  { key: "paused", title: "Paused", tone: "idle" },
  { key: "draft", title: "Draft", tone: "idle" },
  { key: "done", title: "Done", tone: "go" },
  { key: "cancelled", title: "Cancelled", tone: "idle" },
];

const STATUS_TONE = {
  in_progress: "busy", in_review: "review", open: "go", done: "go", ready: "go",
  in_preview: "review", broken: "stop", paused: "idle", draft: "idle", cancelled: "idle",
};

const label = (status) => status.replaceAll("_", " ");

function columnOf(task) {
  if (task.status === "open") return task.is_waiting ? "waiting" : "next";
  return task.status;
}

const FINISHED = ["done", "cancelled"];
const isTrouble = (task) => task.type !== "task";

const isOpenTrouble = (task) => isTrouble(task) && !FINISHED.includes(task.status);

/**
 * Where a task goes on the board: the column for its state. When the person asks for it, unfinished bugs, issues
 * and incidents get a column of their own instead. They are there because of what they are, not because of their
 * state, so inside that column a heading for each state says which ones are being worked on.
 */
const boardColumn = (task) => (state.bugsApart && isOpenTrouble(task) ? "trouble" : columnOf(task));

const state = { projects: [], tasks: [], byId: new Map(), snapshot: "", instance: null, project: null, filter: "", expanded: new Set(), view: "board", trail: [], hideFinished: false, collapsed: true, bugsApart: localStorage.getItem(BUGS_NAME) === "on", columnScroll: localStorage.getItem(SCROLL_NAME) !== "page", motion: localStorage.getItem(MOTION_NAME), lights: localStorage.getItem(LIGHTS_NAME) === "on", sounds: Object.fromEntries(Object.entries(SOUND_NAMES).map(([what, name]) => [what, localStorage.getItem(name) === "on"])), projectsFolded: localStorage.getItem(PROJECTS_NAME) === "folded", focus: localStorage.getItem(FOCUS_NAME) === "on", full: false, group: null, open: null, failed: false, large: false };

/** How a project appears in a task's `contained_in`: numbered projects carry their kind in front. */
const projectRef = (project) => (/^\d+$/.test(project.id) ? `project:${project.id}` : project.id);

/** Whether a task sits in a project, directly or through the tasks that contain it. */
function inProject(task, ref, seen = new Set()) {
  if (seen.has(task.id)) return false;
  seen.add(task.id);
  return task.contained_in.some((holder) => {
    if (holder === ref) return true;
    const parent = state.byId.get(holder);
    return parent ? inProject(parent, ref, seen) : false;
  });
}

/** Whether a task sits inside a group, directly or through the groups in between. */
function inGroup(task, groupId, seen = new Set()) {
  if (seen.has(task.id)) return false;
  seen.add(task.id);
  return task.contained_in.some((holder) => {
    if (holder === groupId) return true;
    const parent = state.byId.get(holder);
    return parent ? inGroup(parent, groupId, seen) : false;
  });
}

function matches(task) {
  if (state.project && !inProject(task, state.project)) return false;
  if (state.group && !inGroup(task, state.group)) return false;
  const text = state.filter.trim().toLowerCase();
  if (!text) return true;
  return [task.id, task.title, ...task.assigned_to].some((value) => value.toLowerCase().includes(text));
}

function pill(status) {
  return el("span", { class: `pill ${STATUS_TONE[status] ?? ""}` }, label(status));
}

function renderProjects() {
  $("projects-section").classList.toggle("folded", state.projectsFolded);
  $("projects-fold").setAttribute("aria-expanded", String(!state.projectsFolded));
  $("projects-chevron").textContent = state.projectsFolded ? "▸" : "▾";
  const cards = state.projects.map((project) => {
    const { finished, total } = project.progress;
    const percent = total ? Math.round((finished / total) * 100) : 0;
    const pressed = state.project === projectRef(project);
    // With one project selected, the others step back.
    const dimmed = state.project && !pressed ? " dimmed" : "";
    const choose = () => {
      state.project = pressed ? null : projectRef(project);
      render();
    };
    // Folded, a project is one small item: its ID, its progress, and a mark when it has problems.
    if (state.projectsFolded) {
      return el(
        "button",
        { class: `project-chip${pressed ? " selected" : ""}${dimmed}`, type: "button", "aria-pressed": String(pressed), title: `${project.title}: ${finished} of ${total} finished. ${pressed ? "Show all projects" : "Show only this project"}`, onclick: choose },
        el("span", { class: "project-id" }, project.id),
        el("span", { class: "bar", role: "img", "aria-label": `${percent}% finished` }, el("i", { style: `width:${percent}%` })),
        el("span", {}, `${finished}/${total}`),
        project.has_problems && el("span", { class: "warn", title: "Has problems" }, "⚠"),
      );
    }
    return el(
      "div",
      { class: `project${pressed ? " selected" : ""}${dimmed}` },
      el(
        "button",
        {
          class: "project-main",
          type: "button",
          "aria-pressed": String(pressed),
          title: pressed ? "Show all projects" : "Show only this project",
          onclick: choose,
        },
        el("div", { class: "project-head" }, el("span", { class: "project-id" }, project.id), pill(project.status)),
        el("div", { class: "project-title", title: project.title }, project.title),
        el("div", { class: "bar", role: "img", "aria-label": `${percent}% finished` }, el("i", { style: `width:${percent}%` })),
      ),
      el(
        "div",
        { class: "project-foot" },
        el("span", {}, `${finished} of ${total} finished`),
        el(
          "button",
          { class: `tag${project.has_problems ? " warn" : ""} tag-button`, type: "button", onclick: () => openItem("project", project.id) },
          project.has_problems ? "⚠ problems" : "details",
        ),
      ),
    );
  });
  $("projects").replaceChildren(...(cards.length ? cards : [el("p", { class: "empty" }, "No projects yet.")]));
}

/** The first few of a list, then how many more there are, so one card never grows without limit. */
const few = (items, shown = 3) => (items.length > shown ? [...items.slice(0, shown), `+${items.length - shown} more`] : items);

/** A container as a short chip: a numbered project is written without its kind. */
const chip = (ref) => ref.replace(/^project:/, "");

function card(task) {
  const groups = task.contained_in.filter((ref) => state.byId.has(ref));
  const projects = task.contained_in.filter((ref) => !state.byId.has(ref));
  const tags = present([
    task.progress && el("span", { class: "tag group", title: "Tasks finished inside this group" }, `${task.progress.finished}/${task.progress.total} done`),
    watched.has(task.id) && el("span", { class: "tag watched", title: "You are watching this task: a sound plays when it is done" }, "watching"),
    few(task.assigned_to).map((user) => el("span", { class: "tag who" }, user)),
    task.is_waiting && el("span", { class: "tag waiting", title: task.waiting_for.map(chip).join(", ") }, `waits for ${few(task.waiting_for.map(chip)).join(", ")}`),
    task.has_problems && el("span", { class: "tag warn" }, "⚠ problem"),
    few(groups).map((id) => el("span", { class: "tag", title: state.byId.get(id)?.title ?? "" }, `in ${id}`)),
    !state.project && few(projects.map(chip)).map((id) => el("span", { class: "tag" }, id)),
  ]);
  return el(
    "button",
    { class: `card${task.has_problems ? " problem" : ""}${isTrouble(task) ? " trouble" : ""}${task.progress ? " is-group" : ""}`, type: "button", "data-id": task.id, "data-status": task.status, onclick: () => openItem("task", task.id) },
    el(
      "div",
      { class: "card-top" },
      el("span", { class: "id" }, task.id),
      isTrouble(task) && el("span", { class: "type" }, task.type),
      task.priority !== 0 && el("span", { class: `priority${task.priority >= 5 ? " high" : ""}`, title: "Priority" }, `P${task.priority}`),
    ),
    el("div", { class: "card-title" }, task.title),
    tags.length ? el("div", { class: "tags" }, tags) : null,
  );
}

/** Whether each column scrolls by itself. On a phone the columns are stacked and the page scrolls. */
const columnMode = () => state.columnScroll && !narrow.matches;

/** How many cards a column shows before asking: few on a page that scrolls as a whole, more in a column that scrolls by itself. */
const columnShown = () => (columnMode() ? 50 : 12);

/** With columns that scroll by themselves, the board is as tall as the room left in the window. */
function fitBoard() {
  const board = $("board");
  const on = columnMode() && state.view === "board";
  document.body.classList.toggle("column-scroll", on);
  if (!on || $("main").hidden) return board.style.removeProperty("--board-height");
  // Fitting the board can remove the page's scrollbar, which widens the page and can move the board up: measure again.
  for (let round = 0; round < 3; round++) {
    const top = board.getBoundingClientRect().top + window.scrollY;
    const height = `${Math.max(360, Math.floor(window.innerHeight - top - 12))}px`;
    if (board.style.getPropertyValue("--board-height") === height) break;
    board.style.setProperty("--board-height", height);
  }
}

/**
 * How many card-widths the Done column takes. It is usually the longest column, so when the window is wider
 * than the columns need, it gets the spare room, up to four card-widths and never more than it has cards.
 */
function doneSpan(columns, cards) {
  const board = $("board");
  if (narrow.matches || !board.clientWidth) return 1;
  const style = getComputedStyle(board);
  const widest = parseFloat(style.getPropertyValue("--column-widest"));
  const gap = parseFloat(style.columnGap) || 0;
  const spare = board.clientWidth - (columns * widest + (columns - 1) * gap);
  return 1 + Math.max(0, Math.min(Math.floor(spare / (widest + gap)), cards - 1, 3));
}

function renderBoard(tasks) {
  const groups = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));
  for (const task of tasks) (groups[boardColumn(task)] ??= []).push(task);
  const order = COLUMNS.map((c) => c.key);
  groups.trouble.sort((a, b) => order.indexOf(columnOf(a)) - order.indexOf(columnOf(b)) || b.priority - a.priority);
  groups.next.sort((a, b) => b.priority - a.priority);
  groups.done.sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));

  // With no tasks at all there is nothing to lay out: one message says why.
  const visible = tasks.length ? COLUMNS.filter((c) => groups[c.key].length || ["in_progress", "next", "done"].includes(c.key)) : [];
  state.span = doneSpan(visible.length, groups.done.length);
  state.spanFor = [visible.length, groups.done.length];
  const columns = visible.map((c) => {
    let shown = groups[c.key];
    let more = null;
    const span = c.key === "done" ? state.span : 1;
    const limit = columnShown() * span;
    if (shown.length > limit) {
      const open = state.expanded.has(c.key);
      more = el(
        "button",
        { class: "more", type: "button", "aria-expanded": String(open), onclick: () => (open ? state.expanded.delete(c.key) : state.expanded.add(c.key), render()) },
        open ? `Show the first ${limit}` : `Show all ${shown.length}`,
      );
      if (!open) shown = shown.slice(0, limit);
    }
    // The column for bugs, issues and incidents holds them in every unfinished state, under a heading for each.
    const cards = c.key === "trouble"
      ? COLUMNS.filter((s) => shown.some((task) => columnOf(task) === s.key)).flatMap((s) => [
          el("h3", { class: "lane", "data-tone": s.tone }, el("span", { class: "dot" }), s.title, el("span", { class: "count" }, String(groups.trouble.filter((task) => columnOf(task) === s.key).length))),
          shown.filter((task) => columnOf(task) === s.key).map(card),
        ])
      : shown.map(card);
    return el(
      "section",
      { class: `column${span > 1 ? " wide" : ""}`, "data-tone": c.tone, "data-key": c.key, style: span > 1 ? `--span: ${span}` : undefined },
      el("div", { class: "column-head" }, el("span", { class: "dot" }), c.title, el("span", { class: "count" }, String(groups[c.key].length))),
      c.note && el("p", { class: "column-note" }, c.note),
      shown.length ? el("div", { class: "cards" }, cards) : el("p", { class: "nothing" }, "Nothing here."),
      more,
    );
  });
  // Drawing the board again must not make a reader lose their place: each column, and the board itself, stays
  // scrolled where it was.
  const scrolled = new Map([...$("board").querySelectorAll(".column")].map((column) => [column.dataset.key, column.querySelector(".cards")?.scrollTop ?? 0]));
  const across = $("board").scrollLeft;
  $("board").replaceChildren(...columns);
  for (const column of columns) {
    const cards = column.querySelector(".cards");
    if (cards && scrolled.get(column.dataset.key)) cards.scrollTop = scrolled.get(column.dataset.key);
  }
  $("board").scrollLeft = across;
  keepMarks();
}

/** The counts above the tasks, the same in both views. */
function renderSummary(tasks) {
  // Counted as the board shows them: with bugs in a column of their own, they are not also among the waiting or the next.
  const count = (key) => tasks.filter((t) => boardColumn(t) === key).length;
  const trouble = tasks.filter(isOpenTrouble).length;
  const problems = tasks.filter((t) => t.has_problems).length;
  $("summary").replaceChildren(...present([
    el("span", {}, el("b", {}, String(tasks.length)), " tasks"),
    el("span", {}, el("b", {}, String(count("in_progress"))), " in progress"),
    el("span", {}, el("b", {}, String(count("next"))), " next"),
    el("span", {}, el("b", {}, String(count("waiting"))), " waiting"),
    el("span", {}, el("b", {}, String(count("done"))), " done"),
    trouble ? el("span", { class: "tag trouble" }, `${trouble} open ${trouble === 1 ? "bug, issue or incident" : "bugs, issues and incidents"}`) : null,
    problems ? el("span", { class: "tag warn" }, `⚠ ${problems} with problems`) : null,
  ]));
  const project = state.projects.find((p) => projectRef(p) === state.project);
  const group = state.group ? state.byId.get(state.group) : null;
  // With the top section folded away the filter is out of sight, so the line that says what is shown names it too.
  const filter = state.focus && state.filter.trim() ? `, matching "${state.filter.trim()}"` : "";
  const where = [project ? `${project.id} · ${project.title}` : "all projects", group ? `${group.id} · ${group.title}` : null].filter(Boolean).join(" › ") + filter;
  $("scope").replaceChildren(
    ...present([
      el("span", { class: "scope-text", title: where }, `in ${where}`),
      group && el("button", { class: "tag-button", type: "button", onclick: () => ((state.group = null), render()) }, "✕ leave group"),
    ]),
  );
}

const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * The address after the # names the view and, when one is open, the item: #board, #graph/VIG-041,
 * #board/project:VIG. So an item can be bookmarked, and the browser's Back returns to the one before it.
 */
function readRoute() {
  const [, view, item] = /^#(board|graph)(?:\/(.*))?$/.exec(location.hash) ?? [];
  let id = null;
  try {
    id = item ? decodeURIComponent(item) : null;
  } catch {
    // An address that was cut off or mistyped names no item: the view is shown without one.
  }
  return { view: view ?? "board", open: !id ? null : id.startsWith("project:") ? { kind: "project", id: id.slice(8) } : { kind: "task", id } };
}

const routeOf = (view, open) => `#${view}${open ? `/${open.kind === "project" ? "project:" : ""}${encodeURIComponent(open.id)}` : ""}`;
const sameItem = (a, b) => Boolean(a && b && a.kind === b.kind && a.id === b.id);

/** Goes to an address as a new entry in the browser's history. The entry remembers the items the panel came through. */
function go(view, open, trail = []) {
  const route = routeOf(view, open);
  if (route === location.hash) return;
  history.pushState({ trail }, "", route);
  applyRoute();
}

/** Shows what the address says: called when it changes, by this page or by Back and Forward. */
function applyRoute() {
  const route = readRoute();
  const viewChanged = route.view !== state.view;
  state.view = route.view;
  state.trail = history.state?.trail ?? [];
  if (viewChanged) render();
  if (!route.open) return hidePanel();
  const reopen = !sameItem(route.open, state.open) || $("panel").hidden;
  state.open = route.open;
  if (reopen && state.loadedAt) renderDetail();
}

/** Opens an item in the panel. Opened from inside the panel, it remembers the item it came from. */
/** Finds the control the panel was opened from, as it is now, so that the keyboard can go back to it. */
let panelOpener = null;

function openItem(kind, id) {
  const next = { kind, id };
  if (sameItem(next, state.open) && !$("panel").hidden) return;
  if ($("panel").hidden) panelOpener = keyboardPlace();
  go(state.view, next, state.open && !$("panel").hidden ? [...state.trail, { ...state.open, title: state.openTitle }] : []);
}

const RELATIONS = {
  contains: "Contains",
  "is contained": "Inside",
  "depends on": "Depends on",
  "is depended on by": "Needed by",
  "assigned to": "Assigned to",
  "is assigned": "Assigned",
};

/** One section of the panel: a block of its own with a heading. */
const block = (title, ...children) => el("section", { class: "block" }, el("h3", {}, title), ...children);

async function renderDetail() {
  // Locked out, the page asks the service for nothing: the item named in the address opens once it is let in.
  if (!state.open || locked) return;
  const asked = state.open;
  const session = sessions;
  let item;
  try {
    item = await api("get", { kind: asked.kind, id: asked.id, history: true });
  } catch (error) {
    // A refused key is for the page as a whole to deal with: it empties itself and asks for one.
    if (error.status === 401) return void load();
    if (session !== sessions || locked || !sameItem(asked, state.open)) return;
    state.shown = null;
    state.drawn = null;
    $("detail").replaceChildren(el("p", { class: "empty" }, error.message));
    $("panel").hidden = false;
    // The panel is a dialog also when all it has to say is that the item cannot be shown: the keyboard goes into
    // it, unless it is in it already, on the control that closes it for instance.
    if (!$("panel").contains(document.activeElement)) $("panel").querySelector(".panel-card").focus({ preventScroll: true });
    return;
  }
  // The answer to an earlier click must not replace what was opened since. Nor may an answer asked for before the
  // key was refused show an item afterwards.
  if (session !== sessions || locked || !sameItem(asked, state.open)) return;
  // The same item drawn again, after a refresh, keeps its place: how far it was scrolled and whether its history was unfolded.
  const again = sameItem(asked, state.shown) && !$("panel").hidden;
  // And when nothing the panel shows has changed, it is not drawn again at all: a change to some other task must
  // not take away what someone has selected in it, nor where they are in it with the keyboard.
  const drawing = JSON.stringify([item, state.trail.at(-1) ?? null, watched.has(item.id)]);
  if (again && drawing === state.drawn) return;
  state.drawn = drawing;
  const place = again ? placeInPanel() : null;
  const historyOpen = again && Boolean($("detail").querySelector(".fold-block")?.open);
  state.shown = asked;
  state.openTitle = item.title ?? item.username ?? "";
  document.title = [item.id, state.openTitle, state.instance?.name, "Vigile"].filter(Boolean).join(" · ");
  const links = Object.entries(item.links ?? {})
    .filter(([, items]) => items.length)
    .map(([relation, items]) =>
      el(
        "div",
        { class: "relation", "data-relation": relation },
        el("h4", { title: `Link type: ${relation}` }, RELATIONS[relation] ?? relation, el("span", { class: "count" }, String(items.length))),
        el(
          "ul",
          { class: "links" },
          items.map((other) =>
            el(
              "li",
              {},
              el(
                other.kind === "user" ? "div" : "button",
                { class: "link", type: other.kind === "user" ? undefined : "button", onclick: () => other.kind !== "user" && openItem(other.kind, other.id.replace(/^project:/, "")) },
                el("span", { class: "id" }, other.id),
                el("span", { class: `name${other.deleted ? " gone" : ""}` }, other.title),
                other.status && pill(other.status),
              ),
            ),
          ),
        ),
      ),
    );
  const facts = [
    item.kind === "task" && ["Type", item.type],
    item.kind === "task" && item.progress && ["Progress", `${item.progress.finished} of ${item.progress.total} tasks inside finished`],
    item.kind === "task" && ["Priority", String(item.priority)],
    item.kind === "task" && item.value !== null && ["Value", String(item.value)],
    item.kind === "task" && item.size !== null && ["Size", String(item.size)],
    item.kind === "task" && ["Assigned to", item.assigned_to.length ? item.assigned_to.join(", ") : "nobody"],
    item.kind === "project" && ["Progress", `${item.progress.finished} of ${item.progress.total} tasks finished`],
    item.completed_at && ["Completed", when(item.completed_at)],
    ["Created", `${when(item.created_at)} by ${item.created_by}`],
    ["Updated", when(item.updated_at)],
    item.deleted_at && ["Deleted", when(item.deleted_at)],
    ["Version", String(item.version)],
  ].filter(Boolean);
  const from = state.trail.at(-1);
  const tone = item.is_waiting ? "wait" : (STATUS_TONE[item.status] ?? "idle");

  $("detail").replaceChildren(
    el(
      "div",
      { class: "detail" },
      from &&
        el("button", { class: "back", type: "button", title: "Back to the item this was opened from", onclick: () => history.back() }, el("span", { "aria-hidden": "true" }, "←"), el("span", { class: "id" }, from.id), el("span", { class: "back-title" }, from.title ?? "")),
      el(
        "header",
        { class: "block detail-top", "data-tone": tone },
        el(
          "div",
          { class: "detail-head" },
          el("span", { class: "id" }, item.id),
          item.type && item.type !== "task" && el("span", { class: "type" }, item.type),
          item.status && pill(item.status),
          // A deleted item is not work any more, whatever status it was left in.
          item.deleted_at && el("span", { class: "pill stop" }, "deleted"),
          !item.deleted_at && item.is_next && el("span", { class: "pill go" }, "next"),
          !item.deleted_at && item.is_waiting && el("span", { class: "pill wait" }, "waiting"),
        ),
        el("h2", { class: "detail-title", id: "panel-title" }, item.title ?? item.username),
        item.problems?.length && el("ul", { class: "problems" }, item.problems.map((p) => el("li", {}, `⚠ ${p.message}`))),
        item.kind === "task" && !FINISHED.includes(item.status) && !item.deleted_at && el(
          "button",
          {
            class: "watch",
            type: "button",
            "aria-pressed": String(watched.has(item.id)),
            title: "This browser tab plays a sound when the task is done. Nothing about it is sent to the service.",
            // Asking to be told is the last thing to do here, so the panel closes; stopping a watch leaves it open.
            onclick: () => (watched.has(item.id) ? (unwatch(item.id), renderDetail()) : (watch(item.id), closeItem())),
          },
          watched.has(item.id) ? "Watching. Stop" : "Tell me when it is done",
        ),
        item.kind === "task" && item.progress && el(
          "button",
          { class: "open-group", type: "button", onclick: () => ((state.group = item.id), closeItem(), render()) },
          `Show only this group (${item.progress.total} ${item.progress.total === 1 ? "task" : "tasks"})`,
        ),
      ),
      item.description !== undefined && block("Description", el("p", { class: `description${item.description ? "" : " none"}` }, item.description || "No description.")),
      item.why && el("section", { class: "block why" }, el("h3", {}, "Why"), el("p", { class: "description" }, item.why)),
      links.length ? block("Links", links) : null,
      block("Details", el("dl", { class: "facts" }, facts.flatMap(([name, value]) => [el("dt", {}, name), el("dd", {}, value)]))),
      item.timeline?.length &&
        block(
          "Status timeline",
          el(
            "ol",
            { class: "timeline" },
            item.timeline.map((entry) => el("li", {}, pill(entry.status), el("time", { datetime: entry.at }, when(entry.at)), el("span", {}, `by ${entry.by}`))),
          ),
        ),
      item.history?.length &&
        el(
          "details",
          { class: "block fold-block", open: historyOpen },
          el("summary", {}, el("h3", {}, "History"), el("span", { class: "count" }, `${item.history.length} ${item.history.length === 1 ? "change" : "changes"}`)),
          el(
            "ol",
            { class: "history" },
            item.history.map((entry) =>
              el("li", {}, el("span", { class: "what" }, label(entry.action)), el("span", { class: "change" }, describeChange(entry.data)), el("time", { datetime: entry.at }, `${when(entry.at)} · ${entry.by}`)),
            ),
          ),
        ),
    ),
  );
  $("panel").hidden = false;
  const card = $("panel").querySelector(".panel-card");
  if (!again) card.scrollTop = 0;
  // The panel is a dialog: the keyboard goes into it when it opens and when it shows another item. Drawn again
  // for the same item, the control that had the keyboard has it back.
  if (!again) card.focus({ preventScroll: true });
  else if (place) (place() ?? card).focus({ preventScroll: true });
}

/** Which control of the panel has the keyboard, told so that it can be found again after the panel is drawn anew. */
function placeInPanel() {
  const at = document.activeElement;
  if (!at || !$("panel").contains(at) || at === $("panel").querySelector(".panel-card")) return null;
  if (at.id) return () => $(at.id);
  // A control is known again by what it is, not by what it says: the fold of the history counts its entries in
  // its label, a link shows the state of what it leads to, and both change while the control stays the same one.
  // A link is the one of its kind to its item: a task can both hold and wait for the same task.
  const name = (control) =>
    control.matches("summary") ? "summary" : control.matches(".link") ? `link ${control.closest(".relation")?.dataset.relation} ${control.querySelector(".id")?.textContent}` : control.className || control.textContent;
  const wanted = name(at);
  return () => [...$("detail").querySelectorAll("button, summary, a[href]")].find((control) => control.tagName === at.tagName && name(control) === wanted);
}

/** A history entry's data in a few words. */
function describeChange(data) {
  // A link has two ends and a type. A type alone is that of a task created as a bug, or of a user.
  if (data.from !== undefined && data.to !== undefined && data.type !== undefined) return `${data.from} ${data.type} ${data.to}`;
  if (data.from !== undefined && data.to !== undefined) return `${label(String(data.from))} → ${label(String(data.to))}${data.assigned_to ? `, assigned to ${data.assigned_to}` : ""}`;
  if (data.changes) {
    return Object.entries(data.changes)
      .map(([field, value]) => (Array.isArray(value) ? `${field}: ${value[0] ?? "none"} → ${value[1] ?? "none"}` : `${field} changed`))
      .join(", ");
  }
  if (data.status) return [`as ${label(data.status)}`, data.type && `type ${data.type}`, data.contained_in && `in ${data.contained_in.join(", ")}`].filter(Boolean).join(", ");
  if (data.username) return `${data.username}, ${data.type}`;
  return "";
}

/** Takes the panel off the screen. */
function hidePanel() {
  state.open = null;
  // The keyboard goes back to what the panel was opened from, when it was in the panel or lost with it.
  const inside = !$("panel").hidden && ($("panel").contains(document.activeElement) || document.activeElement === document.body);
  $("panel").hidden = true;
  state.drawn = null;
  if (inside) panelOpener?.()?.focus({ preventScroll: true });
  panelOpener = null;
  document.title = state.instance?.name ? `${state.instance.name} · Vigile` : "Vigile";
}

/** Closes the panel on the person's request, which also takes the item out of the address. */
function closeItem() {
  if (readRoute().open) go(state.view, null);
  else hidePanel();
}

/**
 * What the graph on screen is a graph of: the project, the group, the filter and the two switches above it. A
 * large graph is drawn again only when the person asks for something else, never because the plan changed.
 */
let graphScope = null;
/** Counts the drawings asked for, so that the answer to an earlier one is not shown over a later one. */
let graphTurns = 0;

async function renderGraphView(tasks) {
  const shown = state.hideFinished ? tasks.filter((t) => !FINISHED.includes(t.status)) : tasks;
  $("graph-note").hidden = shown.length > 0;
  $("graph-note").textContent = shown.length ? "" : "Every task here is finished. Untick “Hide finished tasks” to see them.";
  $("graph-box").hidden = shown.length === 0;
  const turn = ++graphTurns;
  if (!shown.length) return void showGraphStatus(null);
  // Only the projects in view are drawn: all of them, or the one that is selected.
  const projects = state.project ? state.projects.filter((p) => projectRef(p) === state.project) : state.projects;
  const scope = JSON.stringify([state.project, state.group, state.filter.trim().toLowerCase(), state.hideFinished, state.collapsed]);
  // A large graph is drawn when the person has said they want large ones and now asks for another. One that is
  // there stays as it is when the plan changes under it: with auto-refresh on, that could be every few seconds.
  const large = scope === graphScope ? "keep" : state.large ? "draw" : "clear";
  try {
    resizeGraph();
    const stands = await renderGraph($("graph-box"), { tasks: shown, projects, collapsed: state.collapsed }, { open: openItem, placed: graphPlaced, failed: graphFailed, large });
    if (!stands || turn !== graphTurns) return;
    graphScope = stands.waits ? null : scope;
    showGraphStatus(stands);
  } catch (error) {
    if (turn === graphTurns) graphFailed(error);
  }
}

/** How the graph stands, as the line over it says. */
let graphStands = null;

/** A count with its noun, written as the rest of the page is, in English: "1,204 items", "1 arrow". */
const counted = (count, one) => `${count.toLocaleString("en-US")} ${one}${count === 1 ? "" : "s"}`;

/**
 * Says, in a line over the graph's box, what cannot be seen from the graph itself: that it is large and waits to
 * be asked for, that it is being worked out, or that the plan has changed since it was drawn.
 */
function showGraphStatus(stands) {
  graphStands = stands;
  const sizes = stands?.size ? `${counted(stands.size.items, "item")} and ${counted(stands.size.arrows, "arrow")}` : "";
  const placing = stands?.placing ? `Working out where ${sizes} go. The rest of the page can be used meanwhile.` : "";
  const [text, button] = !stands
    ? ["", ""]
    : stands.waits
      ? [`This graph has ${sizes}. A graph of more than ${LARGE} items is drawn when you ask for it, because working out where everything goes takes a while.`, "Draw the graph"]
      : stands.outdated
        ? [[placing, sinceDrawn(stands.outdated, Boolean(placing))].filter(Boolean).join(" "), "Draw it again"]
        : [placing, ""];
  // Written only when it says something else: the line is read out by a screen reader whenever it is written.
  if ($("graph-status-text").textContent !== text) $("graph-status-text").textContent = text;
  if ($("graph-draw").textContent !== button) $("graph-draw").textContent = button;
  $("graph-draw").hidden = !button;
  $("graph-status").hidden = !text;
}

/**
 * Says what a drawing is that was kept while the plan moved on, so that nothing in it is taken for more than it
 * is: what was added is not in it, what is gone is greyed out, and the rest shows the present. A drawing that is
 * still being worked out was asked for, not drawn yet.
 */
function sinceDrawn({ added, gone }, underWay) {
  const some = ({ items, arrows }) => [items && counted(items, "item"), arrows && counted(arrows, "arrow")].filter(Boolean).join(" and ");
  const are = ({ items, arrows }) => (items + arrows === 1 ? "is" : "are");
  const changes = [
    added.items + added.arrows && `${some(added)} ${are(added)} new and not drawn`,
    gone.items + gone.arrows && `${some(gone)} ${are(gone)} no longer there and greyed out`,
  ].filter(Boolean);
  return `The plan has changed since this graph was ${underWay ? "asked for" : "drawn"}: ${changes.join("; ")}. Everything else in it shows the plan as it is now.`;
}

/** The layout of the drawing has arrived: the line that said it was being worked out goes. */
function graphPlaced() {
  if (graphStands?.placing) showGraphStatus({ ...graphStands, placing: false });
}

/** Says why there is no graph, in its place. The next drawing tries again. */
function graphFailed(error) {
  // What a drawing asked for earlier comes to say is of no use after this.
  graphTurns++;
  graphScope = null;
  showGraphStatus(null);
  // With nothing to draw, the note says so already, and there was no drawing to fail.
  if ($("graph-box").hidden) return;
  $("graph-box").hidden = true;
  $("graph-note").hidden = false;
  $("graph-note").textContent = `The graph could not be drawn: ${error.message}`;
}

// Asked for once, large graphs are drawn from then on, until the page is loaded again.
$("graph-draw").addEventListener("click", () => {
  state.large = true;
  graphScope = null;
  // The button goes while the graph is worked out. The keyboard stays on the line, which says what happens next.
  $("graph-status").focus({ preventScroll: true });
  render();
});

/**
 * Which control has the keyboard, told in a way that outlives the drawing: a card by its task, a project by its
 * ID, a column's "show all" by its column. Drawing the board again replaces these, and whoever was on one with
 * the keyboard must still be on it afterwards.
 */
function keyboardPlace() {
  const at = document.activeElement;
  if (!at?.closest) return null;
  if (at.matches("#board .card")) {
    const id = at.dataset.id;
    return () => [...$("board").querySelectorAll(".card")].find((card) => card.dataset.id === id);
  }
  if (at.matches("#board .more")) {
    const key = at.closest(".column").dataset.key;
    return () => [...$("board").querySelectorAll(".column")].find((column) => column.dataset.key === key)?.querySelector(".more");
  }
  const project = at.closest("#projects .project, #projects .project-chip");
  if (project) {
    const id = project.querySelector(".project-id")?.textContent;
    const part = at.matches(".tag-button") ? ".tag-button" : at.matches(".project-main") ? ".project-main" : null;
    return () => {
      const again = [...$("projects").querySelectorAll(".project, .project-chip")].find((item) => item.querySelector(".project-id")?.textContent === id);
      return part ? again?.querySelector(part) : again;
    };
  }
  // Any other control outside the panel, such as those of the header, is not drawn again: it is that very one,
  // for as long as it is on the page.
  if (at !== document.body && !$("panel").contains(at)) return () => (at.isConnected ? at : null);
  return null;
}

function render() {
  const place = keyboardPlace();
  draw();
  // Put back without scrolling: the reader keeps their place on the page as well.
  const again = place?.();
  if (again && document.activeElement !== again) again.focus({ preventScroll: true });
}

/**
 * The timer that runs while the person types in the filter with the graph in view. The board follows the filter
 * letter by letter; the graph waits for the typing to pause, since each drawing of it is a layout, and one for
 * every letter of a word is work for nothing.
 */
let typing = null;
const TYPING_PAUSE_MS = 300;

function draw() {
  renderProjects();
  const tasks = state.tasks.filter(matches);
  renderSummary(tasks);
  $("empty").hidden = tasks.length > 0;
  $("empty").textContent = state.tasks.length === 0 ? "No tasks yet." : state.filter.trim() ? `No task matches "${state.filter.trim()}".` : "No tasks in this project.";
  const graph = state.view === "graph";
  // Full screen hides the header and the views. With no graph on screen, which is where its way out is, it ends.
  if (state.full && (!graph || tasks.length === 0)) stopFullScreen();
  document.body.classList.toggle("graph-view", graph);
  document.body.classList.toggle("graph-full", graph && state.full);
  document.body.classList.toggle("focus", state.focus);
  document.body.classList.toggle("scoped", Boolean(state.project || state.group || state.filter.trim()));
  $("focus").setAttribute("aria-pressed", String(state.focus));
  $("focus").setAttribute("aria-label", state.focus ? "Show everything above the board again" : "Hide everything above the board");
  $("graph-full").setAttribute("aria-pressed", String(state.full));
  $("graph-full").textContent = state.full ? "Leave full screen" : "Full screen";
  $("board").hidden = graph;
  showLights();
  $("bugs-apart").checked = state.bugsApart;
  $("column-scroll").checked = state.columnScroll;
  $("graph-panel").hidden = !graph || tasks.length === 0;
  for (const view of ["board", "graph"]) {
    if (state.view === view) $(`view-${view}`).setAttribute("aria-current", "page");
    else $(`view-${view}`).removeAttribute("aria-current");
  }
  if (!graph) renderBoard(tasks);
  else if (typing === null) renderGraphView(tasks);
  fitBoard();
}


function showKeyForm(message) {
  // Leave a form that already says this alone, so a refresh never wipes a key that is being typed.
  if ($("notice").dataset.message === message && !$("notice").hidden) return;
  $("notice").dataset.message = message;
  const input = el("input", { type: "password", placeholder: "API key", autocomplete: "off", "aria-label": "API key" });
  // A key that was given and neither accepted nor refused, because no answer came, is kept for the next try.
  input.value = localStorage.getItem(KEY_NAME) ?? "";
  $("notice").replaceChildren(
    el("span", {}, message),
    el(
      "form",
      // An empty field is no key to put in the place of one: it tries what is stored, which another tab may have
      // been given meanwhile, or no key at all.
      { onsubmit: (event) => (event.preventDefault(), input.value.trim() && localStorage.setItem(KEY_NAME, input.value.trim()), load(true)) },
      input,
      el("button", { type: "submit" }, "Connect"),
    ),
  );
  $("notice").hidden = false;
}

/** Asks again and again while the service cannot be reached, until it answers. */
let again = null;
/** Whether the service refused the page's key, or its lack of one. Nothing is read until a load succeeds again. */
let locked = false;
/** Goes up each time the page is locked out. An answer asked for before that is not shown after it. */
let sessions = 0;

/**
 * The service no longer lets the page in. Nothing it showed may stay: not on screen, not hidden in the page, and
 * not on its way to the screen. The page stops reading and listening until a key is given and a load succeeds.
 */
function lockOut(refused = "") {
  locked = true;
  sessions++;
  // The key that was refused is forgotten. Another one, given in another tab while the answer was on its way,
  // was not refused and stays.
  if (refused) localStorage.removeItemIf(KEY_NAME, refused);
  // Nothing is loaded any more, and the header must go on saying that the page is not connected.
  Object.assign(state, { projects: [], tasks: [], byId: new Map(), snapshot: "", shown: null, loadedAt: null, loadedMs: null, failed: true });
  $("main").hidden = true;
  $("you").textContent = "";
  $("panel").hidden = true;
  // A load that was waiting its turn was asked for before this: it is not to run now.
  wanted = false;
  wantedByPerson = false;
  // Hidden is not gone: the board, the graph and the panel are emptied of what the earlier key had loaded,
  // whichever of the two views is showing.
  $("detail").replaceChildren();
  $("board").replaceChildren();
  clearGraph();
  graphScope = null;
  showGraphStatus(null);
  render();
  showRefresh();
  // Cards on their way across the page are copies of tasks, attached to the page itself.
  for (const copy of document.querySelectorAll(".card-ghost")) {
    for (const animation of copy.getAnimations()) animation.cancel();
    copy.remove();
  }
  flights.clear();
  marked.clear();
  // The notices and the list of watched tasks name tasks too, and sit outside what was just hidden.
  notices.length = 0;
  showNotices();
  showWatched();
  document.title = "Vigile";
  // What was heard so far is forgotten: when the page is let in again, nothing that happened meanwhile is announced.
  heard = null;
  chimed.clear();
  // Asking again is of no use until a key has been given, and neither is listening.
  clearInterval(again);
  again = null;
  clearTimeout(quietRetry);
  quietRetry = null;
  keepUp();
}

async function refresh() {
  try {
    const turn = ++readings;
    const [instance, projects, tasks] = await Promise.all([api("instance"), all("list-projects", "projects"), all("list-tasks", "tasks")]);
    // Redraw only when something changed, so a refresh never swaps a card out from under a click.
    const snapshot = JSON.stringify([projects, tasks]);
    const changed = snapshot !== state.snapshot;
    Object.assign(state, { instance, projects, tasks, snapshot, byId: new Map(tasks.map((t) => [t.id, t])), failed: false });
    if (state.project && !projects.some((p) => projectRef(p) === state.project)) state.project = null;
    if (state.group && !state.byId.has(state.group)) state.group = null;
    $("instance").textContent = instance.name ?? "";
    if (!state.open) document.title = instance.name ? `${instance.name} · Vigile` : "Vigile";
    $("you").textContent = `${instance.you.username}${instance.you.keyless ? " (no key)" : ""}`;
    state.failed = false;
    const unlocked = locked;
    locked = false;
    if (unlocked) {
      keepUp();
      showRefresh();
    }
    clearInterval(again);
    again = null;
    state.loadedMs = Date.now();
    $("notice").hidden = true;
    delete $("notice").dataset.message;
    $("main").hidden = false;
    const first = !state.loadedAt;
    state.loadedAt = new Date().toLocaleTimeString();
    showWatched();
    showAge();
    // A change that arrives while the board is in sight is shown as movement, so the eye can follow it.
    const before = changed && !first && state.view === "board" ? cardPlaces() : null;
    if (changed) render();
    else fitBoard();
    if (before) showMoves(before);
    announce(tasks, (id) => state.byId.get(id) ?? null, turn);
    // An item named in the address opens once there is data; an open one follows the changes.
    if (state.open && (changed || first || $("panel").hidden)) await renderDetail();
  } catch (error) {
    $("sync").textContent = "Not connected";
    $("sync").classList.remove("old");
    $("sync").classList.add("stale");
    if (error.status === 401) {
      // Whether another key is stored by now than the one that was refused: asked before the refused one is
      // forgotten, since afterwards "no key" would look like another one. No key at all is not another key:
      // it is what is left when another tab had the same key refused and forgot it, and trying without a key
      // would let the page in as whoever needs none, where it was to stay locked.
      const stored = localStorage.getItem(KEY_NAME) ?? "";
      const another = stored !== "" && stored !== (error.key ?? "");
      lockOut(error.key);
      showKeyForm(error.message);
      // A key that another tab stored meanwhile has not been tried yet: the person gave it, so it is tried now.
      if (another) load(true);
    } else {
      const since = state.loadedAt ? ` Showing what was loaded at ${state.loadedAt}.` : "";
      const what = error.status ? `The service answered with an error: ${error.message}` : "Cannot reach the service.";
      $("main").hidden = !state.loadedAt;
      if (locked) {
        // The page is locked out and the person's attempt to get in got no answer. The form stays, with the key
        // that was tried, so that they can try again; the page itself does not, since only they may let it in.
        showKeyForm(`${what} Press Connect to try again.`);
      } else {
        $("notice").textContent = `${what} Trying again every few seconds.${since}`;
        delete $("notice").dataset.message;
        $("notice").hidden = false;
        // A page that was asked for the plan and could not get it keeps asking by itself until it does, also with
        // auto-refresh off: the person asked, and should not have to ask again when the service is back.
        again ??= setInterval(follow, REFRESH_MS);
      }
    }
    state.failed = true;
    fitBoard();
  }
}

$("filter").addEventListener("input", (event) => {
  state.filter = event.target.value;
  clearTimeout(typing);
  typing = state.view === "graph" ? setTimeout(() => ((typing = null), render()), TYPING_PAUSE_MS) : null;
  render();
});
$("bugs-apart").addEventListener("change", (event) => {
  state.bugsApart = event.target.checked;
  localStorage.setItem(BUGS_NAME, state.bugsApart ? "on" : "off");
  render();
});
$("column-scroll").addEventListener("change", (event) => {
  state.columnScroll = event.target.checked;
  localStorage.setItem(SCROLL_NAME, state.columnScroll ? "columns" : "page");
  render();
});
narrow.addEventListener("change", () => render());
$("projects-fold").addEventListener("click", () => {
  state.projectsFolded = !state.projectsFolded;
  localStorage.setItem(PROJECTS_NAME, state.projectsFolded ? "folded" : "open");
  render();
});
// The legend's colours come from the same list the graph is drawn from.
$("legend").prepend(...STATES.map((s) => el("li", { "data-state": s.state }, el("i", { class: "swatch", style: `border-color: var(--${s.border}); background: var(--${s.fill});${s.dashed ? " border-style: dashed;" : ""}` }), s.label)));
$("hide-finished").addEventListener("change", (event) => ((state.hideFinished = event.target.checked), render()));
$("collapse-groups").addEventListener("change", (event) => ((state.collapsed = event.target.checked), render()));
$("zoom-out").addEventListener("click", () => zoomGraph("out"));
$("zoom-in").addEventListener("click", () => zoomGraph("in"));
$("zoom-fit").addEventListener("click", () => zoomGraph("fit"));

/** Puts the page in a theme. The graph is drawn from the page's colours, so it is coloured again. */
function setTheme(name) {
  const theme = THEMES.includes(name) ? name : "vigile";
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_NAME, theme);
  for (const button of $("themes").querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.themeChoice === theme));
  if (state.loadedAt) render();
}
$("themes").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button) setTheme(button.dataset.themeChoice);
});
setTheme(localStorage.getItem(THEME_NAME) ?? "vigile");

/** The moving background: off unless the person turns it on, and shown behind the board only. */
const backdrop = lights($("lights"), () => document.documentElement.dataset.scheme);
window.vigileLights = backdrop;
function showLights() {
  const on = state.lights && state.view === "board";
  $("lights").hidden = !on;
  document.body.classList.toggle("lit", on);
  if (on) backdrop.start();
  else backdrop.stop();
}
$("lights-on").checked = state.lights;
$("lights-on").addEventListener("change", (event) => {
  state.lights = event.target.checked;
  localStorage.setItem(LIGHTS_NAME, state.lights ? "on" : "off");
  showLights();
});

/** Opens or closes the menu that holds the page's settings. */
function showSettings(open) {
  $("settings-menu").hidden = !open;
  $("settings").setAttribute("aria-expanded", String(open));
  fitSettings();
}
/** The menu is as tall as the window leaves room for under its button, and scrolls when its rows need more. */
function fitSettings() {
  if ($("settings-menu").hidden) return;
  const top = $("settings").getBoundingClientRect().bottom + 10;
  $("settings-menu").style.maxHeight = `${Math.max(120, window.innerHeight - top - 8)}px`;
}
window.addEventListener("resize", fitSettings);
$("settings").addEventListener("click", () => showSettings($("settings-menu").hidden));
// A click anywhere else closes it, and so does moving on with the keyboard.
document.addEventListener("click", (event) => {
  if (!$("settings-menu").hidden && !event.target.closest(".settings")) showSettings(false);
});
$("settings").parentElement.addEventListener("focusout", (event) => {
  if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) showSettings(false);
});

$("focus").addEventListener("click", () => {
  state.focus = !state.focus;
  localStorage.setItem(FOCUS_NAME, state.focus ? "on" : "off");
  render();
});

/**
 * Full screen for the graph: the header and everything above the graph go away, and the browser is asked to
 * hide its own bars too. Where the browser refuses, the graph still takes the whole window.
 */
function enterFullScreen() {
  state.full = true;
  render();
  document.documentElement.requestFullscreen?.().catch(() => {});
}
function stopFullScreen() {
  state.full = false;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
function leaveFullScreen() {
  if (!state.full) return;
  stopFullScreen();
  render();
}
$("graph-full").addEventListener("click", () => (state.full ? leaveFullScreen() : enterFullScreen()));
// Escape, or the browser's own way out of full screen, brings the page back.
document.addEventListener("fullscreenchange", () => !document.fullscreenElement && leaveFullScreen());
// The graph takes its colours from the page, so it is drawn again when the system switches between light and dark.
/**
 * Light or dark. The page is as the system says, unless the person switched that off and chose one themselves.
 * The answer is the page's data-scheme attribute, which the colours, the graph and the background all go by.
 */
const systemDark = matchMedia("(prefers-color-scheme: dark)");
function showScheme() {
  const chosen = localStorage.getItem(SCHEME_NAME);
  const own = chosen === "light" || chosen === "dark";
  const scheme = own ? chosen : systemDark.matches ? "dark" : "light";
  const changed = document.documentElement.dataset.scheme !== scheme;
  document.documentElement.dataset.scheme = scheme;
  $("scheme-system").checked = !own;
  $("scheme-dark").checked = scheme === "dark";
  $("scheme-dark-choice").hidden = !own;
  // The graph is drawn from the page's colours, so it is coloured again.
  if (changed && state.loadedAt) render();
}
showScheme();
systemDark.addEventListener("change", showScheme);
$("scheme-system").addEventListener("change", (event) => {
  // Switched off, the page stays as it is at that moment, and from then on it is the person's to choose.
  if (event.target.checked) localStorage.removeItem(SCHEME_NAME);
  else localStorage.setItem(SCHEME_NAME, document.documentElement.dataset.scheme);
  showScheme();
});
$("scheme-dark").addEventListener("change", (event) => {
  localStorage.setItem(SCHEME_NAME, event.target.checked ? "dark" : "light");
  showScheme();
});
// When the window changes size the graph is placed in its box afresh, once the dragging has paused.
let resized = null;
window.addEventListener("resize", () => {
  clearTimeout(resized);
  resized = setTimeout(() => state.view === "graph" && !$("graph-panel").hidden && resizeGraph(), 150);
  // The Done column takes spare width, so the board is laid out again when the spare width changes.
  if (state.view === "board" && state.spanFor && doneSpan(...state.spanFor) !== state.span) render();
  else fitBoard();
});
// A key given in another tab of this browser lets this one in too: the person has answered the question once.
window.addEventListener("storage", (event) => {
  // Another tab was given a key. News of it can arrive late: by then that tab may have had the key refused and
  // forgotten it. Only a key that is still stored is tried; with none stored, trying would let the page in as
  // whoever needs no key, where it was to stay locked.
  if (event.key === KEY_NAME && event.newValue && locked && localStorage.getItem(KEY_NAME) === event.newValue) load(true);
  // The key this page is in with was taken away in another tab, which happens when it was refused there. With
  // none stored, the next request would go without a key and be answered as whoever needs none, with no word
  // about the key: the page locks instead, as the other tab did, and asks for one.
  if (event.key === KEY_NAME && !event.newValue && !locked && keyInUse && event.oldValue === keyInUse && !localStorage.getItem(KEY_NAME)) {
    lockOut(keyInUse);
    showKeyForm("The API key is not valid.");
  }
});

// Back, Forward, a link to a view and an address typed by hand all end up here.
window.addEventListener("popstate", applyRoute);
window.addEventListener("hashchange", applyRoute);
$("close").addEventListener("click", closeItem);
$("panel").addEventListener("click", (event) => event.target === $("panel") && closeItem());
// The panel is a dialog over the page: Tab goes round inside it and does not wander off into the board behind.
$("panel").addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  const card = $("panel").querySelector(".panel-card");
  const controls = [...card.querySelectorAll("button, summary, a[href], input")].filter((control) => !control.disabled && control.getClientRects().length);
  if (!controls.length) return void event.preventDefault();
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && (document.activeElement === first || document.activeElement === card)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("settings-menu").hidden) {
    showSettings(false);
    $("settings").focus();
  } else if (!$("panel").hidden) closeItem();
  else if (state.full) leaveFullScreen();
});

/** Where every card is on screen and which column it is in, taken before the board is drawn again. */
function cardPlaces() {
  return new Map(
    [...$("board").querySelectorAll(".card")].map((card) => {
      const box = card.getBoundingClientRect();
      // A card may be scrolled out of sight inside its column. Then it sets off from the nearest edge of the column.
      const room = card.closest(".cards").getBoundingClientRect();
      const inSight = box.bottom > room.top && box.top < room.bottom;
      const from = { left: box.left, top: inSight ? box.top : box.top < room.top ? room.top : room.bottom - box.height, width: box.width, height: box.height };
      return [card.dataset.id, { box, from, inSight, column: card.closest(".column").dataset.key, status: card.dataset.status, node: card }];
    }),
  );
}

/** How long a card that changed stays ringed. */
const MARKED_MS = 6000;
/** How long a card takes to lift off where it was before it sets off, so that the eye has time to find it. */
const LIFT_MS = 150;
/** How long it takes to settle where it lands. */
const LAND_MS = 300;
/** How fast a card travels, in pixels a millisecond: one steady pace, so a longer way takes longer, within limits. */
const PACE = 1.6;
const LEAST_MS = 400;
const MOST_MS = 1200;
/** Whether cards move: they do, unless the person switches it off in the settings. Then the ring alone says what changed. */
const moving = () => state.motion !== "off";
$("motion").checked = moving();
$("motion").addEventListener("change", (event) => {
  state.motion = event.target.checked ? "on" : "off";
  localStorage.setItem(MOTION_NAME, state.motion);
});

/** Sends a copy of a card from where it was to where it is now. Returns the journey, which ends when the copy has landed. */
function fly(copy, dx, dy, lands) {
  const way = Math.round(Math.min(MOST_MS, Math.max(LEAST_MS, Math.hypot(dx, dy) / PACE)));
  const total = LIFT_MS + way + LAND_MS;
  return copy.animate(
    [
      { transform: "none", offset: 0, easing: "ease-out" },
      // The same at both ends, so that half the time is half the way: it neither darts off nor rushes in.
      { transform: "scale(1.06)", offset: LIFT_MS / total, easing: "cubic-bezier(0.3, 0, 0.7, 1)" },
      { transform: `translate(${dx}px, ${dy}px) scale(1.06)`, offset: (LIFT_MS + way) / total, easing: "ease-in", opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px)`, offset: 1, opacity: lands ? 1 : 0 },
    ],
    // It stays where it landed until it is taken away, so it is never seen back where it started.
    { duration: total, fill: "forwards" },
  );
}
/** Cards that a refresh changed lately, and when. They stay ringed for a few seconds, also when the board is drawn again. */
const marked = new Map();
/** Cards on their way to another column, each with the copy that travels. The card itself waits, unseen, where it will land. */
const flights = new Map();

/** Rings the cards that changed lately and keeps the ones in flight unseen. Called whenever the board has been drawn. */
function keepMarks() {
  const now = performance.now();
  for (const [id, at] of marked) if (now - at >= MARKED_MS) marked.delete(id);
  for (const card of $("board").querySelectorAll(".card")) {
    const at = marked.get(card.dataset.id);
    card.classList.toggle("changed", at !== undefined);
    // Drawn again, the ring goes on fading from where it was instead of starting over.
    card.style.animationDelay = at === undefined ? "" : `${-Math.round(now - at)}ms`;
    card.style.visibility = flights.has(card.dataset.id) ? "hidden" : "";
  }
}

function mark(id) {
  marked.set(id, performance.now());
  setTimeout(keepMarks, MARKED_MS + 50);
}

/**
 * Shows what a refresh changed, so that the eye can follow it. A card that went to another column lifts off
 * where it was, travels there at a steady pace and lands; one that moved within its column slides; a new one
 * fades in and a removed one fades out. Each card that changed stays ringed for a few seconds. With animations
 * switched off in the settings nothing moves, and the ring alone says what changed.
 */
function showMoves(before) {
  if ($("board").hidden) return;
  const still = !moving();
  const MOST = 12;
  let travellers = 0;
  /** A copy of a card that floats above the page, for movement that would be cut off inside a scrolling column. */
  const ghost = (source, box) => {
    const copy = source.cloneNode(true);
    copy.classList.add("card-ghost");
    copy.classList.remove("changed");
    copy.removeAttribute("data-id");
    // A copy is for the eye only. It is a button that does nothing: the keyboard and screen readers pass it by.
    copy.inert = true;
    copy.tabIndex = -1;
    copy.setAttribute("aria-hidden", "true");
    Object.assign(copy.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, visibility: "", animationDelay: "" });
    document.body.append(copy);
    return copy;
  };
  const after = new Set();
  for (const card of $("board").querySelectorAll(".card")) {
    const id = card.dataset.id;
    after.add(id);
    const was = before.get(id);
    const now = card.getBoundingClientRect();
    if (!was) {
      mark(id);
      if (!still) card.animate([{ opacity: 0, transform: "scale(0.9)" }, { opacity: 1, transform: "none" }], { duration: 340, easing: "ease-out" });
    } else if (was.column !== card.closest(".column").dataset.key) {
      mark(id);
      // A card that is already on its way turns towards its new place from where it is now: the copy that was
      // heading for the old place is taken away, and a new one sets off from that spot.
      const flying = flights.get(id);
      let from = was.from;
      if (flying) {
        const at = flying.getBoundingClientRect();
        const width = parseFloat(flying.style.width);
        const height = parseFloat(flying.style.height);
        from = { left: at.left + (at.width - width) / 2, top: at.top + (at.height - height) / 2, width, height };
        flights.delete(id);
        for (const animation of flying.getAnimations()) animation.cancel();
        flying.remove();
      }
      // The card that has the keyboard stays where the keyboard can reach it: hidden for a flight it would lose
      // it, so it is ringed in its new place and does not travel.
      if (still || document.activeElement === card || travellers++ >= MOST) continue;
      // Where it lands: its new place, or the nearest edge of its column when that place is scrolled out of sight.
      const room = card.closest(".cards").getBoundingClientRect();
      const inSight = now.bottom > room.top && now.top < room.bottom;
      const dx = now.left - from.left;
      const dy = (inSight ? now.top : now.top < room.top ? room.top : room.bottom - from.height) - from.top;
      const copy = ghost(card, from);
      flights.set(id, copy);
      const travel = fly(copy, dx, dy, inSight);
      travel.finished.catch(() => {}).then(() => {
        copy.remove();
        // Only the copy that is still this card's own ends its flight; one that was replaced on the way does not.
        if (flights.get(id) === copy) flights.delete(id);
        keepMarks();
      });
    } else {
      // A card may change state and stay in its column, as a bug does in the column for bugs: it is ringed too.
      if (was.status !== card.dataset.status) mark(id);
      if (still || Math.abs(was.box.left - now.left) >= 1 || Math.abs(was.box.top - now.top) < 1) continue;
      card.animate([{ transform: `translateY(${was.box.top - now.top}px)` }, { transform: "none" }], { duration: 260, easing: "ease-in-out" });
    }
  }
  let leavers = 0;
  for (const [id, was] of before) {
    if (after.has(id)) continue;
    // A card that is gone has no place to land any more: a copy of it that was on its way is taken away.
    const flying = flights.get(id);
    if (flying) {
      flights.delete(id);
      for (const animation of flying.getAnimations()) animation.cancel();
      flying.remove();
      continue;
    }
    // A card that left while it was scrolled out of sight has nothing to show for it.
    if (still || !was.inSight || leavers++ >= MOST) continue;
    const copy = ghost(was.node, was.box);
    copy.animate([{ opacity: 1 }, { opacity: 0, transform: "scale(0.9)" }], { duration: 300, easing: "ease-in" }).finished.catch(() => {}).then(() => copy.remove());
  }
  keepMarks();
}

/** Whether the page keeps itself up to date: the person's choice, off unless turned on. */
let auto = false;
/** The timer that asks for the plan again every few seconds, while changes cannot be listened for. */
let polling = null;
/** How long the stream of changes may stay silent before it is taken for stalled: more than twice the service's heartbeat. */
const STREAM_SILENCE_MS = 45000;
/** The open stream of changes, when there is one. */
let stream = null;
let retry = null;
let seenRevision = null;
let wanted = false;
/** Whether the load that is wanted next was asked for by the person, with the key form. */
let wantedByPerson = false;
let busy = false;

/**
 * Says how old the data on screen is. With self-refresh off the page does not change by itself,
 * so after a minute the label turns into a reminder that what is shown may be out of date.
 */
function showAge() {
  if (!state.loadedMs || state.failed || locked) return;
  const minutes = Math.floor((Date.now() - state.loadedMs) / 60000);
  const old = minutes >= 1 && !auto;
  const live = auto && (Boolean(stream?.connected) || following);
  // Written only when it says something else: the status is read out by a screen reader whenever it is written,
  // and this runs every second.
  const say = (text) => $("sync").textContent !== text && ($("sync").textContent = text);
  if (old) say(`Loaded ${minutes} min ago, may be out of date`);
  else if (live) showLiveAge();
  else say(`Updated ${state.loadedAt}`);
  const title = live ? `Changes are shown as they happen. Last update at ${state.loadedAt}.` : "";
  if ($("sync").title !== title) $("sync").title = title;
  $("sync").classList.toggle("stale", false);
  $("sync").classList.toggle("old", old);
  $("sync").classList.toggle("live", live && !old);
  $("refresh").classList.toggle("nudge", old);
}
// Once a second, since a live page counts the seconds since its last update.
setInterval(showAge, 1000);

/** How long ago, in the unit that fits: "12 secs", "1 min", "3 hrs". */
function ago(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const [count, unit] = seconds < 60 ? [seconds, "sec"] : seconds < 3600 ? [Math.floor(seconds / 60), "min"] : [Math.floor(seconds / 3600), "hr"];
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/**
 * "Live, updated 12 secs ago", with the count going up by itself. The header's status is read out by a screen
 * reader whenever it changes, and a count that changes every second must not be: the count is kept out of what
 * is read out, and only it is rewritten as time passes.
 */
function showLiveAge() {
  const lead = "Live, updated ";
  let count = $("sync").querySelector(".age");
  if (!count || $("sync").firstChild?.nodeValue !== lead) {
    count = el("span", { class: "age", "aria-hidden": "true" });
    $("sync").replaceChildren(lead, count);
  }
  const text = ago(Date.now() - state.loadedMs);
  if (count.textContent !== text) count.textContent = text;
}

/**
 * Loads the plan. Every load goes through here, whoever asks for it: the page as it opens, the refresh button,
 * the key form, a switch, a change in the service. One runs at a time, and a request that arrives meanwhile
 * leads to one more afterwards, so the answer to an earlier question is never drawn over a later one.
 */
async function load(byPerson = false) {
  // Locked out, the page reads the plan again only when the person asks for it by giving a key. Nothing that was
  // asked for before, or that the page would do by itself, lets it back in.
  if (locked && !byPerson) return;
  if (busy) {
    wanted = true;
    wantedByPerson ||= byPerson;
    return;
  }
  busy = true;
  try {
    let more;
    do {
      wanted = false;
      wantedByPerson = false;
      await refresh();
      more = wanted && (!locked || wantedByPerson);
    } while (more);
  } finally {
    busy = false;
    wanted = false;
    wantedByPerson = false;
  }
}

/** Loads the plan again because something changed, while the page is in sight. Out of sight it waits to be seen again. */
function follow() {
  if (!document.hidden) load();
}

/**
 * Listens to the service's stream of changes. The stream says only that the plan changed; the page then loads
 * it as usual. While the stream cannot be had, the page asks every few seconds instead, and tries the stream
 * again now and then.
 */
function listen() {
  stopListening();
  if (!tabs) return connect();
  // Another tab may be listening already. It answers at once if it is; if none does, this one connects.
  tabs.postMessage({ type: "who", from: me });
  asking = setTimeout(() => {
    asking = null;
    if (!following) connect();
  }, 150 + Math.random() * 150);
}

function connect() {
  const mine = (stream = { abort: new AbortController(), connected: false });
  const lost = () => {
    if (stream !== mine) return;
    if (mine.connected) tabs?.postMessage({ type: "lost", from: me });
    mine.connected = false;
    showAge();
    polling ??= setInterval(planChanged, REFRESH_MS);
    retry = setTimeout(listen, 15000);
  };
  // The service sends a few bytes at least every 20 seconds. A stream that stays silent for longer than that has
  // stalled without saying so: it is given up, which starts the asking and the reconnecting below.
  let silence = null;
  const heardFrom = () => {
    clearTimeout(silence);
    silence = setTimeout(() => mine.abort.abort(), STREAM_SILENCE_MS);
  };
  (async () => {
    const key = localStorage.getItem(KEY_NAME);
    heardFrom();
    const response = await fetch("/api/events", { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: mine.abort.signal });
    if (!response.ok || !response.body) throw new Error("no stream");
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      heardFrom();
      text += value;
      for (let cut = text.indexOf("\n\n"); cut >= 0; cut = text.indexOf("\n\n")) {
        const block = text.slice(0, cut);
        text = text.slice(cut + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const revision = JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? "null")?.revision;
        if (stream !== mine || !event) continue;
        if (event === "hello") {
          // Connected: asking every few seconds is no longer needed.
          mine.connected = true;
          clearInterval(polling);
          polling = null;
          showAge();
        }
        // The other tabs of this browser hear of it from this one.
        tabs?.postMessage({ type: event === "hello" ? "here" : "change", from: me, revision });
        // The revision goes up with every change. One that differs from the last one seen, also after the stream
        // was lost and found again, means the plan on screen is out of date. The first one counts too: something
        // may have changed between the last reading and the moment the stream was connected.
        if (revision !== seenRevision) planChanged();
        seenRevision = revision;
      }
    }
    throw new Error("stream ended");
  })()
    .catch(lost)
    .finally(() => clearTimeout(silence));
}

function stopListening() {
  clearTimeout(retry);
  retry = null;
  clearTimeout(asking);
  asking = null;
  // The tabs that heard of changes from this one are told, so that one of them listens instead.
  if (stream?.connected) tabs?.postMessage({ type: "bye", from: me });
  stream?.abort.abort();
  stream = null;
}

/**
 * One stream for all the tabs of a browser. A browser allows a site only a handful of connections at a time, and
 * a stream holds one for as long as it lasts: with a stream in every tab, half a dozen tabs would leave none
 * for reading the plan. So one tab listens to the service and tells the others, which hold no connection.
 * When that tab closes, stops listening or loses the service, another one takes over.
 */
const tabs = "BroadcastChannel" in window ? new BroadcastChannel("vigile-changes") : null;
const me = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
/** Whether another tab tells this one of changes, when that tab was last heard, and the timer that asks after it. */
let following = false;
let heardTab = 0;
let tabCheck = null;
/** The short wait for a tab that already listens to say so. */
let asking = null;
const TAB_CHECK_MS = 5000;
const TAB_GONE_MS = 12000;

/** Stops hearing of changes from another tab. */
function leaveTab() {
  following = false;
  clearInterval(tabCheck);
  tabCheck = null;
}

/** Another tab is gone or cut off: this one asks for the plan itself until a stream is found again. */
function standAlone() {
  leaveTab();
  polling ??= setInterval(planChanged, REFRESH_MS);
  listen();
}

tabs?.addEventListener("message", ({ data }) => {
  if (!data || data.from === me) return;
  if (data.type === "who") {
    if (stream?.connected) tabs.postMessage({ type: "here", from: me, revision: seenRevision });
    return;
  }
  if (data.type === "bye" || data.type === "lost") {
    if (following) standAlone();
    return;
  }
  // "here" or "change": another tab is listening to the service.
  if (locked || !(auto || anySound() || watched.size > 0)) return;
  if (stream?.connected && me < data.from) {
    // Two tabs listen, which happens when they open together. This one keeps its stream and says so; the other gives its up.
    if (data.type === "here") tabs.postMessage({ type: "here", from: me, revision: seenRevision });
    return;
  }
  // This tab hears of changes from that one, and holds no connection of its own.
  clearTimeout(retry);
  retry = null;
  clearTimeout(asking);
  asking = null;
  stream?.abort.abort();
  stream = null;
  clearInterval(polling);
  polling = null;
  following = true;
  heardTab = Date.now();
  // The other tab may close without a word: it is asked now and then whether it is still there.
  tabCheck ??= setInterval(() => (Date.now() - heardTab > TAB_GONE_MS ? standAlone() : tabs.postMessage({ type: "who", from: me })), TAB_CHECK_MS);
  showAge();
  if (data.revision !== seenRevision) {
    seenRevision = data.revision;
    planChanged();
  }
});
// A tab that is closed says so, when it was the one listening.
window.addEventListener("pagehide", () => stream?.connected && tabs?.postMessage({ type: "bye", from: me }));

/**
 * What to do when the plan may have changed. With auto-refresh on and the page in sight, it is loaded and drawn
 * again. Otherwise the board is left as it is: the tasks are read for the sound alone when it is on, and else
 * only the watched tasks are looked at.
 */
function planChanged() {
  // A page whose key was refused has nothing to read until a key is given.
  if (locked) return;
  if (auto && !document.hidden) follow();
  else if (anySound()) hearChanges();
  else if (watched.size) lookAtWatched();
}

/**
 * A reading made for the sounds or the watched tasks that failed is tried again in a few seconds. While the
 * stream of changes is connected nothing else would: no change may come to prompt another reading.
 */
let quietRetry = null;
function retryQuietly() {
  quietRetry ??= setTimeout(() => {
    quietRetry = null;
    planChanged();
  }, REFRESH_MS);
}

/** Starts or stops following the service, which is needed while auto-refresh or the sound is on, or a task is watched. */
function keepUp() {
  // A page that is locked out neither listens nor asks.
  const needed = !locked && (auto || anySound() || watched.size > 0);
  if (!needed) {
    clearInterval(polling);
    polling = null;
    stopListening();
    leaveTab();
  } else if (!stream && !following && !asking) {
    // Asks every few seconds until the stream of changes is connected, and whenever it is lost.
    polling ??= setInterval(planChanged, REFRESH_MS);
    listen();
  }
  showAge();
}

/**
 * The button that reloads the plan is there while it has something to do: not while the page keeps itself up to
 * date, and not while the page is locked out, when only a key lets it read.
 */
function showRefresh() {
  $("refresh").hidden = auto || locked;
}

/** Self-refresh is off unless the person turns it on; the choice is remembered in this browser. */
function setAutoRefresh(on) {
  auto = on;
  keepUp();
  $("auto").checked = on;
  showRefresh();
  localStorage.setItem(AUTO_NAME, on ? "on" : "off");
}

/**
 * Watching. The person can ask to be told when a task is done. The list of watched tasks lives in this tab's
 * session storage and nowhere else: the service is never told, and the list is gone when the tab is closed.
 */
const watched = new Set(readWatchedIds());

/** The watched tasks as the tab remembers them. Something else under that name is taken for no tasks. */
function readWatchedIds() {
  try {
    const ids = JSON.parse(sessionStorage.getItem(WATCH_NAME) ?? "[]");
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}
let sound = null;

/** Says in the header how many tasks are watched, while the page may show the plan: it names them. */
function showWatched() {
  const shown = watched.size > 0 && Boolean(state.loadedAt);
  $("watching").hidden = !shown;
  $("watching").textContent = shown ? `watching ${watched.size}` : "";
  $("watching").title = shown ? `Watching ${[...watched].join(", ")}. A sound plays when one is done. Click to open the first.` : "";
}

function saveWatched() {
  sessionStorage.setItem(WATCH_NAME, JSON.stringify([...watched]));
  showWatched();
  keepUp();
  if (state.loadedAt) render();
}

/** Browsers let a page make sound only after the person has used it, so the sound is made ready on a click. */
function readySound() {
  try {
    sound ??= new (window.AudioContext ?? window.webkitAudioContext)();
    if (sound.state === "suspended") sound.resume().catch(() => {});
  } catch {
    sound = null;
  }
}

function watch(id) {
  readySound();
  watched.add(id);
  watchedSince.set(id, ++readings);
  saveWatched();
  // The task may have been finished since the page last read it: it is looked at now, not at the next change.
  lookAtWatched();
}

function unwatch(id) {
  watched.delete(id);
  watchedSince.delete(id);
  saveWatched();
}

/**
 * The page's sounds, each a few notes made by the browser. A note has a pitch `f` in hertz, the second `t` it
 * starts and how many seconds `d` it rings; `type` is its wave, `g` how loud it is, and `to` a pitch it slides to.
 * They were picked by ear from a set of candidates: a pop for a new task, a knock for a started one, a coin for
 * a completed one, and three rising notes for a watched task that is done.
 */
const NOTES = {
  created: [{ f: 420, to: 860, t: 0, d: 0.12, g: 0.3 }],
  started: [
    { f: 330, to: 220, t: 0, d: 0.1, type: "triangle", g: 0.35 },
    { f: 392, to: 262, t: 0.13, d: 0.12, type: "triangle", g: 0.35 },
  ],
  done: [
    { f: 987.77, t: 0, d: 0.09, type: "square", g: 0.08 },
    { f: 1318.5, t: 0.08, d: 0.45, type: "square", g: 0.08 },
  ],
  watched: [
    { f: 660, t: 0, d: 0.36 },
    { f: 880, t: 0.16, d: 0.36 },
    { f: 1320, t: 0.32, d: 0.36 },
  ],
};
const anySound = () => Object.values(state.sounds).some(Boolean);

/** Plays the notes of one sound. */
function chime(notes) {
  readySound();
  if (!sound) return;
  const start = sound.currentTime + 0.02;
  for (const { f, to, t, d, type = "sine", g = 0.22 } of notes) {
    const at = start + t;
    const note = sound.createOscillator();
    const volume = sound.createGain();
    note.type = type;
    note.frequency.setValueAtTime(f, at);
    if (to) note.frequency.exponentialRampToValueAtTime(to, at + d);
    volume.gain.setValueAtTime(0.0001, at);
    volume.gain.exponentialRampToValueAtTime(g, at + 0.012);
    volume.gain.exponentialRampToValueAtTime(0.0001, at + d);
    note.connect(volume).connect(sound.destination);
    note.start(at);
    note.stop(at + d + 0.05);
  }
}

/** How many notices are on screen at once. The earlier ones wait behind them and come into view as these are dismissed. */
const NOTICES_SHOWN = 5;
/** Every notice that has not been dismissed, the earliest first. */
const notices = [];

/**
 * Puts the latest notices on screen. With more than one, a line above them says how many there are in all and
 * has a button that closes every one. Notices already on screen are left where they are, so they do not flicker.
 */
function showNotices() {
  const shown = notices.slice(-NOTICES_SHOWN);
  for (const node of $("toasts").querySelectorAll(".toast")) if (!shown.includes(node)) node.remove();
  for (let i = shown.length - 1; i >= 0; i--) if (!shown[i].isConnected) $("toasts").insertBefore(shown[i], shown[i + 1] ?? null);
  $("toasts-head").hidden = notices.length < 2;
  $("toasts-count").textContent = notices.length > shown.length ? `${notices.length} notifications, showing the latest ${shown.length}` : `${notices.length} notifications`;
}
$("toasts-clear").addEventListener("click", () => {
  notices.length = 0;
  showNotices();
});

/** Shows a notice that stays until it is dismissed, since the person may be looking elsewhere. */
function toast(kind, what, title, id) {
  const dismiss = () => {
    notices.splice(notices.indexOf(notice), 1);
    showNotices();
  };
  const notice = el(
    "div",
    { class: `toast ${kind}` },
    el("span", { class: "toast-mark", "aria-hidden": "true" }, kind === "done" ? "✓" : "–"),
    el("div", {}, el("div", { class: "toast-what" }, what), title && el("div", { class: "toast-title", title }, title)),
    id && el("button", { type: "button", onclick: () => (dismiss(), openItem("task", id)) }, "Open"),
    el("button", { class: "toast-close", type: "button", "aria-label": "Dismiss", onclick: dismiss }, "✕"),
  );
  notices.push(notice);
  showNotices();
}

/**
 * Looks at every watched task through `find`, which gives the task as last read, or null when it is gone.
 * A task that is done is announced with the sound and is no longer watched. Returns whether the sound was played.
 */
function noteWatched(find, turn) {
  // An answer that was on its way when the key was refused must not put a task's name back on screen.
  if (locked) return false;
  // Nor may an answer asked for before one that was already acted on: it is older news, and may say a task is
  // done that has been reopened since.
  if (turn < noted) return false;
  noted = turn;
  let fewer = false;
  let played = false;
  for (const id of [...watched]) {
    // An answer asked for before this watch began belongs to an earlier watch of the same task.
    if (turn < (watchedSince.get(id) ?? 0)) continue;
    const task = find(id);
    if (task === undefined) continue;
    if (task && !FINISHED.includes(task.status)) continue;
    watched.delete(id);
    watchedSince.delete(id);
    fewer = true;
    if (task?.status === "done") {
      if (!played) chime(NOTES.watched);
      played = true;
      chimed.set(id, turn);
      toast("done", `${id} is done`, task.title, id);
    } else {
      toast("gone", task ? `${id} was cancelled` : `${id} was deleted`, task?.title, task ? id : null);
    }
  }
  if (fewer) saveWatched();
  return played;
}

/** The state each task was last heard to be in. Kept apart from the board, which the sound must not need drawn again. */
let heard = null;
/**
 * Readings of the tasks are numbered in the order they are asked for, whoever asks. `announced` is the latest one
 * whose news was announced, `noted` the latest one the watched tasks were looked up in, and `watchedSince` the
 * number at which each watch began.
 */
let readings = 0;
let announced = 0;
let noted = 0;
const watchedSince = new Map();
/**
 * Tasks whose completion the watch has announced, each with the number of the reading that found it. The sound
 * for completed tasks leaves them out, until a reading that is not older than that one has been through: by then
 * the completion is either known to all, or undone because the task was reopened.
 */
const chimed = new Map();

/**
 * Says what the tasks just read have to tell: a notice and a chime for each watched task that is done, and, for
 * the sounds that are switched on, one sound for what happened since the tasks were last read. One sound for one
 * reading, however much happened: a completed task is announced before a started one, a started one before a new
 * one, and never on top of the chime of a watched task.
 */
function announce(tasks, find, turn) {
  // A reading asked for before one that has already been announced is older news: it says nothing, and it must
  // not become what the next reading is compared with, or what was announced would be announced again.
  if (turn < announced || locked) return;
  announced = turn;
  const before = heard;
  heard = new Map(tasks.map((task) => [task.id, task.status]));
  const played = noteWatched(find, turn);
  // A task not seen before that is already started or completed was created and moved on between two readings:
  // it counts as started or completed, which says more than that it is new. A completion that the watch has
  // announced with its own chime is not announced a second time.
  const became = (status) => tasks.some((task) => task.status === status && before.get(task.id) !== status && !(status === "done" && chimed.has(task.id)));
  const what =
    played || before === null ? null
    : state.sounds.done && became("done") ? "done"
    : state.sounds.started && became("in_progress") ? "started"
    : state.sounds.created && tasks.some((task) => !before.has(task.id)) ? "created"
    : null;
  // A reading as new as the one in which the watch chimed settles it, whatever it found: done, and the completion
  // is now known here too; reopened or gone, and there is nothing left to leave out. An older reading does not.
  for (const [id, found] of chimed) if (turn >= found) chimed.delete(id);
  if (what) chime(NOTES[what]);
}

/**
 * Makes `read` run one at a time. A call that arrives while it runs leads to one more run afterwards, so that a
 * change made during a reading is never missed.
 */
function oneAtATime(read) {
  let running = false;
  let more = false;
  return async () => {
    if (running) return void (more = true);
    running = true;
    try {
      do {
        more = false;
        await read();
      } while (more);
    } finally {
      running = false;
    }
  };
}

/** Reads the tasks for what there is to announce, without loading or drawing the board again. */
const hearChanges = oneAtATime(async () => {
  if (locked) return;
  try {
    const turn = ++readings;
    const tasks = await all("list-tasks", "tasks");
    const byId = new Map(tasks.map((task) => [task.id, task]));
    announce(tasks, (id) => byId.get(id) ?? null, turn);
  } catch (error) {
    // A refused key is for the page as a whole to deal with: it empties itself and asks for one.
    if (error.status === 401) load();
    else retryQuietly();
  }
});

/** Reads the watched tasks from the service, one by one, without loading or drawing the board again. */
const lookAtWatched = oneAtATime(async () => {
  if (locked) return;
  const turn = ++readings;
  const session = sessions;
  const read = new Map();
  let failed = false;
  for (const id of watched) {
    // The key may be refused while this is under way: nothing more is asked for then.
    if (locked || session !== sessions) return;
    try {
      const task = await api("get", { kind: "task", id });
      read.set(id, task.deleted_at ? null : task);
    } catch (error) {
      // A task that is not there any more is gone; any other failure says nothing about the task.
      if (error.code === "not_found") read.set(id, null);
      else if (error.status === 401) return void load();
      else failed = true;
    }
  }
  noteWatched((id) => (read.has(id) ? read.get(id) : undefined), turn);
  if (failed) retryQuietly();
});
$("watching").addEventListener("click", () => watched.size && openItem("task", [...watched][0]));
// A page that was reloaded cannot make sound until it is used again: the first click or key makes it ready.
for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, () => (watched.size || anySound()) && readySound(), { once: true });

for (const [what, id] of Object.entries({ created: "sound-created", started: "sound-started", done: "sound" })) {
  $(id).checked = state.sounds[what];
  $(id).addEventListener("change", (event) => {
    const listening = anySound();
    state.sounds[what] = event.target.checked;
    localStorage.setItem(SOUND_NAMES[what], state.sounds[what] ? "on" : "off");
    // Turned on, it is played once: the person hears what to expect, and the browser now lets the page make sound.
    if (state.sounds[what]) chime(NOTES[what]);
    keepUp();
    // What happened before now is not news: without auto-refresh, the tasks are read afresh to start from.
    if (state.sounds[what] && !listening && !auto) {
      heard = null;
      hearChanges();
    }
  });
}

$("auto").addEventListener("change", (event) => {
  setAutoRefresh(event.target.checked);
  if (event.target.checked) load();
});
$("refresh").addEventListener("click", () => load());
// Seen again, the page catches up; not while it is locked out, when only a key given by the person lets it read.
document.addEventListener("visibilitychange", () => !locked && (auto || state.failed) && !document.hidden && follow());

{
  const route = readRoute();
  Object.assign(state, { view: route.view, open: route.open, trail: history.state?.trail ?? [] });
}
setAutoRefresh(localStorage.getItem(AUTO_NAME) === "on");
saveWatched();
load();
