import type { Kind, Link, Node, NodeOf, Ref } from "./model.js";

const key = (ref: Ref) => `${ref.kind}:${ref.id}`;
const sameRef = (a: Ref, b: Ref) => a.kind === b.kind && a.id === b.id;
const sameLink = (a: Pick<Link, "from" | "type" | "to">, b: Pick<Link, "from" | "type" | "to">) =>
  a.type === b.type && sameRef(a.from, b.from) && sameRef(a.to, b.to);

/** A link's name: where it starts, its type and where it ends. The type's own text cannot hold the separator. */
const ends = (link: Pick<Link, "from" | "type" | "to">) => `${key(link.from)}\u0000${link.type}\u0000${key(link.to)}`;

/** What a read operation may do with the graph: look, never change. */
export interface GraphView {
  get<K extends Kind>(kind: K, id: string): NodeOf<K> | undefined;
  node(ref: Ref): Node | undefined;
  all<K extends Kind>(kind: K): NodeOf<K>[];
  /** Links that start at `ref`, optionally of one type. */
  out(ref: Ref, type?: string): Link[];
  /** Links that end at `ref`, optionally of one type. */
  in(ref: Ref, type?: string): Link[];
  findLink(link: Pick<Link, "from" | "type" | "to">): Link | undefined;
  links(): Link[];
  userByName(username: string): NodeOf<"user"> | undefined;
  /** Every item there is, of whatever kind, also one of a kind the engine does not know. */
  everything(): Node[];
}

/** A tenant's objects and links, held in memory. Storage stays authoritative; this is a working copy. */
export class Graph implements GraphView {
  private readonly nodes = new Map<string, Node>();
  private readonly outgoing = new Map<string, Link[]>();
  private readonly incoming = new Map<string, Link[]>();
  /** Every link by its two ends and its type, so that asking whether a link exists does not walk a list. */
  private readonly byEnds = new Map<string, Link>();
  /**
   * Every user by its username, so that asking who a caller is does not walk the whole plan: that is asked for
   * every request. Should damaged data hold two users of one name, the one that was there first is the one.
   */
  private readonly byName = new Map<string, NodeOf<"user">>();

  get<K extends Kind>(kind: K, id: string): NodeOf<K> | undefined {
    return this.nodes.get(`${kind}:${id}`) as NodeOf<K> | undefined;
  }

  node(ref: Ref): Node | undefined {
    return this.nodes.get(key(ref));
  }

  all<K extends Kind>(kind: K): NodeOf<K>[] {
    const found: NodeOf<K>[] = [];
    for (const node of this.nodes.values()) if (node.kind === kind) found.push(node as NodeOf<K>);
    return found;
  }

  out(ref: Ref, type?: string): Link[] {
    const links = this.outgoing.get(key(ref)) ?? [];
    return type === undefined ? links : links.filter((l) => l.type === type);
  }

  in(ref: Ref, type?: string): Link[] {
    const links = this.incoming.get(key(ref)) ?? [];
    return type === undefined ? links : links.filter((l) => l.type === type);
  }

  findLink(link: Pick<Link, "from" | "type" | "to">): Link | undefined {
    return this.byEnds.get(ends(link));
  }

  links(): Link[] {
    return [...this.outgoing.values()].flat();
  }

  everything(): Node[] {
    return [...this.nodes.values()];
  }

  userByName(username: string): NodeOf<"user"> | undefined {
    return this.byName.get(username);
  }

  putNode(node: Node): void {
    const before = this.nodes.get(key(node));
    if (before?.kind === "user" && (node.kind !== "user" || node.username !== before.username)) this.forgetName(before);
    this.nodes.set(key(node), node);
    if (node.kind === "user") {
      const named = this.byName.get(node.username);
      if (!named || named.id === node.id) this.byName.set(node.username, node);
    }
  }

  removeNode(ref: Ref): void {
    const before = this.nodes.get(key(ref));
    this.nodes.delete(key(ref));
    if (before?.kind === "user") this.forgetName(before);
  }

  /** Takes a user out of the names. Another user of the same name, should there be one, is then the one of that name. */
  private forgetName(user: NodeOf<"user">): void {
    if (this.byName.get(user.username)?.id !== user.id) return;
    this.byName.delete(user.username);
    for (const node of this.nodes.values()) {
      if (node.kind === "user" && node.username === user.username && node.id !== user.id) {
        this.byName.set(node.username, node);
        return;
      }
    }
  }

  addLink(link: Link): void {
    const name = ends(link);
    if (this.byEnds.has(name)) return;
    this.byEnds.set(name, link);
    push(this.outgoing, key(link.from), link);
    push(this.incoming, key(link.to), link);
  }

  removeLink(link: Pick<Link, "from" | "type" | "to">): void {
    if (!this.byEnds.delete(ends(link))) return;
    drop(this.outgoing, key(link.from), link);
    drop(this.incoming, key(link.to), link);
  }
}

function push(map: Map<string, Link[]>, k: string, link: Link): void {
  const list = map.get(k);
  if (list) list.push(link);
  else map.set(k, [link]);
}

function drop(map: Map<string, Link[]>, k: string, link: Pick<Link, "from" | "type" | "to">): void {
  const list = map.get(k);
  if (!list) return;
  const rest = list.filter((l) => !sameLink(l, link));
  if (rest.length) map.set(k, rest);
  else map.delete(k);
}

export { sameRef };
