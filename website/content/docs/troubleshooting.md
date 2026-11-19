---
title: Troubleshooting
description: How to find out what is wrong with a Vigile instance. The doctor and what each of its checks means, the log of the service, and what to do when a command cannot reach its service or gets no answer.
card: The doctor and its checks, the log, and what to do when a command gets no answer.
lead: Start with the doctor. It checks the config file, the data and the running service, changes nothing, and says what to do about each thing it finds.
terminals: running
---

## The doctor

```sh terminal=your
vigile doctor
```

The commands here are typed in a terminal that is set up as [Install and first run](/docs/install/#in-every-terminal) leaves it, with the instance running. The doctor also works on an instance that is not running, and says so.

```text
  vigile doctor

  Config
  ✓ config file passes the check          /home/you/vigile/main/config.toml
  ✓ config file is private                readable by its owner only
  ✓ environment overrides are known       no stray VIGILE_ variables
  ✓ listen address is on this machine     127.0.0.1

  Data
  ✓ data folder is writable               /home/you/vigile/main/data
  ✓ disk has free space                   9.2 GB free
  ✓ store "default" can be written        /home/you/vigile/main/data/default.sqlite
  ✓ store "default" is intact             format 2, revision 5
  ✓ automatic backups are on              every 24 hours into /home/you/vigile/main/backups, the newest 30 of a tenant are kept; none taken yet, the first is due when the service runs

  Service
  ✓ service is running                    main {{=version}}, up 6s, process 4242
  ✓ admin key works
  ✓ port belongs to this instance         http://127.0.0.1:8700
  ✓ service holds the data folder         process 4242
  ✓ service runs the code on disk         started after the last change
  ✓ running settings match the config     no restart needed
  ✓ last automatic backup worked          none taken yet; the first is due 2026-01-13T09:14:03.120Z
  ✓ graph is consistent                   1 project, 3 tasks, 3 users, 6 links
  ✓ status timelines are consistent       each project and task has a timeline that ends with its status
  ✓ config users exist                    1 user with a key
  ✓ MCP endpoint answers                  http://127.0.0.1:8700/mcp lists {{=operations.count}} tools
  ✓ web page answers                      http://127.0.0.1:8700/
  ⚠ auth is off for non-admin users       no key needed to act as agent1
    → To require a key from everyone: vigile config set auth.keyless_user ""

  21 passed · 1 warning
```

It ends with an error when a check fails, so a script can go by it; `--json` gives the checks as JSON. A warning is not a failure.

### What the checks mean

| Check | When it is not passed |
|---|---|
| config file passes the check | The file has a setting that is none, a value of the wrong kind, no admin key. The line says what; fix it with `vigile config set` |
| config file is private | Other accounts can read the keys in it. The line gives the command that closes it |
| environment overrides are known | A `VIGILE_` variable matches no setting, usually a typo. It is ignored |
| listen address is on this machine | The service could not listen there. The line lists the addresses this machine has |
| data folder is writable, store can be written | The account that runs Vigile may not write there. Until it may, every change fails |
| disk has free space | Less than 100 MB are free. Writes fail when the disk is full |
| store is intact | The data file is damaged, or of a format newer than this version understands. Stop the service and [restore a backup](/docs/storage/#restoring-a-backup) |
| no restore is left half-done | A restore was interrupted. Start the service, or run the restore again: either puts the data in order |
| service is running | Nothing of this config answers. Start it with `vigile serve` |
| admin key works | The service refuses the key in the config. `vigile user reset-key admin` issues a new one |
| port belongs to this instance | Something else answers at the config's address |
| service holds the data folder | The process that answers is not the one that has the data |
| service runs the code on disk | The code was built after the service started. Restart it |
| running settings match the config | The config changed since the start. Restart the service for the change to apply |
| status timelines are consistent | A stored status timeline is damaged: it does not end with the status its item has. Restore from a backup |
| graph is consistent | The data has damage: a record that cannot be read, a link that leads nowhere. This is not about [problems in the plan](/how/problems/) |
| config users exist, each key is its user's own | The config has a key for a user that does not exist, or one that was not issued for its user. Such a key lets nobody in |
| MCP endpoint answers, web page answers | The service runs and one of its parts does not answer. Look at its log |
| auth is off for non-admin users | A warning, not a failure: connections without a key are let in. See [Security](/docs/security/) |

## The log {#the-log}

`serve` writes operations to its output, one line each: the operation, the caller, whether it reads or writes, how long it took and how it ended.

```text
2026-01-12T09:14:03.120Z op=set_task_status caller=agent1 kind=write ms=6.1 result=ok
2026-01-12T09:14:07.482Z op=set_task_status caller=agent2 kind=write ms=0.6 result=rule_violation rule=unfinished_dependencies
```

- `result` is `ok` or the [code](/docs/errors/#codes) of the error; `rule` names the rule that refused a change.
- With `log_level` at `info`, reads that succeed are left out. `debug` writes them too; `quiet` writes no lines for operations.
- What goes wrong inside the service is written at every level, with where it was thrown.
- Titles, descriptions and keys are never logged.

Vigile does not keep the log: send the output of `serve` wherever you keep logs.

## When a command cannot reach its service

| The command says | It means | Do |
|---|---|---|
| No Vigile service answers at the address | `not_running`: no service of this config is running. Nothing was sent | Start it: `vigile serve` |
| Something else answers there | `not_this_service`: another program has the port, or a service of another instance. Nothing was sent to it | Stop that program, or give this instance another port |
| The service runs at another address, or is not listening yet | `not_running`: a process holds the data folder and nothing answers at the config's address | Wait a moment, or check whether the service was started with other settings than the config's |
| No config file given | `usage` | Pass `--config <file>`, or set `VIGILE_CONFIG` |
| The config is not correct | `config_invalid`, with each thing that is wrong | Fix them with `vigile config set` |

## When a command gets no answer

A command ends with the code `no_answer`, and the exit code 2, when the service took the connection and its answer did not come: within 15 seconds, or because the connection ended first.

A change that was sent may then have been stored, or may be stored yet: the service carries out a request it has taken even after the connection has ended. So do not send it again straight away. First:

1. Look: `vigile get <id> --history` shows an item with the changes recorded in its history. A link, also one that gives a task to a user, is looked for in the history of the task.
2. Wait until the request is over: when the service's log has the line of its operation, or when the service has been stopped and started again.

Only then decide whether to send it again, knowing this:

- A change that names its item **by an ID together with a version** is stored only once, however often it is sent: of two such requests, the one that is carried out later is refused with a conflict.
- A request that takes no version is not held back by one. Creating a task or a project makes another each time it is carried out, and resetting a key replaces the key each time; a link that is there, or an item that is restored, is not made twice. [Which operations take a version](/docs/operations/#versions) says it of each. Do not send such a request again while an earlier one may still be outstanding.
- A request that names a user by its username acts on whoever has the name when it is carried out. Name the user by its ID to be sure.

## The service does not start

`serve` ends with exit code 1 and says why. Its code is `cannot_start`; for data of a format newer than this version understands it is `failed`. A start goes through four steps, and a start that failed has done the steps before the one that failed. So a failed start does not by itself mean that the data folder is as it was:

{{startup}}

Before starting it again, look: `vigile doctor` checks the config and the data, and says whether a restore was left half-done; what `serve` said tells which step failed.

| It says | Do |
|---|---|
| The port is already in use | Stop what is using it, or choose another: `vigile config set listen.port <port>` |
| Another Vigile service is already using the data folder | Stop that service, or point this one at another `data_dir`. One service per folder |
| This machine has no such address | Check `listen.address` |
| The config names a user that does not exist | Set `auth.keyless_user` to a user that exists, or to nothing |
| Vigile needs Node.js {{=node.needed}} or later | Run it with a newer Node.js |

## The page

- **The page does not update by itself.** That is the default, so that it does not change while you read. Turn on "Auto-refresh" in its settings.
- **The page asks for a key.** The instance requires one from everyone. Give it the key of a user; it is kept in that browser.
- **The page says it lost the service.** It keeps what it had on screen and finds the service again by itself once it answers.
- **History opens with filters already set.** The browser remembers the filters applied last. "Clear" empties and forgets them.
- **The graph is not drawn.** A graph of more than 300 items is drawn when asked for: press "Draw the graph".
