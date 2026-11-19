---
example: {"project": "WEB", "parent": "WEB-001", "title": "Order history lists a customer's past orders", "description": "Done when a signed-in customer sees their last ten orders with the state of each.", "why": "Customers ask support for this every day.", "depends_on": ["WEB-003"], "priority": 3}
refusal: {"project": "WEB", "parent": "WEB-001", "title": "Thank-you page for launch day", "description": "Done when it is live.", "depends_on": ["WEB-013"]}
---

## What it answers

The new task in short: its `id`, its `status`, its `version` (1), its links, and what is worked out from them. In the example the task waits for `WEB-003`, so `is_waiting` is true and `is_next` is false.

## Rules

- A title and a description are required. The description says what is to be done and how to tell it is finished.
- The task starts as `open`, or as `draft` when `draft` is true.
- `project` puts it into a project and `parent` into a group. Both can be given.
- The task gets its ID now, and keeps it when it is moved. {{=ids.rule}}: see [how a task gets its ID](/docs/model/#ids).
- A task becomes a group the moment another task is created with `parent` set to it. Nothing else has to be done.
- `depends_on` and `assigned_to` make the links in the same step. Each takes at most 30 entries; a user can be named by its username.
- What it is put into, depends on or is assigned to has to exist and not be deleted.
- A task cannot be created inside something it would also have to wait for: that is a loop, as in the refused call above, where the launch waits for the checkout the task would be part of.

## Errors

- `invalid_input`: a missing or empty title or description, text that is too long, a field the operation does not know.
- `not_found`: the project, the parent, a dependency or a user does not exist.
- `rule_violation`: `loop`, or `deleted` for something that is deleted.

## See also

[`update_task`](/docs/operations/update-task/) changes its fields, [`set_task_status`](/docs/operations/set-task-status/) its status, and [`add_link`](/docs/operations/add-link/) what it depends on, where it is and who has it.
