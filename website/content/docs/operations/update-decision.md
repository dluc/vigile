---
before: [{"operation":"create_decision","input":{"project":"WEB","title":"Show gross prices","description":"Include tax in displayed prices.","status":"proposed"}}]
example: {"id":"WEB-018","version":1,"status":"active"}
---

## What it answers

The decision in short after the amendment. Use `get` with history to see previous wording.

## Rules

Send the version last read. A withdrawn decision remains readable; changing one decision does not change others.

## Errors

`version_conflict` means the record changed; read it again before amending. A deleted decision must be restored before it can be changed.
