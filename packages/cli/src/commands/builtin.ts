import { SETTINGS } from "@vigile/config";
import { UsageError, flag, nothingElse, take, type Args } from "../args.js";

/** An option of a built-in command. */
export interface BuiltinOption {
  /** As it is typed after the two hyphens. */
  name: string;
  /** What stands for its value in a usage line. A yes/no option has none. */
  value?: string;
  /** A second name the option is also taken by. */
  also?: string;
  text: string;
}

/** A word a built-in command takes after its name. */
interface Word {
  name: string;
  /** Whether the word may be empty text, as the value of a setting may. */
  mayBeEmpty?: true;
}

/**
 * A built-in command: what it is called, the words and the options it takes, and what it does. Its help, the
 * usage line in its errors and the reading of its arguments are all made from this one description, so that
 * none of them can say what the others do not.
 */
export interface Builtin {
  /** The words it is called by: `config set`. */
  name: string;
  group: "Run" | "Set up";
  words: Word[];
  options: BuiltinOption[];
  /** What it does, in a line. */
  text: string;
  /** What else there is to know about how it is called. */
  more?: string[];
}

export const BUILTINS: readonly Builtin[] = [
  {
    name: "serve",
    group: "Run",
    words: [],
    // Any setting can be overridden for one run, as in `--listen.port 8701`.
    options: SETTINGS.map((setting) => ({ name: setting.key, value: setting.type === "number" || setting.type === "decimal" ? "number" : setting.type === "boolean" ? "true|false" : "text", text: `for this run: ${setting.description.charAt(0).toLowerCase()}${setting.description.slice(1)}` })),
    text: "start the service: MCP, HTTP API and web page on one port",
    more: ["Runs until it is stopped. A setting given here counts for this run and is not written to the config."],
  },
  {
    name: "doctor",
    group: "Run",
    words: [],
    options: [],
    text: "check the config and the running service; changes nothing",
    more: ["Ends with an error when a check fails."],
  },
  {
    name: "backup",
    group: "Run",
    words: [{ name: "folder" }],
    options: [],
    text: "write a consistent copy of the data, while the service runs",
    more: ["The folder is created if needed. Each tenant becomes one file in it.", "The service also takes backups by itself: see the settings backup.enabled, backup.every_hours, backup.folder and backup.keep."],
  },
  {
    name: "restore-backup",
    group: "Run",
    words: [{ name: "backup file" }],
    options: [{ name: "tenant", value: "name", text: "the tenant the file is a backup of, when the file's name does not say" }],
    text: "put a backup in the place of the data, while the service is stopped",
    more: ["The file is one that vigile backup wrote, or one the service wrote by itself. Stop the service first."],
  },
  {
    name: "config init",
    group: "Set up",
    words: [],
    options: [
      { name: "name", value: "name", text: "a label for the instance" },
      { name: "listen.address", value: "address", also: "address", text: "the address to listen on" },
      { name: "listen.port", value: "port", also: "port", text: "the port to listen on" },
    ],
    text: "write a starter config with a new admin key",
    more: ["Refuses to replace a config file that is there."],
  },
  { name: "config show", group: "Set up", words: [], options: [], text: "print the values in effect and where each came from" },
  {
    name: "config set",
    group: "Set up",
    words: [{ name: "setting" }, { name: "value", mayBeEmpty: true }],
    options: [],
    text: "change one setting, after checking it",
    more: [`Settings: ${SETTINGS.map((setting) => setting.key).join(", ")}`],
  },
  {
    name: "config unset",
    group: "Set up",
    words: [{ name: "setting" }],
    options: [],
    text: "remove a setting so its default applies",
    more: [`Settings: ${SETTINGS.map((setting) => setting.key).join(", ")}`],
  },
  { name: "config path", group: "Set up", words: [], options: [], text: "print where the config file is" },
  {
    name: "user add",
    group: "Set up",
    words: [{ name: "username" }],
    options: [{ name: "type", value: "agent|person", text: "what the user is; an agent when left out" }],
    text: "create a user; prints its API key and MCP settings",
  },
  {
    name: "user remove",
    group: "Set up",
    words: [{ name: "username" }],
    options: [{ name: "permanent", text: "remove the user for good: it cannot be brought back" }],
    text: "delete a user; its key stops working",
  },
  { name: "user reset-key", group: "Set up", words: [{ name: "username" }], options: [], text: "issue a new key and cancel the old one" },
  { name: "user list", group: "Set up", words: [], options: [], text: "show the users and how each connects" },
  {
    name: "describe",
    group: "Set up",
    words: [],
    options: [],
    text: "print what this version offers, as JSON",
    more: ["Operations with their inputs, commands, settings, errors, statuses, limits, the guide and what an agent is told over MCP.", "Needs no config and reads no plan: it describes the program, for documentation and for tools made from it."],
  },
];

/** The options every command takes, built-in or operation. */
export const EVERYWHERE: readonly BuiltinOption[] = [
  { name: "config", value: "file", text: "the instance to act on; or set VIGILE_CONFIG" },
  { name: "json", text: "print the raw result, and a failure as JSON on the error output, for scripts and agents" },
];

export const optionAsTyped = (option: BuiltinOption): string => `--${option.name}${option.value ? ` <${option.value}>` : ""}`;

/** How a built-in command is called, without the options every command takes: `vigile user add <username> [--type <agent|person>]`. */
export const calledAs = (builtin: Builtin): string =>
  ["vigile", builtin.name, ...builtin.words.map((word) => `<${word.name}>`), ...builtin.options.map((option) => `[${optionAsTyped(option)}]`)].join(" ");

const usage = (builtin: Builtin): string => `Usage: ${calledAs(builtin)}`;

/** The built-in command of this name. One that is not described is a mistake in the code, not in what was typed. */
export function builtin(name: string): Builtin {
  const found = BUILTINS.find((one) => one.name === name);
  if (!found) throw new Error(`There is no built-in command "${name}".`);
  return found;
}

/** The built-in commands that share a first word, as `config init` and `config show` do, or the one that is called by it. */
export const builtinsUnder = (first: string): Builtin[] => BUILTINS.filter((one) => one.name === first || one.name.startsWith(`${first} `));

/** What was typed for a built-in command, by the names its description gives. */
export interface Given {
  /** The words after the command's name, in the order they are described. */
  words: string[];
  /** The value of an option that takes one, or nothing when it was not given. */
  value(name: string): string | undefined;
  /** Whether a yes/no option was given. */
  yes(name: string): boolean;
}

/**
 * Reads a built-in command's arguments by its description, after the options every command takes have been
 * read: the words it needs, then its options, and nothing else. A word that is missing, an option that is not
 * described and a word too many are refused with the usage line.
 */
export function given(command: Builtin, args: Args): Given {
  const words = command.words.map((word) => {
    const typed = args.words.shift();
    if (typed === undefined || (typed === "" && !word.mayBeEmpty)) throw new UsageError(usage(command), command.more);
    return typed;
  });
  const values = new Map<string, string | undefined>();
  const flags = new Map<string, boolean>();
  for (const option of command.options) {
    if (option.value) values.set(option.name, take(args, option.name) ?? (option.also ? take(args, option.also) : undefined));
    else flags.set(option.name, flag(args, option.name));
  }
  nothingElse(args, [usage(command)]);
  // A name that the description does not have is a mistake in the code: said, and not taken for an option that
  // was left out.
  const described = <T>(from: Map<string, T>, name: string): T => {
    if (!from.has(name)) throw new Error(`"${command.name}" is not described as taking --${name}.`);
    return from.get(name) as T;
  };
  return { words, value: (name) => described(values, name), yes: (name) => described(flags, name) };
}

/**
 * Refuses a word after `config` or `user` that is none of theirs, or a missing one. Asked before anything else
 * of what was typed: a word that is not understood is what is wrong, whether or not a config was given as well.
 */
export function oneOf(first: string, typed: string | undefined): void {
  if (typed === undefined || !BUILTINS.some((one) => one.name === `${first} ${typed}`)) throw notOneOf(first, typed);
}

/** What to say when the word after `config` or `user` is none of theirs, or is missing. */
export function notOneOf(first: string, typed: string | undefined): UsageError {
  const commands = builtinsUnder(first);
  const names = commands.map((one) => one.name.slice(first.length + 1));
  const size = Math.max(...commands.map((one) => calledAs(one).length - "vigile ".length - first.length - 1));
  return new UsageError(
    typed ? `"${first} ${typed}" is not a command.` : `Usage: vigile ${first} <${names.join("|")}>`,
    commands.map((one) => `${calledAs(one).slice("vigile ".length + first.length + 1).padEnd(size)}  ${one.text}`),
  );
}
