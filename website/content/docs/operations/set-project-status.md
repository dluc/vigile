---
example: {"id": "APP", "version": 1, "status": "in_preview"}
---

## What it answers

The project in short, with its new `status` and its `version`, one higher.

## Rules

- Any move between the [statuses of a project](/docs/model/#statuses-of-a-project) is allowed, except to the status it already has.
- Tasks that depend on the project wait until it is `ready` or `cancelled`.
- Marking a project `ready` while it holds unfinished tasks is allowed, and shows as the problem `ready_with_unfinished_tasks` on the project.
- A project that is `broken` says so as a problem, and so does every unfinished task that depends on it.
- The change of status is added to the project's timeline and history.

## Errors

- `version_conflict`: the project changed since it was read. The error holds it as it is now, in short.
- `rule_violation`: `same_status`, or `deleted` for a project that is deleted.
- `not_found`: no project has that ID.
