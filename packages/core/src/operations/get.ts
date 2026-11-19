import { z } from "zod";
import type { GraphView } from "../graph.js";
import { comparePlaces, placeOf, type Place } from "../ids.js";
import { KINDS, LIMITS, type Kind, type Node, type Ref } from "../model.js";
import { defineRead, type ReadContext } from "../operation.js";
import { resolveRef } from "../rules.js";
import { timelinePage } from "../timeline.js";
import { detail, linkedItem, username, type Detail, type More } from "../views.js";
import { describeItemList, type At } from "../paging.js";
import { cursor, firstFew, kind, listOf, type Cursor } from "./shared.js";
import { readSteady } from "./steady.js";

interface ListPage {
  items: unknown[];
  /** How many entries the list has in all. */
  total: number;
  /** The token that reads the page after this one. Absent when this page ends the list. */
  next?: string;
}

/**
 * One of the lists an item is returned with. Each is read a page at a time and continued with a token of its
 * own, as the list operations are: the token belongs to this list of this item and to no other, and is made
 * and read by the list's cursor.
 */
interface ItemList<K = any> {
  at: At;
  cursor: Cursor<K>;
  /** The sort keys the list has now: gone through only for a token that names its place by a mark. */
  keys(): Iterable<K>;
  page(from?: K): ListPage | Promise<ListPage>;
}

/** A list of links is read from the plan in memory, there and then. */
interface LinkList extends ItemList<string> {
  page(from?: string): ListPage;
}

/** The sort key of a list of links: the item at the other end, as its kind and its ID as it is written. */
const refKey = (ref: Ref): string => `${ref.kind}:${ref.id}`;
const refOfKey = (key: string): Ref => ({ kind: key.slice(0, key.indexOf(":")) as Kind, id: key.slice(key.indexOf(":") + 1) });

/** The tokens of each list of an item. What each list is, is said in `paging.ts`. */
export const itemListCursors = {
  links: (item: Ref, name: string): Cursor<string> => cursor(describeItemList(item, ["links", name])),
  timeline: (item: Ref): Cursor<number> => cursor(describeItemList(item, ["timeline"])),
  history: (item: Ref): Cursor<readonly [number, number]> => cursor(describeItemList(item, ["history"])),
};

/** The token after a place in a list. There is one for every key of the list; that there is none says that the key is none. */
function tokenAfter<K>(list: Cursor<K>, key: K): string {
  const token = list.after(key);
  if (token === undefined) throw new Error(`No continuation token names the place of ${JSON.stringify(key)?.slice(0, 200)}.`);
  return token;
}

/**
 * The links of one type that start or end at an item, in the order of the IDs at their other end. The page is
 * picked in one pass over the item's links of that type: the list is not put in order to return a hundred.
 *
 * Only links whose other end exists count, for the page and for how many there are: a link that leads to
 * nothing, in data that was damaged, takes no place in a page and is not counted, so that a page is never empty
 * with more behind it and "100 of 105" is true of what the pages hold. Whether an end exists is asked in that
 * same pass, once for each link, before anything else is done with it: however many links lead nowhere, a call
 * goes through the item's links of that type once.
 *
 * A page holds at most a hundred links, whatever their ends are called. There is a token after every one: an
 * end whose ID is too long to be written into a token, as only damage leaves it, is named by the mark of its
 * key, and the next page finds it by that among the links there are.
 */
function linkList(graph: GraphView, node: Ref & {feature_profile?: string}, name: string, others: () => Ref[]): LinkList {
  const tokens = itemListCursors.links(node, name);
  return {
    at: ["links", name],
    cursor: tokens,
    *keys() {
      for (const ref of others()) if (graph.node(ref)) yield refKey(ref);
    },
    page(after) {
      type Placed = { ref: Ref; place: Place };
      const placed = (ref: Ref): Placed => ({ ref, place: placeOf(ref) });
      const from = after === undefined ? undefined : placed(refOfKey(after));
      let total = 0;
      function* there(): Generator<Placed> {
        for (const ref of others()) {
          if (!graph.node(ref)) continue;
          total++;
          yield placed(ref);
        }
      }
      // One more than a page: when it is there, the list goes on after this page.
      const first = firstFew(there(), LIMITS.page + 1, (a, b) => comparePlaces(a.place, b.place), from);
      const shown = first.slice(0, LIMITS.page);
      return {
        items: shown.flatMap(({ ref }) => {
          const other = graph.node(ref);
          return other ? [linkedItem(other)] : [];
        }),
        total,
        ...(first.length > shown.length ? { next: tokenAfter(tokens, refKey(shown.at(-1)!.ref)) } : {}),
      };
    },
  };
}

/** The lists of an item's links, by the name each has seen from the item. */
function linkLists(graph: GraphView, node: Node, features: ReadContext["features"]): LinkList[] {
  const ref = {kind:node.kind, id:node.id, ...features.profileTag};
  return features.links().flatMap((linkType) => [
    linkList(graph, ref, linkType.type, () => graph.out(node, linkType.type).map((link) => link.to).filter(ref => features.kind(ref.kind))),
    linkList(graph, ref, linkType.reverse, () => graph.in(node, linkType.type).map((link) => link.from).filter(ref => features.kind(ref.kind))),
  ]);
}

/**
 * The lists of an item that are not links: its timeline, unless it is a user, and its history. Of both the
 * latest entries come first: the last entry of the first page of a timeline is the status the item has now.
 * The token carries the place of the first entry returned, and the page before ends there.
 */
function recordLists(ctx: ReadContext, graph: GraphView, node: Node): ItemList[] {
  const ref = {kind:node.kind, id:node.id, ...ctx.features.profileTag};
  const places = itemListCursors.history(ref);
  const history: ItemList<readonly [number, number]> = {
    at: ["history"],
    cursor: places,
    keys: () => [],
    async page(before) {
      const { items, total, earlier } = await ctx.readHistoryPage(node, before);
      return { items, total, ...(earlier ? { next: tokenAfter(places, earlier) } : {}) };
    },
  };
  if (node.kind === "user") return [history];
  const counts = itemListCursors.timeline(ref);
  const timeline: ItemList<number> = {
    at: ["timeline"],
    cursor: counts,
    keys: () => [],
      async page(before) {
        const { entries, total, from } = await timelinePage(ctx, node, before);
        // Each entry says its place, counted from the item's first status: the token after a page names the place of its earliest entry.
        return { items: entries.map((entry) => ({ ...entry, by: username(graph, entry.by) })), total, ...(from > 0 ? { next: tokenAfter(counts, from) } : {}) };
    },
  };
  return [timeline, history];
}

type Lists = Pick<Detail, "links" | "timeline" | "history" | "more">;

/** Puts a page of a list where the list stands in the answer, and says in `more` when the list goes on. */
function put(answer: Partial<Lists>, list: ItemList, page: ListPage, evenEmpty: boolean): void {
  const more: More | undefined = page.next === undefined ? undefined : { total: page.total, continuation: page.next };
  if (list.at[0] === "links") {
    const name = list.at[1];
    answer.links ??= {};
    if (page.items.length || evenEmpty) answer.links[name] = page.items as Lists["links"][string];
    if (more) ((answer.more ??= {}).links ??= {})[name] = more;
    return;
  }
  (answer as Record<string, unknown>)[list.at[0]] = page.items;
  if (more) (answer.more ??= {})[list.at[0]] = more;
}

export const get = defineRead({
  name: "get",
  description:
    'Read one project, task or user in full: its description, its links in both directions, its calculated state, its status timeline and its version. Ask for history to also get the recorded changes. Deleted items can still be read. Each list in the answer holds at most 100 entries: the links of each kind, in the order of their IDs; the latest entries of the timeline and of the history, oldest first; and contained_in, depends_on, assigned_to and waiting_for. When a list has more, "more" says how many it has in all ("total") and, for links, timeline and history, gives a continuation token: call get again with the same id and that token to read the next page of that list alone, which for the timeline and the history holds the entries before the ones already read. Each entry of the timeline and of the history says its "place" in the list. A list that is not named in "more" is whole. Every answer carries "unchanged_since": the revision of the plan since which nothing that get shows of the item has changed: the item itself, its links in either direction, its timeline and history, and what its lists show of the items and users at their other end. Pages belong together when they say the same "unchanged_since"; when a page says another, something was added, removed or changed in between: read the item again from the start. An item that contains others says another after any change to any task, since its progress and problems are worked out from all it contains. The item\'s "version" does not tell: a task that is put into a group, taken out of it or changed changes what the group\'s lists show and not the group\'s version. Every answer is of one state of the item; should the plan be changed faster than the item can be read, the call is refused with too_many_requests: call it again.',
  access: "all",
  input: z.strictObject({
    kind,
    id: z.string().describe("The item's ID, or a username for a user."),
    history: z.boolean().optional().describe("true to also return the recorded changes to the item: when, by whom, and what. The latest 100, oldest first."),
    continuation: z
      .string()
      .optional()
      .describe('A continuation token from "more" in an earlier answer for the same item, to read the next page of that one list. The answer then holds the item\'s kind, id, version and unchanged_since, and that list only.'),
  }),
  run(ctx, input) {
    const token = input.continuation;
    // Parts of the answer are waited for, and the plan may change or be read anew meanwhile. The answer is of one
    // revision of the plan all the same, and says since when its item is unchanged: see `readSteady`. Each try
    // finds the item anew, in the graph of that try, and takes from that graph whatever it reads of the plan.
    return readSteady(ctx, async (graph) => {
      const node = resolveRef(graph, input.id, (input.kind ? [input.kind] : KINDS).filter(k => ctx.features.kind(k)));
      const since = ctx.unchangedSince(node);
      const visibleLinks = () => linkLists(graph, node, ctx.features);
      if (token !== undefined) {
        const list = listOf<ItemList>(token, [...visibleLinks(), ...recordLists(ctx, graph, node)]);
        const reading = list.page(list.cursor.place(token, () => list.keys()));
        const read = reading instanceof Promise ? await reading : reading;
        return {
          // A page of links is read from the plan in memory; history and timeline pages come from the store.
          stored: list.at[0] === "history" || list.at[0] === "timeline",
          finish: () => {
            const page: Partial<Lists> = {};
            put(page, list, read, true);
            return { kind: node.kind, id: node.id, version: node.version, unchanged_since: since, ...ctx.features.profileTag, ...page };
          },
        };
      }
      const text = node.kind === "user" ? null : await ctx.readText(node);
      const answer: Partial<Lists> = {};
      for (const list of recordLists(ctx, graph, node)) {
        if (list.at[0] === "history" && !input.history) continue;
        put(answer, list, await list.page(), false);
      }
      return {
        stored: node.kind !== "user" || input.history === true,
        // What the plan in memory says of the item is read last and in one go, and only when the plan has not
        // moved since the try began: the item, its links, what they show of other items and the names of users
        // are all of that one revision.
        finish: () => {
          for (const list of visibleLinks()) put(answer, list, list.page(), false);
          return { ...detail(graph, node, text, { ...answer, links: answer.links ?? {}, unchanged_since: since }), ...ctx.features.profileTag };
        },
      };
    });
  },
});
