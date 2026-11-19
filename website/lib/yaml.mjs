// Reads the YAML the workflows of this repository are written in, and nothing more: mappings and lists by
// indentation, plain and quoted values, lists in brackets, and comments. It is here so that a test can read a
// workflow as GitHub would, without a dependency: what is not in this small part of YAML is refused, with the
// file and the line, and so is what YAML itself refuses, such as a key that is there twice, or the marks a
// merge leaves behind when it was not finished.

export class YamlError extends Error {
  constructor(file, line, message) {
    super(`${file}:${line}: ${message}`);
    this.name = "YamlError";
    this.line = line;
  }
}

/** A line without its comment. A # starts one at the start of the line or after a space, outside quotes. */
function withoutComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const sign = line[i];
    if (quote === '"') {
      if (sign === "\\") i++;
      else if (sign === quote) quote = null;
    } else if (quote === "'") {
      if (sign === "'" && line[i + 1] === "'") i++;
      else if (sign === quote) quote = null;
    } else if (sign === '"' || sign === "'") quote = sign;
    else if (sign === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/**
 * The elements of a list in brackets, as they are written: cut at the commas that stand outside quotes and
 * outside brackets inside it. A comma after the last element is allowed; an element that is missing is null.
 * Brackets that do not pair, one closed that was not opened or one opened that is not closed, are no list: null.
 */
function elementsOf(inner) {
  const elements = [];
  let quote = null;
  let depth = 0;
  let from = 0;
  for (let i = 0; i < inner.length; i++) {
    const sign = inner[i];
    if (quote === '"') {
      if (sign === "\\") i++;
      else if (sign === quote) quote = null;
    } else if (quote === "'") {
      if (sign === "'" && inner[i + 1] === "'") i++;
      else if (sign === quote) quote = null;
    } else if (sign === '"' || sign === "'") quote = sign;
    else if (sign === "[") depth++;
    else if (sign === "]") {
      if (--depth < 0) return null;
    } else if (sign === "," && depth === 0) {
      elements.push(inner.slice(from, i).trim() || null);
      from = i + 1;
    }
  }
  if (depth !== 0) return null;
  const last = inner.slice(from).trim();
  if (last) elements.push(last);
  return elements;
}

export function parseYaml(text, file = "file.yml") {
  const fail = (line, message) => {
    throw new YamlError(file, line, message);
  };
  const lines = [];
  text.split("\n").forEach((raw, index) => {
    const number = index + 1;
    if (/^(<<<<<<<|=======|>>>>>>>)(\s|$)/.test(raw)) fail(number, "a mark of a merge that was not finished");
    if (/^\s*\t/.test(raw)) fail(number, "a tab in the indentation");
    const kept = withoutComment(raw).trimEnd();
    if (!kept.trim()) return;
    if (/^(---|\.\.\.)$/.test(kept.trim())) fail(number, "more than one document in a file is not read here");
    lines.push({ number, indent: kept.length - kept.trimStart().length, text: kept.trim() });
  });
  let at = 0;

  const value = (written, number) => {
    const text = written.trim();
    if (/^[|>]/.test(text)) fail(number, "text over several lines, written with | or >, is not read here");
    if (/^[&*!]/.test(text)) fail(number, "anchors, aliases and tags are not read here");
    if (text.startsWith("[")) {
      if (!text.endsWith("]")) fail(number, "a list in brackets ends on its line");
      const inner = text.slice(1, -1).trim();
      const elements = elementsOf(inner);
      if (elements === null) fail(number, "the brackets of a list pair up");
      return elements.map((item) => (item === null ? fail(number, "a list in brackets has an element between its commas") : value(item, number)));
    }
    if (text.startsWith("{")) fail(number, "a mapping in braces is not read here");
    if (text.startsWith('"')) {
      if (!text.endsWith('"')) fail(number, "a quote that is opened is closed at the end of the value");
      try {
        return JSON.parse(text);
      } catch {
        fail(number, "a double-quoted value has only valid escaped quotes and characters");
      }
    }
    if (text.startsWith("'")) {
      if (!text.endsWith("'")) fail(number, "a quote that is opened is closed at the end of the value");
      let made = "";
      const inner = text.slice(1, -1);
      for (let i = 0; i < inner.length; i++) {
        if (inner[i] !== "'") made += inner[i];
        else if (inner[i + 1] === "'") (made += "'"), i++;
        else fail(number, "a quote inside a single-quoted value is written twice");
      }
      return made;
    }
    if (/:\s/.test(text.replace(/\$\{\{.*?\}\}/g, "")) || text.endsWith(":")) fail(number, `a plain value has no ": " in it: ${text}`);
    if (text === "true" || text === "false") return text === "true";
    if (text === "null" || text === "~") return null;
    return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
  };

  const KEY = /^([A-Za-z0-9_.-]+|"[^"]*"|'[^']*'):(?:\s+(.*))?$/;

  function mapping(indent) {
    const map = {};
    while (at < lines.length && lines[at].indent === indent && !/^-(\s|$)/.test(lines[at].text)) {
      const line = lines[at];
      const found = KEY.exec(line.text);
      if (!found) fail(line.number, `this is not "key: value": ${line.text}`);
      const key = /^['"]/.test(found[1]) ? value(found[1], line.number) : found[1];
      if (Object.hasOwn(map, key)) fail(line.number, `the key "${key}" is there twice`);
      at++;
      if (found[2] !== undefined) {
        map[key] = value(found[2], line.number);
        if (at < lines.length && lines[at].indent > indent) fail(lines[at].number, `this line is indented under "${key}", which has its value on its own line`);
      } else if (at < lines.length && (lines[at].indent > indent || (lines[at].indent === indent && /^-(\s|$)/.test(lines[at].text)))) map[key] = block(lines[at].indent);
      else map[key] = null;
    }
    return map;
  }

  function sequence(indent) {
    const list = [];
    while (at < lines.length && lines[at].indent === indent && /^-(\s|$)/.test(lines[at].text)) {
      const line = lines[at];
      const rest = line.text.slice(1).trimStart();
      if (!rest) {
        at++;
        if (at >= lines.length || lines[at].indent <= indent) fail(line.number, "an item of a list has nothing in it");
        list.push(block(lines[at].indent));
      } else if (KEY.test(rest)) {
        // "- key: value" opens a mapping: its other keys stand under the key, two places in.
        lines[at] = { number: line.number, indent: indent + (line.text.length - rest.length), text: rest };
        list.push(mapping(lines[at].indent));
      } else {
        at++;
        list.push(value(rest, line.number));
      }
    }
    return list;
  }

  function block(indent) {
    const made = /^-(\s|$)/.test(lines[at].text) ? sequence(indent) : mapping(indent);
    if (at < lines.length && lines[at].indent > indent) fail(lines[at].number, "this line is indented further than what it follows, and belongs to nothing");
    return made;
  }

  if (!lines.length) return null;
  if (lines[0].indent !== 0) fail(lines[0].number, "the first line is indented");
  const made = block(0);
  if (at < lines.length) fail(lines[at].number, `this line belongs to nothing above it: ${lines[at].text}`);
  return made;
}
