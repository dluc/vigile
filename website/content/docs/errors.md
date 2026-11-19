---
title: Errors and refusals
description: Every error Vigile can answer with. The shape of an error, the nine codes and their HTTP statuses, every rule a change can be refused by, and the codes and exit codes of the command line.
card: Every error code, every rule a change can be refused by, and what to do.
lead: A call that cannot be carried out is answered with what is wrong and, where there is a next step, what it is. The answer has one shape, over MCP, over HTTP and on the command line.
---

## The shape of an error

```json
{
  "error": {
    "code": "rule_violation",
    "message": "Task WEB-003 cannot be started: it is waiting for a dependency to finish.",
    "rule": "unfinished_dependencies",
    "blocking": [
      { "kind": "task", "id": "WEB-002", "title": "Cart page lists the items and the total", "status": "open" }
    ],
    "actions": [
      "Finish or cancel the items it depends on.",
      "Or call remove_link with type \"depends on\" if the dependency no longer applies.",
      "Or call list_next_tasks to pick work that can start now."
    ]
  }
}
```

| Field | Is | Present |
|---|---|---|
| `code` | One of the codes below | always |
| `message` | What is wrong, in a sentence | always |
| `actions` | Things the caller can do about it. Not exhaustive | with a refusal of an operation; an error of the service itself may have none |
| `rule` | The rule that refused the change | with `rule_violation` |
| `blocking` | The items in the way: `kind`, `id`, `title`, `status` | with some rules |
| `blocking_total` | How many items are in the way in all | when `blocking` is cut |
| `current` | The item as it is now, in short: what a list says of it. [`get`](/docs/operations/get/) has the description, the timeline and the history | with `version_conflict` |

Where it arrives:

- **HTTP**: as the body, with the status of the code.
- **MCP**: as the text of a tool result that is marked as an error.
- **Command line**: printed in words, with the items in the way and the actions; with `--json`, as this JSON on the error output.

## Codes

{{error-codes}}

In the service's log, a refused call has its line like any other, with the code as its result and the rule when there is one:

```text
2026-01-12T09:14:03.120Z op=set_task_status caller=agent1 kind=write ms=0.6 result=rule_violation rule=unfinished_dependencies
```

## Rules {#rules}

A `rule_violation` names the rule. These are all of them:

{{rules}}

## What to do with a refusal

- **`version_conflict`**: someone changed the item since it was read. The error holds the item as it is now, in short. Look at what changed, with [`get`](/docs/operations/get/) when it may be the description, then call again with the new version if the change still makes sense.
- **`rule_violation`**: follow one of the `actions`. Repeating the same call will be refused again while the plan is as it is.
- **`not_found`**, or an ID that matches more than one item: the error says how to name the item, for example by putting the kind in front.
- **`unauthorized`**: send a key, or a valid one. An admin issues keys.
- **`internal`**: something went wrong inside the service, and its log has the cause. Do not take it to mean that nothing was changed. Where a change was stored and a later step failed, the message says what stands and what to do, as in "User agent2 was created, but its API key could not be stored". Where the message says that the change was not confirmed, it is not known whether it was stored: read the item again, with `get` and `history`, before sending the change again.

After {{=errors.unchanged}}, nothing was changed: the call was refused before anything was stored. `unauthorized` is given before a call reaches an operation. The rows of those codes are what a service left behind when it gave each of them while this site was built:

{{error-outcomes}}

## The command line's own codes

With `--json`, the command line reports its own failures in the same shape, under codes the service does not use:

| Code | Means | Exit |
|---|---|---|
| `usage` | The command was not typed as it is to be: an option it does not have, a word too many, no config given | 1 |
| `not_running` | No service of this config is running. Nothing was sent to anyone | 1 |
| `not_this_service` | Something answers at the config's address, and it is not the service of this config. Nothing was sent to it | 1 |
| `no_answer` | The service took the connection and its answer did not come. A change may or may not have been stored | 2 |
| `cannot_start` | `serve` could not start: the port is taken, another service holds the data folder, the config names a user that does not exist. What has happened to the data folder by then depends on the step that failed: see [the steps of a start](/docs/troubleshooting/#the-service-does-not-start) | 1 |
| `config_invalid` | The config file does not pass the check. The actions list each thing that is wrong | 1 |
| `config_busy` | Another change to the config file is under way. Nothing was changed | 1 |
| `failed` | Anything else that went wrong in the command itself. The message says what; where the command had written something, such as a setting, it says that it stands | 1 |

A refusal by the service keeps the service's code and ends with 1. An exit code of 1 does not by itself say that nothing was changed: see [exit codes](/docs/cli/#exit-codes).
