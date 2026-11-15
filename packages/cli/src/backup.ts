import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, rmdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { backupTenantFile, everHeld, flushFolder, holdFile, holdFileAsync, holdFolderAsync, holdTenantFiles, tenantFiles, type AsyncRelease } from "@vigile/storage-sqlite";
import { REMEMBERED_MOST_BYTES, decodeRemembered, encodeRemembered, type BackupMemory, type BackupOutcome, type BackupSource } from "./backup-schedule.js";
import { NoPlace, NotAFile, createPlainFile, kindAt, openPlainFile, placeOf, samePlace, somethingAt } from "@vigile/config";
import { FILES_WAIT_MS, restoreInterrupted } from "./restore.js";

/** A backup that is not taken because of where things stand, with what to do about it. */
export class BackupRefused extends Error {
  constructor(
    message: string,
    readonly hints: string[] = [],
  ) {
    super(message);
    this.name = "BackupRefused";
  }
}

export interface BackupRequest {
  dataDir: string;
  folder: string;
  /** The moment the backup is named after. */
  at: Date;
  /** For a backup the service takes by itself: how many of a tenant's automatic backups are kept. */
  automatic?: { keep: number };
  /**
   * The copies this backup is to write, when whoever asks has made them its own already: see `prepareCopies`.
   * The service does, so that it knows every file of a backup from before the backup's thread starts.
   */
  copies?: PlannedCopy[];
  /** Identity of an already-held backup folder, for an automatic worker that must never follow a replacement. */
  folderIdentity?: { device: number; inode: number };
  /** Told where the backup has got to, as it goes. For the tests, which stop a backup at each of these places. */
  step?(point: BackupPoint, tenant?: string): void;
}

/** One tenant's copy in a backup: where it is copied from, the working name it is written under, and the name it gets. */
export interface PlannedCopy {
  tenant: string;
  source: string;
  working: string;
  file: string;
  /** Identity of the exclusively created working file; rename preserves it under the final name. */
  device: number;
  inode: number;
  /** Creation identity detail used only to avoid reclaiming a new inode that reused both numbers. */
  createdCtimeMs?: number;
  /** How the final name is published on this filesystem. */
  publication: "link" | "copy" | "set";
  /** For copy publication, the final file and its guard are created and identified before the worker starts. */
  finalDevice?: number;
  finalInode?: number;
  guard?: string;
  guardDevice?: number;
  guardInode?: number;
  /** Identity details after SQLite finished writing, checked again at publication against inode reuse. */
  flushedCtimeMs?: number;
  flushedSize?: number;
  /** The automatic set whose complete marker commits all of its copies at once. */
  set?: PlannedSet;
  /** Private SQLite staging directory registered before the worker starts. */
  stagingDirectory?: string;
  stagingDevice?: number;
  stagingInode?: number;
  stagingFile?: string;
  stagingFileDevice?: number;
  stagingFileInode?: number;
  /** Durable ownership record for a manual backup's private SQLite staging directory. */
  stagingRecord?: string;
  stagingRecordDevice?: number;
  stagingRecordInode?: number;
}

export interface PlannedSet {
  directory: string;
  device: number;
  inode: number;
  complete: string;
  working: string;
  pending: string;
  preparing: string;
  workingDevice?: number;
  workingInode?: number;
  completeDevice?: number;
  completeInode?: number;
  pendingDevice?: number;
  pendingInode?: number;
  preparingDevice?: number;
  preparingInode?: number;
}

/**
 * Where a backup has got to. In this order: `start` once, before anything is written; `copy`, `copied` and
 * `flushed` for each tenant, before its copy is written, after, and after it is on the disk; `name` for each
 * tenant, before its copy gets its name; `named` once every copy has its name; `retention` before older
 * backups are removed.
 */
export type BackupPoint = "start" | "copy" | "copied" | "flushed" | "name" | "named" | "retention";

/** How a backup renames, removes and flushes. Parameters for the tests, which have each of them fail. */
export interface BackupSteps {
  rename(from: string, to: string, copy: PlannedCopy): void;
  remove(file: string): void;
  flush(folder: string): void;
}
const publishNoReplace = (from: string, to: string, copy: PlannedCopy): void => {
  if (copy.publication === "set") throw new Error("A backup-set copy is published only by its set marker");
  // A hard link is one atomic claim on the final name: unlike rename, it refuses EEXIST instead of replacing
  // a file another process put there after preparation. Both names identify the same inode until the working
  // name is removed, so settlement can still recognize and roll back either one after any failure.
  if (copy.publication === "link") {
    const found = lstatSync(from, { throwIfNoEntry: false });
    if (!found?.isFile() || found.dev !== copy.device || found.ino !== copy.inode || found.ctimeMs !== copy.flushedCtimeMs || found.size !== copy.flushedSize) throw new Error(`${from} is not the file that was made for this copy`);
    linkSync(from, to);
    rmSync(from);
    return;
  }

  // On a filesystem without hard links, preparation already claimed the final name and recorded its identity,
  // behind a guard that makes discovery ignore it. Copy through descriptors, verify both identities, and flush
  // the new inode before removing the guard. The folder was flushed after both names were created, so after a
  // crash either the durable guard remains (not a backup) or its durable file is complete.
  const source = openPlainFile(from);
  let destination: number | null = null;
  try {
    const noLink = constants.O_NOFOLLOW ?? 0;
    destination = openSync(to, constants.O_WRONLY | (constants.O_NONBLOCK ?? 0) | noLink);
    const found = fstatSync(destination);
    if (!found.isFile() || found.dev !== copy.finalDevice || found.ino !== copy.finalInode) throw new Error(`${to} is not the file that was reserved for this copy`);
    const original = fstatSync(source);
    if (original.dev !== copy.device || original.ino !== copy.inode || original.ctimeMs !== copy.flushedCtimeMs || original.size !== copy.flushedSize) throw new Error(`${from} is not the file that was made for this copy`);
    ftruncateSync(destination, 0);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (let got = readSync(source, buffer, 0, buffer.length, null); got > 0; got = readSync(source, buffer, 0, buffer.length, null)) {
      let written = 0;
      while (written < got) written += writeSync(destination, buffer, written, got - written, null);
    }
    fchmodSync(destination, 0o600);
    fsyncSync(destination);
  } finally {
    closeSync(source);
    if (destination !== null) closeSync(destination);
  }
  const guard = lstatSync(copy.guard!, { throwIfNoEntry: false });
  if (!guard?.isFile() || guard.dev !== copy.guardDevice || guard.ino !== copy.guardInode) throw new Error(`${copy.guard} is not the guard made for this copy`);
  rmSync(copy.guard!);
  rmSync(from);
};
const STEPS: BackupSteps = { rename: publishNoReplace, remove: (file) => rmSync(file), flush: flushFolder };

export interface BackupResult {
  folder: string;
  files: Array<{ tenant: string; file: string; bytes: number }>;
  /** Older automatic backups that were removed to keep the number that is asked for. */
  removed: string[];
  /** Older automatic backups that should have gone and could not be removed, each with why. */
  notRemoved: string[];
  /**
   * Why the backup, which is whole and in place, is not confirmed: the system could not flush its folder. Null
   * when it could. No older backup is removed for one that is not confirmed.
   */
  unconfirmed: string | null;
}

/** The moment in a backup's name: to the millisecond, so that two backups in a row never want the same name. */
const stampOf = (at: Date): string => at.toISOString().replace(/[-:]/g, "").replace(".", "-").replace("Z", "").replace("T", "-");

/** A transitional flat automatic-backup filename, still readable until set markers have replaced all of them. */
const AUTOMATIC = /^([a-z][a-z0-9-]{0,62})-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})-auto\.sqlite$/;
/** One automatic backup set. Its marker is the single boundary between incomplete work and a discoverable set. */
const AUTOMATIC_SET = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})-auto\.set$/;
const SET_COMPLETE = "complete.json";
const SET_MARKER_BYTES = 64 * 1024;
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const TENANT = /^[a-z][a-z0-9-]{0,62}$/;
/** A backup is written under its name with this after it, and gets its name when it is whole. */
const UNFINISHED = ".partial";
const COPYING = ".copying";
const VIGILE_UNFINISHED = /^\.vigile-[a-z][a-z0-9-]{0,62}-\d{8}-\d{6}-\d{3}(?:-auto)?\.sqlite\.partial(-journal|-wal|-shm)?$/;
const COPYING_AUTOMATIC = /^[a-z][a-z0-9-]{0,62}-\d{8}-\d{6}-\d{3}-auto\.sqlite\.copying$/;
const VIGILE_COPYING = /^\.vigile-[a-z][a-z0-9-]{0,62}-\d{8}-\d{6}-\d{3}(?:-auto)?\.sqlite\.copying$/;
const SET_ARTIFACT = /^[a-z][a-z0-9-]{0,62}-(\d{8}-\d{6}-\d{3})-auto\.sqlite\.copying$/;
const MANUAL_STAGING = /^\.vigile-[a-z][a-z0-9-]{0,62}-\d{8}-\d{6}-\d{3}\.sqlite\.partial\.staging$/;
const MANUAL_STAGING_RECORD = /^\.vigile-[a-z][a-z0-9-]{0,62}-\d{8}-\d{6}-\d{3}\.sqlite\.partial\.staging\.json$/;
type BackupRead = (file: number, buffer: Buffer, offset: number, length: number, position: number | null) => number;
const readFull = (read: BackupRead, file: number, buffer: Buffer): boolean => {
  let filled = 0;
  while (filled < buffer.length) {
    const got = read(file, buffer, filled, buffer.length - filled, filled);
    if (got === 0) return false;
    filled += got;
  }
  return true;
};

const nameOf = (tenant: string, at: Date, automatic: boolean): string => `${tenant}-${stampOf(at)}${automatic ? "-auto" : ""}.sqlite`;
const setNameOf = (at: Date): string => `${stampOf(at)}-auto.set`;
/** A private transient name whose namespace is sufficient proof that Vigile made it. */
const transientName = (file: string, suffix: string): string => join(dirname(file), `.vigile-${basename(file)}${suffix}`);

export interface AutomaticBackup {
  tenant: string;
  file: string;
  /** The moment in its name. */
  at: number;
  /** The committed set this file belongs to; absent for transitional flat backups. */
  set?: string;
  device?: number;
  inode?: number;
  markerDevice?: number;
  markerInode?: number;
  setDevice?: number;
  setInode?: number;
}

const momentFrom = (parts: readonly string[]): number => Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), Number(parts[3]), Number(parts[4]), Number(parts[5]), Number(parts[6]));

/** Reads a committed set marker and returns its ordinary tenant files, or null when it is not a complete set. */
function automaticSet(folder: string, name: string, match: RegExpExecArray, read: BackupRead = readSync): AutomaticBackup[] | null {
  const at = momentFrom(match.slice(1));
  const directory = join(folder, name);
  let marker: number | null = null;
  try {
    const setStats = lstatSync(directory, { throwIfNoEntry: false });
    if (!setStats?.isDirectory()) return null;
    marker = openPlainFile(join(directory, SET_COMPLETE));
    const stats = fstatSync(marker);
    if (stats.size <= 0 || stats.size > SET_MARKER_BYTES) return null;
    const bytes = Buffer.alloc(stats.size);
    if (!readFull(read, marker, bytes)) return null;
    const decoded: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null;
    const record = decoded as { version?: unknown; directory?: unknown; files?: unknown };
    const recordedDirectory = record.directory as { device?: unknown; inode?: unknown } | undefined;
    if (record.version !== 1 || !recordedDirectory || Object.keys(recordedDirectory).sort().join() !== "device,inode" || recordedDirectory.device !== String(setStats.dev) || recordedDirectory.inode !== String(setStats.ino) || !Array.isArray(record.files) || !record.files.length || Object.keys(record).sort().join() !== "directory,files,version") return null;
    const listed = record.files as Array<{ tenant?: unknown; device?: unknown; inode?: unknown }>;
    if (listed.some((file) => !file || typeof file !== "object" || Object.keys(file).sort().join() !== "device,inode,tenant" || typeof file.tenant !== "string" || !TENANT.test(file.tenant) || typeof file.device !== "string" || typeof file.inode !== "string")) return null;
    const tenants = listed.map((file) => file.tenant as string);
    if (new Set(tenants).size !== tenants.length || tenants.some((tenant, index) => index > 0 && tenants[index - 1]! >= tenant)) return null;
    const found = listed.map((recorded) => {
      const tenant = recorded.tenant as string;
      const file = join(folder, nameOf(tenant, new Date(at), true));
      const stats = lstatSync(file, { throwIfNoEntry: false });
      if (!stats?.isFile() || String(stats.dev) !== recorded.device || String(stats.ino) !== recorded.inode || lstatSync(file + COPYING, { throwIfNoEntry: false }) !== undefined) return null;
      return { tenant, file, at, set: directory, device: stats.dev, inode: stats.ino, markerDevice: stats.dev, markerInode: stats.ino, setDevice: setStats.dev, setInode: setStats.ino };
    });
    if (found.some((file) => file === null)) return null;
    for (const file of found) {
      file!.markerDevice = stats.dev;
      file!.markerInode = stats.ino;
    }
    const still = lstatSync(directory, { throwIfNoEntry: false });
    if (!still?.isDirectory() || still.dev !== setStats.dev || still.ino !== setStats.ino) return null;
    return found as AutomaticBackup[];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A missing, malformed or non-file marker is an incomplete set. An I/O or metadata failure proves no such
    // thing: propagate it so recovery leaves the committed set untouched and the schedule reports it unreadable.
    if (error instanceof SyntaxError || error instanceof NotAFile || code === "ENOENT") return null;
    throw error;
  } finally {
    if (marker !== null) closeSync(marker);
  }
}

/** The backups in committed sets, plus flat backups from versions before sets. Incomplete sets hide their moment. */
export function automaticBackups(folder: string, read: BackupRead = readSync): AutomaticBackup[] {
  if (!existsSync(folder)) return [];
  const found: AutomaticBackup[] = [];
  const entries = readdirSync(folder, { withFileTypes: true });
  const setMoments = new Set<number>();
  for (const entry of entries) {
    const match = AUTOMATIC_SET.exec(entry.name);
    if (!match) continue;
    const at = momentFrom(match.slice(1));
    setMoments.add(at);
    if (!entry.isDirectory()) continue;
    const committed = automaticSet(folder, entry.name, match, read);
    if (committed) found.push(...committed);
  }
  // A folder designated for this version's set protocol never falls back to filename-only discovery. Legacy
  // flat backups are read only in folders that predate the durable backup-folder marker.
  if (existsSync(join(folder, BACKUPS_LOCK))) return found;
  for (const entry of entries) {
    const match = AUTOMATIC.exec(entry.name);
    // A folder or a link under such a name is nothing the service wrote.
    if (!match || !entry.isFile() || existsSync(join(folder, entry.name + COPYING))) continue;
    const [, tenant, year, month, day, hour, minute, second, millisecond] = match;
    const at = momentFrom([year!, month!, day!, hour!, minute!, second!, millisecond!]);
    // Once a set directory claims a moment, only its complete marker can make that moment discoverable. Flat
    // files from interrupted set work cannot fall back to the legacy filename rule.
    if (setMoments.has(at)) continue;
    found.push({ tenant: tenant!, file: join(folder, entry.name), at });
  }
  return found;
}

/**
 * The moment of the newest automatic backup in a folder that is whole and not dated after `now`. Null when
 * there is none.
 *
 * Whole is one committed set that has a recorded copy of every tenant there is. A set without its marker or
 * any exact recorded file is no backup of the data. Transitional flat backups are whole only when every
 * tenant has a file at their shared moment.
 *
 * A backup dated after now was taken by a clock that has since been set back. When it was taken, as the clock
 * now counts, nobody knows: it says nothing about how long ago the last backup was, and is not asked.
 */
export function newestWhole(folder: string, tenants: readonly string[], now: number): number | null {
  return wholeMoments(folder, tenants).reduce<number | null>((newest, at) => (at <= now && (newest === null || at > newest) ? at : newest), null);
}

/** The moments of all the automatic backups in a folder that are whole, whatever their dates. */
export function wholeMoments(folder: string, tenants: readonly string[]): number[] {
  const have = new Map<number, Set<string>>();
  for (const backup of automaticBackups(folder)) {
    const of = have.get(backup.at);
    if (of) of.add(backup.tenant);
    else have.set(backup.at, new Set([backup.tenant]));
  }
  return [...have].filter(([, of]) => tenants.every((tenant) => of.has(tenant))).map(([at]) => at);
}

/**
 * The order in which automatic backups are kept, the first being the last to go: the newest first, by the
 * moment in the name, among those that are not dated after `now`; after all of them, those that are. A backup
 * dated after now was written before the clock was set back, so before every backup written since: it is
 * taken for older than all that lie before now, and is the first to make room. Otherwise the backups of a
 * clock that ran ahead would hold their places for as long as it ran ahead, and each backup taken since would
 * be removed by the next.
 */
export function keptFirst(now: number): (a: AutomaticBackup, b: AutomaticBackup) => number {
  return (a, b) => Number(a.at > now) - Number(b.at > now) || b.at - a.at || (a.file < b.file ? 1 : -1);
}

/** Removes one complete set by the identities its marker recorded, leaving any replacement or foreign entry. */
function removeCommittedSet(backups: readonly AutomaticBackup[], remove: (path: string) => void): string[] {
  const set = backups[0]?.set;
  if (!set || backups.some((backup) => backup.set !== set)) throw new Error("the automatic backup files do not belong to one committed set");
  for (const backup of backups) {
    const found = lstatSync(backup.file, { throwIfNoEntry: false });
    if (!found?.isFile() || found.dev !== backup.device || found.ino !== backup.inode) throw new Error(`${backup.file} is no longer the file recorded by its backup set`);
  }
  const marker = join(set, SET_COMPLETE);
  const directory = lstatSync(set, { throwIfNoEntry: false });
  const marked = lstatSync(marker, { throwIfNoEntry: false });
  const first = backups[0]!;
  if (!directory?.isDirectory() || directory.dev !== first.setDevice || directory.ino !== first.setInode) throw new Error(`${set} is no longer this backup set's directory`);
  if (!marked?.isFile() || marked.dev !== first.markerDevice || marked.ino !== first.markerInode) throw new Error(`${marker} is no longer this backup set's marker`);
  const pending = pendingSet(set);
  if (!pending) throw new Error(`${set} has no valid durable ownership record for retirement`);
  // Removing the marker first unpublishes the whole set. Any later filesystem failure can leave owned files,
  // but can never expose a partially removed backup as complete.
  remove(marker);
  for (const backup of backups) {
    const found = lstatSync(backup.file, { throwIfNoEntry: false });
    if (!found?.isFile() || found.dev !== backup.device || found.ino !== backup.inode) throw new Error(`${backup.file} changed while its backup set was being retired`);
    remove(backup.file);
  }
  const pendingMarker = lstatSync(join(set, "pending.json"), { throwIfNoEntry: false });
  if (!pendingMarker?.isFile() || pendingMarker.dev !== pending.marker.device || pendingMarker.ino !== pending.marker.inode) throw new Error(`${set} no longer has its durable ownership record`);
  remove(join(set, "pending.json"));
  rmdirSync(set);
  return backups.map((backup) => backup.file);
}

/** The tenants a data folder has, by name. A folder that is not there has none. */
export const tenantsIn = (dataDir: string): string[] => (existsSync(dataDir) ? tenantFiles(dataDir).map(({ tenant }) => tenant) : []);

/**
 * Removes names in Vigile's reserved transient namespace, guarded legacy copies whose records match their
 * filesystem identities, and current incomplete sets by their durable identity manifests. An old unprefixed
 * partial name proves no ownership and is left alone. This is only for whoever has just taken the folder for
 * itself and has no backup under way.
 */
export function clearLeftovers(folder: string, read: BackupRead = readSync): void {
  const belongsToSet = (name: string): boolean => {
    const match = SET_ARTIFACT.exec(name);
    return Boolean(match && existsSync(join(folder, `${match[1]}-auto.set`)));
  };
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isFile() && VIGILE_UNFINISHED.test(entry.name)) rmSync(join(folder, entry.name), { force: true });
  }
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile() || (!COPYING_AUTOMATIC.test(entry.name) && !VIGILE_COPYING.test(entry.name)) || belongsToSet(entry.name)) continue;
    const guard = join(folder, entry.name);
    const file = VIGILE_COPYING.test(entry.name) ? join(folder, entry.name.slice(".vigile-".length, -COPYING.length)) : guard.slice(0, -COPYING.length);
    let handle: number | null = null;
    try {
      handle = openPlainFile(guard);
      const held = fstatSync(handle);
      if (held.size > 512) continue;
      const data = Buffer.alloc(held.size);
      if (!readFull(readSync, handle, data)) continue;
      const record = JSON.parse(data.toString("utf8")) as { version?: unknown; device?: unknown; inode?: unknown };
      const final = lstatSync(file, { throwIfNoEntry: false });
      if (record.version !== 1 || typeof record.device !== "string" || typeof record.inode !== "string" || !final?.isFile() || String(final.dev) !== record.device || String(final.ino) !== record.inode) continue;
      const still = lstatSync(guard, { throwIfNoEntry: false });
      if (!still?.isFile() || still.dev !== held.dev || still.ino !== held.ino) continue;
      rmSync(file);
      rmSync(guard);
    } catch {
      // Not a guard record this version wrote, or no longer the files it described: leave both alone.
    } finally {
      if (handle !== null) closeSync(handle);
    }
  }
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile() || !MANUAL_STAGING_RECORD.test(entry.name)) continue;
    const recordPath = join(folder, entry.name);
    let handle: number | null = null;
    try {
      handle = openPlainFile(recordPath);
      const marker = fstatSync(handle);
      if (marker.size <= 0 || marker.size > 512) continue;
      const bytes = Buffer.alloc(marker.size);
      if (!readFull(readSync, handle, bytes)) continue;
      const record = JSON.parse(bytes.toString("utf8")) as { version?: unknown; directory?: { device?: unknown; inode?: unknown }; file?: unknown; fileDevice?: unknown; fileInode?: unknown };
      const directoryName = entry.name.slice(0, -".json".length);
      const directoryPath = join(folder, directoryName);
      const directory = lstatSync(directoryPath, { throwIfNoEntry: false });
      const keys = Object.keys(record).sort().join();
      if ((record.version !== 1 && record.version !== 2) || (record.version === 1 ? keys !== "directory,file,version" : keys !== "directory,file,fileDevice,fileInode,version") || !record.directory || Object.keys(record.directory).sort().join() !== "device,inode" || typeof record.directory.device !== "string" || typeof record.directory.inode !== "string" || record.file !== ".vigile-copy.sqlite" || (record.version === 2 && (typeof record.fileDevice !== "string" || typeof record.fileInode !== "string"))) continue;
      if (directory !== undefined) {
        if (!directory.isDirectory() || String(directory.dev) !== record.directory.device || String(directory.ino) !== record.directory.inode) continue;
        const stagedPath = join(directoryPath, record.file);
        const staged = lstatSync(stagedPath, { throwIfNoEntry: false });
        if (staged?.isFile() && (record.version === 2 ? String(staged.dev) === record.fileDevice && String(staged.ino) === record.fileInode : staged.size === 0)) rmSync(stagedPath);
        else if (staged !== undefined) continue;
        try { rmdirSync(directoryPath); } catch { continue; }
      }
      const still = lstatSync(recordPath, { throwIfNoEntry: false });
      if (still?.isFile() && still.dev === marker.dev && still.ino === marker.ino) rmSync(recordPath);
    } catch {
      // Not a durable manual-staging record this version wrote, or no longer what it described.
    } finally {
      if (handle !== null) closeSync(handle);
    }
  }
  // Preparation can be interrupted after the reserved directory is made but before its record is durable. At
  // that point it is empty; remove only such an empty exact-name directory, never anything inside one.
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isDirectory() || !MANUAL_STAGING.test(entry.name) || somethingAt(join(folder, `${entry.name}.json`))) continue;
    try { rmdirSync(join(folder, entry.name)); } catch {}
  }
  clearIncompleteSets(folder, read);
}

/**
 * Every file this backup owns publicly: each prepared working file and its final name. SQLite writes in private
 * registered staging. A sidecar that appears beside a public path is not assumed to be ours and is never deleted.
 */
const filesOf = (copies: readonly PlannedCopy[]): string[] => [...new Set(copies.flatMap((copy) => [copy.file, copy.working, ...(copy.guard ? [copy.guard] : [])]))];

/**
 * Makes the files of a backup this backup's own, before anything is written. The names are decided here, for
 * every tenant there is and the moment of the backup; none of them may be taken, since nobody else may have
 * made a file of this backup; and each working file is created here, empty, readable by its owner only, and
 * only if nothing has its name. From here on, whatever exists under one of these names is this backup's, and
 * whoever called this knows all of them: there is no instant at which a backup has a file that is not on this
 * list. Should this fail, what it created is removed again.
 */
export function prepareCopies(dataDir: string, folder: string, at: Date, automatic: boolean, makeLink: typeof linkSync = linkSync, makeFile: typeof createPlainFile = createPlainFile): PlannedCopy[] {
  const files = tenantFiles(dataDir);
  if (!files.length) throw new BackupRefused(`There is no data yet at ${dataDir}.`);
  const copies = files.map(({ tenant, file }): PlannedCopy => {
    const destination = join(folder, nameOf(tenant, at, automatic));
    const working = automatic ? destination : transientName(destination, UNFINISHED);
    const copy: PlannedCopy = { tenant, source: file, working, file: destination, device: 0, inode: 0, publication: automatic ? "set" : "link" };
    if (!automatic) {
      copy.stagingDirectory = `${working}.staging`;
      copy.stagingFile = join(copy.stagingDirectory, ".vigile-copy.sqlite");
      copy.stagingRecord = `${copy.stagingDirectory}.json`;
    }
    return copy;
  });
  const probes = automatic ? [] : copies.map((copy) => `${copy.working}.link-test`);
  const guarded = automatic ? [] : copies.flatMap((copy) => [transientName(copy.file, COPYING)]);
  const setDirectory = automatic ? join(folder, setNameOf(at)) : null;
  const taken = [...filesOf(copies), ...probes, ...guarded, ...copies.flatMap((copy) => copy.stagingRecord ? [copy.stagingDirectory!, copy.stagingRecord] : []), ...(setDirectory ? [setDirectory] : [])].find(somethingAt);
  if (taken) throw new BackupRefused(`${taken} is in the way: this backup would be written there, and nothing but this backup may have that name.`, ["Move it away, or remove it if it is nothing you need."]);
  try {
    if (setDirectory) {
      mkdirSync(setDirectory, { mode: 0o700 });
      const made = lstatSync(setDirectory);
      const set = { directory: setDirectory, device: made.dev, inode: made.ino, complete: join(setDirectory, SET_COMPLETE), working: join(setDirectory, `${SET_COMPLETE}.partial`), pending: join(setDirectory, "pending.json"), preparing: join(setDirectory, "preparing.json") };
      for (const copy of copies) copy.set = set;
      // The set tombstone must survive before any legacy-looking tenant filename can survive: after a crash,
      // those names can then be discovered only through a complete marker in this directory.
      flushFolder(setDirectory);
      flushFolder(folder);
      for (const copy of copies) {
        copy.stagingDirectory = join(setDirectory, `${copy.tenant}.staging`);
        copy.stagingFile = join(copy.stagingDirectory, "copy.sqlite");
      }
      // This durable plan precedes every artifact. If the process dies before the identity manifest is complete,
      // recovery can still recognize the exact names this preparation was allowed to create.
      writePreparingSet(copies);
      for (const copy of copies) {
        mkdirSync(copy.stagingDirectory!, { mode: 0o700 });
        const staging = lstatSync(copy.stagingDirectory!);
        Object.assign(copy, { stagingDevice: staging.dev, stagingInode: staging.ino });
        const staged = createPlainFile(copy.stagingFile!);
        const stagedIdentity = fstatSync(staged);
        Object.assign(copy, { stagingFileDevice: stagedIdentity.dev, stagingFileInode: stagedIdentity.ino });
        closeSync(staged);
      }
      flushFolder(setDirectory);
    }
    if (!automatic) {
      for (const copy of copies) {
        mkdirSync(copy.stagingDirectory!, { mode: 0o700 });
        const staging = lstatSync(copy.stagingDirectory!);
        Object.assign(copy, { stagingDevice: staging.dev, stagingInode: staging.ino });
        const marker = createPlainFile(copy.stagingRecord!);
        try {
          const identity = fstatSync(marker);
          Object.assign(copy, { stagingRecordDevice: identity.dev, stagingRecordInode: identity.ino });
          writeFileSync(marker, `${JSON.stringify({ version: 1, directory: { device: String(staging.dev), inode: String(staging.ino) }, file: basename(copy.stagingFile!) })}\n`);
          fsyncSync(marker);
          // The name plan must survive before its empty file is created; its identity must then survive before
          // VACUUM INTO can put a database-sized copy there.
          flushFolder(folder);
          const staged = createPlainFile(copy.stagingFile!);
          const stagedIdentity = fstatSync(staged);
          Object.assign(copy, { stagingFileDevice: stagedIdentity.dev, stagingFileInode: stagedIdentity.ino });
          closeSync(staged);
          ftruncateSync(marker, 0);
          const identityRecord = Buffer.from(`${JSON.stringify({ version: 2, directory: { device: String(staging.dev), inode: String(staging.ino) }, file: basename(copy.stagingFile!), fileDevice: String(stagedIdentity.dev), fileInode: String(stagedIdentity.ino) })}\n`);
          writeSync(marker, identityRecord, 0, identityRecord.length, 0);
          fsyncSync(marker);
        } finally {
          closeSync(marker);
        }
      }
      flushFolder(folder);
    }
    for (const copy of copies) {
      // A backup is a plan: readable by its owner only, from the moment it is created.
      const handle = makeFile(copy.working);
      const made = fstatSync(handle);
      Object.assign(copy, { device: made.dev, inode: made.ino, createdCtimeMs: made.ctimeMs });
      closeSync(handle);
    }
    if (!automatic) {
      const probe = probes[0]!;
      let madeProbe = false;
      try {
        makeLink(copies[0]!.working, probe);
        madeProbe = true;
        const linked = lstatSync(probe, { throwIfNoEntry: false });
        if (!linked?.isFile() || linked.dev !== copies[0]!.device || linked.ino !== copies[0]!.inode) throw new Error(`${probe} is not this backup's link probe`);
        rmSync(probe);
        madeProbe = false;
      } catch (error) {
        if (madeProbe) {
          const linked = lstatSync(probe, { throwIfNoEntry: false });
          if (linked?.isFile() && linked.dev === copies[0]!.device && linked.ino === copies[0]!.inode) rmSync(probe);
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (!new Set(["EPERM", "EOPNOTSUPP", "ENOTSUP", "EXDEV"]).has(code ?? "")) throw error;
        for (const copy of copies) {
          copy.publication = "copy";
          copy.guard = transientName(copy.file, COPYING);
          const guard = createPlainFile(copy.guard);
          try {
            const guardStats = fstatSync(guard);
            Object.assign(copy, { guardDevice: guardStats.dev, guardInode: guardStats.ino });
            const final = createPlainFile(copy.file);
            try {
              const finalStats = fstatSync(final);
              Object.assign(copy, { finalDevice: finalStats.dev, finalInode: finalStats.ino });
              writeFileSync(guard, JSON.stringify({ version: 1, device: String(finalStats.dev), inode: String(finalStats.ino) }));
              fsyncSync(guard);
            } finally {
              closeSync(final);
            }
          } finally {
            closeSync(guard);
          }
        }
        flushFolder(folder);
      }
    }
    if (setDirectory) writePendingSet(copies);
  } catch (error) {
    const removeOwned = (path: string | undefined, device: number | undefined, inode: number | undefined, createdCtimeMs?: number): void => {
      if (!path || device === undefined || inode === undefined) return;
      const found = lstatSync(path, { throwIfNoEntry: false });
      if (found?.isFile() && found.dev === device && found.ino === inode && (createdCtimeMs === undefined || (found.size === 0 && found.ctimeMs === createdCtimeMs))) rmSync(path);
    };
    for (const copy of copies) {
      removeOwned(copy.working, copy.device, copy.inode, copy.createdCtimeMs);
      if (copy.publication === "copy") removeOwned(copy.file, copy.finalDevice, copy.finalInode);
      removeOwned(copy.guard, copy.guardDevice, copy.guardInode);
      if (copy.stagingDirectory) {
        const staging = lstatSync(copy.stagingDirectory, { throwIfNoEntry: false });
        if (staging?.isDirectory() && staging.dev === copy.stagingDevice && staging.ino === copy.stagingInode) {
          const staged = lstatSync(copy.stagingFile!, { throwIfNoEntry: false });
          if (staged?.isFile() && staged.dev === copy.stagingFileDevice && staged.ino === copy.stagingFileInode) rmSync(copy.stagingFile!);
          try { rmdirSync(copy.stagingDirectory); } catch {}
        }
      }
      removeOwned(copy.stagingRecord, copy.stagingRecordDevice, copy.stagingRecordInode);
    }
    const set = copies[0]?.set;
    removeOwned(set?.pending, set?.pendingDevice, set?.pendingInode);
    removeOwned(set?.preparing, set?.preparingDevice, set?.preparingInode);
    if (setDirectory) {
      try {
        const directory = lstatSync(setDirectory, { throwIfNoEntry: false });
        // A final name taken after preflight must remain hidden behind this tombstone. Remove the directory
        // only when it is still ours and every legacy-looking final name is absent.
        if (directory?.isDirectory() && directory.dev === set?.device && directory.ino === set?.inode && copies.every((copy) => !somethingAt(copy.file))) rmdirSync(setDirectory);
      } catch {
        // Something foreign appeared there, or it was replaced: never remove recursively.
      }
    }
    throw error;
  }
  return copies;
}

interface PendingSetRecord {
  version: 1 | 2;
  directory: { device: string; inode: string };
  files: Array<{ name: string; device: string; inode: string }>;
  directories?: Array<{ name: string; device: string; inode: string; file: string; fileDevice: string; fileInode: string }>;
}

interface PreparingSetRecord {
  version: 1;
  directory: { device: string; inode: string };
  files: string[];
  directories: Array<{ name: string; file: "copy.sqlite" }>;
}

const encodedSetRecord = (record: object): string => {
  const text = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(text) > SET_MARKER_BYTES) throw new BackupRefused("There are too many tenant files for one automatic backup set.", ["Reduce the number of tenant files before automatic backups run."]);
  return text;
};

const completeSetRecord = (copies: readonly PlannedCopy[]): object => {
  const set = copies[0]!.set!;
  const files = copies.map((copy) => ({ tenant: copy.tenant, device: String(copy.device), inode: String(copy.inode) })).sort((a, b) => compareText(a.tenant, b.tenant));
  return { version: 1, directory: { device: String(set.device), inode: String(set.inode) }, files };
};

/** Durably names every artifact preparation may create before any of those names is touched. */
function writePreparingSet(copies: readonly PlannedCopy[]): void {
  const set = copies[0]?.set;
  if (!set) return;
  const record: PreparingSetRecord = {
    version: 1,
    directory: { device: String(set.device), inode: String(set.inode) },
    files: copies.map((copy) => basename(copy.file)).sort(compareText),
    directories: copies.map((copy) => ({ name: basename(copy.stagingDirectory!), file: "copy.sqlite" as const })).sort((a, b) => compareText(a.name, b.name)),
  };
  let handle: number | null = null;
  try {
    handle = createPlainFile(set.preparing);
    const made = fstatSync(handle);
    Object.assign(set, { preparingDevice: made.dev, preparingInode: made.ino });
    writeFileSync(handle, encodedSetRecord(record));
    fsyncSync(handle);
    closeSync(handle);
    handle = null;
    flushFolder(set.directory);
    flushFolder(dirname(set.directory));
  } catch (error) {
    if (handle !== null) closeSync(handle);
    const marker = lstatSync(set.preparing, { throwIfNoEntry: false });
    if (marker?.isFile() && marker.dev === set.preparingDevice && marker.ino === set.preparingInode) rmSync(set.preparing);
    throw error;
  }
}

/** Makes every path an automatic worker may leave recoverable before that worker can start. */
function writePendingSet(copies: readonly PlannedCopy[]): void {
  const set = copies[0]?.set;
  if (!set) return;
  const files = new Map<string, { name: string; device: string; inode: string }>();
  const remember = (path: string | undefined, device: number | undefined, inode: number | undefined): void => {
    if (!path || device === undefined || inode === undefined) return;
    files.set(path, { name: basename(path), device: String(device), inode: String(inode) });
  };
  for (const copy of copies) {
    remember(copy.working, copy.device, copy.inode);
    remember(copy.file, copy.publication === "copy" ? copy.finalDevice : copy.device, copy.publication === "copy" ? copy.finalInode : copy.inode);
    remember(copy.guard, copy.guardDevice, copy.guardInode);
  }
  const record: PendingSetRecord = {
    version: 2,
    directory: { device: String(set.device), inode: String(set.inode) },
    files: [...files.values()].sort((a, b) => compareText(a.name, b.name)),
    directories: copies.map((copy) => ({ name: basename(copy.stagingDirectory!), device: String(copy.stagingDevice), inode: String(copy.stagingInode), file: basename(copy.stagingFile!), fileDevice: String(copy.stagingFileDevice), fileInode: String(copy.stagingFileInode) })).sort((a, b) => compareText(a.name, b.name)),
  };
  const text = encodedSetRecord(record);
  // The complete marker has one shorter tenant field for each pending filename and the same identities. Prove
  // that both durable records fit before a worker copies any tenant or retention can begin.
  encodedSetRecord(completeSetRecord(copies));
  let handle: number | null = null;
  try {
    handle = createPlainFile(set.pending);
    const made = fstatSync(handle);
    Object.assign(set, { pendingDevice: made.dev, pendingInode: made.ino });
    writeFileSync(handle, text);
    fsyncSync(handle);
    closeSync(handle);
    handle = null;
    flushFolder(set.directory);
    flushFolder(dirname(set.directory));
    const preparing = lstatSync(set.preparing, { throwIfNoEntry: false });
    if (preparing?.isFile() && preparing.dev === set.preparingDevice && preparing.ino === set.preparingInode) {
      rmSync(set.preparing);
      flushFolder(set.directory);
    }
  } catch (error) {
    if (handle !== null) closeSync(handle);
    const pending = lstatSync(set.pending, { throwIfNoEntry: false });
    if (pending?.isFile() && pending.dev === set.pendingDevice && pending.ino === set.pendingInode) rmSync(set.pending);
    throw error;
  }
}

/** Opens and validates an incomplete set's ownership record without following anything it names. */
function pendingSet(setDirectory: string): { marker: { device: number; inode: number }; files: PendingSetRecord["files"]; directories: NonNullable<PendingSetRecord["directories"]> } | null {
  let handle: number | null = null;
  try {
    handle = openPlainFile(join(setDirectory, "pending.json"));
    const marker = fstatSync(handle);
    if (marker.size <= 0 || marker.size > SET_MARKER_BYTES) return null;
    const bytes = Buffer.alloc(marker.size);
    if (!readFull(readSync, handle, bytes)) return null;
    const record = JSON.parse(bytes.toString("utf8")) as Partial<PendingSetRecord>;
    const directory = lstatSync(setDirectory, { throwIfNoEntry: false });
    const setName = basename(setDirectory);
    const setMatch = AUTOMATIC_SET.exec(setName);
    const stamp = setName.slice(0, -"-auto.set".length);
    const expected = new RegExp(`^([a-z][a-z0-9-]{0,62})-${stamp}-auto\\.sqlite$`);
    const keys = Object.keys(record).sort().join();
    if ((record.version !== 1 && record.version !== 2) || (record.version === 1 ? keys !== "directory,files,version" : keys !== "directories,directory,files,version") || !directory?.isDirectory() || !setMatch || !record.directory || Object.keys(record.directory).sort().join() !== "device,inode" || record.directory.device !== String(directory.dev) || record.directory.inode !== String(directory.ino) || !Array.isArray(record.files) || !record.files.length) return null;
    if (record.files.some((file) => !file || typeof file.name !== "string" || !expected.test(file.name) || typeof file.device !== "string" || typeof file.inode !== "string" || Object.keys(file).sort().join() !== "device,inode,name")) return null;
    const names = record.files.map(({ name }) => name);
    if (new Set(names).size !== names.length || names.some((name, index) => index > 0 && names[index - 1]! >= name)) return null;
    const directories = record.version === 2 ? record.directories : [];
    if (!Array.isArray(directories) || directories.some((entry) => !entry || typeof entry.name !== "string" || !/^([a-z][a-z0-9-]{0,62})\.staging$/.test(entry.name) || entry.file !== "copy.sqlite" || typeof entry.device !== "string" || typeof entry.inode !== "string" || typeof entry.fileDevice !== "string" || typeof entry.fileInode !== "string" || Object.keys(entry).sort().join() !== "device,file,fileDevice,fileInode,inode,name")) return null;
    const directoryNames = directories.map(({ name }) => name);
    if (new Set(directoryNames).size !== directoryNames.length || directoryNames.some((name, index) => index > 0 && directoryNames[index - 1]! >= name)) return null;
    return { marker: { device: marker.dev, inode: marker.ino }, files: record.files, directories };
  } catch {
    return null;
  } finally {
    if (handle !== null) closeSync(handle);
  }
}

/** Reads the durable plan written before preparation creates any artifact. */
function preparingSet(setDirectory: string): { marker: { device: number; inode: number }; files: string[]; directories: PreparingSetRecord["directories"] } | null {
  let handle: number | null = null;
  try {
    handle = openPlainFile(join(setDirectory, "preparing.json"));
    const marker = fstatSync(handle);
    if (marker.size <= 0 || marker.size > SET_MARKER_BYTES) return null;
    const bytes = Buffer.alloc(marker.size);
    if (!readFull(readSync, handle, bytes)) return null;
    const record = JSON.parse(bytes.toString("utf8")) as Partial<PreparingSetRecord>;
    const directory = lstatSync(setDirectory, { throwIfNoEntry: false });
    const setName = basename(setDirectory);
    if (!AUTOMATIC_SET.test(setName) || !directory?.isDirectory() || record.version !== 1 || Object.keys(record).sort().join() !== "directories,directory,files,version" || !record.directory || Object.keys(record.directory).sort().join() !== "device,inode" || record.directory.device !== String(directory.dev) || record.directory.inode !== String(directory.ino)) return null;
    const stamp = setName.slice(0, -"-auto.set".length);
    const expected = new RegExp(`^[a-z][a-z0-9-]{0,62}-${stamp}-auto\\.sqlite$`);
    if (!Array.isArray(record.files) || !record.files.length || record.files.some((name) => typeof name !== "string" || !expected.test(name))) return null;
    if (new Set(record.files).size !== record.files.length || record.files.some((name, i) => i > 0 && record.files![i - 1]! >= name)) return null;
    if (!Array.isArray(record.directories) || record.directories.length !== record.files.length || record.directories.some((entry) => !entry || Object.keys(entry).sort().join() !== "file,name" || entry.file !== "copy.sqlite" || typeof entry.name !== "string" || !/^[a-z][a-z0-9-]{0,62}\.staging$/.test(entry.name))) return null;
    const names = record.directories.map(({ name }) => name);
    if (new Set(names).size !== names.length || names.some((name, i) => i > 0 && names[i - 1]! >= name)) return null;
    return { marker: { device: marker.dev, inode: marker.ino }, files: record.files, directories: record.directories };
  } catch {
    return null;
  } finally {
    if (handle !== null) closeSync(handle);
  }
}

/** Reclaims artifacts whose exact names were durably reserved before preparation began. */
function clearPreparingSet(folder: string, directory: string, preparing: NonNullable<ReturnType<typeof preparingSet>>): void {
  let blocked = false;
  for (const recorded of preparing.directories) {
    const path = join(directory, recorded.name);
    const found = lstatSync(path, { throwIfNoEntry: false });
    if (!found) continue;
    if (!found.isDirectory()) { blocked = true; continue; }
    const staged = join(path, recorded.file);
    const file = lstatSync(staged, { throwIfNoEntry: false });
    if (file?.isFile()) rmSync(staged);
    else if (file !== undefined) { blocked = true; continue; }
    try { rmdirSync(path); } catch { blocked = true; }
  }
  for (const name of preparing.files) {
    const path = join(folder, name);
    const found = lstatSync(path, { throwIfNoEntry: false });
    if (found?.isFile()) rmSync(path);
    else if (found !== undefined) blocked = true;
  }
  const marker = lstatSync(join(directory, "preparing.json"), { throwIfNoEntry: false });
  if (marker?.isFile() && marker.dev === preparing.marker.device && marker.ino === preparing.marker.inode) rmSync(join(directory, "preparing.json"));
  else if (marker !== undefined) blocked = true;
  if (!blocked) {
    try { rmdirSync(directory); } catch {}
  }
}

/** Reclaims only paths identified by an owned incomplete-set marker; foreign replacements and entries stay. */
function clearIncompleteSets(folder: string, read: BackupRead = readSync): void {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const match = AUTOMATIC_SET.exec(entry.name);
    if (!match || !entry.isDirectory()) continue;
    const directory = join(folder, entry.name);
    const pending = pendingSet(directory);
    const preparing = preparingSet(directory);
    if (!pending) {
      if (preparing) clearPreparingSet(folder, directory, preparing);
      continue;
    }
    const committed = automaticSet(folder, entry.name, match, read) !== null;
    if (!committed) {
      const complete = join(directory, SET_COMPLETE);
      const marker = lstatSync(complete, { throwIfNoEntry: false });
      // The durable pending record proves that this is a set Vigile prepared. In its private dedicated folder,
      // a plain but invalid marker can only be publication interrupted by Vigile's own crash. Reclaim it so one
      // torn marker cannot prevent every later backup; anything of another kind is left untouched.
      if (marker?.isFile()) rmSync(complete);
      else if (marker !== undefined) continue;
    }
    let foreignReplacement = false;
    if (!committed) {
      for (const recorded of pending.directories) {
        const path = join(directory, recorded.name);
        const found = lstatSync(path, { throwIfNoEntry: false });
        if (found?.isDirectory() && String(found.dev) === recorded.device && String(found.ino) === recorded.inode) {
          const staged = join(path, recorded.file);
          const stagedEntry = lstatSync(staged, { throwIfNoEntry: false });
          if (stagedEntry?.isFile() && String(stagedEntry.dev) === recorded.fileDevice && String(stagedEntry.ino) === recorded.fileInode) rmSync(staged);
          else if (stagedEntry !== undefined) foreignReplacement = true;
          try { rmdirSync(path); } catch { foreignReplacement = true; }
        } else if (found !== undefined) foreignReplacement = true;
      }
      for (const recorded of pending.files) {
        const path = join(folder, recorded.name);
        const found = lstatSync(path, { throwIfNoEntry: false });
        if (found?.isFile() && String(found.dev) === recorded.device && String(found.ino) === recorded.inode) rmSync(path);
        else if (found !== undefined) foreignReplacement = true;
      }
    }
    if (!committed) {
      const marker = lstatSync(join(directory, "pending.json"), { throwIfNoEntry: false });
      if (marker?.isFile() && marker.dev === pending.marker.device && marker.ino === pending.marker.inode) rmSync(join(directory, "pending.json"));
      if (preparing) {
        const early = lstatSync(join(directory, "preparing.json"), { throwIfNoEntry: false });
        if (early?.isFile() && early.dev === preparing.marker.device && early.ino === preparing.marker.inode) rmSync(join(directory, "preparing.json"));
      }
      if (!foreignReplacement) {
        try {
          rmdirSync(directory);
        } catch {
          // A foreign entry or replacement keeps the directory in place and is never removed recursively.
        }
      }
    } else if (preparing) {
      const marker = lstatSync(join(directory, "preparing.json"), { throwIfNoEntry: false });
      if (marker?.isFile() && marker.dev === preparing.marker.device && marker.ino === preparing.marker.inode) rmSync(join(directory, "preparing.json"));
    }
  }
}

/** Publishes the one marker that makes an automatic set discoverable. Returns why its directory was not flushed. */
function publishSet(copies: readonly PlannedCopy[]): string | null {
  const set = copies[0]?.set;
  if (!set) return null;
  if (copies.some((copy) => copy.set?.directory !== set.directory)) throw new Error("The copies do not belong to one automatic backup set");
  const directory = lstatSync(set.directory, { throwIfNoEntry: false });
  if (!directory?.isDirectory() || directory.dev !== set.device || directory.ino !== set.inode) throw new Error(`${set.directory} is not the directory made for this backup set`);
  if (somethingAt(set.complete) || somethingAt(set.working)) throw new Error(`${somethingAt(set.complete) ? set.complete : set.working} is in the way of this backup set's complete marker`);
  // Claim the public marker name atomically. It is not discoverable while empty or partial, and no rename can
  // replace an entry created after an earlier existence check.
  const handle = createPlainFile(set.complete);
  let markerIdentity: { device: number; inode: number };
  try {
    markerIdentity = (() => {
      const made = fstatSync(handle);
      return { device: made.dev, inode: made.ino };
    })();
    Object.assign(set, { completeDevice: markerIdentity.device, completeInode: markerIdentity.inode });
    const files = copies
      .map((copy) => {
        const found = lstatSync(copy.file, { throwIfNoEntry: false });
        const expected = copy.publication === "copy" ? [copy.finalDevice, copy.finalInode] : [copy.device, copy.inode];
        if (!found?.isFile() || found.dev !== expected[0] || found.ino !== expected[1] || found.ctimeMs !== copy.flushedCtimeMs || found.size !== copy.flushedSize) throw new Error(`${copy.file} is not the file that was made for this copy after it was flushed`);
        return { tenant: copy.tenant, device: String(found.dev), inode: String(found.ino) };
      })
      .sort((a, b) => compareText(a.tenant, b.tenant));
    writeFileSync(handle, encodedSetRecord({ version: 1, directory: { device: String(set.device), inode: String(set.inode) }, files }));
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  const still = lstatSync(set.complete, { throwIfNoEntry: false });
  const held = lstatSync(set.directory, { throwIfNoEntry: false });
  if (!still?.isFile() || still.dev !== markerIdentity.device || still.ino !== markerIdentity.inode || !held?.isDirectory() || held.dev !== set.device || held.ino !== set.inode) throw new Error(`${set.complete} is not the complete marker made for this backup set`);
  try {
    flushFolder(set.directory);
    const pending = lstatSync(set.pending, { throwIfNoEntry: false });
    if (!pending?.isFile() || pending.dev !== set.pendingDevice || pending.ino !== set.pendingInode) throw new Error(`${set.pending} is not the pending marker made for this backup set`);
    // Keep the durable ownership record for the set's lifetime. Retention removes it only after every recorded
    // tenant file; if retirement is interrupted, startup can safely resume from the identities it records.
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * Settles the files of a backup that has ended, however it ended, by looking at them and at nothing else: no
 * word of the backup itself is needed. A backup whose copies all have their names is whole: it stays, and from
 * here on its files are backups like any other. Anything less is no backup: every file of it that exists is
 * removed, the copies that had their names already as well. Only the files of this backup are looked at, never
 * what else lies in the folder. Says whether the backup is whole. Whether each removal works or not, the others
 * are tried.
 */
export function settleCopies(copies: readonly PlannedCopy[], remove: (path: string) => void = (path) => rmSync(path, { force: true })): boolean {
  const ours = (copy: PlannedCopy, path: string): boolean => {
    const found = lstatSync(path, { throwIfNoEntry: false });
    const identity = path === copy.file && copy.publication === "copy" ? [copy.finalDevice, copy.finalInode] : path === copy.guard ? [copy.guardDevice, copy.guardInode] : [copy.device, copy.inode];
    return Boolean(found?.isFile() && found.dev === identity[0] && found.ino === identity[1]);
  };
  // A copy has its name only when the file made exclusively for it stands there. A foreign replacement is
  // neither counted as this backup nor removed as though it belonged to it.
  const set = copies[0]?.set;
  const setMatch = set ? AUTOMATIC_SET.exec(basename(set.directory)) : null;
  const committed = !set || Boolean(setMatch && automaticSet(dirname(set.directory), basename(set.directory), setMatch));
  const whole = copies.length > 0 && committed && copies.every((copy) => ours(copy, copy.file) && (!copy.guard || !somethingAt(copy.guard)));
  let foreignReplacement = false;
  let ownedRemains = false;
  for (const copy of copies) {
    if (!copy.stagingDirectory) continue;
    const directory = lstatSync(copy.stagingDirectory, { throwIfNoEntry: false });
    if (directory && (!directory.isDirectory() || directory.dev !== copy.stagingDevice || directory.ino !== copy.stagingInode)) {
      foreignReplacement = true;
      continue;
    }
    if (directory) {
      try {
        const staged = lstatSync(copy.stagingFile!, { throwIfNoEntry: false });
        if (staged?.isFile() && staged.dev === copy.stagingFileDevice && staged.ino === copy.stagingFileInode) remove(copy.stagingFile!);
        else if (staged !== undefined) {
          foreignReplacement = true;
          continue;
        }
        rmdirSync(copy.stagingDirectory);
      } catch {
        ownedRemains = true;
      }
    }
    if (copy.stagingRecord) {
      const marker = lstatSync(copy.stagingRecord, { throwIfNoEntry: false });
      if (marker?.isFile() && marker.dev === copy.stagingRecordDevice && marker.ino === copy.stagingRecordInode && !somethingAt(copy.stagingDirectory!)) {
        try { remove(copy.stagingRecord); } catch { ownedRemains = true; }
      } else if (marker !== undefined) foreignReplacement = true;
    }
  }
  for (const path of whole ? filesOf(copies).filter((file) => !copies.some((copy) => copy.file === file)) : filesOf(copies)) {
    const copy = copies.find((item) => path === item.file || path === item.working || path === item.guard);
    if (copy && !ours(copy, path)) {
      if (somethingAt(path)) foreignReplacement = true;
      continue;
    }
    try {
      remove(path);
    } catch {
      ownedRemains = true;
      // Left where it is. Under a working name it is no backup; under a backup's name it is one tenant's, and
      // a moment that lacks a tenant is not counted.
    }
  }
  if (set) {
    const directory = lstatSync(set.directory, { throwIfNoEntry: false });
    if (directory?.isDirectory() && directory.dev === set.device && directory.ino === set.inode) {
      try {
        const working = lstatSync(set.working, { throwIfNoEntry: false });
        if (working?.isFile() && working.dev === set.workingDevice && working.ino === set.workingInode) rmSync(set.working);
        if (!whole) {
          const complete = lstatSync(set.complete, { throwIfNoEntry: false });
          if (complete?.isFile() && complete.dev === set.completeDevice && complete.ino === set.completeInode) rmSync(set.complete);
          const pending = lstatSync(set.pending, { throwIfNoEntry: false });
          // A marker made inside the backup worker may not have had its identity copied back before that worker
          // was ended. Keep the durable pending record while any such marker remains: startup recovery needs it
          // to prove ownership and reclaim the interrupted publication.
          if (!ownedRemains && !somethingAt(set.complete) && pending?.isFile() && pending.dev === set.pendingDevice && pending.ino === set.pendingInode) rmSync(set.pending);
        }
        if (!whole && !foreignReplacement && !ownedRemains) rmdirSync(set.directory);
      } catch {
        // A foreign entry, replacement or failed removal is preserved. It is not a discoverable complete set.
      }
    }
  }
  return whole;
}

/** The file in a backup folder whose lock says that a service has the folder for its automatic backups. It holds nothing. */
export const BACKUPS_LOCK = "vigile-backups.hold";
/** Short-lived destination exclusion shared by recovery, manual backups and automatic backup workers. */
export const backupOperationLock = (folder: string): string => join(dirname(folder), `.vigile-${basename(folder)}-backup-operation.hold`);

/**
 * Why a folder is no place for backups of the data in a data folder. Each reason is one of these and nothing
 * else, with the two places as the system names them: whoever has to tell one reason from another, as the
 * start of the service does, asks which it is, and never whether there was any.
 *
 * - `same_data_folder_of_this_instance`: the folder is the data folder itself, by whatever name it is reached.
 *   A backup among the data would be taken for a tenant of its own by the next start.
 * - `data_folder_of_another_instance`: the folder is the data folder of another Vigile instance, which would
 *   take the backup for a tenant.
 */
export type PlaceRefusal =
  | { code: "same_data_folder_of_this_instance"; backups: string; data: string }
  | { code: "data_folder_of_another_instance"; backups: string; data: string };

/** Why backups of the data in `dataDir` cannot go into `folder`, or null when they can. */
export function placeRefusal(dataDir: string, folder: string): PlaceRefusal | null {
  // Both as the places they lead to already: what a loaded config has, and what `takeBackup` makes of the
  // paths it is given. Nothing is worked out again here.
  const [data, backups] = [dataDir, folder];
  if (samePlace(backups, data)) return { code: "same_data_folder_of_this_instance", backups, data };
  // Automatic backup folders also carry the shared folder locks. Their own lock record distinguishes that
  // history; an active data service is excluded mechanically by those shared locks during acquisition.
  if ((everHeld(backups) && !existsSync(join(backups, BACKUPS_LOCK))) || existsSync(join(backups, "vigile.lock"))) return { code: "data_folder_of_another_instance", backups, data };
  return null;
}

/** A refusal in words, with what to do: the ones `vigile backup` has always given. */
export function refusedPlace(refusal: PlaceRefusal): BackupRefused {
  switch (refusal.code) {
    case "same_data_folder_of_this_instance":
      return new BackupRefused("A backup cannot go into the data folder itself.", ["Choose a folder outside it."]);
    case "data_folder_of_another_instance":
      return new BackupRefused(`${refusal.backups} is the data folder of a Vigile instance: a backup written there would be taken for a tenant of that instance.`, ["Choose another folder."]);
    default:
      return unknownRefusal(refusal);
  }
}

/** A reason that is none of the ones there are: a mistake in the code, which the compiler finds first. */
export function unknownRefusal(refusal: never): never {
  throw new Error(`There is no reason called ${JSON.stringify(refusal)} for refusing a backup folder.`);
}

/** Says so when what stands where the backups are to go is not a folder: nothing is made, opened or read there. */
function mustBeFolder(folder: string): void {
  const kind = kindAt(folder);
  if (kind && kind !== "folder") throw new BackupRefused(`${folder} is not a folder: it is a ${kind}.`, ["Move it away, or name another folder for the backups."]);
}

function refuseFolder(dataDir: string, folder: string): void {
  const refusal = placeRefusal(dataDir, folder);
  if (refusal) throw refusedPlace(refusal);
}

/** Validates and optionally creates a possible backup folder, returning the exact directory identity to lock. */
export function prepareBackupFolder(dataDir: string, folder: string, create: boolean): { device: number; inode: number } | null {
  refuseFolder(dataDir, folder);
  mustBeFolder(folder);
  if (create) mkdirSync(folder, { recursive: true, mode: 0o700 });
  else if (!somethingAt(folder)) return null;
  refuseFolder(dataDir, folder);
  const found = lstatSync(folder, { throwIfNoEntry: false });
  if (!found?.isDirectory()) throw new BackupRefused(`${folder} is not a folder.`);
  const marker = join(folder, BACKUPS_LOCK);
  const markerKind = kindAt(marker);
  if (markerKind && markerKind !== "file") throw new BackupRefused(`${marker} is not a lock file of Vigile. Remove it while no vigile command and no service is running.`);
  return { device: found.dev, inode: found.ino };
}

/** Publishes backup-folder history only after shared ownership excludes every data service. */
export function designateBackupFolder(folder: string, expected: { device: number; inode: number }): { device: number; inode: number } {
  const found = lstatSync(folder, { throwIfNoEntry: false });
  if (!found?.isDirectory() || found.dev !== expected.device || found.ino !== expected.inode) throw new BackupRefused(`The held backup folder ${folder} was moved or replaced while backup ownership was being acquired.`);
  const marker = join(folder, BACKUPS_LOCK);
  const markerKind = kindAt(marker);
  if (markerKind && markerKind !== "file") throw new BackupRefused(`${marker} is not a lock file of Vigile. Remove it while no vigile command and no service is running.`);
  if (!markerKind) {
    const handle = createPlainFile(marker);
    try { fsyncSync(handle); } finally { closeSync(handle); }
    flushFolder(folder);
  }
  return expected;
}

/**
 * Why a config's automatic backups cannot go where it has them go, or null when they can, or are off. Asked
 * of a config as a whole, with its folders worked out: whether the place is one a backup may be written to
 * depends on both folders and on whether backups are taken at all, never on one setting alone.
 */
export function backupPlaceRefused(loaded: { config: { backup: { enabled: boolean } }; dataDir: string; backupDir: string }): PlaceRefusal | null {
  return loaded.config.backup.enabled ? placeRefusal(loaded.dataDir, loaded.backupDir) : null;
}

/**
 * Writes a consistent copy of every tenant's data into a folder. Safe while the service runs; reads only. This
 * is the whole of a backup, for `vigile backup` and for the ones the service takes by itself, so that what holds
 * for the one holds for the other. It does not return until the backup is written, which takes as long as the
 * data is large: the service has it done on a thread of its own.
 */
export function takeBackup(request: BackupRequest, how: Partial<BackupSteps> = {}): BackupResult {
  const { automatic } = request;
  const steps = { ...STEPS, ...how };
  // The two folders as the places they lead to, walked as the system walks them: what is checked, made, written
  // to and named in the answer is one and the same folder. A path worked out by striking `..` together with
  // the name before it leads elsewhere when that name is a link.
  // A path that leads nowhere is refused, as that: no other path is made of it.
  const led = (path: string): string => {
    try {
      return placeOf(path);
    } catch (error) {
      if (error instanceof NoPlace) throw new BackupRefused(`${error.message}.`, ["Name a folder that the path leads to."]);
      throw error;
    }
  };
  const dataDir = led(request.dataDir);
  const folder = led(request.folder);
  const requireFolder = (): void => {
    if (!request.folderIdentity) return;
    const found = lstatSync(folder, { throwIfNoEntry: false });
    if (!found?.isDirectory() || found.dev !== request.folderIdentity.device || found.ino !== request.folderIdentity.inode) {
      throw new BackupRefused(`The held backup folder ${folder} was moved or replaced while the backup was running.`, ["Put the folder back, or restart the service after choosing a stable backup folder."]);
    }
  };
  requireFolder();
  refuseFolder(dataDir, folder);
  if (!existsSync(dataDir)) throw new BackupRefused(`There is no data yet at ${dataDir}.`);
  // From the look at what there is until the last copy is made, no restore and no recovery of one may move a
  // tenant's files: a copy begun on a file that is then moved away would leave out what it had not read yet.
  // The running service moves nothing, and is not kept out by this, nor does it keep a backup out.
  let release: (() => void) | null;
  let releaseDestination: (() => void) | null = null;
  try {
    release = holdTenantFiles(dataDir, FILES_WAIT_MS);
  } catch (error) {
    throw new BackupRefused(`The data in ${dataDir} cannot be kept still for a backup: ${(error as Error).message}.`, ["Give this account write access to the data folder: a backup leaves a lock file there."]);
  }
  if (!release) throw new BackupRefused(`A restore, or another backup, is at work in ${dataDir}.`, ["Take the backup when it has finished."]);
  const result: BackupResult = { folder, files: [], removed: [], notRemoved: [], unconfirmed: null };
  try {
    // Half-way through a restore a tenant's file is somewhere else, or without what belongs beside it: a backup
    // taken now would miss the tenant, or part of it, and say that all is well.
    if (restoreInterrupted(dataDir)) {
      throw new BackupRefused(`A restore in ${dataDir} was interrupted, and the data is not in order yet.`, ["Start the service, or run restore-backup again: either puts it in order first. Then take the backup."]);
    }
    const files = tenantFiles(dataDir);
    if (!files.length) throw new BackupRefused(`There is no data yet at ${dataDir}.`);
    for (const source of files) {
      if (!lstatSync(source.file, { throwIfNoEntry: false })?.isFile()) throw new BackupRefused(`${source.file} is not a plain tenant file and cannot be backed up.`);
    }

    mustBeFolder(folder);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    // Asked again now that the folder is there for certain: a link made in the meantime leads where it leads.
    refuseFolder(dataDir, folder);
    try {
      releaseDestination = holdFile(backupOperationLock(folder));
    } catch (error) {
      throw new BackupRefused(`The backup destination ${folder} cannot be reserved: ${(error as Error).message}.`);
    }
    if (!releaseDestination) throw new BackupRefused(`Another backup or recovery is writing in ${folder}.`, ["Let it finish, then take the backup again."]);

    // One backup is every tenant's copy or none. Each copy is written under a working name; only when all of
    // them are whole and on the disk do they get their names, one after another; and whatever goes wrong before
    // the last one has its name, every file of this backup is removed again, those that had their names already
    // as well.
    const given = request.copies;
    // Whoever made the copies its own did so for the tenants it saw. They are the ones there are.
    if (given && (given.length !== files.length || given.some((copy, i) => copy.source !== files[i]!.file))) {
      throw new Error(`The tenants in ${dataDir} are not the ones this backup was prepared for`);
    }
    const copies = given ?? prepareCopies(dataDir, folder, request.at, automatic !== undefined);
    const sizes: number[] = [];
    let setUnconfirmed: string | null = null;
    try {
      request.step?.("start");
      for (const copy of copies) {
        requireFolder();
        request.step?.("copy", copy.tenant);
        // The working file is the empty plain file that was made for this copy: the store writes into nothing else.
        const empty = lstatSync(copy.working, { throwIfNoEntry: false });
        if (!empty?.isFile() || empty.size !== 0 || empty.dev !== copy.device || empty.ino !== copy.inode) throw new Error(`${copy.working} is not the empty file that was made for this copy`);
        if (!lstatSync(copy.source, { throwIfNoEntry: false })?.isFile()) throw new Error(`${copy.source} is not a plain tenant file`);
        backupTenantFile(copy.source, copy.working, {
          device: copy.device,
          inode: copy.inode,
          staging: copy.stagingDirectory && copy.stagingFile ? { directory: copy.stagingDirectory, file: copy.stagingFile, device: copy.stagingDevice!, inode: copy.stagingInode!, fileDevice: copy.stagingFileDevice!, fileInode: copy.stagingFileInode! } : undefined,
        });
        if (copy.stagingRecord) {
          const marker = lstatSync(copy.stagingRecord, { throwIfNoEntry: false });
          if (!marker?.isFile() || marker.dev !== copy.stagingRecordDevice || marker.ino !== copy.stagingRecordInode || somethingAt(copy.stagingDirectory!)) throw new Error(`${copy.stagingRecord} is not the durable staging record made for this backup`);
          rmSync(copy.stagingRecord);
        }
        request.step?.("copied", copy.tenant);
        // The store does not flush the copy it writes. Opened as a plain file and as nothing else, without
        // waiting; made private, flushed and measured through what was opened, not through its name again.
        const noLink = constants.O_NOFOLLOW ?? 0;
        const handle = openSync(copy.working, constants.O_RDWR | (constants.O_NONBLOCK ?? 0) | noLink);
        try {
          const named = lstatSync(copy.working, { throwIfNoEntry: false });
          const opened = fstatSync(handle);
          if (!named?.isFile() || !opened.isFile() || named.dev !== opened.dev || named.ino !== opened.ino || opened.dev !== copy.device || opened.ino !== copy.inode) throw new Error(`${copy.working} is not the file that was made for this copy`);
          fchmodSync(handle, 0o600);
          fsyncSync(handle);
          // How large each is, is known before the first has its name: nothing that can fail lies between two names.
          const flushed = fstatSync(handle);
          sizes.push(flushed.size);
          Object.assign(copy, { flushedCtimeMs: flushed.ctimeMs, flushedSize: flushed.size });
        } finally {
          closeSync(handle);
        }
        request.step?.("flushed", copy.tenant);
        requireFolder();
      }
      for (const copy of copies) {
        requireFolder();
        request.step?.("name", copy.tenant);
        // A linked publication claims a still-free name here. A copy publication claimed and identified both
        // its guarded final name and its working name before the worker began.
        if (copy.publication !== "set") {
          if (copy.publication === "link" && somethingAt(copy.file)) throw new Error(`There is already something called ${copy.file}`);
          steps.rename(copy.working, copy.file, copy);
        }
      }
      // The copies remain undiscoverable until this one marker is durable in their private set directory.
      // Publication is the set boundary: no per-tenant filename can make a partial automatic backup count.
      setUnconfirmed = publishSet(copies);
    } catch (error) {
      // What went wrong is what is said, also when what was written so far cannot be cleared away.
      settleCopies(copies);
      throw error;
    }
    request.step?.("named");
    requireFolder();
    result.files = copies.map(({ tenant, file }, i) => ({ tenant, file, bytes: sizes[i]! }));
    result.unconfirmed = setUnconfirmed;
    // A backup is written once its folder says it holds it. When the system cannot confirm that, the backup is
    // whole and in place all the same, and that is what is said of it. Nothing older is removed for it.
    try {
      steps.flush(folder);
    } catch (error) {
      result.unconfirmed = (error as Error).message;
      return result;
    }
    if (result.unconfirmed !== null) return result;

    // Older ones go only now that the new one is safely there. Among the ones kept is always the one just
    // written; the others are kept in the order of `keptFirst`. The backup is taken by now: whatever goes
    // wrong with the older ones is said, and does not undo it.
    if (automatic) {
      request.step?.("retention");
      const fresh = new Set(result.files.map((item) => item.file));
      // A prior retirement may already have unpublished its set before one removal failed. Such a set is absent
      // from automaticBackups(), so resume its identity-recorded cleanup before discovering retention units.
      try {
        clearIncompleteSets(folder);
      } catch (error) {
        result.notRemoved.push(`an incomplete retirement could not be resumed: ${(error as Error).message}`);
      }
      let all: AutomaticBackup[] = [];
      try {
        all = automaticBackups(folder);
      } catch (error) {
        result.notRemoved.push(`what there is in ${folder} could not be listed: ${(error as Error).message}`);
      }
      const bySet = new Map<string, AutomaticBackup[]>();
      for (const backup of all.filter((item) => item.set)) {
        const grouped = bySet.get(backup.set!);
        if (grouped) grouped.push(backup);
        else bySet.set(backup.set!, [backup]);
      }
      const sets = [...bySet.values()];
      const legacy = all.filter((backup) => !backup.set && !fresh.has(backup.file));
      // A set is one retention unit; each transitional flat moment is one compatibility unit. Rank all of them
      // globally, including the set just written, so tenant removal cannot give old sets a second quota and a
      // future-dated set still makes room before a newer legacy moment as earlier releases did.
      const legacyMoments = new Map<number, AutomaticBackup>();
      for (const backup of legacy) if (!legacyMoments.has(backup.at)) legacyMoments.set(backup.at, backup);
      const units = [
        ...sets.map((group) => ({ backup: group[0]!, set: group })),
        ...[...legacyMoments.values()].map((backup) => ({ backup, set: null })),
      ].sort((a, b) => keptFirst(request.at.getTime())(a.backup, b.backup));
      const expiredUnits = units.slice(automatic.keep);
      const expiredSets = new Set(expiredUnits.flatMap((unit) => unit.set ? [unit.set] : []));
      const expiredLegacyMoments = new Set(expiredUnits.filter((unit) => !unit.set).map((unit) => unit.backup.at));
      for (const oldSet of sets.filter((group) => expiredSets.has(group))) {
        try {
          result.removed.push(...removeCommittedSet(oldSet, steps.remove));
        } catch (error) {
          result.notRemoved.push(`${oldSet[0]!.set}: ${(error as Error).message}`);
        }
      }
      // Transitional flat backups have no set marker, but every shared moment is one global retention unit.
      for (const backup of legacy.filter((item) => expiredLegacyMoments.has(item.at))) {
        try {
          steps.remove(backup.file);
          result.removed.push(backup.file);
        } catch (error) {
          result.notRemoved.push(`${backup.file}: ${(error as Error).message}`);
        }
      }
    }
  } finally {
    releaseDestination?.();
    release();
  }
  return result;
}

/** What the thread that takes a backup for the service says at its end: how it went. */
export type WorkerAnswer = { ok: true; result: BackupResult } | { ok: false; message: string; hints: string[] | null };

/**
 * How a backup ended, from what settling its files found and what its thread said, if it said anything. Whether
 * the backup is whole is what was found in the folder; the thread's word says the rest.
 */
function outcomeOf(whole: boolean, copies: readonly PlannedCopy[], answer: WorkerAnswer | undefined, died: unknown, settledBytes = 0): BackupOutcome {
  const why = answer && !answer.ok ? answer.message : died instanceof Error ? died.message : died === undefined ? null : String(died);
  if (!whole) {
    return {
      kind: "incomplete",
      reason: answer?.ok ? "The backup's copies were not all there when its thread had ended." : (why ?? "The thread that wrote the backup ended before the backup was whole, and without saying why."),
      actions: answer && !answer.ok && answer.hints ? answer.hints : [],
    };
  }
  if (!answer?.ok) {
    // Whole, and nobody said so: how large it is is read from the copies themselves.
    return { kind: "complete_unreported", copies: copies.length, bytes: settledBytes, reason: why };
  }
  const { files, removed, notRemoved, unconfirmed } = answer.result;
  const written = { copies: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
  if (unconfirmed !== null) return { kind: "complete_unconfirmed", ...written, reason: unconfirmed };
  if (notRemoved.length) return { kind: "complete_retention_failed", ...written, removed: removed.length, notRemoved };
  return { kind: "complete", ...written, removed: removed.length };
}

/** The file in the data folder that holds what the service keeps of the last automatic backup it began. */
export const MEMORY_FILE = "vigile-backups.json";

/**
 * What the service keeps of the last backup it began, in a file of its own in the data folder. In the data
 * folder and not among the backups: it has to be kept exactly when the backup folder cannot be written, is
 * not there, or is another service's. The data folder is this service's alone for as long as it runs, so
 * nobody else writes the file, and two services whose backups go to one folder each keep their own.
 *
 * It is one small file, replaced as a whole each time: written under another name, flushed, then given its
 * name. It is no tenant and no backup: `vigile backup` does not copy it and a restore leaves it where it is.
 * Removed by hand, the next run begins as if no backup had been begun before.
 *
 * Reading it never fails. Whatever is there that is not what the service writes, a file too large to be it,
 * a folder under its name, text that is no JSON or JSON of another shape, is answered with that it cannot be
 * read and why; no more of the file is read than the service could have written.
 */
export function backupMemory(dataDir: string): BackupMemory {
  const file = join(dataDir, MEMORY_FILE);
  const writing = new Set<Promise<void>>();
  return {
    read() {
      let handle: number;
      try {
        // As a plain file and as nothing else, without waiting: a pipe under the name, with nobody at its
        // other end, would otherwise be waited for without end, and the service with it.
        handle = openPlainFile(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        if (error instanceof NotAFile) return { unreadable: `${file} is not what the service writes there: it is a ${error.kind}, not a file` };
        return { unreadable: `${file} cannot be read (${(error as Error).message})` };
      }
      try {
        if (fstatSync(handle).size > REMEMBERED_MOST_BYTES) return { unreadable: `${file} is larger than anything the service writes there` };
        // One more than the most there may be, so that a file that grew meanwhile is seen to be too large.
        const buffer = Buffer.alloc(REMEMBERED_MOST_BYTES + 1);
        let filled = 0;
        for (let got = -1; got !== 0 && filled < buffer.length; filled += got) got = readSync(handle, buffer, filled, buffer.length - filled, null);
        if (filled > REMEMBERED_MOST_BYTES) return { unreadable: `${file} is larger than anything the service writes there` };
        return decodeRemembered(buffer.toString("utf8", 0, filled)) ?? { unreadable: `${file} is not what the service writes there` };
      } catch (error) {
        return { unreadable: `${file} cannot be read (${(error as Error).message})` };
      } finally {
        closeSync(handle);
      }
    },
    async write(remembered) {
      const text = remembered ? encodeRemembered(remembered) : null;
      if (remembered && text === null) throw new Error(`${file} cannot hold it in the form the service reads again`);
      const work = new Promise<void>((resolve, reject) => {
        const worker = new Worker(new URL("./backup-memory-worker.js", import.meta.url), { workerData: { dataDir, name: MEMORY_FILE, text } });
        let answer: { ok: true } | { ok: false; message: string } | undefined;
        worker.once("message", (message) => (answer = message));
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (!answer) reject(new Error(`The backup-memory worker ended before answering${code === 0 ? "" : ` (exit ${code})`}.`));
          else if (answer.ok) resolve();
          else reject(new Error(answer.message));
        });
      });
      writing.add(work);
      try { await work; } finally { writing.delete(work); }
    },
    async close() { await Promise.allSettled([...writing]); },
  };
}

/** For the tests: has the backup's thread stop at one place, by waiting there until it is ended or by dying there, and say that it got there. */
export interface WorkerPause {
  point: BackupPoint;
  /** For the places a backup comes to once for each tenant: at which of them. */
  tenant?: string;
  then: "wait" | "die";
  /** Four bytes that the thread sets to 1 when it has got there. */
  reached: SharedArrayBuffer;
}

export interface WorkerRequest {
  dataDir: string;
  folder: string;
  at: number;
  automatic: { keep: number };
  copies: PlannedCopy[];
  folderIdentity: { device: number; inode: number };
  pause?: WorkerPause;
}

/** For the tests. */
export interface BackupHooks {
  /** Where the backup's thread stops. */
  pause?: WorkerPause;
  /** Something to wait for between the end of a backup's thread and the settling of its files. */
  ending?(): Promise<void>;
  /** Told what is in the folder at the moment this service takes it, before it clears anything. */
  taken?(found: string[]): void;
  /** Called when the files of a backup whose thread has ended are about to be settled, and again when they have been, before the folder may go. */
  settling?(when: "before" | "after"): void;
  /** Replaces asynchronous backup-folder acquisition in fault-injection tests. */
  hold?(file: string, deadline: number): Promise<AsyncRelease | null>;
  /** Replaces creation of a backup-folder worker in fault-injection tests. */
  folderWorker?(request: object, start: () => Worker): Worker;
}

/**
 * The automatic backups of a SQLite data folder, for the schedule the service keeps. Each one is `takeBackup`
 * on a thread of its own: copying a large plan takes tens of milliseconds, more on a slow disk, and waiting for
 * a `vigile backup` that is at work beside the service takes up to two seconds, in none of which the service
 * may stop answering.
 *
 * The folder belongs to one service at a time, through a lock the system keeps: two services that wrote there
 * would take each other's backups for their own, and each would remove the other's. The lock is held for
 * exactly as long as anything of this service can still touch the folder, and what this service knows of its
 * backup's files is complete at every instant. A backup goes through these states:
 *
 * - prepared: before its thread exists, its files are made its own here (`prepareCopies`): every name it can
 *   write is known, none is taken, and the working files are created. The thread creates no file of its own.
 * - writing: its thread is alive. It copies into the working files, gives the copies their names, flushes,
 *   removes older backups. When it fails by itself, it settles its files itself before it says so.
 * - settling: its thread has ended, however it ended: with an answer, cut short by `cancel` wherever it was,
 *   or by dying. Its files are settled here by looking at them (`settleCopies`): whole, it stays; anything
 *   less, every file of it is removed. Nothing the thread said or did not get to say is needed for that.
 * - over: nothing of it can touch the folder any more, and nothing of it is left there but a whole backup.
 *
 * `close` lets go of the lock when no backup is prepared, writing or settling, at once or as soon as that is
 * so. A stop that does not wait for a backup to end therefore returns with the folder still held, and no other
 * service gets it until that backup is over. The process does not end by itself before that either: a backup
 * that is not over keeps it, and `serve` waits for it before it ends the process. If the process is killed
 * all the same, the system lets go of the lock, and whoever takes the folder next clears the working files
 * that were left, which it does only once it holds the folder.
 */
export function sqliteBackups(options: { dataDir: string; folder: string; keep: number; hooks?: BackupHooks }): BackupSource {
  // The two folders as the config has them, which is as the places they lead to: used as they are.
  const { dataDir, folder, keep, hooks = {} } = options;
  let held: AsyncRelease | null = null;
  let holding: Promise<void> | null = null;
  let holdFailure: unknown;
  let heldFolder: { device: number; inode: number } | null = null;
  let knownMoments: number[] = [];
  let scanFailure: unknown;
  let scanning: Promise<void> | null = null;
  /** Ends when the backup under way is over. Null when none is. */
  let live: Promise<void> | null = null;
  let closing = false;

  const letGo = async (): Promise<void> => {
    if (!closing || live) return;
    await holding;
    await scanning;
    await held?.();
    held = null;
    heldFolder = null;
  };

  type FolderAnswer = { ok: true; identity: { device: number; inode: number } | null; moments?: number[]; before?: string[]; whole?: boolean; bytes?: number; scanError?: string } | { ok: false; message: string; hints: string[]; refused?: boolean };

  /** Runs one bounded backup-folder operation away from the service thread. */
  const folderJob = (request: object): Promise<FolderAnswer> =>
    new Promise((resolve) => {
      const start = () => new Worker(new URL("./backup-scan-worker.js", import.meta.url), { workerData: request });
      const worker = hooks.folderWorker?.(request, start) ?? start();
      let answer: FolderAnswer | undefined;
      worker.once("message", (message: FolderAnswer) => (answer = message));
      worker.once("error", (error) => (answer = { ok: false, message: error.message, hints: [] }));
      worker.once("exit", (code) => resolve(answer ?? { ok: false, message: `The backup-folder worker ended before answering${code === 0 ? "" : ` (exit ${code})`}.`, hints: [] }));
    });

  /** Refreshes the status snapshot off the service thread. Calls share one scan. */
  const refresh = (): Promise<void> => {
    if (!held) return Promise.resolve();
    if (scanning) return scanning;
    scanning = folderJob({ action: "scan", dataDir, folder, expected: heldFolder! })
      .then((answer) => {
        if (answer.ok) {
          knownMoments = answer.moments ?? [];
          scanFailure = undefined;
        } else scanFailure = new Error(answer.message);
      }, (error) => {
        scanFailure = error;
      })
      .finally(() => (scanning = null));
    return scanning;
  };

  /** Begins taking the folder without holding up the service's thread. */
  const beginHold = (create: boolean): void => {
    holding = (async () => {
      const prepared = await folderJob({ action: "prepare", dataDir, folder, create });
      if (!prepared.ok) {
        if (prepared.refused) throw new BackupRefused(prepared.message, prepared.hints);
        throw new BackupRefused(`The backup folder ${folder} cannot be taken for this service: ${prepared.message}.`, [
          "Give the account the service runs as read and write access to the folder, or choose another: vigile config set backup.folder <folder>, then restart the service.",
        ]);
      }
      const expected = prepared.identity;
      if (!expected) return;
      let folderTaken: AsyncRelease | null = null;
      let backupTaken: AsyncRelease | null = null;
      try {
        const deadline = Date.now() + 10_000;
        folderTaken = await holdFolderAsync(folder, deadline);
        if (folderTaken) {
          const designated = await folderJob({ action: "designate", folder, expected });
          if (!designated.ok) throw new BackupRefused(designated.message, designated.hints);
          backupTaken = await (hooks.hold ?? holdFileAsync)(join(folder, BACKUPS_LOCK), deadline);
        }
      } catch (error) {
        await backupTaken?.().catch(() => {});
        await folderTaken?.().catch(() => {});
        if (/is not a lock file of Vigile/.test((error as Error).message)) throw new BackupRefused((error as Error).message);
        throw new BackupRefused(`The backup folder ${folder} cannot be taken for this service: ${(error as Error).message}.`, [
          "Give the account the service runs as read and write access to the folder, or choose another: vigile config set backup.folder <folder>, then restart the service.",
        ]);
      }
      if (!folderTaken || !backupTaken) {
        await backupTaken?.().catch(() => {});
        await folderTaken?.().catch(() => {});
        throw new BackupRefused(`Another Vigile service takes its automatic backups into ${folder}.`, ["Give each instance a backup folder of its own: vigile config set backup.folder <folder>, then restart the service."]);
      }
      const taken: AsyncRelease = async (deadline = Date.now() + 10_000) => {
        const failures: unknown[] = [];
        await backupTaken!(deadline).catch((error) => failures.push(error));
        await folderTaken!(deadline).catch((error) => failures.push(error));
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "The backup-folder locks could not all be confirmed released.");
      };
      try {
        const recovered = await folderJob({ action: "recover", dataDir, folder, expected });
        if (!recovered.ok) throw new BackupRefused(recovered.message, recovered.hints);
        hooks.taken?.(recovered.before ?? []);
        knownMoments = recovered.moments ?? [];
        scanFailure = undefined;
      } catch (error) {
        await taken();
        throw error;
      }
      heldFolder = expected;
      held = taken;
    })()
      .catch((error) => {
        holdFailure = error;
      })
      .finally(() => {
        holding = null;
      });
  };

  return {
    async ready(create) {
      if (closing) return;
      if (!held && !holding) {
        if (holdFailure !== undefined) {
          if (!create) return;
          holdFailure = undefined;
        }
        beginHold(create);
      }
      await holding;
      if (closing) return;
      await refresh();
    },

    moments() {
      // Status reads only the asynchronously refreshed snapshot. They never walk a slow backup filesystem on
      // the service thread; scheduled checks and completed backups refresh it through the scanner worker.
      if (holdFailure !== undefined) throw holdFailure;
      if (scanFailure !== undefined) throw scanFailure;
      return [...knownMoments];
    },

    take(at) {
      const refused = (error: unknown, hints: string[] = []): BackupOutcome => ({ kind: "incomplete", reason: error instanceof Error ? error.message : String(error), actions: hints });
      if (closing) return { done: Promise.resolve(refused(new Error("The service is stopping."))), cancel: async () => {} };
      if (holdFailure !== undefined) {
        const error = holdFailure;
        holdFailure = undefined;
        return { done: Promise.resolve(refused(error, error instanceof BackupRefused ? error.hints : [])), cancel: async () => {} };
      }
      if (!held || !heldFolder) return { done: Promise.resolve(refused(new BackupRefused(`The backup folder ${folder} is still being taken for this service.`, ["Try the backup again once acquisition has finished."]))), cancel: async () => {} };

      let active: Worker | null = null;
      let cancelled = false;
      let phase: "preparing" | "writing" | "settling" = "preparing";
      const runWorker = <T>(url: URL, workerData: object): Promise<{ answer?: T; died?: unknown }> =>
        new Promise((resolve) => {
          const worker = new Worker(url, { workerData });
          active = worker;
          let answer: T | undefined;
          let died: unknown;
          worker.once("message", (message: T) => (answer = message));
          worker.once("error", (error) => (died = error));
          worker.once("exit", () => {
            if (active === worker) active = null;
            resolve({ answer, died });
          });
        });

      const done = (async (): Promise<BackupOutcome> => {
        const prepared = await runWorker<{ ok: true; copies: PlannedCopy[] } | { ok: false; message: string; hints: string[] }>(new URL("./backup-prepare-worker.js", import.meta.url), { dataDir, folder, at, expected: heldFolder! });
        if (!prepared.answer?.ok) {
          const recovered = await folderJob({ action: "recover", dataDir, folder, expected: heldFolder! });
          if (recovered.ok) knownMoments = recovered.moments ?? [];
          const error = prepared.answer && !prepared.answer.ok ? prepared.answer.message : prepared.died ?? "The backup preparation worker ended before answering.";
          return refused(error, prepared.answer && !prepared.answer.ok ? prepared.answer.hints : []);
        }
        const copies = prepared.answer.copies;
        if (cancelled || closing) {
          phase = "settling";
          await folderJob({ action: "settle", dataDir, folder, expected: heldFolder!, copies });
          return refused(new Error("The service is stopping."));
        }
        phase = "writing";
        const written = await runWorker<WorkerAnswer>(new URL("./backup-worker.js", import.meta.url), { dataDir, folder, at, automatic: { keep }, copies, folderIdentity: heldFolder!, pause: hooks.pause } satisfies WorkerRequest);
        await hooks.ending?.().catch(() => {});
        phase = "settling";
        hooks.settling?.("before");
        const settled = await folderJob({ action: "settle", dataDir, folder, expected: heldFolder!, copies });
        hooks.settling?.("after");
        if (!settled.ok) {
          scanFailure = new Error(settled.message);
          return refused(settled.message, settled.hints);
        }
        if (settled.moments) knownMoments = settled.moments;
        scanFailure = settled.scanError ? new Error(settled.scanError) : undefined;
        return outcomeOf(Boolean(settled.whole), copies, written.answer, written.died, settled.bytes ?? 0);
      })();
      // Until the backup is over, this process does not end by itself, whatever else has: with it would go
      // the folder's lock, before the backup's files are settled.
      const alive = setInterval(() => {}, 60_000);
      // Only then is the backup over and may the folder go.
      const over = done.then(
        () => {},
        () => {},
      ).then(async () => {
        live = null;
        await letGo();
        clearInterval(alive);
      });
      live = over;
      return {
        done: over.then(() => done),
        // The thread ends when the copy it is at returns. This returns when the backup is over.
        async cancel() {
          cancelled = true;
          // Preparation is the operation that establishes the durable ownership record. Let it finish so its
          // complete plan reaches the parent, then settle that plan instead of stranding unrecorded files.
          if (phase !== "preparing") await active?.terminate();
          await over;
        },
      };
    },

    async close() {
      closing = true;
      const under = live;
      if (under) return under;
      await letGo();
    },
  };
}
