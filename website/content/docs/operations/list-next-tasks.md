---
example: {}
---

## What it answers

`tasks`: the tasks the caller can start now, each in short. A `continuation` token is there when more follow.

## Rules

- A task is listed when it is open, nothing unfinished is in front of it, at least one path through its projects and groups is active, and it is assigned to the caller or to nobody.
- Grouping directs execution. Priority is compared from the outermost group through each nested group to the task, at the first difference; an open group comes before what it contains. A task in several groups uses its highest active path, and an ungrouped task uses its own priority.
- Each task carries the `priority_path` that placed it. Tasks on the same path are listed by ID, which keeps the order stable and says nothing of importance: choose among them using `value` and `size`.
- Drafts are never listed.
- `project` and `parent` keep the list inside one project or one group, at any depth.
- The answer depends on who asks: a task assigned to someone else is not in it. A continuation token does not pass from one user to another.
- Listing starts nothing. Take a task with [`set_task_status`](/docs/operations/set-task-status/) and `in_progress`.

## Errors

- `not_found`: the project or the parent does not exist.
- `invalid_input`: a continuation token that is not valid, or belongs to another list or to another user: this list is the caller's own.

## See also

[Next and waiting](/how/next-and-waiting/) explains how it is worked out.
