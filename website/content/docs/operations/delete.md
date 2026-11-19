---
example: {"id": "APP-016", "version": 1}
refusal: {"id": "WEB", "version": 1}
---

## What it answers

`deleted: true`, whether it was `permanent`, and the `kind` and `id` of the item.

## Rules

- By default the item is only hidden: it leaves the lists, stops holding back what depends on it, can still be read with `get`, and comes back with [`restore`](/docs/operations/restore/).
- A project that still contains tasks cannot be deleted: delete the tasks first, or move them out with `remove_link`.
- A user that still has tasks assigned cannot be deleted. Its key stops working when it is deleted.
- The three built-in users cannot be deleted.
- **Deleting a user, and deleting anything for good, is for admins.** `permanent: true` removes the item with its description, its links and its history, and cannot be undone. A {{=link.recorders}} that was linked to it records in its own history that the link is gone; a {{=link.silent}} does not.
- A project cannot be deleted for good while deleted tasks are still in it. Its prefix is never given to another project.

## Errors

- `version_conflict`: the item changed since it was read.
- `forbidden`: the caller is not an admin and asked for a permanent delete, or to delete a user.
- `rule_violation`: `contains_tasks`, `contains_deleted_tasks`, `has_assigned_tasks`, `built_in` or `already_deleted`.
- `not_found`: nothing matches the ID.
- `internal`, "User … was deleted, but its API key could not be removed": the user is deleted, and the key lets nobody in while it is. The message says how to remove what is left. Do not delete again.
