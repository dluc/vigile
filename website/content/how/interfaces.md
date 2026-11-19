---
title: Four interfaces, one plan
nav: The interfaces
description: Vigile offers every operation as an MCP tool, an HTTP endpoint and a command, and a web page reads through the same operations. A change made through one shows for all.
card: MCP, HTTP, the command line and the page: one set of operations behind all four.
lead: An operation is defined once, in the engine, with its name, its description, its input and its rules. The interfaces are ways to reach it, and none of them has rules of its own.
---

{{diagram interfaces | Agents speak MCP, programs speak HTTP, people type commands or look at the page. All of it arrives at the same operations of one engine.}}

## One contract

Each operation says what it is called, what it takes, who may call it and what it does. The four ways in come from that one definition:

| Way in | For | An operation is | Read more |
|---|---|---|---|
| MCP, at `/mcp` | agents | a tool: `set_task_status`. An agent also gets the routine for a task, and a guide | [MCP for agents](/docs/mcp/) |
| HTTP API, at `/api` | programs | an endpoint: `POST /api/set-task-status`. A stream says when the plan has changed | [The HTTP API](/docs/http-api/) |
| Command line | you, and scripts | a command: `vigile set-task-status`. Output for people, or JSON | [The command line](/docs/cli/) |
| The page, at `/` | people | read operations, plus `update_task` for the priority −/+ controls | [The web page](/docs/web-page/) |

Input is checked in one place, the engine. So a wrong value is refused in the same words whichever way it came, and a refusal of an operation has [one shape](/docs/errors/) everywhere.

The command line is a client like any other: it calls the running service and never opens the data itself to change it.

## A change by one shows for all

1. An agent calls `set_task_status` over MCP.
2. The engine checks the change, stores it, and the plan's **revision** goes up by one.
3. Everyone listening on the stream of changes is told the new revision, and nothing else.
4. A page with auto-refresh on reads the plan again and moves the card to its new column.

The event says only that something changed. What changed is read through the operations, by each listener as itself, so the stream can tell nobody anything they could not read anyway.

## Reference

- [Operations](/docs/operations/): each one, with its input and an example in all three forms.
- [The guide for agents](/docs/guide/): what the service tells an agent about itself.
