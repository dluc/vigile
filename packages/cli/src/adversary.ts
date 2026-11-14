/**
 * Something that answers in the service's place, in every way in which a list read page by page can be none
 * of the service's. One table, held against everything that reads a list or prints how to read one on: the
 * engine's `readAll`, the command line's `allUsers` and what it prints of an answer, the page's lists and the
 * panel of an item.
 *
 * This file imports nothing and uses nothing but the language: its compiled text is also run in the browser,
 * where the page's readers are tried. The rules of paging are handed in (`paging` is core's `paging.ts`).
 */

/** The list that is read, and what the reader has in hand when the answers of the table begin. */
export interface Target {
  /** What kind of list it is: this decides what a new entry and its sort key look like. */
  list: "users" | "tasks" | "projects" | "next_tasks" | "links" | "timeline" | "history";
  /** What the list's entries are called where a reader says what is wrong: the descriptor's word. */
  entries: string;
  /** What the list was asked for. */
  question: unknown;
  /** Whose the list is: nobody's, a user's whose ID is given, or someone's whom the reader does not know. */
  owner: "nobody" | "someone" | { who: string };
  /** Whether the reader keeps what it has read from one page to the next, or looks at each page by itself, as the command line does when it prints one. */
  remembers: boolean;
  /** How many pages the reader holds before the first answer of the table: none, or the first page of an item's list. */
  first: number;
  /** How many entries those pages hold. */
  held: number;
  /** One of those entries, when there are any. */
  seen?: unknown;
  /** Tokens that are tokens, of other lists: by what makes each another list. */
  foreign: Record<string, string>;
}

/** One way of not being a list of the service's. */
export interface Case {
  name: string;
  /** The answer to the nth request of the reader, counted from 1, which was made with the token `sent`. */
  page(n: number, sent: unknown): { entries: unknown; continuation?: unknown };
  /** What the reader says is wrong, in the words of the rules, or nothing when the list is one and is read to its end. */
  why: string | null;
  /** How many requests the reader makes before it stops. */
  requests: number;
  /** How many entries the reader has when the list is one. */
  holds?: number;
  /** Whether the way is one of holding or asking for more than anyone reads, which has no meaning for a single page. */
  limit?: boolean;
}

export function adversary(paging: any, target: Target): Case[] {
  const { pages: mostPages, entries: mostEntries } = paging.READING as { pages: number; entries: number };
  /**
   * A new entry of the list, the nth in the order the list is read in, after everything the reader holds. A
   * timeline and a history are read from the latest entry back: further on is an earlier place.
   */
  const entry = (n: number): any => {
    if (target.list === "users") return { kind: "user", id: `USER-${5_000_000 + n}`, username: `u${n}`, type: "agent", built_in: false, version: 1 };
    if (target.list === "projects") return { kind: "project", id: `${9_000_000_000_000_000 + n}`, title: `Made up ${n}`, status: "open" };
    if (target.list === "links") return { kind: "task", id: `ZZZ-${1000 + n}`, title: `Made up ${n}`, status: "open" };
    if (target.list === "timeline") return { status: "open", at: "2026-01-01T00:00:00.000Z", by: "admin", place: 1_000_000_000 - n };
    if (target.list === "history") return { at: "2026-01-01T00:00:00.000Z", by: "admin", action: "updated", data: {}, place: [0, 1_000_000 - n] };
    return { kind: "task", id: `ZZZ-${1000 + n}`, title: `Made up ${n}`, type: "task", status: "open", priority: target.list === "next_tasks" ? -1e300 : 0 };
  };
  /** The sort key of the nth new entry: what the service would put into the token after it. */
  const key = (n: number): unknown => {
    if (target.list === "links") return `task:ZZZ-${1000 + n}`;
    if (target.list === "next_tasks") return [-1e300, `ZZZ-${1000 + n}`];
    if (target.list === "timeline" || target.list === "history") return entry(n).place;
    return entry(n).id;
  };
  /** How a token of this list says whose it is: not at all, or by the mark of its user. */
  const owned = target.owner === "nobody" ? {} : { w: paging.whoMark(target.owner === "someone" ? "USER-777" : target.owner.who) };
  const q = paging.questionMark(target.question);
  const seal = (k: unknown): string => paging.sealToken({ q, ...owned, k });
  /** The token that names the place of a key by its mark, as the service does for a key too long to carry. */
  const marked = (k: unknown): string => paging.sealToken({ q, ...owned, x: paging.placeMark(k) });
  /** The token of this list that goes on after its nth new entry. */
  const own = (n: number): string => seal(key(n));
  const one = (n: number) => ({ entries: [entry(n)], continuation: own(n) });
  /** A token that says what is handed in, as it is written: for what is put together in no way a token is. */
  const written = (says: Record<string, unknown>): string => {
    const text = JSON.stringify(says);
    let binary = "";
    for (let i = 0; i < text.length; i++) binary += String.fromCharCode(text.charCodeAt(i) & 255);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const several = (from: number, count: number): any[] => Array.from({ length: count }, (_, i) => entry(from + i));
  const shown = (k: unknown): string => (typeof k === "string" ? k : JSON.stringify(k)).slice(0, 80);
  const notAfter = (k: unknown): string => `it holds ${shown(k)}, which is not after the place it was asked from`;
  const notFurthest = "it goes on from another place than the furthest of its entries";
  /** What an entry is, whatever its place, as the list has it. */
  const identity = (e: any): string => (target.list === "links" ? `${e.kind}:${e.kind === "project" && /^project:\d+$/.test(e.id) ? e.id.slice(8) : e.id}` : target.list === "timeline" ? String(e.place) : target.list === "history" ? e.place.join(".") : e.id);
  const before = (e: any): string => `it holds ${shown(identity(e))}, which a page before held`;
  /** The key of an entry the reader holds, as the list has it. */
  const keyOfSeen = (e: any): unknown => (target.list === "links" ? `${e.kind}:${e.kind === "project" && /^project:\d+$/.test(e.id) ? e.id.slice(8) : e.id}` : target.list === "next_tasks" ? [e.priority, e.id] : target.list === "timeline" || target.list === "history" ? e.place : e.id);
  /**
   * What is no sort key of this list: nothing that is one, a key of the wrong sort, a list or fields where one
   * value is, and what is a key of another list and looks like one.
   */
  const noKeys: unknown[] =
    target.list === "next_tasks"
      ? [{}, null, 5, "ZZZ-1", [0], [0, "ZZZ-1", 3], ["0", "ZZZ-1"], [null, "ZZZ-1"], [0, 5], { priority: 0, id: "ZZZ-1" }]
      : target.list === "links"
        ? [{}, null, 5, "ZZZ-1", "thing:ZZZ-1", ":ZZZ-1", ["task:ZZZ-1"], [0, "ZZZ-1"], { kind: "task", id: "ZZZ-1" }]
        : target.list === "timeline"
          ? [{}, null, "5", -1, 1.5, 2 ** 60, [5], [5, 0], "task:ZZZ-1", { place: 5 }]
          : target.list === "history"
            ? [{}, null, 5, "5", [5], [5, -1], [1.5, 0], ["1", "2"], [1, 2, 3], "task:ZZZ-1", { revision: 1, seq: 0 }]
            : [{}, null, 5, ["ZZZ-1"], [0, "ZZZ-1"], { id: "ZZZ-1" }, true];

  return [
    // Lists of the service's, to their end: read whole. In what order a page holds its entries is the service's to say.
    { name: "three pages and an end", page: (n) => (n < 3 ? { entries: several(n * 10, 10), continuation: own(n * 10 + 9) } : { entries: several(30, 5) }), why: null, requests: 3, holds: 25 },
    { name: "pages whose entries are in another order", page: (n) => (n < 3 ? { entries: several(n * 10, 10).reverse(), continuation: own(n * 10 + 9) } : { entries: several(30, 5).reverse() }), why: null, requests: 3, holds: 25 },
    { name: "a last page that holds nothing", page: (n) => (n === 1 ? one(1) : { entries: [] }), why: null, requests: 2, holds: 1 },
    // As far as anyone reads: the last page that may go on, and no further.
    { name: "as many pages as are read, and the last one ends the list", page: (n) => (n + target.first < mostPages ? one(n) : { entries: [entry(n)] }), why: null, requests: mostPages - target.first, holds: mostPages - target.first, limit: true },
    { name: "a last page that holds more than is read", page: () => ({ entries: several(1, mostEntries - target.held + 1) }), why: `it holds more than ${mostEntries} ${target.entries}`, requests: 1, limit: true },
    { name: "a page that goes on and holds more than is read", page: () => ({ entries: several(1, mostEntries - target.held + 1), continuation: own(mostEntries - target.held + 1) }), why: `it holds more than ${mostEntries} ${target.entries}`, requests: 1, limit: true },
    { name: "pages without end, each new and each with a new token", page: (n) => one(n), why: `it goes on after ${mostPages} pages`, requests: mostPages - target.first, limit: true },
    // Tokens that lead back.
    { name: "two tokens that lead to each other", page: (n) => ({ entries: [entry(n)], continuation: own(n === 3 ? 1 : n) }), why: notFurthest, requests: 3 },
    { name: "a token that leads to itself", page: (n, sent) => ({ entries: [entry(n)], continuation: n === 1 ? own(1) : sent }), why: notFurthest, requests: 2 },
    // Tokens of other lists.
    ...Object.entries(target.foreign).map(([what, token]): Case => ({ name: `a token of ${what}`, page: () => ({ entries: [entry(1)], continuation: token }), why: "it goes on with the token of another list", requests: 1 })),
    // Whose the list is, said in the token exactly as the list has it: a user where the list is nobody's own, no
    // user or another where it is a user's.
    ...(target.owner === "nobody"
      ? [{ name: "a token of this list that says it is a user's own", page: () => ({ entries: [entry(1)], continuation: paging.sealToken({ q, w: paging.whoMark("USER-001"), k: key(1) }) }), why: "it goes on with the token of another list", requests: 1 }]
      : [
          { name: "a token of this list that is nobody's own", page: () => ({ entries: [entry(1)], continuation: paging.sealToken({ q, k: key(1) }) }), why: "it goes on with the token of another list", requests: 1 },
          { name: "a token of this list with what names no user where its user is", page: () => ({ entries: [entry(1)], continuation: paging.sealToken({ q, w: "x", k: key(1) }) }), why: "it goes on with the token of another list", requests: 1 },
          ...(target.owner === "someone"
            ? [{ name: "a token of this list that is some user's own, whoever that is", page: (n: number) => (n === 1 ? { entries: [entry(1)], continuation: paging.sealToken({ q, w: paging.whoMark("USER-123456"), k: key(1) }) } : { entries: [entry(2)] }), why: null, requests: 2, holds: 2 }]
            : [{ name: "a token of this list that is another user's own", page: () => ({ entries: [entry(1)], continuation: paging.sealToken({ q, w: paging.whoMark(`${(target.owner as { who: string }).who}0`), k: key(1) }) }), why: "it goes on with the token of another list", requests: 1 }]),
        ]),
    // A place named by its mark, as the service names one whose key is too long for a token: taken when it is the
    // mark of the furthest entry, and of no other.
    { name: "a token that names the place of the furthest entry by its mark", page: (n) => (n === 1 ? { entries: [entry(1), entry(2)], continuation: marked(key(2)) } : { entries: [entry(3)] }), why: null, requests: 2, holds: 3 },
    { name: "a mark of another place than the furthest entry", page: () => ({ entries: [entry(1), entry(2)], continuation: marked(key(1)) }), why: notFurthest, requests: 1 },
    { name: "a mark of a place beyond the furthest entry", page: () => ({ entries: [entry(1), entry(2)], continuation: marked(key(7)) }), why: notFurthest, requests: 1 },
    ...([[5, "short"], ["5", paging.placeMark(key(1))[1]], [0, paging.placeMark(key(1))[1]], paging.placeMark(key(1))[1], { length: 5 }] as unknown[]).map(
      (none): Case => ({ name: `what is no mark of a place: ${JSON.stringify(none).slice(0, 40)}`, page: () => ({ entries: [entry(1)], continuation: paging.sealToken({ q, ...owned, x: none }) }), why: "it goes on with what is no continuation token", requests: 1 }),
    ),
    { name: "a token with a key and a mark", page: () => ({ entries: [entry(1)], continuation: written({ q, ...owned, k: key(1), x: paging.placeMark(key(1)) }) }), why: "it goes on with what is no continuation token", requests: 1 },
    // What is no token.
    ...(["the next page", "", 5, null, { q: "x", k: 1 }, `${own(1)}=`, ` ${own(1)}`, `${own(1)}A`] as unknown[]).map(
      (none): Case => ({ name: `what is no token: ${JSON.stringify(none).slice(0, 30)}`, page: () => ({ entries: [entry(1)], continuation: none }), why: "it goes on with what is no continuation token", requests: 1 }),
    ),
    // A token of this very list, with what is no sort key of it where the key is.
    ...noKeys.map((none): Case => ({ name: `a token of this list with no key of it: ${JSON.stringify(none)}`, page: () => ({ entries: [entry(1)], continuation: seal(none) }), why: "it goes on with a token that names no place in the list", requests: 1 })),
    // The same after a page that was one: the second answer is looked at as the first.
    { name: "a second page with a token that has no key of the list", page: (n) => (n === 1 ? one(1) : { entries: [entry(2)], continuation: seal({}) }), why: "it goes on with a token that names no place in the list", requests: 2 },
    // Entries again.
    // Entries again. An entry is what it is, whatever its place: a reader that keeps what it has read knows it
    // again, and one that looks at a page by itself finds it at a place the page was not asked for.
    { name: "an entry twice in one page", page: () => ({ entries: [entry(1), entry(2), entry(1)] }), why: `it holds ${shown(identity(entry(1)))} twice`, requests: 1 },
    { name: "an entry twice in one page that goes on", page: () => ({ entries: [entry(1), entry(1)], continuation: own(1) }), why: `it holds ${shown(identity(entry(1)))} twice`, requests: 1 },
    target.seen !== undefined
      ? { name: "an entry of a page before", page: () => ({ entries: [target.seen] }), why: target.remembers ? before(target.seen) : notAfter(keyOfSeen(target.seen)), requests: 1 }
      : { name: "an entry of a page before", page: (n) => (n === 1 ? one(1) : { entries: [entry(1)] }), why: target.remembers ? before(entry(1)) : notAfter(key(1)), requests: 2 },
    { name: "an entry of a page before, among new ones, in a page that goes on", page: (n) => (n === 1 ? one(5) : { entries: [entry(6), entry(5), entry(7)], continuation: own(7) }), why: target.remembers ? before(entry(5)) : notAfter(key(5)), requests: 2 },
    // A task that can be started moves in its list with its priority, and is the same task: under another
    // priority it is there twice all the same, in one page or in a later one.
    ...(target.list === "next_tasks"
      ? [
          { name: "a task twice in one page, under two priorities", page: () => ({ entries: [entry(1), { ...entry(1), priority: -2e300 }] }), why: `it holds ${entry(1).id} twice`, requests: 1 },
          {
            name: "a task of a page before, further on under another priority",
            page: (n: number) => (n === 1 ? one(1) : { entries: [{ ...entry(1), priority: -2e300 }] }),
            // Looked at by itself, the later page is a page of the list: it is the reading of both that holds the task twice.
            ...(target.remembers ? { why: before(entry(1)), requests: 2 } : { why: null, requests: 2, holds: 2 }),
          },
          { name: "a task of a page before, further on under another priority, in a page that goes on", page: (n: number) => (n === 1 ? one(1) : n === 2 ? { entries: [{ ...entry(1), priority: -2e300 }], continuation: seal([-2e300, entry(1).id]) } : { entries: [] }), ...(target.remembers ? { why: before(entry(1)), requests: 2 } : { why: null, requests: 3, holds: 2 }) },
        ]
      : []),
    // No progress, and too much of it.
    { name: "a page that holds nothing and goes on", page: () => ({ entries: [], continuation: own(1) }), why: "it goes on after a page that holds nothing", requests: 1 },
    { name: "a last page of entries from before the place that was reached", page: (n) => (n === 1 ? one(5) : { entries: [entry(2), entry(3)] }), why: notAfter(key(2)), requests: 2 },
    { name: "a page that goes on, of entries from before the place that was reached", page: (n) => (n === 1 ? one(5) : one(2)), why: notAfter(key(2)), requests: 2 },
    { name: "a token of an earlier place than the page was asked from", page: (n) => (n === 1 ? one(5) : { entries: [entry(6)], continuation: own(3) }), why: notFurthest, requests: 2 },
    { name: "a token that passes entries over: of a place beyond the furthest entry", page: () => ({ entries: [entry(1), entry(2)], continuation: own(7) }), why: notFurthest, requests: 1 },
    { name: "a token of the place of an entry that is not the furthest", page: () => ({ entries: [entry(1), entry(2), entry(3)], continuation: own(2) }), why: notFurthest, requests: 1 },
    { name: "a second page with a token that passes entries over", page: (n) => (n === 1 ? one(1) : { entries: [entry(2), entry(3)], continuation: own(9) }), why: notFurthest, requests: 2 },
    // No list.
    { name: "no list", page: () => ({ entries: "none" }), why: `it holds no list of ${target.entries}`, requests: 1 },
    { name: "nothing where the list is", page: () => ({ entries: undefined, continuation: own(1) }), why: `it holds no list of ${target.entries}`, requests: 1 },
    { name: "entries that have no place in the list", page: () => ({ entries: [{ title: "No ID" }, null] }), why: `its list of ${target.entries} holds what has no place in the list`, requests: 1 },
  ];
}
