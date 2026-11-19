---
example: {"id": "WEB-002", "version": 3, "name": "created_at", "value": "2026-02-20T09:00:00Z"}
refusal: {"id": "WEB-002", "version": 3, "name": "completed_at", "value": "2026-02-20T09:00:00Z"}
---

## What it answers

The item in short. For a task that is done, `completed_at` is in it. `created_at` and the timeline show in [`get`](/docs/operations/get/).

## When to use it

Only for work that was created or finished somewhere else and is being brought in. The service records creation and completion itself, as the moment of the call, and everyone relies on that record. For imported work, create and link the tasks, give each the status it has, and then set the dates: `created_at` first, then `completed_at` for a task that is done.

## Rules

- The value is a date and a time with its zone: `2026-03-14T09:30:00Z` or `2026-03-14T10:30:00+01:00`.
- It cannot be in the future, nor before 1970.
- A creation cannot be put after the moment the item was recorded here, nor after a later change of its status.
- A completion can only be set on a task that is done. It cannot come before the creation, as in the refused call above, nor before an earlier completion of the same task.
- Setting the completion earlier also moves back the status changes between creation and completion that would otherwise come after it.
- A date that names the moment the item already has, in whatever zone it is written, changes nothing: no new version, and no line in the history.
- The history records who set which date, when, and what it was before.

## Errors

- `invalid_input`: the value is not a real date and time with a zone, or is before 1970.
- `version_conflict`: the item changed since it was read.
- `rule_violation`: `timestamp_in_future`, `created_after_recorded`, `created_after_change`, `not_completed`, `completed_before_created`, `completed_before_earlier_completion`, or `deleted`.
