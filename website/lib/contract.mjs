// What the service does, found out by asking it: what an answer carries, what a conflict hands back, which
// end of a link gets the change into its history, what a refusal leaves behind. These are the facts the pages
// state about behaviour. They are worked out here from a real service, started through the program and spoken
// to over its HTTP API (website/lib/program.mjs), which is put through each case, and the pages are made from
// them or held to them by the tests: so a sentence about what "every" operation does cannot outlive the
// service that made it true.
//
// Nothing here reads the product's code. What an input takes is read from the description the program prints
// (website/lib/facts.mjs); what the service does is seen by letting it do it.

import { readdirSync } from "node:fs";
import { captionOfChain, descriptionOfChain, modelOf, runScenario } from "./diagrams.mjs";
import { demoService } from "./examples.mjs";
import { Refused, startService } from "./program.mjs";

const sorted = (values) => [...values].sort();

/** Of several answers about items of one kind: the fields that every one has, and those that only some have. */
function fieldsOf(items) {
  if (!items.length) throw new Error("No item of a kind was seen: the facts about its fields cannot be told.");
  const all = new Set(items.flatMap((item) => Object.keys(item)));
  const always = [...all].filter((field) => items.every((item) => Object.hasOwn(item, field)));
  return { always, sometimes: [...all].filter((field) => !always.includes(field)) };
}

/** What kind of answer this is, in a word, and of what. Each operation's page says it, and the test names it for each operation. */
export function answerOf(answer) {
  if (answer === null || typeof answer !== "object") return { category: "other", says: "something else" };
  const has = (field) => Object.hasOwn(answer, field);
  // The answer of a delete names the kind and the ID of what was deleted: it is not the item.
  if (has("deleted") && has("permanent")) return { category: "deleted", says: "that it was deleted, whether for good, and the kind and ID of the item" };
  if (has("kind") && has("links")) return { category: "detail", kind: answer.kind, says: `the ${answer.kind} in full` };
  if (has("kind")) return { category: "summary", kind: answer.kind, says: `the ${answer.kind} in short` };
  for (const [field, of] of [["tasks", "task"], ["projects", "project"], ["users", "user"]]) if (has(field)) return { category: "list", kind: of, says: `a list of ${field}, each in short` };
  if (has("changes")) return { category: "changes", says: "recorded changes across the plan, newest first" };
  if (has("claims") && has("attention_after_hours")) return { category: "claims", says: "quiet claims that need attention and the threshold that brought them to attention" };
  if (has("link_types")) return { category: "link-types", says: "the link types" };
  if (has("link")) return { category: "link", says: has("created") ? "the link, and whether it was made now" : "the link that was removed" };
  if (has("api_key")) return { category: "key", says: "the user and its API key" };
  if (has("topic") && has("text")) return { category: "guide", says: "a topic of the guide" };
  return { category: "other", says: "something else" };
}

/** A sentence part that lists names: "a, b and c". */
export const listed = (names, last = "and") => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} ${last} ${names.at(-1)}`);

/**
 * The guards that stand before the API and the MCP endpoint, and whom each one concerns. These are stated, not
 * worked out. A test starts a service through the program and holds every line of this to what it answers.
 */
export const GUARDS = [
  {
    id: "other-site",
    name: "Pages of other sites",
    on: ["/api", "/mcp"],
    refuses: "a request that says it comes from a page of another site: with an Origin that is not the address the request was sent to, or with a Sec-Fetch-Site that is neither same-origin nor none",
    concerns: "Only what sends those headers, which is browsers. A program that sends neither is not looked at by this guard",
    code: "forbidden",
  },
  {
    id: "host",
    name: "The name it is called by",
    on: ["/api", "/mcp"],
    refuses: "while the service listens on this machine only, a request whose Host is neither localhost, nor a loopback address, nor the address in the config",
    concerns: "Every client, a browser or not: a program that calls the service by another name is refused as well",
    code: "forbidden",
  },
  {
    id: "json",
    name: "A body that says what it is",
    on: ["/api"],
    refuses: "a request with a body that does not say Content-Type: application/json",
    concerns: "Every client, a browser or not",
    code: "invalid_input",
  },
];

/**
 * What the service does when it starts, step by step, and what has happened to the data folder by the time each
 * step can fail with cannot_start. Stated, like the guards. A test starts a real service into each failure that
 * can be brought about from outside, and looks at the folder.
 */
export const STARTUP = [
  {
    id: "take",
    does: "Takes the data folder for itself",
    fails: "Another service, a restore or a command holds the folder, or the folder cannot be written",
    by: "Nothing in the folder has been changed",
    changed: false,
  },
  {
    id: "recover",
    does: "Puts a restore that was interrupted in order",
    fails: "A backup of the folder is being taken, so the restore cannot be put in order yet",
    by: "Nothing more than in the step before",
    changed: false,
  },
  {
    id: "open",
    does: "Opens the plan. A folder that is new gets its data file and the three built-in users",
    fails: "The setting auth.keyless_user names a user that does not exist",
    by: "An interrupted restore has been put in order, a new folder has its data file, and data that an earlier version wrote has been brought to the present format",
    changed: true,
  },
  {
    id: "listen",
    does: "Listens on the address and port",
    fails: "The port is taken, or the machine has no such address",
    by: "The same: the restore is in order, a new folder has its data file with the built-in users, and data of an earlier format has been brought to the present one",
    changed: true,
  },
];

/**
 * What an error called `internal` leaves behind. Stated, like the guards: a store that fails cannot be brought
 * about by running the program, so the build does not see these. The first is seen by a test, on a service whose
 * config file cannot be written; the other two say what the documentation of the product says, and nothing
 * here can hold them to it.
 */
export const INTERNAL = [
  { case: "stored, then the key could not be", code: "internal", message: "User keyless was created, but its API key could not be stored, so it cannot connect yet.", stored: true },
  { case: "store failed before it wrote", code: "internal", message: "The service hit an unexpected error. The change was not confirmed.", stored: false },
  { case: "store failed after it wrote", code: "internal", message: "The service hit an unexpected error. The change was not confirmed.", stored: true },
];

/** A byte more than the service reads of one request to its API, by what the program says that is. */
export const tooLarge = (facts) => facts.apiBodyBytes + 1;

/**
 * What a refusal leaves behind, seen on a service of its own: a call that is refused with each code a call
 * can be refused with from outside, each with whether the plan had changed when the refusal was given. Whether
 * it had is asked of the service: the number of the plan as it is stored goes up with every change.
 */
async function readOutcomes(facts) {
  const service = await startService();
  try {
    const task = await service.call("create_task", { title: "A task", description: "Made to see what an error leaves." });
    const id = `task:${task.id}`;
    const outcomes = [];
    const attempt = async (name, send) => {
      const before = await service.revision();
      const error = await send();
      if (!error) throw new Error(`The case "${name}" of website/lib/contract.mjs was to end with an error, and did not.`);
      outcomes.push({ case: name, code: error.code, message: error.message, stored: (await service.revision()) !== before });
    };
    await attempt("refused: input", () => service.refusal("update_task", { id, version: 1, no_such_field: 1 }));
    await attempt("refused: not found", () => service.refusal("update_task", { id: "task:999", version: 1, priority: 1 }));
    await attempt("refused: forbidden", () => service.refusal("delete", { id, version: 1, permanent: true }));
    await attempt("refused: version", () => service.refusal("update_task", { id, version: 9, priority: 1 }));
    await attempt("refused: rule", () => service.refusal("set_task_status", { id, version: 1, status: "open" }));
    // More than the service reads of one request: a change that is announced as a body of a byte over the limit.
    await attempt("too large", async () => (await service.announce("update_task", tooLarge(facts))).error);
    // A call with a key that is none: turned away before it reaches an operation.
    let turnedAway;
    {
      const before = await service.revision();
      const response = await fetch(`${service.url}/api/update-task`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer vig_not_a_key" }, body: JSON.stringify({ id, version: 1, priority: 1 }), redirect: "error" });
      const error = (await response.json()).error;
      turnedAway = { code: error?.code, stored: (await service.revision()) !== before };
    }
    return { outcomes: [...outcomes, ...INTERNAL], turnedAway };
  } finally {
    await service.stop();
  }
}

/** The diagrams that show a plan: each one's scenario built in a service of its own, and what is worked out of it. */
async function readDiagrams(facts) {
  const names = readdirSync(new URL("../diagrams/", import.meta.url))
    .filter((name) => name.endsWith(".json"))
    .map((file) => file.slice(0, -5))
    .filter((name) => modelOf(name).scenario);
  const seen = await Promise.all(
    names.map(async (name) => {
      const service = await startService();
      try {
        return await runScenario(modelOf(name).scenario, (operation, input) => service.call(operation, input), facts.taskMoves);
      } finally {
        await service.stop();
      }
    }),
  );
  const diagrams = {};
  names.forEach((name, index) => {
    const { scenario } = modelOf(name);
    diagrams[name] = { seen: seen[index], ...(name === "next" ? { caption: captionOfChain(scenario, seen[index], facts.taskFinished), description: descriptionOfChain(scenario, seen[index], facts.taskFinished) } : {}) };
  });
  return diagrams;
}

/**
 * Works the facts out. `facts` is what the program says of itself, as website/lib/facts.mjs reads it: its
 * operations, the link types, the statuses of a task and the moves between them.
 */
export async function readContract(facts) {
  const [plan, { outcomes, turnedAway }, diagrams] = await Promise.all([readPlan(facts), readOutcomes(facts), readDiagrams(facts)]);
  return {
    ...plan,
    /** What an error leaves behind: each case with its code, its message, and whether the plan had changed. The cases of `internal` are stated, the others seen. */
    outcomes,
    /** A call with a key that is none: its code, and whether the plan had changed. */
    turnedAway,
    /** What the service works out of the plan each diagram shows, and for a diagram of tasks in a row, its caption. */
    diagrams,
  };
}

/** What a service that holds the made-up plan does, case by case. */
async function readPlan(facts) {
  const service = await demoService();
  try {
    return await seenOn(service, facts);
  } finally {
    await service.stop();
  }
}

async function seenOn(service, facts) {
  const { operations, linkTypes } = facts;
  const model = { taskStatuses: facts.taskStatuses, taskMoves: facts.taskMoves };
  // Which operations take a version, and which lists a continuation token: read from the operations' inputs,
  // as the description has them.
  const { versioned, paged, wholeLists } = facts.inputs;

  const admin = (operation, input) => service.call(operation, input, "admin");
  const agent = (operation, input) => service.call(operation, input, "agent1");
  /** What a call is refused with, or null when it is not refused. */
  const refusalOf = async (call) => {
    try {
      await call();
    } catch (error) {
      if (error instanceof Refused) return error.refusal;
      throw error;
    }
    return null;
  };
  const everyTask = async () => (await agent("list_tasks", {})).tasks;

  // ---- The three refusals the first page of the site names: each says what would resolve it. Seen before anything is changed.
  const statusRefusals = [];
  {
    const all = await everyTask();
    const cases = [
      [all.find((task) => task.is_waiting && task.status === "open"), "in_progress"],
      [all.find((task) => task.progress && task.progress.finished < task.progress.total && !task.is_waiting), "done"],
      [all.find((task) => task.status === "open" && !task.is_waiting && !task.progress), "in_review"],
    ];
    for (const [task, status] of cases) {
      if (!task) throw new Error("The made-up plan has no task for one of the refusals website/lib/contract.mjs looks at.");
      const refused = await refusalOf(() => agent("set_task_status", { id: task.id, version: task.version, status }));
      if (refused?.code !== "rule_violation") throw new Error(`Setting ${task.id} to ${status} was to be refused by a rule: ${JSON.stringify(refused)}`);
      statusRefusals.push({ rule: refused.rule, actions: Array.isArray(refused.actions) && refused.actions.length > 0, blocking: Array.isArray(refused.blocking) && refused.blocking.length > 0 });
    }
  }

  // ---- Who may call is asked before what is sent is looked at: an operation for admins, called by someone else with input it does not take.
  const adminOnly = operations.filter((operation) => operation.access !== "all").map((operation) => operation.name);
  const accessFirst = [];
  for (const name of adminOnly) accessFirst.push((await refusalOf(() => agent(name, { no_such_field: 1 })))?.code === "forbidden");
  // And every operation refuses a field it does not know, before it does anything.
  const strict = [];
  for (const operation of operations) {
    const refused = await refusalOf(() => admin(operation.name, { no_such_field: 1 }));
    if (refused?.code === "invalid_input") strict.push(operation.name);
  }

  // ---- What an answer carries, by kind. Seen on the plan as it is, and after the changes below, so that what is
  // sent only when there is something to say is seen as well.
  const tasks = [...(await everyTask())];
  const projects = [...(await agent("list_projects", {})).projects];
  const users = [...(await agent("list_users", {})).users];
  // A dependency is reopened after what needed it went on: a problem, on the task and on its project.
  const done = tasks.find((task) => task.status === "done" && tasks.some((other) => other.depends_on.includes(task.id) && other.status === "in_review"));
  await service.call("set_task_status", { id: done.id, version: done.version, status: "open" }, "agent2");
  tasks.push(...(await everyTask()));
  projects.push(...(await agent("list_projects", {})).projects);

  // ---- What a conflict hands back: every operation that takes a version, sent a version that is not the item's.
  const conflict = {};
  const free = (await everyTask()).find((task) => task.status === "open" && !task.depends_on.length && !task.progress);
  const attempts = {
    update_task: [agent, { id: free.id, version: 999, priority: 1 }],
    set_task_status: [agent, { id: free.id, version: 999, status: "in_progress" }],
    override_timestamp: [agent, { id: free.id, version: 999, name: "created_at", value: "2026-01-01T00:00:00Z" }],
    delete: [agent, { id: free.id, version: 999 }],
    set_project_status: [agent, { id: projects[0].id, version: 999, status: "ready" }],
  };
  for (const name of versioned) {
    if (!attempts[name]) throw new Error(`The operation ${name} takes a version, and website/lib/contract.mjs has no call that sends it a wrong one. Add one to "attempts".`);
    const [as, input] = attempts[name];
    const refused = await refusalOf(() => as(name, input));
    if (refused?.code !== "version_conflict" || !refused.current) throw new Error(`${name} with a wrong version was not refused with a conflict that holds the item: ${JSON.stringify(refused)}`);
    conflict[name] = { kind: refused.current.kind, fields: sorted(Object.keys(refused.current)), category: answerOf(refused.current).category };
    (refused.current.kind === "task" ? tasks : projects).push(refused.current);
  }
  // And an operation that takes none goes through whatever the item's version is: seen for each that changes an item it is given.
  const unversioned = operations.filter((operation) => operation.kind === "write" && !versioned.includes(operation.name)).map((operation) => operation.name);

  // ---- Deleted items say so: seen in the item a conflict hands back, and in a full reading.
  const gone = await agent("create_task", { title: "A task that is deleted again", description: "Made to see what a deleted task says." });
  await agent("delete", { id: gone.id, version: gone.version });
  tasks.push((await refusalOf(() => agent("delete", { id: gone.id, version: 999 }))).current);
  const emptied = await agent("create_project", { title: "A project that is deleted again", prefix: "GONE" });
  await agent("delete", { id: "GONE", version: emptied.version });
  projects.push((await refusalOf(() => agent("delete", { id: "GONE", version: 999 }))).current);
  const { user: leaving } = await admin("create_user", { username: "leaving", type: "agent" });
  await admin("delete", { id: "leaving", kind: "user", version: leaving.version });
  users.push((await refusalOf(() => admin("delete", { id: "leaving", kind: "user", version: 999 }))).current);

  // ---- A task whose group is deleted says which live items hold it now: seen in a list, with the group deleted over it.
  const above = await agent("create_task", { title: "A group that stays", description: "Made to see what a task says when the group between is deleted." });
  const between = await agent("create_task", { title: "A group that is deleted over its task", description: "Made to be deleted.", parent: above.id });
  const below = await agent("create_task", { title: "A task whose group is deleted", description: "Made to see what it says of its containers.", parent: between.id });
  await agent("delete", { id: between.id, version: (await agent("get", { id: between.id })).version });
  tasks.push((await everyTask()).find((task) => task.id === below.id));

  // ---- A full reading: what it adds to the short form, and what it says of each linked item.
  const busy = (await everyTask()).find((task) => task.assigned_to.length && task.depends_on.length && task.contained_in.length > 1);
  const details = {
    task: await agent("get", { id: busy.id }),
    project: await agent("get", { id: projects[0].id, kind: "project" }),
    user: await agent("get", { id: busy.assigned_to[0], kind: "user" }),
  };
  const summaries = { task: fieldsOf(tasks), project: fieldsOf(projects), user: fieldsOf(users) };
  const detailAdds = Object.fromEntries(Object.entries(details).map(([kind, detail]) => [kind, Object.keys(detail).filter((field) => !summaries[kind].always.includes(field) && !summaries[kind].sometimes.includes(field))]));
  const withHistory = Object.keys(await agent("get", { id: busy.id, history: true })).filter((field) => !Object.hasOwn(details.task, field));
  const linkedSeen = { project: [], task: [], user: [] };
  for (const detail of [...Object.values(details), await agent("get", { id: gone.id }), await agent("get", { id: "GONE", kind: "project" })]) {
    for (const items of Object.values(detail.links)) for (const item of items) linkedSeen[item.kind].push(item);
  }
  // A linked item that is deleted says so: the deleted task is linked from nothing yet, so it is put into a group first.
  const holder = await agent("create_task", { title: "A group with a deleted task in it", description: "Made to see what a link to a deleted task says." });
  const inside = await agent("create_task", { title: "The deleted task", description: "Made to be deleted.", parent: holder.id });
  await agent("delete", { id: inside.id, version: inside.version });
  for (const items of Object.values((await agent("get", { id: holder.id })).links)) for (const item of items) linkedSeen[item.kind].push(item);
  // The same for a linked project and a linked user that are deleted: a task that waits for the one and was given to the other.
  const waited = await agent("create_project", { title: "A project that is waited for and deleted" });
  const { user: given } = await admin("create_user", { username: "given", type: "agent" });
  const waiting = await agent("create_task", { title: "A task whose project and user are deleted", description: "Made to see what its links say.", depends_on: [`project:${waited.id}`], assigned_to: ["given"] });
  await agent("delete", { id: waited.id, kind: "project", version: waited.version });
  // A user can be deleted once no live task is assigned to it.
  await agent("delete", { id: waiting.id, version: waiting.version });
  await admin("delete", { id: "given", kind: "user", version: given.version });
  for (const items of Object.values((await agent("get", { id: waiting.id })).links)) for (const item of items) linkedSeen[item.kind].push(item);
  const linked = Object.fromEntries(Object.entries(linkedSeen).map(([kind, items]) => [kind, fieldsOf(items)]));

  // ---- Which end of a link gets the change into its history, and whose version moves: each type, between each
  // pair of kinds it joins, added and removed again.
  const linkHistory = [];
  let made = 0;
  const fresh = {
    task: async () => (await agent("create_task", { title: `A task to link, ${++made}`, description: "Made to see what a link does." })).id,
    project: async () => (await agent("create_project", { title: `A project to link, ${++made}` })).id,
    user: async () => (await admin("create_user", { username: `linked${++made}`, type: "agent" })).user.username,
  };
  const state = async (id, kind) => {
    const item = await agent("get", { id, kind, history: true });
    return { version: item.version, entries: item.history.map((entry) => entry.action) };
  };
  for (const type of linkTypes) {
    for (const from of type.from) {
      for (const to of type.to) {
        const ends = { from: await fresh[from](), to: await fresh[to]() };
        const before = { from: await state(ends.from, from), to: await state(ends.to, to) };
        await agent("add_link", { from: from === "project" ? `project:${ends.from}` : ends.from, type: type.type, to: to === "project" ? `project:${ends.to}` : ends.to });
        const added = { from: await state(ends.from, from), to: await state(ends.to, to) };
        await agent("remove_link", { from: from === "project" ? `project:${ends.from}` : ends.from, type: type.type, to: to === "project" ? `project:${ends.to}` : ends.to });
        const removed = { from: await state(ends.from, from), to: await state(ends.to, to) };
        const gained = (end, earlier, later, action) => later[end].entries.filter((entry) => entry === action).length > earlier[end].entries.filter((entry) => entry === action).length;
        linkHistory.push({
          type: type.type,
          from,
          to,
          // Which end's history says that the link was added, and that it was removed.
          history: { from: gained("from", before, added, "link_added") && gained("from", added, removed, "link_removed"), to: gained("to", before, added, "link_added") && gained("to", added, removed, "link_removed") },
          // Whose version went up with the link, and again with its removal.
          version: { from: added.from.version > before.from.version && removed.from.version > added.from.version, to: added.to.version > before.to.version && removed.to.version > added.to.version },
        });
      }
    }
  }
  for (const row of linkHistory) {
    for (const end of ["from", "to"]) {
      const one = linkHistory.find((other) => other[end] === row[end] && other.history[end] !== row.history[end] && other.type === row.type);
      if (one) throw new Error(`Whether a ${row[end]} at the ${end} end of "${row.type}" gets the link into its history is not the same in every case: the facts about link history need another shape.`);
    }
  }

  // ---- A delete for good takes the item's links with it. What stays behind says so in its history, or does not.
  const kept = { project: await fresh.project(), task: await fresh.task(), user: await fresh.user() };
  const doomed = await agent("create_task", { title: "A task that is deleted for good", description: "Made to see what its going leaves.", project: `project:${kept.project}`, assigned_to: [kept.user] });
  await agent("add_link", { from: kept.task, type: "depends on", to: doomed.id });
  const beforeGoing = { project: await state(kept.project, "project"), task: await state(kept.task, "task"), user: await state(kept.user, "user") };
  await admin("delete", { id: doomed.id, version: (await agent("get", { id: doomed.id })).version, permanent: true });
  const afterGoing = { project: await state(kept.project, "project"), task: await state(kept.task, "task"), user: await state(kept.user, "user") };
  const leftBehind = Object.fromEntries(Object.keys(kept).map((kind) => [kind, afterGoing[kind].entries.filter((entry) => entry === "link_removed").length > beforeGoing[kind].entries.filter((entry) => entry === "link_removed").length]));
  // The same when what goes for good is a project that a task waits for, or a user that a deleted task was given to: the task says so.
  const removals = (entries) => entries.filter((entry) => entry === "link_removed").length;
  const goingProject = await agent("create_project", { title: "A project that is deleted for good" });
  const goingUser = await fresh.user();
  const staying = await agent("create_task", { title: "A task whose project and user go for good", description: "Made to see what their going leaves.", depends_on: [`project:${goingProject.id}`], assigned_to: [goingUser] });
  let seen = await state(staying.id, "task");
  await admin("delete", { id: goingProject.id, kind: "project", version: goingProject.version, permanent: true });
  let then = await state(staying.id, "task");
  const taskHearsOfProject = removals(then.entries) > removals(seen.entries);
  await agent("delete", { id: staying.id, version: then.version });
  seen = await state(staying.id, "task");
  await admin("delete", { id: goingUser, kind: "user", version: (await agent("get", { id: goingUser, kind: "user" })).version, permanent: true });
  then = await state(staying.id, "task");
  const taskHearsOfUser = removals(then.entries) > removals(seen.entries);
  if (leftBehind.task !== taskHearsOfProject || leftBehind.task !== taskHearsOfUser) throw new Error("Whether a task records that a link is gone depends on what was deleted for good: the facts about what is left behind need another shape.");

  // ---- A task created with links: which of the items it is linked to say so.
  const hosts = { project: await fresh.project(), task: await fresh.task(), user: await fresh.user() };
  const beforeCreate = { project: await state(hosts.project, "project"), task: await state(hosts.task, "task"), user: await state(hosts.user, "user") };
  await agent("create_task", { title: "A task created with its links", description: "Made to see who hears of it.", project: `project:${hosts.project}`, depends_on: [hosts.task], assigned_to: [hosts.user] });
  const afterCreate = { project: await state(hosts.project, "project"), task: await state(hosts.task, "task"), user: await state(hosts.user, "user") };
  const createdWith = Object.fromEntries(Object.keys(hosts).map((kind) => [kind, afterCreate[kind].entries.length > beforeCreate[kind].entries.length]));

  // ---- The ID of a task: given once, when it is created, from what it is created in. Each way of creating one, and a move afterwards.
  const prefixed = await agent("create_project", { title: "A project with a prefix", prefix: "IDS" });
  const other = await agent("create_project", { title: "Another project with a prefix", prefix: "OTHER" });
  const numbered = await agent("create_project", { title: "A project with a number" });
  const newTask = (extra) => agent("create_task", { title: "A task to see its ID", description: "Made to see what ID it is given.", ...extra });
  const groupOfOther = await newTask({ project: other.id });
  const looseGroup = await newTask({});
  const taskIds = [];
  for (const [given, input] of [
    ["project", { project: prefixed.id }],
    ["project-and-parent", { project: prefixed.id, parent: groupOfOther.id }],
    ["parent", { parent: groupOfOther.id }],
    ["numbered-project-and-parent", { project: `project:${numbered.id}`, parent: groupOfOther.id }],
    ["numbered-project", { project: `project:${numbered.id}` }],
    ["numbered-parent", { parent: `task:${looseGroup.id}` }],
    ["nothing", {}],
  ]) {
    const task = await newTask(input);
    const from = task.id.startsWith(`${prefixed.id}-`) ? "project" : task.id.startsWith(`${other.id}-`) ? "parent" : /^\d+$/.test(task.id) ? "none" : null;
    if (from === null) throw new Error(`A task created with ${given} got the ID ${task.id}, which is of no shape website/lib/contract.mjs knows.`);
    taskIds.push({ given, from, id: task.id });
  }
  // Moved afterwards: out of the project it was created in, into another. And one that was in nothing, into a project.
  const mover = await newTask({ project: prefixed.id });
  await agent("add_link", { from: other.id, type: "contains", to: mover.id });
  await agent("remove_link", { from: prefixed.id, type: "contains", to: mover.id });
  const settler = await newTask({});
  await agent("add_link", { from: prefixed.id, type: "contains", to: `task:${settler.id}` });
  const afterMove = [await agent("get", { id: mover.id }), await agent("get", { id: `task:${settler.id}` })];
  const idKeptOnMove = afterMove[0].id === mover.id && afterMove[0].contained_in.join() === other.id && afterMove[1].id === settler.id && afterMove[1].contained_in.join() === prefixed.id;

  // ---- What a change does to the version: one on. And what a call does that asks for what is already so.
  const versions = {};
    {
    const t = await newTask({});
    const id = `task:${t.id}`;
    const updated = await agent("update_task", { id, version: t.version, priority: 4 });
    const again = await agent("update_task", { id, version: updated.version, priority: 4 });
    versions.update_task = { change: updated.version - t.version, same: again.version === updated.version ? "unchanged" : "moved" };
    const started = await agent("set_task_status", { id, version: again.version, status: "in_progress" });
    const sameStatus = await refusalOf(() => agent("set_task_status", { id, version: started.version, status: "in_progress" }));
    versions.set_task_status = { change: started.version - again.version, same: sameStatus?.rule ? `refused:${sameStatus.rule}` : "not refused" };
    const finished = await agent("set_task_status", { id, version: started.version, status: "done" });
    const at = (await agent("get", { id })).completed_at;
    const sameDate = await agent("override_timestamp", { id, version: finished.version, name: "completed_at", value: at });
    // The same moment written another way is the same date.
    const sameMoment = await agent("override_timestamp", { id, version: finished.version, name: "completed_at", value: at.replace(/Z$/, "+00:00") });
    // Another date is a change. The task was made a moment ago, so it is its creation that is set back: a day.
    const earlier = await agent("override_timestamp", { id, version: finished.version, name: "created_at", value: new Date(Date.parse(at) - 86_400_000).toISOString() });
    versions.override_timestamp = { change: earlier.version - finished.version, same: sameDate.version === finished.version && sameMoment.version === finished.version ? "unchanged" : "moved" };
    const deleted = await agent("delete", { id, version: earlier.version });
    const deletedAgain = await refusalOf(() => agent("delete", { id, version: earlier.version + 1 }));
    const restored = await agent("restore", { id });
    versions.delete = { change: restored.version - 1 - earlier.version, same: deletedAgain?.rule ? `refused:${deletedAgain.rule}` : "not refused" };
    versions.restore = { change: restored.version - (earlier.version + 1) };
    void deleted;
    const p = await agent("create_project", { title: "A project to see its version" });
    const ready = await agent("set_project_status", { id: p.id, version: p.version, status: "ready" });
    const readyAgain = await refusalOf(() => agent("set_project_status", { id: p.id, version: ready.version, status: "ready" }));
    versions.set_project_status = { change: ready.version - p.version, same: readyAgain?.rule ? `refused:${readyAgain.rule}` : "not refused" };
    const linkedNew = await newTask({ project: prefixed.id, depends_on: [mover.id], assigned_to: ["agent2"] });
    versions.create_task = { starts: t.version, startsWithLinks: linkedNew.version };
    versions.create_project = { starts: p.version };
  }
  for (const name of versioned) if (!versions[name]?.same) throw new Error(`The operation ${name} takes a version, and website/lib/contract.mjs does not try what a call does that asks for what is already so. Add it to "versions".`);

  // ---- Next and waiting, by the status of the task: with nothing in front of it, with something unfinished in front of it, and deleted.
  const byStatus = [];
  const pathTo = (status) => {
    const queue = [["open"]];
    const seen = new Set(["open"]);
    while (queue.length) {
      const path = queue.shift();
      if (path.at(-1) === status) return path;
      for (const next of model.taskMoves[path.at(-1)]) if (!seen.has(next)) seen.add(next) && queue.push([...path, next]);
    }
    throw new Error(`No moves lead from open to ${status}.`);
  };
  const unfinished = await newTask({});
  for (const status of model.taskStatuses) {
    let task = await newTask({});
    const id = `task:${task.id}`;
    for (const step of pathTo(status).slice(1)) task = await agent("set_task_status", { id, version: task.version, status: step });
    const alone = await agent("get", { id });
    await agent("add_link", { from: id, type: "depends on", to: `task:${unfinished.id}` });
    const held = await agent("get", { id });
    await agent("delete", { id, version: held.version });
    const gone = await agent("get", { id });
    byStatus.push({
      status,
      next: alone.is_next,
      waiting: held.is_waiting,
      waitingFor: held.waiting_for.length > 0,
      nextWhenHeld: held.is_next,
      problem: (held.problems ?? []).map((problem) => problem.code),
      deleted: { waiting: gone.is_waiting, next: gone.is_next, problems: gone.has_problems, dependsOn: gone.depends_on.length > 0 },
    });
  }
  // A task also waits when every containment path is inactive. One active alternate path makes it eligible again.
  let containerWaiting;
  {
    let inactiveGroup = await newTask({});
    const child = await newTask({ parent: inactiveGroup.id });
    inactiveGroup = await agent("set_task_status", { id: inactiveGroup.id, version: inactiveGroup.version, status: "in_progress" });
    inactiveGroup = await agent("set_task_status", { id: inactiveGroup.id, version: inactiveGroup.version, status: "paused" });
    const inactive = await agent("get", { id: child.id });
    const activeGroup = await newTask({});
    await agent("add_link", { from: `task:${activeGroup.id}`, type: "contains", to: `task:${child.id}` });
    const alternate = await agent("get", { id: child.id });
    containerWaiting = {
      inactive: { next: inactive.is_next, waiting: inactive.is_waiting, waitingFor: inactive.waiting_for },
      alternate: { next: alternate.is_next, waiting: alternate.is_waiting, waitingFor: alternate.waiting_for },
      inactiveGroup: inactiveGroup.id,
    };
  }

  return {
    startup: STARTUP,
    /** How a task gets its ID: each way of creating one, and whether the ID has the prefix of the project, of the parent's ID, or none. */
    taskIds,
    /** Whether a task keeps its ID when it is moved into another project. */
    idKeptOnMove,
    /** What a change does to the version, by operation: how far it moves, and what a call does that asks for what is already so. */
    versions,
    /** Next and waiting, for a task of each status. */
    waiting: byStatus,
    /** Waiting caused by inactive containment paths, and cleared by an alternate active path. */
    containerWaiting,
    versioned,
    unversioned,
    paged,
    /** The operations that list and answer with everything at once. */
    wholeLists,
    conflict,
    summaries,
    detailAdds,
    withHistory,
    linked,
    linkHistory,
    /** Whether an item of each kind that stays behind when a linked item is deleted for good gets that into its history. */
    leftBehind,
    /** Whether an item of each kind hears, in its history, of a task that is created with a link to it. */
    createdWith,
    guards: GUARDS,
    /** The refusals of a wrong move of status that the site names, each with whether it says what to do and what is in the way. */
    statusRefusals,
    /** The operations for admins, and whether each refuses another caller before it looks at the input. */
    adminOnly,
    accessFirst: accessFirst.every(Boolean),
    /** The operations that refuse a field they do not know. */
    strict,
  };
}
