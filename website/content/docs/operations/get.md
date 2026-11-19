---
example: {"id": "WEB-003"}
---

## What it answers

The item in full: everything a list says of it, and more, by its kind.

{{detail-adds}}

- `description`, and `why`, which is `null` when nobody has said;
- `links`: its links in both directions, under the name that reads correctly from this item, such as `is contained`, `depends on`, `is depended on by` and `assigned to`;
- `timeline`: the statuses it went through, oldest first, each with when, by whom and its `place` in the list. The latest {{=page.limit}} come with the item; `more.timeline` says how many there are and leads to the earlier ones;
- `history`: what was recorded of the item, oldest first, with when, by whom, what was done and the details.

### What it says of a linked item {#linked-items}

{{linked-fields}}

## Rules

- Deleted items can still be read; they carry `deleted_at`.
- A bare number can be a project as well as a task or a decision. When it matches more than one, the call is refused and says how to tell them apart: put the kind in front, as in `task:042`, or give `kind`.
- A user can be read by its username or by its ID.
- A [decision](/docs/model/#decisions) is read like any item. Its "affects" links read from both ends: the decision lists what it `affects`, and a task or a project the decisions it `is affected by`.
- IDs are read without regard to capitals.

## Errors

- `not_found`: nothing matches the ID.
- `invalid_input`: the ID matches more than one item, or is of another kind than the `kind` given.
