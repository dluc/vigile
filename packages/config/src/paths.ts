import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute, join, parse, sep } from "node:path";

/** More links than any real path has: beyond this a path goes round in a circle. */
const MOST_LINKS = 64;

/**
 * Where a path leads: the one name of the place, or that the path leads nowhere, with the path in full as it
 * was written and why. A path that leads nowhere is never made into another path that does: no name is
 * given for it that anyone could open, make or write to.
 */
export type Place = { ok: true; place: string } | { ok: false; written: string; cause: string };

/** A path that leads nowhere, for whoever needs its place to read or write there. */
export class NoPlace extends Error {
  constructor(
    readonly written: string,
    readonly why: string,
  ) {
    super(`${written} leads nowhere: ${why}`);
    this.name = "NoPlace";
  }
}

/**
 * The names of a path, between its separators, as they are written. Separators that stand together are one.
 * One at the end is kept, as an empty name: it says that what stands before it has to be a folder, which is
 * not the same as a dot after it, since a folder can be named without being gone through.
 */
function namesOf(path: string): string[] {
  const names = process.platform === "win32" ? path.split(/[\\/]/) : path.split(sep);
  return names.filter((name, i) => name !== "" || (i === names.length - 1 && names.length > 1));
}

/**
 * Where a path leads, whether or not there is anything there yet. Two paths lead to the same place exactly
 * when they have the same name of this kind, so this is what is compared wherever it matters that two
 * folders, or two files, are not one: the data and the backups, a backup and the data it would replace.
 *
 * For everything that is there, the system itself is asked, one name of the path at a time, from the root:
 * what it makes of a link, of `.` and `..`, of a file where a folder has to be, of a separator at the end of
 * the path or of what a link says, of a folder this account may not go through, of links in a circle, is
 * what counts, and nothing here decides it a second time. `..` therefore steps out of the folder a link
 * leads to, not the one the link lies in; `file/` leads nowhere, as it does for the system.
 *
 * What the system cannot answer for is what is not there yet, and that is all this adds: a name that is not
 * there is taken as it is written, with the names after it; `.` after it changes nothing, and `..` takes the
 * last such name away again, as when the folders were made in that order. A link whose end is not there is
 * followed to where it leads, since that is where the system would make what is made through it.
 *
 * A path the system would not walk leads nowhere, and that is the answer, with the reason. It is not walked
 * some other way instead: struck out as written, `loop/../backups` would be `backups`, a folder the path
 * does not lead to.
 */
export function whereTo(path: string): Place {
  // In full, and otherwise as it is written: nothing is struck out of it.
  const written = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  const nowhere = (cause: string): Place => ({ ok: false, written, cause });
  if (path === "") return nowhere("it is empty");
  if (path.includes("\0")) return nowhere("it has a character that no path can have");
  /** The error of the system in words. */
  const said = (at: string, error: unknown): string => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTDIR") return `${at}: something on the way is not a folder, and the path goes on through it`;
    if (code === "EACCES" || code === "EPERM") return `${at}: this account may not go through a folder on the way`;
    if (code === "ELOOP") return `${at}: its links go round in a circle`;
    if (code === "ENAMETOOLONG") return `${at}: a name is too long`;
    return `${at}: the system says ${code ?? (error as Error).message}`;
  };

  // Ask the kernel about the original spelling before realpath or the component walk can shorten dots and
  // separators. A spelling the system itself refuses as too long must never become another usable path here.
  try {
    lstatSync(written);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENAMETOOLONG") return nowhere(said(written, error));
  }

  // Remember when one whole system walk exceeds its symlink limit. The component walk below still supplies the
  // precise error for ordinary circles, permissions and non-folders; only a path it would otherwise accept is
  // refused by this whole-path result.
  let wholeLoop: unknown = null;
  try {
    realpathSync.native(written);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENAMETOOLONG") return nowhere(said(written, error));
    if ((error as NodeJS.ErrnoException).code === "ELOOP") wholeLoop = error;
  }

  const { root } = parse(written);
  /** What is there so far, as the system names it; then the names that are not there yet, as written. */
  let there = root;
  const notYet: string[] = [];
  let links = 0;
  const names = namesOf(written.slice(root.length));
  while (names.length) {
    const name = names.shift()!;
    if (notYet.length) {
      // Among what is not there yet, nothing can be asked of the system.
      if (name === "..") notYet.pop();
      else if (name !== "." && name !== "") notYet.push(name);
      continue;
    }
    // A separator after what is there: the system says whether that is a folder.
    const next = `${there}${there.endsWith(sep) ? "" : sep}${name}`;
    try {
      // To stay in a folder, or to step out of it, the system has to be let through it. Asked of the system
      // as such: what names a path in full takes `..` off the name before it without asking.
      if (name === "." || name === "..") statSync(`${there}${there.endsWith(sep) ? "" : sep}.`);
      there = realpathSync.native(next);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return nowhere(said(next, error));
    }
    // Not there. Either the name itself is not, or it is a link whose end is not.
    let leads: string | null = null;
    try {
      leads = readlinkSync(next);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EINVAL") return nowhere(said(next, error));
    }
    if (leads === null) {
      notYet.push(name);
      continue;
    }
    if (++links > MOST_LINKS) return nowhere(`${next}: its links go round in a circle`);
    // What the link says, in place of the link, before the names that come after it.
    const target = parse(leads);
    if (target.root) there = target.root;
    names.unshift(...namesOf(leads.slice(target.root.length)));
  }
  if (wholeLoop) return nowhere(said(written, wholeLoop));
  return { ok: true, place: notYet.length ? join(there, ...notYet) : there };
}

/**
 * The one name of the place a path leads to, for whoever is about to read or write there. A path that leads
 * nowhere fails here, with the path and the reason (`NoPlace`): there is no name to go on with.
 */
export function placeOf(path: string): string {
  const led = whereTo(path);
  if (!led.ok) throw new NoPlace(led.written, led.cause);
  return led.place;
}

/**
 * Whether two paths are the same file or folder. Two names can lead to one place, through a link, through
 * `..`, or through a link in a folder above something that is not there yet, so the names as they are written
 * are not compared: the places they lead to are (`whereTo`). Two names that the system says are one file,
 * though no link leads from one to the other, are the same place as well. A path that leads nowhere is the
 * same place as nothing, itself included.
 */
export function samePlace(a: string, b: string): boolean {
  const [first, second] = [whereTo(a), whereTo(b)];
  if (!first.ok || !second.ok) return false;
  if (first.place === second.place) return true;
  try {
    const one = statSync(first.place);
    const other = statSync(second.place);
    return one.dev === other.dev && one.ino === other.ino;
  } catch {
    return false;
  }
}

/** Whether there is anything under a name, a link that leads nowhere included. */
export const somethingAt = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/** What something in a folder is, in a word, for whoever has to say why it is not what belongs there. */
export function kindOf(stats: Stats): "file" | "folder" | "link" | "pipe" | "socket" | "device" | "thing" {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "folder";
  if (stats.isSymbolicLink()) return "link";
  if (stats.isFIFO()) return "pipe";
  if (stats.isSocket()) return "socket";
  if (stats.isCharacterDevice() || stats.isBlockDevice()) return "device";
  return "thing";
}

/** What stands under a name, the name itself and not what a link under it leads to: nothing, or its kind. */
export function kindAt(path: string): ReturnType<typeof kindOf> | null {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  return stats ? kindOf(stats) : null;
}

/** Something stands under a name that is not the plain file that belongs there. */
export class NotAFile extends Error {
  constructor(
    readonly path: string,
    readonly kind: string,
  ) {
    super(`${path} is not a file: it is a ${kind}`);
    this.name = "NotAFile";
  }
}

// Where the system has them: not to wait for whoever is at the other end of a pipe, and not to go where a link leads.
const NO_WAIT = constants.O_NONBLOCK ?? 0;
const NO_LINK = constants.O_NOFOLLOW ?? 0;

/**
 * Opens a plain file to read it, and nothing else. A pipe, a socket, a device, a folder or a link under the
 * name is refused with what it is (`NotAFile`), without waiting for anyone and without touching what a link
 * leads to: opened in the usual way, a pipe that nobody writes to is waited for without end. What is opened
 * is looked at once it is open, so that it is the thing that was opened that is judged. The caller closes it.
 */
export function openPlainFile(path: string): number {
  const before = lstatSync(path, { throwIfNoEntry: false });
  if (before && !before.isFile()) throw new NotAFile(path, kindOf(before));
  let handle: number;
  try {
    handle = openSync(path, constants.O_RDONLY | NO_WAIT | NO_LINK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // What the system answers for a link when told not to follow one, and for a socket.
    if (code === "ELOOP" || code === "EMLINK" || code === "ENXIO" || code === "EOPNOTSUPP") {
      const kind = kindAt(path);
      if (kind && kind !== "file") throw new NotAFile(path, kind);
    }
    throw error;
  }
  try {
    const stats = fstatSync(handle);
    if (!stats.isFile()) throw new NotAFile(path, kindOf(stats));
    // O_NOFOLLOW is unavailable on Windows. Checking the name again also closes the replacement race on every
    // platform: what stands under it must be the plain file that was opened, not a link to that file.
    const named = lstatSync(path, { throwIfNoEntry: false });
    if (!named?.isFile() || named.dev !== stats.dev || named.ino !== stats.ino) throw new NotAFile(path, named ? kindOf(named) : "missing file");
    return handle;
  } catch (error) {
    closeSync(handle);
    throw error;
  }
}

/**
 * Creates a plain file to write it, under a name that nothing has: the system refuses when there is anything
 * there, a link included, so nothing is written to what someone else put under the name or to where a link
 * leads. Readable by its owner only. The caller closes it.
 */
export function createPlainFile(path: string): number {
  return openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_LINK, 0o600);
}
