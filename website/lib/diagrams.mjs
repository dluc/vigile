// What the diagrams of the site mean, in a form a program can hold them to. Beside each drawing in
// website/diagrams/ lies a model, <name>.json: the items the drawing names, the names of the program it uses, and
// for a drawing that shows a plan, the plan itself as a scenario: its items, their statuses and their links.
// A scenario is built in a real service, and what the service works out of it is what the drawing has to show and
// what the caption is made from. So a drawing, its caption and the service cannot say three different things.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../diagrams/", import.meta.url));

/** The model that lies beside a drawing, or null when it has none. */
export function modelOf(name) {
  const file = `${root}${name}.json`;
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

const unescape = (text) => text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

/** Every piece of text of a drawing, each with where it stands. A text with parts in it is one text. */
export function textsOf(svg) {
  return [...svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)].map((match) => ({
    x: Number(/\bx="([\d.]+)"/.exec(match[1])?.[1] ?? NaN),
    y: Number(/\by="([\d.]+)"/.exec(match[1])?.[1] ?? NaN),
    middle: /text-anchor="middle"/.test(match[1]),
    text: unescape(match[2].replace(/<[^>]+>/g, "")).trim(),
  }));
}

/** What a drawing says in words to those who do not see it. */
export const describedAs = (svg) => unescape(/<desc[^>]*>([\s\S]*?)<\/desc>/.exec(svg)?.[1] ?? "").trim();

/** The names in a drawing that are names of something: IDs of items, and words written as the program writes its names. */
export function namesIn(svg) {
  const all = [...textsOf(svg).map((one) => one.text), describedAs(svg)].join(" ");
  return {
    ids: [...new Set(all.match(/\b[A-Z]{2,8}-\d{3}\b/g) ?? [])].sort(),
    terms: [...new Set(all.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])].sort(),
  };
}

/**
 * A drawing of tasks in a row, as website/diagrams/next.svg is: a box for each task with its ID, its title and
 * its status, an arrow from each task to the one that waits for it, and under each box what is worked out of it.
 */
export function chainOf(svg) {
  const rects = [...svg.matchAll(/<rect\b([^>]*)\/>/g)].map((match) => {
    const of = (name) => Number(new RegExp(`\\b${name}="([\\d.]+)"`).exec(match[1])?.[1]);
    return { x: of("x"), y: of("y"), width: of("width"), height: of("height"), kind: /class="([^"]*)"/.exec(match[1])?.[1] ?? "" };
  });
  const texts = textsOf(svg);
  const inside = (rect) => texts.filter((one) => one.x >= rect.x && one.x <= rect.x + rect.width && one.y > rect.y && one.y < rect.y + rect.height).map((one) => one.text);
  const boxes = rects.filter((rect) => rect.kind === "box").sort((a, b) => a.x - b.x);
  const tasks = boxes.map((rect) => {
    const [id, title, status] = inside(rect);
    return { id, title, status: /^status: (\S+)$/.exec(status ?? "")?.[1] ?? null, left: rect.x, right: rect.x + rect.width };
  });
  // An arrow runs from the right edge of one box to the left edge of the next: from what has to finish to what waits.
  const arrows = [...svg.matchAll(/<path d="M([\d.]+) [\d.]+H([\d.]+)" class="wire" marker-end/g)].map((match) => {
    const from = tasks.find((task) => Math.abs(task.right - Number(match[1])) <= 4);
    const to = tasks.find((task) => Math.abs(task.left - Number(match[2])) <= 4);
    return { from: from?.id ?? null, to: to?.id ?? null };
  });
  const workedOut = Object.fromEntries(
    rects
      .filter((rect) => /^box-(sunk|go|wait)$/.test(rect.kind))
      .map((rect) => {
        const task = tasks.find((one) => one.left === rect.x);
        return [task?.id ?? `at ${rect.x}`, inside(rect).join(" ")];
      }),
  );
  return { tasks: tasks.map(({ id, title, status }) => ({ id, title, status })), arrows, workedOut, notes: texts.filter((one) => one.y > Math.max(...rects.map((rect) => rect.y + rect.height))).map((one) => one.text) };
}

/**
 * Builds the plan of a scenario in a service and says what the service works out of each of its tasks. `call`
 * runs an operation. The IDs the service gives are its own: the answer is told in the IDs of the scenario.
 */
export async function runScenario(scenario, call, moves) {
  const ids = new Map();
  const mine = (id) => ids.get(id) ?? assertKnown(id);
  const assertKnown = (id) => {
    throw new Error(`The scenario names ${id} before it makes it.`);
  };
  const theirs = (id) => [...ids].find(([, given]) => given === id || given === `task:${id}` || given === `project:${id}`)?.[0] ?? id;
  const route = (from, to) => {
    const queue = [[from]];
    for (const path of queue) {
      if (path.at(-1) === to) return path.slice(1);
      for (const step of moves[path.at(-1)]) if (!path.includes(step)) queue.push([...path, step]);
    }
    throw new Error(`No moves lead from open to ${to}.`);
  };
  const setStatus = async (id, status) => {
    for (const step of route((await call("get", { id: mine(id) })).status, status)) {
      const now = await call("get", { id: mine(id) });
      await call("set_task_status", { id: mine(id), version: now.version, status: step });
    }
  };
  for (const item of scenario.items) {
    if (item.kind === "project") {
      const project = await call("create_project", { title: item.title, prefix: item.id });
      ids.set(item.id, project.id);
      continue;
    }
    const holders = (item.in ?? []).map(mine);
    const project = (item.in ?? []).find((id) => scenario.items.find((one) => one.id === id)?.kind === "project");
    const parent = (item.in ?? []).find((id) => scenario.items.find((one) => one.id === id)?.kind !== "project");
    const task = await call("create_task", { title: item.title, description: `Made for the scenario of a diagram: ${item.title}.`, ...(item.type ? { type: item.type } : {}), ...(project ? { project: mine(project) } : {}), ...(parent ? { parent: mine(parent) } : {}), depends_on: (item.depends_on ?? []).map(mine), assigned_to: item.assigned_to ?? [] });
    void holders;
    ids.set(item.id, `task:${task.id}`);
  }
  // Statuses last, from the first task on: what a task depends on is finished before the task is started.
  for (const item of scenario.items) if (item.kind !== "project" && item.status && item.status !== "open") await setStatus(item.id, item.status);
  for (const step of scenario.then ?? []) await setStatus(step.id, step.status);
  const seen = {};
  for (const item of scenario.items) {
    const read = await call("get", { id: mine(item.id).replace(/^project:/, ""), ...(item.kind === "project" ? { kind: "project" } : {}) });
    seen[item.id] = {
      status: read.status,
      ...(item.kind === "project" ? {} : { is_next: read.is_next, is_waiting: read.is_waiting, waiting_for: read.waiting_for.map(theirs) }),
      ...(read.progress ? { progress: read.progress } : {}),
      problems: (read.problems ?? []).map((problem) => problem.code),
    };
  }
  return seen;
}

/**
 * The words under a drawing of tasks in a row, made from its scenario and from what the service worked out of
 * it: which task is done, which is next, which waits for which, and that only statuses and links are stored.
 */
export function captionOfChain(scenario, seen, finished) {
  const name = (id) => scenario.items.find((item) => item.id === id).name;
  const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
  const tasks = scenario.items.filter((item) => item.kind !== "project");
  const done = tasks.filter((item) => finished.includes(seen[item.id].status));
  const next = tasks.filter((item) => seen[item.id].is_next);
  const waiting = tasks.filter((item) => seen[item.id].is_waiting);
  if (done.length !== 1 || next.length !== 1 || !(next[0].depends_on ?? []).includes(done[0].id)) throw new Error("The scenario of this diagram is not one finished task with one next task behind it: its caption needs other words, in captionOfChain.");
  const waits = waiting.map((item) => `${name(item.id)} waits for ${seen[item.id].waiting_for.map(name).join(" and ")}`);
  const list = waits.length < 2 ? waits.join("") : `${waits.slice(0, -1).join(", ")}, and ${waits.at(-1)}`;
  return `${capital(name(done[0].id))} is done, so ${name(next[0].id)} is next. ${capital(list)}. The statuses and the links are what is stored; next and waiting are worked out from them each time they are read.`;
}

/** What a drawing of tasks in a row says to those who do not see it, made the same way. */
export function descriptionOfChain(scenario, seen, finished) {
  const tasks = scenario.items.filter((item) => item.kind !== "project");
  const numbers = ["No", "One", "Two", "Three", "Four", "Five", "Six"];
  const and = (names) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
  const by = (status) => tasks.filter((item) => seen[item.id].status === status).map((item) => item.id);
  const stored = [...new Set(tasks.map((item) => seen[item.id].status))].map((status) => `${and(by(status))} ${by(status).length === 1 ? "is" : "are"} ${status.replaceAll("_", " ")}`);
  const worked = tasks.map((item) => (finished.includes(seen[item.id].status) ? `${item.id} is finished` : seen[item.id].is_next ? `${item.id} is next` : `${item.id} waits for ${and(seen[item.id].waiting_for)}`));
  return `${numbers[tasks.length]} tasks in a chain of dependencies. Stored: ${stored.join("; ")}. Worked out on every read: ${worked.slice(0, -1).join(", ")}, and ${worked.at(-1)}.`;
}
