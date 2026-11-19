/** Every code an error can carry, in the order the documentation lists them. */
export const ERROR_CODES = ["invalid_input", "not_found", "unauthorized", "forbidden", "version_conflict", "rule_violation", "limit_exceeded", "too_many_requests", "internal"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** An item named in an error, so the client can act on it without another call. */
export interface ErrorItem {
  kind: string;
  id: string;
  title?: string;
  status?: string;
}

export interface ErrorDetails {
  /** The specific rule that refused the change, such as `unfinished_dependencies`. */
  rule?: string;
  /** What is in the way: the first few, when there are many. */
  blocking?: ErrorItem[];
  /** How many are in the way in all. Only when `blocking` does not name every one of them. */
  blocking_total?: number;
  /** Things the client can do about it. Not exhaustive. */
  actions?: string[];
  /** The item as it is now, when the client's copy was stale. */
  current?: unknown;
}

/**
 * What an error may carry beyond its code and its message, each in the words the documentation uses for it.
 * Every field of `ErrorDetails` is here. A refusal of an operation names actions; the other fields are there
 * only when there is something to say, and an error that is no refusal may carry none of them.
 */
export const ERROR_DETAIL_WORDS = {
  rule: "the rule that refused the change",
  blocking: "the items in the way",
  blocking_total: "how many items are in the way",
  actions: "actions you can take",
  current: "the item as it is now",
} as const satisfies Record<keyof ErrorDetails, string>;

/** What every error has. */
export const ERROR_ALWAYS = ["code", "message"] as const satisfies ReadonlyArray<keyof ErrorBody>;

export interface ErrorBody extends ErrorDetails {
  code: ErrorCode;
  message: string;
}

/** The one error shape every interface reports. */
export class VigileError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = "VigileError";
    this.code = code;
    this.details = details;
  }

  toJSON(): ErrorBody {
    return { code: this.code, message: this.message, ...this.details };
  }
}

/** How much of a value a caller sent is repeated in a message. */
const ECHOED = 80;

/**
 * What a caller sent, as a message repeats it: whole when it is short, and otherwise its start and how long it
 * was. A message says what is wrong with a value; it does not hand a value of any length back.
 */
export function echo(value: string, most = ECHOED): string {
  if (value.length <= most) return value;
  // Cut between two characters, never through the middle of one that takes two code units.
  return `${value.slice(0, most).replace(/[\uD800-\uDBFF]$/, "")}… (${value.length} characters)`;
}

export const invalidInput = (message: string, actions: string[] = ["Correct the input described in the message, then send the request again."]) => new VigileError("invalid_input", message, { actions });

export const notFound = (message: string, actions?: string[]) => new VigileError("not_found", message, { actions });

export const forbidden = (message: string, actions?: string[]) => new VigileError("forbidden", message, { actions });

export const refused = (rule: string, message: string, details: Omit<ErrorDetails, "rule"> = {}) =>
  new VigileError("rule_violation", message, { rule, ...details });

/**
 * A change is stored, and a step that comes after it, at the store of the API keys, failed. The caller is told
 * what stands and what does not: "not confirmed" would be untrue, and a second try would be refused.
 */
export const afterStored = (message: string, actions: string[], cause: unknown) => Object.assign(new VigileError("internal", message, { actions }), { cause });

export function toErrorBody(error: unknown): ErrorBody {
  if (error instanceof VigileError) return error.toJSON();
  return { code: "internal", message: "The service hit an unexpected error. The change was not confirmed." };
}

const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  version_conflict: 409,
  rule_violation: 409,
  limit_exceeded: 413,
  too_many_requests: 429,
  internal: 500,
};

export const httpStatus = (code: ErrorCode): number => HTTP_STATUS[code];
