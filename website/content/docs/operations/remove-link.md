---
example: {"from": "WEB-013", "type": "depends on", "to": "WEB-010"}
---

## What it answers

`removed: true`, and the `link` that was removed.

## Rules

- The link is named as it would be added: by its two ends and either name of its type.
- Removing a "contains" link takes a task out of a project or a group. Removing a "depends on" link stops the task waiting for that item. Removing an "assigned to" link takes the task from that user.
- It takes no version. The task the link was about moves one version on.
- An end that is a {{=link.recorders}} records in its history that the link is gone. A {{=link.silent}} does not: that a task was taken from a user is in the history of the task, and only there. See [who records a link](/docs/operations/add-link/#who-records-a-link).

In the example the launch no longer waits for the accounts group. It still waits for the checkout and the search.

## Errors

- `not_found`: there is no such link, or one of the two items does not exist.
- `invalid_input`: no such link type.
