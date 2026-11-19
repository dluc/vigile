---
title: Statuses and the rules of moving
nav: Statuses and moves
description: The seven statuses of a task in Vigile, the moves allowed between them, the rules that refuse a wrong move, and what a refusal carries.
card: Seven statuses, the moves allowed between them, and what a refusal carries.
lead: A status says what is really happening to a task, and others read it to decide what to do. So the service checks every move, and refuses the ones that would make the plan untrue.
---

## The statuses of a task

{{statuses-diagram}}

{{task-statuses}}

## What is checked when a task moves

A change of status goes through [`set_task_status`](/docs/operations/set-task-status/), and is refused when:

1. **The task is already in that status.** History gets no empty entries. For `in_progress` this is what keeps two agents from taking one task: the second is told that it is in progress, and whether it is assigned to others or to nobody.
2. **The move is not one of those above.** A draft cannot go straight to done; a done task can only be reopened.
3. **It is being started or finished while something it depends on is unfinished.** The refusal names the items in the way.
4. **It is being finished while it contains unfinished tasks,** at any depth. A group is closed only over finished work.
5. **It is being started by someone it is not assigned to.** Taking work over is a change of its `assigned to` link, made on purpose.
6. **It is being cancelled while it contains tasks in progress or in review,** at any depth. Work that is under way is finished or moved out first.

What else happens with a move:

- Starting a task that is assigned to nobody assigns it to whoever starts it.
- A task that is done or cancelled is **finished**: it stops holding back what depends on it.
- Reopening a done task keeps the earlier completion in its timeline and history.
- Each status a task goes through is kept, with when and by whom.

## What a refusal carries

A refusal is not only a "no". It carries the rule that refused the change and actions that would resolve it, and with some rules the items in the way:

```json
{
  "error": {
    "code": "rule_violation",
    "message": "Task WEB-003 cannot be started: it is waiting for a dependency to finish.",
    "rule": "unfinished_dependencies",
    "blocking": [
      { "kind": "task", "id": "WEB-002", "title": "Cart page lists the items and the total", "status": "open" }
    ],
    "actions": [
      "Finish or cancel the items it depends on.",
      "Or call remove_link with type \"depends on\" if the dependency no longer applies.",
      "Or call list_next_tasks to pick work that can start now."
    ]
  }
}
```

It is the same over MCP, over HTTP and on the command line, where it is printed in words. An agent that follows one of the actions gets on; one that repeats the same call is refused again.

## The statuses of a project

{{project-statuses}}

Any move between them is allowed, other than to the status the project already has. Marking a project ready while it holds unfinished tasks is allowed too: it shows up as a [problem](/how/problems/) on the project, not as a refusal.

## Reference

- [Errors and refusals](/docs/errors/): every code and every rule.
- [The model](/docs/model/#moves): the moves as a table, from each status to each.
- Operations: [`set_task_status`](/docs/operations/set-task-status/), [`set_project_status`](/docs/operations/set-project-status/).
