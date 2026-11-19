---
title: MCP for agents
nav: MCP for agents
description: How to connect an AI agent to Vigile over MCP. The endpoint, the settings for a client, a user and key for each agent, the tools, and the instructions, resources and prompts an agent gets.
card: How to connect an agent, a user and key for each, and what an agent is told.
lead: Agents reach Vigile over the Model Context Protocol. An agent that connects is told how to work with the plan and gets a tool for each operation it may call.
terminals: running
---

## The endpoint

The service answers MCP at `/mcp`, on the same port as everything else, over streamable HTTP:

```text
http://127.0.0.1:8700/mcp
```

`vigile serve` prints the address. It takes `POST` requests. Nothing is kept between requests, so there is no session to lose: each request is answered for the user it comes from.

## Connecting a client

What a client needs is the address and, if the instance requires one, a key. How that is written depends on the client.

**A client that reads MCP servers from a JSON file.** Most take this form, which is also what `vigile user add` prints:

```json
{
  "mcpServers": {
    "vigile": { "type": "http", "url": "http://127.0.0.1:8700/mcp" }
  }
}
```

With a key:

```json
{
  "mcpServers": {
    "vigile": {
      "type": "http",
      "url": "http://127.0.0.1:8700/mcp",
      "headers": { "Authorization": "Bearer vig_..." }
    }
  }
}
```

The name of the file, and sometimes of the fields, is the client's own: look for "remote", "HTTP" or "streamable HTTP" servers in its documentation.

**A client that is set up with a command.** Give it the same two things. For example, with Claude Code:

```sh skip=other-program
claude mcp add --transport http vigile http://127.0.0.1:8700/mcp
```

**A client that can only start a local program** and talk to it over standard input and output cannot reach Vigile directly: Vigile speaks MCP over HTTP only. Such a client needs a bridge between the two, which Vigile does not come with.

To check the endpoint without any client, ask the doctor: its check "MCP endpoint answers" connects as a client does and counts the tools.

## One agent, no key

On a new instance, a connection without a key acts as the built-in user `agent1`. For one agent on your own machine, the address alone is enough.

## Several agents {#several-agents}

Give each agent its own user, so that their work can be told apart and each can be assigned its own tasks:

```sh terminal=your
vigile user add agent2
```

The commands here are typed in a terminal that is set up as [Install and first run](/docs/install/#in-every-terminal) leaves it, with the instance running.

```text
  ✓ User agent2 created

  Username  agent2
  API key   vig_...
  MCP URL   http://127.0.0.1:8700/mcp

  Paste this into the agent's MCP configuration:
  ...
```

The key is shown once. It applies at once, without a restart. An agent that connects with a key that is not valid is refused; it never falls back to `agent1`.

To make every connection need a key: `vigile config set auth.keyless_user ""`. See [Security](/docs/security/).

## The tools

Every [operation](/docs/operations/) is a tool of the same name, with the same input. The list an agent gets depends on its user's type: tools for admins are not listed for anyone else. It also depends on [what the instance offers](/docs/configuration/#features): one set up for tasks alone lists no decision tool, and one for decisions alone no task tool.

{{mcp-tools}}

- The input of a tool is described by the same JSON Schema the HTTP API shows.
- The result of a call is the operation's answer, as JSON in a text content.
- A call that is refused is a tool result marked as an error, whose text is `{"error": {"code", "message", ...}}`, the same body as over HTTP. That includes input the operation cannot take. See [Errors and refusals](/docs/errors/).

## What an agent is told

On connecting, an agent receives instructions: the routine for a task, how to organise work, and where to read more.

{{mcp-instructions}}

That is what an instance with tasks says. One set up for [decisions alone](/docs/configuration/#features) tells its agents how to keep the register instead: record a choice as proposed or active, find decisions with `list_decisions`, and amend or withdraw one with the version just read.

The routine, in short:

1. `list_next_tasks` lists what can start now, most important first.
2. `get` shows a task in full: description, reason, links and version.
3. `set_task_status` with `in_progress` when the work really starts. This assigns the task to the agent.
4. `set_task_status` with `in_review` when the implementation is complete, and with `done` once the outcome is shipped and verified. `paused` is for work that stops unfinished.

## The guide, as resources and prompts

The [guide](/docs/guide/) that `get_guide` returns is also offered as resources, for clients that read those:

{{mcp-resources}}

And through three prompts, for clients that offer prompts to the person using them. Each sends the agent to the guide and then to work:

{{mcp-prompts}}

## What one request may be {#one-request}

- A request is one JSON-RPC message, as a request to the API is one call. A list of messages in one request is refused.
- Its body may have at most 1 MB, as over the HTTP API.
- A message may have at most 1,000 members and elements, all its objects and lists together, which is many times what a call has. Text of any length counts as one.
- An answer is at most 4 MB. A larger one is not sent, and an error says so in its place: a change the request made is stored.
- The message of a protocol error has at most 1,000 characters.
- The service has 30 seconds to make the answer, counted from when all of the request is here. Then it ends the wait with an error.

That error ends the wait, not the work: a change the request began may still be stored, as after a connection that ended. Read the item before sending the request again. A key that such a request made was in its answer and is not sent again: have an admin reset that user's key, or run `vigile user reset-key admin` for the admin's own.

A request that is refused here is answered as a JSON-RPC error, not as a tool result:

| Refused | Status |
|---|---|
| Not a `POST` | 405 |
| An `Accept` header that does not name both `application/json` and `text/event-stream` | 406 |
| A body that does not say it is JSON | 415 |
| A body over 1 MB, or a message of more than 1,000 members and elements | 413 |
| A body that is not JSON, or a list of messages | 400 |

A `tools/call` that names no tool is a protocol error too. It is not a call of an operation, so it has no line in the log.

## Requests that are turned away

A connection that may not act as anyone, because it has no key where one is required or because its key is not valid, is refused before any tool is listed. So is a request that one of these guards turns away:

{{guards /mcp}}

An agent is not a browser, so the first passes it by. The second is held against it: while the service listens on this machine only, the address in the agent's setting has to name it as `localhost` or by a loopback address such as `127.0.0.1`. See [the guards](/docs/security/#the-browser-guards).
