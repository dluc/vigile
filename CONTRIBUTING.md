# Contributing to Vigile

Vigile is early software. Small, evidenced changes are easier to review and
safer to adopt than broad rewrites.

## Set up

Requirements: Node.js 22.13 or newer and pnpm 10.24.

```sh
pnpm install --frozen-lockfile
pnpm test
```

Dependencies wait: pnpm installs a version only once it has been published for
21 days (`minimumReleaseAge` in `pnpm-workspace.yaml`), and Dependabot proposes
version updates under the same cooldown. Adding or upgrading to a newer version
is refused until it is that old; do not exclude a package from the wait.

`pnpm test` builds every package and runs the full suite, including the browser
tests when Chrome or Chromium is available. Tests run compiled files in `dist/`;
run `pnpm build` before a single package test.

## Make a change

1. Open a focused pull request that explains the problem and observable result.
2. Add a regression test that fails without the change.
3. Keep `core` independent of HTTP, MCP, SQLite and configuration.
   `packages/core/src/paging.ts` and `ids.ts` use nothing but the language: the
   service hands them to the web page as they are compiled, so that the page
   reads a list in pages by the service's own rules. A list that is read in
   pages gets its descriptor there, and every reader of lists is held against
   the table in `packages/cli/src/adversary.ts`.
4. Update `README.md` and, when that folder is present, `website/` when behavior people can see changes.
5. Use made-up data in tests, examples and screenshots. Never include keys,
   private hosts or addresses, machine paths, or real planning data.
6. Run `pnpm test` and report the result.

Public behavior belongs in the repository itself. A clean clone must not need a
file from outside the repository.

## Security

Do not disclose vulnerabilities in an issue. Follow [SECURITY.md](SECURITY.md).
