import assert from "node:assert/strict";
import { describe, it } from "node:test";

// The board's reckoning is plain JavaScript with no build step; it is loaded here as the browser loads it.
const { cardModel, cardSignature, inStrip, boardChanges, forgetMarks, setMarks, markedAt } = (await import(new URL("../public/board.js", import.meta.url).href)) as {
  boardChanges(before: Board, now: Board, collapsed: (column: string) => boolean): { cards: Set<string>; strips: Set<string> };
  setMarks(marks: Marks, names: Iterable<string>, at: number, scope: string): void;
  markedAt(marks: Marks, name: string, scope: string): number | undefined;
  forgetMarks(marks: Marks, at: number, lasts: number, counts: (name: string) => boolean): void;
  cardModel(task: Task, context: Context): { tags: Array<{ kind: string; text: string; title?: string }>; marks: string[] } & Record<string, unknown>;
  cardSignature(task: Task, context: Context): string;
  inStrip(card: Box, room: Box): Box & { scale: number };
};

interface Task {
  id: string;
  title: string;
  type: string;
  status: string;
  priority: number;
  is_waiting: boolean;
  has_problems: boolean;
  assigned_to: string[];
  waiting_for: string[];
  contained_in: string[];
  progress?: { finished: number; total: number };
  [other: string]: unknown;
}
interface Context {
  byId: Map<string, { title: string }>;
  project: string | null;
  watched: Set<string>;
}
type Marks = Map<string, { at: number; scope: string }>;
interface Board {
  scope: string;
  context: Context;
  tasks: Map<string, { task: Task; column: string }>;
}
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const task = (changes: Partial<Task> = {}): Task => ({
  id: "WEB-007",
  title: "Address form",
  type: "task",
  status: "open",
  priority: 0,
  is_waiting: false,
  has_problems: false,
  assigned_to: ["agent1"],
  waiting_for: [],
  contained_in: ["WEB-006", "WEB"],
  description: "A form for the address.",
  why: null,
  value: null,
  size: null,
  version: 3,
  created_at: "2026-11-13T10:00:00.000Z",
  updated_at: "2026-11-13T10:00:00.000Z",
  ...changes,
});
const context = (changes: Partial<Context> = {}): Context => ({ byId: new Map([["WEB-006", { title: "Shipping" }]]), project: null, watched: new Set(), ...changes });

describe("what a card shows", () => {
  it("is another text for every change in what the card shows", () => {
    const base = cardSignature(task(), context());
    const shown: Record<string, Partial<Task>> = {
      "the title": { title: "Address form, with a map" },
      "the kind": { type: "bug" },
      "the state": { status: "in_progress" },
      "a priority": { priority: 3 },
      "who it is assigned to": { assigned_to: ["agent1", "user"] },
      "nobody assigned": { assigned_to: [] },
      "a group it is in": { contained_in: ["WEB"] },
      "a project it is in": { contained_in: ["WEB-006", "WEB", "APP"] },
      "what it waits for": { is_waiting: true, waiting_for: ["WEB-003"] },
      "that it has a problem": { has_problems: true },
      "how far the tasks inside it are": { progress: { finished: 1, total: 3 } },
    };
    for (const [what, change] of Object.entries(shown)) assert.notEqual(cardSignature(task(change), context()), base, what);
    assert.equal(new Set(Object.values(shown).map((change) => cardSignature(task(change), context()))).size, Object.keys(shown).length, "and each change gives a text of its own");
    // A priority is shown as it is, and as a high one from 5 on; one more thing waited for is one more thing said.
    assert.notEqual(cardSignature(task({ priority: 3 }), context()), cardSignature(task({ priority: 7 }), context()));
    assert.notEqual(cardSignature(task({ is_waiting: true, waiting_for: ["WEB-003"] }), context()), cardSignature(task({ is_waiting: true, waiting_for: ["WEB-003", "project:9"] }), context()));
    assert.notEqual(cardSignature(task({ progress: { finished: 1, total: 3 } }), context()), cardSignature(task({ progress: { finished: 2, total: 3 } }), context()));
  });

  it("is the same text for a change in what no card shows", () => {
    const base = cardSignature(task(), context());
    for (const [what, change] of Object.entries({
      "the description": { description: "Another description." },
      "the reason": { why: "Customers ask for it." },
      "the value and the size": { value: 5, size: 3 },
      "the version and the dates": { version: 4, updated_at: "2026-11-14T10:00:00.000Z", completed_at: "2026-11-14T10:00:00.000Z" },
      "who made it": { created_by: "user" },
    })) {
      assert.equal(cardSignature(task(change), context()), base, what);
    }
    // Of many users a card names three and counts the rest: another name among the rest is not shown.
    assert.equal(cardSignature(task({ assigned_to: ["a", "b", "c", "d", "e"] }), context()), cardSignature(task({ assigned_to: ["a", "b", "c", "d", "f"] }), context()));
    assert.notEqual(cardSignature(task({ assigned_to: ["a", "b", "c", "d", "e"] }), context()), cardSignature(task({ assigned_to: ["a", "b", "c", "d", "e", "f"] }), context()), "one more among the rest is");
  });

  it("goes by what the page is narrowed to, what is watched and the plan around the task, as the card does", () => {
    const base = cardSignature(task(), context());
    assert.notEqual(cardSignature(task(), context({ project: "WEB" })), base, "narrowed to a project, the cards leave its name out");
    assert.notEqual(cardSignature(task(), context({ watched: new Set(["WEB-007"]) })), base, "a watched task says so");
    assert.equal(cardSignature(task(), context({ watched: new Set(["WEB-001"]) })), base, "another task that is watched does not");
    assert.notEqual(cardSignature(task(), context({ byId: new Map([["WEB-006", { title: "Shipping and returns" }]]) })), base, "a group's title is under the pointer on the tag that names the group");
    assert.notEqual(cardSignature(task(), context({ byId: new Map() })), base, "a container that is no task of the plan is shown as a project");
  });

  it("says what the card draws, tag by tag", () => {
    const shows = cardModel(task({ type: "incident", priority: 7, has_problems: true, is_waiting: true, waiting_for: ["WEB-003", "project:9"], progress: { finished: 1, total: 3 } }), context({ watched: new Set(["WEB-007"]) }));
    assert.deepEqual(shows, {
      id: "WEB-007",
      status: "open",
      marks: ["problem", "trouble", "is-group"],
      type: "incident",
      priority: { text: "P7", high: true },
      title: "Address form",
      tags: [
        { kind: "group", text: "1/3 done", title: "Tasks finished inside this group" },
        { kind: "watched", text: "watching", title: "You are watching this task: a sound plays when it is done" },
        { kind: "who", text: "agent1" },
        { kind: "waiting", text: "waits for WEB-003, 9", title: "WEB-003, 9" },
        { kind: "warn", text: "⚠ problem" },
        { kind: "", text: "in WEB-006", title: "Shipping" },
        { kind: "", text: "WEB" },
      ],
    });
    assert.deepEqual(cardModel(task(), context({ project: "WEB" })).tags, [{ kind: "who", text: "agent1" }, { kind: "", text: "in WEB-006", title: "Shipping" }]);
  });
});

describe("a card in the strip of a collapsed column", () => {
  const middle = (box: Box) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
  const inside = (point: { x: number; y: number }, room: Box, slack = 1e-6) => point.x >= room.left - slack && point.x <= room.left + room.width + slack && point.y >= room.top - slack && point.y <= room.top + room.height + slack;
  const say = (card: Box, room: Box) => `a card ${JSON.stringify(card)} in a strip ${JSON.stringify(room)}`;

  it("is level with where it was on a tall strip, in the middle of it across, and as wide as the strip", () => {
    const card = { left: 40, top: 300, width: 300, height: 100 };
    const strip = { left: 700, top: 200, width: 40, height: 600 };
    const there = inStrip(card, strip);
    assert.ok(Math.abs(middle(there).x - 720) < 1e-9 && middle(there).y === 350, `its middle is at ${JSON.stringify(middle(there))}`);
    assert.deepEqual([there.width, there.height], [300, 100], "at its own size");
    assert.ok(Math.abs(there.scale * 300 - 40) < 1e-9, `shrunk to the strip's width: ${there.scale}`);
    // A card that is above or below the strip is level with its nearest end, the whole of the shrunk card inside.
    const above = inStrip({ ...card, top: 0 }, strip);
    assert.ok(Math.abs(middle(above).y - (200 + (100 * above.scale) / 2)) < 1e-9, `at the strip's upper end: ${middle(above).y}`);
  });

  it("is in the middle of a bar that lies across and is lower than the card, not under it", () => {
    // A phone: the bar of a collapsed column is as wide as a card and less than half as tall.
    const card = { left: 26, top: 500, width: 338, height: 96 };
    const bar = { left: 14, top: 650, width: 362, height: 45 };
    const there = inStrip(card, bar);
    assert.deepEqual(middle(there), { x: 195, y: 672.5 }, "its middle is the bar's middle from top to bottom, and its own across");
    assert.ok(Math.abs(there.scale * 96 - 45) < 1e-9, `shrunk to the bar's height: ${there.scale}`);
    assert.ok(there.top + (there.height * (1 - there.scale)) / 2 >= bar.top - 1e-9 && there.top + (there.height * (1 + there.scale)) / 2 <= bar.top + bar.height + 1e-9, "the shrunk card is inside the bar");
  });

  it("has its middle inside the strip and is of a real size, whatever the sizes of the two: smaller, larger, or with no width or height at all", () => {
    let seed = 20261113;
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
    // Sizes of every kind: none at all, a hair, those of cards and strips, and far larger.
    const length = () => [0, 0, 1e-7, 0.5, 1, 8, 40, 45, 96, 300, 380, 2000, 1e6][Math.floor(random() * 13)]! * (random() < 0.5 ? 1 : 0.5 + random());
    const place = () => (random() - 0.5) * [10, 2000, 1e6][Math.floor(random() * 3)]!;
    for (let turn = 0; turn < 20000; turn++) {
      const card = { left: place(), top: place(), width: length(), height: length() };
      const room = { left: place(), top: place(), width: length(), height: length() };
      const there = inStrip(card, room);
      for (const [name, value] of Object.entries(there)) assert.ok(Number.isFinite(value), `${name} is ${value} for ${say(card, room)}`);
      assert.ok(there.scale > 0 && there.scale <= 1, `shrunk to ${there.scale} for ${say(card, room)}`);
      assert.deepEqual([there.width, there.height], [card.width, card.height], "the card keeps its own size, around another middle");
      // Sizes of a million pixels leave a hair of rounding: a thousandth of a pixel is allowed for it.
      assert.ok(inside(middle(there), room, 1e-3), `the middle ${JSON.stringify(middle(there))} is outside for ${say(card, room)}`);
      // Where the shrunk card fits the strip, the whole of it is inside.
      const [width, height] = [card.width * there.scale, card.height * there.scale];
      if (width <= room.width && height <= room.height) {
        const at = middle(there);
        assert.ok(inside({ x: at.x - width / 2, y: at.y - height / 2 }, room, 1e-3) && inside({ x: at.x + width / 2, y: at.y + height / 2 }, room, 1e-3), `the shrunk card reaches out of the strip for ${say(card, room)}`);
      }
      // A card that is in the strip already, whole and at its own size, stays where it is.
      if (card.width <= room.width && card.height <= room.height && inside({ x: card.left, y: card.top }, room, 0) && inside({ x: card.left + card.width, y: card.top + card.height }, room, 0)) {
        assert.ok(there.scale === 1 && Math.abs(there.left - card.left) < 1e-3 && Math.abs(there.top - card.top) < 1e-3, `a card inside the strip was moved for ${say(card, room)}`);
      }
    }
  });

  it("gives numbers for sizes that are none: a strip or a card with no width, no height, or a size that is not a number", () => {
    for (const [card, room] of [
      [{ left: 10, top: 10, width: 300, height: 100 }, { left: 500, top: 0, width: 0, height: 0 }],
      [{ left: 10, top: 10, width: 0, height: 0 }, { left: 500, top: 0, width: 40, height: 600 }],
      [{ left: 10, top: 10, width: 300, height: 100 }, { left: 500, top: 0, width: 40, height: 0 }],
      [{ left: 10, top: 10, width: Number.NaN, height: -5 }, { left: 500, top: 0, width: Number.POSITIVE_INFINITY, height: Number.NaN }],
    ] as Array<[Box, Box]>) {
      const there = inStrip(card, room);
      for (const [name, value] of Object.entries(there)) assert.ok(Number.isFinite(value), `${name} is ${value} for ${say(card, room)}`);
      assert.ok(there.scale > 0 && there.scale <= 1);
    }
    assert.deepEqual(middle(inStrip({ left: 10, top: 10, width: 300, height: 100 }, { left: 500, top: 7, width: 0, height: 0 })), { x: 500, y: 7 }, "a strip that is a point has the card's middle on it");
  });
});

describe("what a reading of the plan changed on the board", () => {
  const board = (tasks: Array<[Task, string]>, changes: Partial<Board> = {}): Board => ({ scope: "all", context: context(), tasks: new Map(tasks.map(([one, column]) => [one.id, { task: one, column }])), ...changes });
  const one = (id: string, changes: Partial<Task> = {}) => task({ id, ...changes });
  const told = (before: Board, now: Board, collapsed: string[] = []) => {
    const { cards, strips } = boardChanges(before, now, (column) => collapsed.includes(column));
    return { cards: [...cards].sort(), strips: [...strips].sort() };
  };
  const before = board([[one("T-1"), "next"], [one("T-2"), "next"], [one("T-3"), "in_review"], [one("T-4"), "done"]]);

  it("marks a task that is new on the board, one in another column and one whose card shows something else, whether or not a card is drawn for it", () => {
    assert.deepEqual(told(before, board([...before.tasks.values()].map(({ task: same, column }) => [{ ...same }, column] as [Task, string]))), { cards: [], strips: [] }, "the same plan read again changes nothing");
    const now = board([
      [one("T-1", { title: "Another title" }), "next"],
      [one("T-2", { description: "Another description." }), "next"],
      [one("T-3", { status: "done" }), "done"],
      [one("T-4"), "done"],
      [one("T-5"), "next"],
    ]);
    // Nothing here says which tasks have a card: the fifty-first of its column is marked as the first is.
    assert.deepEqual(told(before, now), { cards: ["T-1", "T-3", "T-5"], strips: [] }, "another title, another column and a new task; not what no card shows");
    assert.deepEqual(told(before, now, ["next"]), { cards: ["T-1", "T-3", "T-5"], strips: ["next"] }, "collapsed, the column they are in is marked too");
    assert.deepEqual(told(before, now, ["in_review", "done"]), { cards: ["T-1", "T-3", "T-5"], strips: ["done", "in_review"] }, "a task that went from one collapsed column to another marks both");
  });

  it("marks the strip a task left and not the task, when the task is gone from the board", () => {
    const now = board([[one("T-1"), "next"], [one("T-2"), "next"], [one("T-4"), "done"]]);
    assert.deepEqual(told(before, now, ["in_review"]), { cards: [], strips: ["in_review"] });
    assert.deepEqual(told(before, now), { cards: [], strips: [] }, "from an open column, nothing is left to mark");
    // It comes back with a later reading: that is news of its own.
    assert.deepEqual(told(now, before, ["in_review"]), { cards: ["T-3"], strips: ["in_review"] });
  });

  it("marks nothing on a board that is narrowed to something else than it was", () => {
    const now = board([[one("T-1", { title: "Another title" }), "next"], [one("T-9"), "next"]], { scope: "one project" });
    assert.deepEqual(told(before, now, ["next", "in_review", "done"]), { cards: [], strips: [] });
  });

  it("goes by what the cards went by at each of the two readings", () => {
    const [here, there] = [one("T-1", { contained_in: ["T-2", "WEB"] }), one("T-1", { contained_in: ["T-2", "WEB"] })];
    const named = (title: string) => ({ ...context(), byId: new Map([["T-2", { title }]]) });
    assert.deepEqual(told(board([[here, "next"]], { context: named("A group") }), board([[there, "next"]], { context: named("A group") })), { cards: [], strips: [] });
    assert.deepEqual(told(board([[here, "next"]], { context: named("A group") }), board([[there, "next"]], { context: named("A group, renamed") })).cards, ["T-1"], "the group's title is on the card of the task it holds");
  });
});

describe("the marks of what changed", () => {
  it("are never more than there is to mark, and none once their time is up: 10,000 changes, read after read", () => {
    const marks: Marks = new Map();
    const LASTS = 6000;
    const tasks = Array.from({ length: 10_000 }, (_, at) => task({ id: `BIG-${at}`, title: `Task ${at}` }));
    const boardOf = (round: number): Board => ({ scope: "all", context: context(), tasks: new Map(tasks.map((each) => [each.id, { task: { ...each, title: `${each.title}, round ${round}` }, column: "next" }])) });
    let clock = 0;
    let before = boardOf(0);
    const onBoard = (name: string) => before.tasks.has(name) || name === "column next";
    let most = 0;
    // A reading every second for a minute, each one changing every task: the marks are those of the board, no more.
    for (let round = 1; round <= 60; round++) {
      clock += 1000;
      const now = boardOf(round);
      const { cards, strips } = boardChanges(before, now, () => true);
      assert.equal(cards.size, 10_000);
      setMarks(marks, [...cards, ...[...strips].map((column) => `column ${column}`)], clock, now.scope);
      before = now;
      forgetMarks(marks, clock, LASTS, onBoard);
      most = Math.max(most, marks.size);
    }
    assert.equal(most, 10_001, "one mark for each task and one for the strip, however many readings changed them");
    // A moment before their time is up they are all there; when it is up, none is.
    forgetMarks(marks, clock + LASTS - 1, LASTS, onBoard);
    assert.equal(marks.size, 10_001);
    forgetMarks(marks, clock + LASTS, LASTS, onBoard);
    assert.equal(marks.size, 0, "nothing is kept once the time is up");
  });

  it("go with their tasks when the tasks are gone from the board, before their time is up", () => {
    const marks: Marks = new Map();
    setMarks(marks, ["WEB-001", "WEB-002", "column done"], 100, "all");
    forgetMarks(marks, 200, 6000, (name) => name === "WEB-002" || name === "column done");
    assert.deepEqual([...marks.keys()], ["WEB-002", "column done"]);
    forgetMarks(marks, 6100, 6000, () => true);
    assert.deepEqual([...marks.keys()], []);
  });

  it("belong to the board they were made on: on a board narrowed to something else they are not there, the mark of a column's strip no more than that of a task, and they do not come back", () => {
    const marks: Marks = new Map();
    setMarks(marks, ["WEB-001", "column done"], 100, "all projects");
    assert.deepEqual([markedAt(marks, "WEB-001", "all projects"), markedAt(marks, "column done", "all projects")], [100, 100]);
    // The same task and the same column are on the board of one project too: their marks are of the other board.
    assert.deepEqual([markedAt(marks, "WEB-001", "one project"), markedAt(marks, "column done", "one project"), markedAt(marks, "WEB-002", "all projects")], [undefined, undefined, undefined]);
    // The page clears them when it draws another board, so that they do not come back with the first one.
    marks.clear();
    assert.equal(markedAt(marks, "column done", "all projects"), undefined, "back on the first board in time, nothing is marked");
    // A reading of the plan on the same board leaves a mark until its time is up, and marks what it changed.
    setMarks(marks, ["column done"], 300, "one project");
    forgetMarks(marks, 400, 6000, () => true);
    assert.equal(markedAt(marks, "column done", "one project"), 300);
    setMarks(marks, ["WEB-003"], 500, "one project");
    assert.deepEqual([...marks.keys()], ["column done", "WEB-003"]);
    forgetMarks(marks, 6300, 6000, () => true);
    assert.deepEqual([...marks.keys()], ["WEB-003"], "each for its own six seconds");
  });
});
