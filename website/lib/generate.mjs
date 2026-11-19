// The parts of the pages that are made from what the program says of itself and from what a service does:
// tables of settings, commands, operations, error codes, statuses and link types, the diagram of the status
// moves, and the page of each operation. A hand-written page asks for one with a line such as {{settings}}.
// Where words are needed that the program does not have, the page gives them, one line for each name, and the
// build fails when a name the program has is left without words or the page has words for a name the program
// does not have.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATION_GROUPS } from "../site.mjs";
import { answerOf, listed } from "./contract.mjs";
import { runExample } from "./examples.mjs";
import { MarkdownError, escapeHtml, frontMatter, inline, markdown, slug } from "./markdown.mjs";

export const heading = (level, id, html) => `<h${level} id="${id}"><a class="anchor" href="#${id}">${html}</a></h${level}>`;

const code = (text) => `<code>${escapeHtml(text)}</code>`;

export const pre = (text, language, extra = "") => `<pre${language ? ` data-language="${language}"` : ""}${extra}><code>${escapeHtml(text)}</code></pre>`;

function table(label, headers, rows, className = "") {
  const head = headers.map((header) => `<th scope="col">${header}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((cell, index) => (index === 0 ? `<th scope="row">${cell}</th>` : `<td>${cell}</td>`)).join("")}</tr>`).join("");
  return `<div class="table-scroll${className ? ` ${className}` : ""}" tabindex="0" role="group" aria-label="${escapeHtml(label)}"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const wordsRoot = fileURLToPath(new URL("../content/words", import.meta.url));

/**
 * The words for each of the names the program has: `name: words`, one to a line, in content/words/<what>.txt, or
 * given by the page itself between the two pairs of braces.
 */
function described(what, names, given, values = {}) {
  const file = join(wordsRoot, `${what}.txt`);
  if (given === null && !existsSync(file)) throw new Error(`{{${what}}} needs words: write website/content/words/${what}.txt, with a line "name: words" for each of ${names.join(", ")}.`);
  const body = given ?? readFileSync(file, "utf8");
  const words = new Map();
  body.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    const colon = line.indexOf(":");
    const name = line.slice(0, colon).trim();
    if (colon < 1 || !names.includes(name)) throw new Error(`The words of {{${what}}} have a line for "${line.slice(0, 40)}", which is none of: ${names.join(", ")}.`);
    words.set(
      name,
      // Where the words have to say what the service does, they take it from what it was seen to do: {{=name}} is a value of website/lib/generate.mjs.
      inline(
        line
          .slice(colon + 1)
          .trim()
          .replace(/\{\{=([a-z.]+)\}\}/g, (_, value) => {
            if (!Object.hasOwn(values, value)) throw new Error(`The words of {{${what}}} for "${name}" ask for {{=${value}}}, and there is no such value.`);
            return values[value];
          }),
        (message) => {
        throw new MarkdownError(given === null ? `content/words/${what}.txt` : `the words of {{${what}}}`, index + 1, message);
      },
      ),
    );
  });
  const missing = names.filter((name) => !words.has(name));
  if (missing.length) throw new Error(`{{${what}}} has no words for: ${missing.join(", ")}. The program has them: say what each is, in website/content/words/${what}.txt.`);
  return words;
}

const sentence = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;
const firstSentence = (text) => text.split(/(?<=[.:])\s/)[0].replace(/[.:]$/, "");
const commandId = (name) => slug(name);
const operationPath = (operation) => `/docs/operations/${operation.command}/`;

/** JSON as a person would lay it out: lists of plain values and small objects on one line. */
export function pretty(value, indent = "") {
  const plain = (item) => item === null || typeof item !== "object";
  if (plain(value)) return JSON.stringify(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    if (value.every(plain)) {
      const line = `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
      if (line.length + indent.length <= 100) return line;
    }
    return `[\n${value.map((item) => `${inner}${pretty(item, inner)}`).join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(value);
  if (!entries.length) return "{}";
  if (entries.every(([, item]) => plain(item)) && entries.length <= 4) {
    const line = `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${JSON.stringify(item)}`).join(", ")} }`;
    if (line.length + indent.length <= 90) return line;
  }
  return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${pretty(item, inner)}`).join(",\n")}\n${indent}}`;
}

/** Cuts an answer down to what fits a page, and says what was cut. */
function shortened(value, cuts = [], name = "") {
  if (typeof value === "string" && value.length > 300) {
    cuts.push(`the text of ${name} is cut short`);
    return `${value.slice(0, 260).trimEnd()}…`;
  }
  if (Array.isArray(value)) {
    const kept = value.length > 3 && value.some((item) => item && typeof item === "object") ? value.slice(0, 2) : value;
    if (kept.length < value.length) cuts.push(`${name} shows 2 of ${value.length}`);
    return kept.map((item) => shortened(item, cuts, name));
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shortened(item, cuts, key)]));
  return value;
}

/** A value as it is typed after an option of the command line. */
function typed(value) {
  if (Array.isArray(value)) return typed(value.join(","));
  const text = String(value);
  return /^[A-Za-z0-9_.,:\/@+-]+$/.test(text) ? text : `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** One call, as it is made over each interface. */
function asCalled(operation, input, as) {
  const options = Object.entries(input).map(([name, value]) => (value === true ? `--${name.replaceAll("_", "-")}` : `--${name.replaceAll("_", "-")} ${typed(value)}`));
  const command = ["vigile", operation.command, ...options, ...(as === "admin" ? [] : [`--as ${as}`])];
  let line = command.join(" ");
  if (line.length > 88) line = command.reduce((text, part, index) => (index < 2 ? `${text}${index ? " " : ""}${part}` : `${text} \\\n  ${part}`), "");
  const body = JSON.stringify(input);
  // Without a key a call acts as the keyless user. A call as anyone else carries that user's key.
  const key = as === "agent1" ? "" : ` \\\n  -H 'Authorization: Bearer vig_...'`;
  const curl = `curl -s http://127.0.0.1:8700/api/${operation.command} \\\n  -H 'content-type: application/json'${key} \\\n  -d '${body.replaceAll("'", "'\\''")}'`;
  const mcp = pretty({ name: operation.name, arguments: input });
  return { cli: line, curl, mcp };
}

/** The three words a row or a block is marked with: usable today, a direction that is not built, or some of each. */
const HORIZON_LABELS = { today: "Today", direction: "Direction", mixed: "Mixed" };

/** The ways a task is created that website/lib/contract.mjs tries, in the words of the table of IDs, and what its ID is made of. */
const TASK_ID_GIVEN = {
  project: "In a project that has a prefix",
  "project-and-parent": "In a project that has a prefix, under a parent whose ID has another prefix",
  parent: "Under a parent whose ID has a prefix, with no project given",
  "numbered-project-and-parent": "In a project whose ID is a number, under a parent whose ID has a prefix",
  "numbered-project": "In a project whose ID is a number",
  "numbered-parent": "Under a parent whose ID is a number alone",
  nothing: "In no project and under no parent",
};
const TASK_ID_FROM = { project: "The project's prefix and a number", parent: "The prefix of the parent's ID and a number", none: "A number alone" };

/**
 * The rule the table of IDs comes to, in a sentence, for the pages that say it in passing. It is said only when
 * every case the service was put through agrees with it.
 */
function taskIdRule(contract) {
  const expected = { project: "project", "project-and-parent": "project", parent: "parent", "numbered-project-and-parent": "parent", "numbered-project": "none", "numbered-parent": "none", nothing: "none" };
  for (const one of contract.taskIds) {
    if (expected[one.given] !== one.from) throw new Error(`A task created "${one.given}" gets its ID from "${one.from}", and the sentence about IDs in website/lib/generate.mjs says "${expected[one.given]}". Say the rule as it is now.`);
  }
  return "The prefix of the project it is created in, when that project has one; otherwise the prefix of its parent's ID, when that has one; otherwise none. Then a number";
}

/**
 * What the cases of errors come to: the codes after which nothing was changed, as a service was seen to leave
 * the plan, the message that is given both when a change was stored and when it was not, and the messages that
 * say what stands. The last two are stated in website/lib/contract.mjs, not seen.
 */
function outcomesOf(contract, codes) {
  const byCode = new Map();
  for (const one of contract.outcomes) byCode.set(one.code, [...(byCode.get(one.code) ?? []), one]);
  const unchanged = codes.filter((code) => byCode.has(code) && byCode.get(code).every((one) => !one.stored));
  const internal = byCode.get("internal") ?? [];
  const messages = [...new Set(internal.map((one) => one.message))];
  const both = messages.filter((message) => internal.some((one) => one.message === message && one.stored) && internal.some((one) => one.message === message && !one.stored));
  const stands = messages.filter((message) => internal.every((one) => one.message !== message || one.stored));
  if (both.length !== 1 || !stands.length || unchanged.includes("internal")) throw new Error(`What an error called internal leaves behind is no longer what the pages say: ${JSON.stringify(internal)}. Say it as it is now, in outcomesOf of website/lib/generate.mjs.`);
  return { unchanged, unknown: both[0], stands };
}

/** What is worked out of a task's status and dependencies, in sentences made from the cases the service was put through. */
function workedOut(contract) {
  const inCode = (statuses, last) => listed(statuses.map((status) => `\`${status}\``), last);
  const next = contract.waiting.filter((one) => one.next).map((one) => one.status);
  const held = contract.waiting.filter((one) => one.waiting).map((one) => one.status);
  const free = contract.waiting.filter((one) => !one.waiting).map((one) => one.status);
  const flagged = contract.waiting.filter((one) => !one.waiting && one.problem.length).map((one) => one.status);
  if (contract.waiting.some((one) => one.deleted.waiting || one.deleted.next || one.nextWhenHeld || one.waiting !== one.waitingFor)) throw new Error("What a deleted or a held-back task says of next and waiting is not what website/lib/generate.mjs says of it. Say it as it is now, in workedOut.");
  const paths = contract.containerWaiting;
  if (paths.inactive.next || !paths.inactive.waiting || !paths.inactive.waitingFor.includes(paths.inactiveGroup) || !paths.alternate.next || paths.alternate.waiting || paths.alternate.waitingFor.length) {
    throw new Error("What a task inside inactive containers says of next and waiting is not what website/lib/generate.mjs says of it. Say it as it is now, in workedOut.");
  }
  return {
    "next.is": `The task is ${inCode(next, "or")}, is not deleted, has an active path through its projects and groups, and has no unfinished dependency`,
    "waiting.is": `The task is not deleted, is ${inCode(held, "or")}, and either depends on something unfinished or every path through its projects and groups is inactive`,
    "waiting.not": `A task that is ${inCode(free, "or")}, or deleted, is not waiting, whatever it depends on${flagged.length ? `; one that is ${inCode(flagged, "or")} with an unfinished dependency carries a problem instead` : ""}`,
    "waiting.statuses": inCode(held, "or"),
    "waiting.never": inCode(free, "or"),
  };
}

const NUMBERS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

const ACCESS = (operation) => (operation.access === "all" ? "Every user" : `${operation.access.map((type) => `${type}s`).join(" and ")} only`.replace(/^./, (first) => first.toUpperCase()));

export function generators(codeData, site) {
  const { operations, contract } = codeData;
  const byName = new Map(operations.map((operation) => [operation.name, operation]));
  const groups = byName.has("create_decision") ? [...OPERATION_GROUPS, { title: "Decisions", operations: ["create_decision", "update_decision", "list_decisions"] }] : OPERATION_GROUPS;
  const grouped = new Set(groups.flatMap((group) => group.operations));
  for (const operation of operations) if (!grouped.has(operation.name)) throw new Error(`The operation ${operation.name} is in no group of OPERATION_GROUPS in website/site.mjs. Add it to one.`);
  for (const name of grouped) if (!byName.has(name)) throw new Error(`website/site.mjs groups an operation called ${name}, and there is none.`);
  const used = { commands: new Set() };

  const block = {
    settings() {
      const rows = codeData.settings.map((setting) => {
        const range = setting.minimum === undefined ? "" : `, ${setting.minimum} to ${setting.maximum}`;
        const takes = setting.values
          ? setting.values.map(code).join(", ")
          : setting.type === "boolean"
            ? `${code("true")} or ${code("false")}`
            : setting.type === "decimal"
              ? `a number${range}`
              : setting.type === "number"
                ? `a whole number${range}`
                : setting.max_length
                  ? `text, at most ${setting.max_length} characters`
                  : "text";
        return [`<span id="setting-${slug(setting.key)}">${code(setting.key)}</span>`, code(JSON.stringify(setting.default)), takes, code(setting.environment), code(`--${setting.key}`), escapeHtml(sentence(setting.description))];
      });
      return table("The settings", ["Setting", "Default", "Takes", "Environment variable", "Option of <code>serve</code>", "What it is"], rows, "wide");
    },

    /** A config file as `config init` writes it: every setting at its default, and the admin's key. */
    "config-example"() {
      const lines = [];
      const sections = new Map();
      for (const setting of codeData.settings) {
        const [section, name] = setting.key.includes(".") ? setting.key.split(".") : [null, setting.key];
        const line = `${name} = ${JSON.stringify(setting.key === "name" ? "main" : setting.default)}`;
        if (section === null) lines.push(line);
        else sections.set(section, [...(sections.get(section) ?? []), line]);
      }
      for (const [section, own] of sections) lines.push("", `[${section}]`, ...own);
      lines.push("", "[auth.keys]", 'admin = "vig_..."');
      return pre(lines.join("\n"), "toml");
    },

    command(args) {
      const builtin = codeData.builtins.find((one) => one.name === args.trim());
      if (!builtin) throw new Error(`{{command ${args}}}: there is no built-in command of that name. There are: ${codeData.builtins.map((one) => one.name).join(", ")}.`);
      used.commands.add(builtin.name);
      const options = builtin.options.length
        ? table(
            `Options of vigile ${builtin.name}`,
            ["Option", "What it is"],
            builtin.options.map((option) => [code(option.typed), `${escapeHtml(sentence(option.description))}${option.also ? ` Also taken as ${code(`--${option.also}`)}.` : ""}`]),
          )
        : "";
      return [heading(3, commandId(builtin.name), code(`vigile ${builtin.name}`)), pre(builtin.usage, "usage", ' class="wrap"'), `<p>${escapeHtml(sentence(builtin.description))}${(builtin.notes ?? []).map((line) => ` ${escapeHtml(sentence(line))}`).join("")}</p>`, options].join("\n");
    },

    "commands-check"() {
      const missing = codeData.builtins.filter((one) => !used.commands.has(one.name));
      if (missing.length) throw new Error(`The page of the command line does not describe: ${missing.map((one) => one.name).join(", ")}. Add {{command <name>}} for each.`);
      return "";
    },

    "everywhere-options"() {
      return table("The options every command takes", ["Option", "What it is"], codeData.everywhere.map((option) => [code(option.typed), escapeHtml(sentence(option.description))]));
    },

    "operation-commands"() {
      const rows = operations.map((operation) => [`<a href="${operationPath(operation)}">${code(`vigile ${operation.command}`)}</a>`, operation.options.map((option) => code(`--${option.name}${option.value ? ` <${option.value}>` : ""}`) + (option.required ? " <span class=\"must\">required</span>" : "")).join("<br>") || "<span class=\"quiet\">none</span>"]);
      return table("The commands of the operations and their options", ["Command", "Options"], rows);
    },

    "operations-index"() {
      return groups.map((group) => {
        const rows = group.operations.map((name) => {
          const operation = byName.get(name);
          return [`<a href="${operationPath(operation)}">${code(operation.name)}</a>`, operation.kind === "read" ? "reads" : "changes", escapeHtml(ACCESS(operation).toLowerCase()), escapeHtml(sentence(firstSentence(operation.description)))];
        });
        return `${heading(2, slug(group.title), escapeHtml(group.title))}\n${table(`Operations: ${group.title}`, ["Operation", "It", "Who may call", "What it does"], rows)}`;
      }).join("\n");
    },

    "error-codes"(_args, body) {
      const words = described("error-codes", codeData.errorCodes.map((one) => one.code), body);
      return table("The error codes", ["Code", "HTTP status", "When"], codeData.errorCodes.map((one) => [`<span id="code-${slug(one.code)}">${code(one.code)}</span>`, String(one.status), words.get(one.code)]));
    },

    rules(_args, body) {
      const words = described("rules", codeData.rules, body);
      return table("The rules a change can be refused by", ["Rule", "The change is refused when"], codeData.rules.map((rule) => [`<span id="rule-${slug(rule)}">${code(rule)}</span>`, words.get(rule)]));
    },

    problems(_args, body) {
      const words = described("problems", codeData.problems, body);
      return table("The problems a plan can have", ["Problem", "What is wrong"], codeData.problems.map((problem) => [`<span id="problem-${slug(problem)}">${code(problem)}</span>`, words.get(problem)]));
    },

    "task-statuses"(_args, body) {
      const words = described("task-statuses", [...codeData.taskStatuses], body);
      return table(
        "The statuses of a task",
        ["Status", "Means", "Can move to"],
        codeData.taskStatuses.map((status) => [`<span class="lamp st-${status}" id="status-${slug(status)}">${code(status)}</span>`, `${words.get(status)}${codeData.taskFinished.includes(status) ? " <span class=\"quiet\">Finished: it no longer holds back what depends on it.</span>" : ""}`, codeData.taskMoves[status].map(code).join(", ")]),
      );
    },

    "project-statuses"(_args, body) {
      const words = described("project-statuses", [...codeData.projectStatuses], body);
      return table("The statuses of a project", ["Status", "Means"], codeData.projectStatuses.map((status) => [code(status), `${words.get(status)}${codeData.projectFinished.includes(status) ? " <span class=\"quiet\">Finished: tasks that depend on the project stop waiting.</span>" : ""}`]));
    },

    "task-types"(_args, body) {
      const words = described("task-types", [...codeData.taskTypes], body);
      return table("The types of a task", ["Type", "Is"], codeData.taskTypes.map((type) => [code(type), words.get(type)]));
    },

    "user-types"(_args, body) {
      const words = described("user-types", [...codeData.userTypes], body);
      return table("The types of a user", ["Type", "Is", "May call"], codeData.userTypes.map((type) => [code(type), words.get(type), `${operations.filter((operation) => operation.access === "all" || operation.access.includes(type)).length} of ${operations.length} operations`]));
    },

    "built-in-users"(_args, body) {
      const words = described("built-in-users", codeData.builtInUsers.map((user) => user.username), body);
      return table("The users every instance starts with", ["User", "Type", "For"], codeData.builtInUsers.map((user) => [code(user.username), user.type, words.get(user.username)]));
    },

    moves() {
      const statuses = codeData.taskStatuses;
      const head = ["From \\ to", ...statuses.map(code)];
      const rows = statuses.map((from) => [code(from), ...statuses.map((to) => (from === to ? '<span class="quiet" aria-label="the same status">·</span>' : codeData.taskMoves[from].includes(to) ? '<span class="yes">yes</span>' : '<span class="no">no</span>'))]);
      return table("Which status a task can move to from each status", head, rows, "matrix");
    },

    "statuses-diagram"() {
      return statusesDiagram(codeData);
    },

    "link-types"() {
      return table(
        "The link types",
        ["Type", "Reverse name", "From", "To", "What it does"],
        codeData.linkTypes.map((type) => [code(type.type), code(type.reverse), type.from.join(" or "), type.to.join(" or "), escapeHtml(type.description)]),
      );
    },

    limits(_args, body) {
      const words = described("limits", Object.keys(codeData.limits), body);
      return table("The limits", ["Limit", "Is", "On"], Object.entries(codeData.limits).map(([name, value]) => [code(name), String(value), words.get(name)]));
    },

    "reserved-prefixes"() {
      return `<p>These words cannot be a project's prefix, because they start the IDs of other kinds of item: ${codeData.reservedPrefixes.map(code).join(", ")}.</p>`;
    },

    guide(args) {
      const topic = codeData.guideTopics.find((one) => one.topic === args.trim());
      if (!topic) throw new Error(`{{guide ${args}}}: the guide has no such topic. It has: ${codeData.guideTopics.map((one) => one.topic).join(", ")}.`);
      if (topic.topic === "examples") return guideExamples(codeData);
      const text = topic.text.replace(/^## (.*)$/gm, (_, title) => `### ${title} {#guide-${topic.topic}-${slug(title)}}`);
      return `<div class="from-code">${markdown(text, { file: `the guide's topic "${topic.topic}", as "vigile describe" prints it` }).html}</div>`;
    },

    "guide-topics"() {
      return table("The topics of the guide", ["Topic", "Title", "Holds"], codeData.guideTopics.map((one) => [`<a href="#${one.topic}">${code(one.topic)}</a>`, escapeHtml(one.title), escapeHtml(one.topics.find((topic) => topic.topic === one.topic).summary)]));
    },

    "mcp-instructions"() {
      return `<details class="fold"><summary>The instructions, word for word</summary>${pre(codeData.mcpInstructions, "text")}</details>`;
    },

    "mcp-prompts"() {
      return table("The prompts", ["Prompt", "Title", "Takes", "Does"], codeData.mcpPrompts.map((prompt) => [code(prompt.name), escapeHtml(prompt.title), `${code(prompt.argument.name)}: ${escapeHtml(prompt.argument.description)}`, escapeHtml(prompt.description)]));
    },

    "mcp-resources"() {
      return table("The resources", ["Address", "Holds"], codeData.guideTopics.map((one) => [code(`vigile://guide/${one.topic}`), escapeHtml(one.title)]));
    },

    // ---- What the service does, from website/lib/contract.mjs: the pages say these, and no other, facts about it.

    /** What a conflict hands back: the item in short. Stops the build when that is no longer so, since the pages say it. */
    "conflict-current"() {
      const { conflict, summaries, detailAdds } = contract;
      for (const [name, seen] of Object.entries(conflict)) {
        if (seen.category !== "summary") throw new Error(`A conflict of ${name} no longer hands back the item in short, which {{conflict-current}} says it does: it has ${seen.fields.join(", ")}. Say what it hands back now, in website/lib/generate.mjs.`);
      }
      const rows = Object.entries(summaries).map(([kind, fields]) => [`a ${kind}`, fields.always.map(code).join(", "), fields.sometimes.length ? fields.sometimes.map(code).join(", ") : "nothing more"]);
      const missing = [...new Set(Object.values(detailAdds).flat())];
      return `<p>Under <code>current</code> is the item as it is now, <strong>in short</strong>: what a list says of it, which is less than <a href="/docs/operations/get/"><code>get</code></a> says.</p>${table("What a conflict hands back under current", ["The item is", "<code>current</code> has", "And when there is something to say"], rows)}<p>It does not have ${listed(missing.map(code), "or")}, nor the history. Call <a href="/docs/operations/get/"><code>get</code></a> for those.</p>`;
    },

    /** The fields of an item in short, each with the page's words for it and whether it is sent every time. */
    "answer-fields"(args, body) {
      const kind = args.trim();
      if (!Object.hasOwn(contract.summaries, kind)) throw new Error(`{{answer-fields ${kind}}}: there are the fields of a ${Object.keys(contract.summaries).join(", a ")}.`);
      const { always, sometimes } = contract.summaries[kind];
      const words = described(`fields-${kind}`, [...always, ...sometimes], body, inlineValues);
      return table(`What an answer about a ${kind} carries`, ["Field", "Sent", "Is"], [...always, ...sometimes].map((field) => [code(field), always.includes(field) ? "always" : '<span class="quiet">sometimes</span>', words.get(field)]));
    },

    /** What a full reading adds to the short form, by kind. */
    "detail-adds"() {
      const { detailAdds, withHistory } = contract;
      const rows = Object.entries(detailAdds).map(([kind, fields]) => [`a ${kind}`, fields.map(code).join(", ")]);
      return `${table("What a full reading adds to the short form", ["The item is", "<code>get</code> adds"], rows)}<p>With <code>history: true</code> it also has ${listed(withHistory.map(code))}, for an item of any of the ${NUMBERS[rows.length].toLowerCase()} kinds.</p>`;
    },

    /** What a full reading says of each item that is linked, by the kind of that item. */
    "linked-fields"() {
      const rows = Object.entries(contract.linked).map(([kind, fields]) => [`a ${kind}`, fields.always.map(code).join(", "), fields.sometimes.length ? fields.sometimes.map((field) => `${code(field)}: true`).join(", ") : "nothing more"]);
      const without = Object.entries(contract.linked).filter(([, fields]) => !fields.always.includes("status")).map(([kind]) => kind);
      const withStatus = Object.entries(contract.linked).filter(([, fields]) => fields.always.includes("status")).map(([kind]) => kind);
      return `${table("What a full reading says of a linked item", ["The linked item is", "It comes with", "And when it is deleted"], rows)}<p>A linked ${listed(withStatus, "or")} comes with its <code>status</code>. A linked ${listed(without, "or")} has none${without.includes("user") ? ": its <code>title</code> is the username" : ""}.</p>`;
    },

    /**
     * What an error of the service leaves behind. A code is said to leave nothing only when every case of it
     * that a service was put through left nothing; what is said of `internal` is stated in website/lib/contract.mjs.
     */
    "error-outcomes"() {
      const seen = outcomesOf(contract, codeData.errorCodes.map((one) => one.code));
      if (contract.turnedAway.code !== "unauthorized" || contract.turnedAway.stored) throw new Error(`A call with a key that is none is no longer turned away as unauthorized with nothing changed, which {{error-outcomes}} says it is: ${JSON.stringify(contract.turnedAway)}. Say it as it is now, in website/lib/generate.mjs.`);
      const rows = [
        [`${seen.unchanged.map(code).join(", ")}`, "Nothing. The call was refused before anything was stored."],
        [`${code("unauthorized")}`, "Nothing. The call was turned away before it reached an operation."],
        ...seen.stands.map((message) => [`${code("internal")}, with a message that says what stands, as in "${escapeHtml(message)}"`, "Part of it: what the message says stands, and it says what to do about the rest."]),
        [`${code("internal")}, "${escapeHtml(seen.unknown)}"`, 'Not known. The same answer is given when the change was stored and when it was not. Look at the item, with <a href="/docs/operations/get/"><code>get</code></a> and its history, before sending the change again.'],
      ];
      return table("What an error of the service leaves behind", ["The error", "What was changed"], rows);
    },

    /** What the service does when it starts, and what has happened to the data folder by the time each step can fail. */
    startup() {
      return table(
        "The steps of a start, and what has happened when one fails",
        ["Step", "It", "Fails with cannot_start when", "By then"],
        contract.startup.map((step, index) => [String(index + 1), escapeHtml(sentence(step.does)), escapeHtml(sentence(step.fails)), escapeHtml(sentence(step.by))]),
        "wide",
      );
    },

    /** How a task gets its ID: each way of creating one, as the service was seen to do it, and that a move does not change it. */
    "task-ids"() {
      const rows = contract.taskIds.map((one) => {
        if (!Object.hasOwn(TASK_ID_GIVEN, one.given)) throw new Error(`A task is created "${one.given}" in website/lib/contract.mjs, and {{task-ids}} has no words for that. Say it in TASK_ID_GIVEN.`);
        return [TASK_ID_GIVEN[one.given], TASK_ID_FROM[one.from]];
      });
      if (!contract.idKeptOnMove) throw new Error("A task no longer keeps its ID when it is moved into another project, which {{task-ids}} says it does. Say what happens now, in website/lib/generate.mjs.");
      return `${table("How a task gets its ID", ["A task created", "Gets as its ID"], rows)}<p>The ID is given once, when the task is created. Putting the task into another project or group afterwards, or taking it out of the one it was created in, does not change it.</p>`;
    },

    /** Which operations answer in pages, and which lists answer with everything. */
    paged() {
      const { paged, wholeLists } = contract;
      const link = (name) => `<a href="${operationPath(byName.get(name))}">${code(name)}</a>`;
      const lists = paged.filter((name) => name !== "get");
      const get = paged.includes("get");
      return `<p>${NUMBERS[lists.length] ?? lists.length} list operation${lists.length === 1 ? " answers" : "s answer"} in pages of at most ${codeData.limits.page}: ${listed(lists.map(link))}. When there is more, the answer carries a top-level <code>continuation</code> token: send it back unchanged, with the same operation and filters, for the next page. ${wholeLists.length ? `${listed(wholeLists.map(link))} answer with the whole list at once, and take no token.` : ""}</p>${get ? `<p>${link("get")} can page each cut list of one item separately. <code>more.links[&lt;type&gt;]</code>, <code>more.timeline</code> or <code>more.history</code> carries that list's total and continuation token. Send the token back to <code>get</code> with the same item ID. Link pages continue forward by ID; timeline and history pages continue to older entries. Combine item pages only while their <code>unchanged_since</code> values match. If one differs, read the item again from the first page.</p>` : ""}`;
    },

    /** Every operation that changes something, with whether it takes a version, and the page's words for those that take none. */
    versions(_args, body) {
      const { versioned, unversioned } = contract;
      const words = described("without-version", unversioned.filter(name => name !== "create_decision"), body);
      if (unversioned.includes("create_decision")) words.set("create_decision", "Sent twice, it makes two decisions.");
      const link = (name) => `<a href="${operationPath(byName.get(name))}">${code(name)}</a>`;
      const rows = [...versioned.map((name) => [link(name), '<span class="yes">yes</span>', "Refused with <code>version_conflict</code> when the item has changed since the version that is sent."]), ...unversioned.map((name) => [link(name), '<span class="no">no</span>', words.get(name)])];
      return table("Which operations take a version", ["Operation", "Takes a version", "So"], rows);
    },

    /** Which end of each kind of link gets a change of the link into its history, and whose version moves. */
    "link-history"() {
      const { linkHistory, leftBehind, createdWith } = contract;
      const ends = (row, what) => {
        const named = ["from", "to"].filter((end) => row[what][end]).map((end) => `the ${row[end]}${row.from === row.to ? (end === "from" ? (row.type === "contains" ? " that contains" : " that depends") : row.type === "contains" ? " that is contained" : " that is depended on") : ""}`);
        return named.length ? listed(named) : "neither";
      };
      const rows = linkHistory.map((row) => [code(row.type), row.from, row.to, ends(row, "history"), ends(row, "version")]);
      const silent = Object.entries(leftBehind).filter(([, hears]) => !hears).map(([kind]) => kind);
      const hearing = Object.entries(leftBehind).filter(([, hears]) => hears).map(([kind]) => kind);
      for (const kind of Object.keys(leftBehind)) if (leftBehind[kind] !== createdWith[kind]) throw new Error(`Whether a ${kind} hears of a link in its history is not the same for a task created with the link as for an item deleted for good: {{link-history}} says one thing of both. Say each, in website/lib/generate.mjs.`);
      return `${table("Which end of a link records it, and whose version moves", ["Link", "From a", "To a", "Recorded in the history of", "The version goes up of"], rows)}<p>The same holds when a task is created with its links, and when an item is deleted for good and its links go with it: a ${listed(hearing, "or")} at the other end records it in its history${silent.length ? `, a ${listed(silent, "or")} does not` : ""}.</p>`;
    },

    /** The guards before the API and the MCP endpoint, and whom each concerns. */
    guards(args) {
      // With an endpoint after it, as in {{guards /mcp}}: the guards that stand before that one.
      const on = args.trim();
      const guards = on ? contract.guards.filter((guard) => guard.on.includes(on)) : contract.guards;
      if (!guards.length) throw new Error(`{{guards ${on}}}: no guard stands before ${on}. The guards stand before ${[...new Set(contract.guards.flatMap((guard) => guard.on))].join(" and ")}.`);
      const where = on ? [] : ["Before"];
      return table(`The guards before ${on || "the API and the MCP endpoint"}`, ["Guard", ...where, "Refuses", "Concerns", "Answers"], guards.map((guard) => [escapeHtml(guard.name), ...(on ? [] : [guard.on.map(code).join(", ")]), escapeHtml(sentence(guard.refuses)), escapeHtml(sentence(guard.concerns)), code(guard.code)]), "wide");
    },

    // ---- What can be used today and what is a direction: every row says which, in a label and for the test.

    /**
     * Rows that each say whether they are true today, a direction that is not built, or both. The page gives the
     * two headings, and a row as "Today | … | …", "Direction | … | …" or "Mixed | … | …".
     */
    horizons(args, body) {
      const heads = args.split("|").map((head) => head.trim());
      if (heads.length !== 2 || heads.some((head) => !head)) throw new Error("{{horizons}} takes two headings, as in {{horizons Who | What they have");
      const rows = (body ?? "").split("\n").filter((row) => row.trim()).map((row) => {
        const cells = row.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
        const horizon = cells[0]?.toLowerCase();
        if (cells.length !== 3 || !Object.hasOwn(HORIZON_LABELS, horizon)) throw new Error(`{{horizons}}: a row is "Today | … | …", "Direction | … | …" or "Mixed | … | …", and this one is not: ${row.slice(0, 60)}`);
        return `<li data-horizon="${horizon}"><p class="horizon-what"><span class="horizon h-${horizon}">${HORIZON_LABELS[horizon]}</span> <strong>${inline(cells[1])}</strong></p><p>${inline(cells[2])}</p></li>`;
      });
      if (!rows.length) throw new Error("{{horizons}} has no rows.");
      return `<ul class="horizon-list" aria-label="${escapeHtml(`${heads[0]}, and ${heads[1].toLowerCase()}: each marked as today, direction or mixed`)}">${rows.join("")}</ul>`;
    },

    /** Pairs of what is real today and what it could carry: a row as "what is real, with its evidence | what it could carry". */
    bridges(_args, body) {
      const rows = (body ?? "").split("\n").filter((row) => row.trim()).map((row) => {
        const cells = row.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
        if (cells.length !== 2 || cells.some((cell) => !cell)) throw new Error(`{{bridges}}: a row is "what is real today | what it could carry", and this one is not: ${row.slice(0, 60)}`);
        if (!/\]\(\//.test(cells[0])) throw new Error(`{{bridges}}: what is real today links to the page that shows it, and this does not: ${cells[0].slice(0, 60)}`);
        return `<li><p data-horizon="today"><span class="horizon h-today">Today</span> ${inline(cells[0])}</p><p data-horizon="direction"><span class="horizon h-direction">Direction</span> ${inline(cells[1])}</p></li>`;
      });
      if (!rows.length) throw new Error("{{bridges}} has no rows.");
      return `<ul class="horizon-list bridges" aria-label="What is real today, and what it could carry, which is not built">${rows.join("")}</ul>`;
    },

    "mcp-tools"() {
      const rows = operations.map((operation) => [`<a href="${operationPath(operation)}">${code(operation.name)}</a>`, operation.kind === "read" ? "yes" : "no", operation.name === "delete" ? "yes" : "no", escapeHtml(ACCESS(operation).toLowerCase())]);
      return table("The tools", ["Tool", "Marked read-only", "Marked destructive", "Listed for"], rows);
    },
  };

  const names = (list) => listed(list.map((name) => `\`${name}\``));
  const inlineValues = {
    // Lists of operations as the pages name them in a sentence, from what the schemas say.
    "ops.versioned": names(contract.versioned),
    "ops.unversioned": names(contract.unversioned),
    "ops.paged": names(contract.paged),
    "ops.whole": names(contract.wholeLists),
    // How a task gets its ID, and what next and waiting are, as the service was seen to do them.
    "ids.rule": taskIdRule(contract),
    // The codes after which nothing was changed, as a service that refused with each was seen to leave the plan.
    "errors.unchanged": listed(outcomesOf(contract, codeData.errorCodes.map((one) => one.code)).unchanged.map((name) => `\`${name}\``)),
    "errors.unknown": outcomesOf(contract, codeData.errorCodes.map((one) => one.code)).unknown,
    ...workedOut(contract),
    // The kinds of item that record a link in their history, and those that do not, as the service was seen to do.
    "link.recorders": listed(Object.keys(contract.leftBehind).filter((kind) => contract.leftBehind[kind]), "or"),
    "link.silent": listed(Object.keys(contract.leftBehind).filter((kind) => !contract.leftBehind[kind]), "or"),
    version: codeData.version,
    "operations.count": String(operations.length),
    "page.limit": String(codeData.limits.page),
    "node.needed": codeData.nodeNeeded,
    "repo.url": site.REPO_URL,
  };

  return { block, inlineValues, used };
}

/**
 * The statuses of a task and the moves between them, drawn. The places are chosen by hand; the arrows are the
 * table of moves the program has. A status without a place, or a move without a route, stops the build, so the
 * drawing cannot show less than the program allows, or more.
 */
function statusesDiagram(codeData) {
  const PLACE = {
    done: [450, 46, 54],
    draft: [78, 150, 46],
    open: [222, 150, 46],
    in_progress: [450, 150, 70],
    in_review: [640, 150, 58],
    paused: [336, 244, 52],
    cancelled: [360, 336, 330],
  };
  // The ends of each line, by the two statuses it joins, in the order of the list of statuses.
  const ROUTE = {
    "draft|open": [124, 150, 176, 150],
    "open|in_progress": [268, 150, 380, 150],
    "in_progress|in_review": [520, 150, 582, 150],
    "open|done": [246, 131, 398, 58],
    "in_progress|done": [450, 131, 450, 65],
    "in_review|done": [628, 131, 502, 58],
    "open|paused": [246, 169, 296, 226],
    "in_progress|paused": [420, 169, 370, 226],
    "draft|cancelled": [78, 169, 78, 317],
    "open|cancelled": [206, 169, 206, 317],
    "paused|cancelled": [336, 263, 336, 317],
    "in_progress|cancelled": [476, 169, 476, 317],
    "in_review|cancelled": [640, 169, 640, 317],
  };
  const statuses = codeData.taskStatuses;
  for (const status of statuses) if (!PLACE[status]) throw new Error(`The diagram of the statuses has no place for "${status}". Give it one in statusesDiagram, in website/lib/generate.mjs.`);
  const lines = [];
  const seen = new Set();
  for (const from of statuses) {
    for (const to of codeData.taskMoves[from]) {
      const [a, b] = statuses.indexOf(from) < statuses.indexOf(to) ? [from, to] : [to, from];
      const key = `${a}|${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const route = ROUTE[key] ?? ROUTE[`${b}|${a}`];
      if (!route) throw new Error(`The diagram of the statuses has no line for the move between "${a}" and "${b}". Give it one in statusesDiagram, in website/lib/generate.mjs.`);
      // The line is written from the first status named in ROUTE to the second.
      const [first, second] = ROUTE[key] ? [a, b] : [b, a];
      const forward = codeData.taskMoves[first].includes(second);
      const back = codeData.taskMoves[second].includes(first);
      lines.push(`<line x1="${route[0]}" y1="${route[1]}" x2="${route[2]}" y2="${route[3]}" class="move"${forward ? ' marker-end="url(#move-head)"' : ""}${back ? ' marker-start="url(#move-head)"' : ""}/>`);
    }
  }
  for (const key of Object.keys(ROUTE)) if (!seen.has(key)) throw new Error(`The diagram of the statuses draws a line for "${key}", and the program allows no such move. Remove it from statusesDiagram.`);
  const boxes = statuses.map((status) => {
    const [x, y, half] = PLACE[status];
    return `<g class="st-${status}"><rect x="${x - half}" y="${y - 19}" width="${half * 2}" height="38" rx="19" class="status-box"/><circle cx="${x - half + 18}" cy="${y}" r="5" class="status-lamp"/><text x="${x + 8}" y="${y + 5}" text-anchor="middle" class="status-name">${status}</text></g>`;
  });
  const said = statuses.map((from) => `${from} to ${codeData.taskMoves[from].join(", ")}`).join("; ");
  return `<figure class="figure diagram"><div class="diagram-scroll" tabindex="0" role="group" aria-label="Diagram: the statuses of a task and the moves between them"><svg viewBox="0 0 720 372" font-size="13" role="img" aria-labelledby="statuses-title statuses-desc" class="svg-statuses">
<title id="statuses-title">The statuses of a task and the moves between them</title>
<desc id="statuses-desc">A task can move from ${escapeHtml(said)}.</desc>
<defs><marker id="move-head" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" class="move-head"/></marker></defs>
${lines.join("\n")}
${boxes.join("\n")}
</svg></div><figcaption>Every move a task can make. An arrow with two heads goes both ways. The table below says the same.</figcaption></figure>`;
}

function guideExamples(codeData) {
  return codeData.guideExamples
    .map((example, index) => {
      const calls = example.calls.map((call) => `${call.operation} ${JSON.stringify(call.input)}${call.note ? `\n  → ${call.note}` : ""}`).join("\n");
      return `${heading(3, `example-${index + 1}`, `${index + 1}. ${escapeHtml(example.title)}`)}\n<p>${escapeHtml(example.when)}</p>\n${pre(calls, "text")}\n<p><strong>Result.</strong> ${escapeHtml(example.result)}</p>`;
    })
    .join("\n");
}

/**
 * The page of one operation: what the program says of it, an example that was run against a real service when
 * the site was built, and the notes written by hand for it.
 */
/** What an operation's page says of versions: whether it takes one, how far a change moves it, and what a call does that asks for what is already so. */
function versionRow(operation, contract) {
  const seen = contract.versions[operation.name] ?? {};
  if (seen.change !== undefined && seen.change !== 1) throw new Error(`${operation.name} moves the version by ${seen.change}, and its page says "one on". Say it as it is now, in versionRow.`);
  if (!contract.versioned.includes(operation.name)) {
    const more = seen.change === 1 ? " The item it brings back is one version on." : seen.starts === 1 && (seen.startsWithLinks ?? 1) === 1 ? " What it creates starts at version 1." : "";
    return `Takes no version: it is carried out on the plan as it is at that moment.${more}`;
  }
  const same = seen.same === "unchanged" ? "A call that asks for what is already so changes nothing, and leaves the version as it is." : seen.same?.startsWith("refused:") ? `A call that asks for what is already so is refused with <code>${escapeHtml(seen.same.slice(8))}</code>.` : null;
  if (!same) throw new Error(`What ${operation.name} does when it is asked for what is already so is "${seen.same}", which versionRow has no words for.`);
  return `Takes the <code>version</code> the caller last read, and is refused with <code>version_conflict</code> when the item has changed since. A change moves the version one on. ${same}`;
}

/** What an operation's page says it answers with: the sort of answer, and for an item in short, what is not in it. */
function answersRow(answered, contract) {
  const says = `${answered.says.charAt(0).toUpperCase()}${answered.says.slice(1)}.`;
  if (answered.category !== "summary" && answered.category !== "list") return says;
  const lacks = contract.detailAdds[answered.kind];
  const fields = answered.kind === "task" ? ' <a href="/docs/operations/#what-an-answer-about-a-task-carries">Its fields</a>.' : ` Its fields: ${contract.summaries[answered.kind].always.map(code).join(", ")}${contract.summaries[answered.kind].sometimes.length ? `, and sometimes ${contract.summaries[answered.kind].sometimes.map(code).join(", ")}` : ""}.`;
  return `${says}${fields} Not in it: ${listed(lacks.map(code))}. <a href="/docs/operations/get/"><code>get</code></a> has those.`;
}

export async function operationPage(operation, notesFile, expand, contract, limits) {
  if (!existsSync(notesFile)) throw new Error(`The operation ${operation.name} has no notes: write ${notesFile}, with an example of its input in the first lines and what it answers, its rules and its errors below.`);
  const { data, body, line } = frontMatter(readFileSync(notesFile, "utf8"), notesFile);
  if (!data.example) throw new Error(`${notesFile} gives no example: add a line "example: {…}" with an input, as JSON, between the two rules at its top.`);
  const read = (name) => {
    try {
      return data[name] === undefined ? undefined : JSON.parse(data[name]);
    } catch (error) {
      throw new Error(`${notesFile}: "${name}" is not JSON (${error.message}).`);
    }
  };
  const as = data.as ?? (operation.access === "all" ? "agent1" : "admin");
  const input = read("example");
  const before = read("before") ?? [];
  // An example that reads leaves the plan as it is, and so does a call that is refused: those share one service.
  const refusal = read("refusal");
  const [run, refused] = await Promise.all([
    runExample({ operation: operation.name, as, input, before, changes: operation.kind !== "read" }),
    refusal === undefined ? null : runExample({ operation: operation.name, as: data["refusal-as"] ?? as, input: refusal, before, changes: false }),
  ]);
  if (!run.ok) throw new Error(`${notesFile}: the example was refused by the service: ${run.answer.error.message}`);
  const cuts = [];
  const answer = shortened(run.answer, cuts);
  const called = asCalled(operation, input, as);

  const answered = answerOf(run.answer);
  if (answered.category === "other") throw new Error(`${notesFile}: the answer of the example is of no sort website/lib/contract.mjs knows (${Object.keys(run.answer).join(", ")}). Say what it is, in answerOf.`);
  const facts = [
    ["It", operation.kind === "read" ? "Reads. It changes nothing." : answered.category === "key" ? "Changes the plan, as one step that is stored whole or not at all, and then stores the key in the config file, which is a step of its own." : "Changes the plan, as one step that is stored whole or not at all."],
    ["Who may call it", `${ACCESS(operation)}.${operation.access === "all" ? "" : " It is not listed for anyone else."}`],
    ...(operation.kind === "write" ? [["Version", versionRow(operation, contract)]] : []),
    ...(contract.paged.includes(operation.name) ? [["Pages", `Answers in pages of at most ${limits.page}, with a <code>continuation</code> token for the next.`]] : contract.wholeLists.includes(operation.name) ? [["Pages", "Answers with the whole list at once. It takes no continuation token."]] : []),
    ["Answers with", answersRow(answered, contract)],
    ["MCP tool", code(operation.name)],
    ["HTTP", code(`POST /api/${operation.command}`)],
    ["Command", code(`vigile ${operation.command}`)],
  ];
  const fields = operation.fields.length
    ? table(
        `The input of ${operation.name}`,
        ["Field", "Takes", "", "What it is"],
        operation.fields.map((field) => [code(field.name), `${escapeHtml(field.type)}${field.limits.length ? `<br><span class="quiet">${escapeHtml(field.limits.join(", "))}</span>` : ""}`, field.required ? '<span class="must">required</span>' : '<span class="quiet">optional</span>', escapeHtml(field.description)]),
      )
    : "<p>It takes no input: send an empty object, or nothing.</p>";

  const parts = [
    `<blockquote class="from-code" cite="#"><p>${escapeHtml(operation.description)}</p><footer>The operation's own description: what an agent reads to decide whether and how to call it.</footer></blockquote>`.replace(' cite="#"', ""),
    `<dl class="facts">${facts.map(([name, value]) => `<div><dt>${name}</dt><dd>${value}</dd></div>`).join("")}</dl>`,
    heading(2, "input", "Input"),
    fields,
    operation.fields.length ? `<p class="quiet">A field that is not listed here is refused, as <a href="/docs/errors/#code-invalid-input"><code>invalid_input</code></a>. On the command line each field is an option, with hyphens for underscores: ${code(`--${operation.fields[0].name.replaceAll("_", "-")}`)}.</p>` : "",
    heading(2, "example", "Example"),
    `<p>The same call three ways, as <code>${escapeHtml(as)}</code>. ${before.length ? "It was made on the demo plan after a few changes that set the scene." : "It was made on the demo plan the pictures of this site show."}${as === "agent1" ? " Over HTTP and MCP, a call without a key acts as <code>agent1</code> on a new instance." : ` Over HTTP, <code>vig_...</code> stands for the key of <code>${escapeHtml(as)}</code>; over MCP, the client is set up with that key.`}</p>`,
    `<div class="ways"><div><p class="way-name">Command line</p>${pre(called.cli, "sh", ' data-example="command"')}</div><div><p class="way-name">HTTP</p>${pre(called.curl, "sh", ' data-example="http"')}</div><div><p class="way-name">MCP tool call</p>${pre(called.mcp, "json")}</div></div>`,
    `<p class="way-name">The answer</p>`,
    pre(pretty(answer), "json", " data-noindex"),
    `<p class="quiet">This is what a service answered when this page was built${cuts.length ? `; for the page, ${[...new Set(cuts)].join(" and ")}` : ""}. Over HTTP it is the body of the response, over MCP the text of the tool result, and the command line prints it in words unless given <code>--json</code>.</p>`,
  ];
  let refusedCall = null;
  if (refusal !== undefined) {
    if (refused.ok) throw new Error(`${notesFile}: the call under "refusal" was not refused by the service. Give one that is.`);
    const refusedAs = asCalled(operation, refusal, data["refusal-as"] ?? as);
    parts.push(heading(3, "a-refusal", "A call that is refused"), pre(refusedAs.cli, "sh", ' data-example="command"'), pre(pretty(refused.answer), "json", " data-noindex"));
    refusedCall = { as: data["refusal-as"] ?? as, input: refusal, command: refusedAs.cli, http: refusedAs.curl, code: refused.answer.error.code };
  }
  parts.push(expand(body, line));
  return {
    title: operation.name,
    nav: operation.name,
    description: `${sentence(firstSentence(operation.description))} The ${operation.name} operation of Vigile: its input, an example, what it answers, its rules and its errors.`,
    html: parts.join("\n"),
    source: notesFile,
    example: { operation: operation.name, as, before, input, command: called.cli, http: called.curl, refused: refusedCall, answers: answered },
  };
}

export const notesPath = (contentRoot, operation) => join(contentRoot, "docs", "operations", `${operation.command}.md`);
