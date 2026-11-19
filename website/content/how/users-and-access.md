---
title: Users, keys and who can do what
nav: Users and access
description: A Vigile instance has users of three types, admin, person and agent. Identity comes from an API key, a connection without one acts as a configured user, and the operations offered depend on the user's type.
card: Who a connection acts as, with a key and without, and what each may do.
lead: Every change is made by someone. Who that is comes from the API key a connection sends, or from the instance's choice of who a connection without a key is.
terminals: running
---

{{diagram access | A connection with a valid key acts as the user the key was made for. One without a key acts as the keyless user, if the instance has one. A key that is not valid is refused, and never falls back to the keyless user.}}

## Users

A user is an item in the plan like a task: it has an ID, a version and a history of what was done to it. The tasks it is given are not in that history: they are in the tasks'. It has a username and one of three types.

{{user-types}}

Every instance starts with three users:

{{built-in-users}}

More agents mean more users: give each agent its own, so that their work can be told apart in the history and each can be assigned its own tasks.

## Keys

A key is a long random text that starts with `vig_`, sent with every request as `Authorization: Bearer vig_...`.

- The service makes a key when a user is created or its key is reset, and shows it once.
- Keys are kept in the instance's config file, which only your account can read, and apply at once.
- A key counts only for the user it was made for, and `admin` always needs its key.

## Without a key

By default, a connection without a key acts as `agent1`, and can read and change the plan. That is the setting `auth.keyless_user`. It makes the first minutes easy and is fine while the service listens on `127.0.0.1` only.

Set it to nothing and every connection needs a key:

```sh terminal=your
vigile config set auth.keyless_user ""
```

Do that before the service can be reached from another machine. `serve` and the doctor both warn while it is open on a network address. See [Security](/docs/security/).

## What a user may do

Everyone in an instance sees the whole plan, and every user may call the operations that read and change projects, tasks, decisions and links. What depends on the type:

- **Creating users and resetting keys** are operations for admins. They are not even listed for anyone else: an agent's list of tools does not have them.
- **Deleting for good**, and deleting or restoring a user, are for admins, within operations everyone may call.
- **The status of the service** is for admins.

There is no access by team or by item: whoever is let in may read and change everything but users and keys.

## The command line and the page

The command line acts as `admin` unless a command is given `--as <username>`; it takes the key from the config file. The page mostly reads the plan; a task panel's priority −/+ controls call `update_task` as the browser's current user. When a key is required the page asks for one and keeps it in that browser.

## Reference

- [`create_user`](/docs/operations/create-user/), [`reset_user_key`](/docs/operations/reset-user-key/), [`list_users`](/docs/operations/list-users/).
- [`vigile user`](/docs/cli/#user-add) on the command line.
- [Security](/docs/security/): keys, the browser guards, and what to expose.
- The command above is typed in a terminal set up as [Install and first run](/docs/install/#in-every-terminal) leaves it.
