---
example: {"username": "agent3", "type": "agent"}
refusal: {"username": "agent2", "type": "agent"}
---

## What it answers

The new `user`, and its `api_key`. **The key is shown once, here.** Give it to the client, which sends it as `Authorization: Bearer <key>`. A `warning` beside it means the key works but could not be confirmed to last; issue another with `reset_user_key` once the cause is put right.

On the page the key is shown as `vig_…`; a real one is longer.

## Rules

- A username has lowercase letters, digits, "-" and "_", starts with a letter, has at most 32 characters, and cannot read like an ID, such as `user-7`.
- A username that is in use cannot be taken, also not one of a deleted user: restore that user, or choose another name.
- The type is `agent` or `person`. There is one admin, which is built in.
- The key applies at once.

On the command line, [`vigile user add`](/docs/cli/#user-add) calls this and prints the settings for the agent's MCP configuration as well.

## Errors

- `forbidden`: the caller is not an admin.
- `invalid_input`: the username cannot be one, or the type is none of the two.
- `rule_violation` with `username_taken`.
- `internal`, "User … was created, but its API key could not be stored": the user is there and cannot connect yet. Do not create it again: issue its key with [`reset_user_key`](/docs/operations/reset-user-key/) once the cause, which is in the service's log, is put right.
