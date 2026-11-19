---
example: {"id": "WEB-009", "version": 1, "priority": 7, "why": "Half of the searches on the old shop used a filter."}
---

## What it answers

The task in short, as it is after the change. A short form has no `description` and no `why`: when one of those was changed, read it back with [`get`](/docs/operations/get/).

## Rules

- Only the fields that are sent are changed.
- `why`, `value` and `size` are cleared with `null`. A title and a description cannot be emptied.
- A call changes nothing when every field sent already has that value.
- The history keeps what was there before: the old and the new value of a field, and the earlier text of a description or a reason.
- The status, the links and the assignment are not changed here.

## Errors

- `version_conflict`: the task changed since it was read. The error holds it as it is now, in short.
- `invalid_input`: text that is too long or empty, a field the operation does not know.
- `rule_violation` with `deleted`: the task is deleted.
- `not_found`: no task has that ID.
