import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Engine, areKeyMarks, readAll, storedAs } from "@vigile/core";
import { assertTenantName, type StorageAdapter } from "@vigile/storage";
import { flushFolder, historyOwners, holdTenantFiles, openTenantFile, timelineOwners } from "@vigile/storage-sqlite";
import { samePlace } from "@vigile/config";

/**
 * A note in the data folder that a restore is under way: which tenant, and the folder that takes what was there.
 * It is written, and the folder flushed, before the first file is moved, and removed after the last. A restore
 * that is killed in between leaves it, and with it everything needed to put the data in order again: without
 * it, a tenant whose file had just been moved aside would look like one that does not exist yet, and the next
 * start would begin an empty plan in its place.
 */
const NOTE = "restore-in-progress.json";

/**
 * What SQLite keeps beside a database while it is open, and leaves there when the process is killed: its log of
 * changes, the index to that, and the journal it rolls back from. Each belongs to the database it lies beside,
 * and left beside another one it would be replayed onto that.
 */
export const BESIDE = ["-wal", "-shm", "-journal"];

export interface RestoreNote {
  tenant: string;
  /** The name, inside the data folder, of the folder that takes what was there. */
  aside: string;
  /** The names of the files that were there when the restore began, and that it moves aside. */
  had: string[];
}

/** What may lie beside the copy of a backup: what making it, and checking it, put there. */
export const BESIDE_COPY = ["", ...BESIDE];

/**
 * The order in which files that were moved aside are put back: the reverse of the order they were moved in, so
 * the data file last. A tenant is its data file and what lies beside it, and while the data file is not back
 * nothing can open the tenant without the rest, as the doctor or a backup would, and leave an empty file of its
 * own where the real one belongs.
 */
export const putBackOrder = (moved: readonly string[]): string[] => [...moved].reverse();

/** The names a restore works under in a data folder, of whichever tenant: the copy of a backup and what may lie beside it. */
const WORKING_NAME = /\.sqlite\.restoring(-journal|-wal|-shm)?$/;

/**
 * Whether a file is one a restore works with in this data folder, under whatever name it is reached. These are
 * all the files a restore, or the recovery of one, writes over or clears away: the copy of a backup, of this
 * tenant or another, and what may lie beside one; the note of a restore, and the note before it has its name.
 * None of them can be the backup to restore from: it would be gone before it was copied.
 */
export function isWorkingFile(dataDir: string, file: string): boolean {
  if (!existsSync(dataDir)) return false;
  return readdirSync(dataDir).some((name) => (WORKING_NAME.test(name) || name === NOTE || name === `${NOTE}.tmp`) && samePlace(file, join(dataDir, name)));
}

/** The name of the file a restore keeps its copy of the backup in while it works. */
export const stagingFile = (dataDir: string, tenant: string): string => join(dataDir, `${tenant}.sqlite.restoring`);

/**
 * Writes the note and has the system put it on the disk, what it says and that it is there, before anything is
 * moved. It is written under another name and given its own only when it is whole: a note that is there is one
 * that can be read. If it cannot be written, nothing of it stays, and nothing has been moved.
 */
export function noteRestore(dataDir: string, note: RestoreNote): void {
  const unfinished = join(dataDir, `${NOTE}.tmp`);
  try {
    const handle = openSync(unfinished, "w", 0o600);
    try {
      writeFileSync(handle, JSON.stringify(note) + "\n");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(unfinished, join(dataDir, NOTE));
  } catch (error) {
    rmSync(unfinished, { force: true });
    throw error;
  }
  flushFolder(dataDir);
}

/**
 * Takes the note away. The folder is flushed first, while the note is still there: what the restore, or its
 * undoing, moved and renamed in the folder must be on the disk before the note that explains a half-done state
 * is gone, or a power cut could leave that state without its explanation. Then the note goes, and that is
 * flushed too.
 */
export function forgetRestore(dataDir: string, flush: (folder: string) => void = flushFolder): void {
  flush(dataDir);
  rmSync(join(dataDir, NOTE), { force: true });
  flush(dataDir);
}

/** Whether a restore was begun in this data folder and not finished. */
export const restoreInterrupted = (dataDir: string): boolean => existsSync(join(dataDir, NOTE));

const stampOf = (at: Date): string => at.toISOString().replace(/[-:]/g, "").replace(/\./, "-").replace("Z", "").replace("T", "-");

/**
 * Makes the folder that takes what a restore sets aside, named after the moment, and makes sure that it is a
 * new one: a name that is taken, by a restore of the same millisecond or by a clock that was set back, gets a
 * number after it.
 */
function ownFolder(dataDir: string, at: Date): string {
  for (let n = 1; ; n++) {
    const folder = join(dataDir, `replaced-${stampOf(at)}${n === 1 ? "" : `-${n}`}`);
    try {
      mkdirSync(folder, { mode: 0o700 });
      return folder;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || n >= 1000) throw error;
    }
  }
}

/**
 * Sets aside what a tenant has and gives the copy of the backup the data file's name. To be called by whoever
 * holds the data folder and the tenants' files, with the copy made and checked. Each step is put on the disk
 * before the next one that depends on it:
 * 1. the note, which says what is about to be moved and where to. From here until it is taken away again, a
 *    restore that is cut short is put in order by the next start of the service, or by the next restore;
 * 2. the moves, into a folder of their own. Both folders are flushed before the copy gets its name: a power cut
 *    could otherwise keep the new name and lose one of the moves, and the backup would stand there with the
 *    old log of changes beside it, to be replayed onto it;
 * 3. the copy's new name, flushed while the note is still there, and only then the note's going.
 * If a step fails, what was moved is put back, the data file last, and the data is as it was.
 */
export function putInPlace(dataDir: string, tenant: string, incoming: string, flush: (folder: string) => void = flushFolder, at: Date = new Date()): { aside: string; moved: string[] } {
  const target = join(dataDir, `${tenant}.sqlite`);
  const moved: string[] = [];
  const there = [target, ...BESIDE.map((suffix) => target + suffix)].filter((file) => existsSync(file));
  // The folder that takes what is there is this restore's own, made before anything else is touched: a folder of
  // an earlier restore under the same name is never moved into, where a file of the same name would be lost.
  const aside = there.length ? ownFolder(dataDir, at) : join(dataDir, `replaced-${stampOf(at)}`);
  try {
    noteRestore(dataDir, { tenant, aside: basename(aside), had: there.map((file) => basename(file)) });
  } catch (error) {
    // Nothing has been moved. A note that got its name although the folder then would not confirm it is taken
    // away again, so that the copy can go too; should that fail as well, the next start puts it in order.
    try {
      forgetRestore(dataDir, flush);
    } catch {
      // The first failure is reported.
    }
    if (there.length) {
      try {
        rmdirSync(aside);
      } catch {
        // The first failure is reported.
      }
    }
    throw error;
  }
  try {
    for (const file of there) {
      renameSync(file, join(aside, basename(file)));
      moved.push(basename(file));
    }
    if (moved.length) flush(aside);
    flush(dataDir);
    renameSync(incoming, target);
  } catch (error) {
    // That reason is the one to hear, also should the folder then not confirm what it holds.
    for (const name of putBackOrder(moved)) renameSync(join(aside, name), join(dataDir, name));
    try {
      // Where the files are again first, then where they were: see the recovery.
      flush(dataDir);
      if (existsSync(aside)) flush(aside);
    } catch {
      // The first failure is reported.
    }
    // A folder that gave back all it took is not kept.
    if (existsSync(aside) && !readdirSync(aside).length) rmdirSync(aside);
    try {
      forgetRestore(dataDir, flush);
    } catch {
      // The first failure is reported.
    }
    throw error;
  }
  forgetRestore(dataDir, flush);
  return { aside, moved };
}

/**
 * Opens a tenant file as the service would at its start, with nothing written anywhere: the file is read as the
 * service reads its data, and the plan is built from it as the engine builds it. Says why the service would not
 * start on it, in words, or who the users of the plan are when it would.
 */
export async function openAsPlan(tenant: string, file: string): Promise<{ why: string } | { users: string[] }> {
  let reader: ReturnType<typeof openTenantFile> | undefined;
  try {
    const opened = (reader = openTenantFile(file));
    const snapshot = opened.snapshot();
    if (!snapshot) return { why: "there is no plan in it" };
    const storage: StorageAdapter = {
      load: async () => snapshot,
      commit: async () => {
        throw new Error("This is only a look: nothing is stored.");
      },
      readRevision: async () => snapshot.head.revision,
      readText: async () => null,
      readHistory: async () => [],
      readHistoryPage: async () => ({ records: [], total: 0 }),
      // The timelines are read from the file itself: each is checked against the item it belongs to.
      readTimeline: async (_tenant, kind, id, page) => opened.timeline(kind, id, page),
      close: async () => {},
    };
    const engine = await Engine.open({ storage, tenant });
    // The first thing the service does with its plan: it looks up who there is.
    const users = await readAll<{ username: string }>((operation, input) => engine.execute(operation, "admin", input), "list_users");
    // The next: whether each key in the config is its user's own, by the marks the user carries.
    const odd = users.find((user) => !areKeyMarks(engine.user(user.username)?.key_marks));
    if (odd) return { why: `the user ${odd.username} has key marks that are not a list of marks` };
    // A plan that is damaged in itself would do damage once it is in use: a counter that fell behind the IDs
    // in use gives the next task the ID of one that is there, and writes over it.
    // The history is read by the ID the store writes for an item: an entry stored under another form of it would
    // never be found again.
    const lost = historyOwners(file).find((owner) => storedAs(owner.kind, owner.id) !== owner.id);
    if (lost) return { why: `the history of ${lost.kind} "${lost.id}" is stored under an ID the store would not write` };
    // The items first, then the timeline of each, which is stored beside it: a timeline that does not end with
    // the status its item has would have the next change of status, or of a date, build on what is not there.
    const damage = engine.checkConsistency();
    if (!damage.length) damage.push(...(await engine.checkTimelines()));
    if (damage.length) return { why: `the plan in it is damaged: ${damage.slice(0, 3).join("; ")}${damage.length > 3 ? `; and ${damage.length - 3} more` : ""}` };
    // And a timeline of an item that is not there: a later item that got that ID would have it for the start of
    // its own. A delete for good takes the timeline with it, so one that stayed was put there by something else.
    const there = new Set(snapshot.objects.map((record) => `${record.kind}\u0000${record.id}`));
    const left = timelineOwners(file).find((owner) => !there.has(`${owner.kind}\u0000${owner.id}`));
    if (left) return { why: `it holds the timeline of ${left.kind} "${left.id}", and no such item` };
    return { users: users.map((user) => user.username) };
  } catch (error) {
    return { why: `the service would not start on it (${(error as Error).message})` };
  } finally {
    reader?.close();
  }
}

/** How long a backup, a restore or a recovery waits for another of them to finish before it says that it cannot go on. */
export const FILES_WAIT_MS = 2000;

/**
 * The recovery as the service does it at its start. A recovery moves the files of a tenant, so it takes them
 * first, as a restore does: a backup that has them open is waited for, and is not left with half of what it
 * was copying. With no restore to recover from, nothing of a tenant is moved and nothing is taken.
 */
export function recoverAtStart(dataDir: string): string | null {
  if (!restoreInterrupted(dataDir)) return recoverRestore(dataDir);
  const release = holdTenantFiles(dataDir, FILES_WAIT_MS);
  if (!release) throw new Error(`A restore in ${dataDir} was interrupted, and it cannot be put in order while a backup of the folder is being taken. Start the service again when the backup has finished.`);
  try {
    return recoverRestore(dataDir);
  } finally {
    release();
  }
}

/**
 * Puts a data folder in order after a restore that was killed half-way. To be called by whoever holds the
 * folder, before the data is opened. A restore whose new file is in place is finished; any other is undone,
 * and the data is as it was before it began. Returns what was done, in words, or nothing when no restore was
 * under way.
 */
export function recoverRestore(dataDir: string, forTenant?: string, flush: (folder: string) => void = flushFolder): string | null {
  const file = join(dataDir, NOTE);
  if (!existsSync(file)) {
    // No restore is under way, so whatever one left behind before it got as far as its note is only in the way:
    // a copy of a backup, with what the check of it may have put beside it, and a note that never got its name.
    // A restore clears away only what is in the way of its own tenant; the start of the service, all of it.
    const leftover = forTenant === undefined ? WORKING_NAME : new RegExp(`^${forTenant}\\.sqlite\\.restoring(-journal|-wal|-shm)?$`);
    for (const name of readdirSync(dataDir)) {
      if (leftover.test(name) || name === `${NOTE}.tmp`) rmSync(join(dataDir, name), { force: true });
      // The folder a restore makes for what it sets aside, when the restore died before it put anything there:
      // it holds nothing, and removing a folder fails by itself when it holds something.
      else if (name.startsWith("replaced-")) {
        try {
          rmdirSync(join(dataDir, name));
        } catch {
          // It holds what a restore set aside, or is no folder: it stays.
        }
      }
    }
    return null;
  }
  let note: RestoreNote;
  try {
    note = JSON.parse(readFileSync(file, "utf8")) as RestoreNote;
    assertTenantName(note.tenant);
    // The folder is one a restore makes, inside the data folder, and nothing that leads elsewhere.
    if (typeof note.aside !== "string" || basename(note.aside) !== note.aside || !note.aside.startsWith("replaced-")) throw new Error("not a folder a restore makes");
    const mayHave = [`${note.tenant}.sqlite`, ...BESIDE.map((suffix) => `${note.tenant}.sqlite${suffix}`)];
    if (!Array.isArray(note.had) || !note.had.every((name) => mayHave.includes(name))) throw new Error("not the files of that tenant");
  } catch (error) {
    throw new Error(`${file} says that a restore was interrupted, but cannot be read (${(error as Error).message}). Look at what is in ${dataDir} and its replaced-… folders, put the data file back by hand if it is missing, and remove that file.`);
  }
  const target = join(dataDir, `${note.tenant}.sqlite`);
  const aside = join(dataDir, note.aside);
  const staging = stagingFile(dataDir, note.tenant);
  // Where things stand is read from two facts that no power cut can blur, each the outcome of one rename:
  // - the copy of the backup is beside the data until it is given the data file's name, or until an undoing has
  //   put everything back and clears it away;
  // - the data file that was there is in the folder that took it, or it is in its place.
  // With the copy gone and the old data file still set aside, the data file in place is the backup: the restore
  // had installed it. Everything else is a restore that had not, and is undone.
  const dataFile = `${note.tenant}.sqlite`;
  const installed = !existsSync(staging) && existsSync(target) && (!note.had.includes(dataFile) || existsSync(join(aside, dataFile)));
  // A file that is moved is written down where it now is before it is written down as gone from where it was:
  // the folder it went to is flushed first, then the one it left. A power cut between the two then finds the file
  // in both places or in the new one, and never in neither.
  if (installed) {
    // Nothing may lie beside the backup: it is one whole file, and a log of changes or a journal beside it, of
    // whatever data, would be replayed onto it when it is opened. One that is there, because its move was lost
    // where a folder cannot be flushed or because something put it there, goes to what was set aside. Where a
    // file of that name is set aside already, which of the two is the old data's cannot be told: both are kept,
    // this one under a name of its own, and neither stays beside the backup.
    for (const suffix of BESIDE) {
      const name = dataFile + suffix;
      if (!existsSync(join(dataDir, name))) continue;
      mkdirSync(aside, { recursive: true, mode: 0o700 });
      let to = join(aside, name);
      for (let n = 1; existsSync(to); n++) to = join(aside, `${name}.found-beside-the-backup${n === 1 ? "" : `-${n}`}`);
      renameSync(join(dataDir, name), to);
    }
    if (existsSync(aside)) flush(aside);
    flush(dataDir);
  } else {
    for (const name of putBackOrder(note.had)) if (existsSync(join(aside, name)) && !existsSync(join(dataDir, name))) renameSync(join(aside, name), join(dataDir, name));
    flush(dataDir);
    if (existsSync(aside)) flush(aside);
  }
  const finished = installed;
  // The note is the last to go: until then, a recovery that is itself cut short is taken up again where it was.
  // The copy of the backup goes only once everything is back: it is what tells an undoing from a finished restore.
  for (const suffix of BESIDE_COPY) rmSync(staging + suffix, { force: true });
  // A folder that took nothing, or gave everything back, is not kept.
  if (existsSync(aside) && !readdirSync(aside).length) rmdirSync(aside);
  forgetRestore(dataDir, flush);
  return finished
    ? `A restore of "${note.tenant}" had put the backup in place and was interrupted before it could say so. It is finished${existsSync(aside) ? `; what was there before is in ${aside}` : ""}.`
    : `A restore of "${note.tenant}" was interrupted before the backup was in place. The data is as it was before the restore began; run restore-backup again to restore.`;
}
