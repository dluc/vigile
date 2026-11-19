---
example: {"project": "WEB", "status": "open"}
---

## What it answers

`tasks`: each task in short, without its description: its status, its links, and what is worked out from them. A `continuation` token is there when more tasks follow. [What an answer about a task carries](/docs/operations/#what-an-answer-about-a-task-carries) lists the fields.

## Rules

- The filters narrow together: a task is listed when it fits all that are given.
- `project` and `parent` list what is inside, at any depth.
- `top_level: true` lists the tasks that are in no other task: the groups and the ungrouped tasks. It is the view from the top; a group reports its progress.
- `has_problems: true` lists only tasks with problems; `false`, only those without.
- `assigned_to` takes a username or a user's ID.
- Deleted tasks are not listed.
- The order is by ID: tasks whose ID is a number alone first, then by prefix in alphabetical order, and by number within a prefix.
- At most {{=page.limit}} tasks come in one answer. Send the `continuation` back, with the same filters, for the next page.

## Errors

- `not_found`: the project, the parent or the user does not exist.
- `invalid_input`: a status or type that is none, or a continuation token that is not valid or belongs to another list.

## See also

[`list_next_tasks`](/docs/operations/list-next-tasks/) for what can start now. [`get`](/docs/operations/get/) for one task in full.
