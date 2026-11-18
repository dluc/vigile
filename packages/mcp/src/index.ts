import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isJsonContentType } from "@modelcontextprotocol/sdk/shared/mediaType.js";
import { ErrorCode, ListToolsRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AGENT_INSTRUCTIONS, GUIDE_TOPICS, VERSION, VigileError, guide, httpStatus, readBody, toErrorBody, type Engine, type Operation } from "@vigile/core";

/**
 * What one request may cost the service. The library that speaks the protocol takes more than the service has
 * a use for, and answers a message it refuses with all that is wrong with it: without these, a small request
 * could be answered with a hundred times its size, or not at all.
 */
export const MCP_LIMITS = {
  /** How large the body of a request may be: what the API takes. */
  bodyBytes: 1024 * 1024,
  /**
   * How many members and elements a message may have, all its objects and lists together. A call of a tool
   * has some dozens. Each one costs the library work, and each one that is wrong a line in its answer.
   */
  parts: 1000,
  /** How long the message of an error may be that the protocol answers with. */
  errorChars: 1000,
  /** How large an answer may be. A full page of any list is a fraction of it. */
  answerBytes: 4 * 1024 * 1024,
  /**
   * How long an answer may take to be made, from the moment the request is here. Nothing else ends the wait for
   * one that never comes. It ends the wait and not the work: what a request has begun is carried out. How long
   * an answer may then take to reach its caller is what the service says of every connection.
   */
  answerMs: 30_000,
};

/** What is said in the place of an answer that is larger than an answer may be. The request was carried out. */
const tooLarge = (most: number): string =>
  `The answer is larger than ${most / (1024 * 1024)} MB and was not sent. A change that the request made is stored: read the item before sending the request again.`;

export interface McpOptions {
  engine: Engine;
  /** The user a request acts as. Throws a `VigileError` when the request may not connect. */
  /** Who the request is let in as: the name, and the ID of the user that has it now. */
  caller(request: IncomingMessage): { username: string; id?: string };
  /** Told what went wrong when a request fails in a way nobody planned for, for the service's log. */
  onUnexpected?(error: unknown): void;
  /** Other limits than the usual ones, for tests that cannot wait half a minute. */
  limits?: Partial<typeof MCP_LIMITS>;
}

/** What a connecting agent is told about how to use the service. */
export const INSTRUCTIONS = AGENT_INSTRUCTIONS;

/** Ready-made requests a client can offer its user. Each one sends the agent to the guide and then to work. */
const PROMPTS = [
  {
    name: "plan_work",
    title: "Plan a piece of work",
    description: "Turn a goal into a plan in Vigile: groups where they help, steps, what depends on what, and a reason for each.",
    argument: { name: "goal", description: "What should exist when the work is done." },
    topic: "organising",
    text: (goal: string) =>
      `Plan this work in Vigile: ${goal}\n\nFirst look at what is already there with list_projects and list_tasks with top_level, so nothing is planned twice. Then create the plan. Choose the shape that fits the work, using the guide below: a few independent tasks need no group; work with several steps reads better as a group with its steps inside; large work can nest groups. Give every task a title that says the outcome, a description that says how to tell it is finished, and a reason (why) when you know one. Record what must finish before what with depends_on. When you are done, show the plan from the top with list_tasks and top_level.`,
  },
  {
    name: "pick_up_work",
    title: "Pick up the next task",
    description: "Find what can start now, choose one task, and work on it, keeping its status true.",
    argument: { name: "area", description: "Optional: the ID of a project or a group to stay inside." },
    topic: "working",
    text: (area: string) =>
      `Pick up work from Vigile${area ? ` inside ${area}` : ""}. Follow the routine in the guide below: list what can start now, read the task you choose in full, set it to in_progress only when you really start, and to done only when the work is shown to work. If you find something broken on the way, record it as a bug, issue or incident.`,
  },
  {
    name: "report_problem",
    title: "Report a bug, an issue or an incident",
    description: "Record something that is broken or unclear so that it stands out from planned work.",
    argument: { name: "problem", description: "What is wrong, where it was seen, and what was expected." },
    topic: "organising",
    text: (problem: string) =>
      `Record this in Vigile: ${problem}\n\nChoose the type: bug for something that should work and does not, issue for a problem or an open question, incident for something failing right now. Look for the group or project it affects with list_tasks and top_level, and create the task inside it with parent or project. The title says what is wrong; the description says where it was seen, what was expected, and how to tell it is fixed; why says who is affected.`,
  },
] as const;

const PROMPT_SCOPE = "Use Vigile to record the requested work. The request and higher-priority instructions decide the goal and scope; the guide below only explains Vigile's operations.";

/** A tool as the list of tools shows it: the operation, with its input described the way the API describes it. */
function describeTool(operation: Operation) {
  return {
    name: operation.name,
    description: operation.description,
    inputSchema: z.toJSONSchema(operation.input, { target: "draft-7", io: "input" }) as { type: "object"; [key: string]: unknown },
    annotations: {
      readOnlyHint: operation.kind === "read",
      destructiveHint: operation.name === "delete",
      idempotentHint: operation.kind === "read",
      openWorldHint: false,
    },
    execution: { taskSupport: "forbidden" as const },
  };
}

/**
 * Each tool is described once, however often the list is asked for: working out the schema of an input is the
 * most a request for the list costs, and it is the same every time.
 */
const described = new WeakMap<Operation, ReturnType<typeof describeTool>>();
function toolOf(operation: Operation): ReturnType<typeof describeTool> {
  let tool = described.get(operation);
  if (!tool) described.set(operation, (tool = describeTool(operation)));
  return tool;
}

/** A refusal of a request that is not one the protocol knows, said the way the protocol says it. */
const protocolError = (code: ErrorCode, message: string): Error => Object.assign(new Error(message), { code });

/**
 * A server that offers one tool per operation the user's type may call. With `letInAs`, the ID of the user the
 * request was let in as, a tool runs only as that user: not as someone else who has the name by then.
 */
export function createMcpServer(engine: Engine, username: string, letInAs?: string, answerBytes = MCP_LIMITS.answerBytes): McpServer {
  // The user the request was let in as. Someone else who has the name by now is not that user: the request
  // is not shown what is theirs.
  const named = engine.user(username);
  const user = named && (letInAs === undefined || named.id === letInAs) ? named : undefined;
  const server = new McpServer({ name: "vigile", version: VERSION }, { instructions: INSTRUCTIONS });

  // The tools are not registered with the library's own list of tools. That list checks what a call sends before
  // the call gets anywhere, and answers in words of its own: input of the wrong type never reached the engine,
  // which is where every interface has its input checked, refused in the one shape of an error, and written to
  // the log of operations. Here the list of tools describes each input, and a call goes to the engine as it came.
  server.server.registerCapabilities({ tools: { listChanged: true } });
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: user ? engine.operationsFor(user.type).map(toolOf) : [] }));
  // A call is taken here, as the request it came as, for the same reason: a handler registered for tools/call
  // has the library refuse arguments that are not an object before the handler is asked. This is the handler
  // for every method that has none, so any other method is answered as the library answers one it does not know.
  server.server.fallbackRequestHandler = async (request) => {
    if (request.method !== "tools/call") throw protocolError(ErrorCode.MethodNotFound, "Method not found");
    const { name, arguments: input } = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof name !== "string") throw protocolError(ErrorCode.InvalidParams, "A tools/call request names the tool to call, as text, in params.name.");
    let text: string;
    try {
      text = JSON.stringify(await engine.execute(name, letInAs === undefined ? username : { username, id: letInAs }, input));
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: toErrorBody(error) }) }] };
    }
    // Said here, before the result is written out a second and a third time on its way to the caller.
    if (Buffer.byteLength(text) > answerBytes) throw protocolError(ErrorCode.InternalError, tooLarge(answerBytes));
    return { content: [{ type: "text" as const, text }] };
  };

  // A user that is gone by now, deleted while the request was on its way, has no tools and no guide, whether
  // or not the name has passed to someone else. A call still goes to the engine, which refuses it as it
  // refuses any call of someone it does not know, with its line in the log.
  if (!user) return server;

  // The guide, for clients that read resources or offer prompts instead of calling tools.
  for (const topic of GUIDE_TOPICS) {
    const part = guide(topic);
    const uri = `vigile://guide/${topic}`;
    server.registerResource(`guide-${topic}`, uri, { title: `Vigile guide: ${part.title}`, description: part.topics.find((t) => t.topic === topic)!.summary, mimeType: "text/markdown" }, () => ({
      contents: [{ uri, mimeType: "text/markdown", text: `# ${part.title}\n\n${part.text}` }],
    }));
  }
  for (const prompt of PROMPTS) {
    server.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description, argsSchema: { [prompt.argument.name]: z.string().optional().describe(prompt.argument.description) } },
      (args: Record<string, string | undefined>) => {
        const part = guide(prompt.topic);
        return { messages: [{ role: "user" as const, content: { type: "text" as const, text: `${prompt.text((args[prompt.argument.name] ?? "").trim())}\n\n${PROMPT_SCOPE}\n\n# ${part.title}\n\n${part.text}` } }] };
      },
    );
  }
  return server;
}

/**
 * Why the body of a POST to the endpoint is not read, when it is not, from what the request says before any of
 * it has come: it does not take both kinds of answer, does not say its body is JSON, or says it is larger than
 * is taken. Asked in the order, and answered in the words, of the library that speaks the protocol.
 */
function bodyRefused(request: IncomingMessage, most: number): { status: number; message: string } | null {
  const accept = [request.headers.accept ?? ""].flat().join(",");
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    return { status: 406, message: "Not Acceptable: Client must accept both application/json and text/event-stream" };
  }
  if (!isJsonContentType(request.headers["content-type"])) return { status: 415, message: "Unsupported Media Type: Content-Type must be application/json" };
  return Number(request.headers["content-length"] ?? 0) > most ? { status: 413, message: tooMuch(most) } : null;
}

/** What is said of a body that is larger than is taken. */
const tooMuch = (most: number): string => `The request body is larger than ${most / (1024 * 1024)} MB.`;

/**
 * Whether the body of a POST to the MCP endpoint would be read, from what the request says before any of it has
 * come. A request that waits to be told to go ahead is told so only then; one whose body would not be read is
 * answered without it.
 */
export function mcpBodyRead(request: IncomingMessage, most = MCP_LIMITS.bodyBytes): boolean {
  return bodyRefused(request, most) === null;
}

/**
 * Whether what was read from JSON has more members and elements than it may, all its objects and lists
 * together. Counted without one call inside another, so that a value nested as deep as a megabyte allows is
 * counted like any other, and no further than it takes to know.
 */
function hasMoreParts(value: unknown, most: number): boolean {
  let parts = 0;
  const open: unknown[] = [value];
  while (open.length) {
    const next = open.pop();
    if (next === null || typeof next !== "object") continue;
    const inside: unknown[] = Array.isArray(next) ? next : Object.values(next);
    parts += inside.length;
    if (parts > most) return true;
    for (const part of inside) if (part !== null && typeof part === "object") open.push(part);
  }
  return false;
}

/**
 * An answer as it is sent: the message of an error says what is wrong, and does not hand back what was sent.
 * One that is longer than it may be is cut, with how long it was at its end, and is then as long as it may be.
 */
function shortened(message: JSONRPCMessage, most: number): JSONRPCMessage {
  if (!("error" in message) || message.error.message.length <= most) return message;
  const said = message.error.message;
  const rest = `… (${said.length} characters)`;
  // Cut between two characters, never through the middle of one that takes two code units.
  const kept = said.slice(0, Math.max(0, most - rest.length)).replace(/[\uD800-\uDBFF]$/, "");
  return { ...message, error: { ...message.error, message: `${kept}${rest}` } };
}

/**
 * The text of an answer as it is sent. What the library refuses before it has a message to answer, a version
 * of the protocol it does not speak for one, it answers by itself and not through `shortened`: such an answer
 * is an error with a status that says so, and its message is cut here.
 */
function sentAs(status: number, text: string, most: number): string {
  if (status < 400 || text.length <= most) return text;
  try {
    const message = JSON.parse(text) as JSONRPCMessage | null;
    if (message && typeof message === "object" && "error" in message && typeof message.error?.message === "string") return JSON.stringify(shortened(message, most));
  } catch {
    // Not an answer of the protocol: sent as it is, within what an answer may be.
  }
  return text;
}

/**
 * The operations whose answer holds a key that is said once. Reading the user afterwards does not bring it back.
 */
const KEY_OPERATIONS: ReadonlySet<unknown> = new Set(["create_user", "reset_user_key"]);

/** What a caller is told whose answer did not come in time, for the request it sent. */
function lateFor(message: unknown): string {
  const said = "The service did not answer in time. The request may still be carried out: read the item, now and a little later, before sending the request again.";
  const { method, params } = (message ?? {}) as { method?: unknown; params?: { name?: unknown } | null };
  if (method !== "tools/call" || !KEY_OPERATIONS.has(params?.name)) return said;
  return `${said} A key that the request made was in its answer and is not sent again: once the request has been carried out, have an admin reset the key of that user, or, for the admin's own key, run "vigile user reset-key admin" on the service's machine.`;
}

/** The headers of a request that the protocol goes by. The key a request came with is not among them. */
const PROTOCOL_HEADERS = ["accept", "content-type", "mcp-protocol-version"] as const;

/**
 * Handles the MCP endpoint. Each request gets its own server, built for the user the request acts as,
 * so the list of tools depends on who is asking and nothing is kept between requests.
 *
 * A request is one message. The body is read and checked here, within `MCP_LIMITS`, before the library that
 * speaks the protocol sees any of it, and the answer is written here, so that what a request may cost is the
 * service's to say: how much is read, how much is answered, and how long the answer may take.
 */
export function createMcpHandler(options: McpOptions) {
  const limits = { ...MCP_LIMITS, ...options.limits };
  /** Tells the host what went wrong that was nobody's mistake. That it could not be told keeps no answer back. */
  const report = (error: unknown): void => {
    try {
      options.onUnexpected?.(error);
    } catch {
      // Not said.
    }
  };
  /**
   * A refusal, said the way the protocol says one, of the request with this ID where it has one. How long it
   * may take to reach a caller that does not read it is the service's to say, as of any answer.
   */
  const reject = (response: ServerResponse, status: number, message: string, code = -32000, id: string | number | null = null): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id }));
  };
  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return reject(response, 405, "This endpoint takes POST requests only.");
    }
    let username: string;
    let letInAs: string | undefined;
    try {
      ({ username, id: letInAs } = options.caller(request));
    } catch (error) {
      // A refusal is an answer. Anything else went wrong in finding out who calls, which is the service's own
      // trouble: the caller is told that there was some, and whoever runs the service is told what.
      if (!(error instanceof VigileError)) report(error);
      const body = toErrorBody(error);
      return reject(response, httpStatus(body.code), [body.message, ...(body.actions ?? [])].join(" "));
    }

    // What the request says of its body decides whether any of it is read. One that waited to be told to go
    // ahead was not told, and sends none. A body that is not read is not waited for: the service ends the
    // connection with any answer it gives before the body of the request is here.
    const refused = bodyRefused(request, limits.bodyBytes);
    if (refused) return reject(response, refused.status, refused.message);
    let text: string | null;
    try {
      text = await readBody(request, limits.bodyBytes);
    } catch {
      // The caller left before the request was here: there is nobody to answer.
      return void response.destroy();
    }
    // Larger than it said, or than it may be without having said: the rest is not waited for either.
    if (text === null) return reject(response, 413, tooMuch(limits.bodyBytes));
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return reject(response, 400, "Parse error: Invalid JSON", ErrorCode.ParseError);
    }
    // Several messages in one request would each be answered in full, and the answer waits for every one of
    // them, also for one that the same request takes back. The protocol no longer has such requests.
    if (Array.isArray(message)) return reject(response, 400, "This endpoint takes one message in a request, not a list of them.", ErrorCode.InvalidRequest);
    // Which request an answer is to: said with every answer from here on, a refusal too.
    const asked = (message as { id?: unknown } | null)?.id;
    const id = typeof asked === "string" || typeof asked === "number" ? asked : null;
    if (hasMoreParts(message, limits.parts)) return reject(response, 413, `The message has more than ${limits.parts} members and elements.`, -32000, id);

    const server = createMcpServer(options.engine, username, letInAs, limits.answerBytes);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const send = transport.send.bind(transport);
    transport.send = (said, how) => send(shortened(said, limits.errorChars), how);
    // What the library says went wrong is a caller's mistake as a rule, and is answered as one. It is kept for
    // the one case in which it explains the service's own trouble: an answer that never came.
    let trouble: unknown;
    server.server.onerror = (error) => void (trouble ??= error);

    const headers = new Headers();
    for (const name of PROTOCOL_HEADERS) {
      const value = request.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    // The request is here, and from here the answer has its time: one timer, which no change of the machine's
    // clock moves, and which is spent once.
    let waited: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => {
      waited = setTimeout(() => resolve("late"), limits.answerMs);
      waited.unref();
    });
    const gone = new Promise<"gone">((resolve) => response.once("close", () => resolve("gone")));
    try {
      await server.connect(transport);
      const answered = transport.handleRequest(new Request("http://vigile.invalid/mcp", { method: "POST", headers }), { parsedBody: message });
      // One that fails after nobody waits for it any longer has nobody to tell.
      answered.catch(() => {});
      const made = await Promise.race([answered, late, gone]);
      if (made === "gone") return;
      if (made === "late") {
        report(trouble ?? new Error(`A request to /mcp was not answered within ${limits.answerMs} ms.`));
        return reject(response, 503, lateFor(message), -32000, id);
      }
      // The whole of an answer is here at once: it is no stream, and reading it waits for nothing.
      const body = made.body === null ? "" : sentAs(made.status, await made.text(), limits.errorChars);
      if (Buffer.byteLength(body) > limits.answerBytes) return reject(response, 200, tooLarge(limits.answerBytes), ErrorCode.InternalError, id);
      response.writeHead(made.status, body ? { "content-type": made.headers.get("content-type") ?? "application/json", "content-length": Buffer.byteLength(body) } : {});
      response.end(body);
    } catch (error) {
      report(error);
      if (!response.headersSent) reject(response, 500, "The service hit an unexpected error.");
    } finally {
      clearTimeout(waited);
      void transport.close();
      void server.close();
    }
  };
}
