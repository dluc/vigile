import { z } from "zod";
import { SETTINGS, configSchema } from "@vigile/config";
import {
  BUILT_IN_USERS,
  ERROR_ALWAYS,
  ERROR_CODES,
  ERROR_DETAIL_WORDS,
  GUIDE_EXAMPLES,
  GUIDE_TOPICS,
  KINDS,
  LIMITS as PLAN_LIMITS,
  LINK_TYPES,
  OPERATIONS,
  PROBLEM_CODES,
  PROJECT_FINISHED,
  PROJECT_STATUSES,
  RESERVED_PREFIXES,
  RULES,
  TASK_FINISHED,
  TASK_MOVES,
  TASK_STATUSES,
  TASK_TYPES,
  USER_TYPES,
  VERSION,
  guide,
  httpStatus,
  toHyphens,
} from "@vigile/core";
import { MAX_BODY } from "@vigile/http-api";
import { INSTRUCTIONS, MCP_LIMITS, PROMPTS } from "@vigile/mcp";
import { NODE_NEEDED } from "@vigile/storage-sqlite";
import { flag, take, type Args } from "../args.js";
import { COMMAND_LINE_CODES, EXIT_CODES } from "../codes.js";
import { LIMITS as SERVICE_LIMITS } from "../service.js";
import type { Ui } from "../ui.js";
import { BUILTINS, EVERYWHERE, builtin, calledAs, given, type BuiltinOption } from "./builtin.js";
import { AS, HELP } from "./help.js";
import { optionsOf } from "./operation.js";

/**
 * The number of the description's own shape. It goes up when a member is renamed, removed or changes its
 * meaning, so that whatever reads the description can refuse one it was not written for. A member that is added
 * does not move it.
 */
export const DESCRIPTION_FORMAT = 1;

interface SettingShape {
  properties?: Record<string, SettingShape>;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

/** `requestMs` as `request_ms`: the description names its members the way the operations name theirs. */
const underscored = (name: string): string => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const members = (limits: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(limits).map(([name, value]) => [underscored(name), value]));

const option = (one: BuiltinOption) => ({ name: one.name, ...(one.value ? { value: one.value } : {}), ...(one.also ? { also: one.also } : {}), description: one.text });

/**
 * What this build of Vigile offers, as data: every operation with its input, every command and setting, the
 * errors, the statuses and their moves, the limits, the guide and what an agent is told over MCP. It is made
 * from the same values the service runs on, so it cannot say what the service does not do. Nothing in it is
 * about an instance: no config is read, and no plan.
 */
export function description() {
  const configShape = z.toJSONSchema(configSchema) as SettingShape;
  return {
    format: DESCRIPTION_FORMAT,
    name: "vigile",
    version: VERSION,
    /** What it needs to run: the oldest Node.js it starts on. */
    requires: { node: NODE_NEEDED },
    operations: OPERATIONS.map((operation) => ({
      name: operation.name,
      command: toHyphens(operation.name),
      /** `read` or `write`: whether it changes anything. */
      kind: operation.kind,
      /** Who may call it. */
      access: operation.access,
      description: operation.description,
      /** The input, as JSON Schema. */
      input: z.toJSONSchema(operation.input),
      /** The same input as the options of the command. */
      options: optionsOf(operation).map((one) => ({ name: one.name, ...(one.value ? { value: one.value } : {}), required: one.required, ...(one.text ? { description: one.text } : {}) })),
    })),
    /** Every command that is not an operation: the built-in ones, and the help. */
    commands: [
      ...BUILTINS.map((command) => ({
        name: command.name,
        group: command.group,
        usage: calledAs(command),
        description: command.text,
        notes: command.more ?? [],
        words: command.words.map((word) => word.name),
        options: command.options.map(option),
      })),
      { name: HELP.name, group: "Help", usage: HELP.usage, description: HELP.text, notes: [...HELP.more], words: [...HELP.words], options: [] },
    ],
    options: {
      /** Taken by every command. */
      everywhere: EVERYWHERE.map(option),
      /** Taken by the commands that are operations, besides the fields of their input. */
      operations: [option(AS)],
    },
    settings: SETTINGS.map((setting) => {
      const shape = setting.key.split(".").reduce<SettingShape>((at, part) => at.properties![part]!, configShape);
      return {
        key: setting.key,
        type: setting.type,
        environment: setting.env,
        description: setting.description,
        default: shape.default,
        ...(shape.enum ? { values: shape.enum } : {}),
        ...(shape.minimum !== undefined ? { minimum: shape.minimum } : {}),
        ...(shape.maximum !== undefined ? { maximum: shape.maximum } : {}),
        ...(shape.minLength !== undefined ? { min_length: shape.minLength } : {}),
        ...(shape.maxLength !== undefined ? { max_length: shape.maxLength } : {}),
      };
    }),
    errors: {
      /** What the service answers with when it does not do what was asked. */
      codes: ERROR_CODES.map((code) => ({ code, http_status: httpStatus(code) })),
      /** The members every error has, and those it has when there is something to say, each in a few words. */
      members: { always: ERROR_ALWAYS, sometimes: ERROR_DETAIL_WORDS },
      /** What `rule` can be in an error whose code is `rule_violation`. */
      rules: RULES,
      /** What the command line itself fails with, before or instead of an answer of the service. */
      command_line: { codes: COMMAND_LINE_CODES, exit_codes: EXIT_CODES },
    },
    /** What `code` can be in the problems of a task or a project. */
    problems: PROBLEM_CODES,
    kinds: KINDS,
    tasks: { statuses: TASK_STATUSES, moves: TASK_MOVES, finished: TASK_FINISHED, types: TASK_TYPES },
    projects: { statuses: PROJECT_STATUSES, finished: PROJECT_FINISHED },
    users: { types: USER_TYPES, built_in: BUILT_IN_USERS },
    link_types: LINK_TYPES,
    reserved_prefixes: RESERVED_PREFIXES,
    limits: { plan: members(PLAN_LIMITS), service: members(SERVICE_LIMITS), api: { body_bytes: MAX_BODY }, mcp: members(MCP_LIMITS) },
    guide: { topics: GUIDE_TOPICS.map((topic) => guide(topic)), examples: GUIDE_EXAMPLES },
    mcp: {
      instructions: INSTRUCTIONS,
      prompts: PROMPTS.map(({ name, title, description, argument }) => ({ name, title, description, argument })),
    },
  };
}

/** Prints the description. It is JSON whether or not `--json` is given: there is nothing else it could be. */
export async function describe(args: Args, ui: Ui): Promise<void> {
  // The two options every command takes are taken and not used: the description is of the program, not of an instance.
  flag(args, "json");
  take(args, "config");
  given(builtin("describe"), args);
  ui.out(JSON.stringify(description(), null, 2));
}
