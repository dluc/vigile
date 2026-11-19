import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { VigileError, echo, httpStatus, readBody, toErrorBody, toHyphens, toUnderscores, type Engine, type ErrorBody } from "@vigile/core";

export interface ApiOptions {
  engine: Engine;
  /** The user a request acts as. Throws a `VigileError` when the request may not connect. */
  /** Who the request is let in as: the name, the ID of the user that has it now, and whether no key was needed. */
  caller(request: IncomingMessage): { username: string; id: string; keyless: boolean };
  /** Facts about the running instance, for `/health`, the web page and the doctor. */
  instance(): Record<string, unknown>;
  /** Runtime details for the doctor. Admins only. */
  adminStatus?(): Record<string, unknown>;
  /**
   * Told of what went wrong in here that was nobody's mistake: finding out who calls, opening the stream of
   * changes, working out the status. What goes wrong inside an operation is the engine's to report.
   */
  onUnexpected?(error: unknown): void;
  /**
   * Whether a request was sent from the service's own machine over an address that is not always a machine's
   * own, which only the service knows. Without it, only what comes from a loopback address is taken to be.
   */
  fromThisMachine?(request: IncomingMessage): boolean;
  /**
   * Told that a stream of changes begins as the answer to a request, before anything of it is sent. Answers
   * on a connection go out in the order of their requests, so nothing behind a stream can be answered while
   * it goes on: what that means for the connection is the host's to say.
   */
  onStream?(request: IncomingMessage, response: ServerResponse): void;
}

/** How large the body of a request may be, in bytes. */
export const MAX_BODY = 1024 * 1024;
/** How many clients may listen for changes at once. */
const MAX_STREAMS = 200;
/**
 * How many of them may come from one address. Tabs of one browser share a stream, so a person needs one for
 * each browser; this leaves room for a household of them behind one address, and keeps a single client from
 * taking every place.
 */
const MAX_STREAMS_PER_ADDRESS = 32;
/**
 * How many of them may connect from this machine, whomever they say they speak for. A proxy on this machine is
 * believed about the address of its client, and so is any other program on it: one that named a new address
 * each time would take every place. What is left is for clients that connect from elsewhere themselves.
 */
const MAX_STREAMS_FROM_HERE = MAX_STREAMS - MAX_STREAMS_PER_ADDRESS;
/** How often a client that listens is sent a line that says nothing, so that its connection is not taken for idle. */
export const PING_MS = 20_000;

export type ApiHandler = ((request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void>) & {
  /** Ends every open stream of changes, so the server can stop. */
  close(): void;
  /** How many clients are listening for changes. */
  streams(): number;
};

/**
 * The input of an operation is JSON and says so. A browser sends a body of any other type to another site
 * without asking first, so a body that does not say it is JSON is not read at all.
 */
/**
 * Where a request comes from. A proxy on the same machine connects from the machine itself and says in a header
 * whom it speaks for; it is believed, since whoever can connect from this machine is trusted already. Without
 * that, everyone behind the proxy would count as one address. Of the addresses in the header only the last
 * counts: that is the one the proxy itself saw and added. Whatever stands before it came with the request and
 * can be anything the client cared to write.
 */
function clientAddress(request: IncomingMessage): string {
  const direct = request.socket?.remoteAddress ?? "";
  const forwarded = request.headers?.["x-forwarded-for"];
  const last = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded)?.split(",").at(-1)?.trim();
  return fromLoopback(request) && last ? last.slice(0, 64) : direct;
}

/** Whether the request was sent from this machine to itself: by a program on it, or by a proxy on it for someone else. */
function fromLoopback(request: IncomingMessage): boolean {
  const direct = request.socket?.remoteAddress ?? "";
  return direct === "::1" || direct.startsWith("127.") || direct.startsWith("::ffff:127.");
}

/**
 * Why the body of a request is not read, when it is not, from what the request says of it before any of it has
 * come: it does not say it is JSON, or it says it is larger than is taken.
 */
export function bodyRefused(request: IncomingMessage): VigileError | null {
  const length = Number(request.headers["content-length"] ?? 0);
  const hasBody = length > 0 || request.headers["transfer-encoding"] !== undefined;
  if (hasBody && !/^application\/json\s*(;|$)/i.test(request.headers["content-type"] ?? "")) {
    return new VigileError("invalid_input", "The request body must be JSON and say so.", { actions: ['Send the header "Content-Type: application/json".'] });
  }
  return length > MAX_BODY ? new VigileError("limit_exceeded", "The request body is larger than 1 MB.") : null;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const refused = bodyRefused(request);
  if (refused) throw refused;
  // A body that grew past what is taken without having said so is refused like one that said so: with an
  // answer, which the request is still there to get.
  const body = await readBody(request, MAX_BODY);
  if (body === null) throw new VigileError("limit_exceeded", "The request body is larger than 1 MB.");
  const text = body.trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new VigileError("invalid_input", "The request body is not valid JSON.");
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(text);
}

export function sendError(response: ServerResponse, error: unknown): ErrorBody {
  const body = toErrorBody(error);
  send(response, httpStatus(body.code), { error: body });
  return body;
}

/**
 * The JSON API: one `POST /api/<operation>` per operation, with the same input and output as the MCP tool
 * of the same name. Names use hyphens here, as web addresses usually do.
 */
export function createApiHandler(options: ApiOptions): ApiHandler {
  const { engine } = options;
  const streams = new Set<() => void>();
  const streamsFrom = new Map<string, number>();
  let streamsFromHere = 0;

  /**
   * `GET /api/events`: a stream of server-sent events that says when the plan has changed. An event carries the
   * new revision and nothing about what changed; the client reads that through the operations, as itself.
   */
  function stream(request: IncomingMessage, response: ServerResponse): void {
    const address = clientAddress(request);
    // From this machine by whichever of its addresses: otherwise a program on it would have the places of the
    // machine over one address and those of an address beyond it over another.
    const here = fromLoopback(request) || (options.fromThisMachine?.(request) ?? false);
    const atAddress = streamsFrom.get(address) ?? 0;
    const full =
      atAddress >= MAX_STREAMS_PER_ADDRESS
        ? `${MAX_STREAMS_PER_ADDRESS} clients at your address are already listening for changes.`
        : streams.size >= MAX_STREAMS
          ? `${MAX_STREAMS} clients are already listening for changes.`
          : here && streamsFromHere >= MAX_STREAMS_FROM_HERE
            ? `${MAX_STREAMS_FROM_HERE} clients that connect from the service's own machine are already listening for changes.`
            : null;
    if (full) throw new VigileError("too_many_requests", full, { actions: ["Close a page that is listening, or ask for changes with list_tasks instead."] });
    streamsFrom.set(address, atAddress + 1);
    if (here) streamsFromHere++;
    // Whether the connection is kept after the stream is the host's to say, which is told that one begins.
    options.onStream?.(request, response);
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
    let ping: NodeJS.Timeout | undefined;
    let unsubscribe = (): void => {};
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      clearInterval(ping);
      unsubscribe();
      streams.delete(end);
      const left = (streamsFrom.get(address) ?? 1) - 1;
      if (left > 0) streamsFrom.set(address, left);
      else streamsFrom.delete(address);
      if (here) streamsFromHere--;
      response.end();
    };
    /**
     * Sends a few bytes. A client that has stopped reading would make the service keep everything it is sent,
     * without end: when what was written before has not gone out yet, the client is let go, and what was kept
     * for it is dropped. It can connect again, and learns the revision when it does.
     */
    const write = (text: string): void => {
      if (ended) return;
      // Who may listen is asked again each time, not only when the stream opens: a key that was reset, a user
      // that was deleted or a service that now wants a key from everyone ends the stream at its next message.
      if (!allowed()) return end();
      if (response.write(text)) return;
      end();
      response.destroy();
    };
    const allowed = (): boolean => {
      try {
        return engine.user(options.caller(request).username) !== undefined;
      } catch {
        return false;
      }
    };
    const say = (event: string, revision: number): void => write(`event: ${event}\ndata: ${JSON.stringify({ revision })}\n\n`);
    streams.add(end);
    request.on("close", end);
    say("hello", engine.currentRevision);
    if (ended) return;
    unsubscribe = engine.subscribe((revision) => say("change", revision));
    // A comment line now and then keeps the connection from being closed as idle by anything in between.
    ping = setInterval(() => write(": ping\n\n"), PING_MS);
    ping.unref();
  }

  const handle = async function handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    try {
      if (url.pathname === "/health") {
        return send(response, 200, { status: "ok", ...options.instance() });
      }
      const path = url.pathname.replace(/^\/api\//, "");
      const who = options.caller(request);
      const user = engine.user(who.username)!;

      if (request.method === "GET" && path === "instance") {
        return send(response, 200, { ...options.instance(), features: engine.features.enabled, you: { username: user.username, type: user.type, keyless: who.keyless } });
      }
      if (request.method === "GET" && path === "operations") {
        const operations = engine.operationsFor(user.type).map((o) => ({
          name: o.name,
          path: `/api/${toHyphens(o.name)}`,
          kind: o.kind,
          access: o.access,
          description: o.description,
          input: z.toJSONSchema(o.input),
        }));
        return send(response, 200, { operations });
      }
      if (request.method === "GET" && path === "events") {
        return stream(request, response);
      }
      if (request.method === "GET" && path === "admin/status") {
        if (user.type !== "admin") throw new VigileError("forbidden", "Only an admin can read the service status.");
        let timelineInconsistencies: string[] | undefined;
        if (url.searchParams.get("check_timelines") === "true") {
          const controller = new AbortController();
          const cancelIfDisconnected = () => { if (!response.writableEnded) controller.abort(); };
          if (response.destroyed) controller.abort();
          else response.once("close", cancelIfDisconnected);
          try {
            timelineInconsistencies = await engine.checkTimelines(3, controller.signal);
          } finally {
            response.off("close", cancelIfDisconnected);
          }
        }
        return send(response, 200, {
          ...options.instance(),
          ...(options.adminStatus?.() ?? {}),
          engine: engine.status(),
          listeners: streams.size,
          inconsistencies: engine.checkConsistency(),
          ...(timelineInconsistencies === undefined ? {} : { timeline_inconsistencies: timelineInconsistencies }),
        });
      }
      if (request.method !== "POST") {
        throw new VigileError("not_found", `${echo(request.method ?? "")} ${echo(url.pathname)} is not part of the API.`, {
          actions: ["Operations are called with POST /api/<operation-name>. GET /api/operations lists them."],
        });
      }
      // The body may take its time, and the user may be gone by its end, with the name given to someone else:
      // the operation runs as the user that was let in, or not at all.
      const result = await engine.execute(toUnderscores(path), { username: who.username, id: who.id }, await readJson(request));
      return send(response, 200, result);
    } catch (error) {
      // A caller that left during an opt-in paged diagnostic is no longer waiting for an error response.
      if (response.destroyed) return;
      // A refusal is an answer. Anything else is the service's own trouble: the caller is told that there was
      // some, and whoever runs the service is told what. That it could not be told keeps no answer back.
      if (!(error instanceof VigileError)) {
        try {
          options.onUnexpected?.(error);
        } catch {
          // Not said.
        }
      }
      sendError(response, error);
    }
  };
  return Object.assign(handle, {
    close: () => {
      for (const end of [...streams]) end();
    },
    streams: () => streams.size,
  });
}
