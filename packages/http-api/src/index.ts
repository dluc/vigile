import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { VigileError, httpStatus, toErrorBody, toHyphens, toUnderscores, type Engine, type ErrorBody } from "@vigile/core";

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
}

const MAX_BODY = 1024 * 1024;
/** How many clients may listen for changes at once. */
const MAX_STREAMS = 200;
/**
 * How many of them may come from one address. Tabs of one browser share a stream, so a person needs one for
 * each browser; this leaves room for a household of them behind one address, and keeps a single client from
 * taking every place.
 */
const MAX_STREAMS_PER_ADDRESS = 32;
const PING_MS = 20_000;

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
  const local = direct === "::1" || direct.startsWith("127.") || direct.startsWith("::ffff:127.");
  return local && last ? last.slice(0, 64) : direct;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const hasBody = Number(request.headers["content-length"] ?? 0) > 0 || request.headers["transfer-encoding"] !== undefined;
  if (hasBody && !/^application\/json\s*(;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new VigileError("invalid_input", "The request body must be JSON and say so.", { actions: ['Send the header "Content-Type: application/json".'] });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new VigileError("limit_exceeded", "The request body is larger than 1 MB.");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
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

  /**
   * `GET /api/events`: a stream of server-sent events that says when the plan has changed. An event carries the
   * new revision and nothing about what changed; the client reads that through the operations, as itself.
   */
  function stream(request: IncomingMessage, response: ServerResponse): void {
    const address = clientAddress(request);
    const fromHere = streamsFrom.get(address) ?? 0;
    if (streams.size >= MAX_STREAMS || fromHere >= MAX_STREAMS_PER_ADDRESS) {
      const message = fromHere >= MAX_STREAMS_PER_ADDRESS ? `${MAX_STREAMS_PER_ADDRESS} clients at your address are already listening for changes.` : `${MAX_STREAMS} clients are already listening for changes.`;
      throw new VigileError("too_many_requests", message, { actions: ["Close a page that is listening, or ask for changes with list_tasks instead."] });
    }
    streamsFrom.set(address, fromHere + 1);
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
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
        return send(response, 200, { ...options.instance(), you: { username: user.username, type: user.type, keyless: who.keyless } });
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
        return send(response, 200, { ...options.instance(), ...(options.adminStatus?.() ?? {}), engine: engine.status(), listeners: streams.size, inconsistencies: engine.checkConsistency() });
      }
      if (request.method !== "POST") {
        throw new VigileError("not_found", `${request.method} ${url.pathname} is not part of the API.`, {
          actions: ["Operations are called with POST /api/<operation-name>. GET /api/operations lists them."],
        });
      }
      // The body may take its time, and the user may be gone by its end, with the name given to someone else:
      // the operation runs as the user that was let in, or not at all.
      const result = await engine.execute(toUnderscores(path), { username: who.username, id: who.id }, await readJson(request));
      return send(response, 200, result);
    } catch (error) {
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
