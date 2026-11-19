---
title: Storage, the data folder and backups
nav: Storage and backups
description: How Vigile stores a plan. The store is the authority and memory is a working copy, a change is one step that is stored whole or not at all, an instance is one folder, and a backup is taken while the service runs.
card: One SQLite file in one folder, each change stored whole, backups while it runs.
lead: The plan lives in one SQLite file in one folder. The service works from a copy of its items and links in memory, and stores every change as one step before it confirms it.
terminals: running
---

{{diagram storage | A change is checked against the plan in memory, stored as one step, and only then applied to memory and announced. Lists, links and what is worked out of them are answered from memory; a description, the history and the status timeline are read from the store.}}

## The store decides; memory is a working copy

When the service starts, it loads the items and links of the plan into memory. Lists, and next, waiting and problems, are answered from there, which is what makes it cheap to work them out each time they are read. A description, the history of an item and the statuses it went through are not kept in memory: [`get`](/docs/operations/get/) reads them from the store when it is asked.

A change goes one at a time:

1. It is **checked** against the plan in memory: the version, the rules, the links.
2. It is **stored as one step**: the item, its links, its history, its status timeline and the counters, all or nothing. The step is tied to the revision of the plan it was checked against, so the service can never write over a plan it has not seen.
3. Memory is brought up to date, and listeners are told that the plan has changed.

A change is confirmed only after step 2. **A confirmed change survives a power cut**: the store is asked to write through to the disk before it answers.

## An instance is one folder

```text
main/
  config.toml           the settings and the API keys; readable by your account only
  config.toml.hold      keeps two changes to the config from happening at once
  data/
    default.sqlite      the plan
    default.sqlite-wal  changes on their way into it, while the service runs
    default.sqlite-shm
    vigile.hold         held by the running service: one service per folder
    vigile.lock         says which process that is
```

There is no default location and nothing is written anywhere else. To move an instance, stop the service and move the folder as one. To copy one that is running, take a backup.

## Backups

The service takes a complete backup set by itself every 24 hours by default and keeps the newest 30. The interval, folder, retention and whether automatic backups run are settings. Requests continue while a backup is written; a failed backup is reported and retried without stopping the service.

```sh terminal=your
vigile backup ~/backups
```

writes a consistent copy of the data into the folder **while the service runs**. The copy is one file, named after the moment it was taken. The config file, which holds the API keys, is not included.

## Restoring

```sh skip=placeholder
vigile restore-backup ~/backups/default-20260112-091403-120.sqlite
```

puts a backup in the place of the data, while the service is stopped. What was there is not deleted: it is moved to a folder `replaced-<date>` inside the data folder, for you to remove once the restored plan is what you wanted. A restore that is killed half-way is put in order by the next start.

Do not restore by copying a backup over the data file by hand. After a crash, the files beside the data would be replayed onto the copy and break it.

## What is not stored

Next, waiting, progress and problems are never stored. They are worked out from statuses and links when read, so there is no second copy of anything that could disagree with the first.

The engine itself does not know SQLite: it reaches the store through a small contract, which a second store, in memory, meets for the tests.

## Reference

- [Storage, backup and restore](/docs/storage/): the commands, the files, moving and upgrading.
- The commands above are typed in a terminal set up as [Install and first run](/docs/install/#in-every-terminal) leaves it. The name of a backup carries the moment it was taken, so yours is another.
- [`vigile backup`](/docs/cli/#backup), [`vigile restore-backup`](/docs/cli/#restore-backup), [`vigile doctor`](/docs/cli/#doctor).
