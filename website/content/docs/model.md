---
title: The model
description: The reference of what a Vigile plan is made of. The kinds of item, the statuses of tasks, projects and decisions and the moves between them, the types of task and of user, the link types, IDs and limits.
card: Statuses and moves, types, link types, IDs and limits, for looking things up.
lead: What a plan is made of, for looking things up. Every table on this page is made from the program: from what `vigile describe` prints, or from what a service did when this site was built.
---

For the ideas, read [The plan as a graph](/how/plan-as-a-graph/) and [Statuses and the rules of moving](/how/statuses/).

## Kinds of item

A plan holds projects, tasks, decisions and users, and links between them. In an ID or a reference the kind can be put in front: `project:042`, `task:042`, `decision:043`, `user:agent1`.

Which of them an instance offers is [a setting](/docs/configuration/#features): tasks, decisions or both.

## Fields of a task

| Field | Is |
|---|---|
| `title` | The outcome in one line: "Checkout: a customer can pay for a basket" says what will exist; "Checkout" does not. Required. |
| `description` | What needs to be done and how to tell it is finished. Required, and never empty. |
| `why` | At least one reason the work matters, for whoever picks it up. Optional. |
| `type` | `task` for planned work; `bug`, `issue` or `incident` for a problem, shown in its own colour. |
| `priority` | A number; the higher, the more important. Not set means 0. |
| `value`, `size` | Numbers that help choose among tasks of equal priority. Optional. |

Text reads back as it was written. Control characters are refused, a title is one line, and text made only of spaces counts as empty.

## Statuses of a task

{{task-statuses}}

### Moves {#moves}

{{moves}}

{{statuses-diagram}}

Besides the table, a move to `in_progress` or `done` is refused while something the task depends on is unfinished, a move to `done` while the task contains unfinished tasks, a move to `in_progress` by someone the task is not assigned to, and a move to `cancelled` while the task contains tasks in progress or in review. See [the rules](/docs/errors/#rules).

## Statuses of a project

{{project-statuses}}

Any move between them is allowed, other than to the status the project already has.

## Decisions {#decisions}

A decision has a `title`, the decision as one statement; a `description`, what is decided and what follows from it, which is required and never empty; optionally `why`, the reasons and what was ruled out; and a `status`:

- `proposed`: a choice under consideration.
- `active`: a choice that was adopted and is stood by.
- `withdrawn`: no longer considered or stood by. It stays readable, and [`list_decisions`](/docs/operations/list-decisions/) returns it.

[`create_decision`](/docs/operations/create-decision/) takes `proposed` or `active` and has no default. [`update_decision`](/docs/operations/update-decision/) moves a decision between the three in any direction. Nothing else changes its status: no link, and no change to another item.

A decision is in no group, and nothing depends on it. The project named when it is created gives its ID a prefix, and nothing more. What it affects is said by "affects" links, below.

## Types of task

{{task-types}}

## Link types

{{link-types}}

Either name of a type works when adding or removing a link; with the reverse name the two ends are swapped. A link is stored once.

An instance has the link types of [the features it offers](/docs/configuration/#features): "affects" with decisions, the other three with tasks. Set up for decisions alone, "affects" goes from a decision to a project.

## What is worked out {#what-is-worked-out}

Never stored, and so never stale: worked out from statuses and links whenever an item is read.

| In an answer | Is |
|---|---|
| `is_next` | {{=next.is}} |
| `is_waiting`, `waiting_for` | {{=waiting.is}}; and what. {{=waiting.not}} |
| `is_assigned`, `assigned_to` | Who has it, from its "assigned to" links |
| `progress` | For a group and a project: finished tasks out of all the tasks inside, at any depth |
| `has_problems`, `problems` | Where the plan contradicts itself |

### Problems {#problems}

{{problems}}

## Users

{{user-types}}

{{built-in-users}}

A username has lowercase letters, digits, "-" and "_", starts with a letter, and cannot read like an ID.

## IDs

| Kind | ID | Example |
|---|---|---|
| Project | Its prefix: 2 to 8 letters. Without a prefix, a number | `WEB` |
| Task | {{=ids.rule}} | `WEB-012`, `012` |
| Decision | As a task's, with the prefix of the project it was created with, if any | `WEB-013`, `013` |
| User | `USER-` and a number | `USER-004` |

{{task-ids}}

- IDs are given by the service. Numbers have at least three digits.
- Task and decision numbers come from one counter for the whole instance, so no two of them share a number.
- A number is given once, and so is a prefix, also after its project was deleted for good.
- IDs are read without regard to capitals: `web-12` finds `WEB-012`.

{{reserved-prefixes}}

## Limits

{{limits}}

A request body may have at most 1 MB. Text cannot contain control characters, other than line breaks and tabs in a description or a reason; a title is one line.
