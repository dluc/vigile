import { loadConfig } from "@vigile/config";
import { UsageError, configPath, flag, type Args } from "../args.js";
import { BackupRefused, takeBackup } from "../backup.js";
import { dim, note, plural, type Ui } from "../ui.js";
import { builtin, given } from "./builtin.js";

/** Writes a consistent copy of every tenant's data. Safe while the service runs; reads only. */
export async function backup(args: Args, ui: Ui): Promise<void> {
  // A backup is a plan: readable by its owner only, from the moment it is created.
  process.umask(0o077);
  const json = flag(args, "json");
  const loaded = loadConfig(configPath(args));
  const [target] = given(builtin("backup"), args).words;
  let taken;
  try {
    taken = takeBackup({ dataDir: loaded.dataDir, folder: target!, at: new Date() });
  } catch (error) {
    if (error instanceof BackupRefused) throw new UsageError(error.message, error.hints);
    throw error;
  }
  // Whole and in place, and not confirmed: that is a failure to say, as it was before, in the words it has.
  if (taken.unconfirmed !== null) throw new Error(taken.unconfirmed);
  const { folder, files: written } = taken;
  if (json) return ui.out(JSON.stringify({ folder, files: written }, null, 2));
  ui.out();
  for (const item of written) note(ui, "ok", `${item.tenant}  ${dim(ui, `${item.file}  ${Math.ceil(item.bytes / 1024)} KB`)}`);
  ui.out();
  ui.out(`  ${dim(ui, `${plural(written.length, "tenant")} backed up. The config file, which holds the API keys, is not included.`)}`);
  ui.out();
}
