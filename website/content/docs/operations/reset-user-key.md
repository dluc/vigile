---
example: {"user": "agent2"}
---

## What it answers

The `user`, and its new `api_key`, shown once. A `warning` beside it means the key works but could not be confirmed to last.

## Rules

- The old key stops working when the new one is issued.
- The user is named by its username or its ID. The ID is the safer of the two for a request that may be carried out late: a username can pass to another user.
- It takes no version. Each reset that is carried out replaces the key: the last one carried out is the one in force.
- Use it when a key is lost or leaked, and after restoring a deleted user, which comes back without a key.

On the command line, [`vigile user reset-key`](/docs/cli/#user-reset-key) calls this. For `admin` it also works when the service refuses the admin key or is not running.

## Errors

- `forbidden`: the caller is not an admin.
- `not_found`: no user has that name or ID.
- `rule_violation` with `deleted`: the user is deleted.
- `internal`, "No new API key could be stored": the key the user had still works. Call it again once the cause, which is in the service's log, is put right.
