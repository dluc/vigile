---
title: Security
description: How Vigile is protected and what is yours to decide. It listens on this machine only by default, admin always needs a key, requests from pages of other sites are refused, and there is no TLS. What to change before it faces a network.
card: The defaults, the two changes to make before it faces a network, and the limits.
lead: Vigile holds a plan, not a shell. But whoever can write to it can mislead every agent that reads it. The defaults are safe on your own machine, and need two changes before the service faces a network.
terminals: running
---

## The defaults

- **It listens on `127.0.0.1` only.** Any wider exposure is something you choose, by setting `listen.address`.
- **`admin` always needs its key.** Creating users, resetting keys and the status of the service are for admins only.
- **Other users need no key.** A connection without one acts as `agent1`, and can read and change the plan. On `127.0.0.1` that is whoever can run a program on your machine.
- **The page mostly reads.** In a task's panel, the priority −/+ controls call `update_task` as the current browser user. The board, the graph, History, Decisions and the other panel fields only read.
- **It sends nothing anywhere.** The service makes no connections of its own: no account, no telemetry, no check for updates. The page loads only the files the service serves.

## Before it faces a network

Two changes, and a restart:

```sh terminal=your
vigile config set auth.keyless_user ""
vigile config set listen.address 192.168.1.20
```

The commands here are typed in a terminal that is set up as [Install and first run](/docs/install/#in-every-terminal) leaves it, with the instance running. The address is an example: use one of this machine's. Requiring keys comes first, while the service still answers where the config says; the new address applies when the service is started again.

1. **Require a key from everyone.** With `auth.keyless_user` empty, every connection needs a key. Give each agent and each person a user of their own with [`vigile user add`](/docs/cli/#user-add).
2. **Listen on an address the others can reach**, one of this machine's.

`serve` and the doctor both warn while connections without a key are let in on a network address. Vigile takes no part in how the port is reached: which network it faces, and any firewall in the way, are yours to decide.

## There is no TLS

Vigile serves plain HTTP, so keys and the plan cross the network unencrypted. Reach it over a network you trust, such as a VPN, or put a proxy that adds TLS in front of it.

A proxy on the same machine needs no setting in Vigile: it reaches the service as `127.0.0.1` or `localhost`, names it so in the `Host` header it sends on, and says whom it speaks for in `X-Forwarded-For`. That is what nginx's `proxy_pass` does unless it is told to pass the public name on. With the public name in `Host`, the page still loads and every request to the API and to MCP is refused as `forbidden`: the service listens on this machine only, and [answers only to this machine's names](#the-browser-guards). This holds for a proxy that serves the page over HTTPS. For connections, a proxy on the same machine is the machine itself: it shares the machine's connections among everyone it serves. A proxy is there to add TLS, so give it a certificate: over plain HTTP under another name, the page's own requests are refused as coming from another site.

## Keys

- A key is made by the service and shown once, when a user is created or its key is reset.
- Keys are stored in the config file, which is created readable by your account only. The doctor checks that it still is.
- `vigile backup` leaves the config file out.
- A key counts only for the user it was made for, and stops working when the user is deleted or the key is reset. Both apply at once.
- A connection with a key that is not valid is refused. It never falls back to the keyless user.
- Titles, descriptions and keys are never written to the log.

Lost the admin key? `vigile user reset-key admin` issues a new one, also when the service refuses the old one or is not running.

## The guards before the API and MCP {#the-browser-guards}

A browser sends requests on behalf of whatever page is open in it. Without a guard, any site you visit could use the service through your browser, as the keyless user. So a request is held against these before it reaches an operation:

{{guards}}

- **Only the first is about browsers alone.** It goes by headers that a browser sends and a page cannot change. A program that sends neither is passed by it.
- **The other two are held against every client.** A script or an agent that calls a service on `127.0.0.1` by another name is refused like a browser, and so is one that sends a body to the API without saying that it is JSON.
- The second is why a site that points a name of its own at your machine gets nothing. The third is there because a browser does not send a JSON body to another site without asking that site first.
- `GET /health` and the files of the web page are not behind the guards.

Once the service listens on another address, the second guard is off: it answers under any name, with nothing to configure. A site could then pass for its page in your browser, which is one more reason to require keys there.

## Limits on connections and requests {#limits}

No client holds the service for itself.

- **Connections.** The service has 1,024. An address beyond its own machine holds at most 64 of them, an IPv6 network of 64 bits counting as one address. 32 are left to the machine itself, so the command line and the doctor get through while the network is busy. What connects from one of the machine's own addresses is the machine itself, also when the service listens on an address of a network.
- **When there is no room.** A connection that is doing less gives way to a new one: the one idle the longest, then one whose request is still arriving, then one that does not read its answer. A connection whose request is being answered is not closed to make room; only then is the new one refused. The service says in its log, at most once a minute, when it had to close or refuse connections.
- **Time.** A request has 30 seconds to arrive in full. A connection on which nothing moves for a minute is closed. An answer moves as its client reads it: when no more of it could be sent for one to two minutes, the connection is closed.
- **Requests on one connection.** A connection may have at most 8 requests that are not answered yet. A client that waits for each answer before it asks again has one or two; a connection that sends more without reading is closed.
- **Bodies.** A body may have at most 1 MB, and only a POST request may have one. A request that is refused before its body has arrived, for its key, the page it comes from or what it says of its body, ends its connection with the answer: the rest of the body is not taken in, and nothing that came behind it on that connection is carried out.
- **The stream of changes.** Of the 200 clients that may [listen for changes](/docs/http-api/#the-stream-of-changes), 32 may come from one address and 168 from the machine itself, whomever they say they speak for.
- **Over MCP**, a request is one message of a bounded size, and its answer has a size and a time: see [what one request may be](/docs/mcp/#one-request).
- The page's files are answered from memory, so a request for one holds no file open.

## The web page {#the-web-page}

- It calls read operations, except that a task panel's priority −/+ controls call `update_task` as the current browser user.
- When a key is required it asks for one, and keeps it in that browser's storage.
- The browser's local storage also keeps the page's settings and the History filters that were applied last. A text filter can hold part of an ID, a title or a username; it stays there until "Clear" is pressed in History.
- **It runs only its own files.** The page is served with a policy that lets the browser run and load nothing but the page's own files, nothing written into the page itself, and that forbids other sites to show it in a frame.
- The libraries that draw the graph are served by the service itself. The page loads nothing from anywhere else.

## The command line

The command line gives a key to its own service only. While the service is down, any program on the machine can listen on its port. So before a command sends a key, or anything of the plan, it checks that a running service holds the config's data folder, and asks what answers, without a key, whether it is a Vigile service of the config's `name`. If not, it stops and says what answers instead. It follows no redirect.

For a config whose `listen.address` is another machine's, there is no data folder to look at, and the answer alone decides.

## What is not there

- No TLS, as above.
- No access by team or by item: whoever is let in may read and change the whole plan, except users and keys.
- No limit on how many calls a client makes over time. What it may hold at once is limited, [as above](#limits).
