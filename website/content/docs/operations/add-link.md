---
example: {"from": "WEB-012", "type": "depends on", "to": "WEB-003"}
refusal: {"from": "WEB-001", "type": "depends on", "to": "WEB-013"}
---

## What it answers

`created`, and the `link` as it is stored: `from`, `type` and `to`. When the link was already there, `created` is false and nothing has changed.

## Rules

- The type is one of the [link types](/docs/model/#link-types), by either of its names. With the reverse name the two ends are swapped: "A is contained B" is stored as "B contains A".
- The two ends have to be of the kinds the type connects, exist, and not be deleted.
- A link that would close a loop of "contains" and "depends on" is refused, with the path it would close. In the refused call above, the launch already waits for the checkout.
- An item cannot be linked to itself.
- It takes no version. But the link is a change to the task it is about, the one that is contained, depends or is assigned: that task's `version` goes up by one, and whoever read it before reads it again. An "affects" link is a change to the decision, and leaves the version of what it affects as it was.
- An end that is a {{=link.recorders}} records the new link in its history. A {{=link.silent}} keeps no history of the tasks it is given: an assignment is in the history of the task, and only there.

### Who records a link {#who-records-a-link}

{{link-history}}

"contains" puts a task into a group or a project; a task can be in several. "depends on" makes a task wait. "assigned to" says who works on it; a task can have several users. "affects" says which task, group or project a [decision](/docs/model/#decisions) bears on, and does nothing more: it holds no work back and is not passed on to what a group or a project contains.

## Errors

- `invalid_input`: no such link type, or ends of the wrong kinds for it.
- `not_found`: one of the two items does not exist.
- `rule_violation`: `loop`, `self_link`, or `deleted`.
