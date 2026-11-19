import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { MemoryStorage } from "@vigile/storage";
import { ERROR_ALWAYS, ERROR_DETAIL_WORDS, Engine, GUIDE_TOPICS, LIMITS, MemoryKeyStore, OPERATIONS, PROJECT_STATUSES, REPEATED_WITHOUT_VERSION, VigileError, guide, listed, operationFacts, toHyphens, versionAdvice } from "../index.js";

/**
 * What the guide, the MCP instructions and the README say of versions and of pages is made from the operations'
 * inputs, or held to them here: an operation is said to take a version, or to answer in pages, exactly when
 * its input has the field, and what is said of a second call is what the engine does with one.
 */

async function setup() {
  let tick = Date.parse("2026-01-01T00:00:00.000Z");
  const engine = await Engine.open({ storage: new MemoryStorage(), keys: new MemoryKeyStore(), clock: { now: () => new Date((tick += 1000)) } });
  const as = (username: string) => (operation: string, input: Record<string, unknown> = {}) => engine.execute(operation, username, input) as Promise<any>;
  return { agent: as("agent1"), admin: as("admin") };
}

async function refusal(promise: Promise<unknown>): Promise<ReturnType<VigileError["toJSON"]>> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof VigileError, `expected a VigileError, got ${error}`);
    return error.toJSON();
  }
  assert.fail("expected the operation to be refused");
}

const fields = (name: string) => Object.keys(OPERATIONS.find((operation) => operation.name === name)!.input.shape);
const readme = readFileSync(new URL("../../../../README.md", import.meta.url), "utf8").replace(/\s+/g, " ");
const inCode = (names: readonly string[]) => listed(names.map((name) => `\`${name}\``));

describe("what is said of every operation", () => {
  it("names the operations that take a version, and those that change something without one, from their inputs", () => {
    const facts = operationFacts();
    for (const operation of OPERATIONS) {
      const hasVersion = fields(operation.name).includes("version");
      assert.equal(facts.versioned.includes(operation.name), hasVersion, `${operation.name}: said to take a version exactly when its input has one`);
      assert.equal(facts.unversioned.some((one) => one.name === operation.name), operation.kind === "write" && !hasVersion, `${operation.name}: said to change something without a version exactly when it does`);
      assert.ok(!hasVersion || operation.kind === "write", `${operation.name}: only an operation that changes something takes a version`);
    }
    // As they are on this branch. A change to this list is a change to what agents are told: look at the texts below.
    assert.deepEqual(facts.versioned, ["set_project_status", "update_task", "set_task_status", "delete", "override_timestamp"]);
    assert.deepEqual(facts.unversioned.map((one) => one.name), ["create_project", "create_task", "restore", "add_link", "remove_link", "create_user", "reset_user_key"]);
    assert.deepEqual(Object.keys(REPEATED_WITHOUT_VERSION).sort(), facts.unversioned.map((one) => one.name).sort(), "what a second call does is said of each of them, and of no other");
  });

  it("names the lists that answer in pages, and those that answer whole, from their inputs", () => {
    const facts = operationFacts();
    for (const operation of OPERATIONS) {
      const hasToken = fields(operation.name).includes("continuation");
      assert.equal(facts.paged.includes(operation.name), hasToken, `${operation.name}: said to answer in pages exactly when its input has a continuation`);
      assert.equal(facts.wholeLists.includes(operation.name), operation.name.startsWith("list_") && !hasToken, operation.name);
    }
    assert.deepEqual(facts.paged, ["list_projects", "list_history", "list_tasks", "list_next_tasks", "list_stale_tasks", "get", "list_users"], "the reads that answer in pages, on this branch");
    assert.deepEqual(facts.wholeLists, ["list_link_types"]);
  });

  it("says of a second call of each change without a version what the engine does with one", async () => {
    const { agent, admin } = await setup();
    const says = REPEATED_WITHOUT_VERSION;
    // An operation that takes no version does not know the field.
    for (const { name } of operationFacts().unversioned) assert.equal((await refusal(admin(name, { version: 1 }))).code, "invalid_input", `${name} takes no version`);

    assert.equal(says.create_project, "makes another project, unless it names a prefix, which is refused the second time");
    const projects = [await agent("create_project", { title: "Twice" }), await agent("create_project", { title: "Twice" })];
    assert.notEqual(projects[0].id, projects[1].id);
    await agent("create_project", { title: "Twice", prefix: "TWICE" });
    assert.equal((await refusal(agent("create_project", { title: "Twice", prefix: "TWICE" }))).rule, "prefix_taken");

    assert.equal(says.create_task, "makes another task");
    const tasks = [await agent("create_task", { title: "Twice", description: "Sent twice." }), await agent("create_task", { title: "Twice", description: "Sent twice." })];
    assert.notEqual(tasks[0].id, tasks[1].id);
    const [first, second] = tasks.map((task) => `task:${task.id}`);

    assert.equal(says.add_link, "leaves a link that is there as it is");
    assert.equal((await agent("add_link", { from: first, type: "depends on", to: second })).created, true);
    const linked = await agent("get", { id: first });
    assert.equal((await agent("add_link", { from: first, type: "depends on", to: second })).created, false);
    assert.equal((await agent("get", { id: first })).version, linked.version, "and the task's version with it");

    assert.equal(says.remove_link, "is refused once the link is gone");
    await agent("remove_link", { from: first, type: "depends on", to: second });
    assert.equal((await refusal(agent("remove_link", { from: first, type: "depends on", to: second }))).code, "not_found");

    assert.equal(says.restore, "is refused once the item is back");
    const now = await agent("get", { id: second });
    await agent("delete", { id: second, version: now.version });
    await agent("restore", { id: second });
    assert.equal((await refusal(agent("restore", { id: second }))).rule, "not_deleted");

    assert.equal(says.create_user, "is refused for a username that is taken");
    await admin("create_user", { username: "twice", type: "agent" });
    assert.equal((await refusal(admin("create_user", { username: "twice", type: "agent" }))).rule, "username_taken");

    assert.equal(says.reset_user_key, "replaces the key each time");
    const keys = [(await admin("reset_user_key", { user: "twice" })).api_key, (await admin("reset_user_key", { user: "twice" })).api_key];
    assert.notEqual(keys[0], keys[1]);
  });

  it("is what the guide says of versions, name for name", () => {
    const facts = operationFacts();
    const advice = versionAdvice();
    assert.equal(advice.versioned, `${listed(facts.versioned)} take the version you last read`);
    assert.equal(advice.unversioned, `${listed(facts.unversioned.map((one) => one.name))} take no version, so a conflict does not catch one that is sent twice`);
    const text = guide("overview").text;
    assert.ok(text.includes(`- ${advice.versioned}. If someone changed the item since, the call fails with a conflict and returns the current item in short`), "the guide names the operations that take a version");
    assert.ok(text.includes(`- ${advice.unversioned}. Sent twice: ${advice.repeated}.`), "and those that take none, each with what a second call does");
    for (const one of facts.unversioned) assert.ok(text.includes(`${one.name} ${one.repeated}`), one.name);
    // No topic of the guide says of every change what is true of some.
    for (const topic of ["overview", "organising", "working", "examples"] as const) {
      assert.doesNotMatch(guide(topic).text, /Every change (to an item )?(needs|names|carries|takes) the version/, `the guide's topic ${topic}`);
    }
  });

  it("is what the README says of versions and of pages, name for name", () => {
    const facts = operationFacts();
    const sentences = [
      `**No silent overwrites.** ${inCode(facts.versioned)} name the version the change was based on.`,
      `${inCode(facts.versioned)} take the \`version\` you last read; if it is no longer the current one, the call fails and returns the item as it is now, in short.`,
      `${inCode(facts.unversioned.map((one) => one.name))} take no version, so no conflict catches one that is sent twice; \`vigile get-guide\` says what a second call of each does.`,
      `${inCode(facts.paged.map((name) => `vigile ${toHyphens(name)}`))} return at most ${LIMITS.page} entries and a continuation token for the next page.`,
      `${inCode(facts.wholeLists.map((name) => `vigile ${toHyphens(name)}`))} ${facts.wholeLists.length === 1 ? "returns" : "return"} the whole list.`,
    ];
    for (const sentence of sentences) assert.ok(readme.includes(sentence), `The README has to say, as the operations are now:\n${sentence}`);
    assert.doesNotMatch(readme, /Every change (names|carries|needs) the `?version|Changing or deleting an item names the version|Lists return at most/, "the README does not say of every change, or of every list, what is true of some");
  });

  it("says of a project's status what the engine allows: every move to another status, and none to the one it has", async () => {
    const { agent } = await setup();
    for (const from of PROJECT_STATUSES) {
      for (const to of PROJECT_STATUSES) {
        const project = await agent("create_project", { title: `From ${from} to ${to}` });
        const at = from === "open" ? project : await agent("set_project_status", { id: project.id, version: project.version, status: from });
        assert.equal(at.status, from);
        if (from === to) assert.equal((await refusal(agent("set_project_status", { id: project.id, version: at.version, status: to }))).rule, "same_status", `${from} to ${to} is refused`);
        else assert.equal((await agent("set_project_status", { id: project.id, version: at.version, status: to })).status, to, `${from} to ${to} is allowed`);
      }
    }
    const description = OPERATIONS.find((operation) => operation.name === "set_project_status")!.description;
    assert.ok(description.includes("Any move to another status is allowed; setting the status the project already has is refused."));
    assert.doesNotMatch(description, /Any move is allowed/);
  });

  it("says of an error what every error has, a code and a message; of a refusal that it names actions; and the rest where there is something to say", async () => {
    const { agent, admin } = await setup();
    const group = await agent("create_task", { title: "A group", description: "Holds a step." });
    const step = await agent("create_task", { title: "A step", description: "Inside the group.", parent: `task:${group.id}` });
    const later = await agent("create_task", { title: "Later", description: "Waits for the step.", depends_on: [`task:${step.id}`] });
    // Refusals of every sort the texts speak of, as the engine gives them.
    const refusals = [
      await refusal(agent("set_task_status", { id: `task:${later.id}`, version: later.version, status: "in_progress" })),
      await refusal(agent("set_task_status", { id: `task:${group.id}`, version: (await agent("get", { id: `task:${group.id}` })).version, status: "done" })),
      await refusal(agent("set_task_status", { id: `task:${step.id}`, version: (await agent("get", { id: `task:${step.id}` })).version, status: "in_review" })),
      await refusal(agent("restore", { id: `task:${step.id}` })),
      await refusal(agent("update_task", { id: `task:${step.id}`, version: 99, priority: 1 })),
      await refusal(agent("get", { id: "task:999" })),
      await refusal(agent("create_user", { username: "someone", type: "agent" })),
      await refusal(admin("create_task", { title: "No description" })),
    ];
    assert.deepEqual(refusals.map((one) => one.rule ?? one.code), ["unfinished_dependencies", "unfinished_contents", "status_move_not_allowed", "not_deleted", "version_conflict", "not_found", "forbidden", "invalid_input"]);
    const optional = Object.keys(ERROR_DETAIL_WORDS);
    assert.deepEqual(optional, ["rule", "blocking", "blocking_total", "actions", "current"]);
    for (const one of refusals) {
      for (const field of ERROR_ALWAYS) assert.equal(typeof one[field], "string", `${one.code}: every error has its ${field}`);
      for (const field of Object.keys(one)) assert.ok([...ERROR_ALWAYS, ...optional].includes(field as never), `${one.code}: ${field} is a field the texts know`);
    }
    // Every refusal of an operation names actions. The other fields are in some refusals and not in others.
    const present = (field: string) => refusals.filter((one) => (one as unknown as Record<string, unknown>)[field] !== undefined).map((one) => one.rule ?? one.code);
    for (const one of refusals) assert.ok(Array.isArray(one.actions) && one.actions.length > 0 && one.actions.every((action) => typeof action === "string" && action.length > 0), `${one.rule ?? one.code}: a refusal names actions`);
    assert.deepEqual(present("rule"), ["unfinished_dependencies", "unfinished_contents", "status_move_not_allowed", "not_deleted"], "a rule: with a rule violation");
    assert.deepEqual(present("blocking"), ["unfinished_dependencies", "unfinished_contents"], "items in the way: with some rules, and not with a move the rules do not allow");
    assert.deepEqual(present("current"), ["version_conflict"]);

    // The texts say that a refusal names actions.
    assert.ok(guide("overview").text.includes("- A change that breaks a rule is refused. The refusal says what is in the way and lists actions you can take."));
    assert.ok(guide("working").text.includes("The error names what is in the way and lists actions. Follow one of them; repeating the same call will fail again."));
    assert.ok(readme.includes("**Refusals that say what to do.** A change that breaks a rule is refused with what is in the way and the actions that would resolve it."), "the README says of a refusal what the guide says");
  });

  it("says in the README how many operations there are", () => {
    const inWords = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
    const count = OPERATIONS.length;
    const spelled = count >= 20 && count < 30 ? `twenty${count === 20 ? "" : `-${inWords[count - 20]}`}` : String(count);
    assert.ok(readme.includes(`The same ${spelled} operations are MCP tools`), `the README says there are ${spelled} operations`);
  });

  it("says of waiting and of a task's ID what the engine does, in the guide and in the README", async () => {
    const { agent } = await setup();
    // Waiting: a task that is not finished and not deleted, with something unfinished in front of it. Not only an open one, and never a finished one.
    const front = await agent("create_task", { title: "In front", description: "Stays open." });
    const waits = async (status: string | null) => {
      let task = await agent("create_task", { title: "Behind", description: "Depends on the one in front." });
      const id = `task:${task.id}`;
      if (status === "in_progress" || status === "done") task = await agent("set_task_status", { id, version: task.version, status: "in_progress" });
      if (status === "done") task = await agent("set_task_status", { id, version: task.version, status: "done" });
      await agent("add_link", { from: id, type: "depends on", to: `task:${front.id}` });
      if (status === null) await agent("delete", { id, version: (await agent("get", { id })).version });
      return (await agent("get", { id })).is_waiting;
    };
    assert.deepEqual([await waits("open"), await waits("in_progress"), await waits("done"), await waits(null)], [true, true, false, false], "open: waiting; in progress: waiting; done: not; deleted: not");
    assert.ok(guide("overview").text.includes("- waiting: an unfinished task that depends on something unfinished, or for which every path through its containers is inactive. A draft can be waiting; only an open task can be next. waiting_for says what blocks it."));
    assert.ok(readme.replace(/\s+/g, " ").includes("An unfinished task is *waiting* when it depends on something unfinished or when every path through its containers is inactive; a draft can therefore be waiting too."));
    assert.doesNotMatch(readme, /It is \*waiting\* when it is open/);
    for (const topic of GUIDE_TOPICS) assert.doesNotMatch(guide(topic).text, /waiting: an open task/, `the guide's topic ${topic}`);

    // A task's ID: from the project it is created in, or the parent's ID, or a number alone; and it stays.
    const web = (await agent("create_project", { title: "Web", prefix: "WEB" })).id;
    const app = (await agent("create_project", { title: "App", prefix: "APP" })).id;
    const inWeb = await agent("create_task", { title: "In WEB", description: "Created in a project." });
    const created = await agent("create_task", { title: "In WEB", description: "Created in a project.", project: web });
    const under = await agent("create_task", { title: "Under it", description: "Created under a parent, with no project.", parent: created.id });
    assert.match(inWeb.id, /^\d{3,}$/, "in no project and under no parent: a number alone");
    assert.match(created.id, /^WEB-\d{3,}$/, "in a project: its prefix");
    assert.match(under.id, /^WEB-\d{3,}$/, "under a parent, with no project: the prefix of the parent's ID");
    await agent("add_link", { from: app, type: "contains", to: created.id });
    await agent("remove_link", { from: web, type: "contains", to: created.id });
    const moved = await agent("get", { id: created.id });
    assert.deepEqual([moved.id, moved.contained_in], [created.id, [app]], "moved into another project, it keeps the ID it was created with");
    assert.ok(readme.includes("A task's ID is given when it is created: the prefix of the project it is created in and a number, `WEB-012`; with no such project, the prefix of its parent's ID; otherwise the number alone, `012`. It keeps that ID when it is moved."));
    assert.doesNotMatch(readme, /A task's ID is its project's prefix and a number/);
  });
});
