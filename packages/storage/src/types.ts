export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** The contract's limit, set by the weakest adapter (Azure Table storage). Every adapter enforces it. */
export const MAX_RECORDS_PER_COMMIT = 100;

/**
 * The form of what is stored, counted up each time it changes in a way that an earlier version of the service
 * would misread. A version refuses data of a later format than its own.
 * 1: the statuses an item has had are a list inside its record.
 * 2: they are entries of their own beside the record (`TimelineRecord`), and a task's record says when the task
 *    was completed.
 */
export const FORMAT_VERSION = 2;
/** Format 3 uses the same tables, but older clients cannot interpret decision objects. */
export const DECISION_FORMAT = 3;

export function formatAfter(current: number, changes: readonly Change[]): number {
  return changes.some(c => c.op === "put_object" && c.record.kind === "decision") ? Math.max(current, DECISION_FORMAT) : current;
}

export interface Head {
  format: number;
  revision: number;
  counters: Record<string, number>;
}

export interface ObjectRecord {
  kind: string;
  id: string;
  version: number;
  data: JsonObject;
}

export interface LinkKey {
  fromKind: string;
  fromId: string;
  type: string;
  toKind: string;
  toId: string;
}

export interface LinkRecord extends LinkKey {
  data: JsonObject;
}

export interface HistoryInput {
  kind: string;
  id: string;
  at: string;
  actor: string;
  action: string;
  data: JsonObject;
}

export interface HistoryRecord extends HistoryInput {
  revision: number;
  seq: number;
}

/** Where a history entry stands among those of its item: the revision that wrote it, and its place in that revision. */
export interface HistoryPlace {
  revision: number;
  seq: number;
}

export interface HistoryPageRequest {
  /** Only entries before this one. */
  before?: HistoryPlace;
  limit: number;
  /** The action whose last entry is where the history begins. */
  sinceLast?: string;
}

export interface HistoryPage {
  /** Oldest first. */
  records: HistoryRecord[];
  /** How many entries the history has in all, on this page or not. */
  total: number;
}

/** Filters for the tenant-wide History feed. Project membership follows current containment links. */
export interface HistoryFeedFilters {
  /** A stored project ID; includes that project's events and events for items it contains. */
  project?: string;
  /** A stored task ID; includes events for its current contents at any depth, not the group itself. */
  parent?: string;
  /** A case-insensitive substring of an item's ID, title or username. */
  text?: string;
  kind?: string;
  /** A stored user ID. */
  actor?: string;
  action?: string;
  /** Only status changes whose previous status is this task or project status. */
  statusFrom?: string;
  /** Only status changes whose new status is this task or project status. */
  statusTo?: string;
  /** Inclusive ISO timestamp bounds. */
  from?: string;
  to?: string;
}

export interface HistoryFeedPageRequest extends HistoryFeedFilters {
  /** Only events before this place in the tenant-wide history. */
  before?: HistoryPlace;
  limit: number;
}

/** A feed entry with the effective timeline moment for a completed task event, when available. */
export interface HistoryFeedRecord extends HistoryRecord {
  completion_at?: string;
}

export interface HistoryFeedPage {
  /** Newest first, ordered by the revision and sequence that recorded each event. */
  records: HistoryFeedRecord[];
  /** Whether another matching event exists before this page. */
  hasMore: boolean;
}

/** One of the statuses an item has had, as it is added: the store gives it the place after the last. */
export interface TimelineInput {
  kind: string;
  id: string;
  data: JsonObject;
}

/** One of the statuses an item has had. Its place is its number among them, counted from 0 without gaps. */
export interface TimelineRecord extends TimelineInput {
  place: number;
}

export interface TimelinePageRequest {
  /** Only entries before this place. */
  before?: number;
  /** At most this many, the latest of them. All of them when left out. */
  limit?: number;
}

export interface TimelinePage {
  /** Oldest first. */
  records: TimelineRecord[];
  /** How many entries the timeline has in all, on this page or not. */
  total: number;
}

export type Change =
  /** `text` left undefined keeps the stored text; a string replaces it. */
  | { op: "put_object"; record: ObjectRecord; text?: string }
  /** Takes the object's text, its history and its timeline with it: nothing stays stored under its kind and ID. */
  | { op: "delete_object"; kind: string; id: string }
  | { op: "put_link"; record: LinkRecord }
  | { op: "delete_link"; key: LinkKey }
  | { op: "add_history"; record: HistoryInput }
  /** Adds an entry after the last of an item's timeline. What is written is that one entry, however many came before. */
  | { op: "add_timeline"; record: TimelineInput }
  /**
   * Sets the given fields in entries of an item's timeline from one place to another, both included, and leaves
   * their other fields as they are. With `when.at_after`, only entries whose ISO timestamp field `at` is later
   * than that moment are changed; a nonempty stretch with no matching entries is a no-op. It is one record of
   * the commit however many entries it reaches: what is stored is one statement about a stretch of the timeline,
   * and whether an adapter rewrites each entry or keeps the statement and applies it when it reads is its own
   * affair. A stretch that holds no entry at all fails the commit.
   */
  | { op: "patch_timeline"; kind: string; id: string; from: number; to: number; data: JsonObject; when?: { at_after: string } };

export interface Snapshot {
  head: Head;
  objects: ObjectRecord[];
  links: LinkRecord[];
}

export interface CommitRequest {
  /** The revision the caller last saw; `null` means the tenant must not exist yet. */
  expectedRevision: number | null;
  counters: Record<string, number>;
  changes: Change[];
}

export interface StorageAdapter {
  /** Loads everything except long text, history and timelines. Returns `null` for a tenant that does not exist. */
  load(tenant: string): Promise<Snapshot | null>;
  /**
   * Applies all changes and moves the tenant revision forward by one, or does nothing at all.
   * Rejects with `RevisionConflictError` when the stored revision is not `expectedRevision`.
   */
  commit(tenant: string, request: CommitRequest): Promise<Head>;
  /**
   * The revision the tenant is at, and nothing else: `null` for a tenant that does not exist. Whoever holds the
   * plan in memory and reads text or history beside it asks this after those reads: the revision only ever goes
   * up, so a store that is still at the revision of the plan in memory was there for each of the reads.
   */
  readRevision(tenant: string): Promise<number | null>;
  readText(tenant: string, kind: string, id: string): Promise<string | null>;
  /** Oldest first. */
  readHistory(tenant: string, kind: string, id: string): Promise<HistoryRecord[]>;
  /**
   * The latest entries of an item's history, at most `limit` of them, oldest first: the latest of all, or the
   * latest before a given entry. With them, how many entries the item has in all. An item with a long history
   * is read a page at a time, and the count does not read the entries.
   *
   * With `sinceLast`, the history that is returned and counted begins at the last entry of that action: what
   * was stored before it under the same kind and ID is as if it were not there. Without such an entry it is
   * all of the history.
   */
  readHistoryPage(tenant: string, kind: string, id: string, page: HistoryPageRequest): Promise<HistoryPage>;
  /** A bounded tenant-wide history page, newest first, with optional item and time filters. */
  readHistoryFeedPage(tenant: string, page: HistoryFeedPageRequest): Promise<HistoryFeedPage>;
  /**
   * The entries of an item's timeline, oldest first: all of them, or at most `limit` of the latest, or of the
   * latest before a place. With them, how many entries the timeline has in all. Neither a page nor the count
   * reads the entries that are not returned.
   */
  readTimeline(tenant: string, kind: string, id: string, page?: TimelinePageRequest): Promise<TimelinePage>;
  close(): Promise<void>;
}

export class RevisionConflictError extends Error {
  constructor(
    readonly tenant: string,
    readonly expected: number | null,
    readonly actual: number | null,
  ) {
    super(`Tenant "${tenant}" is at revision ${actual ?? "none"}, expected ${expected ?? "none"}`);
    this.name = "RevisionConflictError";
  }
}

export class CommitTooLargeError extends Error {
  constructor(readonly records: number) {
    super(`A commit holds at most ${MAX_RECORDS_PER_COMMIT} records, got ${records}`);
    this.name = "CommitTooLargeError";
  }
}

/** The tenant head counts as one record. */
export function assertCommitSize(request: CommitRequest): void {
  const records = request.changes.length + 1;
  if (records > MAX_RECORDS_PER_COMMIT) throw new CommitTooLargeError(records);
}

export const isTenantName = (tenant: string): boolean => /^[a-z][a-z0-9-]{0,62}$/.test(tenant);

export function assertTenantName(tenant: string): void {
  if (!isTenantName(tenant)) throw new Error(`Invalid tenant name: ${JSON.stringify(tenant)}`);
}
