---
example: {"project": "WEB", "action": "status_changed"}
---

## What it answers

`changes`: the recorded changes across the plan, newest first. Each one names its item by `kind`, `id` and `title`, and says `at` what moment, `by` whom, the `action` and its `data`. A change that completed a task also carries `duration_ms`: the time from the task's creation to that completion. `place` is the change's position in the plan's history. A `continuation` token is there when older changes follow.

## Rules

- The filters narrow together: a change is listed when it fits all that are given.
- `project` lists the changes of the project and of the items it contains now, in nested groups too. `parent` lists the changes of the tasks a group contains, at any depth, and not the group's own.
- `text` finds items by what their ID, their title as it is now, or their username contains.
- `kind` is `project`, `task`, `decision` or `user`. `actor` takes a username or a user's ID. `action` is one kind of change, such as `status_changed` or `link_added`.
- `status_from` and `status_to` keep only changes of status that left, or arrived at, that status.
- `from` and `to` bound the time, each as a date or as a moment. A date as `from` starts with that day, and as `to` ends with it.
- The `title` is the item's title now, not the one it had then. The changes of an item that was deleted for good are not listed: its history went with it.
- At most {{=page.limit}} changes come in one answer. Send the `continuation` back unchanged, with the same filters, for the older ones.

## Errors

- `not_found`: the project, the parent or the actor does not exist.
- `invalid_input`: a kind or status that is none, a date that is none, a range that ends before it starts, or a continuation token that is not valid or belongs to another list.

## See also

[`get`](/docs/operations/get/) with `history` reads the changes of one item, and its status timeline. [Versions and history](/how/versions-and-history/) says what is recorded.
