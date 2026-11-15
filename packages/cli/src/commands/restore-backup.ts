import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { NoPlace, kindOf, loadConfig, placeOf, samePlace } from "@vigile/config";
import { assertTenantName } from "@vigile/storage";
import { backupTenantFile, holdFolder, holdTenantFiles, inspectTenantFile } from "@vigile/storage-sqlite";
import { UsageError, configPath, flag, type Args } from "../args.js";
import { BESIDE, BESIDE_COPY, FILES_WAIT_MS, isWorkingFile, putInPlace, recoverRestore, restoreInterrupted, stagingFile, openAsPlan } from "../restore.js";
import { StartupError, earlierService, earlierServiceRuns } from "../service.js";
import { dim, note, type Ui } from "../ui.js";
import { builtin, given } from "./builtin.js";

/** What a check found, without the "ok" of the part of it that passed. */
const found = (messages: string[]): string => (messages.filter((message) => message !== "ok").join("; ") || messages.join("; "));

/**
 * A backup is named after its tenant and the moment it was taken: default-20261113-090247-123.sqlite. One that
 * the service took by itself says so after the moment: default-20261113-090247-123-auto.sqlite.
 */
const BACKUP_NAME = /^([a-z][a-z0-9-]*)-\d{8}-\d{6}(?:-\d{3})?(?:-auto)?\.sqlite$/;

/**
 * Puts a backup in the place of a tenant's data. The service must be stopped: the data folder is held for as
 * long as this takes. What was there, with the files a crash left beside it, is set aside and not deleted,
 * because a copy of a backup over the data alone would have the leftovers replayed onto it and break it.
 * The copy is made and checked before anything is moved, so that a restore that cannot be finished leaves the
 * data as it was.
 */
export async function restoreBackup(args: Args, ui: Ui): Promise<void> {
  // What this writes is a plan: readable by its owner only, from the moment it is created.
  process.umask(0o077);
  const json = flag(args, "json");
  const loaded = loadConfig(configPath(args));
  const typed = given(builtin("restore-backup"), args);
  // The file the words lead to, as the system walks them: the one that is then read, checked and named.
  let source: string;
  try {
    source = placeOf(typed.words[0]!);
  } catch (error) {
    // A path that leads nowhere is said to, with why: no other file is looked for in its place.
    if (error instanceof NoPlace) throw new UsageError(`${error.message}.`, ["Give the backup file by a path that leads to it."]);
    throw error;
  }
  if (!existsSync(source)) throw new UsageError(`There is no file ${source}.`);
  // A backup is a plain file. Anything else under the name, a pipe or a folder, is not opened to find out.
  const kind = kindOf(statSync(source));
  if (kind !== "file") throw new UsageError(`${source} is not a file: it is a ${kind}.`, ["Give a file that vigile backup wrote, or one of the service's automatic backups."]);
  const tenant = typed.value("tenant") ?? BACKUP_NAME.exec(basename(typed.words[0]!))?.[1];
  if (!tenant) throw new UsageError(`The name of ${basename(source)} does not say which tenant it is a backup of.`, ["Say it: vigile restore-backup <backup file> --tenant default"]);
  // A tenant's name is a file's name in the data folder, and nothing that leads out of it.
  try {
    assertTenantName(tenant);
  } catch (error) {
    throw new UsageError(`"${tenant}" cannot be the name of a tenant: ${(error as Error).message}`);
  }
  const target = join(loaded.dataDir, `${tenant}.sqlite`);
  // The data file, and what lies beside it, are what a restore moves aside: none of them is a backup of the data.
  if ([target, ...BESIDE.map((suffix) => target + suffix)].some((file) => samePlace(source, file))) {
    throw new UsageError(`${source} is the data itself, not a backup of it.`, ["Give a file that vigile backup wrote, or one of the service's automatic backups."]);
  }
  // The copy of the backup is made under this name beside the data, and removed when the restore ends. A
  // backup that is that very file would be copied onto itself and then moved or removed.
  const incoming = stagingFile(loaded.dataDir, tenant);
  if (isWorkingFile(loaded.dataDir, source)) {
    throw new UsageError(`${source} is a file that a restore works with in the data folder, and would not survive being restored from.`, ["Move the file somewhere else, or give it another name, and restore from there."]);
  }

  const report = inspectTenantFile(tenant, source);
  if (!report.ok) throw new UsageError(`${source} cannot be restored: ${found(report.messages)}.`, ["Choose another backup."]);

  mkdirSync(loaded.dataDir, { recursive: true, mode: 0o700 });
  // A service from before the folder was held by a lock of the system is not kept out by that lock.
  const earlier = earlierService(loaded.dataDir);
  if (earlier) throw earlierServiceRuns(loaded.dataDir, earlier);
  let release: (() => void) | null;
  try {
    release = holdFolder(loaded.dataDir);
  } catch (error) {
    throw new StartupError(`The data folder ${loaded.dataDir} cannot be taken for a restore: ${(error as Error).message}.`, ["Give this account read and write access to the folder and to what is in it."]);
  }
  if (!release) throw new StartupError(`A Vigile service, or another restore, is using ${loaded.dataDir}.`, ["Stop the service first, restore, then start it again."]);
  const held = release;
  // The files of the tenants as well, against a backup: one that is being taken has them open, and must not have
  // them moved away under it.
  let files: (() => void) | null;
  try {
    files = holdTenantFiles(loaded.dataDir, FILES_WAIT_MS);
  } catch (error) {
    held();
    throw new StartupError(`The data folder ${loaded.dataDir} cannot be taken for a restore: ${(error as Error).message}.`, ["Give this account read and write access to the folder and to what is in it."]);
  }
  if (!files) {
    held();
    throw new StartupError(`A backup of ${loaded.dataDir} is being taken.`, ["Restore when it has finished."]);
  }
  const letGo = files;
  try {
    // An earlier restore that was killed half-way is put in order first: finished if its backup was in place,
    // undone if not.
    const earlier = recoverRestore(loaded.dataDir, tenant);
    if (earlier && !json) ui.out(`  ${dim(ui, earlier)}`);
    // Putting an earlier restore in order moves files back to where they were. The file to restore from may
    // have been one of them: what that restore had set aside. It is the data again now, not a backup of it.
    if (!existsSync(source) || samePlace(source, target)) {
      throw new UsageError(`${source} was set aside by a restore that was interrupted. That restore has now been put in order, which moved the file: ${earlier ?? "the data is as it was before it."}`, [
        "Look at what is in the data folder now, and choose the backup to restore from again.",
      ]);
    }
    // 1. The backup is copied beside the data under another name, and checked there. The copy is made by the
    // store itself and not file by file: a tenant is its data file and what lies beside it, and a source that
    // was last used by a service that was killed has changes in the file beside it that a plain copy of the
    // data file would leave behind. The copy is one whole file, flushed.
    // No restore is recorded as under way at this point, so a copy that lies there is one that nobody needs.
    for (const suffix of BESIDE_COPY) rmSync(incoming + suffix, { force: true });
    try {
      backupTenantFile(source, incoming);
    } catch (error) {
      throw new Error(`${source} could not be copied to ${incoming}: ${(error as Error).message}. Nothing was changed.`, { cause: error });
    }
    chmodSync(incoming, 0o600);
    const copied = inspectTenantFile(tenant, incoming);
    if (!copied.ok) throw new Error(`The copy of the backup does not pass the check: ${found(copied.messages)}. Nothing was changed.`);
    // A sound database with a plan's tables in it is not yet a plan the service starts on. The copy is opened
    // the way the service opens its data, before it may take the place of data that works.
    const plan = await openAsPlan(tenant, incoming);
    if ("why" in plan) throw new UsageError(`${source} cannot be restored: ${plan.why}. Nothing was changed.`, ["Choose another backup."]);
    // The plan is sound, and the config may still not go with it: a backup from before the user that connections
    // without a key act as was created. That is no reason to refuse the backup, which may be the very one that
    // is wanted; it is a setting to change before the service is started, and it is said, with how.
    const warnings: string[] = [];
    const keyless = loaded.config.auth.keyless_user;
    if (keyless && !plan.users.includes(keyless)) {
      warnings.push(`The config lets connections without a key act as "${keyless}", and the restored plan has no such user: the service will not start like this. Before starting it, run: vigile config set auth.keyless_user "" (or name a user the plan has: ${plan.users.join(", ")}).`);
    }

    // 2. Only now is what was there moved aside, and the copy given the data file's name.
    const { aside, moved } = putInPlace(loaded.dataDir, tenant, incoming);

    const result = { tenant, file: target, revision: copied.revision, from: source, set_aside: moved.length ? { folder: aside, files: moved } : null, ...(earlier ? { recovered: earlier } : {}), ...(warnings.length ? { warnings } : {}) };
    if (json) return ui.out(JSON.stringify(result, null, 2));
    ui.out();
    note(ui, "ok", `${tenant}  ${dim(ui, `restored from ${source}, revision ${copied.revision}`)}`);
    if (moved.length) ui.out(`    ${dim(ui, `What was there is kept in ${aside}. Delete that folder once the restored data is what you wanted.`)}`);
    for (const warning of warnings) note(ui, "warn", warning);
    ui.out(`    ${dim(ui, "API keys that were issued or replaced after this backup was taken no longer count; the service says which at its start. Replace them with: vigile user reset-key <username>")}`);
    ui.out(`    ${dim(ui, "Start the service again: vigile serve")}`);
    ui.out();
  } finally {
    // The copy of the backup is what tells a restore that was undone from one that was finished. While a note
    // says that a restore, this one or an earlier one, is not in order yet, the copy stays for whoever puts it
    // in order.
    let failure: unknown;
    const failed = (error: unknown): void => {
      failure = failure === undefined ? error : new AggregateError([failure, error], "Restore cleanup had more than one failure.");
    };
    try {
      if (!restoreInterrupted(loaded.dataDir)) for (const suffix of BESIDE_COPY) rmSync(incoming + suffix, { force: true });
    } catch (error) {
      failed(error);
    }
    try {
      letGo();
    } catch (error) {
      failed(error);
    }
    try {
      held();
    } catch (error) {
      failed(error);
    }
    if (failure !== undefined) throw failure;
  }
}
