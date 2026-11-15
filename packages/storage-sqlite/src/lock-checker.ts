import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** Inspects record locks outside the service process, so closing the diagnostic descriptor cannot release them. */
const busy = (error: unknown): boolean => (error as { errcode?: number }).errcode === 5 || /database is locked/.test((error as Error).message);

function held(file: string): boolean {
  if (!existsSync(file)) return false;
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 0");
    database.prepare("SELECT count(*) FROM sqlite_master").get();
    return false;
  } catch (error) {
    if (busy(error)) return true;
    throw error;
  } finally {
    database.close();
  }
}

try {
  console.log(JSON.stringify({ held: process.argv.slice(2).some(held) }));
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
