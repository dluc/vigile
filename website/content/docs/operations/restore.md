---
example: {"id": "APP-016"}
before: [{"operation": "delete", "input": {"id": "APP-016", "version": 1}}]
---

## What it answers

The item in short, as it is again: with the status and the links it had, and a `version` one higher.

## Rules

- It takes no version: there is nothing to overwrite.
- A restored task holds back what depends on it again, if it is unfinished. That can leave a [problem](/how/problems/) on a task that went on meanwhile.
- Restoring a user is for admins. The user comes back without a key: issue one with [`reset_user_key`](/docs/operations/reset-user-key/).
- An item that was deleted for good cannot be restored.

## Errors

- `rule_violation` with `not_deleted`: the item is not deleted.
- `forbidden`: the caller is not an admin and the item is a user.
- `not_found`: nothing matches the ID, as after a permanent delete.
- `internal`, "User … was restored. The key it had before no longer counts": the user is back. Issue its new key with [`reset_user_key`](/docs/operations/reset-user-key/), which it needs in any case.
