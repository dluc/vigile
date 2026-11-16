import type { z } from "zod";
import type { GraphView } from "./graph.js";
import { RETIRED_PREFIX, type CounterName, type Link, type Node, type Ref, type StatusEntry, type UserNode, type UserType } from "./model.js";

export interface Clock {
  now(): Date;
}

/**
 * Where API keys live. The engine asks for keys to be made, stored and revoked; it never stores them itself.
 * Of each key it keeps a mark with the user (see `keyMark`), so that a key counts only for the user it was
 * made for and not for whoever has that user's name later.
 */
export interface KeyStore {
  /** Makes a new key. Nothing is stored yet. */
  create(): string;
  /** The key that is stored for the user now, if there is one. */
  stored(username: string): string | undefined;
  /**
   * Stores a key for the user, replacing any earlier one. Rejects when the key was not stored. Resolves to a
   * warning, in words for the caller, when the key is stored and works but may not last, for example because
   * the system could not confirm that it will survive a power cut.
   */
  put(username: string, key: string): Promise<string | undefined | void>;
  revoke(username: string): Promise<void>;
}

export interface HistoryItem {
  at: string;
  by: string;
  action: string;
  data: Record<string, unknown>;
}

/** Where a history entry stands among those of its item: the revision that wrote it, and its place in that revision. */
export type HistoryPlace = readonly [revision: number, seq: number];

export interface HistoryPage {
  /** Oldest first, each with its place among the item's changes: what the token after a page names. */
  items: Array<HistoryItem & { place: HistoryPlace }>;
  /** How many changes to the item are recorded in all. */
  total: number;
  /** Where this page starts, when there are changes before it: the page before ends there. */
  earlier?: HistoryPlace;
}

export interface TimelinePage {
  /** Oldest first, each with its actual place in storage, including gaps in damaged timelines. */
  entries: Array<StatusEntry & { place: number }>;
  /** How many statuses the item went through in all. */
  total: number;
  /** The place in the timeline of the first entry of this page. Above 0, there are entries before it. */
  from: number;
}

export interface ReadContext {
  /**
   * The plan as the engine has it at the moment this is asked. A read that waits for the store asks again after
   * waiting, or holds on to one graph and checks afterwards that it is still this one: the engine puts another
   * graph in its place when it reads the plan anew.
   */
  readonly graph: GraphView;
  readonly caller: UserNode;
  /** The time of this call, as an ISO timestamp. */
  readonly now: string;
  readText(ref: Ref): Promise<string | null>;
  /** Every recorded change to an item, oldest first. */
  readHistory(ref: Ref): Promise<HistoryItem[]>;
  /** The revision the plan in memory is at, at the moment this is asked. Every change and every new reading of the plan from the store moves it or the graph. */
  readonly revision: number;
  /**
   * The revision of the plan since which nothing that `get` shows of an item has changed: see `Unchanged` for
   * what that is and how it is kept. Two answers about an item that say the same revision here show nothing
   * that differs. Known without looking at the item's lists.
   */
  unchangedSince(ref: Ref): number;
  /** The latest recorded changes to an item, or the latest before a given one: at most a page of them, without reading the rest. */
  readHistoryPage(ref: Ref, before?: HistoryPlace): Promise<HistoryPage>;
  /** Every status an item went through, oldest first. For the one operation that moves them; a timeline is shown a page at a time. */
  readTimeline(ref: Ref): Promise<StatusEntry[]>;
  /** The latest statuses an item went through, or the latest before a place in its timeline: at most a page of them, without reading the rest. */
  readTimelinePage(ref: Ref, before?: number): Promise<TimelinePage>;
  /**
   * Whether the store is at the revision of the plan in memory. Asked after reading text or history beside the
   * plan: the revision only goes up, so a store that is still where the plan in memory is was there during the
   * reads, and what they found is of that plan. Otherwise someone has stored a change that is not in memory:
   * another engine on the same store, or this one, between storing a change and taking it into memory.
   */
  storeInStep(): Promise<boolean>;
  /**
   * Runs a reading in its turn among the changes, on the plan as the store has it: the engine first reads the
   * plan anew if the store has moved past it, and while the reading runs this engine stores no change and does
   * not read the plan anew, and its changes wait. For a reading that was overtaken when it held nothing up.
   */
  inTurn<T>(read: () => Promise<T>): Promise<T>;
}

export type Mutation =
  | { t: "put"; node: Node; text?: string }
  | { t: "remove"; ref: Ref }
  | { t: "link"; link: Link }
  | { t: "unlink"; link: Pick<Link, "from" | "type" | "to"> }
  | { t: "history"; ref: Ref; action: string; data: Record<string, unknown> }
  /** The item has taken a status: the next entry of its timeline. */
  | { t: "status"; ref: Ref; entry: StatusEntry }
  /** Gives entries in a timeline range another moment, optionally only when their old moment is later. */
  | { t: "moment"; ref: Ref; from: number; to: number; at: string; atAfter?: string };

/** The changes one write operation wants. Nothing happens until the engine commits them as one step. */
export class Plan {
  readonly mutations: Mutation[] = [];
  readonly counters: Record<string, number>;

  constructor(counters: Record<string, number>) {
    this.counters = { ...counters };
  }

  /** Takes the next number of a counter. The counter moves in the same step as the rest of the plan. */
  next(counter: CounterName): number {
    const value = (this.counters[counter] ?? 0) + 1;
    this.counters[counter] = value;
    return value;
  }

  /** Whether a prefix was that of a project that has since been deleted for good. */
  isRetired(prefix: string): boolean {
    return Object.hasOwn(this.counters, RETIRED_PREFIX + prefix);
  }

  /** Remembers a prefix as used up, in the same step as the rest of the plan. */
  retire(prefix: string): void {
    this.counters[RETIRED_PREFIX + prefix] = 1;
  }

  /** Stores a node. Pass `text` to set its long text; leave it out to keep the stored text. */
  put(node: Node, text?: string): void {
    this.mutations.push({ t: "put", node, text });
  }

  remove(ref: Ref): void {
    this.mutations.push({ t: "remove", ref: { kind: ref.kind, id: ref.id } });
  }

  link(link: Link): void {
    this.mutations.push({ t: "link", link });
  }

  unlink(link: Pick<Link, "from" | "type" | "to">): void {
    this.mutations.push({ t: "unlink", link });
  }

  history(ref: Ref, action: string, data: Record<string, unknown> = {}): void {
    this.mutations.push({ t: "history", ref: { kind: ref.kind, id: ref.id }, action, data });
  }

  /**
   * Adds the status an item has taken to its timeline. To be planned together with the item itself, which says
   * what its status is: the last entry of a timeline is the status the item has.
   */
  status(ref: Ref, entry: StatusEntry): void {
    this.mutations.push({ t: "status", ref: { kind: ref.kind, id: ref.id }, entry });
  }

  /** Gives the entries of an item's timeline from one place to another, both included, another moment. */
  moment(ref: Ref, from: number, to: number, at: string, atAfter?: string): void {
    this.mutations.push({ t: "moment", ref: { kind: ref.kind, id: ref.id }, from, to, at, ...(atAfter === undefined ? {} : { atAfter }) });
  }
}

export interface WriteContext extends ReadContext {
  readonly plan: Plan;
  readonly keys: KeyStore;
}

/** Who may call an operation: everyone, or only users of the listed types. */
export type Access = "all" | readonly UserType[];

interface OperationBase<S extends z.ZodObject> {
  /** Lowercase letters and underscores. Each interface rewrites it to its own convention. */
  name: string;
  /** What an agent reads to decide whether and how to call the operation. */
  description: string;
  access: Access;
  input: S;
}

export interface ReadOperation<S extends z.ZodObject = z.ZodObject, O = unknown> extends OperationBase<S> {
  kind: "read";
  run(ctx: ReadContext, input: z.output<S>): O | Promise<O>;
}

export interface WriteOperation<S extends z.ZodObject = z.ZodObject, O = unknown> extends OperationBase<S> {
  kind: "write";
  /**
   * Checks the change against the graph and records it in `ctx.plan`. Returns a function that builds the reply;
   * the engine calls it once the plan is stored, so it sees the graph as it is after the change.
   */
  run(ctx: WriteContext, input: z.output<S>): (() => O | Promise<O>) | Promise<() => O | Promise<O>>;
}

export type Operation = ReadOperation<any, any> | WriteOperation<any, any>;

export function defineRead<S extends z.ZodObject, O>(operation: Omit<ReadOperation<S, O>, "kind">): ReadOperation<S, O> {
  return { ...operation, kind: "read" };
}

export function defineWrite<S extends z.ZodObject, O>(operation: Omit<WriteOperation<S, O>, "kind">): WriteOperation<S, O> {
  return { ...operation, kind: "write" };
}

export const mayCall = (operation: Pick<Operation, "access">, type: UserType): boolean =>
  operation.access === "all" || operation.access.includes(type);
