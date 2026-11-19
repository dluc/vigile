// What the program says of itself, read from the description it prints (`vigile describe`): the operations,
// the settings, the commands, the error codes, the statuses and their moves, the link types, the limits and
// the guide. The reference pages are made from this, so they cannot say what the program does not.
//
// What the service does, which no description says, is found out by running it: see website/lib/contract.mjs.

import { readContract } from "./contract.mjs";
import { describeProgram, programPath } from "./program.mjs";

/** An option of a command as it is typed: `--name <value>`, or `--name` for one that stands alone. */
const asTyped = (option) => `--${option.name}${option.value ? ` <${option.value}>` : ""}`;

/** What a field of an input takes, in the words of its JSON Schema. */
function describeProperty(property) {
  const options = property.anyOf ?? [property];
  const types = [];
  let limits = [];
  for (const option of options) {
    if (option.enum) types.push(option.enum.map((value) => JSON.stringify(value)).join(" | "));
    else if (option.type === "array") types.push(`array of ${option.items?.type ?? "values"}`);
    else if (option.type) types.push(option.type);
    if (option.minLength === 1 && option.maxLength) limits.push(`1 to ${option.maxLength} characters`);
    else if (option.maxLength) limits.push(`at most ${option.maxLength} characters`);
    if (option.maxItems) limits.push(`at most ${option.maxItems}`);
    if (option.type === "integer" && option.minimum !== undefined) limits.push(`${option.minimum} or more`);
  }
  if (property.maxItems) limits.push(`at most ${property.maxItems}`);
  limits = [...new Set(limits)];
  const description = property.description ?? options.find((option) => option.description)?.description ?? "";
  return { type: types.join(" | "), limits, description };
}

/**
 * The description, in the shape the pages are made from. Nothing is added to it: a name is the program's name,
 * and what is derived is derived from the description alone, such as the fields of an input from its JSON
 * Schema.
 */
export function factsOf(description) {
  const operations = description.operations.map((one) => {
    const required = one.input.required ?? [];
    return {
      name: one.name,
      command: one.command,
      kind: one.kind,
      access: one.access,
      description: one.description,
      // The input as JSON Schema, as the description has it.
      input: one.input,
      fields: Object.entries(one.input.properties ?? {}).map(([name, property]) => ({ name, required: required.includes(name), ...describeProperty(property) })),
      options: one.options,
    };
  });
  // Which operations take a version, and which answer in pages: an input that has the field.
  const takes = (operation, field) => Object.hasOwn(operation.input.properties ?? {}, field);
  const paged = operations.filter((operation) => takes(operation, "continuation")).map((operation) => operation.name);
  return {
    version: description.version,
    operations,
    inputs: {
      versioned: operations.filter((operation) => takes(operation, "version")).map((operation) => operation.name),
      paged,
      // The operations that list and answer with everything at once.
      wholeLists: operations.filter((operation) => operation.name.startsWith("list_") && !paged.includes(operation.name)).map((operation) => operation.name),
    },
    settings: description.settings,
    builtins: description.commands.map((one) => ({ ...one, options: one.options.map((option) => ({ ...option, typed: asTyped(option) })) })),
    everywhere: description.options.everywhere.map((option) => ({ ...option, typed: asTyped(option) })),
    errorCodes: description.errors.codes.map((one) => ({ code: one.code, status: one.http_status })),
    // The members of an error: the two every error has, and those that are there when there is something to say.
    errorMembers: description.errors.members,
    // What the command line calls its own failures, and what it ends with.
    commandLine: description.errors.command_line,
    rules: description.errors.rules,
    problems: description.problems,
    kinds: description.kinds,
    taskStatuses: description.tasks.statuses,
    taskMoves: description.tasks.moves,
    taskFinished: description.tasks.finished,
    taskTypes: description.tasks.types,
    projectStatuses: description.projects.statuses,
    projectFinished: description.projects.finished,
    userTypes: description.users.types,
    builtInUsers: description.users.built_in,
    linkTypes: description.link_types,
    limits: description.limits.plan,
    // The most bytes one request to the API may have, and the oldest Node.js the program starts on.
    apiBodyBytes: description.limits.api.body_bytes,
    nodeNeeded: description.requires.node,
    reservedPrefixes: description.reserved_prefixes,
    guideTopics: description.guide.topics,
    guideExamples: description.guide.examples,
    mcpInstructions: description.mcp.instructions,
    mcpPrompts: description.mcp.prompts,
  };
}

/** The facts that were read, by the program they are of: one program says and does the same each time. */
const read = new Map();

/**
 * Everything the pages are made from: the description of the program, and under `contract` what a service
 * that was started through the program was seen to do. The program must be there first (`pnpm build`).
 */
export function readFacts() {
  const program = programPath();
  if (!read.has(program)) {
    const reading = (async () => {
      const facts = factsOf(await describeProgram());
      return { ...facts, contract: await readContract(facts) };
    })();
    // A reading that failed is not kept: the next one tries again.
    reading.catch(() => read.delete(program));
    read.set(program, reading);
  }
  return read.get(program);
}
