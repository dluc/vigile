import { styleText } from "node:util";

type Style = Parameters<typeof styleText>[0];

/** Colour and symbols only when a person is looking: off when piped, or when NO_COLOR is set. */
export interface Ui {
  readonly fancy: boolean;
  paint(style: Style, text: string): string;
  out(line?: string): void;
  err(line?: string): void;
}

export function createUi(stream: NodeJS.WriteStream = process.stdout, errors: NodeJS.WriteStream = process.stderr): Ui {
  const forced = process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0";
  const fancy = forced || (Boolean(stream.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb");
  return {
    fancy,
    paint: (style, text) => (fancy ? styleText(style, text, { validateStream: false }) : text),
    out: (line = "") => void stream.write(`${line}\n`),
    err: (line = "") => void errors.write(`${line}\n`),
  };
}

export const SYMBOL = { ok: "✓", warn: "⚠", fail: "✗", fix: "→", dot: "·", none: "–" } as const;

export type Level = "ok" | "warn" | "fail";

const LEVEL_STYLE: Record<Level, Style> = { ok: "green", warn: "yellow", fail: "red" };

export const mark = (ui: Ui, level: Level): string => ui.paint(LEVEL_STYLE[level], SYMBOL[level]);

export const accent = (ui: Ui, text: string): string => ui.paint("cyan", text);
export const dim = (ui: Ui, text: string): string => ui.paint("dim", text);
export const bold = (ui: Ui, text: string): string => ui.paint("bold", text);

/** Width as shown in a terminal, ignoring colour codes. */
const width = (text: string): number => text.replace(/\u001b\[[0-9;]*m/g, "").length;

export const pad = (text: string, size: number, right = false): string => {
  const gap = " ".repeat(Math.max(0, size - width(text)));
  return right ? gap + text : text + gap;
};

export function heading(ui: Ui, text: string): void {
  ui.out();
  ui.out(`  ${bold(ui, text)}`);
  ui.out();
}

export interface Column<T> {
  title: string;
  value(row: T): string;
  right?: boolean;
  style?(row: T): Style | undefined;
}

/** Aligned columns with a dim header. The last column is left unpadded so long titles do not wrap early. */
export function table<T>(ui: Ui, rows: T[], columns: Column<T>[]): void {
  const cells = rows.map((row) => columns.map((c) => c.value(row)));
  const sizes = columns.map((c, i) => Math.max(c.title.length, ...cells.map((r) => width(r[i]!))));
  const last = columns.length - 1;
  ui.out(`  ${columns.map((c, i) => dim(ui, i === last && !c.right ? c.title : pad(c.title, sizes[i]!, c.right))).join("  ")}`);
  rows.forEach((row, r) => {
    const line = columns.map((c, i) => {
      const raw = cells[r]![i]!;
      const text = i === last && !c.right ? raw : pad(raw, sizes[i]!, c.right);
      const style = c.style?.(row);
      return style ? ui.paint(style, text) : text;
    });
    ui.out(`  ${line.join("  ")}`);
  });
}

/** `name  value` pairs, aligned. */
export function fields(ui: Ui, pairs: Array<[string, string]>): void {
  const size = Math.max(...pairs.map(([name]) => name.length));
  for (const [name, value] of pairs) ui.out(`  ${dim(ui, pad(name, size))}  ${value}`);
}

export function note(ui: Ui, level: Level, text: string, fix?: string): void {
  ui.out(`  ${mark(ui, level)} ${text}`);
  if (fix) ui.out(`    ${dim(ui, SYMBOL.fix)} ${fix}`);
}

/**
 * What was warned of on the way to a failure, kept with the failure: reported as JSON, the two are one document
 * that a script can read, where warnings written as they came would stand before it as plain lines.
 */
const warned = new WeakMap<object, string[]>();
export function withWarnings(error: unknown, warnings: string[]): unknown {
  if (warnings.length && typeof error === "object" && error !== null) warned.set(error, warnings);
  return error;
}
export const warningsOf = (error: unknown): string[] => (typeof error === "object" && error !== null ? (warned.get(error) ?? []) : []);

export function failure(ui: Ui, message: string, lines: string[] = []): void {
  ui.err();
  ui.err(`  ${ui.paint("red", SYMBOL.fail)} ${message}`);
  for (const line of lines) ui.err(`    ${dim(ui, SYMBOL.fix)} ${line}`);
  ui.err();
}

export const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
