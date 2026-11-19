---
title: The vision
nav: Vision
description: What Vigile is for. A shared planning and coordination layer for people and AI agents, what of it can be used today, what is a direction that is not built, and why what is built makes the direction credible.
card: What Vigile is for, what of it is real today, and what is direction.
lead: Vigile is a planning and coordination layer for people and agents who work together. Each part of that is marked here as usable today, or as a direction that is not built.
---

## The idea {#idea}

People and agents increasingly work together. A longer list does not coordinate them; one observable plan can, when everyone shares its rules.

Vigile holds outcomes, containment, dependencies, responsibility, state and history in one graph. People, agents and programs use the same checked operations. It is not only an issue tracker or an agent screen, but **the control plane of coordinated work**.

## Who it is for {#who}

{{horizons Who | What they have
Today | A lead or an engineer who coordinates several agents and a few people | One service on one machine, or on a network they trust: [everything this site documents](/docs/).
Mixed | A product or engineering team with parallel work and dependencies | Today, one plan where whoever is let in may change all of it. Access by team is a direction.
Direction | A platform team that governs many agents | Today each agent can have a user and a key of its own. Rules that a platform sets for its agents are not built.
Direction | An organisation that needs one plan across teams and tools | Not built. An instance is one plan in one place, with no link to other tools.
}}

## It guides, and does not only store {#guides}

A plan that agents work from has to lead them to plan well and keep moving, by what it teaches and by how its tools behave.

{{horizons How | What there is
Today | Guidance | One loop, taught by [what an agent is told on connecting](/docs/mcp/#what-an-agent-is-told), [the guide](/docs/guide/#working) and each tool's description: read the plan from the top, ask what is next, read the task and its version, start only when the work starts, keep statuses and structure true, finish when the work is shown to work.
Today | How the tools behave | A stale or unsafe move is hard to make. [Changing a task names the version the change was based on](/how/versions-and-history/), a task [cannot start before what it depends on](/how/statuses/), and [`list_next_tasks`](/docs/operations/list-next-tasks/) answers from each task's priority, its dependencies and who has it. A refusal names its rule and actions that lead out.
Today | Area priority directs next work | [`list_next_tasks`](/docs/operations/list-next-tasks/) compares priority from the outermost group to the task and returns that path.
Direction | An observer of plan health that nudges | Not built. Today [the shape of the plan](/how/plan-as-a-graph/#reading-the-plan) is there for whoever looks.
Direction | Guidance fitted to an agent's role and state, measured by evaluations of agents | Not built. Today the guide is the same text for every caller.
}}

## What it changes {#scenarios}

{{horizons Moment | What happens
Mixed | A dependency between two teams is visible | Today a task can wait for a task, or a whole project, elsewhere in the same plan, and [the graph](/docs/web-page/#the-graph) draws the arrow. Across plans that are kept apart, it is a direction.
Mixed | A stale claim is noticed | Today [`list_stale_tasks`](/docs/operations/list-stale-tasks/) finds assigned work quiet for 24 hours, on demand. A proactive observer is direction; neither releases or reassigns it.
Mixed | A policy refuses a move that conflicts | Today the built-in rules do, and of two agents that take one task [one is refused](/how/versions-and-history/#taking-a-task). Rules that a team sets for itself are a direction.
Today | Decisions and history survive a handoff | The description, the reason, each status and who changed what stay with the task. The next agent or person reads them with [`get`](/docs/operations/get/).
}}

## Why the ceiling is higher than the product {#why-credible}

Each direction rests on a choice that is real and can be checked.

{{bridges
One definition of an operation makes its MCP tool, its HTTP endpoint, its command and its page here: [one contract](/how/interfaces/#one-contract). | An integration, or one more interface, written once against the same rules.
The plan is [a graph](/how/plan-as-a-graph/) of items and typed links; next, waiting and progress are [worked out from it](/how/next-and-waiting/). | Views across many projects and teams, and an observer that reads the same graph.
Every change is checked in one place and [refused with its rule](/how/statuses/#what-a-refusal-carries). | Rules that a team sets, and automation that may do only what they allow.
[Versions and history](/how/versions-and-history/): who did what, on which version, is kept. | Many actors on one plan, and the evidence an observer goes by.
The engine reaches its data through a contract that [a second store already meets](/docs/storage/#stores). | A store for a hosted service.
[A line in the log](/docs/troubleshooting/#the-log) for each change, and [a stream](/docs/http-api/#the-stream-of-changes) that says when the plan has changed. | Watching a plan from outside, without asking the agents.
[Users of three types](/how/users-and-access/#users), each under a key of its own. | Access by team.
}}

## The directions {#directions}

:::direction
None of these is built, none is promised and none has a date. They are where this design could go.

- **Access by team:** who may see and change which part of a plan.
- **A hosted service:** the same operations, without running the process yourself.
- **Integrations and sync:** a plan that stays in step with other tools.
- **An observer of plan health, with suggestions:** lack of focus, weak grouping and stale claims, said unasked.
- **Controlled automation:** agents that change the plan within rules a team sets.
- **Views across projects and teams:** one picture of many plans.
:::

## What it is today {#today}

:::today
Version {{=version}}: one service that you run yourself. It has [no TLS of its own](/docs/security/#there-is-no-tls) and no access by team; its web page mostly reads, with −/+ controls for task priority; and it has no importer from other tools. [Try it](/#start), or read [what it does not do](/#limits).
:::
