import type { Change, JsonObject, LinkKey, LinkRecord, ObjectRecord } from "@vigile/storage";
import { userId, userNumber } from "./ids.js";
import { KINDS, type Kind, type Link, type Node, type Ref, type StatusEntry } from "./model.js";
import type { Mutation } from "./operation.js";

/** For users only the number is stored; `USER-` is added when an ID is shown. */
export const storageId = (kind: Kind, id: string): string => (kind === "user" ? String(userNumber(id)) : id);

export const displayId = (kind: Kind, id: string): string => (kind === "user" ? userId(Number(id)) : id);

/**
 * The ID the store would write for a record that it has under `id`, or null when that is no ID of its kind at
 * all. The two differ when a record was put into the store by something else: a user stored under "04" is shown
 * as USER-004 like one stored under "4", and every change to it would go to "4", past the record that is there.
 */
export function storedAs(kind: string, id: string): string | null {
  if (!(KINDS as readonly string[]).includes(kind)) return id;
  try {
    return storageId(kind as Kind, displayId(kind as Kind, id));
  } catch {
    return null;
  }
}

/** A user reference inside a record, such as the creator. */
const actorToStorage = (id: string): string => storageId("user", id);
const actorFromStorage = (id: string): string => displayId("user", id);

export function nodeToRecord(node: Node): ObjectRecord {
  const { kind, id, version, created_by, ...rest } = node;
  const data: Record<string, unknown> = { ...rest, created_by: actorToStorage(created_by) };
  return { kind, id: storageId(kind, id), version, data: data as JsonObject };
}

export function recordToNode(record: ObjectRecord): Node {
  const kind = record.kind as Kind;
  const data = record.data as Record<string, any>;
  const node: Record<string, unknown> = {
    ...data,
    kind,
    id: displayId(kind, record.id),
    version: record.version,
    created_by: actorFromStorage(data.created_by),
  };
  // Tasks stored before the field existed have no reason recorded.
  if (kind === "task" && node.why === undefined) node.why = null;
  if (kind === "task" && node.type === undefined) node.type = "task";
  return node as unknown as Node;
}

/** An entry of a timeline as it is stored. */
const entryToRecord = (entry: StatusEntry): JsonObject => ({ ...entry, by: actorToStorage(entry.by) });

/**
 * An entry of a timeline as it was stored. It is read to be shown, so one that is not what the engine writes,
 * in data that was damaged, is shown as it is and fails nothing.
 */
export function recordToEntry(data: JsonObject): StatusEntry {
  // A damaged timeline row can contain JSON null or another scalar. Keep it as an invalid empty entry so
  // validation can name the timeline, and `get` can report it, instead of failing while decoding the row.
  if (data === null || typeof data !== "object" || Array.isArray(data)) return {} as StatusEntry;
  const by = data.by;
  return { ...data, by: typeof by === "string" && /^\d+$/.test(by) ? actorFromStorage(by) : by } as unknown as StatusEntry;
}

const linkKey = (link: Pick<Link, "from" | "type" | "to">): LinkKey => ({
  fromKind: link.from.kind,
  fromId: storageId(link.from.kind, link.from.id),
  type: link.type,
  toKind: link.to.kind,
  toId: storageId(link.to.kind, link.to.id),
});

export function recordToLink(record: LinkRecord): Link {
  const from: Ref = { kind: record.fromKind as Kind, id: displayId(record.fromKind as Kind, record.fromId) };
  const to: Ref = { kind: record.toKind as Kind, id: displayId(record.toKind as Kind, record.toId) };
  const data = record.data as { at: string; by: string };
  return { from, type: record.type, to, created_at: data.at, created_by: actorFromStorage(data.by) };
}

/** Turns what an operation planned into the records storage writes. */
export function toChanges(mutations: Mutation[], at: string, actor: string): Change[] {
  return mutations.map((m): Change => {
    switch (m.t) {
      case "put":
        return m.text === undefined ? { op: "put_object", record: nodeToRecord(m.node) } : { op: "put_object", record: nodeToRecord(m.node), text: m.text };
      case "remove":
        return { op: "delete_object", kind: m.ref.kind, id: storageId(m.ref.kind, m.ref.id) };
      case "link":
        return { op: "put_link", record: { ...linkKey(m.link), data: { at: m.link.created_at, by: actorToStorage(m.link.created_by) } } };
      case "unlink":
        return { op: "delete_link", key: linkKey(m.link) };
      case "history":
        return {
          op: "add_history",
          record: { kind: m.ref.kind, id: storageId(m.ref.kind, m.ref.id), at, actor: actorToStorage(actor), action: m.action, data: m.data as JsonObject },
        };
      case "status":
        return { op: "add_timeline", record: { kind: m.ref.kind, id: storageId(m.ref.kind, m.ref.id), data: entryToRecord(m.entry) } };
      case "moment":
        return {
          op: "patch_timeline",
          kind: m.ref.kind,
          id: storageId(m.ref.kind, m.ref.id),
          from: m.from,
          to: m.to,
          data: { at: m.at },
          ...(m.atAfter === undefined ? {} : { when: { at_after: m.atAfter } }),
        };
    }
  });
}
