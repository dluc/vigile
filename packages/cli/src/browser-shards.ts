/**
 * The browser suites that GitHub runs in parallel. Local `pnpm test` leaves the shard unset and runs them all.
 * This is the one list used by the browser test and the shard runner; duplicate suite names fail at import.
 */
export const BROWSER_TEST_SHARDS = {
  "browser-refreshing": ["refreshing"],
  "browser-panel-access": ["reading on in the panel, while other things happen", "settings", "room", "access", "the keyboard, when the control that had it goes"],
  "browser-visual": ["board", "collapsed columns", "graph", "history", "themes", "background lights", "a large plan"],
} as const;

export type BrowserTestShard = keyof typeof BROWSER_TEST_SHARDS;
export type BrowserTestSuite = (typeof BROWSER_TEST_SHARDS)[BrowserTestShard][number];

const assigned = Object.values(BROWSER_TEST_SHARDS).flat();
if (new Set(assigned).size !== assigned.length) throw new Error("A browser test suite belongs to more than one shard.");
