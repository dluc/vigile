---
title: The HTTP API
description: The HTTP API of Vigile. An operation is a POST with a JSON body, errors have one shape, an endpoint lists the operations with their schemas, and a stream of server-sent events says when the plan has changed.
card: How to call an operation, the shape of an error, and the stream of changes.
lead: Every operation is an endpoint. A call is a POST with a JSON body, the answer is JSON, and a refusal says what is wrong in one shape.
terminals: running-demo
---

## Calling an operation

The examples ask a running instance on its usual port, `8700`, which holds the made-up plan the pictures show. See [Install and first run](/docs/install/#in-every-terminal).

An operation is a `POST` to `/api/<name>`, with the name written with hyphens, and its input as a JSON body:

```sh terminal=your
curl -s http://127.0.0.1:8700/api/list-next-tasks \
  -H 'content-type: application/json' \
  -d '{}'
```

With a key, where `vig_...` stands for the key of a user:

```sh skip=placeholder
curl -s http://127.0.0.1:8700/api/set-task-status \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer vig_...' \
  -d '{"id": "WEB-005", "version": 1, "status": "in_progress"}'
```

- **The body must say that it is JSON**, with the header `Content-Type: application/json`. A body of any other type is not read. No body at all is an empty input.
- **`Authorization: Bearer <key>`** makes the call act as the user that key belongs to. Without it, the call acts as the keyless user, if the instance has one. See [Users and access](/how/users-and-access/).
- The answer is the operation's result, as JSON, with status 200. [Operations](/docs/operations/) shows the input and a real answer of each.
- A body may have at most 1 MB. A larger one is refused as `limit_exceeded`.
- Only a POST request may have a body. Any other that brings one is refused as `invalid_input`.
- There is no version in the address. The API is the one of the service that answers; `GET /health` says which version that is.

## Errors

A call that is refused gets the status of its code and one shape of body:

```json
{
  "error": {
    "code": "version_conflict",
    "message": "Task WEB-002 changed since you read it: it is at version 2, you sent 1.",
    "current": { "kind": "task", "id": "WEB-002", "version": 2, "status": "in_progress" },
    "actions": ["Check the current item, then repeat the call with its version."]
  }
}
```

The example is cut short.

{{conflict-current}}

{{error-codes}}

Input the operation cannot take is `invalid_input`, with a message that names the field. [Errors and refusals](/docs/errors/) has every code and every rule.

An error does not always mean that nothing was changed. After {{=errors.unchanged}} nothing was: the change was refused before it was stored. After `internal`, read the message: it says what stands, or that the change was not confirmed, and then the item is read again before the change is sent again. See [what to do with a refusal](/docs/errors/#what-to-do-with-a-refusal).

## The other endpoints

| Endpoint | Answers | Needs |
|---|---|---|
| `GET /health` | `{"status": "ok", "name", "version"}`: that a Vigile service is here, which instance and which version | nothing, never a key |
| `GET /api/instance` | The instance's `name` and `version`, and under `you` who the request acts as: `username`, `type`, and whether no key was needed | to be let in |
| `GET /api/operations` | The operations the caller may call, each with its `name`, `path`, `kind` (read or write), `access`, `description` and the JSON Schema of its `input` | to be let in |
| `GET /api/events` | The stream of changes, below | to be let in |
| `GET /api/admin/status` | Details of the running service, for the doctor: process, uptime, settings with keys masked, counts, and what a check of the graph found | an admin |
| `POST /mcp` | MCP, for agents: see [MCP for agents](/docs/mcp/) | to be let in |

Anything else under `/api/` is `not_found`, with how operations are called.

`GET /api/operations` is the API describing itself. A client can be built from it without this documentation:

```sh terminal=your
curl -s http://127.0.0.1:8700/api/operations
```

## The stream of changes

`GET /api/events` is a stream of server-sent events, for anything that wants to know when the plan changes:

```sh terminal=second stays=running
curl -N http://127.0.0.1:8700/api/events
```

It keeps running, so it takes a terminal of its own.

```text
event: hello
data: {"revision":5}

event: change
data: {"revision":6}
```

- `hello` comes on connecting, `change` after every stored change.
- Each carries the plan's **revision**, a number that goes up by one with every stored change, and nothing else. What changed is read through the operations.
- A comment line every 20 seconds keeps the connection from being closed as idle.
- It needs a key whenever the operations do. Who may listen is asked again before each message, so a key that was reset ends the stream.
- At most 200 clients may listen at once: 32 from one address, and 168 in all that connect from the service's own machine, whomever they say they speak for. A further one gets `too_many_requests`. A client that has stopped reading is let go, and can connect again.
- A stream is the last answer on its connection: what is sent behind it on that connection is not looked at.

## Lists and pages

{{paged}}

```sh skip=placeholder
curl -s http://127.0.0.1:8700/api/list-tasks \
  -H 'content-type: application/json' \
  -d '{"project": "WEB", "continuation": "<token>"}'
```

A token belongs to the list it came from: with other filters, or made up, it is refused as `invalid_input`. So is a `continuation` sent to an operation that does not answer in pages, which does not know the field. A page starts after the last item of the page before, so items that were added or removed in between do not shift it.

## Requests that are turned away before they are read {#requests-from-browsers}

Three guards stand before `/api`. A request they turn away is not let in, with or without a key:

{{guards /api}}

A program that is not a browser is passed by the first guard only, because it sends neither header. The other two are held against it like against a browser. `GET /health` is not behind them. See [the guards](/docs/security/#the-browser-guards) for why they are there.

## Limits on a connection

A request has 30 seconds to arrive in full, headers and body; one that does not is dropped. The service keeps at most 1,024 connections open at once, 64 of them for one address beyond its own machine, and closes a connection on which nothing moves for a minute. A connection may have at most 8 requests that are not answered yet. [Security](/docs/security/#limits) has the whole of it.

A request that is refused before its body has arrived ends its connection with the answer: the rest of the body is not read, and nothing that came behind it on that connection is carried out.

Answers are never to be cached: they say `Cache-Control: no-store`.
