---
title: The guide for agents
nav: The guide for agents
description: The guide that Vigile gives to agents through get_guide, word for word. What the service holds, the ways to organise work in it, the routine for a task, and complete examples of calls.
card: What the service tells an agent about itself, word for word.
lead: An agent can ask the service how to use it. This is what it is told, word for word: the page is made from the same text the `get_guide` operation returns.
---

The guide invites and never requires: a single task with a title and a description is a valid plan. It is read with [`get_guide`](/docs/operations/get-guide/), from the command line with `vigile get-guide --topic examples`, and over MCP also as [resources and prompts](/docs/mcp/#the-guide-as-resources-and-prompts).

The examples in it are data that the tests run, call by call, so the guide cannot show a call that does not work.

{{guide-topics}}

## What Vigile holds and how it behaves {#overview}

{{guide overview}}

## Ways to organise work {#organising}

{{guide organising}}

## Working on tasks {#working}

{{guide working}}

## Examples to copy {#examples}

Each example lists calls in order, as they work on a new instance: the operation's name, then its input. Task IDs are numbered across the whole instance, so on an instance that already has tasks the IDs will differ: use the IDs that the calls return.

{{guide examples}}
