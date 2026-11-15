import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** A process-birth identity that changes when an operating system reuses the numeric PID. */
export function processIdentity(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const afterName = stat.lastIndexOf(") ");
      const fields = afterName >= 0 ? stat.slice(afterName + 2).trim().split(/\s+/) : [];
      // Field 22 is the kernel start tick; `fields` begins with field 3 (state).
      return fields[19] ? `linux:${fields[19]}` : null;
    }
    if (process.platform === "win32") {
      const found = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: "utf8", windowsHide: true });
      const value = found.status === 0 ? found.stdout.trim() : "";
      return /^\d+$/.test(value) ? `win32:${value}` : null;
    }
    const found = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    const value = found.status === 0 ? found.stdout.trim() : "";
    return value ? `${process.platform}:${value}` : null;
  } catch {
    return null;
  }
}

/** Stops one process immediately on the platform's own terms. */
export function stopProcess(pid: number): void {
  if (process.platform !== "win32") {
    process.kill(pid, "SIGKILL");
    return;
  }
  // Node's signal emulation does not reliably terminate an unrelated process on Windows. taskkill is the
  // operating system's noninteractive primitive; the PID is numeric and is passed as an argument, never a shell.
  const stopped = spawnSync("taskkill.exe", ["/PID", String(pid), "/F"], { stdio: "ignore", windowsHide: true });
  if (stopped.error) throw stopped.error;
  if (stopped.status !== 0) throw new Error(`The process ${pid} could not be stopped (taskkill ${stopped.status ?? "did not finish"}).`);
}

/** Whether a process can still run. Linux zombies exist for signals but have already terminated. */
export function processIsAlive(pid: number, probe: typeof process.kill = process.kill, readStat: typeof readFileSync = readFileSync): boolean {
  try {
    probe(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  if (process.platform === "linux") {
    try {
      // The command name is parenthesized and may contain spaces or ')'; the state is the first field after its
      // last closing parenthesis. Z and X cannot execute and need not keep a holder's SQLite lock alive.
      const stat = readStat(`/proc/${pid}/stat`, "utf8");
      const afterName = stat.lastIndexOf(") ");
      if (afterName >= 0 && new Set(["Z", "X"]).has(stat[afterName + 2]!)) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Procfs may be unavailable in a chroot. Distinguish that from an exit between the two observations by
        // probing once more; only ESRCH confirms absence.
        try {
          probe(pid, 0);
        } catch (again) {
          return (again as NodeJS.ErrnoException).code !== "ESRCH";
        }
      }
      // Permission, unavailable procfs and unknown failures are conservatively alive.
    }
  }
  return true;
}

/** Attempts one stop and confirms the process is gone; false keeps every protected resource held for a retry. */
export function stopAndConfirm(pid: number, stop: (pid: number) => void = stopProcess, alive: (pid: number) => boolean = processIsAlive, expectedIdentity?: string, identify: (pid: number) => string | null = processIdentity): boolean {
  if (expectedIdentity !== undefined) {
    if (!alive(pid)) return true;
    // Unknown identity is not permission to signal. A changed identity means the observed process is already
    // gone and this numeric PID now belongs to somebody else.
    const current = identify(pid);
    if (current === null) return false;
    if (current !== expectedIdentity) return true;
  }
  try {
    stop(pid);
  } catch {}
  if (!alive(pid)) return true;
  if (expectedIdentity === undefined) return false;
  const remaining = identify(pid);
  return remaining !== null && remaining !== expectedIdentity;
}

/** Stops the holder only after the owner is confirmed gone. Each false result is safe to call again. */
export function stopOwnerThenHolder(owner: number, holder: number, stop: (pid: number) => void = stopProcess, alive: (pid: number) => boolean = processIsAlive, identities?: { owner: string; holder: string }, identify: (pid: number) => string | null = processIdentity): boolean {
  return stopAndConfirm(owner, stop, alive, identities?.owner, identify) && stopAndConfirm(holder, stop, alive, identities?.holder, identify);
}
