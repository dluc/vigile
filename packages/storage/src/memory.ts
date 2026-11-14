import {
  FORMAT_VERSION,
  RevisionConflictError,
  assertCommitSize,
  assertTenantName,
  type CommitRequest,
  type Head,
  type HistoryRecord,
  type LinkKey,
  type LinkRecord,
  type ObjectRecord,
  type Snapshot,
  type StorageAdapter,
} from "./types.js";

interface Tenant {
  head: Head;
  objects: Map<string, ObjectRecord>;
  texts: Map<string, string>;
  links: Map<string, LinkRecord>;
  history: HistoryRecord[];
}

const objectKey = (kind: string, id: string) => `${kind}\u0000${id}`;
const linkKey = (k: LinkKey) => [k.fromKind, k.fromId, k.type, k.toKind, k.toId].join("\u0000");
const copy = <T>(value: T): T => structuredClone(value);

/** Keeps everything in process memory. For tests and as the reference behaviour of the contract. */
export class MemoryStorage implements StorageAdapter {
  private readonly tenants = new Map<string, Tenant>();

  async load(tenant: string): Promise<Snapshot | null> {
    assertTenantName(tenant);
    const t = this.tenants.get(tenant);
    if (!t) return null;
    return copy({ head: t.head, objects: [...t.objects.values()], links: [...t.links.values()] });
  }

  async commit(tenant: string, request: CommitRequest): Promise<Head> {
    assertTenantName(tenant);
    assertCommitSize(request);
    const existing = this.tenants.get(tenant);
    const actual = existing ? existing.head.revision : null;
    if (actual !== request.expectedRevision) throw new RevisionConflictError(tenant, request.expectedRevision, actual);

    const t: Tenant = existing
      ? copy(existing)
      : { head: { format: FORMAT_VERSION, revision: 0, counters: {} }, objects: new Map(), texts: new Map(), links: new Map(), history: [] };
    const revision = t.head.revision + 1;
    let seq = 0;
    for (const change of request.changes) {
      switch (change.op) {
        case "put_object": {
          const key = objectKey(change.record.kind, change.record.id);
          t.objects.set(key, copy(change.record));
          if (change.text !== undefined) t.texts.set(key, change.text);
          break;
        }
        case "delete_object": {
          const key = objectKey(change.kind, change.id);
          t.objects.delete(key);
          t.texts.delete(key);
          t.history = t.history.filter((h) => h.kind !== change.kind || h.id !== change.id);
          break;
        }
        case "put_link":
          t.links.set(linkKey(change.record), copy(change.record));
          break;
        case "delete_link":
          t.links.delete(linkKey(change.key));
          break;
        case "add_history":
          t.history.push({ ...copy(change.record), revision, seq: seq++ });
          break;
      }
    }
    t.head = { format: t.head.format, revision, counters: { ...request.counters } };
    this.tenants.set(tenant, t);
    return copy(t.head);
  }

  async readText(tenant: string, kind: string, id: string): Promise<string | null> {
    return this.tenants.get(tenant)?.texts.get(objectKey(kind, id)) ?? null;
  }

  async readHistory(tenant: string, kind: string, id: string): Promise<HistoryRecord[]> {
    const t = this.tenants.get(tenant);
    return t ? copy(t.history.filter((h) => h.kind === kind && h.id === id)) : [];
  }

  async close(): Promise<void> {}
}
