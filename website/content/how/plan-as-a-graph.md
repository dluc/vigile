---
title: The plan as a graph
nav: The plan as a graph
description: A Vigile plan is a graph of projects, tasks and users joined by links. A task that contains tasks is a group, a dependency is a link, and loops are refused.
card: Projects, tasks and users, joined by links. A task that holds tasks is a group.
lead: A plan is items and the links between them. Hierarchy is a link, order is a link, and who works on what is a link.
---

{{diagram plan-graph | A project holds a group and a task. The group holds three steps. Two steps depend on the one before, the launch depends on the whole group, and one step is assigned to an agent.}}

## Three kinds of item

- A **project** gathers the tasks of one product or goal. It has a status of its own and, usually, a prefix of 2 to 8 letters, such as `WEB`, that starts the IDs of the tasks created in it.
- A **task** is something to do. It has a title that says the outcome, a description that says how to tell it is finished, and optionally a reason, a type (a task, or a bug, an issue or an incident), a priority, a value and a size. [The model](/docs/model/#fields-of-a-task) lists the fields.
- A **user** is a person or an agent. Tasks are assigned to users, and every change is recorded under the user that made it.

Nothing but a task is required. A task with a title and a description, in no project and no group, is a valid plan.

## Links

Items are joined by links. A link has a type, and the type decides what Vigile does because the link exists.

{{link-types}}

Each link is stored once, under its forward name. Either name can be used when making or removing one: "A is contained B" is stored as "B contains A".

A link that would close a loop is refused when it is made, for "contains" and for "depends on" together: a task cannot be inside a group that waits for it, however long the way round is. The refusal shows the path.

## Groups

There is no separate kind of item for a feature, an epic or a release. **A task that contains other tasks is a group.** Create the task for the feature, then create its steps with `parent` set to it.

- Groups hold groups, as deep as the work is, and a task can be in several at once.
- A group reports its **progress**: how many of the tasks inside it are finished, at any depth. So does a project.
- A group does not close by itself. Whoever owns it sets it to done once its parts are done, and marking it done over unfinished tasks is refused.
- Depending on a group waits for all of it with one link.

## What the shape of the plan tells you {#reading-the-plan}

A plan that is held as a graph can be looked at whole, and the whole says how the work is cut, beyond how far along it is. Vigile does not rate a plan. It flags [contradictions](/how/problems/), and shows the rest for a person to read on [the board and the graph](/docs/web-page/), and for an agent to read through the same lists.

| To notice | A person looks at | An agent calls |
|---|---|---|
| Work that belongs nowhere | The graph: a task in no group lies loose in its project's box, and a task in no project outside every box | [`list_tasks`](/docs/operations/list-tasks/) with `top_level`, which lists the groups and the ungrouped tasks; a task's `contained_in` |
| Groups that are too wide or too thin | The groups with their progress, as "1/4 done" on a card, and the graph with its groups collapsed | `list_tasks` with `top_level`, then with `parent` to look into one group |
| Too many unrelated things in progress | The "in progress" column of the board: each card with its priority, who has it, and its group and project | `list_tasks` with `status` set to `in_progress`: each task with its `priority`, `assigned_to` and `contained_in` |
| Work that hangs on much else | The arrows of the graph | `depends_on` and `waiting_for` of each task, and [`get`](/docs/operations/get/) for its links in both directions |

## Order is never stored

There is no position of a task among its neighbours to keep up to date. Dependencies decide whether work can start. Among active paths, `list_next_tasks` compares priority from the outermost group through nested groups to the task; a task in several groups uses its highest active path. Where a path still leaves several tasks, whoever picks chooses with value and size.

## IDs

IDs are given by the service: `WEB` for a project, after its prefix; `WEB-012` for a task created in it, which keeps that ID when it is moved; `USER-004` for a user. A number is given once, and so is a prefix, so an ID never comes to mean something else. [The model](/docs/model/#ids) has the details.

## Reference

- [The model](/docs/model/): every field, type, link type and limit.
- Operations: [`create_project`](/docs/operations/create-project/), [`create_task`](/docs/operations/create-task/), [`add_link`](/docs/operations/add-link/), [`list_tasks`](/docs/operations/list-tasks/).
- [The guide for agents](/docs/guide/) has complete examples of each shape.
