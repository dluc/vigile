import { OPERATIONS, VERSION, toHyphens, type Operation } from "@vigile/core";
import { UsageError } from "../args.js";
import { accent, bold, dim, pad, type Ui } from "../ui.js";
import { BUILTINS, EVERYWHERE, builtinsUnder, calledAs, notOneOf, optionAsTyped, type Builtin, type BuiltinOption } from "./builtin.js";
import { optionsOf, usage } from "./operation.js";

/** What only the commands that are operations take, besides the fields of their input. */
/**
 * The help itself, as a command. It is not among the built-in commands, whose arguments are read by their
 * description: what follows `help` is the name of another command, of one word or of two.
 */
export const HELP = {
  name: "help",
  usage: "vigile help [command]",
  text: "list the commands, or show what one command takes",
  more: ["So does <command> --help.", "vigile --version, with no command, prints the version."],
  words: ["command"],
} as const;

export const AS: BuiltinOption = { name: "as", value: "username", text: "act as another user; operations act as admin by default" };

const firstSentence = (text: string): string => text.split(/(?<=[.:])\s/)[0]!.replace(/[.:]$/, "");

const operationCalled = (name: string): Operation | undefined => OPERATIONS.find((o) => toHyphens(o.name) === name || o.name === name);

/** A command as JSON says it: what it is called, how, what it does, and each of its options. */
const builtinAsJson = (builtin: Builtin) => ({
  command: builtin.name,
  usage: calledAs(builtin),
  description: builtin.text,
  ...(builtin.more ? { notes: builtin.more } : {}),
  options: builtin.options.map((option) => optionAsJson(option)),
});
const optionAsJson = (option: BuiltinOption) => ({ option: `--${option.name}`, ...(option.value ? { value: option.value } : {}), ...(option.also ? { also: `--${option.also}` } : {}), description: option.text });
const operationAsJson = (operation: Operation) => ({
  command: toHyphens(operation.name),
  description: operation.description,
  options: [
    ...optionsOf(operation).map((option) => ({ option: `--${option.name}`, ...(option.value ? { value: option.value } : {}), required: option.required, ...(option.text ? { description: option.text } : {}) })),
    { ...optionAsJson(AS), required: false },
  ],
});

function options(ui: Ui, list: readonly BuiltinOption[], indent: string, size = Math.max(...list.map((option) => optionAsTyped(option).length))): void {
  for (const option of list) ui.out(`${indent}${accent(ui, pad(optionAsTyped(option), size))}  ${dim(ui, `${option.text}${option.also ? `; also --${option.also}` : ""}`)}`);
}

/**
 * Prints the help: of everything, of one built-in command or of those that share a first word, or of one
 * operation. As JSON when that is asked for.
 *
 * A topic that is no command is a mistake in what was typed, and is refused with what there is instead: a first
 * word that no command has, and a second word that none of the commands under the first has. What follows the
 * name of a command is refused too, unless the help was asked of the command itself with `--help`: there it is
 * what the command was given, as in `vigile config set name main --help`, and is not looked at.
 */
export function help(ui: Ui, topic: string[] = [], json = false, ofItself = false): void {
  const [first, second] = topic;
  if (first === undefined) return json ? ui.out(JSON.stringify(everythingAsJson(), null, 2)) : everything(ui);
  /** Ends the reading of the topic: `name` is a command, and `further` is what was typed after it. */
  const nothingAfter = (name: string, further: string[]): void => {
    if (further.length && !ofItself) throw new UsageError(`Unexpected "${further[0]}" after "help ${name}".`, [`The help of this command: vigile help ${name}`, "The commands there are: vigile help"]);
  };
  // `vigile help help` asks for the help itself, which is the help of everything.
  if (first === "help" && !ofItself) {
    nothingAfter("help", topic.slice(1));
    return help(ui, [], json);
  }

  const under = builtinsUnder(first);
  if (under.length) {
    // `serve` is one command. `config` is several that share the word: alone it stands for all of them, and with
    // a second word for the one that has it, which must be one of theirs.
    const shared = under[0]!.name !== first;
    const exact = shared && second !== undefined ? under.find((one) => one.name === `${first} ${second}`) : undefined;
    if (shared && second !== undefined && !exact) throw notOneOf(first, second);
    nothingAfter(exact ? exact.name : first, topic.slice(exact ? 2 : shared ? topic.length : 1));
    const builtins = exact ? [exact] : under;
    if (json) return ui.out(JSON.stringify({ commands: builtins.map(builtinAsJson), everywhere: EVERYWHERE.map(optionAsJson) }, null, 2));
    ui.out();
    ui.out(`  ${bold(ui, `vigile ${exact ? exact.name : first}`)}`);
    for (const builtin of builtins) {
      ui.out();
      ui.out(`  ${accent(ui, calledAs(builtin))}`);
      ui.out(`    ${builtin.text}`);
      for (const line of builtin.more ?? []) ui.out(`    ${dim(ui, line)}`);
      if (builtin.options.length) options(ui, builtin.options, "    ");
    }
    ui.out();
    ui.out(`  ${bold(ui, "Everywhere")}`);
    options(ui, EVERYWHERE, "    ");
    ui.out();
    return;
  }

  const operation = operationCalled(first);
  if (operation) {
    nothingAfter(toHyphens(operation.name), topic.slice(1));
    if (json) return ui.out(JSON.stringify({ commands: [operationAsJson(operation)], everywhere: EVERYWHERE.map(optionAsJson) }, null, 2));
    ui.out();
    ui.out(`  ${bold(ui, `vigile ${toHyphens(operation.name)}`)}`);
    ui.out();
    ui.out(`  ${operation.description}`);
    ui.out();
    for (const line of usage(operation)) ui.out(`  ${accent(ui, line)}`);
    ui.out();
    ui.out(`  ${bold(ui, "Also")}`);
    options(ui, [AS, ...EVERYWHERE], "    ");
    ui.out();
    return;
  }
  throw new UsageError(`There is no command called "${first}".`, ["Run: vigile help"]);
}

const everythingAsJson = () => ({
  version: VERSION,
  commands: [...BUILTINS.map(builtinAsJson), ...OPERATIONS.map(operationAsJson)],
  everywhere: EVERYWHERE.map(optionAsJson),
});

/** How a built-in command stands in the list of all commands: its name and the words it takes. */
const listed = (builtin: Builtin): string => [builtin.name, ...builtin.words.map((word) => `<${word.name}>`)].join(" ");

function everything(ui: Ui): void {
  ui.out();
  ui.out(`  ${bold(ui, "vigile")} ${dim(ui, VERSION)}  ${dim(ui, "a shared plan for people and AI agents")}`);
  const size = Math.max(...BUILTINS.map((builtin) => listed(builtin).length), ...OPERATIONS.map((o) => o.name.length));
  for (const group of ["Run", "Set up"] as const) {
    ui.out();
    ui.out(`  ${bold(ui, group)}`);
    for (const builtin of BUILTINS.filter((one) => one.group === group)) ui.out(`    ${accent(ui, pad(listed(builtin), size))}  ${dim(ui, builtin.text)}`);
  }
  ui.out();
  ui.out(`  ${bold(ui, "Work with the plan")}  ${dim(ui, "the same operations as the MCP tools and the HTTP API")}`);
  for (const o of OPERATIONS) ui.out(`    ${accent(ui, pad(toHyphens(o.name), size))}  ${dim(ui, firstSentence(o.description))}`);
  options(ui, [AS], "    ", size);
  ui.out();
  ui.out(`  ${bold(ui, "Everywhere")}`);
  options(ui, EVERYWHERE, "    ", size);
  ui.out(`    ${accent(ui, pad(HELP.usage.slice("vigile ".length), size))}  ${dim(ui, `${HELP.text}; so does <command> --help`)}`);
  ui.out();
}
