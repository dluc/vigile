import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isJsonContentType } from "@modelcontextprotocol/sdk/shared/mediaType.js";
import { ErrorCode, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AGENT_INSTRUCTIONS, GUIDE_TOPICS, VERSION, VigileError, guide, httpStatus, toErrorBody, type Engine, type Operation } from "@vigile/core";

export interface McpOptions {
  engine: Engine;
  /** The user a request acts as. Throws a `VigileError` when the request may not connect. */
  /** Who the request is let in as: the name, and the ID of the user that has it now. */
  caller(request: IncomingMessage): { username: string; id?: string };
  /** Told what went wrong when a request fails in a way nobody planned for, for the service's log. */
  onUnexpected?(error: unknown): void;
}

/** How large the body of a request to the MCP endpoint may be, in bytes. */
export const MAX_MCP_BODY = 4 * 1024 * 1024;

/**
 * Whether the body of a POST to the MCP endpoint would be read, from what the request says before any of it has
 * come: it takes both kinds of answer, says its body is JSON, and does not say it is larger than is taken. These
 * are the checks the transport makes before it reads; a request that fails one is answered without its body.
 */
export function mcpBodyRead(request: IncomingMessage): boolean {
  const accept = [request.headers.accept ?? ""].flat().join(",");
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return false;
  if (!isJsonContentType(request.headers["content-type"])) return false;
  return !(Number(request.headers["content-length"] ?? 0) > MAX_MCP_BODY);
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

/** A refusal of a request that is not one the protocol knows, said the way the protocol says it. */
const protocolError = (code: ErrorCode, message: string): Error => Object.assign(new Error(message), { code });

/**
 * A server that offers one tool per operation the user's type may call. With `letInAs`, the ID of the user the
 * request was let in as, a tool runs only as that user: not as someone else who has the name by then.
 */
export function createMcpServer(engine: Engine, username: string, letInAs?: string): McpServer {
  const user = engine.user(username);
  const server = new McpServer({ name: "vigile", version: VERSION }, { instructions: INSTRUCTIONS });
  if (!user) return server;

  // The tools are not registered with the library's own list of tools. That list checks what a call sends before
  // the call gets anywhere, and answers in words of its own: input of the wrong type never reached the engine,
  // which is where every interface has its input checked, refused in the one shape of an error, and written to
  // the log of operations. Here the list of tools describes each input, and a call goes to the engine as it came.
  server.server.registerCapabilities({ tools: { listChanged: true } });
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: engine.operationsFor(user.type).map(describeTool) }));
  // A call is taken here, as the request it came as, for the same reason: a handler registered for tools/call
  // has the library refuse arguments that are not an object before the handler is asked. This is the handler
  // for every method that has none, so any other method is answered as the library answers one it does not know.
  server.server.fallbackRequestHandler = async (request) => {
    if (request.method !== "tools/call") throw protocolError(ErrorCode.MethodNotFound, "Method not found");
    const { name, arguments: input } = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof name !== "string") throw protocolError(ErrorCode.InvalidParams, "A tools/call request names the tool to call, as text, in params.name.");
    try {
      const result = await engine.execute(name, letInAs === undefined ? username : { username, id: letInAs }, input);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: toErrorBody(error) }) }] };
    }
  };

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

function reject(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

/**
 * Handles the MCP endpoint. Each request gets its own server, built for the user the request acts as,
 * so the list of tools depends on who is asking and nothing is kept between requests.
 */
export function createMcpHandler(options: McpOptions) {
  /** Tells the host what went wrong that was nobody's mistake. That it could not be told keeps no answer back. */
  const report = (error: unknown): void => {
    try {
      options.onUnexpected?.(error);
    } catch {
      // Not said.
    }
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
    const server = createMcpServer(options.engine, username, letInAs);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_MCP_BODY });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      report(error);
      if (!response.headersSent) reject(response, 500, "The service hit an unexpected error.");
    }
  };
}
