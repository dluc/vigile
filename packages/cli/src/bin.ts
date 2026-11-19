#!/usr/bin/env node
import { ConfigBusy, ConfigError, loadConfig } from "@vigile/config";
import { FeatureSelection, OPERATIONS, VERSION, toHyphens } from "@vigile/core";
import { keyRefused } from "./answers.js";
import { UsageError, configPath, flag, parseArgs, type Args } from "./args.js";
import { NoAnswerError, NotRunningError, ServiceError } from "./client.js";
import { EXIT_CODES, type CommandLineCode } from "./codes.js";
import { backup } from "./commands/backup.js";
import { config } from "./commands/config.js";
import { describe } from "./commands/describe.js";
import { doctor } from "./commands/doctor.js";
import { help } from "./commands/help.js";
import { builtinsUnder } from "./commands/builtin.js";
import { restoreBackup } from "./commands/restore-backup.js";
import { runOperation } from "./commands/operation.js";
import { serve } from "./commands/serve.js";
import { user } from "./commands/user.js";
import { NotReachedError } from "./reach.js";
import { renderError } from "./render.js";
import { LIMITS, StartupError } from "./service.js";
import { createUi, failure, warningsOf, type Ui } from "./ui.js";

/** Returns an exit code, or nothing for success. */
type Command = (args: Args, ui: Ui) => Promise<number | void>;

const COMMANDS: Record<string, Command> = { serve, config, user, doctor, backup, "restore-backup": restoreBackup, describe };

async function run(args: Args, ui: Ui): Promise<number> {
  // `--version` alone asks for the CLI's version; after a command it is that command's own option.
  if (!args.words.length && args.options.has("version")) {
    ui.out(flag(args, "json") ? JSON.stringify({ version: VERSION }) : VERSION);
    return 0;
  }
  const name = args.words.shift();
  if (!name || name === "help" || args.options.has("help")) {
    // The help of the one named after `help`: `config set`, with its second word. Or of the command that was
    // typed with --help, where what follows its name is what it was given.
    const topic = name === "help" || !name ? args.words[0] : name;
    const useConfig = !(topic && builtinsUnder(topic).length) && (args.options.has("config") || process.env.VIGILE_CONFIG);
    const selection = useConfig ? new FeatureSelection(loadConfig(configPath(args)).config.features) : new FeatureSelection();
    const operations = OPERATIONS.filter(o => selection.operation(o.name)).map(o => selection.profile(o));
    if (name === "help" || !name) help(ui, args.words, flag(args, "json"), false, operations);
    else help(ui, [name, ...args.words], flag(args, "json"), true, operations);
    return 0;
  }
  // Only a command that is listed: every object answers to names such as "constructor" with something callable.
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (command) return (await command(args, ui)) ?? 0;
  const operation = OPERATIONS.find((o) => toHyphens(o.name) === name || o.name === name);
  if (operation) {
    await runOperation(operation, args, ui);
    return 0;
  }
  throw new UsageError(`There is no command called "${name}".`, ["Run: vigile help"]);
}

/** What a failure of the command line itself is called, what it says, and what to do about it. */
function told(error: unknown): [code: CommandLineCode, message: string, actions: string[]] {
  if (error instanceof NotReachedError) return [error.code, error.message, error.hints];
  if (error instanceof NotRunningError) return ["not_running", error.message, ["Start it: vigile serve --config <file>", "Or check it: vigile doctor --config <file>"]];
  if (error instanceof NoAnswerError) {
    // What is said of a change that got no answer holds in whatever order the service gets to its requests:
    // nothing is promised of one sent later, and what makes the outcome certain is named.
    const open = [
      "The service carries out a request it has taken also after the connection has ended, and possibly after requests that were sent later: what is not there now may still come.",
      `This request is over when the service's log has the line of its operation (it has none when log_level is quiet), or when the service has been stopped and started again, which ends whatever it had taken. A request that does not reach the service in full within ${LIMITS.requestMs / 1000} seconds is dropped, and leaves no such line.`,
    ];
    const look = [
      "vigile get <id> --history shows an item with the latest changes made to it; vigile list-tasks, vigile list-projects and vigile user list show what is there now.",
      "Sent again, a change is sure to be stored only once when it names its item by an ID together with a version: the ID of a task, of a user (USER-007) or of a project is never given twice, so of two such requests the later one to be carried out is refused.",
      "A request that names a user by its username acts on whoever has the name when it is carried out, and one that names no version on the item as it is then: a task is created once for each request, and a key is replaced by each reset, the last one carried out being the one in force. Do not send such a request again while an earlier one is outstanding: wait until it is over, or name the user by its ID, which vigile get <username> --kind user shows.",
    ];
    return ["no_answer", error.message, [...(error.change ? [...open, ...(error.advice ?? look)] : (error.advice ?? [])), "Check the service: vigile doctor --config <file>"]];
  }
  if (error instanceof UsageError) return ["usage", error.message, error.hints];
  if (error instanceof StartupError) return ["cannot_start", error.message, error.hints];
  if (error instanceof ConfigBusy) return ["config_busy", error.message, ["Nothing was changed. Try again in a moment."]];
  if (error instanceof ConfigError) return ["config_invalid", `The config is not correct${error.path ? `: ${error.path}` : ""}`, error.issues];
  return ["failed", error instanceof Error ? error.message : String(error), []];
}

/** A refusal of the service as JSON. One that cannot be written out, nested deeper than any refusal is, is said to be that. */
function refusalAsJson(body: unknown): string {
  try {
    return JSON.stringify({ error: body }, null, 2);
  } catch {
    return JSON.stringify({ error: { code: "internal", message: "The service refused the request, and did not say why in a way this command line can read." } }, null, 2);
  }
}

async function main(): Promise<number> {
  const ui = createUi();
  // Whether errors are to be JSON is asked of the arguments as they were typed, since reading them may be what fails.
  // What follows a bare "--" is words and not options, here as in the reading of the arguments: an item may be
  // called "--json".
  const typed = process.argv.slice(2);
  const options = typed.includes("--") ? typed.slice(0, typed.indexOf("--")) : typed;
  // A value that is neither yes nor no is refused, and refused as JSON: whoever wrote it meant to say something
  // about JSON, and did not say no.
  const json = options.some((arg, i) => (arg.startsWith("--json=") && arg !== "--json=false") || (arg === "--json" && options[i + 1] !== "false"));
  try {
    return await run(parseArgs(process.argv.slice(2)), ui);
  } catch (error) {
    if (error instanceof ServiceError) {
      if (json) ui.err(refusalAsJson(error.body));
      // The service's advice on a refused key is for whoever holds the key. Here that is the command line, which
      // took it from the config file: that is said as well, with what helps when the key refused is the admin's.
      else if (keyRefused(error)) {
        renderError(ui, { ...error.body, actions: [...(Array.isArray(error.body.actions) ? error.body.actions : []), "The command line took the key from the config file. vigile doctor says what is wrong with it; vigile user reset-key <username> issues a new one, for admin also when its key is refused."] });
      } else renderError(ui, error.body);
    } else {
      // A failure of the command line itself: the same in words and, when JSON was asked for, in the shape the
      // service's errors have, so that a script reads every failure the same way.
      const [code, message, actions] = told(error);
      const warnings = warningsOf(error);
      if (json) ui.err(JSON.stringify({ error: { code, message, ...(actions.length ? { actions } : {}) }, ...(warnings.length ? { warnings } : {}) }, null, 2));
      else failure(ui, message, actions);
    }
    return error instanceof NoAnswerError ? EXIT_CODES.no_answer : EXIT_CODES.failed;
  }
}

// Output piped into a program that stops reading early, such as `head`, is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
}

main().then((code) => {
  // `serve` keeps running; every other command ends here.
  if (code !== 0) process.exit(code);
});
