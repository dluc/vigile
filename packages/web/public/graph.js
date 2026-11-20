/**
 * The graph view. Containment is nesting: a project holds its tasks, a group holds its steps.
 * Dependencies are arrows, drawn in the order the work has to happen. A decision stands outside the boxes, with
 * an arrow to each thing it affects. Layout and drawing are done by
 * Cytoscape.js with the ELK layered layout, both served by this service so the page needs no internet.
 * The layout is worked out in a worker, off the page's own thread: for a large plan it takes many seconds,
 * and the page must go on answering meanwhile.
 */

const FINISHED = ["done", "cancelled"];
const isNumbered = (id) => /^\d+$/.test(id);
/** How a project is written in a task's links: a numbered project carries its kind in front. */
export const projectRef = (project) => (isNumbered(project.id) ? `project:${project.id}` : project.id);
const short = (text, length) => (text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text);

/**
 * The live projects and tasks that hold a task. The service lists them apart when a deleted item is among the
 * task's containers: what a live group holds through a deleted one is still inside it, and is drawn there.
 */
const holdersOf = (task) => task.live_containers ?? task.contained_in;

/** A task's state for colouring: its status, with open split into next and waiting. */
export function stateOf(task) {
  if (task.status === "open") return task.is_waiting ? "waiting" : "next";
  return task.status;
}

/**
 * Turns tasks and projects into the nodes and edges to draw.
 *
 * With `collapsed`, a group is one node that stands for everything inside it, and an arrow to or from a task
 * inside is drawn to or from the group. That is the high-level view. Without it, groups are boxes around
 * their tasks.
 *
 * Each of `decisions` is a node of its own kind, in no box, with an arrow to every task and project it affects
 * that is drawn. One that affects nothing drawn stands loose.
 */
export function buildElements(tasks, projects, { collapsed = false, decisions = [] } = {}) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const projectByRef = new Map(projects.map((p) => [projectRef(p), p]));

  // Each task is drawn inside one container, even when it sits in several: the group that holds it,
  // or else the project its ID names, or else the first of its projects by name. Which one must not depend on
  // the order the service lists them in: the same plan is the same drawing.
  const parentTask = new Map();
  for (const task of tasks) {
    const holders = holdersOf(task).filter((ref) => byId.has(ref) && ref !== task.id).sort();
    if (holders.length) parentTask.set(task.id, holders[0]);
  }
  const homeProject = (task) => {
    const named = /^([A-Z]+)-\d+$/.exec(task.id)?.[1];
    if (named && projectByRef.has(named) && holdersOf(task).includes(named)) return named;
    return holdersOf(task).filter((ref) => projectByRef.has(ref)).sort()[0] ?? null;
  };
  const top = (id, seen = new Set()) => {
    const parent = parentTask.get(id);
    if (!parent || seen.has(id)) return id;
    seen.add(id);
    return top(parent, seen);
  };
  /** The node that stands for a task on screen: itself, or the outermost group around it when groups are collapsed. */
  const shown = (id) => (collapsed ? top(id) : id);
  const hasChildren = new Set(parentTask.values());
  const nodeId = (id) => `task:${id}`;
  const projectId = (ref) => `project:${ref.replace(/^project:/, "")}`;

  const nodes = [];
  const drawnParent = new Map();
  const usedProjects = new Set();
  for (const task of tasks) {
    if (shown(task.id) !== task.id) continue;
    const parent = parentTask.get(task.id);
    const project = parent ? null : homeProject(task);
    const container = parent ? nodeId(parent) : project ? projectId(project) : undefined;
    if (project) usedProjects.add(project);
    if (container) drawnParent.set(nodeId(task.id), container);
    const group = hasChildren.has(task.id);
    const open = group && !collapsed;
    const progress = task.progress ? `${task.progress.finished}/${task.progress.total}` : "";
    const kind = task.type !== "task" ? ` · ${task.type}` : "";
    nodes.push({
      data: {
        id: nodeId(task.id),
        ref: task.id,
        kind: "task",
        parent: container,
        label: open
          ? `${task.id}${kind} · ${short(task.title, 46)}${progress ? `   ${progress}` : ""}`
          : `${task.id}${kind}${group ? `   ${progress}` : ""}\n${short(task.title, 78)}`,
        state: stateOf(task),
        type: task.type,
        trouble: task.type !== "task" ? 1 : 0,
        unbroken: /\S{22,}/.test(task.title) ? 1 : 0,
        problem: task.has_problems ? 1 : 0,
        group: group ? 1 : 0,
      },
    });
  }

  const isInside = (inner, outer) => {
    for (let at = drawnParent.get(inner); at; at = drawnParent.get(at)) if (at === outer) return true;
    return false;
  };
  const edges = new Map();
  const connect = (source, target, kind, state) => {
    if (source === target || isInside(source, target) || isInside(target, source)) return;
    const key = `${source}|${target}|${kind === "contains" ? "c" : kind === "affects" ? "a" : "d"}`;
    const existing = edges.get(key);
    // Several dependencies can fold into one arrow between two groups: it is unmet if any of them is.
    if (existing) {
      if (kind === "open") existing.data.kind = "open";
      return;
    }
    edges.set(key, { data: { id: `edge:${key}`, source, target, kind, ...(state ? { state } : {}) } });
  };
  for (const task of tasks) {
    const target = nodeId(shown(task.id));
    for (const ref of task.depends_on) {
      const kind = task.waiting_for.includes(ref) ? "open" : "met";
      if (byId.has(ref)) connect(nodeId(shown(ref)), target, kind);
      else if (projectByRef.has(ref)) {
        usedProjects.add(ref);
        connect(projectId(ref), target, kind);
      }
    }
    // A task that sits in a second container is drawn in one and tied to the other by a dashed line.
    if (shown(task.id) !== task.id) continue;
    for (const ref of holdersOf(task)) {
      const other = byId.has(ref) ? nodeId(shown(ref)) : projectByRef.has(ref) ? projectId(ref) : null;
      if (!other || other === drawnParent.get(target)) continue;
      if (projectByRef.has(ref)) usedProjects.add(ref);
      connect(other, target, "contains");
    }
  }
  // A decision is an item in no box. Its arrow to a task inside a collapsed group goes to the group, as a
  // dependency's does, and carries the decision's state: that of a withdrawn decision is subdued with it.
  for (const decision of decisions) {
    const source = `decision:${decision.id}`;
    nodes.push({
      data: {
        id: source,
        ref: decision.id,
        kind: "decision",
        label: `${decision.id} · ${decision.status}\n${short(decision.title, 64)}`,
        state: decision.status,
        unbroken: /\S{20,}/.test(decision.title) ? 1 : 0,
      },
    });
    for (const ref of decision.affects) {
      if (byId.has(ref)) connect(source, nodeId(shown(ref)), "affects", decision.status);
      else if (projectByRef.has(ref)) {
        usedProjects.add(ref);
        connect(source, projectId(ref), "affects", decision.status);
      }
    }
  }

  // The projects come first, the last of them at the front.
  const boxes = [];
  for (const [ref, project] of projectByRef) {
    if (!usedProjects.has(ref)) continue;
    boxes.push({
      data: {
        id: projectId(ref),
        ref: project.id,
        kind: "project",
        label: `${project.id} · ${short(project.title, 40)}   ${project.status.replaceAll("_", " ")}`,
        state: project.status,
        problem: project.has_problems ? 1 : 0,
      },
    });
  }
  return { nodes: [...boxes.reverse(), ...nodes], edges: [...edges.values()] };
}

/**
 * The libraries, in the order they are loaded. The layout plugin takes whatever is called ELK at the moment it
 * loads, and asks it for each layout: it is given the stand-in below, which has the worker do the work.
 */
const VENDOR = [
  { src: "/vendor/cytoscape.min.js" },
  { src: "/vendor/elk-api.js", loaded: () => ((Elk = window.ELK), (window.ELK = OffThread)) },
  { src: "/vendor/cytoscape-elk.js" },
];
const WORKER = "/vendor/elk-worker.min.js";
let libraries = null;
/** The layout library's own way to a worker, as it was loaded. */
let Elk = null;

/**
 * The graph library writes a small style of its own into the page the first time it draws, unless it finds one
 * there already under this name. The page's policy lets no style written into the page apply, so the one rule
 * that style holds is in style.css, and this stands in its place for the library to find.
 */
const LIBRARY_STYLE = "__________cytoscape_stylesheet";
const notServed = (src) => new Error(`the service did not serve the graph library (${src}). It was probably started before the page was updated; restart the service, then reload this page`);

/** Loads the drawing libraries the first time the graph is opened. */
function loadLibraries() {
  if (!document.getElementById(LIBRARY_STYLE)) document.head.append(Object.assign(document.createElement("meta"), { id: LIBRARY_STYLE }));
  libraries ??= VENDOR.reduce(
    (before, { src, loaded }) =>
      before.then(
        () =>
          new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = src;
            script.onload = () => resolve(loaded?.());
            script.onerror = () => {
              script.remove();
              reject(notServed(src));
            };
            document.head.append(script);
          }),
      ),
    Promise.resolve(),
  ).then(() => {
    if (!window.cytoscape.prototype.hasInitialisedElk) {
      window.cytoscape.use(window.cytoscapeElk);
      window.cytoscape("layout", SPARING, SparingLayout);
      window.cytoscape.prototype.hasInitialisedElk = true;
    }
    return window.cytoscape;
  });
  // A failed load is not remembered, so the graph works again once the service has been restarted.
  libraries.catch(() => (libraries = null));
  return libraries;
}

/** The worker that works out layouts, kept between one layout and the next: starting one takes a moment. */
let elk = null;
/** The layout the worker is working out, which is always that of the latest drawing. */
let underWay = null;

/**
 * Stands where the layout plugin expects the layout library. The plugin hands over the graph and reads the
 * places from that same graph afterwards, which is how the library works on the page's own thread. A worker
 * gets a copy and answers with another, so the answer is written back into the graph that was handed over.
 */
class OffThread {
  layout(graph) {
    // The worker does one thing at a time and cannot be interrupted. A layout still under way is for a drawing
    // that this one replaces: it is given up, and this one does not wait behind it.
    if (underWay) endWorker();
    const mine = (underWay = {});
    return new Promise((resolve) => {
      const failed = (error) => mine === underWay && layoutFailed(error);
      try {
        elk ??= startWorker();
        elk.layout(sendable(graph)).then((placed) => {
          if (mine !== underWay) return;
          underWay = null;
          writeBack(graph, placed);
          resolve(graph);
        }, (error) => failed(new Error(`the layout could not be worked out (${error?.message ?? error})`)));
      } catch (error) {
        // Said a moment later: the drawing this is for is still being made, and is not in its place yet.
        queueMicrotask(() => failed(error));
      }
    });
  }
}

/** Starts a worker. Should it fail, whatever layout it is working out at that moment has failed with it. */
function startWorker() {
  const started = new Elk({
    workerFactory: () => {
      const worker = new Worker(WORKER);
      // A worker whose file the service does not have says nothing more than that it failed.
      worker.addEventListener("error", (event) => {
        if (started === elk && underWay) layoutFailed(event.message ? new Error(`the layout stopped with an error (${event.message})`) : notServed(WORKER));
      });
      return worker;
    },
  });
  return started;
}

/** A copy of the plugin's graph without the drawn items it hangs on each entry, which cannot be sent to a worker. */
function sendable({ _cyEle, children, edges, ...entry }) {
  return { ...entry, ...(children ? { children: children.map(sendable) } : {}), ...(edges ? { edges: edges.map(sendable) } : {}) };
}

/** Writes what the worker answered into the graph the plugin handed over, entry by entry. */
function writeBack(graph, placed) {
  const entries = new Map();
  const collect = (entry) => {
    entries.set(entry.id, entry);
    for (const inner of [...(entry.children ?? []), ...(entry.edges ?? [])]) collect(inner);
  };
  collect(graph);
  const write = (answer) => {
    const { children = [], edges = [], ...values } = answer;
    const entry = entries.get(answer.id);
    if (entry) Object.assign(entry, values);
    for (const inner of [...children, ...edges]) write(inner);
  };
  write(placed);
}

/** Ends the worker and whatever it was working out. The next layout starts another. */
function endWorker() {
  elk?.terminateWorker();
  elk = null;
  underWay = null;
}

/** The layout of the drawing on screen came to nothing: the drawing is taken away, and the page is told why. */
function layoutFailed(error) {
  endWorker();
  drop();
  told.failed?.(error);
}

/**
 * Sets apart, in each box, the items that no arrow touches. Left among the others they would all be stacked in
 * one tall column, because the layout orders items by what they wait for and these wait for nothing. Here they
 * become a shelf, packed in rows under the items that are linked. The shelf and the linked part are boxes of
 * their own that are not drawn. The decisions that affect nothing drawn are in no box, and would be one tall
 * column for the same reason: they get a shelf of their own, under everything else, which is then one part
 * above it as the linked items of a box are.
 */
export function arrange({ nodes, edges }) {
  const linked = new Set(edges.flatMap((edge) => [edge.data.source, edge.data.target]));
  const boxes = new Set(nodes.map((node) => node.data.parent).filter(Boolean));
  const isLoose = (node) => node.data.parent && !linked.has(node.data.id) && !boxes.has(node.data.id);
  const loose = new Map();
  for (const node of nodes) if (isLoose(node)) loose.set(node.data.parent, (loose.get(node.data.parent) ?? 0) + 1);
  const shelved = (box) => (loose.get(box) ?? 0) >= 2;
  /** The boxes that hold something an arrow touches, or another box. */
  const flowing = new Set(nodes.filter((node) => node.data.parent && !isLoose(node)).map((node) => node.data.parent));
  const isLooseDecision = (node) => node.data.kind === "decision" && !linked.has(node.data.id);
  const decisionsShelved = nodes.filter(isLooseDecision).length >= 2;
  const arranged = [];
  for (const node of nodes) {
    const box = node.data.parent;
    if (decisionsShelved && !box) arranged.push({ data: { ...node.data, parent: isLooseDecision(node) ? DECISION_SHELF : PLAN } });
    else arranged.push(shelved(box) ? { data: { ...node.data, parent: `${isLoose(node) ? "shelf" : "flow"}:${box}` } } : node);
    if (!shelved(node.data.id)) continue;
    if (flowing.has(node.data.id)) arranged.push({ data: { id: `flow:${node.data.id}`, kind: "flow", parent: node.data.id } });
    arranged.push({ data: { id: `shelf:${node.data.id}`, kind: "shelf", parent: node.data.id } });
  }
  if (decisionsShelved) {
    if (arranged.some((node) => node.data.parent === PLAN)) arranged.push({ data: { id: PLAN, kind: "flow" } });
    arranged.push({ data: { id: DECISION_SHELF, kind: "shelf" } });
  }
  return { nodes: arranged, edges };
}
/** The shelf of the decisions that affect nothing drawn, and the part above it that holds everything else. */
const DECISION_SHELF = "shelf:decisions";
const PLAN = "flow:plan";

/** The outline of a decision: a box pointed at both ends, which no task has. */
const DECISION_SHAPE = "-1 0 -0.93 -1 0.93 -1 1 0 0.93 1 -0.93 1";

/**
 * How each state is drawn: the names of the page's colours for the border and the inside of a task's box.
 * The legend is made from the same list, so it cannot show a colour the graph does not use.
 */
export const STATES = [
  { state: "in_progress", label: "in progress", border: "busy", fill: "busy-soft" },
  { state: "in_review", label: "in review", border: "review", fill: "review-soft" },
  { state: "next", label: "next: can start", border: "go", fill: "surface" },
  { state: "waiting", label: "waiting for another", border: "wait", fill: "wait-soft" },
  { state: "paused", label: "paused", border: "idle", fill: "idle-soft" },
  { state: "draft", label: "draft", border: "idle", fill: "surface", dashed: true },
  { state: "done", label: "done", border: "go", fill: "go-soft" },
  { state: "cancelled", label: "cancelled", border: "line", fill: "idle-soft" },
];

/** Colours come from the page's own style, so the graph follows light and dark mode. */
function palette() {
  const css = getComputedStyle(document.documentElement);
  const read = (name) => css.getPropertyValue(name).trim();
  return Object.fromEntries(
    ["surface", "raised", "text", "muted", "line", "go", "go-soft", "wait", "wait-soft", "stop", "stop-soft", "busy", "busy-soft", "review", "review-soft", "idle", "idle-soft", "bug", "bug-soft", "bg"].map((n) => [n, read(`--${n}`)]),
  );
}

function stylesheet(c) {
  const font = getComputedStyle(document.body).fontFamily;
  const state = (name, border, fill, dashed) => ({ selector: `node[kind = "task"][state = "${name}"]`, style: { "border-color": border, "background-color": fill, "border-style": dashed ? "dashed" : "solid" } });
  return [
    {
      selector: "node",
      style: {
        shape: "round-rectangle",
        width: 208,
        height: 70,
        "background-color": c.surface,
        "border-width": 2,
        "border-color": c.line,
        label: "data(label)",
        color: c.text,
        "font-family": font,
        "font-size": 12,
        "line-height": 1.25,
        "text-wrap": "wrap",
        "text-max-width": 188,
        // Words stay whole unless one is too long to fit on a line by itself.
        "text-overflow-wrap": (node) => (node.data("unbroken") ? "anywhere" : "whitespace"),
        "text-valign": "center",
        "text-halign": "center",
        "text-justification": "left",
      },
    },
    ...STATES.map((s) => state(s.state, c[s.border], c[s.fill], s.dashed)),
    { selector: 'node[state = "done"], node[state = "cancelled"]', style: { color: c.muted } },
    { selector: "node[trouble = 1]", style: { "border-color": c.bug, "border-width": 4, "border-style": "double", "background-color": c["bug-soft"] } },
    { selector: "node[problem = 1]", style: { "border-color": c.stop, "border-style": "dashed" } },
    // A decision has no colour of a task's state: its outline is the colour of the text, dashed while it is only
    // proposed, and its label says which state it is in. A withdrawn one is subdued.
    { selector: 'node[kind = "decision"]', style: { shape: "polygon", "shape-polygon-points": DECISION_SHAPE, "border-color": c.text, "background-color": c.surface, "text-max-width": 176 } },
    { selector: 'node[kind = "decision"][state = "proposed"]', style: { "border-style": "dashed" } },
    { selector: 'node[kind = "decision"][state = "withdrawn"]', style: { "border-color": c.idle, "background-color": c["idle-soft"], color: c.muted, opacity: 0.7 } },
    {
      selector: ":parent",
      style: {
        "background-color": c.raised,
        "background-opacity": 0.6,
        "border-width": 1.5,
        // A box's name is drawn just above the box, in room the layout keeps free, so nothing inside covers it.
        "text-valign": "top",
        "text-halign": "center",
        "text-margin-y": -5,
        // It is cut with an ellipsis at the box's own width.
        "text-wrap": "ellipsis",
        "text-max-width": (node) => Math.max(80, node.width() + 2 * BOX_PADDING - 8),
        "text-justification": "center",
        "font-weight": "bold",
        padding: BOX_PADDING,
      },
    },
    { selector: 'node[kind = "flow"], node[kind = "shelf"]', style: { "background-opacity": 0, "border-width": 0, padding: 0, label: "", events: "no" } },
    { selector: 'node[kind = "project"]', style: { "background-color": c.bg, "background-opacity": 0.5, "border-color": c.line, "border-style": "solid", "border-width": 1.5, "font-weight": "bold", color: c.text } },
    { selector: 'node[kind = "project"][state = "broken"]', style: { "border-color": c.stop } },
    { selector: 'node[kind = "project"][state = "ready"]', style: { "border-color": c.go } },
    {
      selector: "edge",
      style: { width: 1.5, "curve-style": "bezier", "line-color": c.idle, "target-arrow-color": c.idle, "target-arrow-shape": "triangle", "arrow-scale": 1.1 },
    },
    { selector: 'edge[kind = "open"]', style: { "line-color": c.wait, "target-arrow-color": c.wait, width: 2 } },
    { selector: 'edge[kind = "met"]', style: { "line-color": c.go, "target-arrow-color": c.go, opacity: 0.55 } },
    { selector: 'edge[kind = "contains"]', style: { "line-style": "dashed", "target-arrow-shape": "none", opacity: 0.7 } },
    { selector: 'edge[kind = "affects"]', style: { "line-color": c.text, "target-arrow-color": c.text, "line-style": "dotted", "target-arrow-shape": "vee", opacity: 0.75 } },
    { selector: 'edge[kind = "affects"][state = "withdrawn"]', style: { "line-color": c.idle, "target-arrow-color": c.idle, opacity: 0.5 } },
    { selector: ".faded", style: { opacity: 0.15 } },
    { selector: "edge.lit", style: { width: 3, opacity: 1 } },
    // What is no longer in the plan where a kept drawing has it: see `bringUpToDate`. It comes last, so that it
    // is grey whatever else it is, also when the pointer is on a neighbour and its arrows are lit.
    { selector: "node.gone", style: { "background-color": c.surface, "background-opacity": 0.3, "border-color": c.line, "border-style": "dashed", "border-width": 1.5, color: c.muted, opacity: 0.5 } },
    { selector: "edge.gone", style: { "line-color": c.line, "target-arrow-color": c.line, "line-style": "dotted", "target-arrow-shape": "none", width: 1, opacity: 0.5 } },
    { selector: ".gone.faded", style: { opacity: 0.15 } },
  ];
}

let cy = null;
/** Goes up each time the graph is taken away, so that a drawing that was under way is not finished after it. */
let cleared = 0;
/** What the page asked to be told when it last had the graph drawn. */
let told = {};
/** How many drawings were started since the page was opened. */
let drawings = 0;

/** Gives a drawing the page's colours, when they are not the ones it has. */
function colour(graph, colours) {
  const wanted = JSON.stringify(colours);
  if (graph.scratch("colours") === wanted) return;
  graph.style(stylesheet(colours));
  graph.scratch("colours", wanted);
}

/** Takes the graph away with everything it holds, as when the page may no longer show the plan. */
export function clearGraph() {
  cleared++;
  // The worker holds the plan it was last given: it goes too.
  endWorker();
  drop();
}

/** Throws away the drawing there is, if any. */
function drop() {
  if (cy) retire(cy);
  cy = null;
  delete window.vigileGraph;
}

const BOX_PADDING = 14;
const SPACING = { "elk.layered.spacing.nodeNodeBetweenLayers": 48, "elk.spacing.nodeNode": 16, "elk.spacing.edgeNode": 16 };
const NO_PADDING = "[top=0,left=0,bottom=0,right=0]";

/**
 * How many items a graph may have and still be drawn without being asked for. Up to this size the layout is
 * there within about a second. It grows faster than the plan does: a thousand tasks that wait for each other are
 * many seconds of work and hundreds of megabytes, which nobody should get just for opening the page.
 */
export const LARGE = 300;
const isLarge = (size) => size.items > LARGE;

/**
 * What becomes of the graph when the plan is not what is drawn, or nothing is drawn. Whether a graph is drawn,
 * kept or made to wait is decided here and nowhere else, and on these two sizes: that of the plan's graph as it
 * is now, which is what a layout would cost, and that of the drawing on screen, which is what would be thrown away.
 * - "draw": the person asked for this graph, having said that they want large ones. It is drawn, whatever its size.
 * - "keep": the plan moved on by itself under a drawing. The drawing stays when either is large: a large layout is
 *   not started unasked, and a large drawing, which was asked for, is not replaced unasked. So a graph of 301
 *   items that loses one is kept as much as a graph of 300 that gains one, and both say what they do not show.
 *   When both are small, the graph is drawn again, as small graphs always are.
 * - otherwise the person asked for another graph without having said that they want large ones, or nothing is
 *   drawn: a large graph waits to be asked for, and a small one is drawn.
 * Answers "draw", "keep" or "wait".
 */
function whatNow(large, onScreen, size) {
  if (large === "draw") return "draw";
  if (large === "keep" && onScreen && (isLarge(onScreen) || isLarge(size))) return "keep";
  return isLarge(size) ? "wait" : "draw";
}

/**
 * Draws the graph into `root`, and answers with how things stand, for the page to say:
 * - `waits`: the graph is large and was not asked for, so nothing is drawn;
 * - `outdated`: the drawing was made for an earlier plan and a new one was not asked for. What it still shares
 *   with the plan shows the present, and this says how many items and arrows are `added` to the plan and not
 *   drawn, and how many are `gone` from it and marked so. Never set when there is nothing of either;
 * - `placing`: a large graph is being worked out, which takes a while;
 * - `size`: how many items and arrows the graph that waits or is being worked out has.
 *
 * `large` says what is to become of a graph when the plan is no longer what is drawn: see `whatNow`.
 * `open(kind, id)` is called when a node is clicked, `placed()` when the layout of the drawing has arrived, and
 * `failed(error)` when it came to nothing. Answers nothing when the graph was taken away meanwhile.
 */
export async function renderGraph(root, { tasks, projects, decisions, collapsed }, { open, placed, failed, large = "draw" }) {
  const asked = cleared;
  const cytoscape = await loadLibraries();
  if (asked !== cleared) return null;
  told = { placed, failed };
  const built = buildElements(tasks, projects, { collapsed, decisions });
  const colours = palette();
  const size = { items: built.nodes.length, arrows: built.edges.length };
  const current = cy && cy.container().parentElement === root;
  const stands = (more = {}) => ({ waits: false, outdated: false, placing: Boolean(cy) && !cy.scratch("settled") && isLarge(cy.scratch("size")), size: cy?.scratch("size") ?? null, ...more });

  // Whether the plan is what is drawn is asked once, here, and everything goes by the answer: whether a layout is
  // needed, what is written into the drawing, what is greyed out in it, and what the page says about it.
  const difference = current ? compare(cy.scratch("base"), built) : null;
  const then = difference && !difference.changed ? "same" : whatNow(large, current ? cy.scratch("size") : null, size);
  if (then === "same" || then === "keep") {
    // The same items in the same boxes with the same arrows keep the person's zoom and position, and the drawing.
    cy.batch(() => {
      bringUpToDate(cy, difference);
      // What stays is not from another time in its colours either: it follows the theme, and light and dark.
      colour(cy, colours);
    });
    return stands({ outdated: then === "keep" && difference.changes });
  }
  if (then === "wait") {
    drop();
    root.replaceChildren();
    return stands({ waits: true, size });
  }

  const elements = arrange(built);
  // A graph that the person has moved stays where they put it when the plan changes under it: a task added
  // somewhere makes a new drawing, and must not throw away their zoom and their place.
  const kept = current ? viewOf(cy) : null;
  // Each drawing has a holder of its own, laid over the one before. When the new drawing will have its places in
  // a moment, the one in sight stays there under it until then, so that the box does not go empty in between: on
  // a small plan with auto-refresh on, that would be a blink at every change. A large one takes long enough for
  // a drawing of what the person no longer asks for to be in the way, and the box is emptied at once.
  const before = current && !isLarge(size) ? inSight(cy) : null;
  if (cy) retire(cy, before);
  const holder = document.createElement("div");
  holder.style.cssText = "position: absolute; inset: 0";
  fillWindow(root);
  root.replaceChildren(...(before ? [before.container()] : []), holder);
  const graph = (cy = cytoscape({
    container: holder,
    elements: [...elements.nodes, ...elements.edges],
    style: stylesheet(colours),
    minZoom: 0.15,
    maxZoom: 2.5,
    wheelSensitivity: 0.25,
    boxSelectionEnabled: false,
    autoungrabify: true,
    // The library draws nothing until the layout has arrived, and listens for it from here on.
    layout: layoutFor(root, elements.nodes.some((node) => node.data.id === DECISION_SHELF)),
  }));
  // What was drawn, as the plan has it: each item with the box it is in, and each arrow.
  cy.scratch("base", { nodes: new Map(built.nodes.map(({ data }) => [data.id, data.parent ?? null])), edges: new Set(built.edges.map(({ data }) => data.id)) });
  cy.scratch("kept", kept);
  cy.scratch("before", before);
  cy.scratch("size", size);
  cy.scratch("colours", JSON.stringify(colours));
  // Which drawing this is: the tests tell from it how many were started.
  cy.scratch("drawing", ++drawings);
  // Reachable from the browser console, for looking into a layout.
  window.vigileGraph = cy;

  cy.on("tap", "node", (event) => open(event.target.data("kind"), event.target.data("ref")));
  cy.on("mouseover", "node", (event) => {
    const around = event.target.closedNeighborhood().union(event.target.descendants()).union(event.target.ancestors());
    cy.elements().difference(around).addClass("faded");
    event.target.connectedEdges().addClass("lit");
    holder.style.cursor = "pointer";
  });
  cy.on("mouseout", "node", () => {
    cy.elements().removeClass("faded lit");
    holder.style.cursor = "grab";
  });
  // A gesture of the person's own is respected from then on: the view is no longer chosen for them. On a
  // drawing whose layout has not finished there is nothing to move yet, and a gesture there moves nothing.
  cy.on("scrollzoom pinchzoom dragpan", () => graph.scratch("settled") && movedByHand(graph));
  dragToMove(graph, holder);
  cy.one("layoutstop", () => {
    routeBoxArrows(graph);
    graph.scratch("settled", true);
    // This drawing is the one to see from here on: the one that stayed in sight under it goes.
    if (before) discard(before);
    graph.scratch("before", null);
    told.placed?.();
    // The view this drawing is to be given, as it stands now: what the drawing before it had, and what the
    // person has chosen since, with Fit or the zoom buttons, while the layout was under way.
    const view = graph.scratch("kept");
    if (!view || !putBack(graph, view)) settle();
    // Each press in its turn, as on a drawing that is there: at the largest and the smallest the graph allows a
    // press does nothing, and the one after it starts from there.
    for (const factor of view?.then ?? []) zoomBy(graph, factor);
    // The worker keeps the memory its last layout took, which for a large graph is hundreds of megabytes. It is
    // let go, and the next layout starts another.
    if (isLarge(size)) endWorker();
  });
  return stands();
}

/** Writes an item's data into the drawing when it is not what the drawing has. */
function write(item, data) {
  if (Object.keys(data).some((name) => item.data(name) !== data[name])) item.data(data);
}

/**
 * Compares the plan with what was drawn: which items are where they were drawn, which arrows are still there, and
 * how many of each are added and gone. It goes by what is drawn and nothing else: each item with the box it is
 * in, and each arrow by its two ends. The order in which the service lists tasks, projects and links is not
 * part of it, and neither is anything that only changes what an item says.
 */
function compare(base, built) {
  const nodes = new Map(built.nodes.map(({ data }) => [data.id, data]));
  const edges = new Map(built.edges.map(({ data }) => [data.id, data]));
  // An item is where it was drawn when it is in the plan, in the same box, and that box is where it was drawn.
  const placed = new Map();
  const there = (id) => {
    if (!placed.has(id)) {
      const box = base.nodes.get(id);
      placed.set(id, base.nodes.has(id) && nodes.has(id) && (nodes.get(id).parent ?? null) === box && (box === null || there(box)));
    }
    return placed.get(id);
  };
  const holds = (id) => base.edges.has(id) && edges.has(id) && there(edges.get(id).source) && there(edges.get(id).target);
  const count = (ids, test) => {
    let missing = 0;
    for (const id of ids) if (!test(id)) missing++;
    return missing;
  };
  const changes = {
    added: { items: count(nodes.keys(), there), arrows: count(edges.keys(), holds) },
    gone: { items: count(base.nodes.keys(), there), arrows: count(base.edges, holds) },
  };
  const changed = Object.values(changes).some(({ items, arrows }) => items + arrows > 0);
  return { base, nodes, edges, there, holds, changes, changed };
}

/**
 * Brings a drawing up to date with the plan as far as that can be done without a new layout. When the plan is
 * what was drawn, that is all of it. When a drawing is kept while the plan moves on, nothing in it may look like
 * the present when it is not:
 * - an item that is still in the plan, in the same box, shows what it is now: its state, title, kind, progress
 *   and problem mark;
 * - an item that is no longer there is greyed out and says so. It may be deleted, or finished and hidden, or no
 *   longer match the filter, or sit in another box or inside a group by now, or its box may have been moved;
 * - an arrow that is still in the plan between two such items shows whether it still holds work back, or the
 *   state of the decision it comes from; one that is not is greyed out;
 * - what is new in the plan has no place in the drawing, and is only counted.
 * Each time, the drawing is compared with the plan as a whole, so changes that come one upon the other, and
 * changes that are taken back, leave nothing behind. Only what changed is written: each item written is styled
 * again, and a box with everything in it, so writing them all would take seconds on a large plan.
 */
function bringUpToDate(graph, { base, nodes, edges, there, holds }) {
  const mark = (item, gone) => item.hasClass("gone") !== gone && item.toggleClass("gone", gone);
  for (const id of base.nodes.keys()) {
    const item = graph.getElementById(id);
    if (there(id)) {
      // The box it is drawn in is the layout's to say, and the same as before.
      const { id: same, parent, ...data } = nodes.get(id);
      write(item, data);
    } else {
      write(item, { label: `${item.data("ref")} · no longer here` });
    }
    mark(item, !there(id));
  }
  for (const id of base.edges) {
    const item = graph.getElementById(id);
    if (holds(id)) {
      const { id: same, source, target, ...data } = edges.get(id);
      write(item, data);
    }
    mark(item, !holds(id));
  }
}

/** What the layout is asked for: tasks in the order the work has to happen, from left to right, in their boxes. */
function layoutFor(root, shelf) {
  return {
    name: SPARING,
    // The view is chosen when the layout has arrived, by `settle` or `putBack`.
    fit: false,
    nodeDimensionsIncludeLabels: false,
    // Arrows follow the routes the layout works out, which go around boxes, instead of straight lines that
    // can run across a box's name or a task that has nothing to do with them.
    useElkEdgeGeometry: true,
    elkEdgeRadius: 8,
    elk: {
      algorithm: "layered",
      "elk.direction": "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      ...SPACING,
      "elk.spacing.componentComponent": 28,
      "elk.padding": "[top=24,left=24,bottom=24,right=24]",
      "elk.aspectRatio": Math.max(0.6, root.clientWidth / roomFor(root)),
      // The shelf of the decisions is kept under the rest, as a box with a shelf keeps its shelf.
      ...(shelf ? { "elk.layered.crossingMinimization.semiInteractive": "true" } : {}),
    },
    // Spacing is not passed down from one box to the boxes inside it, so each box is told.
    nodeLayoutOptions: (node) => {
      const kind = node.data("kind");
      if (kind === "shelf") {
        // Rows about as wide as the window is, so a long list of loose items uses the width there is.
        const ratio = Math.min(5, Math.max(1, (1.5 * root.clientWidth) / roomFor(root)));
        return { "elk.algorithm": "rectpacking", "elk.aspectRatio": ratio, "elk.padding": NO_PADDING, "elk.spacing.nodeNode": 16, "elk.alignment": "LEFT", "elk.position": "(0,1)" };
      }
      if (kind === "flow") return { ...SPACING, "elk.padding": NO_PADDING, "elk.alignment": "LEFT", "elk.position": "(0,0)" };
      if (!node.isParent()) return undefined;
      // A box with a shelf keeps its linked items above the shelf.
      const shelf = node.children('[kind = "shelf"]').nonempty();
      return { ...SPACING, "elk.padding": "[top=40,left=16,bottom=16,right=16]", ...(shelf ? { "elk.layered.crossingMinimization.semiInteractive": "true" } : {}) };
    },
  };
}

/**
 * The layout the graph is drawn with: that of the layout plugin, started in a way that spares the boxes.
 *
 * To start, the plugin asks each item for its size, which gives every item of the new drawing its style for the
 * first time. Whenever a property of an item is set, the graph library forgets what it had worked out from the
 * style of that item and of everything inside it, by going through all of it. For a box with a thousand tasks
 * inside, that is a thousand tasks for each of some forty properties, and it made a new drawing of a large plan
 * hold the page for a second or two. On a first styling there is nothing to forget, since nothing can have been
 * worked out from a style that was not there. So the boxes are spared the walk while the layout starts, and only
 * then. Should the library come to do this another way, nothing is spared and nothing breaks.
 */
const SPARING = "elk-sparing-boxes";
function SparingLayout(options) {
  this.options = options;
}
SparingLayout.prototype.run = function () {
  const boxes = this.options.eles.nodes(":parent");
  const nothing = () => boxes;
  boxes.forEach((box) => (box.dirtyStyleCache = nothing));
  try {
    this.options.cy.layout({ ...this.options, name: "elk" }).run();
  } finally {
    boxes.forEach((box) => delete box.dirtyStyleCache);
  }
  return this;
};

/**
 * Lets the person drag the graph by pressing anywhere in it. The library moves the graph when a drag starts on
 * empty background; this does the same when it starts on a box or a task, because when zoomed in there is often
 * no background in sight. A press that does not move is still a click on what is under it.
 */
function dragToMove(graph, holder) {
  const START = 4;
  const fingers = new Set();
  let last = null;
  let onItem = false;
  let dragging = false;
  holder.style.touchAction = "none";
  holder.style.cursor = "grab";
  const stop = (event) => {
    fingers.delete(event.pointerId);
    last = null;
    if (dragging) holder.style.cursor = "grab";
    dragging = false;
  };
  // The press reaches the library after the handler below, and it says what is under the pointer.
  graph.on("tapstart", (event) => (onItem = event.target !== graph));
  holder.addEventListener("pointerdown", (event) => {
    fingers.add(event.pointerId);
    onItem = false;
    dragging = false;
    // Two fingers pinch to zoom; only one pointer drags.
    last = fingers.size === 1 && (event.pointerType !== "mouse" || event.button === 0) ? { x: event.clientX, y: event.clientY } : null;
  });
  holder.addEventListener("pointermove", (event) => {
    if (!last || !onItem || fingers.size !== 1 || graph.destroyed()) return;
    const dx = event.clientX - last.x;
    const dy = event.clientY - last.y;
    if (!dragging && Math.hypot(dx, dy) < START) return;
    if (!dragging) {
      dragging = true;
      holder.setPointerCapture?.(event.pointerId);
      holder.style.cursor = "grabbing";
    }
    last = { x: event.clientX, y: event.clientY };
    graph.panBy({ x: dx, y: dy });
    if (graph.scratch("settled")) movedByHand(graph);
  });
  holder.addEventListener("pointerup", stop);
  holder.addEventListener("pointercancel", stop);
}

/**
 * Gives the arrows that start or end at a box the route the layout worked out for them. The layout plugin does
 * this for arrows between two tasks only; an arrow from a whole group or project would otherwise be a straight
 * line, which can run across a neighbour's name or a task that has nothing to do with it.
 */
function routeBoxArrows(graph) {
  /** Where a box's own coordinates start: the layout gives each item a place relative to the box around it. */
  const originOf = (id) => {
    const origin = { x: 0, y: 0 };
    for (let node = graph.getElementById(id); node.nonempty(); node = node.parent()) {
      const placed = node.scratch("elk");
      origin.x += placed?.x ?? 0;
      origin.y += placed?.y ?? 0;
    }
    return origin;
  };
  graph.edges().forEach((edge) => {
    const ends = [edge.source(), edge.target()];
    if (!ends.some((end) => end.isParent())) return;
    const route = edge.scratch("elk");
    const section = route?.sections?.[0];
    if (!section?.startPoint || !section.endPoint) return;
    const origin = !route.container || route.container === "root" ? { x: 0, y: 0 } : originOf(route.container);
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((p) => ({ x: p.x + origin.x, y: p.y + origin.y }));
    // The layout's box is a little larger than the drawn one, so an end at a box is brought onto the drawn border.
    const boxes = ends.map((end) => end.boundingBox({ includeLabels: false, includeOverlays: false }));
    const onBorder = (point, box) => ({ x: Math.min(box.x2, Math.max(box.x1, point.x)), y: Math.min(box.y2, Math.max(box.y1, point.y)) });
    const start = ends[0].isParent() ? onBorder(points[0], boxes[0]) : points[0];
    const end = ends[1].isParent() ? onBorder(points.at(-1), boxes[1]) : points.at(-1);
    const centre = (box) => ({ x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 });
    const from = (point, box) => `${(point.x - centre(box).x).toFixed(1)}px ${(point.y - centre(box).y).toFixed(1)}px`;
    // Each bend is given as how far along the straight line between the two ends it is, and how far off it.
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    const bends = length < 0.05 ? [] : points.slice(1, -1).map((p) => ({ weight: ((p.x - start.x) * dx + (p.y - start.y) * dy) / (length * length), distance: (dx * (p.y - start.y) - dy * (p.x - start.x)) / length }));
    const kept = bends.filter((bend) => !((Math.abs(bend.weight) < 1e-4 || Math.abs(bend.weight - 1) < 1e-4) && Math.abs(bend.distance) < 0.01));
    edge.style({
      "curve-style": kept.length ? "round-segments" : "straight",
      "edge-distances": "endpoints",
      "source-endpoint": from(start, boxes[0]),
      "target-endpoint": from(end, boxes[1]),
      ...(kept.length ? { "segment-weights": kept.map((b) => b.weight.toFixed(4)).join(" "), "segment-distances": kept.map((b) => b.distance.toFixed(2)).join(" "), "segment-radii": "8", "radius-type": "arc-radius" } : {}),
    });
  });
}

/**
 * Where the person has put the graph, or nothing when they left it where it was placed: how far in they are,
 * and where on the screen the task nearest the middle is. A new layout may put every task somewhere else, so
 * the place is remembered by a task and not by a point.
 */
function viewOf(graph) {
  // A drawing whose layout has not finished has not been put where the one before it was yet: what it was to be
  // given is passed on, so that changes that come one upon the other do not lose the person's place.
  if (!graph.scratch("settled")) return graph.scratch("kept") ?? null;
  // "Fit" is a choice of the person's too: everything in view, whatever there comes to be.
  if (graph.scratch("fitted")) return { fit: true };
  if (!graph.scratch("moved")) return null;
  const middle = { x: graph.width() / 2, y: graph.height() / 2 };
  let nearest = null;
  let least = Infinity;
  graph.nodes().forEach((node) => {
    if (node.isParent()) return;
    const at = node.renderedPosition();
    const distance = (at.x - middle.x) ** 2 + (at.y - middle.y) ** 2;
    if (distance < least) {
      least = distance;
      nearest = { id: node.id(), at };
    }
  });
  return nearest ? { zoom: graph.zoom(), nearest } : null;
}

/** Puts a new drawing where the one before it was. Says no when the task it was placed by is no longer drawn. */
function putBack(graph, view) {
  const root = graph.container().parentElement;
  if (view.fit) {
    if (root) fillWindow(root);
    graph.resize();
    showAll(graph);
    return true;
  }
  // A view that only says what to do once the drawing is placed has no place of its own.
  if (!view.nearest) return false;
  const node = graph.getElementById(view.nearest.id);
  if (node.empty()) return false;
  if (root) fillWindow(root);
  graph.resize();
  graph.zoom(view.zoom);
  const at = node.position();
  graph.pan({ x: view.nearest.at.x - at.x * view.zoom, y: view.nearest.at.y - at.y * view.zoom });
  movedByHand(graph);
  return true;
}

/** The person has put the graph somewhere themselves: from then on the view is theirs, and no longer "Fit". */
function movedByHand(graph) {
  graph.scratch("moved", true);
  graph.scratch("fitted", false);
}

/**
 * Shows everything, however small that makes it, and never larger than life. This is what "Fit" asks for, and
 * it goes on holding: when a task is added or the window changes size, everything is in view again.
 */
function showAll(graph) {
  graph.fit(undefined, PADDING);
  if (graph.zoom() > 1) {
    graph.zoom(1);
    graph.center();
  }
  graph.scratch("fitted", true);
  graph.scratch("moved", false);
}

/** The drawing that can be seen where `graph` is: itself once it has its places, until then the one left under it. */
const inSight = (graph) => (graph.scratch("settled") ? graph : graph.scratch("before"));

/**
 * Throws a drawing away, and the one left in sight under it, unless that one is `spared` to stay in sight under
 * the next. A layout that is still being worked out for the drawing is given up: nothing is left to place.
 */
function retire(old, spared = null) {
  if (!old.scratch("settled")) endWorker();
  for (const graph of [old.scratch("before"), old]) if (graph && graph !== spared) discard(graph);
}

/** Takes a drawing off the page for good, with the holder it was drawn in. */
function discard(graph) {
  const holder = graph.container();
  graph.destroy();
  holder?.remove();
}

const SHORTEST = 360;

/** The tallest the graph's box gets: most of the window, within limits. */
const tallest = () => Math.round(Math.max(SHORTEST, Math.min(window.innerHeight * 0.72, 880)));

/**
 * How tall the graph's box is: the room left in the window under its top, so the box always reaches the bottom
 * of the window. On a phone little is left under the controls, so there the box keeps most of the screen's
 * height and the page scrolls, unless the graph has the whole screen.
 */
function roomFor(root) {
  if (matchMedia("(max-width: 640px)").matches && !document.body.classList.contains("graph-full")) return tallest();
  return Math.max(SHORTEST, Math.floor(window.innerHeight - (root.getBoundingClientRect().top + window.scrollY) - 12));
}

function fillWindow(root) {
  // A taller box can bring the page's scrollbar, and a shorter one remove it; either moves the box: measure again.
  for (let round = 0; round < 3; round++) {
    const height = `${roomFor(root)}px`;
    if (root.style.height === height) break;
    root.style.height = height;
  }
}

const SMALLEST_READABLE = 0.7;
const PADDING = 24;

/**
 * Chooses the opening view. A small graph is shown at its natural size, not blown up. A graph too big to read
 * when fitted opens at a readable size on its top left corner, to be panned from there.
 */
function settle() {
  const root = cy.container().parentElement;
  if (!root || !root.clientWidth) return;
  const place = () => {
    cy.resize();
    cy.fit(undefined, PADDING);
    if (cy.zoom() > 1) {
      cy.zoom(1);
      cy.center();
    } else if (cy.zoom() < SMALLEST_READABLE) {
      const box = cy.elements().boundingBox();
      cy.zoom(SMALLEST_READABLE);
      cy.pan({ x: PADDING - box.x1 * SMALLEST_READABLE, y: PADDING - box.y1 * SMALLEST_READABLE });
    }
  };
  fillWindow(root);
  place();
  cy.scratch("moved", false);
  cy.scratch("fitted", false);
}

/** Zooms around the middle of the box. `fit` shows everything. */
export function zoomGraph(action) {
  if (!cy) return;
  const factor = action === "in" ? 1.25 : 0.8;
  if (!cy.scratch("settled")) {
    // The layout of this drawing is still under way, and there is nothing to zoom yet. The choice is kept with
    // the view the drawing is to be given, so that it holds when the layout has finished, and also when yet
    // another drawing takes this one's place before that.
    // A press of a zoom button is kept as what to do after the view is in place, and done then as it would be on
    // a drawing that is there: around the middle, and within the limits the graph has. The presses are kept one
    // by one and not as their product: a press that runs into a limit does less than it says.
    const view = cy.scratch("kept");
    if (action === "fit") cy.scratch("kept", { fit: true });
    else cy.scratch("kept", { ...view, then: [...(view?.then ?? []), factor] });
    return;
  }
  if (action === "fit") return showAll(cy);
  zoomBy(cy, factor);
}

/** Zooms around the middle of the box, as the person asked. */
function zoomBy(graph, factor) {
  movedByHand(graph);
  graph.zoom({ level: graph.zoom() * factor, renderedPosition: { x: graph.width() / 2, y: graph.height() / 2 } });
}

/**
 * Tells the graph its box changed size, such as after the window was resized or the view was hidden and shown
 * again. The opening view is chosen afresh unless the person has moved the graph themselves.
 */
export function resizeGraph() {
  if (!cy) return;
  const root = cy.container().parentElement;
  // The box follows the window in any case; where the graph sits in it is left alone once the person moved it.
  if (root?.clientWidth) fillWindow(root);
  cy.resize();
  if (!cy.scratch("settled")) return;
  if (cy.scratch("fitted")) showAll(cy);
  else if (!cy.scratch("moved")) settle();
}
