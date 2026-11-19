---
example: {"id": "WEB-005", "version": 1, "status": "in_progress"}
refusal: {"id": "WEB-004", "version": 1, "status": "in_progress"}
---

## What it answers

The task in short, with its new `status` and its `version`, one higher. In the example the task was assigned to nobody, so starting it assigned it to the caller: `assigned_to` now names `agent1`.

## Rules

- The move has to be one the [table of moves](/docs/model/#moves) allows.
- A task cannot be moved to the status it already has. For `in_progress`, the refusal tells a second agent that the task is in progress, and whether it is assigned to that agent, to others or to nobody.
- A task cannot be started or marked done while something it depends on is unfinished.
- A task cannot be marked done while it contains unfinished tasks, at any depth.
- A task cannot be started by someone it is not assigned to, while it is assigned to anyone.
- A task cannot be cancelled while it contains tasks in progress or in review, at any depth.
- Starting a task that is assigned to nobody assigns it to whoever starts it.
- A group does not close by itself when its tasks are done: someone sets it to done.
- Every status a task goes through is kept in its timeline, with when and by whom.

## Errors

- `version_conflict`: the task changed since it was read. The error holds it as it is now, in short.
- `rule_violation`: `same_status`, `status_move_not_allowed`, `unfinished_dependencies`, `unfinished_contents`, `assigned_to_other`, `active_contents`, or `deleted`. Each names actions that would resolve it; some also name the items in the way.
- `invalid_input`: a status that is none of the seven.
- `not_found`: no task has that ID.

## See also

[Statuses and the rules of moving](/how/statuses/) explains the rules. [`list_next_tasks`](/docs/operations/list-next-tasks/) lists what can be started.
