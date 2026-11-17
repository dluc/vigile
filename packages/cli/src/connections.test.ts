import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { describe, it } from "node:test";
import { Connections, peerOf } from "./connections.js";

/** A connection as the service sees one: where it is from, whether an answer waits in it, and whether it was closed. */
class Peer extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  constructor(
    readonly remoteAddress: string | undefined,
    /** The address of the service that it came to. */
    readonly localAddress = "192.0.2.1",
  ) {
    super();
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

function world(limits: { connections: number; connectionsPerAddress: number; connectionsKeptForHere: number }) {
  const clock = { now: 1000 };
  const said: Array<[closed: number, refused: number]> = [];
  /** The addresses the machine has on its networks, which the test may change. */
  const machine = { addresses: ["127.0.0.1", "::1", "192.0.2.1", "2001:db8:5::1"], asked: 0 };
  const connections = new Connections(limits, (closed, refused) => said.push([closed, refused]), () => clock.now, () => (machine.asked++, machine.addresses));
  /** Connects from an address, a moment after whatever came before. Says whether it was kept. */
  const connect = (address: string | undefined, to?: string): Peer & { kept: boolean } => {
    clock.now += 1;
    const peer = new Peer(address, to);
    return Object.assign(peer, { kept: connections.connected(peer as unknown as Socket) });
  };
  /**
   * Sends a request on a connection. `arrived` is whether all of it is there. Its answer is being worked out
   * until `written` says that all of it was handed over, or `begun` that its first part was; it has gone out
   * when `answered` is called.
   */
  const ask = (peer: Peer, arrived = true): { request: { complete: boolean }; begun(): void; written(): void; answered(): void } => {
    clock.now += 1;
    const request = { socket: peer, complete: arrived };
    const response = Object.assign(new EventEmitter(), { writableEnded: false, headersSent: false });
    connections.began(request as unknown as IncomingMessage, response as unknown as ServerResponse);
    return {
      request,
      begun: () => void (response.headersSent = true),
      written: () => void (response.writableEnded = true),
      answered: () => (clock.now++, void response.emit("close")),
    };
  };
  return { clock, said, machine, connections, connect, ask };
}

describe("whom a connection counts for", () => {
  it("is the address itself for IPv4, however it is written, and this machine for its own addresses", () => {
    assert.deepEqual(peerOf("203.0.113.7"), { key: "203.0.113.7", here: false });
    assert.deepEqual(peerOf("::ffff:203.0.113.7"), { key: "203.0.113.7", here: false });
    assert.deepEqual(peerOf("::FFFF:CB00:7107"), { key: "203.0.113.7", here: false });
    assert.deepEqual(peerOf("0:0:0:0:0:ffff:203.0.113.7"), { key: "203.0.113.7", here: false });
    for (const own of ["127.0.0.1", "127.8.9.10", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) assert.equal(peerOf(own).here, true, own);
    for (const other of ["128.0.0.1", "10.0.0.1", "::2", "::ffff:128.0.0.1", "1::1"]) assert.equal(peerOf(other).here, false, other);
  });

  it("is the network of 64 bits for IPv6, so that one network has one share and not one for each of its addresses", () => {
    const network = peerOf("2001:db8:1:2::1").key;
    assert.equal(network, "2001:db8:1:2::/64");
    for (const same of ["2001:db8:1:2:ffff:ffff:ffff:ffff", "2001:0DB8:0001:0002:0:0:0:9", "2001:db8:1:2::", "2001:db8:1:2:a:b:c:d%eth0"]) assert.equal(peerOf(same).key, network, same);
    for (const other of ["2001:db8:1:3::1", "2001:db8:1::1", "2001:db8::1:2:0:0:1", "fe80::1"]) assert.notEqual(peerOf(other).key, network, other);
    assert.equal(peerOf("fe80::1%eth0").key, "fe80:0:0:0::/64");
    assert.equal(peerOf("::").key, "0:0:0:0::/64");
  });

  it("is this machine for each of the machine's own addresses, however one is written", () => {
    const own = ["192.0.2.1", "2001:db8:5::1", "", "not an address"];
    for (const address of ["192.0.2.1", "::ffff:192.0.2.1", "2001:db8:5::1", "2001:0db8:0005:0:0:0:0:1", "2001:DB8:5::1%eth0"]) assert.equal(peerOf(address, own).here, true, address);
    // Not another address of the same network, and not an address that is none.
    for (const address of ["192.0.2.2", "2001:db8:5::2", "2001:db8:5::", undefined, "not an address"]) assert.equal(peerOf(address, own).here, false, String(address));
    assert.deepEqual(peerOf("2001:db8:5::1", own), { key: "2001:db8:5:0::/64", here: true });
    assert.equal(peerOf("192.0.2.1").here, false, "nor without being told that the address is the machine's");
  });

  it("is one and the same for every connection whose address is not known", () => {
    assert.deepEqual(peerOf(undefined), { key: "", here: false });
    assert.deepEqual(peerOf("not an address"), { key: "", here: false });
  });
});

describe("who gets a connection when there are no more to give", () => {
  const limits = { connections: 10, connectionsPerAddress: 3, connectionsKeptForHere: 2 };

  it("gives an address beyond this machine a share: its own longest-idle connection gives way to its next one", () => {
    const { connect, connections } = world(limits);
    const first = [connect("203.0.113.7"), connect("203.0.113.7"), connect("203.0.113.7")];
    const other = connect("198.51.100.1");
    assert.deepEqual([...first, other].map((peer) => peer.kept), [true, true, true, true]);
    const fourth = connect("203.0.113.7");
    assert.deepEqual([fourth.kept, first.map((peer) => peer.destroyed), other.destroyed, connections.size], [true, [true, false, false], false, 4]);
    // Written another way it is the same address, and has the same share.
    const fifth = connect("::ffff:203.0.113.7");
    assert.deepEqual([fifth.kept, first.map((peer) => peer.destroyed), connections.size], [true, [true, true, false], 4]);
  });

  it("refuses the next connection of an address whose connections are all at work, and no other address pays for it", () => {
    const { connect, ask, connections } = world(limits);
    const busy = [connect("203.0.113.7"), connect("203.0.113.7"), connect("203.0.113.7")];
    const answers = busy.map((peer) => ask(peer));
    const idle = connect("198.51.100.1");
    const refused = connect("203.0.113.7");
    assert.deepEqual([refused.kept, refused.destroyed, busy.map((peer) => peer.destroyed), idle.destroyed, connections.size], [false, true, [false, false, false], false, 4]);
    // Once one of them has its answer, it is idle again and gives way.
    answers[1]!.answered();
    const next = connect("203.0.113.7");
    assert.deepEqual([next.kept, busy.map((peer) => peer.destroyed)], [true, [false, true, false]]);
  });

  it("gives up what loses the least: an idle connection, then one whose request is still arriving, then one that does not read its answer", () => {
    const { connect, ask } = world(limits);
    const unread = connect("203.0.113.7");
    const arriving = connect("203.0.113.7");
    const idle = connect("203.0.113.7");
    ask(unread).written();
    unread.writableLength = 4096;
    ask(arriving, false);
    // The idle one goes first although it is the newest of the three.
    assert.equal(connect("203.0.113.7").kept, true);
    assert.deepEqual([unread.destroyed, arriving.destroyed, idle.destroyed], [false, false, true]);
    // The one just made is idle, and goes next. Then, with a request on its successor, the one still sending.
    const second = connect("203.0.113.7");
    ask(second);
    const third = connect("203.0.113.7");
    assert.deepEqual([third.kept, unread.destroyed, arriving.destroyed], [true, false, true]);
    ask(third);
    // Two at work now, and one whose answer nobody takes: that one gives way.
    const fourth = connect("203.0.113.7");
    assert.deepEqual([fourth.kept, unread.destroyed, second.destroyed, third.destroyed], [true, true, false, false]);
    // A request counts as work from the moment all of it has arrived: with all three at it, the next is refused.
    const last = ask(fourth, false);
    last.request.complete = true;
    assert.equal(connect("203.0.113.7").kept, false);
    assert.deepEqual([second.destroyed, third.destroyed, fourth.destroyed], [false, false, false]);
  });

  it("never closes a connection for which something is being worked out, whatever else it has sent or not read", () => {
    const { connect, ask } = world({ connections: 10, connectionsPerAddress: 1, connectionsKeptForHere: 0 });
    // A request that has arrived whole and is being answered, and behind it one that is still arriving.
    const peer = connect("203.0.113.7");
    const first = ask(peer);
    const second = ask(peer, false);
    assert.deepEqual([connect("203.0.113.7").kept, peer.destroyed], [false, false], "at work, though a request of its is still arriving");
    // The first answer is complete and nobody takes it, while the second request, now arrived, is worked out.
    first.written();
    peer.writableLength = 4096;
    second.request.complete = true;
    assert.deepEqual([connect("203.0.113.7").kept, peer.destroyed], [false, false], "at work, though an answer of its is not read");
    // An answer that has begun and does not go out is not work: a file sent piece by piece.
    second.begun();
    assert.deepEqual([connect("203.0.113.7").kept, peer.destroyed], [true, true]);
  });

  it("takes an answer for unread only while some of it waits: one on its way out is left alone", () => {
    const { connect, ask } = world({ connections: 10, connectionsPerAddress: 1, connectionsKeptForHere: 0 });
    const peer = connect("203.0.113.7");
    const only = ask(peer);
    only.written();
    assert.deepEqual([connect("203.0.113.7").kept, peer.destroyed], [false, false], "handed over whole, and nothing of it waits");
    // An answer that has begun and of which nothing waits is being worked out: a client that listens for changes.
    const other = connect("198.51.100.1");
    ask(other).begun();
    assert.deepEqual([connect("198.51.100.1").kept, other.destroyed], [false, false]);
    other.writableLength = 1;
    assert.deepEqual([connect("198.51.100.1").kept, other.destroyed], [true, true]);
  });

  it("takes the one that has been as it is the longest, of several that lose the same", () => {
    const { connect, ask } = world(limits);
    const [a, b, c] = [connect("203.0.113.7"), connect("203.0.113.7"), connect("203.0.113.7")];
    // The first made has since answered a request: it has been idle for a shorter time than the second.
    ask(a!).answered();
    connect("203.0.113.7");
    assert.deepEqual([a!.destroyed, b!.destroyed, c!.destroyed], [false, true, false]);
  });

  it("leaves some connections to this machine, whatever addresses beyond it hold", () => {
    const { connect, ask, connections } = world(limits);
    // Eight are for addresses beyond this machine. Each of three takes its share; the ninth finds the eight taken.
    const beyond = ["203.0.113.1", "203.0.113.2", "203.0.113.3"].flatMap((address) => [connect(address), connect(address), connect(address)]);
    assert.deepEqual([beyond.map((peer) => peer.kept).every(Boolean), beyond.filter((peer) => peer.destroyed).length, connections.size], [true, 1, 8]);
    assert.equal(beyond[0]!.destroyed, true, "the longest-idle one from beyond gave way, of whichever address");
    // With all of them at work, another address is refused, and this machine still connects.
    for (const peer of beyond.filter((peer) => !peer.destroyed)) ask(peer);
    assert.equal(connect("198.51.100.1").kept, false);
    const own = [connect("127.0.0.1"), connect("::1")];
    assert.deepEqual([own.map((peer) => peer.kept), connections.size], [[true, true], 10]);
    // This machine has no share of its own: it takes what is free, and then what is idle, its own included.
    const third = connect("127.0.0.1");
    assert.deepEqual([third.kept, own.map((peer) => peer.destroyed), connections.size], [true, [true, false], 10]);
  });

  it("counts as this machine what comes from an address of the machine's own, as the command line does to a service on a network", () => {
    const { connect, ask, machine, clock, connections } = world({ connections: 4, connectionsPerAddress: 1, connectionsKeptForHere: 2 });
    // Addresses beyond the machine have two connections between them, one each, and both are at work.
    for (const address of ["203.0.113.1", "203.0.113.2"]) ask(connect(address));
    assert.equal(connect("203.0.113.3").kept, false);
    // The machine's own address on that network is not one of them: the two that are left are there for it.
    const own = [connect("192.0.2.1"), connect("::ffff:192.0.2.1")];
    assert.deepEqual([own.map((peer) => peer.kept), connections.size], [[true, true], 4]);
    for (const peer of own) peer.destroy();
    // So is the address a connection came to, whatever the machine says its addresses are, and any other of its addresses.
    const same = connect("198.51.100.9", "198.51.100.9");
    const other = connect("2001:db8:5::1", "198.51.100.9");
    assert.deepEqual([same.kept, other.kept, connections.size], [true, true, 4]);
    for (const peer of [same, other]) peer.destroy();
    // The machine is asked for its addresses now and then, not with every connection, and one it has lost counts no more.
    assert.equal(machine.asked, 1);
    machine.addresses = ["127.0.0.1"];
    const still = connect("192.0.2.1");
    assert.equal(still.kept, true, "still taken for the machine's own for some seconds");
    still.destroy();
    clock.now += 10_000;
    assert.deepEqual([connect("192.0.2.1", "198.51.100.9").kept, machine.asked], [false, 2]);
  });

  it("keeps the machine's own connections out of the share of an address in the same network", () => {
    const { connect, ask, connections } = world({ connections: 10, connectionsPerAddress: 2, connectionsKeptForHere: 2 });
    // The machine has an address in a network of 64 bits, and so has a client beyond it.
    const own = [connect("2001:db8:5::1"), connect("2001:db8:5::1"), connect("2001:db8:5::1")];
    assert.deepEqual(own.map((peer) => peer.kept), [true, true, true], "the machine has no share to use up");
    // The client has the whole share of its network, whatever the machine holds there.
    const beyond = [connect("2001:db8:5::2"), connect("2001:db8:5::3")];
    assert.deepEqual([beyond.map((peer) => peer.kept), own.some((peer) => peer.destroyed), connections.size], [[true, true], false, 5]);
    // Its third takes the place of one of its own, not of one of the machine's, although those are idle longer.
    const third = connect("2001:db8:5::4");
    assert.deepEqual([third.kept, beyond.map((peer) => peer.destroyed), own.some((peer) => peer.destroyed)], [true, [true, false], false]);
    // With its two at work the next is refused, and the machine's idle ones are still not given up for it.
    ask(beyond[1]!);
    ask(third);
    assert.deepEqual([connect("2001:db8:5::5").kept, own.some((peer) => peer.destroyed), connections.size], [false, false, 5]);
    // A connection of the machine's that closes leaves the share of the network as it was.
    own[0]!.destroy();
    assert.deepEqual([connect("2001:db8:5::6").kept, connect("2001:db8:5::1").kept, connections.size], [false, true, 5]);
  });

  it("says of a connection whether it is the machine's own, as it was taken to be when it was made", () => {
    const { connect, machine, clock, connections } = world({ connections: 10, connectionsPerAddress: 2, connectionsKeptForHere: 2 });
    const [own, other] = [connect("192.0.2.1", "198.51.100.9"), connect("203.0.113.7")];
    const from = (peer: object) => connections.fromHere(peer as unknown as Socket);
    assert.deepEqual([from(own), from(other)], [true, false]);
    // The machine loses the address: the connection made from it stays what it was, a new one is from beyond.
    machine.addresses = ["127.0.0.1"];
    clock.now += 10_000;
    assert.deepEqual([from(own), from(connect("192.0.2.1", "198.51.100.9"))], [true, false]);
    // One that is not held, or no longer, is looked at as it is now.
    own.destroy();
    assert.deepEqual([from(own), from({ remoteAddress: "127.0.0.1" }), from({ remoteAddress: "203.0.113.7", localAddress: "203.0.113.7" })], [false, true, true]);
  });

  it("lets this machine use every connection, and refuses it only when all of them are at work", () => {
    const { connect, ask, connections } = world(limits);
    const own = Array.from({ length: 10 }, () => connect("127.0.0.1"));
    const answers = own.map((peer) => ask(peer));
    assert.equal(own.every((peer) => peer.kept), true);
    assert.deepEqual([connect("127.0.0.1").kept, connect("203.0.113.7").kept, connections.size], [false, false, 10]);
    answers[4]!.answered();
    assert.deepEqual([connect("203.0.113.7").kept, own[4]!.destroyed, connections.size], [true, true, 10]);
  });

  it("frees the place of a connection that closes, and counts a request only until its answer has gone out", () => {
    const { connect, ask, connections } = world(limits);
    const peers = [connect("203.0.113.7"), connect("203.0.113.7"), connect("203.0.113.7")];
    peers[1]!.destroy();
    assert.equal(connections.size, 2);
    const fourth = connect("203.0.113.7");
    assert.deepEqual([fourth.kept, peers[0]!.destroyed, peers[2]!.destroyed, connections.size], [true, false, false, 3]);
    // A request on a connection that is gone, and an answer that goes out twice, change nothing.
    const late = ask(peers[1]!);
    late.answered();
    late.answered();
    assert.equal(connections.size, 3);
  });

  it("says that it made room or refused at most once a minute, with how many since it last said so", () => {
    const { connect, ask, said, clock } = world({ connections: 2, connectionsPerAddress: 2, connectionsKeptForHere: 0 });
    connect("127.0.0.1");
    connect("127.0.0.1");
    assert.deepEqual(said, [], "nothing to say while there is room");
    connect("127.0.0.1");
    assert.deepEqual(said, [[1, 0]]);
    for (let i = 0; i < 5; i++) connect("127.0.0.1");
    assert.deepEqual(said, [[1, 0]], "not again within the minute");
    clock.now += 60_000;
    const [a, b] = [connect("127.0.0.1"), connect("127.0.0.1")];
    ask(a);
    ask(b);
    assert.deepEqual(said, [[1, 0], [6, 0]]);
    connect("127.0.0.1");
    clock.now += 60_000;
    connect("127.0.0.1");
    assert.deepEqual(said, [[1, 0], [6, 0], [1, 2]]);
  });
});
