---
title: The command line
description: The vigile command. How it finds its instance, the commands that run and set up the service, a command for every operation, output for people and for scripts, and what its exit codes mean.
card: Every command and option of vigile, its output for scripts, and its exit codes.
lead: One command, `vigile`, runs the service, sets it up, and is a client of it. Every operation of the plan is a command of the same name.
terminals: running-demo
---

## How a command is read

`vigile` goes by its first words. `serve` starts the service. `config`, `doctor`, `backup` and `restore-backup` work on the files of an instance. `user` and every operation call the running service over HTTP.

```sh terminal=your
vigile list-tasks --project WEB --status open
vigile set-task-status --id WEB-005 --version 1 --status in_progress --as agent1
vigile get WEB-005 --json
vigile help set-task-status
```

The commands here are typed in a terminal that is set up as [Install and first run](/docs/install/#in-every-terminal) leaves it, with the instance running. The plan in them is the made-up one the pictures show.

Every command takes these two options:

{{everywhere-options}}

- **There is no default instance.** A command without `--config` and without `VIGILE_CONFIG` stops and says so.
- `vigile help` lists the commands. `vigile help <command>` and `vigile <command> --help` show what one command takes: `vigile help user`, `vigile help config set`, `vigile help create-task`. A name that is no command is an error that lists what there is.
- `vigile --version` prints the version.
- An option may be written `--name value` or `--name=value`. A yes/no option stands alone, or says which: `--draft`, `--draft false`. Two hyphens alone end the options: what follows is taken as words.

## Run {#run}

{{command serve}}

Each setting can be given for one run, as in `--listen.port 8701`. What a run is started with holds for the whole run. `serve` prints the addresses of the service and then a line for each change and each call that fails: see [the log](/docs/troubleshooting/#the-log). With `--json`, a failure to start is reported as JSON; what it prints while it runs is the service's log.

It runs in the foreground. Ctrl-C, or a `SIGTERM`, finishes the write in flight and stops. A second `serve` on the same data folder refuses to start.

{{command doctor}}

See [Troubleshooting](/docs/troubleshooting/) for what it checks.

{{command backup}}

The config file, which holds the API keys, is not included. A backup cannot be written into the data folder itself. See [Backups](/docs/storage/#backups).

{{command restore-backup}}

What was there is set aside, not deleted. See [Restoring a backup](/docs/storage/#restoring-a-backup).

## Set up {#set-up}

{{command config init}}

{{command config show}}

Keys are masked.

{{command config set}}

The value is checked before it is written, and a value that fails the check is never written. See [Configuration](/docs/configuration/) for each setting and for when a change applies.

For `auth.keyless_user` the running service is asked whether there is such a user. When no service runs on the config's data, the setting is written unchecked, with a warning. When the service cannot be asked for any other reason, because it does not answer, because something else answers at its address, or because the config names another machine's address, nothing is written.

{{command config unset}}

{{command config path}}

{{command user add}}

It prints the new key, once, and the settings to paste into that agent's MCP configuration. The key applies at once, without a restart.

{{command user remove}}

{{command user reset-key}}

For `admin` it also works when no service runs on the config's data, or when the service refuses the admin key: the new key is then written straight to the config file. When the service is there and does not answer, no key is written: the reset may still be carried out.

{{command user list}}

{{command describe}}

The reference pages of this documentation are made from what it prints.

{{command help}}

## A command for every operation {#operations}

Each of the {{=operations.count}} [operations](/docs/operations/) is a command: its name with hyphens for underscores, and an option for each field of its input.

```sh terminal=your
vigile create-task --project WEB --title "Cart page lists the items and the total" \
  --description "Done when the total is right." --depends-on WEB-001,WEB-004
```

- **Commands act as `admin`** unless given `--as <username>`.
- The first word that is not an option is the item the command is about: `vigile get WEB-002` is `vigile get --id WEB-002`.
- A field that takes a list is given with commas: `--depends-on WEB-001,WEB-004`.
- A field that can be cleared takes `null`: `--why null`.
- An option of an operation may be written with hyphens or underscores: `--depends-on` and `--depends_on` are the same.
- A value with spaces needs quotes.

{{operation-commands}}

## Output, for people and for scripts

Without `--json`, a command prints its result in words and columns, in colour when the output is a terminal and plain when it is piped. A refusal is printed with the items in the way and the actions, where it has them:

```text
✗ Task WEB-003 cannot be started: it is waiting for a dependency to finish.
  · WEB-002  Cart page lists the items and the total  open
  → Finish or cancel the items it depends on.
  → Or call remove_link with type "depends on" if the dependency no longer applies.
  → Or call list_next_tasks to pick work that can start now.
```

With `--json`, a command prints nothing but JSON: its result on the standard output, as the service gave it, or its failure on the error output, as `{"error": {"code", "message"}}`, with `actions` when there is something to do. That holds for every failure, also those of the command line itself; see [the codes of the command line](/docs/errors/#the-command-line-s-own-codes).

Before a command says anything in words about an answer, it checks that the answer is the one its operation gives to that call. Any other answer to a change is reported as an outcome that is not known; any other answer to a question as no answer to it. With `--json` the answer is passed on as it came, for the script to judge.

## Exit codes

| Code | Means |
|---|---|
| `0` | The command did what it was asked. |
| `1` | The command reports a failure. Read the error before trying again: it says what happened, and what to do. |
| `2` | The service took the connection and its answer did not come, within 15 seconds or because the connection ended first. The code in the error is `no_answer`. |

**An exit code of 1 does not by itself say that nothing was changed.** Mostly nothing was, and in a few cases something was; the error tells them apart:

{{error-outcomes}}

And the errors of the command line itself:

| The error | What was changed |
|---|---|
| `usage`, `not_running`, `not_this_service`, `config_invalid`, `config_busy` | Nothing. Nothing was sent to a service, and nothing was written |
| `cannot_start` | It depends on how far the start had come: [the steps of a start](/docs/troubleshooting/#the-service-does-not-start) say what has happened by each |
| "Whether it was done is not known": the answer was not the one the operation gives | Not known. Look at the item with `vigile get <id> --history` before sending the change again |
| A change to the config that ends with an error saying that the change is in place | The change. It was written, and the system could not confirm that it will survive a power cut |

So a script that gets 1 reads the code and the message, with `--json` as `{"error": {"code", "message"}}`, and goes by them. It does not send a change again only because the exit code was 1.

After `2`, a change that was sent may have been stored, or may be stored yet: the service carries out a request it has taken even after the connection has ended. The message says so, and how to look: `vigile get <id> --history` shows an item with the changes recorded in its history. See [When a command gets no answer](/docs/troubleshooting/#when-a-command-gets-no-answer).

## The command line and its service

A command takes its key from the config file, and first makes sure that what answers on the config's port is the service of this config: a running service holds the config's data folder, and what answers says it is a Vigile service of the config's `name`. If something else has the port, the command stops, says so, and has sent it nothing.

After a change of `name`, `data_dir` or `[listen]` in the config, the commands that call the service do not, until the service is started again: it is still what it was started as, and no longer what the config describes.

The command line never opens the data files to change them. Only `doctor` and `backup` open them, to read, and `restore-backup` replaces them while no service runs.
