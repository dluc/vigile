---
title: Problems the plan finds in itself
nav: Problems
description: A change that is allowed can still leave a Vigile plan inconsistent somewhere else. The plan works out these contradictions on every read and flags them on the tasks and projects they concern.
card: What the plan says when a rightful change leaves something else wrong.
lead: A rule refuses a change that is wrong at the moment it is made. A problem is what is left when a change that was right makes something else wrong.
---

{{diagram problems | The search box went to review while the nightly index was done. Then the index was reopened. Nothing was refused: reopening is allowed. The search box now says that it depends on unfinished work, and its project says that it holds a task with a problem.}}

## How a problem comes about

Reopening a done task is allowed. So is restoring an existing task inside a done group, or marking a project ready while work in it is still open. Each can contradict something that was true a moment ago. New contents cannot be added to a done group: reopen the group first.

Vigile does not forbid them and does not quietly change other items to match. It **says so**, on the item that is now in question, for as long as it holds:

{{problems}}

A problem goes away by itself when its cause does: finish the dependency again, and the flag is gone at the next read.

## Where problems show

- A task or a project that an operation answers with, in short or in full, carries `has_problems`, and when it is true, `problems`: a code and a sentence for each. The items named under `links` and `blocking` do not.
- [`list_tasks`](/docs/operations/list-tasks/) and [`list_projects`](/docs/operations/list-projects/) take `has_problems` to list only those.
- On the page, a task's card and a project's card with a problem carry a warning, the counts of the board say how many items have problems and show only those when chosen, and the panel of the item says what is wrong.

{{picture problem | A task in review whose dependency was reopened. The panel says that its status is in_review but it depends on work that is not finished. Behind the panel, the card of its project carries a warning mark.}}

## A problem is not damage

Problems are about the plan: statements in it that no longer fit together. They are worked out from sound data.

Nor is a problem a judgement of the plan. Work in no group, or too much started at once, contradicts nothing and is not flagged: [the shape of the plan](/how/plan-as-a-graph/#reading-the-plan) shows it to whoever looks.

Damage is something else: a record that cannot be read, a link that leads nowhere. That is what the [doctor](/docs/troubleshooting/) looks for when it checks that the graph is consistent.

## Reference

- [The model](/docs/model/#problems): the problem codes.
- [Statuses and the rules of moving](/how/statuses/): what is refused outright.
