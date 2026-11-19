---
title: One service, one folder
nav: One service
description: A Vigile instance is one process that serves MCP, the HTTP API and the web page on one port, and holds one data folder. A second service on the same folder refuses to start.
card: One process on one port holds one data folder. A second one is refused.
lead: There is no cluster, no worker, no database server. One process holds the plan and answers everyone.
terminals: running
---

{{diagram one-service | One process listens on one port for agents, programs and browsers, and holds the data folder. A second process that is started on the same folder is refused.}}

## One process, one port

`vigile serve` starts the whole service: the MCP endpoint, the HTTP API and the page, on one address and port. It prints where each is:

```text
  vigile {{=version}}  main

  MCP      http://127.0.0.1:8700/mcp
  Web      http://127.0.0.1:8700/
  API      http://127.0.0.1:8700/api
```

It runs in the foreground. Vigile does not install itself as a service: run it under whatever keeps processes alive on your machine. Ctrl-C, or a `SIGTERM`, finishes the write in flight and stops.

## One service per data folder

The service keeps the items and links of the plan in memory. Two services on the same data would each work from their own copy, and each would be wrong about what the other did. So the running service **holds the data folder**, through a lock the operating system keeps for as long as the process lives:

- a second `serve` on the same folder refuses to start, and says which process has it;
- a service that was killed leaves nothing behind that keeps the next one out;
- `restore-backup` refuses while a service holds the folder.

For the same reason the command line never changes the data itself. A command such as `vigile create-task` is a client: it calls the running service. With no service running it says so, and has sent nothing to anyone.

## The command line knows its service

Before a command sends a key, or anything of the plan, it makes sure that what answers on the config's port is the service of this config and not another program that took the port. [Security](/docs/security/#the-command-line) says how.

## Several instances

An instance is one config file, one data folder and one port. Several can run side by side and share nothing:

```sh terminal=second stays=running
vigile config init --config ~/vigile/second/config.toml --name second --port 8701
vigile serve --config ~/vigile/second/config.toml
```

The second instance takes a terminal of its own, set up as [Install and first run](/docs/install/#in-every-terminal) says: `serve` keeps it.

There is no default location. Every command takes `--config <file>` or reads `VIGILE_CONFIG`, so it is always plain which instance a command acts on.

## The log

`serve` writes a line for each change and for each call that fails: which operation, who called, how long it took and how it ended. A setting adds the reads that succeed. Titles, descriptions and keys are never logged. [Troubleshooting](/docs/troubleshooting/#the-log) shows the lines.

## Reference

- [Install and first run](/docs/install/).
- [Configuration](/docs/configuration/): every setting.
- [Troubleshooting](/docs/troubleshooting/): the doctor, and what to do when a command cannot reach its service.
