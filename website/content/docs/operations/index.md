---
title: Operations
description: The operations of Vigile, one by one. Each is an MCP tool, an HTTP endpoint and a command, with the same input, answer, rules and errors, and each has a page with an example that was run.
card: Every operation, each with its input, an example that was run, and its errors.
lead: Everything that reads or changes a plan is one of these operations. Each is offered three ways, with the same input, the same answer and the same rules.
---

An operation called `set_task_status` is:

| Where | Called as |
|---|---|
| MCP | the tool `set_task_status` |
| HTTP API | `POST /api/set-task-status` |
| Command line | `vigile set-task-status` |

Each page below is made from the operation's own definition: its description, its input and who may call it. The example on each page was run against a real service when this site was built, on the made-up plan its pictures show.

{{operations-index}}

## What they share, and where they differ

- **Input is checked before anything is done.** A field of the wrong type, a required field that is missing or a field the operation does not know is refused as `invalid_input`, and the message names the field. An operation for admins asks who is calling before that.
- **A change to the plan is one step.** It is stored whole, with its history, or not at all. A user's key is kept in the config file, apart from the plan: the exception below is about that.
- **An item is named by its ID.** Where a bare number could be a project as well as a task or a decision, put the kind in front, as in `task:042`, or give `kind`. A user can be named by its username.
- **A refusal says what is wrong** and names actions to take. See [Errors and refusals](/docs/errors/).
- **A refusal means nothing was changed, with one exception.** {{=errors.unchanged}} are given before anything is stored. After `internal` the message says what stands, or that the change was not confirmed: read the item again before sending the change again. See [what an error leaves behind](/docs/errors/#what-to-do-with-a-refusal).

## Which operations take a version {#versions}

Not every change does. An operation that changes or deletes an item that is there takes the `version` the caller last read, and is refused when the item has changed since. See [Versions, conflicts and history](/how/versions-and-history/).

{{versions}}

## Which lists come in pages {#pages}

{{paged}}

See [Lists and pages](/docs/http-api/#lists-and-pages).

## What an answer about a task carries

The operations that create, change or list tasks answer with the task in short. So does a conflict, under `current`.

{{answer-fields task}}

{{detail-adds}}
