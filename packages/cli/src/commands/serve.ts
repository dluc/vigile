import { SETTINGS, loadConfig } from "@vigile/config";
import { VERSION } from "@vigile/core";
import { configPath, flag, type Args } from "../args.js";
import { everyHours, type BackupStatus } from "../backup-schedule.js";
import { startService, type Service } from "../service.js";
import { accent, bold, dim, fields, note, withWarnings, type Ui } from "../ui.js";
import { builtin, given } from "./builtin.js";

/** What the first lines say of the automatic backups: whether, how often, where, when the last was and when the next is. */
function backupsLine(status: BackupStatus): string {
  if (!status.enabled) return "off (backup.enabled is false)";
  const due = Date.parse(status.next_due!) <= Date.now() ? "now" : status.next_due;
  return `${everyHours(status.every_hours)} into ${status.folder}; ${status.last_at ? `last ${status.last_at}` : "none taken yet"}, next due ${due}`;
}

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
  let service: Service | undefined;
  let closing = false;
  let pendingSignal: string | null = null;
  const shutdown = (signal: string) => {
    if (!service) {
      if (pendingSignal) return void process.exit(0);
      return void (pendingSignal = signal);
    }
    if (closing) return void process.exit(0);
    closing = true;
    ui.out(dim(ui, `${signal} received, finishing the write in flight and stopping`));
    stopAndSettle(service, (line) => {
      ui.out(dim(ui, line));
    }).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  const onInterrupt = () => shutdown("SIGINT");
  const onTerminate = () => shutdown("SIGTERM");
  // The server can answer while asynchronous backup-folder readiness is finishing. Handle signals before that
  // window opens, remembering one until startService has returned its stoppable service object.
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  service = await startService({
    loaded,
    log: (line) => ui.out(line),
    warn: (line) => (held ? void held.push(line) : say(line)),
  }).catch((error: unknown) => {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    throw withWarnings(error, held ?? []);
  });
  if (pendingSignal) return void shutdown(pendingSignal);
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
    ["Backups", backupsLine(service.backups.status())],
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

  // A first signal stops the service. A second one, when the service has stopped and the process only waits
  // for a backup to end, ends the process at once: what that backup leaves is cleared by the next start.
}

/**
 * Stops the service, and then waits until nothing of it is left at work. A stop does not wait long for a
 * backup that is under way; the process must, since with the process goes the lock on the backup folder, and
 * that may go only when the backup's files are settled. `say` is told when the service has stopped and the
 * process stays for that.
 */
export async function stopAndSettle(service: Service, say: (line: string) => void): Promise<void> {
  await service.stop();
  let over = false;
  const settled = service.backups.over().then(() => (over = true));
  // Whether it is over already is known a moment later, not at once.
  await new Promise((resolve) => setImmediate(resolve));
  if (!over) say(`The service has stopped. Process ${process.pid} stays until the backup that was under way has ended and its files are settled, so that nobody else takes the backup folder before; send the signal again to end it now.`);
  await settled;
}
