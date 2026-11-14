import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "@vigile/config";
import { backupTenantFile, flushFolder, holdTenantFiles, tenantFiles } from "@vigile/storage-sqlite";
import { UsageError, configPath, flag, type Args } from "../args.js";
import { samePlace } from "../paths.js";
import { FILES_WAIT_MS, restoreInterrupted } from "../restore.js";
import { dim, note, plural, type Ui } from "../ui.js";
import { builtin, given } from "./builtin.js";

/** Writes a consistent copy of every tenant's data. Safe while the service runs; reads only. */
export async function backup(args: Args, ui: Ui): Promise<void> {
  // A backup is a plan: readable by its owner only, from the moment it is created.
  process.umask(0o077);
  const json = flag(args, "json");
  const loaded = loadConfig(configPath(args));
  const [target] = given(builtin("backup"), args).words;
  const folder = resolve(target!);
  // A backup among the data would be taken for a tenant of its own by the next start. The folder is the data
  // folder also when it is reached by another name, through a link.
  if (folder === resolve(loaded.dataDir) || samePlace(folder, loaded.dataDir)) throw new UsageError("A backup cannot go into the data folder itself.", ["Choose a folder outside it."]);
  if (!existsSync(loaded.dataDir)) throw new UsageError(`There is no data yet at ${loaded.dataDir}.`);
  // From the look at what there is until the last copy is made, no restore and no recovery of one may move a
  // tenant's files: a copy begun on a file that is then moved away would leave out what it had not read yet.
  // The running service moves nothing, and is not kept out by this, nor does it keep a backup out.
  let release: (() => void) | null;
  try {
    release = holdTenantFiles(loaded.dataDir, FILES_WAIT_MS);
  } catch (error) {
    throw new UsageError(`The data in ${loaded.dataDir} cannot be kept still for a backup: ${(error as Error).message}.`, ["Give this account write access to the data folder: a backup leaves a lock file there."]);
  }
  if (!release) throw new UsageError(`A restore, or another backup, is at work in ${loaded.dataDir}.`, ["Take the backup when it has finished."]);
  const written: Array<{ tenant: string; file: string; bytes: number }> = [];
  try {
    // Half-way through a restore a tenant's file is somewhere else, or without what belongs beside it: a backup
    // taken now would miss the tenant, or part of it, and say that all is well.
    if (restoreInterrupted(loaded.dataDir)) {
      throw new UsageError(`A restore in ${loaded.dataDir} was interrupted, and the data is not in order yet.`, ["Start the service, or run restore-backup again: either puts it in order first. Then take the backup."]);
    }
    const files = tenantFiles(loaded.dataDir);
    if (!files.length) throw new UsageError(`There is no data yet at ${loaded.dataDir}.`);

    mkdirSync(folder, { recursive: true, mode: 0o700 });
    // Asked again now that the folder is there for certain: a link made in the meantime leads where it leads.
    if (samePlace(folder, loaded.dataDir)) throw new UsageError("A backup cannot go into the data folder itself.", ["Choose a folder outside it."]);
    // To the millisecond, so that two backups in a row never want the same name.
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "-").replace("Z", "").replace("T", "-");
    for (const { tenant, file } of files) {
      const destination = join(folder, `${tenant}-${stamp}.sqlite`);
      backupTenantFile(file, destination);
      chmodSync(destination, 0o600);
      written.push({ tenant, file: destination, bytes: statSync(destination).size });
    }
    // A backup is written once its folder says it holds it.
    flushFolder(folder);
  } finally {
    release();
  }
  if (json) return ui.out(JSON.stringify({ folder, files: written }, null, 2));
  ui.out();
  for (const item of written) note(ui, "ok", `${item.tenant}  ${dim(ui, `${item.file}  ${Math.ceil(item.bytes / 1024)} KB`)}`);
  ui.out();
  ui.out(`  ${dim(ui, `${plural(written.length, "tenant")} backed up. The config file, which holds the API keys, is not included.`)}`);
  ui.out();
}
