# The web site

The site that presents Vigile: what it is (**Product**), the ideas behind it (**How it works**) and the
reference (**Documentation**). It is a static site, built by a script with no framework and no dependency, and
made to be served by GitHub Pages under the project's path.

## The site and the product

The site does not reference the product's code. It has two doors to the product, and no other:

1. **`vigile describe`**, which prints one JSON document that describes the program: its operations with their
   inputs, its commands, settings, errors, statuses, limits, the guide and what an agent is told over MCP. The
   reference pages are made from it.
2. **The program itself, run as anyone would run it**: `vigile config init`, `vigile serve`, the commands, and
   the HTTP API and the MCP endpoint of a service that the build or a test started. Such a service listens on
   `127.0.0.1` and a free port, has its config and its data in a new temporary folder, and is stopped and
   removed afterwards.

No file under `website/` imports a module of the product, requires one, or reads a file of its source. Were the
product written again in another language, the site would still be built and its tests would still run, as long
as there is a `vigile` program. `independence.test.mjs` holds every file of the site to this.

Where the program is, is one setting, in `lib/program.mjs`: `bin/vigile` of this repository, unless the
variable `VIGILE_BIN` or the option `--vigile <program>` of `build.mjs` names another.

## Build it and look at it

The two commands. The first needs the `vigile` program, which `pnpm build` makes, and no browser.

```sh
node website/build.mjs --out <folder> --base /vigile/
node website/serve.mjs --dir <folder> --base /vigile/ --host <address> --port <port>
```

Without options, `build.mjs` writes `website/dist` for the address in `site.mjs`, and `serve.mjs` serves that
folder at `http://127.0.0.1:4173/vigile/`. So on your own machine: `pnpm build && node website/build.mjs && node website/serve.mjs`.

**`build.mjs`** builds the whole site in some seconds and ends with an error, saying why, when something is
wrong: a page that is not in the navigation, a name the program has and the pages have no words for, an example
the service refuses, a link or an anchor that leads nowhere, a picture that is missing. It asks the program to
describe itself, and starts about twenty services through it, a few at a time, to run the examples and to see
what a service does; each is stopped, and its folder removed, before the build ends. Two builds of the same
pages with the same program write the same files, byte for byte: every date a service gave is shown as a
made-up moment, and every key as `vig_…`.

- `--out <folder>`: where the site goes. It is built in a new folder beside it and put in its place at the
  end, so it is safe to build while the folder is being served: a build that fails leaves the old site.
- `--base <path>`: the path the site is served under: `/` for the root of a host, `/vigile/` for a project,
  `/a/b/` for a deeper one. Every link inside the site is relative, so the built folder works under any path;
  the base path is for the 404 page, which is served at any depth. Anything but a plain path is refused, by
  the build and by the server.
- `--site-url <address>` (or the `SITE_URL` variable): the whole address the site is published at, for the
  sitemap, the canonical addresses and the picture of a shared link. `REPO_URL` is where the code is.
- `--vigile <program>` (or the `VIGILE_BIN` variable): the program the site describes, when it is not
  `bin/vigile` of this repository.

**`serve.mjs`** serves a built folder as GitHub Pages would: `index.html` for a folder, the site's `404.html`
with status 404 for what is not there, a redirect from `/` to the base path under a base path other than `/`.
It binds only the address it is given (`127.0.0.1` unless told otherwise), answers `GET` and `HEAD`, follows
no path out of the folder, and has every answer checked again by the browser, so no page is stale after a
rebuild. It reads each file whole and names it by its bytes: the `ETag` is a hash of what is sent, and "not
modified" is answered only to an `If-None-Match` that names those bytes (quoted, weak, one of a list, or `*`),
never for the 404 page. A file of the same length written in the same moment as the old one is therefore sent
as the new file it is. It sends no `Last-Modified` and does not go by `If-Modified-Since`. It writes one line
when it starts and one when it stops; `--log` adds one for each request. `SIGTERM` or Ctrl-C stops it.

The site has tests of its own, which `pnpm test` does not run:

```sh
pnpm build && node --test website/*.test.mjs
```

They take a minute or two, the files side by side, and go through the same two doors as the build. Six files hold them:

| | |
|---|---|
| `site.test.mjs` | The built site against what the program says of itself: every reference table, links, anchors, pictures, the search's marks, the pages without scripts, the wording of what a failure means. What the pages say the service does, against a real service asked again: versions, pages, fields, linked items, the history of links, refusals. The diagrams, the editorial record, the site's workflow, the README's links to the site |
| `serve.test.mjs` | The two commands as they are typed: what the build takes and refuses, the base paths, and the preview server: what it serves, what it refuses to lead to, and its "you have it already", against files of one length written in one moment |
| `markdown.test.mjs` | The reader of Markdown: what it takes, what it refuses and where, and made-up documents by the thousand, in a thread with a time limit: it always ends and drops no word |
| `commands.test.mjs` | Types every block of commands of the pages into real terminals, and every operation's example into a real service. Sends a real service what each guard refuses, as a browser and as a program. Starts a service into each failure of a start, and looks at the data folder |
| `browser.test.mjs` | The mark on the section that is being read: through a long section, in both directions, at the top and the end, for a section asked for by its address, and when the layout changes without scrolling. The search and the pages with scripts switched off, in a Chromium driven by the site's own small driver, `lib/browser.mjs`: one installed by Playwright, one of the system, or the one `VIGILE_TEST_BROWSER` names. Skipped, saying so, when there is none |
| `independence.test.mjs` | That no file of the site imports from outside the site's folder, requires a module, or names a path into the product's code or a file of TypeScript: the code is read, not the words |

## What is where

| | |
|---|---|
| `content/` | The hand-written pages, in Markdown: `index.html` is the home page, `how/` and `docs/` the two other areas |
| `content/docs/operations/` | For each operation, its example and its notes: what it answers, its rules, its errors |
| `content/words/` | One line of words for each name the program has: every rule, error code, status, problem and limit |
| `content/demo-plan.json` | The made-up plan of the examples and the pictures, a shop that moves to a new platform, as the list of calls that makes it. The build replays them through the API of a service |
| `diagrams/` | The diagrams, drawn by hand as SVG. They are put into the pages and take the pages' colours |
| `assets/` | The styles, the two scripts, the icon, and `pictures/`: the pictures of the page |
| `site.mjs` | The three areas, the order of the pages, the groups of the operations, and where the site is published |
| `build.mjs`, `lib/` | The build: Markdown, the parts made from the description and from running the program, the frame of a page, and the check of the result. `lib/program.mjs` is the way to the program, `lib/browser.mjs` the tests' driver of a browser |
| `editorial/README.md` | The editorial pass: how to read a page as someone deciding whether it is worth their attention, and a row for every public page. Not part of the built site |

## What is made from the description

A page asks for a part with a line such as `{{settings}}`. These parts are made from what `vigile describe`
prints, so they say what the program says:

- the page of every operation (`operations`): its description, its input, who may call it, and an example that
  is **run against a real service** on the demo plan when the site is built;
- the settings (`settings`) and the commands (`commands`, `options`);
- the error codes, the rules, the problems, the statuses and their moves (the table and the diagram), the link
  types, the limits;
- the guide for agents and what an agent is told over MCP.

Where words are needed that the description does not have, they are in `content/words/`. The build fails when
the program has a name without words, or the words name something the program no longer has. So a new operation needs
a file in `content/docs/operations/` and a place in `OPERATION_GROUPS`; a new rule, status or error code needs
its line of words; a new built-in command needs `{{command <name>}}` on the page of the command line. The
tests say which.

## Pictures

The pictures show the real page with a made-up plan, never a real instance. They are files in the repository,
in `assets/pictures/`, each in light and in dark and in two or three widths; `assets/pictures/pictures.json`
lists them, with their sizes, for the build. So are the picture a shared link shows, `assets/og.jpg`, and the
icons.

The pictures are maintained by the project's maintainers, who take them again when the page's look has
changed. A contribution changes the code and the text, and leaves the pictures as they are: say in the pull
request that the look of the page changed, and the pictures follow after review. Building the site needs no
browser.

## Writing a page

A page starts with its title and description between two lines of three hyphens; `nav` is a shorter title for
the navigation and `lead` the sentence under the heading. Add the page to `NAV` in `site.mjs`. Links to other
pages are written from the root of the site, as in `/docs/cli/#exit-codes`; the build makes them relative and
fails on one that leads nowhere. `{{picture <name> | what it shows | caption}}` and
`{{diagram <name> | caption}}` put in a picture or a diagram.

Then read the page as `editorial/README.md` says, and give it its row there: the test fails for a page without one.

### What the service does: facts, not sentences

`lib/facts.mjs` reads from the description which operations take a version and which answer in pages: an
input that has a `version`, or a `continuation`. `lib/contract.mjs` finds out what the service does by asking
one: it starts a service through the program, makes the made-up plan in it, and puts it through each case over
its HTTP API. `readFacts()` gives the answers as `contract`:

| Fact | Is found by |
|---|---|
| `versioned`, `unversioned` | Whether the input of each operation that changes something has a `version`, in the JSON Schema the description gives for it |
| `paged`, `wholeLists` | Whether the input of each list has a `continuation`, from the same place |
| `conflict` | Sending each operation that takes a version a wrong one, and looking at `current` |
| `summaries`, `detailAdds`, `linked` | The fields of the items in lists, in full readings and under `links`, by kind, deleted ones too |
| `linkHistory`, `leftBehind`, `createdWith` | Adding and removing every type of link between every two kinds, and reading both histories and versions |
| `statusRefusals`, `strict`, `accessFirst` | Calls that are refused, and what the refusal carries |
| `taskIds`, `idKeptOnMove` | Creating a task in each of seven ways, and moving two afterwards |
| `versions` | For each operation: how far a change moves the version, and what a call does that asks for what is already so |
| `waiting` | A task of each status, alone, in front of an unfinished dependency, and deleted |
| `outcomes`, `turnedAway` | A call that is refused with each code a call can be refused with from outside, and one with a key that is none: each with whether the plan had changed, which the service's stream of changes says. What an error called `internal` leaves behind is stated in `INTERNAL`, since no store can be made to fail from outside; `commands.test.mjs` sees the case of a key that cannot be stored on a service whose config file cannot be written, and nothing holds the other two |
| `diagrams` | The scenario beside each diagram that shows a plan, built in a service of its own |
| `startup` | Stated in `STARTUP`; `commands.test.mjs` starts a real service into each failure that can be brought about from outside and looks at the data folder. The step that puts an interrupted restore in order is stated only |
| `guards` | Stated in `GUARDS`; `commands.test.mjs` holds each row to a real service |

A page states these with `{{versions}}`, `{{paged}}`, `{{conflict-current}}`, `{{answer-fields task}}`,
`{{detail-adds}}`, `{{linked-fields}}`, `{{link-history}}`, `{{task-ids}}`, `{{error-outcomes}}`, `{{startup}}`,
`{{guards}}` (or `{{guards /mcp}}`),
and in a sentence with `{{=ops.versioned}}`, `{{=ops.unversioned}}`, `{{=ops.paged}}`, `{{=ops.whole}}`,
`{{=link.recorders}}`, `{{=link.silent}}`, `{{=ids.rule}}`, `{{=next.is}}`, `{{=waiting.is}}` and
`{{=waiting.not}}`. The words of a field in `content/words/fields-task.txt` take the same values. Each
operation's page gets its rows "Version", "Pages" and "Answers with" the same way. A sentence about what "every" operation, list or link does is written with one of these, or
has a test in `site.test.mjs` ("what it says the service does") that asks a service again. When the service
changes, the page changes, or the build stops and says which sentence no longer holds.

The answers the pages show are answers a service gave. A service goes by the real clock, so each call the
build makes has a made-up moment: a call of the made-up plan the one `content/demo-plan.json` gives it, a call
after the plan seven minutes more than the one before. A date the service made while it carried a call out is
shown as the moment of that call.

### Diagrams

A diagram is an SVG in `diagrams/`, drawn by hand, with a model beside it: `<name>.json`. The model says what
the diagram shows, names every item in it (`ids`) and every name of the program in it (`terms`), and for a diagram
that shows a plan holds the plan as a `scenario`: its items with their statuses and links. The tests build the
scenario in a real service and hold the drawing to what the service works out: for `next`, the boxes, the arrows and
the label under each box are read out of the SVG. `{{diagram next | from the scenario}}` writes a caption made
from the scenario, so the caption cannot say what the drawing does not show. A diagram that is changed is
changed together with its model.

### Today and direction

The site says what Vigile is for, which reaches further than what is built. So that nobody takes the one for
the other, everything that speaks of a direction stands in a place that is marked, for the reader with a label
and for the test with `data-horizon`:

- `:::today` and `:::direction` are notes with labels of their own ("Today", "Direction: not built, no date").
- `{{horizons Who | What they have` … `}}` takes rows of `Today | … | …`, `Direction | … | …` or `Mixed | … | …`
  and shows each with its label. A mixed row says which part is there today and which is direction.
- `{{bridges` … `}}` takes rows of `what is real today, with a link to where it is shown | what it could carry`.
- On the first page, which is HTML, the two cards carry `data-horizon="today"` and `data-horizon="direction"`,
  and the list of what there is not carries `data-horizon="limits"`.

The tests under "what it says of the future" hold the rest: outside a marked place no page promises anything,
and names what is not built only to say that it is not there; inside one, a direction starts with its label,
says that it is not built, and has no date, no price, no customer and no "will". They are a net of words, not a
proof: a new direction is read by a person before it is written.

### What the Markdown takes

Headings with `#` to `####`, paragraphs, lists with `-` or `1.`, tables with a line of `|---|`, code between
lines of three backticks, notes between `:::note` (or `:::warn`, `:::today`, `:::direction`) and `:::`, and in a line: code
between backticks, `**strong**`, `*stressed*` and `[links](/docs/cli/)`. Everything else is refused, with the
file and the line: a quote with `>`, a rule, a picture as `![…](…)`, a tag of HTML, a link that is not a page of
the site, an anchor or `https://…`, a note of another name. Nothing unknown is shown as text in the hope that it
was meant as text. A sign that is meant as text is written as code or with a backslash before it.

### Commands

A block of shell commands says, after its three backticks, which terminal it is typed in, or why the test does
not type it:

````
```sh terminal=first
vigile config init --name main
```

```sh terminal=first stays=running
vigile serve
```

```sh skip=network
git clone …
```
````

`terminal=` names the terminal as the page does (first, second; `your` on a reference page, where there is one
and it has no name). `stays=running` is for a block whose last command keeps running. `skip=` takes `network`,
`other-program`, `placeholder` or `second-service`. The page says in its first lines what its terminals start
with: `terminals: fresh` (nothing but the command at `~/code/vigile/bin/vigile`), `running` (an instance runs, and `vigile`
and `VIGILE_CONFIG` are set as Install and first run sets them) or `running-demo` (the same, with the made-up
plan). A page other than a fresh one says so to the reader as well, with a link to
`/docs/install/#in-every-terminal`.

The test types each block in a shell of its own for each terminal, in a throwaway home folder, and fails on a
command that fails, or that cannot be typed because the terminal is kept by a service. In that home folder
`~/code/vigile/bin/vigile` is a file of one line that runs the program the site describes. A new terminal has
nothing: no `PATH` entry, no `VIGILE_CONFIG`. Where a page names the port 8700, 8701 or 8710, the test types a
free port in its place; nothing else is changed.

Nothing private goes on the site: no machine names, addresses, paths or keys, and nothing from a real plan.

## Going public

The site is not published yet. The workflow `.github/workflows/pages.yml`, "Web site", is the site's own. It
runs the site's tests on every pull request and on every push to `main`, with the Chrome the runner comes
with. It builds the site and publishes it with the official Pages actions only when it is started by hand,
and then only after the tests passed in the same run.
Each job asks for what it needs and no more: the tests read the code, the build also asks Pages for the
address, and only publishing may write the pages. What is left to do:

The workflow names every action by its full commit, with its version in a comment beside it or on the line above, so that the repository can require actions to be pinned: a tag can be moved to other code, a commit cannot. To take a newer version of an action, look up the commit its tag points at and change the commit and the comment together, in every job that names it. `site.test.mjs` reads the workflow as YAML with `lib/yaml.mjs`, a reader of the small part of YAML the workflow uses, so a file that is not YAML, such as one with the marks of an unfinished merge, fails with its line; and it refuses a workflow that names an action by a tag, a branch or a short commit, or names one twice in a job.

1. In the repository's settings, under **Pages**, set **Source** to **GitHub Actions**. That is the one switch.
2. Start the workflow "Web site" by hand (Actions, "Web site", "Run workflow") and look at the result. The
   address comes from Pages itself, so nothing has to be changed for it.
3. To publish on every change, let the jobs `build` and `publish` run for a push to `main` as well: in the
   workflow, each of the two says `if: github.event_name == 'workflow_dispatch'`.
4. If the site moves to another address, such as a domain of its own, change `SITE_URL` in `site.mjs`, which
   the README's links and a build without options go by.
