---
title: Configuration
description: Every setting of a Vigile instance, with its default, its environment variable and when a change applies. The config is one TOML file, changed with vigile config set, which checks each value first.
card: Every setting, its default, its environment variable, and when a change applies.
lead: An instance is configured in one TOML file. Change it with `vigile config set`, which checks the value before writing it.
terminals: running
---

## The file

{{config-example}}

`vigile config init` writes it, with a new admin key, readable by your account only. Every command is told where it is with `--config <file>` or the `VIGILE_CONFIG` variable; there is no default location.

## Settings

{{settings}}

What the settings mean in use:

- **`name`** is how the instance calls itself: on the page, at startup, and to the command line, which checks it before sending a key.
- **`data_dir`** is where the data lives. A relative path starts at the folder of the config file, so by default the data is in `data/` next to `config.toml`.
- **`log_level`**: `info` writes a line for every change and for every call that fails; `debug` also for every read; `quiet` writes no lines for operations. What goes wrong inside the service is written at every level.
- **`listen.address`** is `127.0.0.1` unless you change it: the service answers to this machine only. Read [Security](/docs/security/) before setting another.
- **`auth.keyless_user`** is who a connection without a key acts as. Empty, every connection needs a key. It cannot be `admin`, and it has to be a user that exists.

API keys, under `[auth.keys]`, are not settings to set by hand: they are made and removed with [`vigile user`](/docs/cli/#user-add).

## Tasks, decisions or both {#features}

`features` is what the instance offers: `tasks`, `decisions` or both.

- **Left out**, as `config init` leaves it, every feature of the installed version is on, also after an upgrade that brings a new one.
- **A list** turns on what it names and nothing else. `features = ["decisions"]` makes an instance that keeps decisions for a team whose tasks are elsewhere; `features = ["tasks"]` one without decisions.
- **An empty list** is refused, and the service does not start with it.

Set it with `vigile config set features decisions`, and name both as `tasks,decisions`; `vigile config unset features` is back to everything. It applies when the service starts.

The MCP tools, the guide, the HTTP API, the commands and the page all follow the setting, and a call to what is off is refused without writing.

- **Decisions alone.** The decision operations, and with them projects, links, history and users. A project gives decisions their prefix and is what an "affects" link can lead to. No operation on tasks is offered, an agent that connects is told how to keep the register, and [the register](/docs/web-page/#decisions) is the home page.
- **Tasks alone.** No decision operation and no "affects" link type, and the page has no "Decisions".

Turning a feature off deletes nothing: its items and links are kept, out of sight, and are there again when it is turned on.

## Changing a setting

```sh terminal=your
vigile config set auth.keyless_user ""
vigile config unset log_level
vigile config set listen.port 8701
vigile config show
```

The commands here are typed in a terminal that is set up as [Install and first run](/docs/install/#in-every-terminal) leaves it, with the instance running.

The change of the port comes last for a reason: once the config names another port than the one the service runs on, the commands that ask the running service no longer reach it until it is started again. That is every operation, such as `vigile list-tasks`, and `config set auth.keyless_user` with a username, which asks the service whether there is such a user.

- `config set` checks the value and writes it. A value that fails the check is never written. One setting is checked by asking the service: `auth.keyless_user`. When no service runs on the config's data it is written unchecked, with a warning, and the service does not start while it names a user that does not exist.
- `config unset` removes a setting, so that its default applies.
- `config show` prints the values in effect and where each came from: the file, the environment, an option, or the default. Keys are masked.

The same check runs when a value is set, when the service starts, and in the doctor. A config that fails it never starts the service. It refuses a name that is no setting, a value of the wrong kind, a missing admin key, and two users with the same key.

## When a change applies

- **Users and keys** (`[auth]`) apply at once, without a restart.
- **Everything else** (`features`, `name`, `data_dir`, `log_level`, `[listen]`, `[backup]`) applies when the service starts. Stop it and run `vigile serve` again.

Until the restart, after a change of `name`, `data_dir` or `[listen]`, the commands that call the service do not: it is still what it was started as, and no longer what the config describes. The doctor's check "running settings match the config" says when a restart is due.

## For one run

A setting can be overridden for one run, without touching the file, by its environment variable or by an option of `serve`:

```sh skip=second-service
VIGILE_LISTEN_PORT=8701 vigile serve
vigile serve --listen.port 8701
```

Either line starts the service, so they are two ways to do one thing, for an instance that is not running.

An option wins over the environment, and the environment over the file. What a run is started with holds for the whole run. A `VIGILE_` variable that is no setting is ignored, and the doctor points it out.

## How the file is written

The command line and the running service both write this file, each change as a whole, so the file is rebuilt from its settings every time: **comments written into it by hand are not kept.** A file that is a link to one kept elsewhere stays a link.

The empty file `config.toml.hold` beside it is what keeps two changes from happening at once. Leave it where it is.

## Several instances

Each instance has its own config file, data folder and port, and they share nothing:

```sh terminal=your
vigile config init --config ~/vigile/second/config.toml --name second --port 8701
```
