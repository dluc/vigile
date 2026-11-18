import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * A dependency is taken only once its version has been published for a while: a version that was compromised
 * or broken is usually found and withdrawn within that time. The wait is set in two places, one for what pnpm
 * resolves and one for what Dependabot proposes, and neither may fall below the least there is to be.
 */
const LEAST_DAYS = 21;

/** Text with the line ends of whatever system checked it out read as one. */
const lines = (text: string): string => text.replace(/\r\n?/g, "\n");

const fromRoot = (path: string): string => lines(readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"));

/**
 * The entries under `updates:` of a Dependabot file, each with its keys at one indentation whichever of them
 * comes first: the first key of an entry stands behind the dash, and is put where the others are.
 */
const updatesOf = (dependabot: string): string[] =>
  (/^updates:\n((?:(?: .*)?\n?)+)/m.exec(dependabot)?.[1] ?? "")
    .split(/^  - /m)
    .slice(1)
    .map((entry) => `    ${entry}`);

/** What one entry says of its ecosystem and of its cooldown, the days by their names. */
function cooldownOf(update: string): { ecosystem: string | undefined; days: Array<readonly [string, number]> } {
  const cooldown = /^    cooldown:[ \t]*(?:#.*)?\n((?:      .*\n?)+)/m.exec(update)?.[1] ?? "";
  return {
    ecosystem: /^    package-ecosystem:\s*["']?([^\s"'#]+)/m.exec(update)?.[1],
    days: [...cooldown.matchAll(/^      ([a-z-]+-days):\s*(\d+)\s*(?:#.*)?$/gm)].map((found) => [found[1]!, Number(found[2])] as const),
  };
}

describe("the wait before a dependency is taken", () => {
  it("is at least 21 days for what pnpm resolves, and excludes no package from it", () => {
    const workspace = fromRoot("pnpm-workspace.yaml");
    const set = [...workspace.matchAll(/^minimumReleaseAge:\s*(\d+)\s*(?:#.*)?$/gm)];
    assert.equal(set.length, 1, "pnpm-workspace.yaml sets minimumReleaseAge once");
    // pnpm counts in minutes.
    assert.ok(Number(set[0]![1]) >= LEAST_DAYS * 24 * 60, `minimumReleaseAge is ${set[0]![1]} minutes, less than ${LEAST_DAYS} days`);
    assert.doesNotMatch(workspace, /^minimumReleaseAgeExclude:/m, "no package is let through before its time");
  });

  it("is at least 21 days for every update Dependabot proposes", () => {
    const dependabot = fromRoot(".github/dependabot.yml");
    const updates = updatesOf(dependabot);
    assert.ok(updates.length >= 1, "Dependabot watches at least one ecosystem");
    assert.equal(updates.length, [...dependabot.matchAll(/^\s*(?:- )?package-ecosystem:/gm)].length, "every ecosystem that is named is an entry that is looked at");
    for (const update of updates) {
      const { ecosystem, days } = cooldownOf(update);
      assert.ok(ecosystem, "an entry names its ecosystem");
      assert.ok(days.some(([name]) => name === "default-days"), `${ecosystem}: the cooldown names default-days`);
      for (const [name, value] of days) assert.ok(value >= LEAST_DAYS, `${ecosystem}: ${name} is ${value}, less than ${LEAST_DAYS}`);
    }
  });

  it("is read from an entry whichever key comes first, and from a file checked out with other line ends", () => {
    // An entry that does not begin with its ecosystem, and has no cooldown: it is an entry, and it is found wanting.
    const reordered = "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    cooldown:\n      default-days: 21\n  - directory: /\n    package-ecosystem: github-actions\n    schedule:\n      interval: weekly\n";
    assert.deepEqual(updatesOf(reordered).map(cooldownOf), [
      { ecosystem: "npm", days: [["default-days", 21]] },
      { ecosystem: "github-actions", days: [] },
    ]);
    // The cooldown as the first key of its entry, and a wait for one kind of update that is too short.
    const first = "updates:\n  - cooldown:\n      default-days: 30\n      semver-patch-days: 3\n    package-ecosystem: npm\n";
    assert.deepEqual(updatesOf(first).map(cooldownOf), [{ ecosystem: "npm", days: [["default-days", 30], ["semver-patch-days", 3]] }]);
    // The same file as Windows may check it out.
    assert.deepEqual(updatesOf(lines(reordered.replace(/\n/g, "\r\n"))).map(cooldownOf), updatesOf(reordered).map(cooldownOf));
    assert.match(lines("minimumReleaseAge: 30240\r\n"), /^minimumReleaseAge:\s*(\d+)\s*(?:#.*)?$/m);
  });
});
