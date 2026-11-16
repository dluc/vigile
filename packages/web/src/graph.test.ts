import assert from "node:assert/strict";
import { describe, it } from "node:test";

// The page's graph code is plain JavaScript with no build step; it is loaded here as the browser loads it.
const { buildElements, arrange } = (await import(new URL("../public/graph.js", import.meta.url).href)) as {
  buildElements(tasks: Task[], projects: Project[], options?: { collapsed?: boolean }): Elements;
  arrange(elements: Elements): Elements;
};

interface Task {
  id: string;
  title: string;
  type: string;
  status: string;
  is_waiting: boolean;
  has_problems: boolean;
  depends_on: string[];
  waiting_for: string[];
  contained_in: string[];
  progress?: { finished: number; total: number };
}
interface Project {
  id: string;
  title: string;
  status: string;
  has_problems: boolean;
}
interface Elements {
  nodes: Array<{ data: Record<string, any> }>;
  edges: Array<{ data: { source: string; target: string; kind: string } }>;
}

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Title of ${id}`,
  type: "task",
  status: "open",
  is_waiting: false,
  has_problems: false,
  depends_on: [],
  waiting_for: [],
  contained_in: [],
  ...extra,
});
const project = (id: string, extra: Partial<Project> = {}): Project => ({ id, title: `Project ${id}`, status: "open", has_problems: false, ...extra });
const ids = (e: Elements) => e.nodes.map((n) => n.data.id);
const arrows = (e: Elements) => e.edges.map((x) => `${x.data.source} -> ${x.data.target} (${x.data.kind})`).sort();
const node = (e: Elements, id: string) => e.nodes.find((n) => n.data.id === id)!.data;

/** A project with one feature group of two steps, and a loose task that waits for the second step. */
function plan(): Task[] {
  return [
    task("WEB-001", { contained_in: ["WEB"], progress: { finished: 1, total: 2 } }),
    task("WEB-002", { contained_in: ["WEB", "WEB-001"], status: "done" }),
    task("WEB-003", { contained_in: ["WEB", "WEB-001"], depends_on: ["WEB-002"] }),
    task("WEB-004", { contained_in: ["WEB"], depends_on: ["WEB-003"], waiting_for: ["WEB-003"], is_waiting: true }),
  ];
}

describe("graph elements", () => {
  it("nests each task in its group, and each group in its project", () => {
    const elements = buildElements(plan(), [project("WEB")]);
    assert.deepEqual(ids(elements), ["project:WEB", "task:WEB-001", "task:WEB-002", "task:WEB-003", "task:WEB-004"]);
    assert.equal(node(elements, "task:WEB-001").parent, "project:WEB");
    assert.equal(node(elements, "task:WEB-002").parent, "task:WEB-001");
    assert.equal(node(elements, "task:WEB-004").parent, "project:WEB");
    assert.equal(node(elements, "task:WEB-001").group, 1);
  });

  it("draws a dependency from what must finish first to what waits, marked met or open", () => {
    assert.deepEqual(arrows(buildElements(plan(), [project("WEB")])), ["task:WEB-002 -> task:WEB-003 (met)", "task:WEB-003 -> task:WEB-004 (open)"]);
  });

  it("collapses a group into one node and lifts its arrows onto it", () => {
    const elements = buildElements(plan(), [project("WEB")], { collapsed: true });
    assert.deepEqual(ids(elements), ["project:WEB", "task:WEB-001", "task:WEB-004"]);
    assert.deepEqual(arrows(elements), ["task:WEB-001 -> task:WEB-004 (open)"], "the arrow inside the group disappears; the one leaving it starts at the group");
    assert.match(node(elements, "task:WEB-001").label, /WEB-001\s+1\/2/);
  });

  it("folds several dependencies between two groups into one arrow, unmet if any of them is", () => {
    const tasks = [
      task("A-001", { progress: { finished: 1, total: 2 } }),
      task("A-002", { contained_in: ["A-001"], status: "done" }),
      task("A-003", { contained_in: ["A-001"] }),
      task("B-004", { progress: { finished: 0, total: 2 } }),
      task("B-005", { contained_in: ["B-004"], depends_on: ["A-002"] }),
      task("B-006", { contained_in: ["B-004"], depends_on: ["A-003"], waiting_for: ["A-003"], is_waiting: true }),
    ];
    assert.deepEqual(arrows(buildElements(tasks, [], { collapsed: true })), ["task:A-001 -> task:B-004 (open)"]);
    assert.equal(arrows(buildElements(tasks, [])).length, 2);
  });

  it("draws a task that sits in two places once, and ties it to the other with a dashed line", () => {
    const tasks = [task("WEB-001", { contained_in: ["AAA", "WEB"] })];
    const elements = buildElements(tasks, [project("AAA"), project("WEB")]);
    assert.equal(node(elements, "task:WEB-001").parent, "project:WEB", "the project its ID names is its home");
    assert.deepEqual(arrows(elements), ["project:AAA -> task:WEB-001 (contains)"]);

    const reloaded = buildElements([task("WEB-001", { contained_in: ["WEB", "AAA"] })], [project("WEB"), project("AAA")]);
    assert.equal(node(reloaded, "task:WEB-001").parent, "project:WEB", "reordered project links do not change the task's home");
    assert.deepEqual(arrows(reloaded), arrows(elements), "reordered project links do not change the drawing");
  });

  it("draws a dependency on a whole project from that project, and leaves out projects with nothing to show", () => {
    const tasks = [task("001", { depends_on: ["PLT"], waiting_for: ["PLT"], is_waiting: true })];
    const elements = buildElements(tasks, [project("PLT"), project("EMPTY"), project("042")]);
    assert.deepEqual(ids(elements), ["project:PLT", "task:001"]);
    assert.deepEqual(arrows(elements), ["project:PLT -> task:001 (open)"]);
    const numbered = buildElements([task("007", { contained_in: ["project:042"] })], [project("042")]);
    assert.equal(node(numbered, "task:007").parent, "project:042");
  });

  it("never draws an arrow between a box and something inside it", () => {
    const tasks = [
      task("G-001", { progress: { finished: 0, total: 1 }, depends_on: ["X-003"] }),
      task("G-002", { contained_in: ["G-001", "P"] }),
      task("X-003", {}),
    ];
    const elements = buildElements(tasks, [project("P")]);
    for (const edge of elements.edges) {
      let at = node(elements, edge.data.target).parent;
      for (; at; at = node(elements, at).parent) assert.notEqual(at, edge.data.source);
    }
    assert.ok(arrows(elements).includes("project:P -> task:G-002 (contains)"));
  });

  it("marks bugs, issues and incidents, problems, and each task's state", () => {
    const tasks = [
      task("001", { type: "bug", status: "in_progress" }),
      task("002", { has_problems: true, status: "done" }),
      task("003", { is_waiting: true }),
      task("004", { title: `Unbroken_${"x".repeat(40)}` }),
    ];
    const elements = buildElements(tasks, []);
    assert.deepEqual([node(elements, "task:001").trouble, node(elements, "task:001").state], [1, "in_progress"]);
    assert.match(node(elements, "task:001").label, /^001 · bug\n/);
    assert.deepEqual([node(elements, "task:002").problem, node(elements, "task:002").state], [1, "done"]);
    assert.deepEqual([node(elements, "task:003").state, node(elements, "task:004").state], ["waiting", "next"]);
    assert.equal(node(elements, "task:004").unbroken, 1);
    assert.ok(node(elements, "task:004").label.length < 90, "long titles are shortened");
  });

  it("copes with nothing to draw, and with links to tasks that are not shown", () => {
    assert.deepEqual(buildElements([], [project("WEB")]), { nodes: [], edges: [] });
    const elements = buildElements([task("WEB-002", { depends_on: ["WEB-001"], contained_in: ["WEB", "WEB-009"] })], [project("WEB")]);
    assert.deepEqual(ids(elements), ["project:WEB", "task:WEB-002"]);
    assert.deepEqual(elements.edges, []);
  });
});

describe("graph arrangement", () => {
  const parents = (e: Elements) => Object.fromEntries(e.nodes.map((n) => [n.data.id, n.data.parent ?? null]));

  it("sets the items no arrow touches apart from the linked ones, so they can be packed in rows", () => {
    const tasks = [
      task("WEB-001", { contained_in: ["WEB"] }),
      task("WEB-002", { contained_in: ["WEB"], depends_on: ["WEB-001"] }),
      task("WEB-003", { contained_in: ["WEB"] }),
      task("WEB-004", { contained_in: ["WEB"] }),
      task("WEB-005", { contained_in: ["WEB"] }),
    ];
    const arranged = arrange(buildElements(tasks, [project("WEB")]));
    assert.deepEqual(parents(arranged), {
      "project:WEB": null,
      "flow:project:WEB": "project:WEB",
      "shelf:project:WEB": "project:WEB",
      "task:WEB-001": "flow:project:WEB",
      "task:WEB-002": "flow:project:WEB",
      "task:WEB-003": "shelf:project:WEB",
      "task:WEB-004": "shelf:project:WEB",
      "task:WEB-005": "shelf:project:WEB",
    });
    assert.equal(arranged.edges.length, 1, "arrows are left as they are");
  });

  it("makes only a shelf when nothing in the box is linked, and none for a single loose item", () => {
    const loose = arrange(buildElements([task("A-001", { contained_in: ["A"] }), task("A-002", { contained_in: ["A"] })], [project("A")]));
    assert.deepEqual(parents(loose), { "project:A": null, "shelf:project:A": "project:A", "task:A-001": "shelf:project:A", "task:A-002": "shelf:project:A" });
    const tasks = [task("B-001", { contained_in: ["B"] }), task("B-002", { contained_in: ["B"], depends_on: ["B-001"] }), task("B-003", { contained_in: ["B"] })];
    const single = buildElements(tasks, [project("B")]);
    assert.deepEqual(arrange(single).nodes, single.nodes);
  });

  it("keeps an opened group with the linked items, and shelves the loose items inside it", () => {
    const tasks = [
      task("C-001", { contained_in: ["C"], progress: { finished: 0, total: 2 } }),
      task("C-002", { contained_in: ["C", "C-001"] }),
      task("C-003", { contained_in: ["C", "C-001"] }),
      task("C-004", { contained_in: ["C"] }),
      task("C-005", { contained_in: ["C"] }),
    ];
    const arranged = parents(arrange(buildElements(tasks, [project("C")])));
    assert.equal(arranged["task:C-001"], "flow:project:C", "a box is never put on a shelf");
    assert.deepEqual([arranged["task:C-002"], arranged["task:C-003"]], ["shelf:task:C-001", "shelf:task:C-001"]);
    assert.deepEqual([arranged["task:C-004"], arranged["task:C-005"]], ["shelf:project:C", "shelf:project:C"]);
    const top = arrange(buildElements([task("001"), task("002"), task("003")], []));
    assert.equal(top.nodes.length, 3, "items in no box are left to the layout, which packs them itself");
  });
});
