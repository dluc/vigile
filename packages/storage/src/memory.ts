import {
  FORMAT_VERSION,
  formatAfter,
  visibleLinkHistory,
  RevisionConflictError,
  assertCommitSize,
  assertTenantName,
  type CommitRequest,
  type Head,
  type HistoryPage,
  type HistoryPageRequest,
  type HistoryFeedPage,
  type HistoryFeedRecord,
  type HistoryFeedPageRequest,
  type HistoryRecord,
  type LinkKey,
  type LinkRecord,
  type ObjectRecord,
  type JsonObject,
  type Snapshot,
  type StorageAdapter,
  type TimelinePage,
  type TimelinePageRequest,
} from "./types.js";

interface Tenant {
  head: Head;
  objects: Map<string, ObjectRecord>;
  texts: Map<string, string>;
  links: Map<string, LinkRecord>;
  history: HistoryRecord[];
  /** The entries of each item's timeline, each at its place. */
  timelines: Map<string, JsonObject[]>;
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
      : { head: { format: FORMAT_VERSION, revision: 0, counters: {} }, objects: new Map(), texts: new Map(), links: new Map(), history: [], timelines: new Map() };
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
          t.timelines.delete(key);
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
        case "add_timeline": {
          const key = objectKey(change.record.kind, change.record.id);
          t.timelines.set(key, [...(t.timelines.get(key) ?? []), copy(change.record.data)]);
          break;
        }
        case "patch_timeline": {
          const entries = t.timelines.get(objectKey(change.kind, change.id)) ?? [];
          const from = Math.max(0, change.from);
          const to = Math.min(entries.length - 1, change.to);
          if (from > to) throw new Error(`The timeline of ${change.kind} ${change.id} has no entry from place ${change.from} to ${change.to}`);
          for (let place = from; place <= to; place++) {
            if (change.when && !(Date.parse(String(entries[place]?.at)) > Date.parse(change.when.at_after))) continue;
            entries[place] = { ...entries[place], ...copy(change.data) };
          }
          break;
        }
      }
    }
    t.head = { format: formatAfter(t.head.format, request.changes), revision, counters: { ...request.counters } };
    this.tenants.set(tenant, t);
    return copy(t.head);
  }

  async readRevision(tenant: string): Promise<number | null> {
    return this.tenants.get(tenant)?.head.revision ?? null;
  }

  async readText(tenant: string, kind: string, id: string): Promise<string | null> {
    return this.tenants.get(tenant)?.texts.get(objectKey(kind, id)) ?? null;
  }

  async readHistory(tenant: string, kind: string, id: string): Promise<HistoryRecord[]> {
    const t = this.tenants.get(tenant);
    return t ? copy(t.history.filter((h) => h.kind === kind && h.id === id)) : [];
  }

  async readHistoryPage(tenant: string, kind: string, id: string, page: HistoryPageRequest): Promise<HistoryPage> {
    const stored = this.tenants.get(tenant)?.history.filter((h) => h.kind === kind && h.id === id) ?? [];
    const since = page.sinceLast === undefined ? stored : stored.slice(Math.max(0, stored.findLastIndex((h) => h.action === page.sinceLast)));
    const all = !page.excludeKind ? since : since.filter(h => !(h.action === "link_added" || h.action === "link_removed") || visibleLinkHistory(page.excludeKind!,h.data.type,h.data.to));
    const { before } = page;
    const earlier = before ? all.filter((h) => h.revision < before.revision || (h.revision === before.revision && h.seq < before.seq)) : all;
    return { records: copy(earlier.slice(Math.max(0, earlier.length - page.limit))), total: all.length };
  }

  async readHistoryFeedPage(tenant: string, page: HistoryFeedPageRequest): Promise<HistoryFeedPage> {
    const stored = this.tenants.get(tenant);
    if (!stored) return { records: [], hasMore: false };

    const inProject = page.project === undefined ? null : new Set([objectKey("project", page.project)]);
    if (inProject) {
      let grew = true;
      while (grew) {
        grew = false;
        for (const link of stored.links.values()) {
          if (link.type !== "contains" || !inProject.has(objectKey(link.fromKind, link.fromId))) continue;
          const target = objectKey(link.toKind, link.toId);
          if (inProject.has(target)) continue;
          inProject.add(target);
          grew = true;
        }
      }
    }
    const inParent = page.parent === undefined ? null : new Set<string>();
    if (inParent) {
      const seen = new Set<string>();
      const queue = [objectKey("task", page.parent!)];
      seen.add(queue[0]!);
      for (let next = 0; next < queue.length; next++) {
        for (const link of stored.links.values()) {
          if (link.type !== "contains" || objectKey(link.fromKind, link.fromId) !== queue[next]) continue;
          const target = objectKey(link.toKind, link.toId);
          if (seen.has(target)) continue;
          seen.add(target);
          if (link.toKind === "task") inParent.add(target);
          queue.push(target);
        }
      }
    }

    const beginnings = new Map<string, HistoryRecord>();
    for (const record of stored.history) {
      if (record.action !== "created") continue;
      const key = objectKey(record.kind, record.id);
      const before = beginnings.get(key);
      if (!before || record.revision > before.revision || (record.revision === before.revision && record.seq > before.seq)) beginnings.set(key, record);
    }
    const before = page.before;
    const records = stored.history.filter((record) => {
      const start = beginnings.get(objectKey(record.kind, record.id));
      if (start && (record.revision < start.revision || (record.revision === start.revision && record.seq < start.seq))) return false;
      if (before && (record.revision > before.revision || (record.revision === before.revision && record.seq >= before.seq))) return false;
      if (page.project !== undefined && !inProject?.has(objectKey(record.kind, record.id))) return false;
      if (page.parent !== undefined && !inParent?.has(objectKey(record.kind, record.id))) return false;
      if (page.text !== undefined) {
        const needle = page.text.trim().toLowerCase();
        const item = stored.objects.get(objectKey(record.kind, record.id));
        const title = item?.data.title ?? item?.data.username;
        const publicId = record.kind === "user"
          ? `USER-${record.id.replace(/^0+(?=\d)/, "").padStart(3, "0")}`
          : record.kind === "project" && /^\d+$/.test(record.id)
            ? `project:${record.id}`
            : record.id;
        const matches = [record.id, publicId, typeof title === "string" ? title : ""].some((value) => value.toLowerCase().includes(needle));
        if (!matches) return false;
      }
      if (page.kind !== undefined && record.kind !== page.kind) return false;
      if (record.kind === page.excludeKind) return false;
      if (page.excludeKind && (record.action === "link_added" || record.action === "link_removed") && !visibleLinkHistory(page.excludeKind,record.data.type,record.data.to)) return false;
      if (page.actor !== undefined && record.actor !== page.actor) return false;
      if (page.action !== undefined && record.action !== page.action) return false;
      if (page.statusFrom !== undefined && (record.action !== "status_changed" || record.data.from !== page.statusFrom)) return false;
      if (page.statusTo !== undefined && (record.action !== "status_changed" || record.data.to !== page.statusTo)) return false;
      if (page.from !== undefined && record.at < page.from) return false;
      if (page.to !== undefined && record.at > page.to) return false;
      return true;
    }).sort((a, b) => b.revision - a.revision || b.seq - a.seq);
    const completionIndexes = new Map<string, number>();
    const nextCompletion = new Map<string, number>();
    for (const record of stored.history) {
      const key = objectKey(record.kind, record.id);
      const start = beginnings.get(key);
      if (!start) continue;
      const beforeStart = record.revision < start.revision || (record.revision === start.revision && record.seq < start.seq);
      if (beforeStart) continue;
      if (record.revision === start.revision && record.seq === start.seq) {
        nextCompletion.set(key, record.data.status === "done" ? 1 : 0);
        continue;
      }
      if (record.kind !== "task" || record.action !== "status_changed" || record.data.to !== "done") continue;
      const index = nextCompletion.get(key) ?? 0;
      completionIndexes.set(`${key}\u0000${record.revision}\u0000${record.seq}`, index);
      nextCompletion.set(key, index + 1);
    }

    const selected = records.slice(0, page.limit + 1);
    const pageRecords: HistoryFeedRecord[] = selected.slice(0, page.limit).map((record) => {
      if (record.kind !== "task" || record.action !== "status_changed" || record.data.to !== "done") return record;
      const key = objectKey(record.kind, record.id);
      const index = completionIndexes.get(`${key}\u0000${record.revision}\u0000${record.seq}`);
      const completedAt = index === undefined
        ? undefined
        : (stored.timelines.get(key) ?? []).filter((entry) => entry.status === "done")[index]?.at;
      return typeof completedAt === "string" ? { ...record, completion_at: completedAt } : record;
    });
    return { records: copy(pageRecords), hasMore: selected.length > page.limit };
  }

  async readTimeline(tenant: string, kind: string, id: string, page: TimelinePageRequest = {}): Promise<TimelinePage> {
    const all = this.tenants.get(tenant)?.timelines.get(objectKey(kind, id)) ?? [];
    const end = Math.max(0, Math.min(page.before ?? all.length, all.length));
    const start = page.limit === undefined ? 0 : Math.max(0, end - page.limit);
    return { records: all.slice(start, end).map((data, index) => ({ kind, id, place: start + index, data: copy(data) })), total: all.length };
  }

  async close(): Promise<void> {}
}
