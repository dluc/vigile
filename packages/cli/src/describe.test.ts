import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SETTINGS, configSchema } from "@vigile/config";
import { ERROR_CODES, FeatureSelection, GUIDE_TOPICS, LINK_TYPES, OPERATIONS, PROBLEM_CODES, PROJECT_STATUSES, RULES, TASK_MOVES, TASK_STATUSES, VERSION, instanceGuide, httpStatus } from "@vigile/core";
import { INSTRUCTIONS } from "@vigile/mcp";
import { COMMAND_LINE_CODES } from "./codes.js";
import { BUILTINS, EVERYWHERE, calledAs } from "./commands/builtin.js";
import { DESCRIPTION_FORMAT, description } from "./commands/describe.js";

const BIN = fileURLToPath(new URL("./bin.js", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));

/** Runs the command with nothing of this machine's environment but the path. */
function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, out, err) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out, err });
    });
  });
}

/** The text of every source file of a package that is not a test. */
function source(folder: string): string {
  const texts: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) texts.push(readFileSync(path, "utf8"));
    }
  };
  walk(join(root, folder));
  return texts.join("\n");
}

/** Every name of a member, at any depth, with where it stands. Names that are data, not members, are left out by `skip`. */
function memberNames(value: unknown, at: string, skip: (path: string) => boolean, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((each, index) => memberNames(each, `${at}[${index}]`, skip, found));
  else if (value !== null && typeof value === "object") {
    if (skip(at)) return found;
    for (const [name, inner] of Object.entries(value)) {
      found.push(`${at}.${name}`);
      memberNames(inner, `${at}.${name}`, skip, found);
    }
  }
  return found;
}

describe("vigile describe", () => {
  it("prints the description as JSON, with no config, no plan and nothing of the machine it runs on", async () => {
    const printed = await run(["describe"]);
    assert.deepEqual([printed.code, printed.err], [0, ""]);
    const read = JSON.parse(printed.out);
    assert.deepEqual(read, JSON.parse(JSON.stringify(description())), "what is printed is the description, and all of it is JSON");
    assert.deepEqual([read.format, read.name, read.version], [DESCRIPTION_FORMAT, "vigile", VERSION]);
    for (const private_ of [homedir(), tmpdir(), root.replace(/\/$/, ""), process.cwd()]) assert.ok(!printed.out.includes(private_), `the description names a folder of this machine: ${private_}`);
    assert.doesNotMatch(printed.out, /vig_[A-Za-z0-9_-]{20,}/, "and no key");
    // The same with what every command takes, which it has no use for; and it is the same each time.
    assert.equal((await run(["describe", "--json"])).out, printed.out);
    assert.equal((await run(["describe", "--config", join(tmpdir(), "there-is-no-such-config.toml")])).out, printed.out);
    assert.equal((await run(["describe"], { VIGILE_CONFIG: join(tmpdir(), "there-is-no-such-config.toml") })).out, printed.out);
  });

  it("refuses what it does not take, as every command does", async () => {
    for (const args of [["describe", "operations"], ["describe", "--format", "yaml"]]) {
      const refused = await run([...args, "--json"]);
      assert.equal(refused.code, 1, args.join(" "));
      assert.equal(JSON.parse(refused.err).error.code, "usage", args.join(" "));
      assert.equal(refused.out, "");
    }
  });

  it("is listed with the commands, in the help and in the README", async () => {
    assert.ok(JSON.parse((await run(["help", "--json"])).out).commands.some((command: { command: string }) => command.command === "describe"));
    assert.ok(readFileSync(join(root, "README.md"), "utf8").includes("| `vigile describe` |"));
  });

  it("has every operation, with its input as JSON Schema and the options of its command", () => {
    const { operations } = description();
    assert.deepEqual(operations.map((one) => one.name), OPERATIONS.map((operation) => operation.name));
    for (const operation of OPERATIONS) {
      const described = operations.find((one) => one.name === operation.name)!;
      const input = described.input as { type?: string; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown };
      assert.deepEqual([described.command, described.kind, described.access, described.description], [operation.name.replaceAll("_", "-"), operation.kind, operation.access, operation.description], operation.name);
      assert.equal(input.type, "object", operation.name);
      assert.deepEqual(Object.keys(input.properties ?? {}), Object.keys(operation.input.shape), `${operation.name}: every field of the input, and no other`);
      assert.equal(input.additionalProperties, false, `${operation.name}: a field that is not known is refused, and the schema says so`);
      // What the schema calls required is what the operation refuses to go without.
      for (const field of Object.keys(operation.input.shape)) {
        const without = operation.input.safeParse(Object.fromEntries(Object.keys(operation.input.shape).filter((name) => name !== field).map((name) => [name, undefined])));
        const missing = !without.success && without.error.issues.some((issue: { path: PropertyKey[] }) => issue.path.length === 1 && issue.path[0] === field);
        assert.equal((input.required ?? []).includes(field), missing, `${operation.name}.${field}: required in the schema exactly when the operation needs it`);
      }
      assert.deepEqual(described.options.map((option) => option.name), Object.keys(operation.input.shape).map((name) => name.replaceAll("_", "-")), `${operation.name}: an option for each field`);
    }
  });

  it("has every command with how it is called, and the options every command takes", () => {
    const { commands, options } = description();
    assert.deepEqual(commands.slice(0, BUILTINS.length).map((command) => [command.name, command.usage, command.description]), BUILTINS.map((builtin) => [builtin.name, calledAs(builtin), builtin.text]));
    // The help is a command too, and is no built-in one: it is named here by itself.
    assert.deepEqual(commands.slice(BUILTINS.length).map((command) => [command.name, command.usage, command.words]), [["help", "vigile help [command]", ["command"]]]);
    for (const builtin of BUILTINS) assert.deepEqual(commands.find((command) => command.name === builtin.name)!.options.map((option) => option.name), builtin.options.map((option) => option.name), builtin.name);
    assert.deepEqual(options.everywhere.map((option) => option.name), EVERYWHERE.map((option) => option.name));
    assert.deepEqual(options.operations.map((option) => option.name), ["as"]);
  });

  it("has every setting with the default a config that says nothing has, and the variable that sets it", () => {
    const { settings } = description();
    const defaults = configSchema.parse({}) as Record<string, unknown>;
    assert.deepEqual(settings.map((setting) => [setting.key, setting.environment, setting.type]), SETTINGS.map((setting) => [setting.key, setting.env, setting.type]));
    for (const setting of settings) {
      const inForce = setting.key.split(".").reduce<unknown>((at, part) => (at as Record<string, unknown>)[part], defaults);
      assert.deepEqual(setting.default, inForce, setting.key);
    }
    // The bounds are the ones a value is checked against.
    const port = settings.find((setting) => setting.key === "listen.port")!;
    assert.deepEqual([port.minimum, port.maximum], [1, 65535]);
    for (const [value, taken] of [[0, false], [1, true], [65535, true], [65536, false]] as const) assert.equal(configSchema.safeParse({ listen: { port: value } }).success, taken, `listen.port ${value}`);
    assert.deepEqual(settings.find((setting) => setting.key === "log_level")!.values, ["debug", "info", "quiet"]);
  });

  it("names every error code with its HTTP status, every rule and every problem, and what the command line itself fails with", async () => {
    const { errors, problems } = description();
    assert.deepEqual(errors.codes, ERROR_CODES.map((code) => ({ code, http_status: httpStatus(code) })));
    assert.deepEqual([errors.rules, problems], [RULES, PROBLEM_CODES]);
    // A rule or a problem that is listed is one the code can say: each is named where it is checked.
    const core = source("packages/core/src");
    for (const rule of RULES) assert.match(core, new RegExp(`\\brefused\\(\\s*"${rule}"`), `no change is refused by the rule ${rule}`);
    const calc = readFileSync(join(root, "packages/core/src/calc.ts"), "utf8");
    for (const problem of PROBLEM_CODES) assert.match(calc, new RegExp(`\\bcode: "${problem}"`), `nothing says the problem ${problem}`);
    assert.deepEqual([...RULES].sort(), [...RULES], "the rules stand in the order of the alphabet");
    // The command line's own codes: every one is said somewhere, and a failure says one of them.
    const bin = readFileSync(join(root, "packages/cli/src/bin.ts"), "utf8") + readFileSync(join(root, "packages/cli/src/reach.ts"), "utf8");
    for (const code of COMMAND_LINE_CODES) assert.ok(bin.includes(`"${code}"`), `the command line never fails with ${code}`);
    assert.deepEqual(errors.command_line, { codes: [...COMMAND_LINE_CODES], exit_codes: { done: 0, failed: 1, no_answer: 2 } });
    const failed = await run(["there-is-no-such-command", "--json"]);
    assert.deepEqual([failed.code, JSON.parse(failed.err).error.code], [1, "usage"]);
  });

  it("leaves out no command the program takes: each one it names is one, and each word the program answers to is named", async () => {
    const { commands, operations } = description();
    const named = new Set([...commands.map((command) => command.name.split(" ")[0]!), ...operations.map((operation) => operation.command)]);
    // What the program lists when it is asked, in words: every first word of a line of a command is described.
    const listed = (await run(["help"])).out.split("\n").map((line) => /^ {4}([a-z][a-z-]*)\b/.exec(line)?.[1]).filter((word): word is string => word !== undefined);
    assert.ok(listed.includes("help") && listed.includes("serve") && listed.includes("create-task"), "the list of commands was read");
    for (const word of listed) assert.ok(named.has(word), `the program lists "${word}", and the description has no such command`);
    // And each command that is described is one the program takes: it shows its help and ends well.
    for (const command of commands) {
      const shown = await run([...command.name.split(" "), "--help"]);
      assert.deepEqual([shown.code, shown.err], [0, ""], `vigile ${command.name} --help`);
    }
    for (const word of ["help", "describe"]) assert.equal((await run(["help", word])).code, 0, `vigile help ${word}`);
  });

  it("has the statuses and their moves, the link types, the limits, the guide and what an agent is told", () => {
    const described = description();
    assert.deepEqual([described.tasks.statuses, described.tasks.moves, described.projects.statuses, described.link_types], [TASK_STATUSES, TASK_MOVES, PROJECT_STATUSES, LINK_TYPES]);
    for (const status of [...described.tasks.finished]) assert.ok(TASK_STATUSES.includes(status));
    assert.deepEqual(described.guide.topics, GUIDE_TOPICS.map((topic) => instanceGuide(new FeatureSelection(), topic)));
    assert.equal(described.mcp.instructions, INSTRUCTIONS);
    assert.deepEqual(described.mcp.prompts.map((prompt) => prompt.name), ["plan_work", "pick_up_work", "report_problem"]);
    for (const [group, limits] of Object.entries(described.limits)) {
      assert.ok(Object.keys(limits).length > 0, group);
      for (const [name, value] of Object.entries(limits)) assert.ok(Number.isFinite(value) && value > 0, `${group}.${name}`);
    }
    assert.equal(described.limits.plan.page, 100);
    assert.deepEqual([described.limits.api.body_bytes, described.limits.mcp.body_bytes], [1024 * 1024, 1024 * 1024], "what a request to the API and to MCP may weigh");
    // The Node.js it says it needs is the one the repository asks for.
    assert.equal(`>=${described.requires.node}`, JSON.parse(readFileSync(join(root, "package.json"), "utf8")).engines.node);
  });

  it("names its members the way the operations name theirs: in small letters, with underscores", () => {
    // Under these the names are data: the fields of an input and of a schema, the settings' defaults, and what a guide example sends.
    const data = /\.input$|\.default$|\.examples\[\d+\]\.calls\[\d+\]\.input$|\.moves$|\.sometimes$/;
    const names = memberNames(JSON.parse(JSON.stringify(description())), "description", (path) => data.test(path));
    assert.ok(names.length > 400, `${names.length} members`);
    for (const name of names) assert.match(name.slice(name.lastIndexOf(".") + 1), /^[a-z][a-z0-9_]*$/, name);
  });
});
