import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Whether two paths are the same file or folder. Two names can lead to one place, through a link or through
 * `..`, so the names are not compared: what the system says each of them is, is. A path that does not exist
 * is the same as nothing.
 */
export function samePlace(a: string, b: string): boolean {
  try {
    const first = statSync(a);
    const second = statSync(b);
    return first.dev === second.dev && first.ino === second.ino;
  } catch {
    return false;
  }
}

/** A path with every link in it followed, or the path as it is written when there is nothing there yet. */
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
