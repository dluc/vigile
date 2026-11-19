---
example: {"title": "Customer support", "prefix": "HELP", "description": "Answer every customer within a day."}
refusal: {"title": "Web shop, second try", "prefix": "WEB"}
---

## What it answers

The new project in short: its `id`, which is the prefix, or a number when no prefix was given, its `title`, its `status` (`open`), its `version` (1), its `progress` and whether it `has_problems`.

## Rules

- A prefix has 2 to 8 letters and nothing else. It is stored in capitals, and it is the project's ID: it cannot be changed later.
- A prefix is given once. It cannot be one another project has, also a deleted one, or one that a project deleted for good had. The words that start the IDs of other kinds of item cannot be prefixes either: see [IDs](/docs/model/#ids).
- Without a prefix the project gets a number as its ID. A task created directly in it gets a bare number; a task also created under a parent whose ID has a prefix uses the parent's prefix instead.
- The description is optional for a project.

## Errors

- `invalid_input`: no title, a title of more than one line, a prefix that is not 2 to 8 letters or is a reserved word.
- `rule_violation` with the rule `prefix_taken`: the prefix is in use, or was used.

## See also

[`create_task`](/docs/operations/create-task/) with `project` puts a task into it. [`set_project_status`](/docs/operations/set-project-status/) changes its status.
