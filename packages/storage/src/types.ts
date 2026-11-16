export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** The contract's limit, set by the weakest adapter (Azure Table storage). Every adapter enforces it. */
export const MAX_RECORDS_PER_COMMIT = 100;

export const FORMAT_VERSION = 1;

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

export type Change =
  /** `text` left undefined keeps the stored text; a string replaces it. */
  | { op: "put_object"; record: ObjectRecord; text?: string }
  /** Takes the object's text and its history with it: nothing stays stored under its kind and ID. */
  | { op: "delete_object"; kind: string; id: string }
  | { op: "put_link"; record: LinkRecord }
  | { op: "delete_link"; key: LinkKey }
  | { op: "add_history"; record: HistoryInput };

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
  /** Loads everything except long text and history. Returns `null` for a tenant that does not exist. */
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
