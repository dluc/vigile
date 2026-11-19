import type { z } from "zod";
import { OPERATIONS } from "./index.js";

/**
 * What the operations' own inputs say about them, for the texts that tell a reader how to call them: the guide,
 * what an agent is told over MCP and the README. Each of those says which operations take a
 * version and which lists answer in pages from here, so that none of them can say it of an operation whose
 * input does not have the field.
 *
 * Everything here is worked out when it is asked for and not when this file is loaded: the guide asks, and the
 * guide is loaded by one of the operations.
 */

const takes = (input: z.ZodObject, field: string): boolean => Object.hasOwn(input.shape, field);

export interface OperationFacts {
  /** The operations whose input has a `version`: they change or delete an item that is there, and are refused when it has changed since. */
  versioned: string[];
  /** The operations that change something and take no version, each with what happens when it is sent a second time. */
  unversioned: Array<{ name: string; repeated: string }>;
  /** The operations whose input has a `continuation`: they answer in pages. */
  paged: string[];
  /** The operations that list and answer with everything at once. */
  wholeLists: string[];
}

/**
 * What a second call does of each operation that changes something without a version: nothing holds it back,
 * so the reader has to know. In the words the guide and the MCP instructions use after the operation's name.
 * A test sends each one twice and holds these to what the engine does.
 */
export const REPEATED_WITHOUT_VERSION: Readonly<Record<string, string>> = {
  create_project: "makes another project, unless it names a prefix, which is refused the second time",
  create_task: "makes another task",
  restore: "is refused once the item is back",
  add_link: "leaves a link that is there as it is",
  remove_link: "is refused once the link is gone",
  create_user: "is refused for a username that is taken",
  reset_user_key: "replaces the key each time",
};

/** Kept loadable before the operation registry, which includes the guide; operationFacts checks it against every input. */
const VERSIONED_OPERATIONS = ["set_project_status", "update_task", "set_task_status", "delete", "override_timestamp"] as const;

export function operationFacts(): OperationFacts {
  const versioned = OPERATIONS.filter((operation) => takes(operation.input, "version")).map((operation) => operation.name);
  if (versioned.join("\0") !== VERSIONED_OPERATIONS.join("\0")) throw new Error(`The operations that take a version are ${listed(versioned)}, but the guidance names ${listed(VERSIONED_OPERATIONS)}. Update VERSIONED_OPERATIONS.`);
  const unversioned = OPERATIONS.filter((operation) => operation.kind === "write" && !versioned.includes(operation.name)).map((operation) => {
    const repeated = REPEATED_WITHOUT_VERSION[operation.name];
    if (repeated === undefined) throw new Error(`The operation ${operation.name} changes something and takes no version, and nothing says what a second call of it does. Say it in REPEATED_WITHOUT_VERSION.`);
    return { name: operation.name, repeated };
  });
  for (const name of Object.keys(REPEATED_WITHOUT_VERSION)) {
    if (!unversioned.some((one) => one.name === name)) throw new Error(`REPEATED_WITHOUT_VERSION says what a second call of ${name} does, and ${name} is no operation that changes something without a version. Remove the line.`);
  }
  const paged = OPERATIONS.filter((operation) => takes(operation.input, "continuation")).map((operation) => operation.name);
  const wholeLists = OPERATIONS.filter((operation) => operation.name.startsWith("list_") && !paged.includes(operation.name)).map((operation) => operation.name);
  return { versioned, unversioned, paged, wholeLists };
}

/** Names in a sentence: "a, b and c". */
export const listed = (names: readonly string[], last = "and"): string => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} ${last} ${names.at(-1)}`);

/**
 * What the guide and the MCP instructions say about versions, made from the operations: which take the version
 * that was last read, which changes take none, and what a second call does of each of those. The guide says
 * all three; the instructions, which have to be short, name the operations and send the reader to the guide.
 */
export function versionAdvice(): { versioned: string; unversioned: string; repeated: string } {
  const unversioned = Object.entries(REPEATED_WITHOUT_VERSION).map(([name, repeated]) => ({ name, repeated }));
  return {
    versioned: `${listed(VERSIONED_OPERATIONS)} take the version you last read`,
    unversioned: `${listed(unversioned.map((one) => one.name))} take no version, so a conflict does not catch one that is sent twice`,
    repeated: unversioned.map((one) => `${one.name} ${one.repeated}`).join("; "),
  };
}
