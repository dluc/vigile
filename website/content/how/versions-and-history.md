---
title: Versions, conflicts and history
nav: Versions and history
description: Every item in Vigile has a version. Changing or deleting an item names the version the change was based on and fails if the item has changed since, so nothing is overwritten unseen. What was done to an item is kept in its history.
card: Changing an item names the version the change was based on. What was done is kept.
lead: Several people and agents change one plan at the same time. Versions make sure that nobody changes what they have not seen, and history keeps what everyone did.
terminals: running-demo
---

{{diagram versions | Two agents read the same task at version 1. The first to start it wins and the task moves to version 2. The second is refused, and gets the task as it is now.}}

## Changing an item names its version

Every project, task, decision and user has a `version`. It starts at 1 and goes up by one with each change to the item. A call that changes or deletes an item that is there sends the version it last read. Those are {{=ops.versioned}}:

```sh terminal=your
vigile set-task-status --id WEB-005 --version 1 --status in_progress
```

If the item is still at that version, the change is made. If someone changed it in between, the call fails with `version_conflict` and returns the item as it is now, in short, under `current`. Look at what changed, then call again with the new version if the change still makes sense.

The other operations that change something take no version: {{=ops.unversioned}}. They make something new, add to or take from a set, or have nothing to overwrite. [Which operations take a version](/docs/operations/#versions) says of each what happens when it is sent twice.

That is all there is to it: no locks, no leases, no heartbeat to keep alive. Reading costs nothing and holds nothing.

The other side of that: nothing takes a task back by itself. A task that an agent started and then abandoned stays in progress until someone sets it to open or paused.

## Taking a task

Two agents that both read a task as next and both try to start it cannot both succeed. The second one is refused because the version it sent is old, and gets the task as it is now. If it tries again with the new version, it is refused because the task is already in progress, and told to pick other work. Starting a task that is assigned to nobody assigns it to whoever started it.

## Links count as a change to the task

`add_link` and `remove_link` take no version: they add to or take from a set, and two of them do not overwrite each other. But a new or removed link moves the version of the task it is about, the one that is contained, depends or is assigned. Whoever read that task earlier gets a conflict and reads it again. An "affects" link moves the version of the decision, not of what it affects.

## History

A change to an item is written to its history in the same step as the change itself: when, by whom, and what. [`get`](/docs/operations/get/) with `history` returns it. [`list_history`](/docs/operations/list-history/) lists the changes of the whole plan, newest first, and the page shows them in its [History view](/docs/web-page/#history).

- Creation, and every later change of a field, with what the text was before. That is how a [decision](/how/plan-as-a-graph/#decisions) that was amended still says what it said.
- Every change of status. The **timeline** of a task, a project or a decision lists each status it went through.
- Links added and removed, in the history of each end that is a {{=link.recorders}}. A {{=link.silent}} keeps no history of the tasks it is given: who had a task, and from when to when, is in the history of the task. See [who records a link](/docs/operations/add-link/#who-records-a-link).
- Deleting and restoring.

A change is always made under the identity that called the service, so the history says who did what.

## Deleting

`delete` hides an item: it leaves the lists, stops holding back what depends on it, and comes back with `restore`. An admin can also delete for good, which takes the item's history with it and cannot be undone.

## Time

The service's clock is the one source of when things happened. The one exception is for work brought in from another tool: [`override_timestamp`](/docs/operations/override-timestamp/) sets when it was really created or completed, and the history records who set which date.

## Reference

- [Errors and refusals](/docs/errors/#code-version-conflict): `version_conflict` and what it carries.
- The command above is typed in a terminal set up as [Install and first run](/docs/install/#in-every-terminal) leaves it, on the made-up plan the pictures show.
- [`get`](/docs/operations/get/), [`delete`](/docs/operations/delete/), [`restore`](/docs/operations/restore/), [`override_timestamp`](/docs/operations/override-timestamp/).
