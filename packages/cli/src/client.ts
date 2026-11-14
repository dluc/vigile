import { isIP } from "node:net";
import { keyOf, type LoadedConfig } from "@vigile/config";
import { findOperation, toHyphens, type ErrorBody } from "@vigile/core";
import { UsageError } from "./args.js";
import { redirectOf } from "./redirect.js";

/** The service refused a call. Carries the same error body every interface reports. */
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorBody,
    /** Whether the call was made with a key, which the command line takes from the config file. */
    readonly withKey = false,
  ) {
    // The body is whatever answered: only a message that is a text is taken for one.
    super(typeof body?.message === "string" ? body.message : "");
    this.name = "ServiceError";
  }
}

/** Nothing answered at the service's address. */
export class NotRunningError extends Error {
  constructor(readonly base: string) {
    super(`No Vigile service answers at ${base}.`);
    this.name = "NotRunningError";
  }
}

/**
 * The service was reached and its answer did not come: not in time, or the connection ended first. That is not
 * a service that is not there. What was asked of it may have been done all the same, or may be done yet: the
 * service carries out a request it has taken also after the connection has ended.
 */
export class NoAnswerError extends Error {
  /** What the command that made the call says of the open outcome and of how to find out, in place of what holds for any call. */
  advice?: string[];

  constructor(
    readonly base: string,
    what: string,
    /** Whether the call was one that changes the plan: then nobody knows whether the change was stored, or will be. */
    readonly change: boolean,
  ) {
    super(`${what} ${change ? "The change may or may not have been stored, and may still be." : "Nothing was changed: the call only reads."}`);
    this.name = "NoAnswerError";
  }
}

/** How long the service is given to answer a call. */
export const ANSWER_WITHIN_MS = 15_000;

/**
 * Whether a call failed before there was a connection: the name was not found, or nothing took the connection,
 * in the time the system gives for that, which is shorter than the time given for the answer. Then nothing was
 * asked of anyone. Whatever else goes wrong does so once a service has the connection.
 */
function neverConnected(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown; syscall?: unknown; errors?: unknown } } | null)?.cause;
  if (!cause) return false;
  if (cause.syscall === "connect" || cause.syscall === "getaddrinfo" || cause.code === "UND_ERR_CONNECT_TIMEOUT" || cause.code === "ERR_INVALID_URL") return true;
  // A name with several addresses has each of them tried.
  return Array.isArray(cause.errors) && cause.errors.length > 0 && cause.errors.every((one: { syscall?: unknown } | null) => one?.syscall === "connect");
}

/**
 * How a request failed that got no answer: before there was a connection, with an answer that is not HTTP, with
 * no whole answer in the time given, or with the connection ended first. Every request the command line makes
 * is read by this, so that each tells the same story of what is at the address.
 */
export function howItFailed(error: unknown): "never connected" | "not HTTP" | "not in time" | "ended first" {
  if (neverConnected(error)) return "never connected";
  if (String((error as { cause?: { code?: unknown } } | null)?.cause?.code).startsWith("HPE_")) return "not HTTP";
  return (error as Error | null)?.name === "TimeoutError" ? "not in time" : "ended first";
}

/** What is said of a service that was reached and whose answer did not come. One wording, for whatever was asked. */
export const noAnswer = (base: string, how: "not in time" | "ended first", withinMs: number): string =>
  how === "not in time" ? `The service at ${base} did not answer within ${withinMs / 1000} seconds.` : `The connection to the service at ${base} ended before its answer came.`;

/** The address a client on this machine uses to reach a service that listens on `address`. */
export function reachableHost(address: string): string {
  if (address === "0.0.0.0") return "127.0.0.1";
  if (address === "::") return "[::1]";
  return isIP(address) === 6 ? `[${address}]` : address;
}

export const baseUrl = (loaded: LoadedConfig): string => `http://${reachableHost(loaded.config.listen.address)}:${loaded.config.listen.port}`;

/**
 * Talks to the running service over HTTP. The CLI never opens the data files to change them:
 * the graph in memory and the write queue live in the service process.
 */
export class ServiceClient {
  constructor(
    readonly base: string,
    private readonly key: string | undefined,
    readonly username: string,
    /** A parameter so that a test of a service that does not answer need not wait as long as a person would. */
    private readonly answerWithinMs = ANSWER_WITHIN_MS,
  ) {}

  private async request(path: string, body?: unknown, change = false): Promise<any> {
    let response: Response;
    let text: string;
    let onward: string | null;
    try {
      response = await fetch(`${this.base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        // A redirect is not followed: the key and the request are for this address and no other.
        redirect: "manual",
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.answerWithinMs),
      });
      // A redirect is said to be one, and what comes with it is not read: it is not the answer.
      onward = redirectOf(response);
      if (onward) void response.body?.cancel().catch(() => {});
      // The time is for the whole answer: one that stops half-way did not come either.
      text = onward ? "" : await response.text();
    } catch (error) {
      const how = howItFailed(error);
      if (how === "never connected") throw new NotRunningError(this.base);
      // What answers, and not in HTTP, is something else on the port.
      if (how === "not HTTP") throw new ServiceError(0, { code: "internal", message: `${this.base} answered, but not as a Vigile service.` });
      throw new NoAnswerError(this.base, noAnswer(this.base, how, this.answerWithinMs), change);
    }
    if (onward) throw new ServiceError(response.status, { code: "internal", message: `${this.base}${path} answered with ${onward}.` });
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ServiceError(response.status, { code: "internal", message: `${this.base} answered, but not as a Vigile service.` });
    }
    if (!response.ok) throw new ServiceError(response.status, parsed?.error ?? { code: "internal", message: `The service answered ${response.status}.` }, Boolean(this.key));
    return parsed;
  }

  /** Runs an operation by its core name, such as `set_task_status`. */
  call(operation: string, input: Record<string, unknown> = {}): Promise<any> {
    return this.request(`/api/${toHyphens(operation)}`, input, findOperation(operation)?.kind !== "read");
  }

  get(path: string): Promise<any> {
    return this.request(path);
  }
}

/**
 * A client that acts as a user of this instance, using that user's key from the config file.
 * Commands act as admin unless `--as` names someone else. Commands get theirs from `connect` in reach.ts, which
 * first makes sure that what answers is the service of this config: the client sends the key to whatever does.
 */
export function clientFor(loaded: LoadedConfig, as = "admin", answerWithinMs = ANSWER_WITHIN_MS): ServiceClient {
  const { auth } = loaded.config;
  const key = keyOf(auth, as);
  if (!key && auth.keyless_user !== as) {
    throw new UsageError(`The config has no API key for "${as}".`, [
      as === "admin" ? "Run: vigile user reset-key admin" : `Use --as with a user that has a key, or run: vigile user reset-key ${as}`,
    ]);
  }
  return new ServiceClient(baseUrl(loaded), key, as, answerWithinMs);
}
