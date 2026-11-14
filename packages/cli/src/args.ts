export interface Args {
  /** Words that are not options, in order. */
  words: string[];
  /** `--name value`, `--name=value`, and bare `--flag` as `true`. Names keep their hyphens. */
  options: Map<string, string | true>;
}

/**
 * The yes/no options: those of every command, of the built-in commands and of the operations. They never take
 * the next word as their value. A test holds this list to what the commands are described as taking.
 */
export const FLAGS = new Set(["json", "help", "permanent", "draft", "has-problems", "history", "top-level"]);

export function parseArgs(argv: string[]): Args {
  const words: string[] = [];
  const options = new Map<string, string | true>();
  /** The options seen so far, by the one name each has however it is written: --assigned-to and --assigned_to are one option. */
  const seen = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      words.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    // The same option twice is a slip of the hand: which of the two was meant cannot be known. An operation's
    // option may be written with hyphens or with underscores, and is the same option either way.
    const plain = name.replaceAll("_", "-");
    const earlier = seen.get(plain);
    if (earlier !== undefined) throw new UsageError(earlier === name ? `--${name} is given twice.` : `--${earlier} and --${name} are the same option, given twice.`);
    seen.set(plain, name);
    if (eq > 0) {
      options.set(name, arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (FLAGS.has(plain)) {
      // A yes/no option stands alone, or says which: `--draft false`.
      if (next === "true" || next === "false") {
        options.set(name, next);
        i++;
      } else options.set(name, true);
    } else if (next === undefined || next.startsWith("--")) options.set(name, true);
    else {
      options.set(name, next);
      i++;
    }
  }
  return { words, options };
}

/** What to say when an option that needs a value stands alone. */
export const needsValue = (name: string): UsageError =>
  new UsageError(`--${name} needs a value.`, [`If the value is empty in a script, the option must be left out. If the value itself starts with "--", write --${name}="--..." with an equals sign.`]);

/**
 * The value of an option, or nothing when it was not given. An option that was given without a value is
 * refused, never taken for one that was not given: `--as` with an empty variable after it must not act as
 * someone else, nor `--config` fall back to another file.
 */
export function take(args: Args, name: string): string | undefined {
  const value = args.options.get(name);
  args.options.delete(name);
  if (value === true) throw needsValue(name);
  return value;
}

/** Ends the reading of a command's arguments: what is left is something the command does not know. */
export function nothingElse(args: Args, usage: string[] = []): void {
  const [option] = args.options.keys();
  if (option !== undefined) throw new UsageError(`There is no option --${option} here.`, usage);
  if (args.words.length) throw new UsageError(`Unexpected "${args.words[0]}". Values with spaces need quotes.`, usage);
}

/** A yes/no option: given alone, or with true or false. Anything else is refused, never taken for no. */
export function flag(args: Args, name: string): boolean {
  const value = args.options.get(name);
  args.options.delete(name);
  if (value === undefined || value === "false") return false;
  if (value === true || value === "true") return true;
  throw new UsageError(`--${name} is a yes/no option: use it alone, or with true or false.`);
}

/** A mistake in how the command was typed. Shown without a stack trace. */
export class UsageError extends Error {
  constructor(
    message: string,
    readonly hints: string[] = [],
  ) {
    super(message);
    this.name = "UsageError";
  }
}

/** The config file every command needs. There is no default location: nothing is created under the home folder. */
export function configPath(args: Args, env: NodeJS.ProcessEnv = process.env): string {
  const path = take(args, "config") ?? env.VIGILE_CONFIG;
  if (!path) {
    throw new UsageError("No config file given.", [
      "Pass --config <file>, or set VIGILE_CONFIG.",
      "To create one: vigile config init --config <file>",
    ]);
  }
  return path;
}
