---
example: {}
---

## What it answers

`link_types`: for each type its `type` name, its `reverse` name, the kinds of item it goes `from` and `to`, whether it is `built_in`, and its `effect`: what the product does because such a link exists.

## Rules

- The types are the three that are built in: "contains", "depends on" and "assigned to". See [link types](/docs/model/#link-types).
- [`add_link`](/docs/operations/add-link/) and [`remove_link`](/docs/operations/remove-link/) take either name of a type.

## Errors

None of its own: it takes no input.
