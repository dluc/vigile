import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP, type Socket } from "node:net";
import { networkInterfaces } from "node:os";

/** How many connections the service holds, and how they are shared out. */
export interface ConnectionLimits {
  /** How many may be open at once. */
  connections: number;
  /** How many of them one address beyond this machine may hold. */
  connectionsPerAddress: number;
  /** How many are left to this machine itself, whatever other addresses hold. */
  connectionsKeptForHere: number;
}

/**
 * An address as the one text it has however it is written: an IPv4 address as its four numbers, also when it
 * is written inside an IPv6 one, and an IPv6 address as its eight. Nothing for what is no address.
 */
function plain(address: string | undefined): string {
  const name = (address ?? "").replace(/%.*$/, "").toLowerCase();
  if (isIP(name) === 4) return name;
  if (isIP(name) !== 6) return "";
  // Written out in full: eight numbers, the last two taken from an IPv4 address at the end where there is one.
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(name);
  const text = dotted ? `${dotted[1]}${((Number(dotted[2]) << 8) | Number(dotted[3])).toString(16)}:${((Number(dotted[4]) << 8) | Number(dotted[5])).toString(16)}` : name;
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const parts = (tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]).map((part) => parseInt(part, 16));
  if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff) return `${parts[6]! >> 8}.${parts[6]! & 255}.${parts[7]! >> 8}.${parts[7]! & 255}`;
  return parts.map((part) => part.toString(16)).join(":");
}

/**
 * Whom a connection counts for. An IPv4 address counts for itself. An IPv6 address counts together with the 64
 * bits of network it is in: whoever has one such address has all of them, and would otherwise have a share for
 * each. `here` is this machine talking to itself: over an address that is always its own, or over one of the
 * addresses in `own`, which is how the command line reaches a service that listens on an address of a network.
 */
export function peerOf(address: string | undefined, own: readonly string[] = []): { key: string; here: boolean } {
  const name = plain(address);
  if (!name) return { key: "", here: false };
  const here = name.startsWith("127.") || name === "0:0:0:0:0:0:0:1" || own.some((one) => plain(one) === name);
  return { key: name.includes(".") ? name : `${name.split(":").slice(0, 4).join(":")}::/64`, here };
}

/**
 * What a connection is doing, from what is given up first to what never is:
 * - quiet: it has sent no request, or none that is not answered. Closing it loses nothing.
 * - sending: a request of its is still arriving, and nothing is being worked out for it: it can be sent again.
 * - unread: its answers are waiting in the service for the client to take them.
 * - working: a request of its has arrived whole and its answer is being worked out, or it listens for changes
 *   and has been sent all there is. Such a connection is never closed to make room, whatever else it has sent
 *   or not read: what is being done for it may be a change, and it would not learn whether that was made.
 */
const QUIET = 0;
const SENDING = 1;
const UNREAD = 2;
const WORKING = 3;

interface Held {
  socket: Socket;
  key: string;
  here: boolean;
  /** When it came to be as it is: connected, sent a request, or had one answered. */
  since: number;
  /** The requests it has sent whose answers have not gone out in full, each with its answer. */
  open: Map<IncomingMessage, ServerResponse>;
}

/**
 * The connections of the service, and who gets one when there are no more to give.
 *
 * Without this one client could take every connection and keep everyone else out, by opening them and saying
 * nothing, or by asking for something and not reading it. So an address beyond this machine holds only a share,
 * all such addresses together leave some for this machine, where the command line and a proxy connect from, and
 * when a new connection finds no room, one that is doing less gives way to it: the one that has been quiet the
 * longest, then one whose request is still arriving, then one that does not read its answer. Only when every
 * connection in the way is at work is the new one refused.
 */
export class Connections {
  private readonly held = new Map<Socket, Held>();
  /** How many connections each address beyond this machine holds. The machine's own are not among them. */
  private readonly ofKey = new Map<string, number>();
  private beyond = 0;
  private closed = 0;
  private refused = 0;
  private saidAt = -Infinity;
  private own: { addresses: string[]; at: number } = { addresses: [], at: -Infinity };

  constructor(
    private readonly limits: ConnectionLimits,
    /** Told, at most once a minute, how many connections gave way and how many were refused since it was last told. */
    private readonly say: (closed: number, refused: number) => void = () => {},
    private readonly now: () => number = Date.now,
    /** The addresses this machine has on its networks. */
    private readonly interfaces: () => string[] = () =>
      Object.values(networkInterfaces())
        .flat()
        .map((one) => one?.address ?? ""),
  ) {}

  /**
   * The addresses this machine has, asked for again after ten seconds: they change when a network comes or
   * goes, and are not asked for with every connection.
   */
  private addresses(): string[] {
    if (this.now() - this.own.at >= 10_000) {
      let addresses = this.own.addresses;
      try {
        addresses = this.interfaces();
      } catch {
        // Not known this time: what was known before still counts.
      }
      this.own = { addresses, at: this.now() };
    }
    return this.own.addresses;
  }

  /** How many connections are open. */
  get size(): number {
    return this.held.size;
  }

  /** Whom a connection counts for: from this machine also when it comes from the address it came to, or from another address of the machine's. */
  private peer(socket: Socket): { key: string; here: boolean } {
    return peerOf(socket.remoteAddress, [socket.localAddress ?? "", ...this.addresses()]);
  }

  /** Whether a connection is this machine talking to itself, as it was taken to be when it was made. */
  fromHere(socket: Socket): boolean {
    return (this.held.get(socket) ?? this.peer(socket)).here;
  }

  /** A connection was made. Says whether it is kept; one that is not has been closed. */
  connected(socket: Socket): boolean {
    const one: Held = { socket, ...this.peer(socket), since: this.now(), open: new Map() };
    this.held.set(socket, one);
    if (!one.here) {
      this.ofKey.set(one.key, (this.ofKey.get(one.key) ?? 0) + 1);
      this.beyond++;
    }
    socket.once("close", () => this.forget(one));

    // The narrowest share that is used up says who gives way: a connection of the same address, then one from
    // beyond this machine, then any. Closing one of those makes room in the wider shares as well. A connection
    // of the machine's own has no part in the share of an address, also when it is in the same network as one.
    const { connections, connectionsPerAddress, connectionsKeptForHere } = this.limits;
    const among: ((other: Held) => boolean) | null =
      !one.here && this.ofKey.get(one.key)! > connectionsPerAddress
        ? (other) => !other.here && other.key === one.key
        : !one.here && this.beyond > Math.max(0, connections - connectionsKeptForHere)
          ? (other) => !other.here
          : this.held.size > connections
            ? () => true
            : null;
    if (!among) return true;
    const gives = this.leastAtWork(one, among);
    this.drop(gives ?? one);
    if (gives) this.closed++;
    else this.refused++;
    this.tell();
    return gives !== undefined;
  }

  /** A request arrived on a connection. Its connection is at work until the answer has gone out. */
  began(request: IncomingMessage, response: ServerResponse): void {
    const one = this.held.get(request.socket);
    if (!one) return;
    one.open.set(request, response);
    one.since = this.now();
    // Should the answer never get the connection, behind another that is not read, this is not called: the
    // connection then stays as it is until it closes, which forgets all of it.
    response.once("close", () => {
      if (one.open.delete(request)) one.since = this.now();
    });
  }

  private stateOf(one: Held): number {
    if (one.open.size === 0) return QUIET;
    // What the connection has not taken yet of what was written to it.
    const waits = one.socket.writableLength > 0;
    let sending = false;
    for (const [request, response] of one.open) {
      if (!request.complete) sending = true;
      // Its answer is complete and waits for its turn or for the client.
      else if (response.writableEnded) continue;
      // Its answer has begun and does not go out, itself or behind another: a file, say, sent piece by piece.
      else if (waits && response.headersSent) continue;
      // Its answer is still being worked out.
      else return WORKING;
    }
    // With no answer waiting to go out although one is complete, it is on its way out this moment: left alone.
    return sending ? SENDING : waits ? UNREAD : WORKING;
  }

  /** The connection that gives way to a new one: the one doing the least, and of those the longest as it is. */
  private leastAtWork(newcomer: Held, among: (other: Held) => boolean): Held | undefined {
    let found: Held | undefined;
    let state = WORKING;
    for (const other of this.held.values()) {
      if (other === newcomer || !among(other)) continue;
      const its = this.stateOf(other);
      if (its < state || (its === state && found !== undefined && other.since < found.since)) {
        found = other;
        state = its;
      }
    }
    return found;
  }

  private drop(one: Held): void {
    this.forget(one);
    one.socket.destroy();
  }

  private forget(one: Held): void {
    if (!this.held.delete(one.socket) || one.here) return;
    const left = (this.ofKey.get(one.key) ?? 1) - 1;
    if (left > 0) this.ofKey.set(one.key, left);
    else this.ofKey.delete(one.key);
    this.beyond--;
  }

  private tell(): void {
    if (this.now() - this.saidAt < 60_000) return;
    this.saidAt = this.now();
    const [closed, refused] = [this.closed, this.refused];
    this.closed = this.refused = 0;
    this.say(closed, refused);
  }
}
