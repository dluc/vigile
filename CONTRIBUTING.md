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

## The web site

The site in `website/` is made from hand-written pages, from what the program
says of itself (`vigile describe`) and from running the program. It does not
reference the product's code: nothing under `website/` imports a package or
reads a source file, and a test of the site fails when a file does.
[`website/README.md`](website/README.md) says how to build it, how a page is
written, and what its tests hold.

```sh
pnpm build && node website/build.mjs
pnpm build && node --test website/*.test.mjs
```

`pnpm test` does not run the tests of the site. The workflow "Web site" runs
them on every pull request.

- What a reference page needs to know of the program comes from
  `vigile describe`. When a page needs something the description does not
  have, add it to the description, in the product, and not a reading of the
  code to the site.
- A sentence about what the service does is made from a fact that the build finds
  out by asking a real service, or is held to one by a test. Do not write one
  from memory.
- What is not built is named as a limit, or stands in a place that is marked as
  direction.
- Every page has a row in `website/editorial/README.md`.
- The pictures, in `images/` and in `website/assets/pictures/`, are kept by the
  project's maintainers. Leave the picture files as they are, and say in the pull
  request when the look of the page changed.

## Security

Do not disclose vulnerabilities in an issue. Follow [SECURITY.md](SECURITY.md).
