import { z } from "zod";
import { loadConfig } from "@vigile/config";
import { toHyphens, toUnderscores, type Operation } from "@vigile/core";
import { showing } from "../answers.js";
import { UsageError, configPath, flag, needsValue, take, type Args } from "../args.js";
import { accepted } from "../expected.js";
import { connect } from "../reach.js";
import { renderResult } from "../render.js";
import type { Ui } from "../ui.js";

interface Property {
  type?: string;
  enum?: string[];
  anyOf?: Property[];
  items?: Property;
  description?: string;
}

function fieldsOf(operation: Operation): { properties: Record<string, Property>; required: string[] } {
  const schema = z.toJSONSchema(operation.input) as { properties?: Record<string, Property>; required?: string[] };
  return { properties: schema.properties ?? {}, required: schema.required ?? [] };
}

const typesOf = (property: Property): string[] => (property.anyOf ? property.anyOf.flatMap(typesOf) : property.type ? [property.type] : []);

/** Turns what was typed after `--field` into the value the operation expects. */
function convert(name: string, property: Property, raw: string | true): unknown {
  const types = typesOf(property);
  const option = `--${toHyphens(name)}`;
  if (types.includes("boolean")) {
    if (raw === true || raw === "true") return true;
    if (raw === "false") return false;
    throw new UsageError(`${option} is a yes/no option: use it alone, or with true or false.`);
  }
  if (raw === true) throw needsValue(toHyphens(name));
  if (types.includes("null") && raw === "null") return null;
  if (types.includes("number") || types.includes("integer")) {
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value)) throw new UsageError(`${option} must be a number, got "${raw}".`);
    return value;
  }
  if (types.includes("array")) return raw.split(",").map((part) => part.trim()).filter(Boolean);
  return raw;
}

/** An option of an operation's command, as its help shows it. */
export interface OperationOption {
  /** As it is typed after the two hyphens. */
  name: string;
  /** What stands for its value. A yes/no option has none. */
  value?: string;
  required: boolean;
  text?: string;
}

/** The options of an operation's command: one for each field of its input. */
export function optionsOf(operation: Operation): OperationOption[] {
  const { properties, required } = fieldsOf(operation);
  return Object.entries(properties).map(([name, property]) => {
    const types = typesOf(property);
    const value = property.enum ? property.enum.join("|") : types.includes("boolean") ? undefined : types.includes("array") ? "a,b,c" : types.includes("number") || types.includes("integer") ? "number" : "text";
    return { name: toHyphens(name), ...(value ? { value } : {}), required: required.includes(name), ...(property.description ? { text: property.description } : {}) };
  });
}

export function usage(operation: Operation): string[] {
  return optionsOf(operation).map((option) => `--${option.name}${option.value ? ` <${option.value}>` : ""}${option.required ? "  (required)" : ""}`);
}

/** Runs one operation against the running service: `vigile set-task-status --id ABC-042 --version 3 --status done`. */
export async function runOperation(operation: Operation, args: Args, ui: Ui): Promise<void> {
  const json = flag(args, "json");
  const as = take(args, "as") ?? "admin";
  if (!as.trim()) throw new UsageError("--as needs the name of a user.", ["Leave --as out to act as admin."]);
  const loaded = loadConfig(configPath(args));
  const { properties } = fieldsOf(operation);

  const input: Record<string, unknown> = {};
  for (const [option, raw] of args.options) {
    const name = toUnderscores(option);
    const property = Object.hasOwn(properties, name) ? properties[name] : undefined;
    if (!property) {
      throw new UsageError(`${toHyphens(operation.name)} has no option --${option}.`, usage(operation));
    }
    // Two spellings of one option never get this far; should they, the second does not replace the first.
    if (Object.hasOwn(input, name)) throw new UsageError(`--${toHyphens(name)} is given twice.`, usage(operation));
    input[name] = convert(name, property, raw);
  }
  // The first plain word is the item the command is about: `vigile get ABC-042`.
  const first = args.words.shift();
  if (first !== undefined) {
    const target = ["id", "user", "username", "title"].find((name) => properties[name] && input[name] === undefined);
    if (!target) throw new UsageError(`Unexpected "${first}".`, usage(operation));
    input[target] = first;
  }
  if (args.words.length) throw new UsageError(`Unexpected "${args.words[0]}". Values with spaces need quotes.`, usage(operation));

  const client = await connect(loaded, as);
  const result = await client.call(operation.name, input);
  const asked = `POST /api/${toHyphens(operation.name)}`;
  // As JSON the answer is passed on as it came, for the script to judge.
  if (json) return showing(ui, client.base, asked, (page) => page.out(JSON.stringify(result, null, 2)));
  // In words, something is said only of the answer that this operation gives to this call: one that is another
  // operation's, or about another item, says nothing of what was asked.
  const answer = accepted(client.base, operation.name, input, result, "Look at what the command was about: vigile get <id>, or vigile list-tasks, vigile list-projects, vigile list-users.");
  showing(ui, client.base, asked, (page) => renderResult(page, operation.name, answer, client.base, input));
}
