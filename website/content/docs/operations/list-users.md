---
example: {}
---

## What it answers

`users`: each user with its `id`, `username`, `type`, whether it is `built_in`, and its `version`. And `you`: the username the call was made as, which tells an agent who it is.

## Rules

- Deleted users are not listed.
- The order is that of their IDs, which is the order they were created in.
- Keys are never in an answer of this operation.
- At most {{=page.limit}} users come in one answer. Send the `continuation` back unchanged for the next page.

## Errors

- `invalid_input`: a continuation token is invalid or belongs to another list.

## See also

Assign a task with [`add_link`](/docs/operations/add-link/) and the type "assigned to", or with `assigned_to` when creating it.
