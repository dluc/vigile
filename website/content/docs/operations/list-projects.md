---
example: {}
---

## What it answers

`projects`: each project in short, with its `status`, its `progress` (`finished` tasks out of the `total` it contains, at any depth), and `has_problems`, with the `problems` when there are some. A `continuation` token is there when more projects follow.

## Rules

- Deleted projects are not listed.
- The order is by ID: prefixes in alphabetical order, then the numbered projects.
- `has_problems: true` lists only projects with problems; `false`, only those without.
- At most {{=page.limit}} projects come in one answer. Send the `continuation` back, with the same input, for the next page.

## Errors

- `invalid_input`: a continuation token that is not valid, or that belongs to another list.
