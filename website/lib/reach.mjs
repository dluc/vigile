// Says where a file of the site reaches: what it imports, and which paths it names. The site has two doors to
// the product, the description the program prints and the program itself (website/lib/program.mjs), and this
// is what holds every file of the site to them: a file that imports a module from outside the site's folder,
// or names a path into the product's code, is found here, and independence.test.mjs fails for it.
//
// It looks at the code and not at the words: comments are left out, and a sentence that mentions a folder of
// the product by name is not a path to it.

import { dirname, relative, resolve, sep } from "node:path";

/** Words after which a slash starts a pattern and is not a division. */
const BEFORE_PATTERN = new Set(["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "else", "do", "yield", "await"]);

/**
 * Reads JavaScript far enough to tell code from words. Answers with the code as it is without its comments,
 * each piece of text in it replaced by a mark (\u0001, its number, \u0001), and with the texts: for each its
 * words and its line. In a text with parts that are worked out, as in `${a}/b`, each such part is \u0000,
 * and the code of those parts stands after the rest of the code, so that what is imported or named in one of
 * them is seen as well.
 */
export function readCode(source) {
  const texts = [];
  let code = "";
  /** The code of the parts of texts that are worked out. */
  let aside = "";
  let line = 1;
  let at = 0;
  /** The last sign of the code so far that is not a space, and the last word. */
  const before = () => {
    const trimmed = code.trimEnd();
    return { sign: trimmed.at(-1) ?? "", word: /[A-Za-z_$][\w$]*$/.exec(trimmed)?.[0] ?? "" };
  };
  const take = (text, startedAt) => {
    texts.push({ text, line: startedAt });
    code += `\u0001${texts.length - 1}\u0001`;
  };
  /** Reads a text between quotes, from the opening quote on. */
  const quoted = (quote) => {
    const startedAt = line;
    let text = "";
    at++;
    while (at < source.length && source[at] !== quote) {
      if (source[at] === "\\") {
        const next = source[at + 1];
        text += next === "n" ? "\n" : next === "t" ? "\t" : (next ?? "");
        if (next === "\n") line++;
        at += 2;
        continue;
      }
      if (source[at] === "\n") line++;
      text += source[at++];
    }
    at++;
    take(text, startedAt);
  };
  /** Reads a text between backticks. What stands in ${ } is code, and is read as code, to be put after the rest. */
  const template = () => {
    const startedAt = line;
    const index = texts.push(null) - 1;
    code += `\u0001${index}\u0001`;
    let text = "";
    at++;
    while (at < source.length && source[at] !== "`") {
      if (source[at] === "\\") {
        text += source[at + 1] ?? "";
        at += 2;
        continue;
      }
      if (source[at] === "$" && source[at + 1] === "{") {
        at += 2;
        text += "\u0000";
        const outer = code;
        code = "";
        codeUntil("}");
        aside += `(${code});\n`;
        code = outer;
        at++;
        continue;
      }
      if (source[at] === "\n") line++;
      text += source[at++];
    }
    at++;
    texts[index] = { text, line: startedAt };
  };
  /** Reads code until the sign that closes what was opened, or to the end. */
  const codeUntil = (closing) => {
    let depth = 0;
    while (at < source.length) {
      const sign = source[at];
      if (closing && depth === 0 && sign === closing) return;
      if (sign === "\n") line++;
      if (sign === "/" && source[at + 1] === "/") {
        while (at < source.length && source[at] !== "\n") at++;
        continue;
      }
      if (sign === "/" && source[at + 1] === "*") {
        const end = source.indexOf("*/", at + 2);
        const comment = source.slice(at, end < 0 ? source.length : end + 2);
        line += comment.split("\n").length - 1;
        at += comment.length;
        code += " ";
        continue;
      }
      if (sign === '"' || sign === "'") {
        quoted(sign);
        continue;
      }
      if (sign === "`") {
        template();
        continue;
      }
      if (sign === "/") {
        const { sign: last, word } = before();
        if (last === "" || "(,=:[!&|?{};+-*%<>~^".includes(last) || BEFORE_PATTERN.has(word)) {
          // A pattern: to the slash that ends it, which is none inside brackets and none after a backslash.
          let inClass = false;
          at++;
          while (at < source.length && (inClass || source[at] !== "/") && source[at] !== "\n") {
            if (source[at] === "\\") at++;
            else if (source[at] === "[") inClass = true;
            else if (source[at] === "]") inClass = false;
            at++;
          }
          at++;
          while (/[a-z]/.test(source[at] ?? "")) at++;
          code += " /./ ";
          continue;
        }
      }
      if (closing && sign === "{") depth++;
      if (closing && sign === "}" && depth > 0) depth--;
      code += sign;
      at++;
    }
  };
  codeUntil(null);
  return { code: `${code}\n${aside}`, texts };
}

/** A text that names a folder of the product's code, as a part of a path: on its own, or between slashes. */
const INTO_THE_PRODUCT = /(?:^|[\\/])(?:packages|scripts)(?:[\\/]|$)/;
/** A text that names a file of TypeScript. */
const TYPESCRIPT = /\.[cm]?tsx?(?![\w-])/;

/**
 * What is wrong with where a file of the site reaches. `file` is its path, `siteRoot` the folder of the site,
 * and `allowed` the paths outside that folder this file may name, each written from the folder above the
 * site's. Answers with a line for each thing that is wrong; none when the file keeps to the site.
 */
export function outsideReaches(source, file, siteRoot, allowed = []) {
  const { code, texts } = readCode(source);
  const found = [];
  const folder = dirname(resolve(file));
  const site = resolve(siteRoot);
  const inside = (path) => path === site || path.startsWith(`${site}${sep}`);
  const mayName = (path) => inside(path) || allowed.some((one) => resolve(site, "..", one) === path);
  const textOf = (mark) => texts[Number(mark)];
  const where = (text) => `${relative(site, resolve(file))}:${text.line}`;

  // ---- What it imports: something of Node.js itself, or a file of the site.
  const specifiers = [];
  for (const match of code.matchAll(/\b(?:import|export)\b[^;()\u0001]*?\bfrom\s*\u0001(\d+)\u0001/g)) specifiers.push(textOf(match[1]));
  for (const match of code.matchAll(/\bimport\s*\u0001(\d+)\u0001/g)) specifiers.push(textOf(match[1]));
  for (const match of code.matchAll(/\bimport\s*\(\s*(?:\u0001(\d+)\u0001\s*\))?/g)) {
    if (match[1] === undefined) found.push(`${relative(site, resolve(file))}: imports something that is worked out when it runs, so that nobody can read here what it is. A file of the site imports by name.`);
    else specifiers.push(textOf(match[1]));
  }
  for (const text of specifiers) {
    if (text.text.startsWith("node:")) continue;
    if (!text.text.startsWith("./") && !text.text.startsWith("../")) found.push(`${where(text)}: imports "${text.text}", which is neither a part of Node.js (node:…) nor a file of the site. The site has no dependency.`);
    else if (!inside(resolve(folder, text.text))) found.push(`${where(text)}: imports "${text.text}", which is outside the site's folder. The site speaks to the product through "vigile describe" and by running the program, and through nothing else.`);
  }
  if (/\b(?:require|createRequire)\s*\(/.test(code)) found.push(`${relative(site, resolve(file))}: loads a module with require. A file of the site imports by name, from Node.js or from the site.`);

  // ---- The places it names from where it is: each inside the site, or one of the few it may name.
  /** What stands between the brackets of a call that starts at this place of the code. */
  const argumentsAt = (from) => {
    let depth = 1;
    let end = from;
    while (end < code.length && depth > 0) {
      if (code[end] === "(") depth++;
      if (code[end] === ")") depth--;
      end++;
    }
    return code.slice(from, end - 1);
  };
  for (const match of code.matchAll(/\bnew\s+URL\s*\(/g)) {
    const from = /^([\s\S]*),\s*import\s*\.\s*meta\s*\.\s*url\s*$/.exec(argumentsAt(match.index + match[0].length));
    // An address that is not told from where the file is leads to no file of this machine by itself.
    if (!from) continue;
    const mark = /^\s*\u0001(\d+)\u0001\s*$/.exec(from[1]);
    if (!mark) {
      found.push(`${relative(site, resolve(file))}: names a place from where the file is with something that is worked out. It is written as text, as in new URL("content/", import.meta.url).`);
      continue;
    }
    const text = textOf(mark[1]);
    if (text.text.includes("\u0000")) found.push(`${where(text)}: names a place from where the file is with a part that is worked out: "${text.text.replaceAll("\u0000", "${…}")}". It is written whole.`);
    else if (!mayName(resolve(folder, text.text))) found.push(`${where(text)}: names "${text.text}", which is outside the site's folder and none of the places this file may name there${allowed.length ? ` (${allowed.join(", ")})` : ""}.`);
  }
  // A path put together from parts, or handed to a function that reads: none climbs out of the folder it starts in.
  const climbs = (text) => text.text === ".." || text.text.startsWith("../") || text.text.startsWith("..\\");
  for (const match of code.matchAll(/\b(?:join|resolve|[A-Za-z]+Sync|spawn|readFile|writeFile|readdir|open)\s*\(/g)) {
    // The parts are taken together, from the folder of the file: two steps up are two steps, also when each is a part of its own.
    const parts = [...argumentsAt(match.index + match[0].length).matchAll(/\u0001(\d+)\u0001/g)].map((mark) => textOf(mark[1])).filter((text) => !text.text.includes("\u0000") && !text.text.startsWith("/"));
    const first = parts.find(climbs);
    if (first && !mayName(resolve(folder, ...parts.map((text) => text.text)))) found.push(`${where(first)}: goes up and out of the site's folder with "${first.text}".`);
  }

  // ---- The texts in it: none is a path into the product's code, and none names a file of TypeScript.
  for (const text of texts) {
    if (INTO_THE_PRODUCT.test(text.text)) found.push(`${where(text)}: names a path into the product's code: "${text.text.replaceAll("\u0000", "${…}").slice(0, 80)}".`);
    if (TYPESCRIPT.test(text.text)) found.push(`${where(text)}: names a file of TypeScript: "${text.text.replaceAll("\u0000", "${…}").slice(0, 80)}". The site reads no source of the product.`);
  }
  return [...new Set(found)];
}
