import { CommitTooLargeError, FORMAT_VERSION, RevisionConflictError, type HistoryRecord, type StorageAdapter } from "@vigile/storage";
import { randomBytes } from "node:crypto";
import { isLive, taskCalc, type Known } from "./calc.js";
import { VigileError, echo, forbidden, invalidInput, notFound, toErrorBody } from "./errors.js";
import { Graph, type GraphView } from "./graph.js";
import { userId } from "./ids.js";
import { LINK_TYPES } from "./link-types.js";
import { BUILT_IN_USERS, COUNTERS, LIMITS, RETIRED_PREFIX, areKeyMarks, keyMark, type Node, type Ref, type StatusEntry, type UserNode, type UserType } from "./model.js";
import { entriesProblem, shapeProblem, timelineProblem } from "./shape.js";
import { Plan, mayCall, type Clock, type HistoryItem, type HistoryPage, type HistoryPlace, type KeyStore, type Mutation, type Operation, type ReadContext, type TimelinePage } from "./operation.js";
import { OPERATIONS, findOperation } from "./operations/index.js";
import { displayId, recordToEntry, recordToLink, recordToNode, storageId, storedAs, toChanges } from "./records.js";
import { Unchanged } from "./unchanged.js";

export interface OperationLog {
  operation: string;
  caller: string;
  kind: "read" | "write";
  duration_ms: number;
  /** `ok`, or the error code. */
  result: string;
  rule?: string;
  /** What was thrown, when the result is `internal`: for the service's log, never for the caller. */
  cause?: unknown;
}

export interface EngineOptions {
  storage: StorageAdapter;
  tenant?: string;
  clock?: Clock;
  keys?: KeyStore;
  /** Called once per operation. Never receives titles, descriptions or other content. */
  onOperation?: (entry: OperationLog) => void;
}

export interface EngineStatus {
  tenant: string;
  format: number;
  revision: number;
  counters: Record<string, number>;
  /** How many prefixes are used up: those of projects that were deleted for good. */
  retired_prefixes: number;
  /** How many numbers the engine keeps for single items to say since when each is unchanged: bounded by the items and links there are. */
  remembered: number;
  counts: Record<string, number>;
  links: number;
  loaded_at: string;
}

/** Keeps keys in memory only. For tests and for running without a config file. */
export class MemoryKeyStore implements KeyStore {
  readonly keys = new Map<string, string>();

  create(): string {
    return `vig_${randomBytes(24).toString("base64url")}`;
  }

  stored(username: string): string | undefined {
    return this.keys.get(username);
  }

  async put(username: string, key: string): Promise<string | undefined | void> {
    this.keys.set(username, key);
  }

  async revoke(username: string): Promise<void> {
    this.keys.delete(username);
  }
}

/** The entry an item's history begins with. */
const CREATED = "created";

/** How many entries of a timeline are read at a time by the check of all timelines. */
const TIMELINE_CHECKED_AT_ONCE = 500;

/** How many of the mistakes in an operation's input a refusal puts into words. */
const MOST_ISSUES = 5;
/** How much of one of them: enough for the values a field can take, not for the names of fields a caller made up. */
const MOST_OF_AN_ISSUE = 300;

/** The user a caller was let in as: the name, and which user had it then. */
export interface Caller {
  username: string;
  id: string;
}

/**
 * One tenant's graph and the only way to change it. Reads are answered from memory. Writes go one at a time:
 * check against memory, store as one all-or-nothing step tied to the tenant revision, then update memory.
 */
export class Engine {
  private graph = new Graph();
  /** What the last reading of the store found under IDs the store would not write. */
  private misstored: string[] = [];
  private revision = 0;
  /** Since when nothing that is shown of each item has changed: kept up with the plan in memory, see `Unchanged`. */
  private unchanged = new Unchanged(this.graph, 0);
  private format = FORMAT_VERSION;
  private counters: Record<string, number> = {};
  private loadedAt = "";
  private stale = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(revision: number) => void>();

  private readonly storage: StorageAdapter;
  private readonly clock: Clock;
  private readonly keys: KeyStore;
  private readonly onOperation?: (entry: OperationLog) => void;
  readonly tenant: string;

  private constructor(options: EngineOptions) {
    this.storage = options.storage;
    this.tenant = options.tenant ?? "default";
    this.clock = options.clock ?? { now: () => new Date() };
    this.keys = options.keys ?? new MemoryKeyStore();
    this.onOperation = options.onOperation;
  }

  static async open(options: EngineOptions): Promise<Engine> {
    const engine = new Engine(options);
    await engine.load();
    return engine;
  }

  /**
   * Calls the listener each time the plan has changed, with the new revision and nothing else: what changed
   * is for the listener to read through an operation, as itself. Returns a function that stops the calls.
   */
  subscribe(listener: (revision: number) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** The number that goes up by one with every stored change. */
  get currentRevision(): number {
    return this.revision;
  }

  private announce(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.revision);
      } catch {
        // A listener that fails must not undo or delay a change that is already stored.
      }
    }
  }

  /** The operations a user of this type may call. */
  operationsFor(type: UserType): Operation[] {
    return OPERATIONS.filter((o) => mayCall(o, type));
  }

  user(username: string): UserNode | undefined {
    const user = this.graph.userByName(username);
    return user && isLive(user) ? user : undefined;
  }

  /**
   * Whether a key that is stored under a user's name is that user's own. A name can pass from one user to
   * another, and a key left behind under it must not pass with it: only a key whose mark the user carries
   * counts. Built-in users, and users from before marks were kept, carry none, and any key stored for them does.
   */
  keyIsTheirs(username: string, key: string): boolean {
    const user = this.user(username);
    if (!user) return false;
    if (user.built_in || user.key_marks === undefined) return true;
    // Marks that are not a list, in data that was damaged or written by hand, are the marks of no key: nothing
    // counts for the user until a key is issued, which writes them anew.
    return areKeyMarks(user.key_marks) && user.key_marks.includes(keyMark(key));
  }

  /**
   * Runs one operation as the named user. Everything every interface does goes through here.
   *
   * An interface that let the caller in some time before, by a key, names the user it let in and not only the
   * username: `{ username, id }`. Between the two the user may have been deleted for good and the name given
   * to someone else, whom the key does not let in. The operation then runs only as the user that was let in,
   * which is asked when it runs, after any wait for its turn.
   */
  async execute(name: string, as: string | Caller, input: unknown): Promise<unknown> {
    const username = typeof as === "string" ? as : as.username;
    const letInAs = typeof as === "string" ? undefined : as.id;
    const started = performance.now();
    const operation = findOperation(name);
    let result = "ok";
    let rule: string | undefined;
    let cause: unknown;
    try {
      if (!operation) throw notFound(`There is no operation called "${echo(name)}".`);
      return operation.kind === "read"
        ? await this.run(operation, username, letInAs, input, null, this.clock.now().toISOString())
        : await this.enqueue(() => this.write(operation, username, letInAs, input));
    } catch (error) {
      const body = toErrorBody(error);
      result = body.code;
      rule = body.rule;
      if (error instanceof VigileError) {
        // An internal error that was put into words keeps what set it off, for the log.
        if (error.code === "internal") cause = (error as { cause?: unknown }).cause ?? error;
        throw error;
      }
      cause = error;
      throw Object.assign(new VigileError("internal", body.message), { cause: error });
    } finally {
      try {
        this.onOperation?.({
          // A name that is no operation's is something the caller wrote, and the log takes nothing a caller
          // wrote as it came: it gets the start of the name, without what could end a line or pass for a word
          // of the log.
          operation: operation ? operation.name : name.slice(0, 64).replace(/[^\x21-\x7e]/g, "?"),
          caller: username,
          kind: operation?.kind ?? "read",
          duration_ms: Math.round((performance.now() - started) * 100) / 100,
          result,
          ...(rule ? { rule } : {}),
          ...(cause === undefined ? {} : { cause }),
        });
      } catch {
        // The log could not be written. That is the log's trouble: the operation ends as it did.
      }
    }
  }

  /**
   * What an operation is given to work with.
   *
   * The graph is handed out when it is asked for, not when the context is made: `load()` puts a new graph in
   * the place of the old one, and a read that was waiting for the store at that moment would otherwise go on
   * reading a plan that is no longer the engine's, beside what `unchangedSince` says of the new one. A read
   * that waits for the store goes through `readSteady`, which holds on to one graph for a try and throws the
   * try away when the engine has another by its end.
   *
   * A write needs none of that, and is given the graph of its turn (see `run`). Writes run one at a time, in
   * the queue. The plan in memory is changed in two places only, `apply()` after a commit and `load()`, and both
   * run inside a turn of the queue: `apply()` and the `load()` after a failed commit in the turn of the write
   * itself, `reload()` in a turn of its own. So from the moment a write's context is made to the moment its
   * reply is built, nothing but the write itself changes the plan, also while the write waits for the store:
   * a node it read before waiting is the node there is after. And a write that is run again after a conflict
   * gets a new context, made after the plan was read anew.
   *
   * What a write reads from the store (`update_task` the description, `override_timestamp` the history,
   * `create_project` whether a prefix left history behind) is held against the plan in memory by the commit:
   * the commit names the revision of the plan in memory and is refused when the store is anywhere else. The
   * revision only goes up, so a store that is at that revision when the change is stored was at it when the
   * write read from it, and what the write read is of the plan it checked the change against. A commit that
   * is refused has the plan read anew and the write run again, with its reads. This covers every write that
   * stores something. A write that ends without storing, because it changes nothing or is refused, has
   * certified nothing: it answered from the store as it is, which is never older than the plan in memory.
   */
  private context(caller: UserNode, now: string): ReadContext {
    const engine = this;
    return {
      get graph() {
        return engine.graph;
      },
      caller,
      now,
      storeInStep: async () => (await this.storage.readRevision(this.tenant)) === this.revision,
      // A read takes a turn of the queue, and finds the plan in step with the store when its turn comes. A write
      // has a turn: it is not made to wait for itself.
      inTurn: (read) =>
        this.enqueue(async () => {
          if (this.stale || (await this.storage.readRevision(this.tenant)) !== this.revision) await this.load();
          return read();
        }),
      readText: (ref) => this.storage.readText(this.tenant, ref.kind, storageId(ref.kind, ref.id)),
      get revision() {
        return engine.revision;
      },
      unchangedSince: (ref) => this.unchanged.since(ref),
      readHistory: (ref) => this.history(ref),
      readHistoryPage: (ref, before) => this.historyPage(ref, before),
      readHistoryFeedPage: (page) => this.storage.readHistoryFeedPage(this.tenant, page),
      readTimeline: (ref) => this.timeline(ref),
      readTimelinePage: (ref, before) => this.timelinePage(ref, before),
    };
  }

  /** Checks who is calling and what they sent, then runs the operation. `plan` is null for reads. */
  private async run(operation: Operation, username: string, letInAs: string | undefined, input: unknown, plan: Plan | null, now: string): Promise<any> {
    const caller = this.user(username);
    if (!caller) throw new VigileError("unauthorized", `There is no user called "${echo(username)}".`);
    if (letInAs !== undefined && caller.id !== letInAs) {
      throw new VigileError("unauthorized", `The user "${username}" this request was let in as has been deleted since, and the name belongs to someone else now.`, {
        actions: ["Send the request again with an API key of the present user."],
      });
    }
    if (!mayCall(operation, caller.type)) {
      throw forbidden(`${operation.name} is for ${(operation.access as readonly string[]).join(" or ")} users; you are connected as ${caller.username}, a${caller.type === "agent" ? "n" : ""} ${caller.type}.`);
    }
    const parsed = operation.input.safeParse(input ?? {});
    if (!parsed.success) {
      // The first few of what is wrong, each in a few words: a mistake names fields the caller made up, and
      // there can be as many mistakes as there are fields.
      const all = parsed.error.issues as Array<{ path: PropertyKey[]; message: string }>;
      const issues = all.slice(0, MOST_ISSUES).map((issue) => {
        const where = issue.path.length ? echo(issue.path.join(".")) : "input";
        return /received undefined$/.test(issue.message) ? `${where} is required.` : `${where}: ${echo(issue.message.replace(/\.$/, ""), MOST_OF_AN_ISSUE)}.`;
      });
      if (all.length > MOST_ISSUES) issues.push(`And ${all.length - MOST_ISSUES} more.`);
      throw invalidInput(`The input for ${operation.name} is not valid. ${issues.join(" ")}`);
    }
    const ctx = this.context(caller, now);
    return operation.kind === "read" ? operation.run(ctx, parsed.data) : operation.run({ ...ctx, graph: this.graph, inTurn: (read) => read(), plan: plan!, keys: this.keys }, parsed.data);
  }

  private async write(operation: Operation, username: string, letInAs: string | undefined, input: unknown): Promise<unknown> {
    if (this.stale) await this.load();
    for (let attempt = 0; ; attempt++) {
      const now = this.clock.now().toISOString();
      const plan = new Plan(this.counters);
      let reply: () => unknown;
      try {
        reply = await this.run(operation, username, letInAs, input, plan, now);
      } catch (error) {
        // A write that reads beside its checked plan can discover that another engine moved the store while it
        // was reading. Refresh and rerun once, just as when the eventual commit finds that same revision drift.
        if (!(error instanceof RevisionConflictError)) throw error;
        this.stale = true;
        await this.load();
        if (attempt === 0) continue;
        throw error;
      }
      if (plan.mutations.length) {
        const caller = this.user(username)!;
        try {
          const head = await this.storage.commit(this.tenant, {
            expectedRevision: this.revision,
            counters: plan.counters,
            changes: toChanges(plan.mutations, now, caller.id),
          });
          this.apply(plan.mutations, head.revision);
          this.revision = head.revision;
          this.counters = head.counters;
          this.loadedAt = now;
          this.announce();
        } catch (error) {
          if (error instanceof CommitTooLargeError) {
            throw new VigileError("limit_exceeded", "This change touches too many records to store in one step.", {
              actions: ["Split it into smaller changes, for example by removing links first."],
            });
          }
          // Another writer got there first, or the outcome is unknown: memory may no longer match storage.
          this.stale = true;
          await this.load();
          if (error instanceof RevisionConflictError && attempt === 0) continue;
          throw error;
        }
      }
      return reply();
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => {});
    return next;
  }

  private apply(mutations: Mutation[], revision: number): void {
    // Each change is told to what keeps since when the items are unchanged, once the graph has it: a number is
    // kept only for an item that is in the graph, and an item that has left it takes its number along.
    for (const m of mutations) {
      switch (m.t) {
        case "put":
          this.graph.putNode(m.node);
          this.unchanged.stored(m.node, revision);
          break;
        case "remove":
          this.graph.removeNode(m.ref);
          this.unchanged.removed(m.ref, revision);
          break;
        case "link": {
          const there = this.graph.findLink(m.link) !== undefined;
          this.graph.addLink(m.link);
          this.unchanged.linked(m.link, 1, !there, revision);
          break;
        }
        case "unlink": {
          const there = this.graph.findLink(m.link) !== undefined;
          this.graph.removeLink(m.link);
          this.unchanged.linked(m.link, -1, there, revision);
          break;
        }
        case "history":
          this.unchanged.noted(m.ref, revision);
          break;
        // Neither the history nor the timelines are part of the plan in memory: they are read from the store.
        case "status":
        case "moment":
          break;
      }
    }
  }

  /** Rebuilds the in-memory graph from storage, creating the tenant with its built-in users on first use. */
  private async load(): Promise<void> {
    let snapshot = await this.storage.load(this.tenant);
    if (!snapshot) {
      await this.bootstrap();
      snapshot = await this.storage.load(this.tenant);
    }
    if (!snapshot) throw new Error(`Tenant "${this.tenant}" could not be created`);
    if (snapshot.head.format > FORMAT_VERSION) {
      throw new Error(
        `Tenant "${this.tenant}" uses data format ${snapshot.head.format}; this version of the service understands up to ${FORMAT_VERSION}. Upgrade the service.`,
      );
    }
    // Data of an earlier format is brought to the present one by the store when it opens it. Read as it is, its
    // records would lack what this version reads in them, and its timelines would be taken for empty.
    if (snapshot.head.format < FORMAT_VERSION) {
      throw new Error(`Tenant "${this.tenant}" is in data format ${snapshot.head.format}, which the store has not brought to format ${FORMAT_VERSION}, the one this version of the service reads.`);
    }
    const graph = new Graph();
    for (const record of snapshot.objects) graph.putNode(recordToNode(record));
    for (const record of snapshot.links) graph.addLink(recordToLink(record));
    // What is stored under an ID the store would not write: seen only here, since the plan in memory knows each
    // item by the one form of its ID.
    const misstored = new Set<string>();
    const stored = (what: string, kind: string, id: string): void => {
      const written = storedAs(kind, id);
      if (written !== id) misstored.add(`${what} is stored under "${id}", ${written === null ? "which is no ID of its kind" : `where the store writes "${written}": a change to it would miss what is stored`}`);
    };
    for (const record of snapshot.objects) stored(`The ${record.kind}`, record.kind, record.id);
    for (const record of snapshot.links) {
      stored(`The ${record.fromKind} at one end of a link`, record.fromKind, record.fromId);
      stored(`The ${record.toKind} at one end of a link`, record.toKind, record.toId);
    }
    this.misstored = [...misstored];
    const before = this.revision;
    this.graph = graph;
    // What was known of single items is of the plan that was in memory before: every item is as it was read now.
    this.unchanged = new Unchanged(graph, snapshot.head.revision);
    this.revision = snapshot.head.revision;
    this.format = snapshot.head.format;
    this.counters = snapshot.head.counters;
    this.loadedAt = this.clock.now().toISOString();
    this.stale = false;
    // Reading the plan again can bring in a change stored by another writer.
    if (before !== 0 && before !== this.revision) this.announce();
  }

  private async bootstrap(): Promise<void> {
    const now = this.clock.now().toISOString();
    const plan = new Plan({});
    const admin = userId(1);
    for (const builtIn of BUILT_IN_USERS) {
      const user: UserNode = {
        kind: "user",
        id: userId(plan.next("identity")),
        username: builtIn.username,
        type: builtIn.type,
        built_in: true,
        version: 1,
        created_at: now,
        created_by: admin,
        updated_at: now,
        deleted_at: null,
      };
      plan.put(user);
      plan.history(user, "created", { username: user.username, type: user.type, built_in: true });
    }
    try {
      await this.storage.commit(this.tenant, { expectedRevision: null, counters: plan.counters, changes: toChanges(plan.mutations, now, admin) });
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error;
    }
  }

  /** Forgets the in-memory graph and reads it again from storage. */
  async reload(): Promise<void> {
    await this.enqueue(() => this.load());
  }

  status(): EngineStatus {
    const counts: Record<string, number> = {};
    for (const kind of ["project", "task", "user"] as const) counts[kind] = this.graph.all(kind).length;
    // The prefixes that are used up are kept beside the counters. Here they are counted, not listed: there is
    // one for every project that was ever deleted for good.
    const names = Object.keys(this.counters);
    const counters = Object.fromEntries(names.filter((name) => !name.startsWith(RETIRED_PREFIX)).map((name) => [name, this.counters[name]!]));
    return {
      tenant: this.tenant,
      format: this.format,
      revision: this.revision,
      counters,
      retired_prefixes: names.length - Object.keys(counters).length,
      remembered: this.unchanged.size,
      counts,
      links: this.graph.links().length,
      loaded_at: this.loadedAt,
    };
  }

  async history(ref: Ref): Promise<HistoryItem[]> {
    const all = await this.storage.readHistory(this.tenant, ref.kind, storageId(ref.kind, ref.id));
    // An item's history begins where it was created. In data from before a prefix was given only once, a
    // project can have the history of an earlier project of its name stored in front of its own.
    const records = all.slice(Math.max(0, all.findLastIndex((r) => r.action === CREATED)));
    return records.map((r) => this.historyItem(r));
  }

  private historyItem(record: HistoryRecord): HistoryItem {
    const actor = this.graph.get("user", displayId("user", record.actor));
    return { at: record.at, by: actor?.username ?? displayId("user", record.actor), action: record.action, data: record.data };
  }

  /**
   * One page of an item's history, which begins where the item was created, as in `history`: neither the page
   * nor the count goes back beyond that. One entry more than a page is asked for: when it comes, there are
   * earlier entries, and it is left for the page before.
   */
  private async historyPage(ref: Ref, before?: HistoryPlace): Promise<HistoryPage> {
    const { records, total } = await this.storage.readHistoryPage(this.tenant, ref.kind, storageId(ref.kind, ref.id), {
      ...(before ? { before: { revision: before[0], seq: before[1] } } : {}),
      limit: LIMITS.page + 1,
      sinceLast: CREATED,
    });
    const shown = records.length > LIMITS.page ? records.slice(records.length - LIMITS.page) : records;
    const first = shown[0];
    return { items: shown.map((r) => ({ ...this.historyItem(r), place: [r.revision, r.seq] as const })), total, ...(first && shown.length < records.length ? { earlier: [first.revision, first.seq] as const } : {}) };
  }

  /**
   * Every status an item went through, oldest first, each at its place in the list: whoever asks for all of
   * them writes some of them back by their place. Entries that do not stand at the places 0, 1, 2 and so on
   * were damaged outside the service, and are not handed out as if they did.
   */
  private async timeline(ref: Ref): Promise<StatusEntry[]> {
    const revision = this.revision;
    const { records } = await this.storage.readTimeline(this.tenant, ref.kind, storageId(ref.kind, ref.id));
    const actual = await this.storage.readRevision(this.tenant);
    if (actual !== revision) throw new RevisionConflictError(this.tenant, revision, actual);
    const astray = records.findIndex((record, index) => record.place !== index);
    if (astray >= 0) throw new Error(`The timeline of ${ref.kind} ${ref.id} is damaged: the entry after place ${astray - 1} is at place ${records[astray]!.place}`);
    const entries = records.map((record) => ({ place: record.place, entry: recordToEntry(record.data) }));
    if (ref.kind === "project" || ref.kind === "task") {
      const problem = entriesProblem(ref.kind, entries);
      if (problem) throw new Error(`The timeline of ${ref.kind} ${ref.id} is damaged: ${problem}`);
    }
    return entries.map(({ entry }) => entry);
  }

  /** One page of an item's timeline: the latest entries, or the latest before a place, and how many there are in all. */
  private async timelinePage(ref: Ref, before?: number): Promise<TimelinePage> {
    const { records, total } = await this.storage.readTimeline(this.tenant, ref.kind, storageId(ref.kind, ref.id), { ...(before === undefined ? {} : { before }), limit: LIMITS.page });
    return { entries: records.map((record) => ({ ...recordToEntry(record.data), place: record.place })), total, from: records[0]?.place ?? 0 };
  }

  /**
   * Looks for damage in the timelines, which are stored beside the items and are not part of the plan in
   * memory: that each project and task has one, of statuses of its kind, that ends with the status the item
   * has. It reads every entry of every item from the store, a few hundred at a time, so it is for whoever
   * checks data before it is put to use, and not for a service that answers others meanwhile. It stops at the
   * first few items it finds damaged.
   */
  async checkTimelines(most = 3, signal?: AbortSignal): Promise<string[]> {
    // A diagnostic must not call a healthy timeline damaged just because another engine changed it during a
    // multi-page scan. Validate one revision at a time; refresh and retry on drift, then refuse an unstable scan.
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const revision = this.revision;
      const graph = this.graph;
      if ((await this.storage.readRevision(this.tenant)) !== revision) {
        signal?.throwIfAborted();
        await this.reload();
        continue;
      }
      const problems = await this.timelineProblems(graph, most, signal);
      signal?.throwIfAborted();
      if (this.graph === graph && this.revision === revision && (await this.storage.readRevision(this.tenant)) === revision) return problems;
      await this.reload();
    }
    throw new VigileError("too_many_requests", "The plan is being changed faster than its timelines can be checked.", { actions: ["Run doctor again."] });
  }

  private async timelineProblems(graph: GraphView, most: number, signal?: AbortSignal): Promise<string[]> {
    const problems: string[] = [];
    for (const node of [...graph.all("project"), ...graph.all("task")]) {
      if (problems.length >= most) break;
      const id = storageId(node.kind, node.id);
      let wrong: string | null = null;
      let end: { total: number; latest: StatusEntry | undefined } | undefined;
      let before: number | undefined;
      let expectedBefore: number | undefined;
      for (;;) {
        signal?.throwIfAborted();
        const { records, total } = await this.storage.readTimeline(this.tenant, node.kind, id, { ...(before === undefined ? {} : { before }), limit: TIMELINE_CHECKED_AT_ONCE });
        // SQLite reads are synchronous even though the storage contract is async. Yield between bounded pages
        // so an opt-in doctor scan cannot monopolize the HTTP event loop for a long history.
        await new Promise<void>((resolve) => setImmediate(resolve));
        signal?.throwIfAborted();
        const entries = records.map((record) => ({ place: record.place, entry: recordToEntry(record.data) }));
        end ??= { total, latest: entries.at(-1)?.entry };
        if (!records.length) {
          if (expectedBefore !== undefined && expectedBefore > 0) wrong ??= `timeline has entries missing before place ${expectedBefore}`;
          break;
        }
        const pageEnd = records.at(-1)!.place;
        const expectedEnd = expectedBefore ?? total;
        let gap: string | null = pageEnd === expectedEnd - 1 ? null : `has entries missing after place ${pageEnd} (expected place ${expectedEnd - 1})`;
        for (let index = 1; index < records.length && !gap; index++) {
          if (records[index]!.place !== records[index - 1]!.place + 1) gap = `has entries missing between places ${records[index - 1]!.place} and ${records[index]!.place}`;
        }
        // Read from the latest back, so what is found later stands earlier in the timeline: that is the one said.
        wrong = entriesProblem(node.kind, entries) ?? (gap ? `timeline ${gap}` : null) ?? wrong;
        expectedBefore = records[0]!.place;
        if (expectedBefore === 0) break;
        if (before !== undefined && expectedBefore >= before) {
          wrong ??= `timeline pages did not move before place ${before}`;
          break;
        }
        before = expectedBefore;
      }
      wrong ??= timelineProblem(node, end.total, end.latest);
      if (wrong) problems.push(`The ${node.kind} ${node.id} is damaged: ${wrong}`);
    }
    return problems;
  }

  /** Looks for damage in the graph. An empty list means it is consistent. */
  checkConsistency(): string[] {
    return [...this.misstored, ...findInconsistencies(this.graph, this.counters)];
  }

  /** Waits for the write in flight, then stops accepting work. */
  async close(): Promise<void> {
    await this.queue;
    await this.storage.close();
  }
}

/**
 * Loops among the links that hold work back, found by walking the whole graph once: each item is gone into
 * once and left once, and a link that leads back to an item not yet left closes a loop. Asking for each link
 * whether its end leads back to its start would walk the graph once for every link.
 */
function findLoops(graph: GraphView): string[] {
  const key = (ref: Ref) => `${ref.kind}:${ref.id}`;
  const holds = LINK_TYPES.filter((type) => type.effect !== "assigns").map((type) => type.type);
  const next = (ref: Ref): Ref[] => holds.flatMap((type) => graph.out(ref, type).map((link) => link.to)).filter((to) => graph.node(to));
  const left = new Set<string>();
  const loops: string[] = [];
  for (const start of [...graph.all("project"), ...graph.all("task")]) {
    if (left.has(key(start))) continue;
    // The way from the start to where the walk is now, with what is still to be tried from each step of it.
    const way: Array<{ ref: Ref; rest: Ref[] }> = [{ ref: start, rest: next(start) }];
    const onWay = new Set([key(start)]);
    while (way.length) {
      const step = way.at(-1)!;
      const to = step.rest.pop();
      if (!to) {
        left.add(key(step.ref));
        onWay.delete(key(step.ref));
        way.pop();
      } else if (onWay.has(key(to))) {
        const from = way.findIndex((s) => key(s.ref) === key(to));
        loops.push(`Loop: ${[...way.slice(from).map((s) => s.ref.id), to.id].join(" → ")}`);
      } else if (!left.has(key(to))) {
        onWay.add(key(to));
        way.push({ ref: to, rest: next(to) });
      }
    }
  }
  return loops;
}

function findInconsistencies(graph: GraphView, counters: Record<string, number>): string[] {
  const problems: string[] = [];
  // Each item as a record first: the checks after this one read the fields of items, and so does every answer
  // the service gives. An item whose fields are not what they have to be fails those, sooner or later.
  for (const node of graph.everything()) {
    const wrong = shapeProblem(node);
    if (wrong) problems.push(`The ${(node as { kind: string }).kind} ${node.id} is damaged: ${wrong}`);
  }
  const known = new Map(LINK_TYPES.map((t) => [t.type, t]));
  for (const link of graph.links()) {
    const from = graph.node(link.from);
    const to = graph.node(link.to);
    const label = `${link.from.kind}:${link.from.id} ${link.type} ${link.to.kind}:${link.to.id}`;
    if (!from || !to) problems.push(`Link points at an item that does not exist: ${label}`);
    const type = known.get(link.type);
    if (!type) problems.push(`Link has an unknown type: ${label}`);
    else if (!type.from.includes(link.from.kind) || !type.to.includes(link.to.kind)) problems.push(`Link connects the wrong kinds: ${label}`);
  }
  problems.push(...findLoops(graph));
  // What every list of tasks works out for each task, once for each here: whether it is waiting, who has it,
  // when it was completed. A task that fails this fails every list it is in. Each of these looks no further
  // than the task's own links; what a project adds up over all it holds is not part of this scan, which runs
  // while the service answers others.
  const learnt: Known = new Map();
  for (const task of graph.all("task")) {
    try {
      taskCalc(graph, task, learnt);
    } catch (error) {
      problems.push(`The task ${task.id} cannot be worked out: ${(error as Error).message}`);
    }
  }
  const highest = (nodes: Node[], number: (n: Node) => number) => nodes.reduce((max, n) => Math.max(max, number(n)), 0);
  const trailing = (id: string) => Number(/(\d+)$/.exec(id)?.[1] ?? 0);
  const checks: Array<[string, number]> = [
    [COUNTERS.task, highest(graph.all("task"), (n) => trailing(n.id))],
    [COUNTERS.identity, highest(graph.all("user"), (n) => trailing(n.id))],
    [COUNTERS.project, highest(graph.all("project").filter((p) => p.prefix === null), (n) => trailing(n.id))],
  ];
  for (const [counter, max] of checks) {
    if ((counters[counter] ?? 0) < max) problems.push(`The ${counter} counter is at ${counters[counter] ?? 0}, behind the highest ID in use (${max})`);
  }
  for (const builtIn of BUILT_IN_USERS) {
    const user = graph.userByName(builtIn.username);
    if (!user || !user.built_in) problems.push(`The built-in user "${builtIn.username}" is missing`);
    // What a built-in user may do comes with it and cannot be given back by anyone: an admin that is no admin
    // leaves nobody who can do what only an admin can.
    else if (user.type !== builtIn.type) problems.push(`The built-in user "${builtIn.username}" is of type ${user.type}, not ${builtIn.type}`);
  }
  // A name is one user's: a caller is known by it.
  const names = new Set<string>();
  for (const user of graph.all("user")) {
    if (names.has(user.username)) problems.push(`Two users are called "${user.username}"`);
    names.add(user.username);
  }
  return [...new Set(problems)];
}
