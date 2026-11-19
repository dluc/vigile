---
title: Next and waiting
description: How Vigile works out which tasks can start now and which are waiting, from the links of the plan, on every read. Nothing about it is stored, so nothing about it is stale.
card: What can start now is worked out from the plan on every read, never stored.
lead: Nobody marks a task as ready or as blocked. Whether it can start is worked out from the plan each time someone asks.
---

{{diagram next | from the scenario}}

## Two words, worked out

- **Next**: {{=next.is}}. It can start now.
- **Waiting**: {{=waiting.is}}. `waiting_for` names what. {{=waiting.not}}.

"Finished" means done or cancelled for a task, and ready or cancelled for a project. A deleted item holds nothing back either.

Neither word is a status, and neither can be set. Finish the cart page, and the payment form that depended on it is next for the following caller, with no step in between that could be forgotten.

## What can I do now?

[`list_next_tasks`](/docs/operations/list-next-tasks/) answers it for whoever asks: the tasks that are next and are assigned to the caller or to nobody, the most important first. A draft is never listed. A group can be next like any task.

Listing starts nothing. A task is taken by setting it to `in_progress`, and of two callers who do that, [one is refused](/how/versions-and-history/).

## Waiting for a group, or a project

In the picture above the launch waits for one task, the confirmation email. It could wait for the whole checkout instead: a task can depend on a single task, on a group or on a project, and [the picture of a plan as a graph](/how/plan-as-a-graph/) shows a launch that waits for a group. Depending on a **group** waits until the group itself is set to done or cancelled: one link stands for all the steps inside. Depending on a **project** waits until the project is ready or cancelled.

A task that depends on something unfinished cannot be started and cannot be finished. That is a [rule](/how/statuses/), and the refusal lists what it is waiting for.

## Why none of it is stored

A stored "ready" flag has to be kept right by every change that could affect it, in every task that depends on the one that changed. The day one update is missed, the flag lies. Vigile keeps only the facts, statuses and links, and works the rest out when it is read: next, waiting, the progress of a group or a project, and [problems](/how/problems/). The answer cannot disagree with the plan, because it is made from it.

## Reference

- [`list_next_tasks`](/docs/operations/list-next-tasks/), [`list_tasks`](/docs/operations/list-tasks/), [`get`](/docs/operations/get/).
- In an answer with a task in short or in full: `is_next`, `is_waiting` and `waiting_for`, and for a group `progress`. See [the model](/docs/model/#what-is-worked-out).
