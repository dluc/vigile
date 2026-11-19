---
example: {}
---

## What it answers

`claims`: assigned tasks that remain in progress after a full day without a recorded task change. Each claim says `quiet_since`, the last recorded change, and `attention_since`, when the 24-hour threshold passed. `attention_after_hours` says the threshold. A `continuation` token is there when more claims follow.

## Rules

- Oldest activity comes first, then task ID for a stable order.
- `project` and `parent` keep the list inside one project or group, at any depth.
- The operation only brings quiet work to attention. It never releases, pauses or reassigns a task.
- Taking over still requires an explicit change to the task's `assigned to` link.
- At most {{=page.limit}} claims come in one answer. Send the `continuation` back unchanged, with the same filters, for the next page.

## Errors

- `not_found`: the project or parent does not exist.
- `invalid_input`: a continuation token is invalid or belongs to another list.

## See also

[`list_next_tasks`](/docs/operations/list-next-tasks/) lists unclaimed or caller-assigned work that can start now. [`get`](/docs/operations/get/) reads one task and its assignment in full.
