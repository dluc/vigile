import { LARGE, STATES, clearGraph, renderGraph, resizeGraph, zoomGraph } from "./graph.js";
import { lights } from "./lights.js";
// The rules for reading a list in pages are the service's own modules, handed over as they are.
import { ENDS, NotAList, begun, describeItemList, describeList, readToEnd, resume, takePage } from "/shared/paging.js";
import { boardChanges, cardModel, forgetMarks, inStrip, isTrouble, markedAt, setMarks } from "./board.js";

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
    this.body = body;
    /** The key the request was sent with, or nothing: a refusal is of that key, not of whichever is stored by now. */
    this.key = key ?? "";
  }
}

async function api(path, input, key = localStorage.getItem(KEY_NAME) ?? "") {
  const response = await fetch(`/api/${path}`, {
    method: input === undefined ? "GET" : "POST",
    headers: { ...(input === undefined ? {} : { "content-type": "application/json" }), ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: input === undefined ? undefined : JSON.stringify(input),
    // A request that gets no answer at all is given up, so that the page can ask again instead of waiting for ever.
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body?.error, key);
  keyInUse = key;
  return body;
}

/** The key the service last answered to, or nothing when it answered without one. */
let keyInUse = "";

/**
 * What answered is not a Vigile service, or not this version of one: it gave a list that is not one as the
 * service gives them. Said as an answer that was an error, which is shown with a way to try again; it is never
 * taken for the end of a list, and nothing more is asked for on the strength of it.
 */
const notAsVigile = (asked, why) => new ApiError(200, { code: "internal", message: `What answered ${asked} did not answer as this Vigile service does: ${why}.` });

/**
 * Reads a list to its end, page by page, by the steps that hold for whoever reads one: they are the service's
 * own, in `/shared/paging.js`. A token is sent on once, and only a token of this very list, after a page that
 * brings something new and further on; the list is read for a thousand pages and a hundred thousand entries
 * at most. A list that is not so is not the service's: the reading stops and says so.
 */
async function all(path, field, input = {}) {
  const session = sessions;
  const operation = path.replaceAll("-", "_");
  try {
    return await readToEnd(describeList(operation, input), async (continuation) => {
      // A list comes in pages. Should the key be refused between two of them, the rest is not asked for.
      if (session !== sessions) throw new Error("The page was locked out while it was reading.");
      const page = await api(path, { ...input, ...(continuation === undefined ? {} : { continuation }) });
      return { entries: page?.[field], continuation: page && Object.hasOwn(page, "continuation") ? page.continuation : ENDS };
    });
  } catch (error) {
    throw error instanceof NotAList ? notAsVigile(path, error.why) : error;
  }
}

const COLUMNS = [
  { key: "trouble", title: "Bugs, issues and incidents", tone: "bug", note: "Not finished yet, in any state" },
  { key: "in_progress", title: "In progress", tone: "busy" },
  { key: "next", title: "Next", tone: "go" },
  { key: "in_review", title: "In review", tone: "review" },
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
const isOpenTrouble = (task) => isTrouble(task) && !FINISHED.includes(task.status);

/**
 * Where a task goes on the board: the column for its state. When the person asks for it, unfinished bugs, issues
 * and incidents get a column of their own instead. They are there because of what they are, not because of their
 * state, so inside that column a heading for each state says which ones are being worked on.
 */
const boardColumn = (task) => (state.bugsApart && isOpenTrouble(task) ? "trouble" : columnOf(task));

const state = { projects: [], tasks: [], byId: new Map(), snapshot: "", instance: null, project: null, projectZoom: false, filter: "", summaryFilter: null, expanded: new Set(), view: "board", trail: [], zoom: null, into: [], hideFinished: false, collapsed: true, bugsApart: localStorage.getItem(BUGS_NAME) === "on", columnScroll: localStorage.getItem(SCROLL_NAME) !== "page", motion: localStorage.getItem(MOTION_NAME), lights: localStorage.getItem(LIGHTS_NAME) === "on", sounds: Object.fromEntries(Object.entries(SOUND_NAMES).map(([what, name]) => [what, localStorage.getItem(name) === "on"])), projectsFolded: localStorage.getItem(PROJECTS_NAME) === "folded", focus: localStorage.getItem(FOCUS_NAME) === "on", full: false, group: null, open: null, failed: false, large: false };

/** One worker per task. Leaving a panel cancels unsent clicks, but never creates a rival for a write in flight. */
const priorityWorkers = new Map();
let priorityWork = null;

/** How a project appears in a task's `contained_in`: numbered projects carry their kind in front. */
const projectRef = (project) => (/^\d+$/.test(project.id) ? `project:${project.id}` : project.id);

/**
 * The live projects and tasks that hold a task. The service lists them apart when a deleted item is among the
 * task's containers: a task that a live group holds through a deleted one is still inside the live group, and
 * the service counts it there, in the group's progress and in its lists by project and by parent. The page goes
 * by the same list, so that it never shows a task outside a group whose count includes it.
 */
const holdersOf = (task) => task.live_containers ?? task.contained_in;

/**
 * What each project and task holds, of the tasks as they were last read: `held` directly, and `inside` at any
 * depth, which is worked out for a holder when it is first asked for. Both go when the plan is read again.
 */
let holdings = { of: null, held: new Map(), inside: new Map() };

function heldBy() {
  if (holdings.of === state.tasks) return holdings.held;
  holdings = { of: state.tasks, held: new Map(), inside: new Map() };
  for (const task of state.tasks) {
    for (const ref of holdersOf(task)) {
      if (ref === task.id) continue;
      if (!holdings.held.has(ref)) holdings.held.set(ref, []);
      holdings.held.get(ref).push(task);
    }
  }
  return holdings.held;
}

/**
 * The IDs of the tasks inside a project or a task, at any depth and each once, however many ways lead to it.
 * Found going down from the holder, by steps and not by a function that calls itself: a plan nested a thousand
 * deep is no trouble, and the work is that of the links it follows.
 */
function heldIn(ref) {
  const held = heldBy();
  if (holdings.inside.has(ref)) return holdings.inside.get(ref);
  const inside = new Set();
  const queue = [ref];
  for (let next = 0; next < queue.length; next++) {
    for (const task of held.get(queue[next]) ?? []) {
      if (inside.has(task.id)) continue;
      inside.add(task.id);
      queue.push(task.id);
    }
  }
  holdings.inside.set(ref, inside);
  return inside;
}

/** Whether one holder has a task anywhere inside it, without retaining every ancestor's whole descendant set. */
function holds(ref, wanted) {
  const held = heldBy();
  const seen = new Set([ref]);
  const queue = [ref];
  for (let next = 0; next < queue.length; next++) {
    for (const task of held.get(queue[next]) ?? []) {
      if (task.id === wanted) return true;
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      queue.push(task.id);
    }
  }
  return false;
}

/** The tasks both views are narrowed to: those of the selected project that are inside the group that was zoomed into. */
function tasksInView() {
  let tasks = state.tasks;
  for (const ref of [state.project, state.group]) {
    if (!ref) continue;
    const inside = heldIn(ref);
    tasks = tasks.filter((task) => inside.has(task.id));
  }
  return tasks;
}

/** What is typed in the filter, as it is compared. */
const filterText = () => state.filter.trim().toLowerCase();

/** A selected summary pill narrows both views without turning its label into a text-search query. */
function matchesSummaryFilter(task) {
  if (state.summaryFilter === "trouble") return isOpenTrouble(task);
  if (state.summaryFilter === "problems") return task.has_problems;
  return true;
}

function matchesVisibleTask(task, text = filterText()) {
  return matchesFilter(task, text) && matchesSummaryFilter(task);
}

function matchesFilter(task, text = filterText()) {
  if (!text) return true;
  return [task.id, task.title, ...task.assigned_to].some((value) => value.toLowerCase().includes(text));
}

/**
 * How deep everything in view sits, counted from the top of what is in view. An item that nothing in view holds,
 * or that the group the board is in holds directly, is at 1; anything else is one below the nearest of the items
 * that hold it. So a task in two groups is as near the top as the nearer of them, and is on the board as soon as
 * either is open. `held` says what each item holds directly, and `deepest` how many levels there are.
 */
function levelsOf(tasks) {
  const inView = new Set(tasks.map((task) => task.id));
  const held = new Map();
  const depth = new Map();
  let front = [];
  for (const task of tasks) {
    let top = true;
    for (const ref of holdersOf(task)) {
      if (ref === task.id || !inView.has(ref)) continue;
      top = false;
      if (!held.has(ref)) held.set(ref, []);
      held.get(ref).push(task);
    }
    if (!top && !(state.group && holdersOf(task).includes(state.group))) continue;
    depth.set(task.id, 1);
    front.push(task);
  }
  let deepest = front.length ? 1 : 0;
  // Level by level and not by a function that calls itself, so that groups nested very deep are no trouble.
  for (let level = 2; front.length; level++) {
    const next = [];
    for (const task of front) {
      for (const inner of held.get(task.id) ?? []) {
        if (depth.has(inner.id)) continue;
        depth.set(inner.id, level);
        next.push(inner);
      }
    }
    if (next.length) deepest = level;
    front = next;
  }
  // The service refuses a loop of containing. Should damaged data hold one all the same, nothing leads down to
  // the tasks in it: they count as being at the top, so that no task is ever missing from the board.
  for (const task of tasks) {
    if (depth.has(task.id)) continue;
    depth.set(task.id, 1);
    deepest = Math.max(deepest, 1);
  }
  return { depth, held, deepest };
}

/**
 * What a closed group stands for: how many tasks it holds at any depth, each counted once however many ways lead
 * to it, and how many of them are in progress, waiting, have problems, are unfinished bugs, and match the filter.
 */
function insideOf(task, held, text) {
  const found = { total: 0, finished: 0, busy: 0, waiting: 0, problems: 0, trouble: 0, matching: 0 };
  const seen = new Set([task.id]);
  const queue = [...(held.get(task.id) ?? [])];
  for (let next = 0; next < queue.length; next++) {
    const inner = queue[next];
    if (seen.has(inner.id)) continue;
    seen.add(inner.id);
    found.total++;
    if (FINISHED.includes(inner.status)) found.finished++;
    if (inner.status === "in_progress") found.busy++;
    if (columnOf(inner) === "waiting") found.waiting++;
    if (inner.has_problems) found.problems++;
    if (isOpenTrouble(inner)) found.trouble++;
    if ((text || state.summaryFilter) && matchesVisibleTask(inner, text)) found.matching++;
    for (const deeper of held.get(inner.id) ?? []) if (!seen.has(deeper.id)) queue.push(deeper);
  }
  return found;
}

/**
 * What the board shows at its zoom, of the tasks in view. `level` is how many levels are open, or null when that
 * is all of them. A task is on the board when it sits no deeper than that. One at the last open level that holds
 * something deeper is closed: its card stands for everything it holds, and it stays on the board under a filter
 * when something it holds matches.
 */
function boardAt(tasks) {
  const { depth, held, deepest } = levelsOf(tasks);
  const level = state.zoom === null || state.zoom >= deepest ? null : state.zoom;
  const text = filterText();
  const closed = new Map();
  const cards = [];
  for (const task of tasks) {
    if (level !== null && depth.get(task.id) > level) continue;
    const stands = level !== null && depth.get(task.id) === level && (held.get(task.id) ?? []).some((inner) => depth.get(inner.id) > level);
    const inside = stands ? insideOf(task, held, text) : null;
    if (inside) closed.set(task.id, inside);
    if (matchesVisibleTask(task, text) || inside?.matching) cards.push(task);
  }
  return { cards, closed, level, deepest };
}

/** A level of the board in words. */
const levelName = (level) => (level === null ? "Everything" : level === 1 ? "Top level" : `${level} levels`);

function pill(status) {
  return el("span", { class: `pill ${STATUS_TONE[status] ?? ""}` }, label(status));
}

function renderProjects() {
  $("projects-section").hidden = state.projectZoom;
  $("projects-section").classList.toggle("folded", state.projectsFolded);
  $("projects-fold").setAttribute("aria-expanded", String(!state.projectsFolded));
  $("projects-chevron").textContent = state.projectsFolded ? "▸" : "▾";
  const visibleProjects = state.projectZoom ? [] : state.projects.filter((project) => state.summaryFilter !== "problems" || project.has_problems);
  const cards = visibleProjects.map((project) => {
    const { finished, total } = project.progress;
    const percent = total ? Math.round((finished / total) * 100) : 0;
    const pressed = state.project === projectRef(project);
    // With one project selected, the others step back.
    const dimmed = state.project && !pressed ? " dimmed" : "";
    const choose = () => {
      go(state.view, state.open, state.trail, { project: pressed ? null : projectRef(project), projectZoom: false });
    };
    const zoomed = state.projectZoom && pressed;
    const toggleProjectZoom = () => {
      const zoom = !zoomed;
      go(state.view, null, [], {
        project: projectRef(project),
        projectZoom: zoom,
        zoom: null,
        into: [],
      });
      if (zoom) focusVisible($("leave-group"));
    };
    const zoomButton = (className = "project-zoom") => el(
      "button",
      {
        class: className,
        type: "button",
        "aria-pressed": String(zoomed),
        "aria-label": zoomed ? `Leave project zoom for ${project.id} · ${project.title}` : `Zoom into ${project.id} · ${project.title}`,
        title: zoomed ? "Leave project zoom" : "Show only this project",
        onclick: toggleProjectZoom,
      },
      zoomed ? "Leave zoom" : className === "project-chip-zoom" ? "Zoom" : "Zoom in",
    );
    // Folded, a project is one small item: its ID, its progress, and a mark when it has problems.
    if (state.projectsFolded) {
      return el(
        "span",
        { class: "project-chip-wrap" },
          el(
            "button",
            { class: `project-chip${pressed ? " selected" : ""}${dimmed}`, type: "button", "aria-pressed": String(pressed), title: `${project.title}: ${pressed ? "Show all projects" : "Show only this project"}`, onclick: choose },
            el("span", { class: "project-id" }, project.id),
            el("span", { class: "bar", role: "img", "aria-label": `${percent}% finished` }, el("i", { style: `width:${percent}%` })),
            project.has_problems && el("span", { class: "warn", title: "Has problems" }, "⚠"),
          ),
        zoomButton("project-chip-zoom"),
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
        project.has_problems && el("span", { class: "tag warn" }, "⚠ problems"),
        el("span", { class: "project-actions" }, zoomButton()),
      ),
    );
  });
  $("projects").replaceChildren(...(cards.length ? cards : [el("p", { class: "empty" }, state.summaryFilter === "problems" ? "No projects with problems." : "No projects yet.")]));
}

/** The first few of a list, then how many more there are, so one card never grows without limit. */
const few = (items, shown = 3) => (items.length > shown ? [...items.slice(0, shown), `+${items.length - shown} more`] : items);

/** A container as a short chip: a numbered project is written without its kind. */
const chip = (ref) => ref.replace(/^project:/, "");

/** What a card goes by besides its task: the plan, the project the page is narrowed to, and what is watched. */
const cardContext = () => ({ byId: state.byId, project: state.project, watched });

/**
 * What the card of a closed group showed when it was drawn, as one text: its state, title, kind and priority, how
 * far the tasks it stands for are and how many of them are in each state or match the filter, how many it holds,
 * and every other mark on it. A refresh that changes any of it rings the card. The text is the card itself as it
 * was built, so nothing that is drawn on the card, now or later, can be left out of it; added to it is what the
 * card's place in its column goes by and is not written on it. What the person changes themselves, the filter or
 * the zoom, draws the board again at once and never between the two drawings a refresh compares, so it rings
 * nothing.
 */
const shows = new WeakMap();

/**
 * A task's card. `inside` is given for a closed group, whose card stands for the tasks it holds: it then says how
 * far they are and what state they are in, and has a button of its own that zooms into the group. That button
 * sits beside the card and not in it, since the card is a button itself and opens the panel.
 */
function card(task, inside = null) {
  const shown = cardModel(task, cardContext(), inside);
  const button = el(
    "button",
    { class: ["card", ...shown.marks].join(" "), type: "button", "data-id": shown.id, "data-status": shown.status, onclick: () => openItem("task", shown.id) },
    el(
      "div",
      { class: "card-top" },
      el("span", { class: "id" }, shown.id),
      shown.closed && el("span", { class: "kind" }, "group"),
      shown.type && el("span", { class: "type" }, shown.type),
      shown.priority && el("span", { class: `priority${shown.priority.high ? " high" : ""}`, title: "Priority" }, shown.priority.text),
    ),
    el("div", { class: "card-title" }, shown.title),
    shown.closed && el("span", { class: "bar", role: "img", "aria-label": `${shown.progress.percent}% finished` }, el("i", { style: `width:${shown.progress.percent}%` })),
    shown.tags.length ? el("div", { class: "tags" }, shown.tags.map((tag) => el("span", { class: tag.kind ? `tag ${tag.kind}` : "tag", title: tag.title, "data-tone": tag.tone }, tag.text))) : null,
  );
  if (!inside) return button;
  const whole = el(
    "div",
    { class: "holder" },
    button,
    el(
      "button",
      { class: "zoom-into", type: "button", "data-id": task.id, "aria-label": `Zoom into ${task.id}: show only the ${counted(shown.progress.total, "task")} it holds`, title: "Show only what this group holds", onclick: () => zoomInto(task.id) },
      el("span", { class: "zoom-into-label" }, el("span", { class: "zoom-into-icon", "aria-hidden": "true" }), "Zoom in"),
      el("span", { class: "holds" }, `holds ${counted(shown.progress.total, "task")}`),
    ),
  );
  // Among the finished, a card's place goes by when it was completed, which no card says.
  shows.set(button, [whole.innerHTML, shown.completed_at].join("\n"));
  return whole;
}

/** Whether each column scrolls by itself. On a phone the columns are stacked and the page scrolls. */
const columnMode = () => state.columnScroll && !narrow.matches;

/** How many cards a column shows before asking: few on a page that scrolls as a whole, more in a column that scrolls by itself. */
const columnShown = () => (columnMode() ? 50 : 12);

/** With columns that scroll by themselves, the board is as tall as the room left in the window. */
function fitBoard() {
  const board = $("board");
  const main = $("main");
  const on = columnMode() && state.view === "board" && !board.hidden;
  document.body.classList.toggle("column-scroll", on);
  if (!on || main.hidden) {
    document.body.classList.remove("summary-docked");
    main.style.removeProperty("--summary-room");
    return board.style.removeProperty("--board-height");
  }
  // Fitting the board can remove the page's scrollbar, which widens the page and can move the board up: measure again.
  for (let round = 0; round < 3; round++) {
    // Measure the layout the dock would make, not whichever mode happened to be left by the preceding draw. At
    // widths where an in-flow summary wraps the tools, measuring that wrap would make docking depend on history.
    document.body.classList.add("summary-docked");
    const top = board.getBoundingClientRect().top + window.scrollY;
    const summary = $("summary").getBoundingClientRect();
    const bottomRoom = summary.height > 0 ? summary.height + 24 : 12;
    const available = Math.floor(window.innerHeight - top - bottomRoom);
    const docked = available >= 360;
    document.body.classList.toggle("summary-docked", docked);
    if (docked) main.style.setProperty("--summary-room", `${Math.ceil(bottomRoom)}px`);
    else main.style.removeProperty("--summary-room");
    const height = `${Math.max(360, available)}px`;
    if (board.style.getPropertyValue("--board-height") === height) break;
    board.style.setProperty("--board-height", height);
  }
}

/**
 * Collapsed columns. A column of the board can be collapsed to a strip that keeps its name and its count, which
 * leaves the room to the columns one cares to see. Which columns are collapsed is remembered in this browser, by
 * the column's name. It is this browser's own business: it is not in the page's address, so a shared link
 * collapses nobody else's columns, and it is never sent to the service.
 */
const COLLAPSED_NAME = "vigile.collapsed";
const collapsedColumns = new Set(readCollapsedColumns());

/** The collapsed columns as the browser remembers them. Something else under that name is taken for none, and a name that no column has is left out. */
function readCollapsedColumns() {
  try {
    const keys = JSON.parse(localStorage.getItem(COLLAPSED_NAME) ?? "[]");
    return Array.isArray(keys) ? keys.filter((key) => COLUMNS.some((c) => c.key === key)) : [];
  } catch {
    return [];
  }
}

/** The columns that are being collapsed or opened, while the board is drawn again for it. */
let folding = null;
/** What the board is narrowed to: the project, the group, the filter, and whether bugs have a column of their own. Whatever else comes to narrow it belongs here. */
const boardScope = () => JSON.stringify([state.project, state.group, state.filter.trim().toLowerCase(), state.summaryFilter, state.bugsApart, state.level]);

/**
 * The board as it was last drawn, whether or not a card is drawn for each task: what it is narrowed to, what its
 * cards go by, and every task on it with its column. A refresh is told from the board before it and the board
 * after it, and so are the rings: a task beyond what its column shows, or in a collapsed column, is on the board
 * like any other.
 */
let onBoard = { scope: "", context: null, tasks: new Map() };

/** The control of the collapsed column that holds a task, or nothing: what stands for the task's card while its column is collapsed. */
function stripFor(id) {
  const column = onBoard.tasks.get(id)?.column;
  const strip = column && collapsedColumns.has(column) ? columnOnBoard(column) : null;
  return strip?.classList.contains("collapsed") ? strip.querySelector(".column-fold") : null;
}

/**
 * Whether a control can take the keyboard: it is on the page, drawn, in sight, and neither switched off nor in a
 * part of the page that is. A control with no place on the page, as one inside something hidden, cannot.
 */
function takesKeyboard(control) {
  if (!control?.isConnected || control === document.body || control.disabled || control.closest("[inert], [hidden]")) return false;
  return control.getClientRects().length > 0 && getComputedStyle(control).visibility !== "hidden";
}

/**
 * Puts the keyboard on the first of the candidates that can take it, without scrolling, and says which it was.
 * A candidate is a control, a way to find one, or nothing. Whatever moves the keyboard because the control that
 * had it is gone goes through here, so that it never ends on a control that is hidden, or on nothing while
 * something can take it.
 */
function focusVisible(...candidates) {
  for (const candidate of candidates) {
    const control = typeof candidate === "function" ? candidate() : candidate;
    if (!takesKeyboard(control)) continue;
    if (document.activeElement !== control) control.focus({ preventScroll: true });
    if (document.activeElement === control) return control;
  }
  return null;
}

/**
 * Where the keyboard goes when nothing nearer can take it: the link of the view that is shown, which is there
 * but for the graph at full screen; the button that leaves full screen, which is there then; and the filter and
 * the settings, should a page be drawn one day with neither of the first two.
 */
const keyboardFallbacks = () => [() => $("panel").querySelector(".panel-card"), $(`view-${state.view}`), $("graph-full"), $("filter"), $("settings")];

/**
 * Sees to the keyboard after the page was changed. `had` is what had it before. When that is gone, hidden or
 * switched off, the keyboard goes to the first candidate that can take it, and failing those to where it always
 * can go: it is never left on nothing, or on something out of sight. A page whose keyboard was nowhere before is
 * left as it is: nothing was lost, and nothing is to be read out.
 */
function keepKeyboard(had, ...candidates) {
  if (!had || had === document.body || takesKeyboard(document.activeElement)) return;
  focusVisible(...candidates, ...keyboardFallbacks());
}

/**
 * What stands for a task on the page now, where the keyboard can go: its card, or, while its column is
 * collapsed, the strip that holds it; nothing when the task has neither in sight. Whatever puts the keyboard on
 * a task asks here and nowhere else: the board drawn again under a card that had the keyboard, a card moved by a
 * refresh, a column collapsed under it, the panel that closes. A card on its way to another column waits unseen
 * where it will land: wanted by the keyboard, it lands at once.
 */
function representative(id) {
  const card = [...$("board").querySelectorAll(".card")].find((drawn) => drawn.dataset.id === id);
  const flying = card ? flights.get(id) : null;
  if (flying) {
    flights.delete(id);
    for (const animation of flying.getAnimations()) animation.cancel();
    flying.remove();
    keepMarks();
  }
  return [card, stripFor(id)].find(takesKeyboard) ?? null;
}

/**
 * Collapses columns or opens them again, and remembers it. The board is drawn again with the other columns left
 * as they stand: collapsing one column must not cost the drawing of every card on the board.
 */
function collapseColumns(keys, on) {
  for (const key of keys) on ? collapsedColumns.add(key) : collapsedColumns.delete(key);
  localStorage.setItem(COLLAPSED_NAME, JSON.stringify(COLUMNS.map((c) => c.key).filter((key) => collapsedColumns.has(key))));
  $("columns-open-choice").hidden = collapsedColumns.size === 0;
  if (state.view !== "board" || !state.loadedAt) return;
  // A card on its way would land where its column no longer is: the journeys end, each card in its place.
  for (const copy of flights.values()) {
    for (const animation of copy.getAnimations()) animation.cancel();
    copy.remove();
  }
  flights.clear();
  folding = new Set(keys);
  try {
    render();
  } finally {
    folding = null;
  }
}
const openAllColumns = () => collapseColumns([...collapsedColumns], false);
$("columns-open-choice").hidden = collapsedColumns.size === 0;
$("columns-open").addEventListener("click", () => {
  // The row has nothing left to offer and goes: the keyboard moves to the button of the menu it is in, before
  // the row is taken away under it.
  focusVisible($("settings"));
  openAllColumns();
});

/** The column of that name as it is on the board, or nothing. */
const columnOnBoard = (key) => [...$("board").children].find((child) => child.dataset.key === key) ?? null;

/** A column as it stands on the board, if it still takes the room it took: Done is drawn again when it gets more or less of the spare width. */
function standingColumn(key, span) {
  const column = columnOnBoard(key);
  return column && Number(column.style.getPropertyValue("--span") || 1) === span ? column : null;
}

/**
 * Gives each column its room on the board. Open columns share the width as they always did. A strip has a width
 * of its own, so with one on the board the row is spelled out, column by column.
 */
function layColumns(visible) {
  const tracks = visible.flatMap((c) => (collapsedColumns.has(c.key) ? ["var(--column-strip)"] : Array(c.key === "done" ? state.span : 1).fill("var(--column-track)")));
  if (visible.some((c) => collapsedColumns.has(c.key))) $("board").style.setProperty("--columns", tracks.join(" "));
  else $("board").style.removeProperty("--columns");
}

const SVG = "http://www.w3.org/2000/svg";

/** The arrowhead on the control that collapses a column, drawn as the page's other small drawings are. The styles turn it to point where the column goes. */
function arrowhead() {
  const drawing = document.createElementNS(SVG, "svg");
  for (const [name, value] of Object.entries({ viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true" })) drawing.setAttribute(name, value);
  const line = document.createElementNS(SVG, "path");
  for (const [name, value] of Object.entries({ d: "M10.2 3.6 5.8 8l4.4 4.4", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round" })) line.setAttribute(name, value);
  drawing.append(line);
  return drawing;
}

/**
 * The control in a column's heading that collapses the column, and opens it again. Its name says what it will
 * do, and of a collapsed column how many cards are in it, which is all there is to know of them from outside.
 */
function foldControl(c, shut, cards) {
  const name = shut ? `Open the ${c.title} column, ${counted(cards, "card")}` : `Collapse the ${c.title} column`;
  return el("button", { class: "column-fold", type: "button", "aria-expanded": String(!shut), "aria-label": name, title: name, onclick: () => collapseColumns([c.key], !shut) }, arrowhead());
}

/** A collapsed column: its heading and nothing else. The styles make it a strip, and its control as large as the strip. */
const collapsedColumn = (c, cards) =>
  el("section", { class: "column collapsed", "data-tone": c.tone, "data-key": c.key }, el("div", { class: "column-head" }, el("span", { class: "dot" }), c.title, el("span", { class: "count" }, String(cards)), foldControl(c, true, cards)));

/** With every column collapsed the board is a row of strips and nothing else: a line beside them says so, and opens them all. */
function allCollapsed(visible) {
  if (!visible.length || visible.some((c) => !collapsedColumns.has(c.key))) return null;
  return el("p", { class: "columns-note" }, "Every column is collapsed.", el("button", { type: "button", onclick: openAllColumns }, "Open all"));
}

/**
 * How many card-widths the Done column takes. It is usually the longest column, so when the window is wider
 * than the columns need, it gets the spare room, up to four card-widths and never more than it has cards.
 * `columns` counts the open columns and `strips` the collapsed ones.
 */
function doneSpan(columns, cards, strips = 0) {
  const board = $("board");
  if (narrow.matches || !board.clientWidth) return 1;
  const style = getComputedStyle(board);
  const widest = parseFloat(style.getPropertyValue("--column-widest"));
  const gap = parseFloat(style.columnGap) || 0;
  // A collapsed column takes the width of its strip, and what it leaves is spare room like any other.
  const narrowest = parseFloat(style.getPropertyValue("--column-strip")) || 0;
  const spare = board.clientWidth - (columns * widest + strips * narrowest + (columns + strips - 1) * gap);
  return 1 + Math.max(0, Math.min(Math.floor(spare / (widest + gap)), cards - 1, 3));
}

/** Set when the board is about to show another level or another group: its columns then start from the top. */
let boardMoved = false;

function renderBoard(tasks, closed) {
  const cardOf = (task) => card(task, closed.get(task.id));
  const groups = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));
  for (const task of tasks) (groups[boardColumn(task)] ??= []).push(task);
  const order = COLUMNS.map((c) => c.key);
  // On a board that is zoomed out the closed groups come first in each column, and in each state of the column
  // for bugs: they are what the view is for, and must not be looked for among the tasks that are in no group.
  const first = (a, b) => Number(closed.has(b.id)) - Number(closed.has(a.id));
  groups.trouble.sort((a, b) => order.indexOf(columnOf(a)) - order.indexOf(columnOf(b)) || first(a, b) || b.priority - a.priority);
  groups.next.sort((a, b) => b.priority - a.priority);
  groups.done.sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
  if (closed.size) for (const column of COLUMNS) if (column.key !== "trouble") groups[column.key].sort(first);

  // With no tasks at all there is nothing to lay out: one message says why.
  const visible = tasks.length ? COLUMNS.filter((c) => groups[c.key].length || ["in_progress", "next", "done"].includes(c.key)) : [];
  const strips = visible.filter((c) => collapsedColumns.has(c.key));
  // A collapsed Done column takes no spare room: it counts as one that has no cards to lay side by side.
  state.spanFor = [visible.length - strips.length, collapsedColumns.has("done") ? 0 : groups.done.length, strips.length];
  state.span = doneSpan(...state.spanFor);
  layColumns(visible);
  // A board that is narrowed to something else is another board. The marks of the one before are not carried to
  // it, and are gone when that one is come back to: they were news of the plan as it was shown then.
  if (boardScope() !== onBoard.scope) marked.clear();
  // The tasks that are watched are a list that changes in place: the board keeps the list as it is now.
  onBoard = { scope: boardScope(), context: { ...cardContext(), watched: new Set(watched) }, tasks: new Map(visible.flatMap((c) => groups[c.key].map((task) => [task.id, { task, column: c.key, closed: closed.get(task.id) ?? null }]))) };
  const drawColumn = (c) => {
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
          shown.filter((task) => columnOf(task) === s.key).map(cardOf),
        ])
      : shown.map(cardOf);
    return el(
      "section",
      { class: `column${span > 1 ? " wide" : ""}`, "data-tone": c.tone, "data-key": c.key, style: span > 1 ? `--span: ${span}` : undefined },
      el("div", { class: "column-head" }, el("span", { class: "dot" }), c.title, el("span", { class: "count" }, String(groups[c.key].length)), foldControl(c, false, groups[c.key].length)),
      c.note && el("p", { class: "column-note" }, c.note),
      shown.length ? el("div", { class: "cards" }, cards) : el("p", { class: "nothing" }, "Nothing here."),
      more,
    );
  };
  // While a column is collapsed or opened, the others stand as they are, cards and all.
  const columns = visible.map((c) => (folding && !folding.has(c.key) ? standingColumn(c.key, c.key === "done" ? state.span : 1) : null) ?? (collapsedColumns.has(c.key) ? collapsedColumn(c, groups[c.key].length) : drawColumn(c)));
  // Drawing the board again must not make a reader lose their place: each column, and the board itself, stays
  // scrolled where it was. Not so when the board shows another level or group: those are other cards.
  const scrolled = new Map(boardMoved ? [] : [...$("board").querySelectorAll(".column")].map((column) => [column.dataset.key, column.querySelector(".cards")?.scrollTop ?? 0]));
  boardMoved = false;
  const across = $("board").scrollLeft;
  $("board").replaceChildren(...columns, ...present([allCollapsed(visible)]));
  for (const column of columns) {
    const cards = column.querySelector(".cards");
    if (cards && scrolled.get(column.dataset.key)) cards.scrollTop = scrolled.get(column.dataset.key);
  }
  $("board").scrollLeft = across;
  keepMarks();
}

/**
 * The counts above the tasks. They count what is shown: in the graph every task in view, on the board its cards.
 * On a board that is zoomed out the cards are fewer than the tasks, and the first count says how many tasks they
 * stand for: every task in view that matches the filter, each counted once however many groups hold it.
 */
function renderSummary(tasks, all, visibleTasks = tasks) {
  const active = document.activeElement;
  const focusedFilter = active?.closest?.("#summary [data-summary-filter]")?.dataset.summaryFilter;
  const focusedClear = Boolean(active?.closest?.("#summary [data-clear-summary-filter]"));
  const focusedProjectClear = Boolean(active?.closest?.("#summary [data-clear-project-filter]"));
  // Counted as the board shows them: with bugs in a column of their own, they are not also among the waiting or the next.
  const count = (key) => tasks.filter((t) => boardColumn(t) === key).length;
  const trouble = visibleTasks.filter(isOpenTrouble).length;
  const problems = visibleTasks.filter((t) => t.has_problems).length + (state.group ? 0 : state.projects.filter((project) => project.has_problems && (!state.project || projectRef(project) === state.project)).length);
  const summaryFilter = (key, count, text, tone) => el("button", {
    class: `tag ${tone} summary-filter`,
    type: "button",
    "data-summary-filter": key,
    "aria-pressed": String(state.summaryFilter === key),
    "aria-label": `${count} ${text}${state.summaryFilter === key ? "; selected filter" : "; filter board"}`,
    title: state.summaryFilter === key ? `Clear ${text} filter` : `Show ${text}`,
    onclick: () => selectSummaryFilter(key),
  }, `${count} ${text}`);
  $("summary").replaceChildren(...present([
    state.level && state.view === "board"
      ? el("span", {}, el("b", {}, String(tasks.length)), tasks.length === 1 ? " card for " : " cards for ", el("b", {}, String(all)), all === 1 ? " task" : " tasks")
      : el("span", {}, el("b", {}, String(tasks.length)), " tasks"),
    el("span", {}, el("b", {}, String(count("in_progress"))), " in progress"),
    el("span", {}, el("b", {}, String(count("next"))), " next"),
    el("span", {}, el("b", {}, String(count("waiting"))), " waiting"),
    el("span", {}, el("b", {}, String(count("done"))), " done"),
    trouble || state.summaryFilter === "trouble" ? summaryFilter("trouble", trouble, trouble === 1 ? "open bug, issue or incident" : "open bugs, issues and incidents", "trouble") : null,
    problems || state.summaryFilter === "problems" ? summaryFilter("problems", problems, problems === 1 ? "item with problems" : "items with problems", "warn") : null,
    state.summaryFilter && el("button", { class: "tag summary-filter summary-filter-clear", type: "button", "data-clear-summary-filter": "", "aria-label": "Clear selected summary filter", title: "Clear selected summary filter", onclick: () => selectSummaryFilter(state.summaryFilter) }, "Clear filter"),
    state.project && !state.projects.some((project) => projectRef(project) === state.project && (state.summaryFilter !== "problems" || project.has_problems))
      ? el("button", { class: "tag summary-filter summary-project-clear", type: "button", "data-clear-project-filter": "", "aria-label": `Clear selected project filter ${state.project}`, title: "Clear selected project filter", onclick: clearProjectFilter }, `Clear ${state.project} project filter`)
      : null,
  ]));
  syncFilterClear();
  if (active && !$("summary").contains(active) && (focusedFilter || focusedClear || focusedProjectClear)) {
    const target = focusedProjectClear
      ? $("summary").querySelector("[data-clear-project-filter]")
      : focusedClear
        ? $("summary").querySelector("[data-clear-summary-filter]")
        : $("summary").querySelector(`[data-summary-filter="${focusedFilter}"]`);
    focusVisible(target, $("filter"));
  }
  const project = state.projects.find((p) => projectRef(p) === state.project);
  const top = project ? `${project.id} · ${project.title}` : state.project ? `${state.project} · project no longer available` : "all projects";
  // The groups that were zoomed into, one inside the other: the last is the one in view.
  const steps = state.into.map((id) => ({ id, title: state.byId.get(id)?.title ?? "" }));
  // With the top section folded away the filter and the zoom are out of sight, so the line that says what is
  // shown names them too.
  const filter = state.focus && state.filter.trim() ? `, matching "${state.filter.trim()}"` : "";
  const summary = state.summaryFilter ? `, showing ${state.summaryFilter === "trouble" ? "open bugs, issues and incidents" : "items with problems"}` : "";
  const zoom = state.focus && state.view === "board" && state.level ? `, ${state.level === 1 ? "top level only" : `${state.level} levels deep`}` : "";
  // Each step of the trail but the last leads back out to it. Of a long trail the last steps are shown, and of
  // the ones on the way only the ID, the project's too, so that the place the board is in is not pushed out of
  // the line. The line's full text, which is shown on request, names the same steps with their titles: a trail
  // is as long as the plan is deep, and a plan may be a thousand deep.
  const shown = steps.slice(-TRAIL_SHOWN);
  const where = [top, ...(steps.length > shown.length ? ["…"] : []), ...shown.map((step) => `${step.id} · ${step.title}`)].join(" › ") + filter + summary + zoom;
  // Each of them also says which group it names, for the keyboard: see keyboardPlace.
  const out = (count, text, title) => el("button", { class: "crumb", type: "button", "data-step": String(count), "data-group": steps[count - 1]?.id, title, onclick: () => zoomOut(count) }, text);
  $("scope").replaceChildren(
    ...present([
      el(
        "span",
        // The line can take the keyboard, though Tab passes it by: the keyboard goes there when a group was left
        // and nothing else stands for it.
        { class: `scope-text${steps.length ? " trail" : ""}`, title: where, tabindex: "-1" },
        "in ",
        steps.length ? out(0, project ? project.id : top, `Leave the groups and show ${project ? `${project.id} · ${project.title}` : "all projects"}`) : top,
        steps.length > shown.length && " › …",
        shown.map((step, at) => [
          " › ",
          at < shown.length - 1 ? out(steps.length - shown.length + at + 1, step.id, `Back out to ${step.id} · ${step.title}`) : `${step.id} · ${step.title}`,
        ]),
        filter,
        zoom,
      ),
    ]),
  );
  const leave = $("leave-group");
  leave.hidden = steps.length === 0 && !state.projectZoom;
  leave.dataset.group = steps.at(-1)?.id ?? "";
  leave.textContent = state.projectZoom && steps.length === 0 ? "↑ Leave project" : "↑ Leave group";
  leave.title = steps.length > 1 ? `Back out to ${steps.at(-2).id}` : state.projectZoom && steps.length === 0 ? "Return to all projects with this project selected" : "Show everything here again";
}

/** Keeps the existing clear-search control usable for both typed and summary-selected filters. */
function syncFilterClear() {
  const clear = $("clear-filter");
  const active = Boolean(state.filter || state.summaryFilter);
  const filters = [
    state.summaryFilter && `${state.summaryFilter === "trouble" ? "open bugs" : "with problems"} filter`,
    state.filter && "search",
  ].filter(Boolean);
  const label = filters.length ? `Clear ${filters.join(" and ")}` : "Clear search";
  clear.hidden = !active;
  clear.setAttribute("aria-label", label);
  clear.title = label;
}

function selectSummaryFilter(filter) {
  state.summaryFilter = state.summaryFilter === filter ? null : filter;
  render();
  focusVisible($("summary").querySelector(`[data-summary-filter="${filter}"]`), $("filter"));
}

function clearProjectFilter() {
  go(state.view, state.open, state.trail, { project: null, projectZoom: false });
  focusVisible(() => $("summary").querySelector("[data-clear-summary-filter]"), $("filter"));
}

/**
 * How many steps of the trail of groups the line above the board shows. The trail itself has no limit of its
 * own: each step holds the next, so it is never longer than the plan is deep, and what an address names that
 * does not hold together is cut when the plan is read.
 */
const TRAIL_SHOWN = 3;

const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * The address after the # names the view and, when one is open, the item: #board, #graph/VIG-041,
 * #board/project:VIG. So an item can be bookmarked, and the browser's Back returns to the one before it.
 * After a ? it says where the board is zoomed to: `in` names the groups that were zoomed into, one inside the
 * other and the last the one in view, and `zoom` how many levels are open; neither is there for the whole plan
 * with everything shown. #board?in=VIG-003/VIG-012&zoom=1 is the top level of VIG-012, reached through VIG-003.
 */
function readRoute(address = location.hash) {
  const [, view, item, asks] = /^#(board|graph)(?:\/([^?]*))?(?:\?(.*))?$/.exec(address) ?? [];
  // An address that was cut off or mistyped names no item, or no group: the view is shown without it.
  const decoded = (text) => {
    try {
      return decodeURIComponent(text);
    } catch {
      return "";
    }
  };
  const id = item ? decoded(item) : null;
  const asked = new Map(
    (asks ?? "").split("&").map((ask) => {
      const cut = ask.indexOf("=");
      return cut < 0 ? [ask, ""] : [ask.slice(0, cut), ask.slice(cut + 1)];
    }),
  );
  // A whole number of levels, from 1 up, written in digits alone: as many as a plan can be deep, so there is no
  // limit short of the numbers that can be counted with exactly. Anything else is no zoom.
  const levels = /^[1-9]\d*$/.test(asked.get("zoom") ?? "") ? Number(asked.get("zoom")) : NaN;
  const zoom = Number.isSafeInteger(levels) ? levels : null;
  const into = (asked.get("in") ?? "").split("/").map(decoded).filter(Boolean);
  const project = decoded(asked.get("project") ?? "") || null;
  const projectZoom = Boolean(project && asked.get("projectZoom") === "1");
  return { view: view ?? "board", open: !id ? null : id.startsWith("project:") ? { kind: "project", id: id.slice(8) } : { kind: "task", id }, zoom, into, project, projectZoom };
}

function routeOf(view, open, zoom = state.zoom, into = state.into, project = state.project, projectZoom = state.projectZoom) {
  const asks = [project && `project=${encodeURIComponent(project)}`, into.length > 0 && `in=${into.map(encodeURIComponent).join("/")}`, zoom !== null && `zoom=${zoom}`, projectZoom && "projectZoom=1"].filter(Boolean).join("&");
  return `#${view}${open ? `/${open.kind === "project" ? "project:" : ""}${encodeURIComponent(open.id)}` : ""}${asks ? `?${asks}` : ""}`;
}
/** A task ID as the service stores it, for comparing supported bookmark spellings without losing large digits. */
const taskIdentity = (id) => {
  const found = /^(?:([A-Z]{2,8})-)?(\d+)$/.exec(String(id).trim().replace(/^task:/i, "").toUpperCase());
  if (!found) return id;
  const digits = found[2].replace(/^0+(?=\d)/, "").padStart(3, "0");
  return found[1] ? `${found[1]}-${digits}` : digits;
};
const sameItem = (a, b) => Boolean(a && b && a.kind === b.kind && (a.kind === "task" ? taskIdentity(a.id) === taskIdentity(b.id) : a.id === b.id));
const sameTrail = (a, b) => a.length === b.length && a.every((id, at) => id === b[at]);

/**
 * Goes to an address as a new entry in the browser's history. The entry remembers the items the panel came
 * through. The zoom stays as it is unless another one is given.
 */
function go(view, open, trail = [], { zoom = state.zoom, into = state.into, project = state.project, projectZoom = state.projectZoom } = {}) {
  const route = routeOf(view, open, zoom, into, project, projectZoom);
  if (route === location.hash) return;
  history.pushState({ trail }, "", route);
  applyRoute();
}

/**
 * Locked out, the address names the view and nothing of the plan: the groups that were zoomed into and the item
 * that was open are IDs of the plan, and the address is there for anyone to read. Where the page was is not
 * lost for that. It is put away with the entry in the browser's history, which is where the address itself was
 * kept, together with the project that was selected: not in the document and not in the address. An entry that
 * has an address put away keeps that address, so that a page that is locked out twice, or loaded again while
 * locked out, still knows where it was; the project is the one the page was locked out with, when it knows it.
 */
function putRouteAway() {
  const route = readRoute();
  const bare = `#${route.view}`;
  const before = history.state?.kept;
  const prior = before?.route ? readRoute(before.route) : null;
  const onlyView = !route.open && !route.project && !route.projectZoom && !route.into.length && route.zoom === null;
  const keptRoute = before && prior && onlyView && route.view !== prior.view
    ? routeOf(route.view, prior.open, prior.zoom, prior.into, prior.project, prior.projectZoom)
    : before ? before.route : location.hash;
  const project = before && Object.hasOwn(before, "project") ? before.project : (route.project ?? prior?.project ?? null);
  const kept = { route: keptRoute, project };
  history.replaceState({ ...history.state, kept }, "", location.hash === "" || location.hash === bare ? undefined : bare);
}

/**
 * Puts the address of an entry back where it was put away, and says which project was put away with it, or
 * `undefined` when nothing was. Called when the service lets the page in, and for an entry that was gone to
 * while the page was locked out and is come back to afterwards.
 */
function takeRouteBack() {
  const { kept, ...rest } = history.state ?? {};
  if (!kept) return undefined;
  history.replaceState(rest, "", kept.route || undefined);
  return kept;
}

/**
 * Let in again, the page is where it was: the address says so again, and the page shows what it says, as a
 * reload of that address would, with the project that was selected. What is no longer in the plan is dropped by
 * the checks that follow every reading.
 */
function comeBack() {
  const kept = takeRouteBack();
  if (!kept) return;
  const route = readRoute();
  Object.assign(state, { view: route.view, open: route.open, zoom: route.zoom, into: route.into, group: route.into.at(-1) ?? null, trail: history.state?.trail ?? [], project: route.project ?? kept.project ?? null, projectZoom: route.projectZoom });
}

/** Shows what the address says: called when it changes, by this page or by Back and Forward. */
function applyRoute() {
  // Back and Forward lead to addresses that name groups and items too: locked out, they are put away as well.
  // An entry that was gone to then, and is come back to now that the page is let in, has its address again.
  if (locked) putRouteAway();
  else takeRouteBack();
  let route = readRoute();
  if (state.loadedAt && route.project && !state.projects.some((project) => projectRef(project) === route.project)) {
    history.replaceState(history.state, "", routeOf(route.view, route.open, route.zoom, route.into, null, false));
    route = readRoute();
  }
  const viewChanged = route.view !== state.view;
  const zoomChanged = route.zoom !== state.zoom || !sameTrail(route.into, state.into);
  const projectChanged = route.project !== state.project || route.projectZoom !== state.projectZoom;
  state.view = route.view;
  state.zoom = route.zoom;
  state.into = route.into;
  state.project = route.project;
  state.projectZoom = route.projectZoom;
  state.group = route.into.at(-1) ?? null;
  // The items the panel came through have titles: locked out, they stay with the entry and out of the page.
  state.trail = locked ? [] : (history.state?.trail ?? []);
  // The address may name a group that is not there: once the plan is known, it is put right.
  if (state.loadedAt && !locked) settleZoom();
  if (zoomChanged) boardMoved = true;
  if (viewChanged || zoomChanged || projectChanged) render();
  if ((zoomChanged || projectChanged) && state.loadedAt && !locked) sayZoom();
  if (!route.open) return hidePanel();
  const reopen = !sameItem(route.open, state.open) || $("panel").hidden;
  if (priorityWork && !sameItem(route.open, { kind: "task", id: priorityWork.id })) priorityWork.pending = 0;
  priorityWork = route.open.kind === "task" ? (priorityWorkers.get(taskIdentity(route.open.id)) ?? null) : null;
  state.open = route.open;
  if (reopen && state.loadedAt) renderDetail();
}

/**
 * Keeps of the trail of groups what the plan still has: each group must exist, and each one before the last must
 * still hold the next, at whatever depth. When the group in view is gone the board is in the one before it. The
 * address is put right in place, without a new entry in the browser's history. Says whether anything changed.
 */
function settleZoom() {
  // A group that is gone drops out of the trail. The group before it stays when it still holds the one after,
  // as it does through a group that was deleted and not for good.
  const into = state.into.filter((id) => state.byId.has(id));
  let from = into.length - 1;
  while (from > 0 && holds(into[from - 1], into[from])) from--;
  const kept = into.slice(Math.max(from, 0));
  if (sameTrail(kept, state.into)) return false;
  state.into = kept;
  state.group = kept.at(-1) ?? null;
  history.replaceState(history.state, "", routeOf(state.view, readRoute().open));
  return true;
}

/** The trail that leads to a group: one step on from where the board is when the group is in there, and else the group alone. */
function trailTo(id) {
  const at = state.into.indexOf(id);
  if (at >= 0) return state.into.slice(0, at + 1);
  return state.group && heldIn(state.group).has(id) ? [...state.into, id] : [id];
}

/**
 * Zooms into one group: the board, and the graph, then show only what it holds, with as many levels open as
 * before. It is a step in the browser's history, so Back zooms out again. The keyboard goes to what stands for
 * the group now, which is the way back out of it: the control that was used is gone with the cards.
 */
function zoomInto(id) {
  go(state.view, null, [], { into: trailTo(id) });
  keyboardTo(placeOf(id));
}

/**
 * Zooms back out to a step of the trail: 0 is out of every group. The keyboard goes to what stands for the group
 * that was left: on the board its card, and over the graph, which has no cards, the way out of the group it is
 * still in, or the line that says what is in view.
 */
function zoomOut(steps) {
  const left = state.into[steps];
  go(state.view, null, [], { into: state.into.slice(0, steps) });
  keyboardTo(placeOf(left, ".zoom-into"));
}

/** Leaves project zoom but keeps the project selected, returning to the existing toggle view. */
function leaveProjectZoom() {
  go(state.view, null, [], { project: state.project, projectZoom: false, zoom: null, into: [] });
}

/** The timer that empties what was said of a zoom, so that it is not found on the page later, when it no longer holds. */
let said = null;

/**
 * Says a zoom to a screen reader, once and in a few words: how far the board is zoomed, where it is, and how much
 * that comes to. Nothing else says it. The cards, the counts and the trail are in no live region, so a board that
 * is drawn again is not read out card by card; and the level between the zoom's two buttons is read with each
 * button, not whenever it changes.
 */
function sayZoom() {
  const group = state.group ? state.byId.get(state.group) : null;
  const project = state.projects.find((p) => projectRef(p) === state.project);
  const named = group ?? project;
  const where = named ? `${named.id} ${named.title.length > 60 ? `${named.title.slice(0, 59)}…` : named.title}` : "all projects";
  const counts = $("summary").firstElementChild?.textContent ?? "";
  $("zoom-said").textContent = `${state.view === "board" ? `${levelName(state.level)} in` : "Graph of"} ${where}: ${counts}.`;
  clearTimeout(said);
  said = setTimeout(() => ($("zoom-said").textContent = ""), 5000);
}

/** Opens one level more or one fewer, when there is one. */
function stepLevel(by) {
  const { deepest = 0, level = null } = state;
  const to = (level ?? deepest) + by;
  if (deepest < 2 || to < 1 || to > deepest) return;
  go(state.view, null, [], { zoom: to >= deepest ? null : to });
}
$("level-out").addEventListener("click", () => stepLevel(-1));
$("level-in").addEventListener("click", () => stepLevel(1));
$("leave-group").addEventListener("click", () => state.projectZoom && state.into.length === 0 ? leaveProjectZoom() : zoomOut(Math.max(0, state.into.length - 1)));

/** Opens an item in the panel. Opened from inside the panel, it remembers the item it came from. */
/** Finds the control the panel was opened from, as it is now, so that the keyboard can go back to it. */
let panelOpener = null;
/** The credential that read the panel currently drawn. */
let panelCredential = null;

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

/**
 * Where one of an item's lists stands in what `get` returns, and what says that it goes on: a list of links by
 * its name, the timeline, the history. The service returns at most a page of each.
 */
const listAt = (where) => (where.startsWith("links:") ? ["links", where.slice(6)] : [where]);
function goesOn(item, where) {
  const [field, name] = listAt(where);
  const more = item.more ?? {};
  if (name === undefined) return Object.hasOwn(more, field) ? more[field] : undefined;
  return more.links && Object.hasOwn(more.links, name) ? more.links[name] : undefined;
}

/**
 * Reads the next page of one of an item's lists and joins it to the item as it was read. Links go on after the
 * ones that are there; of the timeline and the history the service returns the latest entries first, so the
 * next page holds the ones before. `had` says how many pages beyond the first the item holds of the list.
 * Returns what the page says of the state it was read of (`unchanged_since`: since when neither the item nor
 * any of its lists has changed), or null when the list does not go on.
 *
 * The list is read by the steps that hold for whoever reads one, which are the service's own, in
 * `/shared/paging.js`: the token is sent only when it is the token of this list of this item, and the page is
 * joined only when it is a page of that list whose entries are all further on in the list than the place it
 * was asked from, so that none was there before, and which goes on, if it does, with a token of the same list
 * that names the place of its furthest entry. A list is read for a thousand pages at most. What is
 * not so is said, as an answer that is not the service's, and is never taken for the end of the list. A page
 * of another state of the item is not looked at further: its caller reads the item again.
 */
async function readOn(item, where, had) {
  const part = goesOn(item, where);
  if (!part) return null;
  const [field, name] = listAt(where);
  const shown = name === undefined ? (item[field] ?? []) : Object.hasOwn(item.links, name) ? item.links[name] : [];
  const list = describeItemList({ kind: item.kind, id: item.id }, name === undefined ? [field] : ["links", name]);
  let page;
  let read;
  let on;
  try {
    // How far the reading has come, as the item in hand has it. The first page is taken here, by the same
    // steps as any; the pages after it were taken when they were read.
    let progress = begun();
    if (had === 0) takePage(list, progress, shown, part.continuation);
    else progress = resume(list, had + 1, shown, part.continuation);
    page = await api("get", { kind: item.kind, id: item.id, continuation: progress.sent });
    read = name === undefined ? page?.[field] : page?.links && Object.hasOwn(page.links, name) ? page.links[name] : undefined;
    const rest = page?.more ?? {};
    on = name === undefined ? rest[field] : rest.links && Object.hasOwn(rest.links, name) ? rest.links[name] : undefined;
    if (page?.kind !== item.kind || page?.id !== item.id || typeof page.unchanged_since !== "number") throw new NotAList("it is no page of a list of that item");
    // Read of another state of the item, the page is not joined to this one: the item is read again.
    if (page.unchanged_since !== item.unchanged_since) return page.unchanged_since;
    // A continuation answer is one page of one list. Metadata for another list must not make this one look
    // finished, nor be ignored beside its own metadata.
    const moreObject = rest && typeof rest === "object" && !Array.isArray(rest);
    const moreFields = moreObject ? Object.keys(rest) : [];
    const rightMore =
      page.more === undefined ||
      (moreObject &&
        (name === undefined
          ? moreFields.length === 1 && moreFields[0] === field
          : moreFields.length === 1 && moreFields[0] === "links" && rest.links && typeof rest.links === "object" && !Array.isArray(rest.links) && Object.keys(rest.links).length === 1 && Object.hasOwn(rest.links, name)));
    if (!rightMore) throw new NotAList("it names another list among those that go on");
    takePage(list, progress, read, on === undefined ? ENDS : on?.continuation);
  } catch (error) {
    throw error instanceof NotAList ? notAsVigile(`for a list of ${item.id}`, error.why) : error;
  }
  if (name === undefined) {
    item[field] = [...read, ...(item[field] ?? [])];
    if (on) item.more[field] = on;
    else delete item.more[field];
    return page.unchanged_since;
  }
  item.links[name] = [...(Object.hasOwn(item.links, name) ? item.links[name] : []), ...read];
  if (on) item.more.links[name] = on;
  else delete item.more.links[name];
  return page.unchanged_since;
}

/**
 * Reads on in the lists of an item until it holds as many pages of each as the person has opened. `have` says
 * how many pages of each list the item holds, and is kept up as they are read. The pages that are wanted are
 * looked up again before each one: a page that is asked for while this reads is read here too. A list that
 * turns out to end sooner is wanted no further than it goes.
 *
 * Says whether the item and its pages are of one state of the item. Every answer of the service says since
 * when the item and its lists are unchanged: a page that says something else than the item in hand was read
 * after a link came or went, or the item changed, and what it counts and holds does not fit what was read
 * before. The item's version does not tell: a task taken out of a group changes the group's list and not the
 * group. At the first such page the reading stops, since nothing more is to be joined to the two. A reading
 * that is not `live` any more stops as well, and its caller drops it.
 */
async function catchUp(item, have, live) {
  while (live()) {
    const { pages } = state.further;
    const [where] = [...pages].find(([list, wanted]) => (have.get(list) ?? 0) < wanted) ?? [];
    if (where === undefined) break;
    const had = have.get(where) ?? 0;
    const since = await readOn(item, where, had);
    if (!live()) break;
    if (since === null) {
      if (had) state.further.pages.set(where, had);
      else state.further.pages.delete(where);
      continue;
    }
    if (since !== item.unchanged_since) return false;
    have.set(where, had + 1);
  }
  return true;
}

/** The button that reads on in a list that the panel shows a part of. */
const further = (where, text) => el("button", { class: "further", type: "button", "data-list": where, onclick: () => renderDetail(where) }, text);

/**
 * The readings of the open item, counted. Each one takes the next number, and only the one with the latest
 * number draws: an answer that was asked for earlier is never drawn over one that was asked for later.
 */
let detailTurn = 0;
/** The number of the reading that is under way, or 0 when none is. */
let detailReading = 0;

/**
 * How often an item is read from the start for one drawing, when it turns out to have changed between its
 * reading and that of one of its pages. An item that someone changes every second would otherwise be read
 * without end.
 */
const DETAIL_TRIES = 3;

/**
 * Says something about the reading of the item under what the panel shows of it, with a button that reads the
 * item again. It stays in sight wherever the panel is scrolled to. Said again, it leaves the keyboard on its button.
 */
function sayInPanel(text) {
  state.troubled = true;
  const had = $("detail").querySelector(".not-read");
  const note = el("div", { class: "not-read", role: "alert" }, el("p", {}, text), el("button", { class: "retry", type: "button", onclick: () => renderDetail() }, "Try again"));
  const onButton = had?.contains(document.activeElement);
  had?.remove();
  $("detail").append(note);
  if (onButton) note.querySelector(".retry").focus({ preventScroll: true });
}

/**
 * Says in the panel that the item could not be read, with a button that reads it again. What the panel shows of
 * the item stays as it was read, with the pages that were opened: only an item that is not there any more, or
 * one of which nothing was read yet, leaves the panel with nothing but the message. The next reading that
 * succeeds takes the message away, whoever asked for it: this button, the refresh button, or a change.
 */
function showTrouble(asked, error) {
  state.troubled = true;
  const kept = state.item && sameItem(asked, state.shown) && !$("panel").hidden && error.code !== "not_found";
  if (kept) {
    const what = error.status ? `The service answered with an error: ${error.message}` : "Cannot reach the service.";
    return sayInPanel(`${what} This is the item as it was read before.`);
  }
  state.shown = null;
  state.drawn = null;
  state.item = null;
  state.have = null;
  // What the service says is said in its words; that it said nothing, in the page's.
  $("detail").replaceChildren(el("p", { class: "empty" }, error.status ? error.message : "Cannot reach the service."), el("button", { class: "retry", type: "button", onclick: () => renderDetail() }, "Try again"));
  $("panel").hidden = false;
  // The panel is a dialog also when all it has to say is that the item cannot be shown: the keyboard goes into
  // it, unless it is in it already, on the control that closes it for instance.
  if (!$("panel").contains(document.activeElement)) $("panel").querySelector(".panel-card").focus({ preventScroll: true });
}

/** Takes the message about a failed reading away, once a reading has succeeded. */
function clearTrouble() {
  state.troubled = false;
  const note = $("detail").querySelector(".not-read");
  if (!note) return;
  // The keyboard does not go with the button it was on: it stays in the panel.
  const inside = note.contains(document.activeElement);
  note.remove();
  if (inside) $("panel").querySelector(".panel-card").focus({ preventScroll: true });
}

/** Says how a queued priority change is going, where its panel is still the one in sight. */
function showPriorityWork(work) {
  if (!priorityWork || priorityWork !== work || !sameItem(state.open, { kind: "task", id: work.id })) return;
  const control = $("detail").querySelector(`.priority-control[data-id="${CSS.escape(work.id)}"]`);
  if (!control) return;
  control.setAttribute("aria-busy", String(work.running));
  const moveFocus = Boolean((work.blocked || work.deleted) && control.querySelector("button:focus"));
  for (const button of control.querySelectorAll("button")) button.disabled = Boolean(work.blocked || work.deleted);
  if (moveFocus) $("panel").querySelector(".panel-card").focus({ preventScroll: true });
  const shown = work.target + work.pending;
  control.querySelector("output").value = String(shown);
  control.querySelector("#priority-down").setAttribute("aria-label", `Lower priority from ${shown} to ${shown - 1}`);
  control.querySelector("#priority-up").setAttribute("aria-label", `Raise priority from ${shown} to ${shown + 1}`);
  control.querySelector(".priority-result").textContent = work.message || (work.pending ? `${Math.abs(work.pending)} ${Math.abs(work.pending) === 1 ? "step" : "steps"} waiting` : work.running ? "Changing priority…" : "");
}

/** Remembers the newest task a successful list or panel read confirmed, without rebasing a write already queued. */
function observePriority(work, latest) {
  if (!latest || typeof latest.version !== "number" || typeof latest.priority !== "number" || latest.version < work.observedVersion) return;
  Object.assign(work, { observedVersion: latest.version, observedPriority: latest.priority });
}

/** Uses the newest confirmed reading only once no queued write still belongs to the earlier returned version. */
function reconcilePriority(work) {
  if (work.blocked) return;
  if (work.pending || work.observedVersion < work.version) return;
  Object.assign(work, { version: work.observedVersion, priority: work.observedPriority, target: work.observedPriority });
}

/** Refreshes the plan and then confirms this task itself, rather than treating a successful list read as enough. */
async function rereadPriority(work) {
  await load();
  if (work.session !== sessions || locked || !sameItem(state.open, { kind: "task", id: work.id })) return false;
  const read = await renderDetail();
  if (!read || state.item?.id !== work.id) return false;
  observePriority(work, state.item);
  work.blocked = false;
  return true;
}

/**
 * Raises or lowers priority through update_task, with the version the panel read. Clicks made while one request
 * is on its way are combined into the next request: none is lost and no two writes race one another. A conflict
 * is shown and reread, never silently applied to the item someone else changed.
 */
function nudgePriority(item, amount, credential) {
  if (item.deleted_at) return;
  // The control belongs to the credential that read the panel. Replacing a valid key gives no 401, so detect it
  // here as well as before every write and never reinterpret an old click as the new identity's choice.
  if ((localStorage.getItem(KEY_NAME) ?? "") !== credential) {
    if (priorityWork) priorityWork.pending = 0;
    void load(true);
    return;
  }
  let work = priorityWorkers.get(item.id);
  if (work && work.credential !== credential) {
    if (work.running) return;
    priorityWorkers.delete(item.id);
    work = null;
  }
  if (!work) {
    work = {
      id: item.id,
      version: item.version,
      priority: item.priority,
      observedVersion: item.version,
      observedPriority: item.priority,
      target: item.priority,
      pending: 0,
      running: false,
      message: null,
      blocked: false,
      deleted: Boolean(item.deleted_at),
      session: sessions,
      credential,
    };
    priorityWorkers.set(item.id, work);
  }
  priorityWork = work;
  work.pending += amount;
  work.message = null;
  showPriorityWork(work);
  if (!work.running) queueMicrotask(() => runPriorityWork(work));
}

async function runPriorityWork(work) {
  if (work.running) return;
  work.running = true;
  try {
    while (work.pending) {
      // Another request may have locked the page while these clicks waited. Never send them with the key that is
      // stored now (possibly no key, which could act as a different keyless user).
      if (work.session !== sessions || locked || (localStorage.getItem(KEY_NAME) ?? "") !== work.credential) {
        work.pending = 0;
        return;
      }
      const amount = work.pending;
      work.pending = 0;
      if (!amount) continue;
      work.target = work.priority + amount;
      work.message = "Changing priority…";
      showPriorityWork(work);
      try {
        const changed = await api("update-task", { id: work.id, version: work.version, priority: work.target }, work.credential);
        // A key refused elsewhere while this answer was on its way emptied the page: the old request writes
        // nothing back into it. The stored change is seen on the first successful load under the new session.
        if (work.session !== sessions || locked) return;
        work.version = changed.version;
        work.priority = changed.priority;
        observePriority(work, changed);
        work.target = changed.priority;
        work.message = `Priority is now ${changed.priority}.`;
        work.blocked = false;
        work.deleted = false;
        await load();
        if (work.session !== sessions || locked) return;
        // A click already waiting belongs after this returned version. Do not silently adopt a later concurrent
        // version: its next write must conflict. Once the queue is empty, the newest panel/list reading wins.
        if (!work.pending) reconcilePriority(work);
        work.message = `Priority is now ${work.priority}.`;
      } catch (error) {
        work.pending = 0;
        if (error.status === 401) {
          if (priorityWork === work) priorityWork = null;
          return void load();
        }
        if (error.code === "version_conflict") {
          work.blocked = true;
          work.target = work.priority;
          work.message = "Priority changed elsewhere. The latest value is shown; choose again if needed.";
          const read = await rereadPriority(work);
          // Clicks made while recovery was reading are choices against neither the old nor the new version.
          work.pending = 0;
          if (work.session !== sessions || locked) return;
          if (read) {
            reconcilePriority(work);
            work.message = "Priority changed elsewhere. The latest value is shown; choose again if needed.";
          } else {
            work.target = work.priority;
            work.message = "Priority changed elsewhere, but the latest value could not be read. Refresh before choosing again.";
          }
        } else if (error.status >= 400 && error.status < 500) {
          work.blocked = false;
          // A refusal is a confirmed non-change.
          work.target = work.priority;
          work.message = `Priority was not changed: ${error.message}`;
          // Deletion after the panel was read is also a confirmed reason that no later click can work. Read the
          // task itself, which lists no longer include, so the controls are redrawn disabled without auto-refresh.
          if (error.code === "rule_violation" && error.body?.rule === "deleted") {
            const refused = work.message;
            work.deleted = true;
            state.drawn = null;
            await renderDetail();
            work.pending = 0;
            reconcilePriority(work);
            work.message = refused;
          }
        } else {
          work.blocked = true;
          // No answer is an unknown outcome: ask for the plan again before saying what priority is in place.
          work.target = work.priority;
          work.message = "The priority change was not confirmed. Reading the task again…";
          const read = await rereadPriority(work);
          work.pending = 0;
          if (work.session !== sessions || locked) return;
          if (read) {
            reconcilePriority(work);
            work.message = `The change did not answer. The current priority is ${work.priority}; choose again if needed.`;
          } else work.message = "The priority change was not confirmed. Refresh before choosing again.";
        }
        break;
      }
    }
  } finally {
    work.running = false;
    const sameCredential = (localStorage.getItem(KEY_NAME) ?? "") === work.credential;
    if (!work.pending && work.session === sessions && !locked && sameCredential) reconcilePriority(work);
    showPriorityWork(work);
    if (!work.pending && priorityWork !== work && priorityWorkers.get(work.id) === work) priorityWorkers.delete(work.id);
    if (!sameCredential && sameItem(state.open, { kind: "task", id: work.id }) && !locked) {
      // The replacement-key load may have drawn disabled controls while this old worker still existed, and an
      // unchanged list snapshot does not normally redraw the panel. Force the panel's own authenticated read.
      state.drawn = null;
      void renderDetail();
    }
  }
}

/** The compact write control beside Priority in a task's facts. */
function priorityControl(item, credential) {
  const worker = priorityWorkers.get(item.id);
  const work = priorityWork?.id === item.id && priorityWork.credential === credential ? priorityWork : null;
  if (work) {
    observePriority(work, item);
    work.deleted = Boolean(item.deleted_at);
    // A refresh from elsewhere supersedes a finished local change. A request still on its way keeps the version
    // it was sent with and will be refused rather than moved silently onto the newer item.
    if (!work.running && !work.pending) Object.assign(work, { version: item.version, priority: item.priority, target: item.priority, message: null, blocked: false });
  }
  const shown = work ? work.target + work.pending : item.priority;
  const disabled = Boolean(item.deleted_at || work?.blocked || (worker?.running && worker.credential !== credential));
  return el(
    "span",
    { class: "priority-control", "data-id": item.id, "aria-busy": String(Boolean(work?.running)) },
    el("button", { id: "priority-down", type: "button", disabled, "aria-label": `Lower priority from ${shown} to ${shown - 1}`, title: "Lower priority", onclick: () => nudgePriority(item, -1, credential) }, "−"),
    el("output", { for: "priority-down priority-up", "aria-label": "Priority" }, String(shown)),
    el("button", { id: "priority-up", type: "button", disabled, "aria-label": `Raise priority from ${shown} to ${shown + 1}`, title: "Raise priority", onclick: () => nudgePriority(item, 1, credential) }, "+"),
    el("span", { class: "priority-result", role: "status", "aria-live": "polite" }, work?.message ?? ""),
  );
}


/**
 * Shows the open item in the panel: the item as it is now, with as many pages of each list as the person has
 * opened. Asked with one of its lists, by the button under a list that is not shown whole, it opens one page
 * more of that list.
 *
 * What can happen while it reads, and what the panel shows then:
 * - Another reading is asked for (a change, the refresh button, "Try again", the item opened anew): the later
 *   one draws, with every page that was opened, and the earlier one is dropped when its answer comes.
 * - One more page is asked for, of the same list or of another: the reading that is under way reads it too,
 *   and draws once, with all of them.
 * - The panel is closed, another item is opened, the key is refused: the answer is dropped.
 * - The item or one of its lists has changed since the panel read it, which the page of a list says, or the
 *   token of a list is not taken any more: the item is read again from the start, with the pages that were opened.
 * - The item changes between its reading and that of one of its pages: it is read from the start again, a few
 *   times. What is drawn is an item and pages of one state of it, whichever way the reading went. An item that
 *   goes on changing is drawn as it was read last, by itself, and the panel says that its further pages are
 *   not shown and offers to try again.
 * - The reading fails: the panel says so and offers to try again, and keeps what it shows.
 */
const copyNotices = new WeakMap();

/** Copies during the button's activation where the async Clipboard API is unavailable or refused. */
function copyTextFallback(control, text) {
  const before = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, at) => selection.getRangeAt(at).cloneRange()) : [];
  const direction = selection?.anchorNode && selection.focusNode ? { anchorNode: selection.anchorNode, anchorOffset: selection.anchorOffset, focusNode: selection.focusNode, focusOffset: selection.focusOffset } : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.setAttribute("aria-hidden", "true");
  area.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0";
  document.body.append(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    area.remove();
    if (before instanceof HTMLElement) before.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
      // Adding a Range always makes it forward. Restore anchor and focus as well so a backward selection keeps
      // the endpoint that Shift+Arrow will extend from after copying.
      if (direction && ranges.length === 1 && selection.setBaseAndExtent) {
        try {
          selection.setBaseAndExtent(direction.anchorNode, direction.anchorOffset, direction.focusNode, direction.focusOffset);
        } catch {
          // The selected nodes left the page meanwhile; the cloned range restoration above is the best left.
        }
      }
    }
  }
  return copied;
}

/** Copies an item's exact ID and says what happened without closing or redrawing its panel. */
async function copyText(control, text) {
  const feedback = control.querySelector(".copy-feedback");
  let message = "Copied";
  try {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
      } catch (error) {
        if (!copyTextFallback(control, text)) throw error;
      }
    } else if (!copyTextFallback(control, text)) throw new Error("Clipboard access is unavailable");
    control.classList.remove("copy-failed");
  } catch {
    message = "Copy failed";
    control.classList.add("copy-failed");
  }
  feedback.textContent = message;
  clearTimeout(copyNotices.get(control));
  copyNotices.set(
    control,
    setTimeout(() => {
      if (feedback.isConnected) feedback.textContent = "";
      control.classList.remove("copy-failed");
    }, 2_000),
  );
}

async function renderDetail(more) {
  // Locked out, the page asks the service for nothing: the item named in the address opens once it is let in.
  if (!state.open || locked) return false;
  const asked = state.open;
  // How many pages beyond the first the person opened, by list: for this item only.
  if (!sameItem(asked, state.further?.of)) state.further = { of: asked, pages: new Map() };
  if (more) {
    // Only what the panel shows has a list to read on in.
    if (!state.item || !sameItem(asked, state.shown) || $("panel").hidden) return false;
    state.further.pages.set(more, (state.further.pages.get(more) ?? 0) + 1);
    // A reading that is under way reads this page as well, before it draws.
    if (detailReading) return false;
  }
  const turn = ++detailTurn;
  const session = sessions;
  const credential = localStorage.getItem(KEY_NAME) ?? "";
  // Whether this reading is still the one to draw: no later one was begun, the page was not locked out, and the
  // panel is still open on the item.
  const live = () => turn === detailTurn && session === sessions && !locked && sameItem(asked, state.open);
  detailReading = turn;
  let item;
  let have;
  // Whether the item went on changing while it was read, so that it is shown without its further pages.
  let changing = false;
  try {
    // One page more is joined to what the panel shows, which is not read again, unless the item has moved on
    // since or the service does not take the token: then it is read from the start like any other time.
    let whole = !more;
    if (more) {
      item = structuredClone(state.item);
      have = new Map(state.have);
      try {
        whole = !(await catchUp(item, have, live));
      } catch (error) {
        if (error.status !== 400 && error.status !== 404) throw error;
        whole = true;
      }
      if (!live()) return;
    }
    // Read from the start, the item and its pages are of one state of it or are not drawn together: a page that
    // was read after something changed sends the reading back to the start, with the pages that were opened
    // still wanted. After a few tries the item is read once more and shown by itself.
    for (let tries = 1; whole; tries++) {
      item = await api("get", { kind: asked.kind, id: asked.id, history: true }, credential);
      have = new Map();
      if (!live()) return;
      changing = tries > DETAIL_TRIES;
      if (changing) break;
      try {
        if (await catchUp(item, have, live)) break;
      } catch (error) {
        // A marked boundary entry may have disappeared after the first page was read. The initial `get` above is
        // deliberately outside this catch: only a rejected continuation restarts the bounded whole-item read.
        if (error.status !== 400 && error.status !== 404) throw error;
      }
      if (!live()) return;
    }
    if (!live()) return;
  } catch (error) {
    // A refused key is for the page as a whole to deal with: it empties itself and asks for one. Should it be
    // let in again without that, the panel is read again with the plan.
    if (error.status === 401) {
      state.troubled = true;
      return void load();
    }
    if (live()) showTrouble(asked, error);
    return false;
  } finally {
    if (detailReading === turn) detailReading = 0;
  }
  // What the panel says of a reading stands under the item, whether the item is drawn again or not: that it
  // could not be read is taken away by this reading, and that it is changing is said by it.
  const said = () => changing && sayInPanel("The item is being changed while it is read. This is the item as it was read last; the further pages of its lists are not shown.");
  if (!changing) clearTrouble();
  if ((localStorage.getItem(KEY_NAME) ?? "") !== credential) return void load(true);
  let worker = priorityWorkers.get(item.id);
  if (worker && worker.credential !== credential && !worker.running) {
    priorityWorkers.delete(item.id);
    worker = null;
  }
  priorityWork = worker?.credential === credential ? worker : null;
  // The same item drawn again, after a refresh, keeps its place: how far it was scrolled and whether its history was unfolded.
  const again = sameItem(asked, state.shown) && !$("panel").hidden;
  // And when nothing the panel shows has changed, it is not drawn again at all: a change to some other task must
  // not take away what someone has selected in it, nor where they are in it with the keyboard.
  // Since when the item is unchanged is nothing the panel shows: after the service has read the plan anew it
  // says another revision of an item that is as it was.
  const drawing = JSON.stringify([{ ...item, unchanged_since: null }, state.trail.at(-1) ?? null, watched.has(item.id)]);
  // What was read is what the next page is joined to, whether it is drawn again or looks the same.
  const recoveringPriority = Boolean(worker?.blocked && !worker.running && !worker.pending);
  const same = again && drawing === state.drawn && credential === panelCredential && !recoveringPriority;
  state.item = item;
  state.have = have;
  if (same) {
    said();
    return true;
  }
  state.drawn = drawing;
  panelCredential = credential;
  const place = again ? placeInPanel() : null;
  const historyOpen = again && Boolean($("detail").querySelector(".fold-block")?.open);
  state.shown = asked;
  state.openTitle = item.title ?? item.username ?? "";
  document.title = [item.id, state.openTitle, state.instance?.name, "Vigile"].filter(Boolean).join(" · ");
  // A list the service returned a part of says so: how many of how many, and a button that reads on.
  const timelineOn = goesOn(item, "timeline");
  const historyOn = goesOn(item, "history");
  const links = Object.entries(item.links ?? {})
    .filter(([, items]) => items.length)
    .map(([relation, items]) => {
      const on = goesOn(item, `links:${relation}`);
      return el(
        "div",
        { class: "relation", "data-relation": relation },
        el("h4", { title: `Link type: ${relation}` }, RELATIONS[relation] ?? relation, el("span", { class: "count" }, on ? `${items.length} of ${on.total}` : String(items.length))),
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
        on && further(`links:${relation}`, "Show more"),
      );
    });
  const facts = [
    item.kind === "task" && ["Type", item.type],
    item.kind === "task" && item.progress && ["Progress", `${item.progress.finished} of ${item.progress.total} tasks inside finished`],
    item.kind === "task" && ["Priority", priorityControl(item, credential)],
    item.kind === "task" && item.value !== null && ["Value", String(item.value)],
    item.kind === "task" && item.size !== null && ["Size", String(item.size)],
    item.kind === "task" && ["Assigned to", item.assigned_to.length ? `${item.assigned_to.join(", ")}${item.more?.assigned_to ? ` and ${item.more.assigned_to.total - item.assigned_to.length} more` : ""}` : "nobody"],
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
          el(
            "button",
            { class: "id copy-id", type: "button", "aria-label": `Copy ID ${item.id}`, title: `Copy ${item.id} to the clipboard`, onclick: (event) => copyText(event.currentTarget, item.id) },
            item.id,
            el("span", { class: "copy-glyph", "aria-hidden": "true" }),
            el("span", { class: "copy-feedback", role: "status", "aria-live": "polite" }),
          ),
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
        item.kind === "task" && item.progress && state.byId.has(item.id) && el(
          "button",
          { class: "open-group", type: "button", onclick: () => zoomInto(item.id) },
          `Show only this group (${item.progress.total} ${item.progress.total === 1 ? "task" : "tasks"})`,
        ),
      ),
      item.description !== undefined &&
        block(
          "Description",
          el(
            "div",
            { class: "description-copy" },
            el("p", { class: `description${item.description ? "" : " none"}` }, item.description || "No description."),
            item.description &&
              el(
                "button",
                { class: "copy-description", type: "button", "aria-label": "Copy description", title: "Copy description to the clipboard", onclick: (event) => copyText(event.currentTarget, item.description) },
                el("span", { class: "copy-glyph", "aria-hidden": "true" }),
                el("span", { class: "copy-feedback", role: "status", "aria-live": "polite" }),
              ),
          ),
        ),
      item.why && el("section", { class: "block why" }, el("h3", {}, "Why"), el("p", { class: "description" }, item.why)),
      links.length ? block("Links", links) : null,
      block("Details", el("dl", { class: "facts" }, facts.flatMap(([name, value]) => [el("dt", {}, name), el("dd", {}, value)]))),
      item.timeline?.length &&
        block(
          "Status timeline",
          timelineOn && el("p", { class: "partial" }, `The latest ${item.timeline.length} of ${timelineOn.total}.`),
          timelineOn && further("timeline", "Show earlier ones"),
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
          el("summary", {}, el("h3", {}, "History"), el("span", { class: "count" }, `${historyOn?.total ?? item.history.length} ${(historyOn?.total ?? item.history.length) === 1 ? "change" : "changes"}`)),
          historyOn && el("p", { class: "partial" }, `The latest ${item.history.length} of ${historyOn.total}.`),
          historyOn && further("history", "Show earlier ones"),
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
  said();
  $("panel").hidden = false;
  const card = $("panel").querySelector(".panel-card");
  if (!again) card.scrollTop = 0;
  // The panel is a dialog: the keyboard goes into it when it opens and when it shows another item. Drawn again
  // for the same item, the control that had the keyboard has it back.
  if (!again) focusVisible(card);
  else if (place) focusVisible(place, card);
  return true;
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
    control.matches(".copy-id") ? "copy-id" : control.matches(".copy-description") ? "copy-description" : control.matches("summary") ? "summary" : control.matches(".further") ? `further ${control.dataset.list}` : control.matches(".link") ? `link ${control.closest(".relation")?.dataset.relation} ${control.querySelector(".id")?.textContent}` : control.className || control.textContent;
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
  const item = state.open;
  if (priorityWork) priorityWork.pending = 0;
  priorityWork = null;
  panelCredential = null;
  state.open = null;
  // The keyboard goes back to what the panel was opened from, when it was in the panel or lost with it.
  const inside = !$("panel").hidden && ($("panel").contains(document.activeElement) || document.activeElement === document.body);
  $("panel").hidden = true;
  state.drawn = null;
  state.item = null;
  state.have = null;
  state.further = null;
  state.troubled = false;
  // On what it was opened from, as that is now; failing that on what stands for the task that was open; failing
  // that where the keyboard always can go.
  if (inside)
    focusVisible(
      () => restoredControl(panelOpener),
      () => (item?.kind === "task" ? (state.view === "board" ? reachable(stripFor(item.id)) ?? standsFor(item.id, ".card") : representative(item.id)) : null),
      ...keyboardFallbacks(),
    );
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
  const scope = JSON.stringify([state.project, state.group, state.filter.trim().toLowerCase(), state.summaryFilter, state.hideFinished, state.collapsed]);
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
  const had = document.activeElement;
  $("graph-draw").hidden = !button;
  $("graph-status").hidden = !text;
  // The line goes when it has nothing more to say, and the keyboard may be on it since its button was pressed.
  keepKeyboard(had, $("graph-status"), $("zoom-fit"));
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
  focusVisible($("graph-status"));
  render();
});

/** The card of a task on the board, or the button beside it that zooms into the group, when the board has one. */
const controlOf = (id, kind = ".card") => [...$("board").querySelectorAll(kind)].find((control) => control.dataset.id === id) ?? null;

/**
 * A place for the keyboard that is not a control but a task: wherever that task shows now. `kind` says which of
 * its two controls is wanted first, its card or the button that zooms into it.
 */
const placeOf = (id, kind = ".card") => Object.assign(() => null, { ofBoard: true, item: id, kind });

/**
 * Which control has the keyboard, told in a way that outlives the drawing: a card by its task, and so the button
 * that zooms into a group; a project by its ID; a column's "show all" by its column; a step of the trail by how
 * far out it leads. Drawing the board again replaces these, and whoever was on one with the keyboard must still
 * be on it afterwards. A control of the board, of the line above it, of its zoom or of the graph's tools can also
 * go out of sight or be gone for good, when the board is zoomed, a group is left or the view changes: its place
 * is marked `ofBoard`, and names the task it stands for when it has one, so that `whereNow` can find what
 * stands for it afterwards.
 */
function keyboardPlace() {
  const at = document.activeElement;
  if (!at?.closest) return null;
  const ofBoard = (find, about = {}) => Object.assign(find, { ofBoard: true, ...about });
  if (at.matches("#board .card, #board .zoom-into")) {
    const id = at.dataset.id;
    const kind = at.matches(".card") ? ".card" : ".zoom-into";
    return ofBoard(() => controlOf(id, kind), { item: id, kind });
  }
  // The line above the board is written again with it. The way out of a group stands for that group, and a step
  // of the trail, which is known by how far out it leads, for the group it names. Which group that is, is read
  // from the control itself: by now the page may be somewhere else already.
  if (at.matches("#leave-group")) {
    const group = at.dataset.group;
    if (!group && state.project) {
      const selectedProject = state.projects.find((project) => projectRef(project) === state.project)?.id;
      return ofBoard(() => [...$("projects").querySelectorAll(".project, .project-chip-wrap")]
        .find((item) => item.querySelector(".project-id")?.textContent === selectedProject)
        ?.querySelector(".project-main, .project-chip"));
    }
    return ofBoard(() => ($("leave-group").dataset.group === group ? $("leave-group") : null), { item: group ?? null, kind: ".zoom-into" });
  }
  if (at.matches("#scope .crumb")) {
    const group = at.dataset.group;
    return ofBoard(() => [...$("scope").querySelectorAll(".crumb")].find((crumb) => crumb.dataset.group === group), { item: group ?? null, kind: ".zoom-into" });
  }
  if (at.matches("#scope .scope-text")) return ofBoard(() => $("scope").querySelector(".scope-text"));
  if (at.matches("#board .more")) {
    const key = at.closest(".column").dataset.key;
    return ofBoard(() => [...$("board").querySelectorAll(".column")].find((column) => column.dataset.key === key)?.querySelector(".more"));
  }
  if (at.matches("#summary [data-summary-filter]")) {
    const filter = at.dataset.summaryFilter;
    return () => $("summary").querySelector(`[data-summary-filter="${filter}"]`);
  }
  if (at.matches("#summary [data-clear-summary-filter]")) return () => $("summary").querySelector("[data-clear-summary-filter]");
  if (at.matches("#summary [data-clear-project-filter]")) return () => $("summary").querySelector("[data-clear-project-filter]");
  // The board's zoom and the graph's tools are not drawn again, and are out of sight in the other view, or
  // where there is nothing to zoom.
  if (at.closest("#levels, #graph-panel")) return ofBoard(() => (at.isConnected ? at : null));
  const project = at.closest("#projects .project, #projects .project-chip, #projects .project-chip-wrap");
  if (project) {
    const id = project.querySelector(".project-id")?.textContent;
    const part = at.matches(".project-zoom") ? ".project-zoom"
      : at.matches(".project-chip-zoom") ? ".project-chip-zoom"
      : at.matches(".project-main") ? ".project-main"
      : at.matches(".project-chip") ? ".project-chip" : null;
    return () => {
      const again = [...$("projects").querySelectorAll(".project, .project-chip-wrap")].find((item) => item.querySelector(".project-id")?.textContent === id);
      return part ? again?.querySelector(part) : again;
    };
  }
  // The control that collapses a column is known by its column: used, it is drawn again as the one that undoes it.
  if (at.matches("#board .column-fold")) {
    const key = at.closest(".column").dataset.key;
    return () => columnOnBoard(key)?.querySelector(".column-fold");
  }
  // "Open all" goes with the line it is in, once the columns are open: the keyboard is then on the first of them.
  if (at.matches("#board .columns-note button")) return () => $("board").querySelector(".columns-note button") ?? $("board").querySelector(".column-fold");
  // Any other control outside the panel, such as those of the header, is not drawn again: it is that very one,
  // for as long as it is on the page.
  if (at !== document.body && !$("panel").contains(at)) return () => (at.isConnected ? at : null);
  return null;
}

/**
 * Whether a control can take the keyboard: it is on the page, drawn, and in sight. A card on its way to another
 * column waits unseen where it will land while a copy of it travels: wanted by the keyboard, it lands at once.
 */
function reachable(control) {
  if (!control?.isConnected) return null;
  const flying = control.matches("#board .card, #board .zoom-into") ? flights.get(control.dataset.id) : null;
  if (flying) {
    flights.delete(control.dataset.id);
    for (const animation of flying.getAnimations()) animation.cancel();
    flying.remove();
    keepMarks();
  }
  return control.getClientRects().length > 0 && getComputedStyle(control).visibility !== "hidden" ? control : null;
}

/**
 * What stands for a task on the page as it is now. On the board: its own card or its button to zoom, whichever
 * `kind` asks for first; else the card of the nearest closed group that holds it. In either view, when the task
 * is a group the page is in or came through: the way out of it, or its step of the trail.
 */
function standsFor(id, kind) {
  if (state.view === "board") {
    const own = reachable(controlOf(id, kind)) ?? reachable(controlOf(id));
    if (own) return own;
    const reveal = (task, wanted = ".card") => {
      if (!task || !state.boardCards?.some((card) => card.id === task.id)) return null;
      state.expanded.add(boardColumn(task));
      draw();
      return reachable(controlOf(task.id, wanted)) ?? reachable(controlOf(task.id));
    };
    // The task belongs on this board but its column stopped at its rendering limit. Open that column rather than
    // treating the task as absent and sending the keyboard to the board's zoom control.
    const revealed = reveal(state.byId.get(id), kind);
    if (revealed) return revealed;
    // Up through what holds it, the nearest first, and not by a function that calls itself.
    const seen = new Set([id]);
    const queue = [id];
    for (let next = 0; next < queue.length; next++) {
      const held = state.byId.get(queue[next]);
      for (const holder of held ? holdersOf(held) : []) {
        if (seen.has(holder) || !state.byId.has(holder)) continue;
        seen.add(holder);
        const around = state.closed?.has(holder) ? reachable(stripFor(holder)) ?? reachable(controlOf(holder)) : null;
        if (around) return around;
        if (state.closed?.has(holder)) {
          const revealedHolder = reveal(state.byId.get(holder));
          if (revealedHolder) return revealedHolder;
        }
        queue.push(holder);
      }
    }
  }
  const step = state.into.indexOf(id);
  if (step < 0) return null;
  const crumb = [...$("scope").querySelectorAll(".crumb")].find((button) => button.dataset.step === String(step + 1));
  const parent = [...$("scope").querySelectorAll(".crumb")].find((button) => button.dataset.step === String(step));
  return (step < state.into.length - 1 ? reachable(crumb) : null) ?? reachable($("leave-group")) ?? reachable(parent);
}

/**
 * Where the keyboard goes now, for a place it was at before the page was drawn again. Every case goes through
 * here: a redraw, a zoom, a group entered or left, a change of view, a panel that closes. The same control, when
 * it is still there and in sight. For a control of the board that is not: what stands for its task now; and
 * failing that the board's zoom, the way out of the group, the line that says what is in view, or the link to
 * the view, whichever is in sight first. So the keyboard is never left on something hidden or gone. Elsewhere on
 * the page, where controls do not come and go with the zoom, it is the same control or nothing, as it always was.
 */
function whereNow(place) {
  const same = place();
  if (!place.ofBoard) return same ?? null;
  return (
    (place.item ? reachable(stripFor(place.item)) : null) ??
    (place.item && place.kind === ".card" ? representative(place.item) : null) ??
    reachable(same) ??
    (place.item ? standsFor(place.item, place.kind) : null) ??
    [state.view === "board" ? $(state.level === null ? "level-out" : "level-in") : null, $("leave-group"), $("scope").querySelector(".scope-text"), $(`view-${state.view}`)].find(reachable) ??
    null
  );
}

/** Puts the keyboard where it goes now, without scrolling: the reader keeps their place on the page as well. */
function keyboardTo(place) {
  const to = place ? whereNow(place) : null;
  if (to && document.activeElement !== to) to.focus({ preventScroll: true });
}

/** A saved place resolves through the board's logical task and zoom fallbacks. */
const restoredControl = (place) => (place ? whereNow(place) : null);

function render() {
  const had = document.activeElement;
  const place = keyboardPlace();
  draw();
  // Put back without scrolling: the reader keeps their place on the page as well. What had the keyboard may be
  // gone from the new drawing, or hidden by it: the keyboard then goes where it can.
  if (had?.matches?.("#leave-group") && place?.item && had.dataset.group !== place.item) keyboardTo(place);
  else keepKeyboard(had, () => restoredControl(place));
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
  const inView = tasksInView();
  const text = filterText();
  const tasks = inView.filter((task) => matchesVisibleTask(task, text));
  const graph = state.view === "graph";
  // The zoom is the board's: the graph has its own way of showing groups closed, and draws every task in view.
  const board = graph ? null : boardAt(inView);
  state.boardCards = board?.cards ?? null;
  state.level = board ? board.level : null;
  state.deepest = board ? board.deepest : 0;
  state.closed = board ? board.closed : null;
  renderSummary(board ? board.cards : tasks, tasks.length, tasks);
  showLevels(board);
  $("empty").hidden = tasks.length > 0;
  $("empty").textContent =
    state.tasks.length === 0 ? "No tasks yet."
    : state.summaryFilter === "trouble" && !state.filter.trim() ? "No open bugs, issues or incidents in this view."
    : state.summaryFilter === "problems" && !state.filter.trim() ? "No tasks with problems in this view."
    : state.filter.trim() ? `No task matches "${state.filter.trim()}".`
    : state.group ? `${state.group} holds no tasks${state.project ? " in this project" : ""}.`
    : "No tasks in this project.";
  // Full screen hides the header and the views. With no graph on screen, which is where its way out is, it ends.
  if (state.full && (!graph || tasks.length === 0)) stopFullScreen();
  document.body.classList.toggle("graph-view", graph);
  document.body.classList.toggle("graph-full", graph && state.full);
  document.body.classList.toggle("focus", state.focus);
  document.body.classList.toggle("scoped", Boolean(state.project || state.group || state.filter.trim() || state.summaryFilter || state.level));
  $("focus").setAttribute("aria-pressed", String(state.focus));
  $("focus").setAttribute("aria-label", state.focus ? "Show everything above the board again" : "Hide everything above the board");
  $("graph-full").setAttribute("aria-pressed", String(state.full));
  $("graph-full").textContent = state.full ? "Leave full screen" : "Full screen";
  $("board").hidden = graph || tasks.length === 0;
  showLights();
  $("bugs-apart").checked = state.bugsApart;
  $("column-scroll").checked = state.columnScroll;
  $("graph-panel").hidden = !graph || tasks.length === 0;
  for (const view of ["board", "graph"]) {
    if (state.view === view) $(`view-${view}`).setAttribute("aria-current", "page");
    else $(`view-${view}`).removeAttribute("aria-current");
  }
  linkViews();
  if (board) renderBoard(board.cards, board.closed);
  else if (typing === null) renderGraphView(tasks);
  fitBoard();
}
/** The links to the two views lead to the same group, and the board is at the same zoom when it is come back to. */
function linkViews() {
  for (const view of ["board", "graph"]) {
    const link = $(`view-${view}`);
    link.setAttribute("href", routeOf(view, null));
    link.onclick = (event) => {
      if (!locked) return;
      // The visible address must not reveal plan IDs while locked out. Carry the target view with the hidden route
      // in this history entry so a switch between Board and Graph still restores the same bookmark after sign-in.
      event.preventDefault();
      const before = history.state?.kept;
      const route = readRoute(before?.route ?? location.hash);
      const kept = {
        route: routeOf(view, null, route.zoom, route.into, route.project, route.projectZoom),
        project: route.project ?? before?.project ?? null,
      };
      history.pushState({ kept }, "", `#${view}`);
      applyRoute();
    };
  }
}

/**
 * The control above the board that zooms it: out to fewer levels of groups, in to more, with the level in words
 * between the two. Where nothing in view holds anything there is one level only, and the control steps aside.
 * A button with nothing further to go to says so and stays where it is, so that the keyboard does not lose it.
 */
function showLevels(board) {
  const canStep = Boolean(board && board.deepest >= 2);
  // Position is useful even where zoom cannot step. It also remains the keyboard's visible fallback after a
  // group is left over the graph, now that the breadcrumb lives inside this unified surface.
  $("levels").hidden = false;
  for (const id of ["level-out", "level-in", "level"]) $(id).hidden = !canStep;
  // Out of sight it says nothing: how many levels were open says how deep the plan is.
  $("level").textContent = canStep ? levelName(board.level) : "";
  if (!canStep) return;
  const ends = { "level-out": board.level === 1, "level-in": board.level === null };
  const titles = {
    "level-out": ends["level-out"] ? "Only the top level is shown: there is nothing further to zoom out to" : "Zoom out: close one level of groups",
    "level-in": ends["level-in"] ? "Everything is shown: there is nothing further to zoom in to" : "Zoom in: open one more level of groups",
  };
  for (const id of ["level-out", "level-in"]) {
    $(id).setAttribute("aria-disabled", String(ends[id]));
    $(id).title = titles[id];
  }
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
  for (const work of priorityWorkers.values()) work.pending = 0;
  priorityWorkers.clear();
  priorityWork = null;
  panelCredential = null;
  // The key that was refused is forgotten. Another one, given in another tab while the answer was on its way,
  // was not refused and stays.
  if (refused) localStorage.removeItemIf(KEY_NAME, refused);
  // Where this entry was is kept with it in browser history, and nowhere a person or screen reader comes by.
  putRouteAway();
  // Nothing is loaded any more, and the header must go on saying that the page is not connected. Nor does the
  // page go on holding where it was, what was open or which project was selected: all of it is of the plan.
  Object.assign(state, { projects: [], tasks: [], byId: new Map(), snapshot: "", instance: null, shown: null, drawn: null, item: null, have: null, further: null, troubled: false, openTitle: "", loadedAt: null, loadedMs: null, failed: true });
  $("instance").textContent = "";
  Object.assign(state, { project: null, projectZoom: false, zoom: null, into: [], group: null, open: null, trail: [] });
  holdings = { of: null, held: new Map(), inside: new Map() };
  panelOpener = null;
  // What was typed into the filter is often a title or an ID, and is repeated in the line that says what is in
  // view and where the page says that nothing matches. It goes before the page is drawn again, and with it the
  // drawing of the graph that waits for the typing to pause.
  state.filter = "";
  $("filter").value = "";
  $("clear-filter").hidden = true;
  clearTimeout(typing);
  typing = null;
  // What was said of a zoom for a screen reader names a group or a project, and sits outside what is hidden
  // below. It goes now, and so does the timer that would have emptied it later.
  clearTimeout(said);
  said = null;
  $("zoom-said").textContent = "";
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
    const session = sessions;
    let turn = ++readings;
    const [instance, projects, firstTasks] = await Promise.all([api("instance"), all("list-projects", "projects"), all("list-tasks", "tasks")]);
    // An empty plan is valid, but losing every task for one successful-looking reading is also the most damaging
    // transient answer the page can draw: it looks exactly like lost data. Confirm that boundary before replacing
    // a populated board. The second ordinary reading also lets the page recover immediately without a reload.
    let tasks = firstTasks;
    if (state.loadedAt && state.tasks.length > 0 && firstTasks.length === 0) {
      // The confirmation is a newer reading than the empty answer. A sound/watch-only reading that began while
      // the first request was pending must not make this newer task data look stale to `announce`.
      turn = ++readings;
      tasks = await all("list-tasks", "tasks");
    }
    // Another request or tab may have locked the page while these answers were on their way. They belong to the
    // credential and route from before that lockout and may restore neither the plan nor its hidden address.
    if (session !== sessions) return;
    // Redraw only when something changed, so a refresh never swaps a card out from under a click.
    const snapshot = JSON.stringify([projects, tasks]);
    const changed = snapshot !== state.snapshot;
    Object.assign(state, { instance, projects, tasks, snapshot, byId: new Map(tasks.map((t) => [t.id, t])), failed: false });
    // The service lets the page in: when it was locked out before, also before it was loaded again, it is
    // where it was then.
    comeBack();
    if (state.project && !projects.some((p) => projectRef(p) === state.project)) {
      state.project = null;
      state.projectZoom = false;
      history.replaceState(history.state, "", routeOf(state.view, readRoute().open, state.zoom, state.into, null, false));
    }
    // A group the board was in may be gone, or no longer hold the one after it in the trail.
    const left = settleZoom();
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
    // Not when the board had to leave a group: it then shows other cards, and none of them moved.
    const before = changed && !first && !left && state.view === "board" ? cardPlaces() : null;
    if (changed) render();
    else fitBoard();
    // The plan took away the group the page was in: where it is now is said, as when the person zooms.
    if (left && !first) sayZoom();
    if (before) showMoves(before);
    announce(tasks, (id) => state.byId.get(id) ?? null, turn);
    // An item named in the address opens once there is data; an open one follows the changes, and one that
    // could not be read the last time is read again.
    const panelKeyChanged = panelCredential !== null && panelCredential !== (localStorage.getItem(KEY_NAME) ?? "");
    const priority = state.open?.kind === "task" ? priorityWorkers.get(taskIdentity(state.open.id)) : null;
    const blockedPriority = Boolean(priority?.blocked && !priority.running && !priority.pending);
    if (state.open && (changed || first || $("panel").hidden || state.troubled || panelKeyChanged || blockedPriority)) await renderDetail();
    return true;
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
    return false;
  }
}

$("filter").addEventListener("input", (event) => {
  state.filter = event.target.value;
  syncFilterClear();
  clearTimeout(typing);
  typing = state.view === "graph" ? setTimeout(() => ((typing = null), render()), TYPING_PAUSE_MS) : null;
  render();
});
$("clear-filter").addEventListener("click", () => {
  const filter = $("filter");
  state.summaryFilter = null;
  filter.value = "";
  filter.dispatchEvent(new Event("input", { bubbles: true }));
  filter.focus({ preventScroll: true });
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
    focusVisible($("settings"), ...keyboardFallbacks());
  } else if (!$("panel").hidden) closeItem();
  else if (state.full) leaveFullScreen();
});

/** The box of a task that had no card: it is nowhere, and no card slides from it. */
const NOWHERE = { left: Number.POSITIVE_INFINITY, top: Number.POSITIVE_INFINITY, width: 0, height: 0 };

/**
 * Where everything on the board is, taken before the board is drawn again: what a refresh moved then sets off
 * from where it was, whatever the new drawing keeps of that place. Every task on the board is in it. One with a
 * card has the card's place. One in a collapsed column has the place of its strip, or none when the strip has
 * no place on the page. One that its column shows only on request has no place. A journey with no place to set
 * off from is not made. The board itself, as it was drawn, is kept with the places: the rings are told from it.
 */
function cardPlaces() {
  const places = cardsOnBoard();
  const rooms = new Map();
  for (const strip of $("board").querySelectorAll(".column.collapsed")) {
    const box = strip.getBoundingClientRect();
    rooms.set(strip.dataset.key, box.width > 0 && box.height > 0 ? box : null);
  }
  for (const [id, { task, column }] of onBoard.tasks) {
    if (!places.has(id)) places.set(id, { held: rooms.has(column), room: rooms.get(column) ?? null, column, status: task.status, box: NOWHERE, inSight: false });
  }
  places.board = onBoard;
  return places;
}

/** Where every card is on screen and which column it is in, taken before the board is drawn again. */
function cardsOnBoard() {
  return new Map(
    [...$("board").querySelectorAll(".card")].map((card) => {
      const box = card.getBoundingClientRect();
      // A card may be scrolled out of sight inside its column. Then it sets off from the nearest edge of the column.
      const room = card.closest(".cards").getBoundingClientRect();
      const inSight = box.bottom > room.top && box.top < room.bottom;
      const from = { left: box.left, top: inSight ? box.top : box.top < room.top ? room.top : room.bottom - box.height, width: box.width, height: box.height };
      return [card.dataset.id, { box, from, inSight, column: card.closest(".column").dataset.key, status: card.dataset.status, shows: shows.get(card), node: card }];
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
/** Whether cards move: an explicit choice wins; otherwise the system's reduced-motion preference is honoured. */
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const moving = () => state.motion === "on" || (state.motion !== "off" && !reducedMotion.matches);
$("motion").checked = moving();
reducedMotion.addEventListener("change", () => {
  if (state.motion === null) $("motion").checked = moving();
});
$("motion").addEventListener("change", (event) => {
  state.motion = event.target.checked ? "on" : "off";
  localStorage.setItem(MOTION_NAME, state.motion);
});

/**
 * Sends a copy of a card from where it was to where it is now. Returns the journey, which ends when the copy has
 * landed. A card that comes out of a collapsed column grows out of the strip as it lifts off, from the size
 * `out`, and one that goes into a collapsed column shrinks into the strip as it lands, to the size `into`.
 */
function fly(copy, dx, dy, lands, { out = 1, into = 1, opacity = out === 1 ? 1 : 0 } = {}) {
  const way = Math.round(Math.min(MOST_MS, Math.max(LEAST_MS, Math.hypot(dx, dy) / PACE)));
  const total = LIFT_MS + way + LAND_MS;
  return copy.animate(
    [
      { transform: out === 1 ? "none" : `scale(${out})`, offset: 0, easing: "ease-out", opacity },
      // The same at both ends, so that half the time is half the way: it neither darts off nor rushes in.
      { transform: "scale(1.06)", offset: LIFT_MS / total, easing: "cubic-bezier(0.3, 0, 0.7, 1)", ...(out === 1 ? {} : { opacity: 1 }) },
      { transform: `translate(${dx}px, ${dy}px) scale(1.06)`, offset: (LIFT_MS + way) / total, easing: "ease-in", opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px)${into === 1 ? "" : ` scale(${into})`}`, offset: 1, opacity: lands ? 1 : 0 },
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
  // A mark lasts its time, and no longer than its task is on the board: the board narrowed to something else, or
  // a task that is gone, takes the mark away.
  forgetMarks(marked, now, MARKED_MS, (name) => onBoard.tasks.has(name) || COLUMNS.some((c) => stripMark(c.key) === name));
  // A collapsed column that something changed in is marked on its strip, for as long as a card is.
  for (const column of $("board").querySelectorAll(".column.collapsed")) {
    const at = markedAt(marked, stripMark(column.dataset.key), onBoard.scope);
    column.classList.toggle("changed", at !== undefined);
    column.style.animationDelay = "";
    if (at !== undefined) {
      const animation = [...column.getAnimations()].find((one) => one.animationName === "changed-strip");
      if (animation) animation.currentTime = Math.max(0, now - at);
    }
  }
  for (const card of $("board").querySelectorAll(".card")) {
    const at = markedAt(marked, card.dataset.id, onBoard.scope);
    card.classList.toggle("changed", at !== undefined);
    // Drawn again, the ring goes on fading from where it was instead of starting over.
    card.style.animationDelay = "";
    if (at !== undefined) {
      const animation = [...card.getAnimations()].find((one) => one.animationName === "changed");
      if (animation) animation.currentTime = Math.max(0, now - at);
    }
    card.style.visibility = flights.has(card.dataset.id) ? "hidden" : "";
    // The button that zooms into a closed group sits beside its card, and is out of sight with it.
    const beside = card.parentElement.matches(".holder") ? card.nextElementSibling : null;
    if (beside) beside.style.visibility = card.style.visibility;
  }
}

function mark(id) {
  setMarks(marked, [id], performance.now(), onBoard.scope);
  setTimeout(keepMarks, MARKED_MS + 50);
}

/** The name a collapsed column is marked under, among the cards: no task has an ID with a space in it. */
const stripMark = (key) => `column ${key}`;

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
  // A board that is narrowed to something else than it was shows other cards: none of them moved, and none is news.
  if (before.board.scope !== onBoard.scope) return void keepMarks();
  // The strips of the collapsed columns, and for a task that is in one of them now, its column and the strip.
  const strips = new Map([...$("board").querySelectorAll(".column.collapsed")].map((strip) => [strip.dataset.key, strip]));
  const held = (id) => {
    const column = onBoard.tasks.get(id)?.column;
    return strips.has(column) ? { column, strip: strips.get(column) } : null;
  };
  /**
   * Where a card's journey starts: at `from`, or, when a copy of it is already on its way, where that copy is
   * now. The copy that was heading for the old place is taken away.
   */
  const setOff = (id, from) => {
    const flying = flights.get(id);
    if (!flying) return from;
    const at = flying.getBoundingClientRect();
    const width = parseFloat(flying.style.width);
    const height = parseFloat(flying.style.height);
    const opacity = Number(getComputedStyle(flying).opacity);
    flights.delete(id);
    for (const animation of flying.getAnimations()) animation.cancel();
    flying.remove();
    return { left: at.left + (at.width - width) / 2, top: at.top + (at.height - height) / 2, width, height, scale: at.width / width, opacity };
  };
  /** Sends a copy on its way as its card's own, and takes it away when it has landed. */
  const send = (id, copy, dx, dy, lands, sizes) => {
    flights.set(id, copy);
    fly(copy, dx, dy, lands, sizes).finished.catch(() => {}).then(() => {
      copy.remove();
      // Only the copy that is still this card's own ends its flight; one that was replaced on the way does not.
      if (flights.get(id) === copy) flights.delete(id);
      keepMarks();
    });
  };
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
    // A closed group's card moves together with the button beside it that zooms into the group.
    const whole = card.parentElement.matches(".holder") ? card.parentElement : card;
    if (!was) {
      mark(id);
      if (!still) whole.animate([{ opacity: 0, transform: "scale(0.9)" }, { opacity: 1, transform: "none" }], { duration: 340, easing: "ease-out" });
    } else if (was.column !== card.closest(".column").dataset.key) {
      mark(id);
      // A card that is already on its way turns towards its new place from where it is now: the copy that was
      // heading for the old place is taken away, and a new one sets off from that spot.
      // One that comes out of a collapsed column sets off from where its strip was, and grows out of it. The strip
      // may be gone by now, when this was its last task: its place was taken before the board was drawn again.
      const start = was.held && was.room ? inStrip(now, was.room) : null;
      const out = start && !flights.has(id) ? start.scale : 1;
      const from = setOff(id, was.held ? start : was.from);
      // With no place to set off from there is no journey: the card is in its place at once, ringed, and does not
      // fade in as a new one does.
      if (!from) continue;
      // The card that has the keyboard stays where the keyboard can reach it: hidden for a flight it would lose
      // it, so it is ringed in its new place and does not travel. The same when the keyboard is on the button
      // beside it that zooms into the group, which is hidden with the card.
      if (still || whole.contains(document.activeElement) || travellers++ >= MOST) continue;
      // Where it lands: its new place, or the nearest edge of its column when that place is scrolled out of sight.
      const room = card.closest(".cards").getBoundingClientRect();
      const inSight = now.bottom > room.top && now.top < room.bottom;
      const dx = now.left - from.left;
      const dy = (inSight ? now.top : now.top < room.top ? room.top : room.bottom - from.height) - from.top;
      send(id, ghost(card, from), dx, dy, inSight, { out: from.scale ?? out, opacity: from.opacity });
    } else {
      // A card may change state and stay in its column, as a bug does in the column for bugs: it is ringed too.
      // So is the card of a closed group when anything it shows changed: of itself, or of the tasks it stands for.
      if (was.status !== card.dataset.status || was.shows !== shows.get(card)) mark(id);
      if (still || Math.abs(was.box.left - now.left) >= 1 || Math.abs(was.box.top - now.top) < 1) continue;
      whole.animate([{ transform: `translateY(${was.box.top - now.top}px)` }, { transform: "none" }], { duration: 260, easing: "ease-in-out" });
    }
  }
  let leavers = 0;
  for (const [id, was] of before) {
    if (after.has(id)) continue;
    const now = held(id);
    if (now) {
      // The task is in a collapsed column. One that was there already stays, and a copy of its card that is still
      // on its way to the strip goes on. One that came from an open column has its card travel to the strip,
      // which takes it in. Between two strips there is no card to travel: their marks say what happened.
      if (was.held && was.column === now.column) continue;
      const from = setOff(id, was.from);
      // The strip is in the drawing that was just made, a new strip too. One that has no place on the page is
      // no place to land.
      const room = now.strip.getBoundingClientRect();
      if (still || !was.node || !room.width || !room.height || travellers++ >= MOST) continue;
      const to = inStrip(from, room);
      send(id, ghost(was.node, from), to.left - from.left, to.top - from.top, false, { out: from.scale, opacity: from.opacity, into: to.scale });
      continue;
    }
    // A card that is gone has no place to land any more: a copy of it that was on its way is taken away.
    if (setOff(id, null)) continue;
    // A card that left while it was scrolled out of sight has nothing to show for it.
    if (still || !was.inSight || leavers++ >= MOST) continue;
    const copy = ghost(was.node, was.box);
    copy.animate([{ opacity: 1 }, { opacity: 0, transform: "scale(0.9)" }], { duration: 300, easing: "ease-in" }).finished.catch(() => {}).then(() => copy.remove());
  }
  // A task is marked for any change in what its card shows, not only for a new state or column: its title, its
  // kind, its priority, who has it, what it waits for, and whatever else is drawn on a card. The marks are told
  // from the board before and the board after, not from the cards that happen to be drawn: a task in a collapsed
  // column, or one that its column shows only on request, is marked like any other, and a card that is drawn for
  // it in time is ringed. Many may be marked at once, and are looked at once when their time is up.
  const { cards, strips: rung } = boardChanges(before.board, onBoard, (column) => collapsedColumns.has(column));
  const changed = [...cards, ...[...rung].map(stripMark)];
  setMarks(marked, changed, performance.now(), onBoard.scope);
  if (changed.length) setTimeout(keepMarks, MARKED_MS + 50);
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
/** Calls that asked while a load was under way: resolved only after the later answer they asked for was handled. */
let loadWaiters = [];

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
    return new Promise((resolve) => loadWaiters.push(resolve));
  }
  busy = true;
  let succeeded = false;
  try {
    let more;
    do {
      wanted = false;
      wantedByPerson = false;
      succeeded = await refresh();
      more = wanted && (!locked || wantedByPerson);
    } while (more);
  } finally {
    busy = false;
    wanted = false;
    wantedByPerson = false;
    const finished = loadWaiters;
    loadWaiters = [];
    for (const resolve of finished) resolve(succeeded);
  }
  return succeeded;
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
  const had = document.activeElement;
  notices.length = 0;
  showNotices();
  keepKeyboard(had);
});

/** Shows a notice that stays until it is dismissed, since the person may be looking elsewhere. */
function toast(kind, what, title, id) {
  const dismiss = () => {
    const had = document.activeElement;
    notices.splice(notices.indexOf(notice), 1);
    showNotices();
    // The notice went with the button that was pressed: the keyboard goes to the notice that is last now.
    keepKeyboard(had, () => [...$("toasts").querySelectorAll(".toast-close")].at(-1));
  };
  const notice = el(
    "div",
    { class: `toast ${kind}` },
    el("span", { class: "toast-mark", "aria-hidden": "true" }, kind === "done" ? "✓" : "–"),
    el("div", {}, el("div", { class: "toast-what" }, what), title && el("div", { class: "toast-title", title }, title)),
    id && el("button", { type: "button", onclick: () => (openItem("task", id), dismiss()) }, "Open"),
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
  Object.assign(state, { view: route.view, open: route.open, trail: history.state?.trail ?? [], zoom: route.zoom, into: route.into, group: route.into.at(-1) ?? null, project: route.project, projectZoom: route.projectZoom });
  linkViews();
}
setAutoRefresh(localStorage.getItem(AUTO_NAME) === "on");
saveWatched();
load();
