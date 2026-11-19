import { KINDS, comparePlaces, compareProjectIds, compareTaskIds, compareUserIds, placeOf, refId } from "./ids.js";

/**
 * How a list is read a page at a time: what a continuation token is, which list it belongs to, and the steps
 * by which anyone reads a list to its end. This is the one place that says so, for the service that makes the
 * tokens and for everything that follows them: the engine's own readers, the command line and the page in the
 * browser.
 *
 * This file and `ids.ts` use nothing but the language: no Node.js, no library. They are compiled to plain
 * modules that the service also hands to the browser as they are (`/shared/paging.js`), so the page runs these
 * very rules and none of its own.
 */

/* What a token is made of. */

/**
 * A token is a few dozen characters. Something much longer is none, and is not read to find that out. A sort
 * key that would make a longer one, which only an ID that damage left can, is not written into the token: the
 * token carries its mark, which is as short for a key of any length (`placeMark`).
 */
export const LONGEST_TOKEN = 1000;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const VALUE_OF = new Map([...ALPHABET].map((letter, value) => [letter, value]));
const asBytes = new TextEncoder();
const asText = new TextDecoder("utf-8", { fatal: true });

/** Bytes as letters, digits, "-" and "_": what can be written into a command or an address as it is. */
function written(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i]!, bytes[i + 1], bytes[i + 2]];
    text += ALPHABET[a >> 2]! + ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) text += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) text += ALPHABET[c & 63]!;
  }
  return text;
}

/** The bytes that were written that way, or nothing when the text is not what `written` gives for any bytes. */
function readBytes(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null;
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let held = 0;
  let at = 0;
  for (const letter of text) {
    const value = VALUE_OF.get(letter);
    if (value === undefined) return null;
    held = (held << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[at++] = (held >> bits) & 255;
    }
  }
  // What is left over says nothing: a text that hides something there is not one that was written.
  return (held & ((1 << bits) - 1)) === 0 ? bytes : null;
}

const K = new Uint32Array(64);
{
  // The first 64 primes, and of each the first 32 bits of the fraction of its cube root.
  let found = 0;
  for (let n = 2; found < 64; n++) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) prime = false;
    if (prime) K[found++] = Math.floor((Math.cbrt(n) % 1) * 2 ** 32);
  }
}

/** SHA-256, as the standard has it. Written out because the service and the browser both run this file, and only the language is there in both. */
export function sha256(message: Uint8Array): Uint8Array {
  const h = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
  const length = message.length;
  const padded = new Uint8Array(((length + 8) >> 6) * 64 + 64);
  padded.set(message);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 2 ** 29));
  view.setUint32(padded.length - 4, (length << 3) >>> 0);
  const w = new Uint32Array(64);
  const turn = (x: number, by: number) => (x >>> by) | (x << (32 - by));
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const [x, y] = [w[i - 15]!, w[i - 2]!];
      w[i] = (w[i - 16]! + (turn(x, 7) ^ turn(x, 18) ^ (x >>> 3)) + w[i - 7]! + (turn(y, 17) ^ turn(y, 19) ^ (y >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (turn(e, 6) ^ turn(e, 11) ^ turn(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((turn(a, 2) ^ turn(a, 13) ^ turn(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [hh, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    [a, b, c, d, e, f, g, hh].forEach((value, i) => (h[i] = (h[i]! + value) >>> 0));
  }
  const digest = new Uint8Array(32);
  h.forEach((value, i) => new DataView(digest.buffer).setUint32(i * 4, value));
  return digest;
}

/** What a list is asked for, in a few characters: a token belongs to that question and to no other. */
export const questionMark = (question: unknown): string => written(sha256(asBytes.encode(JSON.stringify(question)))).slice(0, 12);

/** How a token names the user whose list it is. */
export const whoMark = (who: string): string => questionMark(["who", who]);

/**
 * The mark of a sort key, for a token that cannot carry the key itself: how long the key is as it is written,
 * and the SHA-256 of that. It is the same few dozen characters for a key of any length, and no two keys of a
 * list have the same.
 */
export type PlaceMark = readonly [length: number, digest: string, identity?: string];
export function placeMark(key: unknown, identity?: string): PlaceMark {
  const text = JSON.stringify(key);
  const digest = written(sha256(asBytes.encode(text)));
  return identity === undefined ? [text.length, digest] : [text.length, digest, identity];
}
const isPlaceMark = (value: unknown): value is PlaceMark =>
  Array.isArray(value) &&
  (value.length === 2 || value.length === 3) &&
  Number.isSafeInteger(value[0]) &&
  value[0] > 0 &&
  typeof value[1] === "string" &&
  /^[A-Za-z0-9_-]{43}$/.test(value[1]) &&
  (value[2] === undefined || (typeof value[2] === "string" && value[2].length > 0 && value[2].length <= 100));

/**
 * What a token says: which question it continues, whose list it is where the list is a user's own, and the
 * place of the last entry returned. The place is the entry's sort key (`k`), or, for a key too long to be
 * written into a token, its mark (`x`): one of the two, never both.
 */
export type OpenToken = { q: string; w?: string } & ({ k: unknown; x?: undefined } | { x: PlaceMark; k?: undefined });

/** The token that says this, and nothing else. */
export const sealToken = (says: { q: string; w?: string; k?: unknown; x?: unknown }): string =>
  written(asBytes.encode(JSON.stringify({ q: says.q, ...(says.w === undefined ? {} : { w: says.w }), ...(says.x === undefined ? { k: says.k } : { x: says.x }) })));

/**
 * What a token says, or nothing when the value is no token: a text of letters, digits, "-" and "_", no longer
 * than a token is, exactly as some question and place are written. There is one way to read a token, for the
 * service that is sent one and for whoever is handed one: what is not a token to one is not a token to the other.
 */
export function openToken(token: unknown): OpenToken | null {
  if (typeof token !== "string" || token === "" || token.length > LONGEST_TOKEN) return null;
  const bytes = readBytes(token);
  if (!bytes) return null;
  let read: unknown;
  try {
    read = JSON.parse(asText.decode(bytes));
  } catch {
    return null;
  }
  if (typeof read !== "object" || read === null || Array.isArray(read)) return null;
  const { q, w, k, x } = read as { q?: unknown; w?: unknown; k?: unknown; x?: unknown };
  if (typeof q !== "string" || q === "" || (w !== undefined && typeof w !== "string")) return null;
  const owned = w === undefined ? { q } : { q, w };
  if (x !== undefined) return k === undefined && isPlaceMark(x) ? { ...owned, x } : null;
  return k === undefined ? null : { ...owned, k };
}

/** Whether a value is a continuation token. It begins with a letter and holds nothing a shell or a command line acts on. */
export const isToken = (value: unknown): value is string => openToken(value) !== null;

/** Whether a token names the place of a sort key: it carries that very key, or its mark. */
export function namesPlace(says: OpenToken, key: unknown, identity?: string): boolean {
  const text = JSON.stringify(key);
  if (says.x === undefined) return JSON.stringify(says.k) === text;
  // The length first: among the keys of a list, few are as long as the one that is looked for.
  return says.x[0] === text.length && says.x[1] === placeMark(key)[1] && (says.x[2] === undefined || says.x[2] === identity);
}

/* Which list a token belongs to. */

/**
 * The question of a list operation: its name and its filters, which is everything of its input but the token,
 * as the operation takes it. In whatever order the filters were written, the question is the same.
 */
export function questionOfList(operation: string, input: Record<string, unknown> = {}): unknown {
  const filters = Object.entries(input)
    .filter(([name, value]) => name !== "continuation" && value !== undefined)
    .map(([name, value]) => [
      name,
      operation === "list_history" && ["project", "parent", "text", "actor", "action"].includes(name) && typeof value === "string" ? value.trim() : value,
    ] as const);
  return [operation, Object.fromEntries(filters.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))];
}

/** Where a list of an item stands in the answer of `get`. A list of links stands under its name in `links`. */
export type At = readonly ["links", string] | readonly ["timeline"] | readonly ["history"];

/** The question of one of an item's lists: the item, by its kind and its ID as it is stored, and where the list stands. */
export const itemListQuestion = (item: { kind: string; id: string }, at: At): unknown => ["get", item.kind, item.id, ...at];

/* What a list is: everything that making, reading and following its tokens goes by. */

/**
 * Whose a list is, which a token of it says the same way:
 * - `NOBODY`: the list is the same for whoever asks. A token of it names no user, and one that does is not its own.
 * - a user's ID: the list is that user's own. A token of it names that user.
 * - `SOMEONE`: the list is a user's own, and whoever holds the descriptor does not know that user's ID, as the
 *   command line does not know its own. A token of it names a user; which one, only the service can tell.
 */
export const NOBODY = "the list is nobody's own";
export const SOMEONE = "the list is someone's own";
export type Owner = typeof NOBODY | typeof SOMEONE | { readonly who: string };

/**
 * One list that is read in pages. It says all there is to say for a token of it and for reading it: what the
 * list was asked for, whose it is, what its sort key looks like, in what order the keys are, what the key of an
 * entry is, and what tells an entry from every other for as long as the list is read. The service makes and
 * reads the list's tokens by it, and whoever follows them reads the list by it: none of these is ever left out,
 * and nothing about a list is said anywhere else.
 */
export interface ListDescriptor<Key = any> {
  /** What the entries are called, for what is said of them. */
  readonly entries: string;
  /** What the list was asked for: the operation and its filters, or the item and its list. A token names it. */
  readonly question: unknown;
  /** Whose the list is. A token says so in the same way, exactly. */
  readonly owner: Owner;
  /** What a sort key of the list looks like: every key an entry can have, and nothing else. */
  isKey(key: unknown): key is Key;
  /** Below nought when `a` is read before `b`. No two keys are in the same place. */
  compare(a: Key, b: Key): number;
  /** The sort key of an entry as an answer shows it: exactly the key the service names in the token after that entry. It may change while a list is read, as a task's priority does. */
  keyOf(entry: any): unknown;
  /** What an entry is, whatever its place: it does not change while the list is read, and no two entries of a list have the same. A text, or nothing for what is no entry. */
  identityOf(entry: any): string | undefined;
  /** A bounded identity carried only beside the digest of an overlong key, so that key can be found directly. */
  markIdentity?(key: Key): string | undefined;
}

type Order<Key> = Pick<ListDescriptor<Key>, "entries" | "isKey" | "compare" | "keyOf" | "identityOf" | "markIdentity">;

/** An ID as it is written, whatever it is: no ID is turned into a number, which cannot hold every one. */
const isId = (key: unknown): key is string => typeof key === "string";
const isCount = (key: unknown): key is number => Number.isSafeInteger(key) && (key as number) >= 0;
const idOf = (entry: any): string | undefined => (typeof entry?.id === "string" ? entry.id : undefined);
const inOrderOfIds = (entries: string, compare: (a: string, b: string) => number): Order<string> => ({ entries, isKey: isId, compare, keyOf: (entry) => entry?.id, identityOf: idOf });
/** The item at the other end of a link, as its kind and its ID as it is stored. */
const refOf = (key: string): { kind: "project" | "task" | "user"; id: string } => ({ kind: key.slice(0, key.indexOf(":")) as "project" | "task" | "user", id: key.slice(key.indexOf(":") + 1) });
const linkKey = (entry: any): string | undefined => (typeof entry?.id === "string" && (KINDS as readonly unknown[]).includes(entry?.kind) ? `${entry.kind}:${refId(entry.kind, entry.id)}` : undefined);

const ORDERS = {
  list_projects: inOrderOfIds("projects", compareProjectIds),
  list_tasks: inOrderOfIds("tasks", compareTaskIds),
  list_decisions: inOrderOfIds("decisions", compareTaskIds),
  /** Recorded changes across the tenant, newest first by the revision that stored them. */
  list_history: {
    entries: "changes",
    isKey: (key: unknown): key is readonly [number, number] => Array.isArray(key) && key.length === 2 && key.every(isCount),
    compare: (a: readonly [number, number], b: readonly [number, number]) => b[0] - a[0] || b[1] - a[1],
    keyOf: (entry: any): unknown => entry?.place,
    identityOf: (entry: any) => (Array.isArray(entry?.place) && entry.place.length === 2 && entry.place.every(isCount) ? entry.place.join(".") : undefined),
  } satisfies Order<readonly [number, number]>,
  list_users: inOrderOfIds("users", compareUserIds),
  /**
   * Containment priority path first, highest at the first difference, then by ID. A prefix comes before what it
   * contains. The list is the asking user's own: its tokens name that user. A task's place moves with its active
   * path; what the task is, is its ID.
   */
  list_next_tasks: {
    entries: "tasks",
    isKey: (key: unknown): key is [number[], string] => Array.isArray(key) && key.length === 2 && Array.isArray(key[0]) && key[0].length > 0 && key[0].every((part) => typeof part === "number" && Number.isFinite(part)) && isId(key[1]),
    compare: (a: [number[], string], b: [number[], string]) => {
      const common = Math.min(a[0].length, b[0].length);
      for (let at = 0; at < common; at++) if (a[0][at] !== b[0][at]) return b[0][at]! - a[0][at]!;
      return a[0].length - b[0].length || compareTaskIds(a[1], b[1]);
    },
    keyOf: (entry: any): unknown => [entry?.priority_path, entry?.id],
    identityOf: idOf,
    markIdentity: (key: [number[], string]) => (key[1].length > 0 && key[1].length <= 100 ? key[1] : undefined),
  } satisfies Order<[number[], string]>,
  /** Quiet assigned work, oldest recorded task change first, then by ID. */
  list_stale_tasks: {
    entries: "claims",
    isKey: (key: unknown): key is [string, string] => Array.isArray(key) && key.length === 2 && typeof key[0] === "string" && Number.isFinite(Date.parse(key[0])) && isId(key[1]),
    compare: (a: [string, string], b: [string, string]) => Date.parse(a[0]) - Date.parse(b[0]) || compareTaskIds(a[1], b[1]),
    keyOf: (entry: any): unknown => [entry?.quiet_since, entry?.id],
    identityOf: idOf,
  } satisfies Order<[string, string]>,
  /**
   * The links of one name: in the order of the items at the other end, each by its kind and its ID as it is
   * stored. An answer shows the ID as a reference is written, which for a project with a number is with its
   * kind in front; the key is read back from that, digit for digit.
   */
  links: {
    entries: "links",
    isKey: (key: unknown): key is string => typeof key === "string" && (KINDS as readonly string[]).includes(key.slice(0, Math.max(0, key.indexOf(":")))),
    compare: (a: string, b: string) => comparePlaces(placeOf(refOf(a)), placeOf(refOf(b))),
    keyOf: linkKey,
    identityOf: linkKey,
  } satisfies Order<string>,
  /** The statuses an item went through, the latest first: an entry's key is its place, counted from the item's first status. */
  timeline: { entries: "statuses", isKey: isCount, compare: (a: number, b: number) => b - a, keyOf: (entry: any): unknown => entry?.place, identityOf: (entry: any) => (isCount(entry?.place) ? String(entry.place) : undefined) } satisfies Order<number>,
  /** The recorded changes, the latest first: an entry's key is its place, which is the revision that wrote it and its number in that revision. */
  history: {
    entries: "changes",
    isKey: (key: unknown): key is readonly [number, number] => Array.isArray(key) && key.length === 2 && key.every(isCount),
    compare: (a: readonly [number, number], b: readonly [number, number]) => b[0] - a[0] || b[1] - a[1],
    keyOf: (entry: any): unknown => entry?.place,
    identityOf: (entry: any) => (Array.isArray(entry?.place) && entry.place.length === 2 && entry.place.every(isCount) ? entry.place.join(".") : undefined),
  } satisfies Order<readonly [number, number]>,
} as const;

/** The operations that return a list in pages, each with the field its entries are in. */
export const PAGED = { list_projects: "projects", list_tasks: "tasks", list_decisions: "decisions", list_history: "changes", list_next_tasks: "tasks", list_stale_tasks: "claims", list_users: "users" } as const;
export type PagedOperation = keyof typeof PAGED;
export const isPaged = (operation: string): operation is PagedOperation => Object.hasOwn(PAGED, operation);
/** The lists that are the asking user's own. */
const OWN: readonly string[] = ["list_next_tasks"];

/**
 * The list that an operation returns for a call of it: the operation with the filters of the call, which are
 * its input as the operation takes it. Where the list is the asking user's own, `who` is that user's ID; left
 * out, the list is someone's whom the holder of the descriptor does not know.
 */
export function describeList<O extends PagedOperation>(operation: O, input: Record<string, unknown> = {}, who?: string): ListDescriptor<Parameters<(typeof ORDERS)[O]["compare"]>[0]> {
  const owner: Owner = !OWN.includes(operation) ? NOBODY : who === undefined ? SOMEONE : { who };
  return { ...ORDERS[operation], question: questionOfList(operation, input), owner } as ListDescriptor;
}

/** One of the lists of an item that `get` returns in pages: its links under one name, its timeline, its history. They are the same for whoever asks. */
export function describeItemList<A extends At>(item: { kind: string; id: string }, at: A): ListDescriptor<Parameters<(typeof ORDERS)[A[0]]["compare"]>[0]> {
  return { ...ORDERS[at[0]], question: itemListQuestion(item, at), owner: NOBODY } as ListDescriptor;
}

/** What answered is not a list as the service gives one. `why` says what was wrong with it, for whoever reads the list to put into its own words. */
export class NotAList extends Error {
  constructor(readonly why: string) {
    super(why);
    this.name = "NotAList";
  }
}

/** Whether what a token says of whose it is, is what the list says: exactly, with nothing more and nothing less. */
function ownedAs(list: ListDescriptor, says: OpenToken): boolean {
  if (list.owner === NOBODY) return says.w === undefined;
  if (list.owner === SOMEONE) return typeof says.w === "string" && /^[A-Za-z0-9_-]{12}$/.test(says.w);
  return says.w === whoMark(list.owner.who);
}

/**
 * What a token of a list says: the one check of a token, for the service that is sent one and for whoever is
 * about to print one or send one on. It is a token; of this list, which is the same question and the same
 * owner, said as the list says it; and the place it names is one a place in this list can be: a sort key of the
 * list, or the mark of one. Anything else is said with `NotAList`.
 */
export function tokenOf(list: ListDescriptor, token: unknown): OpenToken {
  const says = openToken(token);
  if (!says) throw new NotAList("it goes on with what is no continuation token");
  if (says.q !== questionMark(list.question) || !ownedAs(list, says)) throw new NotAList("it goes on with the token of another list");
  if (says.x === undefined && !list.isKey(says.k)) throw new NotAList("it goes on with a token that names no place in the list");
  return says;
}

/** Whether a value is a token of a list: see `tokenOf`. */
export function isTokenOf(list: ListDescriptor, token: unknown): boolean {
  try {
    tokenOf(list, token);
    return true;
  } catch {
    return false;
  }
}

/**
 * The token of a list that goes on after the entry with a sort key: the one way a token is made. It carries
 * the key, or, where that would make it longer than a token is, the key's mark: there is a token for every key.
 * Nothing for what is no key of the list.
 */
export function tokenAfter(list: ListDescriptor, key: unknown): string | undefined {
  if (!list.isKey(key)) return undefined;
  const says = { q: questionMark(list.question), ...(typeof list.owner === "object" ? { w: whoMark(list.owner.who) } : {}) };
  if (list.owner === SOMEONE) return undefined;
  const carried = sealToken({ ...says, k: key });
  return carried.length <= LONGEST_TOKEN ? carried : sealToken({ ...says, x: placeMark(key, list.markIdentity?.(key)) });
}

/* Reading a list to its end. */

/** How far anyone reads a list by itself: a thousand pages, of a hundred entries each. */
export const READING = { pages: 1000, entries: 100_000 } as const;

/** How far a reading has come. */
export interface Progress {
  /** Pages taken. */
  pages: number;
  /** Entries taken. */
  entries: number;
  /** What each entry taken is, whatever its place: at most `READING.entries` of them. */
  seen: Set<string>;
  /** The token that the page now awaited was asked for with, when it was asked for with one. */
  sent?: string;
  /** The place that token names, when it is known: the sort key of the furthest entry taken. */
  from?: unknown;
  /** Whose list this reading is, once a token has said so for a descriptor whose caller is unknown. */
  owner?: string;
}

export const begun = (): Progress => ({ pages: 0, entries: 0, seen: new Set() });

/** A page says that the list ends with it by carrying no continuation at all. */
export const ENDS = Symbol("the list ends here");

const shownKey = (key: unknown): string => (typeof key === "string" ? key : JSON.stringify(key)).slice(0, 80);

/** The sort key that is read last among some entries of a list, or nothing when there are none. */
function furthestOf(list: ListDescriptor, keys: unknown[]): unknown {
  let furthest: unknown;
  for (const key of keys) if (furthest === undefined || list.compare(furthest, key) < 0) furthest = key;
  return furthest;
}

/**
 * How far a reading has come of which nothing is known but the token its page was asked for with: a page that
 * was asked for by itself, as the command line asks for one. The place the page was asked from is the key the
 * token carries; where it carries only the mark of a key, that place is not known, and the page is held to
 * everything but it.
 */
export function askedWith(list: ListDescriptor, token: unknown): Progress {
  const says = tokenOf(list, token);
  return { pages: 1, entries: 0, seen: new Set(), sent: token as string, ...(says.x === undefined ? { from: says.k } : {}), ...(says.w === undefined ? {} : { owner: says.w }) };
}

/**
 * Takes a reading up where pages that are in hand left it: they are `pages` pages that hold `held`, and `token`
 * is what the last of them gave to go on with. The token is looked at by `tokenOf` before it is sent, and names
 * the place of the furthest entry in hand; a reading that holds `READING.pages` pages goes no further. Returns
 * how far the reading has come, with the token to ask the next page with in `sent`.
 */
export function resume(list: ListDescriptor, pages: number, held: unknown[], token: unknown): Progress {
  const says = tokenOf(list, token);
  if (pages >= READING.pages) throw new NotAList(`it goes on after ${READING.pages} pages`);
  const keys = held.map((entry) => list.keyOf(entry));
  const seen = new Set<string>();
  for (const entry of held) {
    const identity = list.identityOf(entry);
    if (identity === undefined || !list.isKey(list.keyOf(entry))) throw new NotAList(`its list of ${list.entries} holds what has no place in the list`);
    seen.add(identity);
  }
  const from = furthestOf(list, keys);
  if (from === undefined || !namesPlace(says, from, list.markIdentity?.(from))) throw new NotAList("it goes on from another place than the furthest of its entries");
  return { pages, entries: held.length, seen, sent: token as string, from, ...(says.w === undefined ? {} : { owner: says.w }) };
}

/**
 * One step of reading a list: takes the page that was answered, and says how the reading goes on. Returns the
 * token to ask the next page with, once and as it came, or nothing when the list has ended. Everything is
 * looked at before anything is taken, in this order, and the first thing that is not so ends the reading with
 * `NotAList`. It holds for every list alike, and for a last page as for one that goes on:
 *
 * 1. The answer holds a list of entries, each of which is something of its own and has a sort key of this list.
 * 2. What it goes on with is a token of this list that names a place in it (`tokenOf`).
 * 3. A page that goes on holds something.
 * 4. No entry is there twice: not in the page, and not in a page before. An entry is what `identityOf` says
 *    it is, whatever its place: a task that has moved in the list while it was read is the same task.
 * 5. With this page the reading holds no more than `READING.entries` entries, and a page that goes on is not
 *    the `READING.pages`th.
 * 6. Every entry is after the place the page was asked from.
 * 7. The token names the place of the furthest entry of the page: not one before it, which would lead back,
 *    and not one beyond it, which would pass entries over.
 *
 * In what order a page holds its entries is not looked at: that is the service's to say, and whoever shows a
 * list shows it as it came.
 *
 * Then the page is taken: counted, its entries remembered by what they are, and its token and the place it
 * names kept for the next page. A reading keeps that and nothing else, for at most `READING.entries` entries.
 */
export function takePage(list: ListDescriptor, progress: Progress, entries: unknown, continuation: unknown): string | undefined {
  const what = list.entries;
  const no = (why: string): never => {
    throw new NotAList(why);
  };
  // 1
  if (!Array.isArray(entries)) return no(`it holds no list of ${what}`);
  const keys = entries.map((entry) => list.keyOf(entry));
  const identities = entries.map((entry) => list.identityOf(entry));
  if (!keys.every((key) => list.isKey(key)) || !identities.every((identity) => typeof identity === "string")) return no(`its list of ${what} holds what has no place in the list`);
  // 2
  const goesOn = continuation !== ENDS;
  const says = goesOn ? tokenOf(list, continuation) : null;
  if (says?.w !== undefined && progress.owner !== undefined && says.w !== progress.owner) return no("it goes on with the token of another list");
  // 3
  if (goesOn && entries.length === 0) return no("it goes on after a page that holds nothing");
  // 4
  const inPage = new Set<string>();
  for (const identity of identities as string[]) {
    if (inPage.has(identity)) return no(`it holds ${shownKey(identity)} twice`);
    if (progress.seen.has(identity)) return no(`it holds ${shownKey(identity)}, which a page before held`);
    inPage.add(identity);
  }
  // 5
  if (progress.entries + entries.length > READING.entries) return no(`it holds more than ${READING.entries} ${what}`);
  if (goesOn && progress.pages + 1 >= READING.pages) return no(`it goes on after ${READING.pages} pages`);
  // 6
  const from = progress.from;
  if (from !== undefined) for (const key of keys) if (!(list.compare(from, key) < 0)) return no(`it holds ${shownKey(key)}, which is not after the place it was asked from`);
  // 7
  const furthest = furthestOf(list, keys);
  if (says && !namesPlace(says, furthest, list.markIdentity?.(furthest))) return no("it goes on from another place than the furthest of its entries");
  // Taken.
  progress.pages++;
  progress.entries += entries.length;
  for (const identity of inPage) progress.seen.add(identity);
  progress.sent = goesOn ? (continuation as string) : undefined;
  progress.from = goesOn ? furthest : undefined;
  if (says?.w !== undefined) progress.owner ??= says.w;
  return progress.sent;
}

/**
 * Reads a list to its end: asks for the first page without a token, takes each page by `takePage`, and asks
 * for the next with the token it was given, once. `ask` answers with a page: its entries and what it goes on
 * with, `ENDS` when it carries no continuation. Returns every entry, at most `READING.entries` of them after at
 * most `READING.pages` requests, or ends with `NotAList`.
 */
export async function readToEnd<T>(list: ListDescriptor, ask: (continuation: string | undefined) => Promise<{ entries: unknown; continuation: unknown }>): Promise<T[]> {
  const progress = begun();
  const found: T[] = [];
  let continuation: string | undefined;
  for (;;) {
    const page = await ask(continuation);
    continuation = takePage(list, progress, page.entries, page.continuation);
    for (const entry of page.entries as T[]) found.push(entry);
    if (continuation === undefined) return found;
  }
}
