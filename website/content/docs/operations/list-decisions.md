---
before: [{"operation":"create_decision","input":{"title":"Show gross prices","description":"Include tax in displayed prices.","status":"active"}}]
example: {"status":"active"}
---

## What it answers

One page of decisions in ID order, optionally filtered by state. Standalone records are discoverable without a project or task.

## Rules

Use the continuation token with the same filters to read the next page. Withdrawn records are included unless filtered out; deleted records are not listed.

## Errors

`invalid_input` means the state or continuation token is invalid.
