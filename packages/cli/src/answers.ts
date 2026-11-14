import { ServiceError } from "./client.js";
import { printable } from "./render.js";
import type { Ui } from "./ui.js";

/**
 * What the service answers is read as what it should be only after it was looked at. The command line and the
 * service can be different versions, and what answers can be something else that was taken for the service:
 * an answer of another shape is reported as that, with what was asked, and never as a failure of the command
 * line's own with a line of code in it.
 */

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const areTexts = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
export const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The failure to report when an answer is not the one a Vigile service gives. `asked` is the request, as in "GET /api/admin/status". */
export function notAsVigile(base: string, asked: string, why?: string): ServiceError {
  return new ServiceError(200, {
    code: "internal",
    message: `${base} answered ${asked}, but not as a Vigile service does${why ? `: ${why.slice(0, 200)}` : ""}.`,
    actions: ["The service and this command line may be different versions: stop the service and start it again.", "vigile doctor says what answers at that address."],
  });
}

/**
 * Runs what reads an answer. An answer of another shape makes such code stumble: over a field that is not
 * there, over a text where a list should be, over a nesting too deep to walk. That is reported as the answer's
 * fault, which it is.
 */
export function reading<T>(base: string, asked: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw notAsVigile(base, asked, `it cannot be read (${error.message})`);
    throw error;
  }
}

/** Prints what `show` makes of an answer: all of it, or none when the answer cannot be read, so that no half of a table is left behind. */
export function showing(ui: Ui, base: string, asked: string, show: (ui: Ui) => void): void {
  const lines: string[] = [];
  reading(base, asked, () => show({ ...ui, out: (line = "") => void lines.push(line) }));
  for (const line of lines) ui.out(line);
}

export interface ListedUser extends Record<string, unknown> {
  id: string;
  username: string;
  type: string;
}

/** The users in an answer of `list_users`. */
export function usersOf(base: string, answer: unknown): ListedUser[] {
  const users = isRecord(answer) ? answer.users : undefined;
  const isUser = (user: unknown): user is ListedUser => isRecord(user) && typeof user.id === "string" && typeof user.username === "string" && typeof user.type === "string";
  if (!Array.isArray(users) || !users.every(isUser)) throw notAsVigile(base, "POST /api/list-users", '"users" is not a list of users with an id, a username and a type');
  return users;
}

/** Text that came with an answer, as one line of a report: nothing in it steers the terminal, and it has an end. */
export const oneLine = (text: string, most = 300): string => printable(text).replace(/\s+/g, " ").slice(0, most);

/**
 * Whether the service refused the key it was sent. Only one answer means that: 401, in the service's own words
 * for it. A 403 is not it: the service answers so before it has looked at any key, to a request that names it by
 * a name it does not go by, or that a page of another site sent. Nor is a 401 that is not the service's.
 */
export function keyRefused(error: unknown): boolean {
  return error instanceof ServiceError && error.withKey && error.status === 401 && isRecord(error.body) && error.body.code === "unauthorized";
}

/**
 * A failure as it is reported: the reason in the words of whatever answered, and what it says can be done.
 * Each is taken only if it is text.
 */
export function refusalOf(error: unknown): { reason: string; actions: string[] } {
  const body: Record<string, unknown> = error instanceof ServiceError && isRecord(error.body) ? error.body : {};
  const reason = typeof body.message === "string" && body.message ? body.message : error instanceof Error && error.message ? error.message : "no reason was given";
  const actions = Array.isArray(body.actions) ? body.actions.filter((action): action is string => typeof action === "string" && action !== "") : [];
  return { reason: oneLine(reason), actions: actions.map((action) => oneLine(action)) };
}

/**
 * The failure to report when a change was asked for and the answer is not the one that says it was made. The
 * command does not say so either: it says what was answered and why that is not it, that the outcome is not
 * known, and how to find out.
 */
export function unknownOutcome(base: string, asked: string, answer: unknown, why: string, findOut: string): ServiceError {
  let answered: string;
  try {
    answered = oneLine(JSON.stringify(answer) ?? "nothing", 200);
  } catch {
    answered = "something that cannot be shown";
  }
  return new ServiceError(200, {
    code: "internal",
    message: `${base} answered ${asked}, but not with what says that it was done (${oneLine(why, 200)}): ${answered}. Whether it was done is not known.`,
    actions: [findOut],
  });
}

/** The failure to report when a question was asked and the answer is not the one its operation gives: nothing of it is shown as the result. */
export function notAsOperation(base: string, asked: string, operation: string, why: string): ServiceError {
  return new ServiceError(200, {
    code: "internal",
    message: `${base} answered ${asked}, but not as ${operation} does: ${oneLine(why, 200)}.`,
    actions: ["The service and this command line may be different versions: stop the service and start it again.", "With --json the answer is printed as it came."],
  });
}
