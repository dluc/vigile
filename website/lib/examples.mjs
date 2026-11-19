// Runs the examples of the operation pages against a real service, so that the answers the pages show are
// answers a service gave, on the made-up plan the pictures show. The service is started through the program
// (website/lib/program.mjs) and spoken to over its HTTP API. An example the service does not answer as the
// page expects stops the build.
//
// The made-up plan is the site's own: website/content/demo-plan.json, a list of calls that is replayed here.
//
// A real service goes by the real clock, and the pages are to say the same on every build. So every call that
// is made here has a made-up moment: a step of the plan the one its line gives, a call after the plan seven
// minutes more than the one before. A date the service made while it carried a call out is shown as the
// moment of that call. Keys are random: the pages show their shape and not one of them.

import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { programPath, startService } from "./program.mjs";

const planFile = new URL("../content/demo-plan.json", import.meta.url);

/** The made-up plan: the calls that make it, in order. */
export const demoPlan = () => JSON.parse(readFileSync(planFile, "utf8"));

/** How far the made-up moments of two calls after the plan lie apart. */
const EVERY = 7 * 60_000;

/**
 * At most so many services are started at a time: each is a process of its own. `task` is run when there is
 * room, and its answer is the answer.
 */
const room = Math.max(2, Math.min(8, availableParallelism()));
let busy = 0;
const waiting = [];
async function withRoom(task) {
  while (busy >= room) await new Promise((free) => waiting.push(free));
  busy++;
  try {
    return await task();
  } finally {
    busy--;
    waiting.shift()?.();
  }
}

/**
 * Makes the made-up plan in a service that is new, call by call. The IDs the service gives are held to the
 * ones the plan names, which are the ones the pages and the pictures show.
 */
export async function replayPlan(service) {
  const plan = demoPlan();
  try {
    for (const [index, step] of plan.steps.entries()) {
      const answer = await service.call(step.operation, step.input, step.as, { at: Date.parse(step.at) });
      const given = answer.user?.id ?? answer.id;
      if (step.gives !== undefined && given !== step.gives) throw new Error(`step ${index + 1}, ${step.operation}, was to give ${step.gives} and gave ${given}. The pages and the pictures name the items by these IDs.`);
    }
  } catch (error) {
    throw new Error(`The made-up plan of website/content/demo-plan.json could not be made in a service: ${error.message}`);
  }
  return plan;
}

/** A new service that holds the made-up plan. The caller stops it. */
export async function demoService() {
  const service = await startService();
  let plan;
  try {
    plan = await replayPlan(service);
  } catch (error) {
    await service.stop();
    throw error;
  }
  /** The made-up moment of the call that is made next, after the plan. */
  let moment = Date.parse(plan.steps.at(-1).at);
  service.next = () => (moment += EVERY);
  /** Starts the moments after the plan again: for a call that follows the plan as it is, like the one before it. */
  service.again = () => (moment = Date.parse(plan.steps.at(-1).at));
  return service;
}

/** Keys are random: the pages show their shape and not one of them. */
const withoutKeys = (value) => JSON.parse(JSON.stringify(value).replace(/vig_[A-Za-z0-9_-]{8,}/g, "vig_…"));

/** The service that holds the plan as it is, for the calls that leave it so, by the program it was started through. */
const untouched = new Map();

/** Stops what was started here and is still running: the service that the calls that change nothing share. */
export async function closeExamples() {
  const services = [...untouched.values()];
  untouched.clear();
  for (const service of services) await (await service.catch(() => null))?.stop();
}

/** What the examples answered, by what was asked: the same call on the same plan is answered the same. */
const answered = new Map();

/**
 * Runs one call on the made-up plan. `before` are calls made first, to bring the plan to where the example
 * starts. `changes` says whether the call is one that changes the plan when it is carried out: a call that
 * changes nothing, and has nothing before it, is made on a service that others share, and every other call on
 * a service of its own. Returns what was answered, or the body of the refusal.
 */
export function runExample({ operation, as, input, before = [], changes = true }) {
  const key = JSON.stringify([programPath(), operation, as, input, before, changes]);
  if (!answered.has(key)) {
    const running = changes || before.length ? withRoom(() => onItsOwn({ operation, as, input, before })) : onTheShared({ operation, as, input });
    running.catch(() => answered.delete(key));
    answered.set(key, running);
  }
  return answered.get(key);
}

const shown = (service, answer) => (answer.ok ? { ok: true, answer: withoutKeys(service.steady(answer.body)) } : { ok: false, answer: { error: withoutKeys(service.steady(answer.body.error)) } });

async function onItsOwn({ operation, as, input, before }) {
  const service = await demoService();
  try {
    for (const step of before) await service.call(step.operation, step.input, step.as ?? "agent1", { at: service.next() });
    return shown(service, await service.ask(operation, input, as, { at: service.next() }));
  } finally {
    await service.stop();
  }
}

async function onTheShared({ operation, as, input }) {
  const program = programPath();
  if (!untouched.has(program)) untouched.set(program, withRoom(demoService));
  const service = await untouched.get(program);
  const revision = await service.revision();
  service.again();
  const answer = await service.ask(operation, input, as, { at: service.next() });
  // A call that was to change nothing and changed something: the plan is no longer the one the others count on.
  if ((await service.revision()) !== revision) {
    untouched.delete(program);
    await service.stop();
  }
  return shown(service, answer);
}
