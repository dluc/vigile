---
title: Install and first run
nav: Install and first run
description: Install Vigile from its source, create an instance, start the service, open the board and connect a first agent. Needs Node.js 22.13 or later and pnpm.
card: From nothing to a running service, a board in the browser and an agent connected.
lead: From nothing to a running service with a board in your browser and an agent connected. There is no database server to install and no account to make; the code is compiled once, with one command.
terminals: fresh
---

## What you need

- **Node.js {{=node.needed}} or later**, which has SQLite built in.
- **pnpm**, to install the dependencies and build.
- **git**, to fetch the code.

Vigile is developed and tested on Linux with Node.js 22. Nothing in it is specific to Linux, but other systems are untested.

## Get it and build it

The examples keep the code in `~/code/vigile`. If yours is elsewhere, put your folder in the place of that path wherever it comes up.

```sh skip=network
git clone {{=repo.url}}.git ~/code/vigile
cd ~/code/vigile
pnpm install
pnpm build
```

`pnpm build` compiles the TypeScript of the packages; until it has run, there is no command to start. `bin/vigile` in that folder runs the built command.

## In every terminal {#in-every-terminal}

The examples in this documentation call the command `vigile`, and name the instance once instead of with every command. For that, every terminal you use needs these two lines, typed again in each new one:

```sh terminal=first
export PATH="$HOME/code/vigile/bin:$PATH"
export VIGILE_CONFIG=~/vigile/main/config.toml
```

The first puts `vigile` on the `PATH`. The second says which instance a command acts on: there is no default location, and a command that is told of none stops and says so. `--config <file>` on a command does the same for that one command. To have both lines in every terminal without typing them, add them to your shell's start-up file.

```sh terminal=first
vigile --version
```

## Create an instance

An instance is one config file and the data folder next to it. In the same terminal:

```sh terminal=first
vigile config init --name main
```

```text
  Config created

  File       /home/you/vigile/main/config.toml
  Name       main
  Listen     127.0.0.1:8700
  Admin key  vig_...

  ✓ The file is readable by your account only. The admin key is stored in it; the CLI reads it from there.
```

`config init` writes the file that `VIGILE_CONFIG` names, with a new admin API key in it, readable by your account only. It refuses to replace a file that is already there.

## Start the service

Still in the first terminal, which the service then keeps:

```sh terminal=first stays=running
vigile serve
```

```text
  vigile {{=version}}  main

  MCP      http://127.0.0.1:8700/mcp
  Web      http://127.0.0.1:8700/
  API      http://127.0.0.1:8700/api
  Config   /home/you/vigile/main/config.toml
  Data     /home/you/vigile/main/data
  Backups  every 24 hours into /home/you/vigile/main/backups; none taken yet, next due now

  ⚠ Auth is off for everyone but admin: a connection without an API key acts as agent1.
    To require a key from everyone: vigile config set auth.keyless_user ""
```

`serve` runs in the foreground until it is stopped with Ctrl-C. The warning is the default, and it is fine while the service listens on `127.0.0.1`: before other machines can reach it, read [Security](/docs/security/).

## Open the board

Open the Web address in a browser. With no tasks yet, the board is empty. See [the web page](/docs/web-page/) for what it shows once there is a plan.

## Connect an agent

Point an agent at the MCP address. Most clients take a setting of this form:

```json
{
  "mcpServers": {
    "vigile": { "type": "http", "url": "http://127.0.0.1:8700/mcp" }
  }
}
```

That is all one agent on your own machine needs. It connects as the built-in user `agent1`, with no key, is told the routine for working on tasks, and gets a tool for each operation. [MCP for agents](/docs/mcp/) has the details, and what to do for several agents.

## A first plan, from the command line

Everything an agent can do, the command line can do. Open a second terminal, since the first one is taken by the service, and start with the two lines every terminal needs:

```sh terminal=second
export PATH="$HOME/code/vigile/bin:$PATH"
export VIGILE_CONFIG=~/vigile/main/config.toml
```

```sh terminal=second
vigile create-project --title "Website relaunch" --prefix WEB
vigile create-task --project WEB \
  --title "Checkout: a customer can pay for a basket" \
  --description "Done when a test order goes through."
vigile create-task --project WEB --parent WEB-001 \
  --title "Cart page lists the items and the total" \
  --description "Done when the total is right."
vigile create-task --project WEB --parent WEB-001 \
  --title "Payment form takes a card" \
  --description "Done when a test card is charged." --depends-on WEB-002
vigile list-next-tasks
```

```text
  ID       TYPE  PRIORITY  VALUE  SIZE  ASSIGNED  TITLE
  WEB-001  –            0      –     –  –         Checkout: a customer can pay for a basket  (0/2)
  WEB-002  –            0      –     –  –         Cart page lists the items and the total

  2 tasks can be started now
```

`list-next-tasks` shows the group and the cart page: the payment form waits for the cart page. Reload the page in the browser to see the same on the board and in the graph.

To throw all of it away, stop the service with Ctrl-C in the first terminal and delete the folder `~/vigile/main`. Nothing else was written.

## Check it

In the second terminal:

```sh terminal=second
vigile doctor
```

It checks the config file, the data and the running service, and changes nothing. See [Troubleshooting](/docs/troubleshooting/).

## Updating

Take a [backup](/docs/storage/#backups) first. Then fetch the new code and build it, and stop the service and start it again:

```sh skip=network
cd ~/code/vigile
git pull
pnpm install
pnpm build
```

A running service goes on running the code it was started with. The doctor says so: its check "service runs the code on disk" fails until the service is restarted.

A version that brings a new feature, as [decisions](/how/plan-as-a-graph/#decisions) were, turns it on for an instance whose config does not name its `features`. One that names them keeps what it names: see [Tasks, decisions or both](/docs/configuration/#features).

## Next

- [Several agents, each with its own user and key](/docs/mcp/#several-agents).
- [Before the service faces a network](/docs/security/#before-it-faces-a-network).
- [Backups](/docs/storage/#backups).
- [Decisions](/how/plan-as-a-graph/#decisions): keep the choices behind the work in the plan, or run an instance for them alone.
- [How it works](/how/), if you have not read it.
