import { SETTINGS, loadConfig } from "@vigile/config";
import { VERSION } from "@vigile/core";
import { configPath, flag, type Args } from "../args.js";
import { startService } from "../service.js";
import { accent, bold, dim, fields, note, withWarnings, type Ui } from "../ui.js";
import { builtin, given } from "./builtin.js";

export async function serve(args: Args, ui: Ui): Promise<void> {
  const path = configPath(args);
  // Every command takes --json. Here it makes a failure to start be reported as JSON, which is done where
  // every command's failures are reported; what the running service writes is its log.
  const json = flag(args, "json");
  // Any setting can be overridden for one run, as in `--listen.port 8701`.
  const typed = given(builtin("serve"), args);
  const overrides: Record<string, string> = {};
  for (const setting of SETTINGS) {
    const value = typed.value(setting.key);
    if (value !== undefined) overrides[setting.key] = value;
  }
  const loaded = loadConfig(path, process.env, overrides);
  const { config } = loaded;

  // The service outlives its log. For other commands a reader that goes away, as `head` does, ends the command;
  // here whatever reads the output, or the disk it is written to, must not be able to stop the service.
  for (const stream of [process.stdout, process.stderr]) {
    stream.removeAllListeners("error");
    stream.on("error", () => {});
  }

  // What the service warns of while it starts is written as it comes. When a failure is to be reported as JSON,
  // it is held until the service has started: should it not, the warnings go into the report of the failure,
  // which is then all there is on the error output and can be read as JSON.
  const say = (line: string) => ui.err(`${ui.paint("yellow", "warning")} ${line}`);
  let held: string[] | null = json ? [] : null;
  const service = await startService({
    loaded,
    log: (line) => ui.out(line),
    warn: (line) => (held ? void held.push(line) : say(line)),
  }).catch((error: unknown) => {
    throw withWarnings(error, held ?? []);
  });
  for (const line of held ?? []) say(line);
  held = null;

  ui.out();
  ui.out(`  ${bold(ui, "vigile")} ${dim(ui, VERSION)}  ${accent(ui, config.name)}`);
  ui.out();
  fields(ui, [
    ["MCP", service.urls.mcp],
    ["Web", service.urls.web],
    ["API", `${service.urls.base}/api`],
    ["Config", loaded.path],
    ["Data", loaded.dataDir],
  ]);
  ui.out();
  const open = !service.loopbackOnly;
  if (config.auth.keyless_user) {
    note(
      ui,
      "warn",
      `Auth is off for everyone but admin: a connection without an API key acts as ${config.auth.keyless_user}.`,
      open ? "The service listens beyond this machine, so anyone who can reach it can read and write." : undefined,
    );
    ui.out(`    ${dim(ui, "To require a key from everyone: vigile config set auth.keyless_user \"\"")}`);
  } else {
    note(ui, "ok", "Every connection needs an API key.");
  }
  ui.out();

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    ui.out(dim(ui, `${signal} received, finishing the write in flight and stopping`));
    service.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
