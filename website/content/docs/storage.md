---
title: Storage, backup and restore
nav: Storage and backups
description: Where a Vigile instance keeps its data, what each file in the data folder is, how to take a backup while the service runs, how to restore one, how to move an instance, and what to know when upgrading.
card: The files of an instance, backup, restore, moving and upgrading.
lead: An instance is one folder. This page says what is in it, how to back it up and bring it back, and how to move or upgrade it.
terminals: running
---

For how storing works, read [Storage, the data folder and backups](/how/storage/).

## The data folder

The data is in the folder named by the setting `data_dir`, which is relative to the folder of the config file: by default, `data/` next to `config.toml`.

| File | Is |
|---|---|
| `default.sqlite` | The plan: every item, link, history entry and status timeline, in one SQLite file |
| `default.sqlite-wal`, `default.sqlite-shm` | SQLite's own files beside it while the service runs: changes on their way into the data file. They belong to it |
| `vigile.hold` | The lock the running service holds on the folder. One service per folder |
| `vigile.lock` | Says which process has the folder, for people and for the doctor |
| `vigile.owner`, `vigile.files` | The service's and the commands' own locks. They hold nothing of the plan |
| `vigile-backups.json` | How the last automatic backup ended, kept over a restart. No backup and no data |
| `replaced-<date>/` | What a restore set aside. Yours to remove |

Beside the config file, `config.toml.hold` keeps two changes to the config from happening at once.

The service creates the folder on its first start, readable by your account only. Nothing is written anywhere else: nothing under your home folder, no cache, no state outside the instance.

## Backups

```sh terminal=your
vigile backup ~/backups
```

The commands here are typed in a terminal that is set up as [Install and first run](/docs/install/#in-every-terminal) leaves it, with the instance running.

```text
  ✓ default  /home/you/backups/default-20260112-091403-120.sqlite  20 KB

  1 tenant backed up. The config file, which holds the API keys, is not included.
```

- It writes a **consistent copy of the data while the service runs**, and also when it does not.
- The folder is created if needed. The copy is one file, named after the moment it was taken, to the millisecond, and readable by your account only.
- The **config file is not included**. It holds the API keys; keep a copy of it yourself if you want the keys back as well.
- A backup cannot go into the data folder itself.

The service takes backups by itself by default: every 24 hours, keeping the newest 30 for each tenant. [`backup.enabled`, `backup.every_hours`, `backup.keep` and `backup.folder`](/docs/configuration/#settings) change that schedule and retention. Use `vigile backup` when you also want a copy at a particular moment; arrange an outside schedule only for additional manual copies.

## Restoring a backup

```sh skip=placeholder
vigile restore-backup ~/backups/default-20260112-091403-120.sqlite
```

The file is the one a backup wrote: its name carries the moment it was taken, so yours is another.

- **Stop the service first.** The command refuses while one runs.
- The backup is checked before anything is touched: a file that is damaged, or that is not a backup, is refused.
- What was there is **not deleted**. It is moved to a folder `replaced-<date>` inside the data folder, for you to remove once the restored data is what you wanted.
- A restore that is killed half-way is put in order by the next start of the service, or by the next restore: finished if the backup was already in place, undone if not.
- The keys in the config file are those of now, and the data is that of then. A key that was issued or replaced after the backup was taken no longer counts for its user. The three built-in users are the exception: for them the key in the config counts whatever the data is, so restoring a backup does not take such a key away. The service says at its start which keys no longer count, and so does the doctor; `vigile user reset-key <username>` issues a new one.

Do not restore by copying a backup over the data file yourself. After a crash, SQLite keeps files beside the data that would be replayed onto the copy and break it.

`--tenant` says which data the file is a backup of when the file's name does not; a backup that kept the name `vigile backup` gave it needs no such option.

## Moving an instance

Stop the service and move the instance folder, config file and data folder, as one unit. A relative `data_dir` moves with it. To copy an instance that is running, take a backup and restore it into the copy.

## Several instances

Each instance has its own config file, data folder and port, and they share nothing. See [Configuration](/docs/configuration/#several-instances).

## Upgrading

Fetch the new code, build it, and start the service again; see [Updating](/docs/install/#updating). Take a backup first.

The data file carries the number of its **format**. This version writes format 2, which keeps each status an item went through as an entry of its own, beside the item. The doctor shows the format, with the revision of the plan:

```text
  ✓ store "default" is intact             format 2, revision 5
```

Data that an earlier version wrote in format 1 is brought to format 2 when the service first starts on it, and `serve` says so once, as a warning. Before that start, the doctor names the format and says that the service brings it to format 2 at its next start. After it, a version from before does not open the data. A backup taken before still restores: `restore-backup` brings its copy to format 2 and leaves the backup file as it is. So the backup taken before the first start of a new version is the way back to the version before.

A service does not open data in a format newer than it understands: it says so, and to upgrade the service. The command line and the service are released together and are meant to be of the same version.

## Durability

A change is confirmed only once it is stored, and the store is asked to write through to the disk before it answers: a confirmed change survives a power cut. A write that cannot be stored, because the disk is full or the file cannot be written, fails and is reported; the doctor checks for both.

## Stores

The data is kept by SQLite, the one built into Node.js, so there is no database to install and no native module to compile. The engine reaches it through a small contract that any store has to meet; the only other store today is one in memory, used by the tests.
