---
example: {"topic": "working"}
---

## What it answers

The `topic` that was asked for, its `title`, and its `text`, which is written as Markdown. And `topics`: every topic with its title and a line about what it holds, so that a reader knows what else there is.

## Rules

- Without a topic it answers with `overview`.
- The text is the same for every caller. [The guide for agents](/docs/guide/) shows all of it.

## Errors

- `invalid_input`: a topic that is none of the four.
