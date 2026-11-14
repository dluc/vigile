import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A small driver for a headless Chromium, used by the page's browser tests. It speaks the browser's debugging
 * protocol directly, so the tests need no extra dependency: only a Chromium on the machine.
 */

/** Finds a Chromium to test with: `VIGILE_TEST_BROWSER`, one downloaded by Playwright, or a system install. */
export function findBrowser(): string | null {
  const named = process.env.VIGILE_TEST_BROWSER;
  if (named) return existsSync(named) ? named : null;
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (existsSync(cache)) {
    const shells = readdirSync(cache)
      .filter((name) => name.startsWith("chromium_headless_shell-"))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const shell of shells) {
      const binary = join(cache, shell, "chrome-headless-shell-linux64", "chrome-headless-shell");
      if (existsSync(binary)) return binary;
    }
  }
  for (const binary of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]) {
    if (existsSync(binary)) return binary;
  }
  return null;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class Page {
  /** Uncaught errors the page threw. */
  readonly errors: string[] = [];
  /** Addresses the page asked for, in order. */
  readonly requests: string[] = [];
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();

  private constructor(
    private readonly child: ChildProcess,
    private readonly socket: WebSocket,
    private readonly profile: string,
  ) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Network.requestWillBeSent") this.requests.push(message.params.request.url);
      if (message.method === "Runtime.exceptionThrown") {
        this.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      }
      const waiting = message.id ? this.pending.get(message.id) : undefined;
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    });
  }

  static async launch(binary: string): Promise<Page> {
    const profile = mkdtempSync(join(tmpdir(), "vigile-browser-"));
    const child = spawn(binary, ["--headless=new", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    // The browser picks a free port and prints it.
    const port = await new Promise<number>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(new Error(`The browser did not start: ${text.slice(-300)}`)), 20_000);
      child.stderr!.on("data", (chunk) => {
        text += String(chunk);
        const match = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(text);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.once("exit", () => reject(new Error(`The browser exited: ${text.slice(-300)}`)));
    });
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json`, { redirect: "error" })).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const socket = new WebSocket(targets.find((t) => t.type === "page")!.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", () => reject(new Error("Could not connect to the browser")));
    });
    const page = new Page(child, socket, profile);
    await page.send("Page.enable");
    await page.send("Network.enable");
    await page.send("Runtime.enable");
    return page;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Runs script in the page and returns its result. The script is the body of an async function. */
  async run<T = any>(body: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value as T;
  }

  /** Waits until the script returns something truthy. */
  async until(body: string, what: string, timeout = 8000): Promise<void> {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.run(body)) return;
      await this.wait(60);
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  async open(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
    await this.until("return document.readyState === 'complete'", "the page to load");
  }

  /** Sets the window size, as dragging its edge would. `touch` makes it a phone. */
  async size(width: number, height: number, touch = false): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: touch });
    await this.send("Emulation.setTouchEmulationEnabled", { enabled: touch });
    await this.wait(120);
  }

  scheme(value: "light" | "dark"): Promise<void> {
    this.colours = value;
    return this.media();
  }

  /** Says whether the person has asked their system for reduced motion. */
  motion(value: "no-preference" | "reduce"): Promise<void> {
    this.moving = value;
    return this.media();
  }

  private colours: "light" | "dark" = "light";
  private moving: "no-preference" | "reduce" = "no-preference";

  private async media(): Promise<void> {
    await this.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value: this.colours },
        { name: "prefers-reduced-motion", value: this.moving },
      ],
    });
    // A page that listens for the change hears of it when it is drawn after the new setting has taken hold: wait
    // for the setting to show in the page, then for two drawings.
    const dark = this.colours === "dark";
    const reduce = this.moving === "reduce";
    await this.run(
      `const end = Date.now() + 2000;
       const holds = () => matchMedia("(prefers-color-scheme: dark)").matches === ${dark} && matchMedia("(prefers-reduced-motion: reduce)").matches === ${reduce};
       while (!holds() && Date.now() < end) await new Promise((done) => setTimeout(done, 10));
       await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 0))));
       return holds();`,
    ).catch(() => {});
  }

  /** Where an element is on screen, after scrolling it into view. */
  async box(selector: string, index = 0): Promise<Box> {
    const box = await this.run<Box | null>(`
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    `);
    if (!box) throw new Error(`Nothing matches ${selector} [${index}]`);
    return box;
  }

  /**
   * Clicks the middle of an element with real mouse events, the way a person does. Fails when something else
   * covers that spot, which a scripted `.click()` would not notice.
   */
  async click(selector: string, index = 0): Promise<void> {
    const box = await this.box(selector, index);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const hit = await this.run<boolean>(`
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      const at = document.elementFromPoint(${x}, ${y});
      return Boolean(at && (at === el || el.contains(at) || at.contains(el)));
    `);
    if (!hit) throw new Error(`${selector} [${index}] is covered by something else at (${Math.round(x)}, ${Math.round(y)})`);
    await this.clickAt(x, y);
  }

  async clickAt(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  /** Taps with a finger. */
  async tap(selector: string, index = 0): Promise<void> {
    const box = await this.box(selector, index);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }

  /** Drags one finger across the screen. */
  async swipe(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
    for (let step = 1; step <= 5; step++) {
      await this.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + ((to.x - from.x) * step) / 5, y: from.y + ((to.y - from.y) * step) / 5 }] });
    }
    await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }

  async drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
    for (let step = 1; step <= 5; step++) {
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + ((to.x - from.x) * step) / 5, y: from.y + ((to.y - from.y) * step) / 5, button: "left" });
    }
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 });
  }

  /** Turns the mouse wheel at a point. */
  /**
   * Turns the mouse wheel at a point until the page shows its effect. A turn that arrives while the browser is busy
   * drawing can be lost, on a slow machine more often; a person would turn the wheel again, and so does this.
   */
  async wheelUntil(x: number, y: number, deltaY: number, deltaX: number, body: string, what: string): Promise<void> {
    for (let turn = 0; turn < 6 && !(await this.run<boolean>(body)); turn++) {
      await this.wheel(x, y, deltaY, deltaX);
      await this.wait(400);
    }
    await this.until(body, what);
  }

  /** Turns the mouse wheel with the pointer at a point. The pointer is moved there first, as a hand would. */
  async wheel(x: number, y: number, deltaY: number, deltaX = 0): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
  }

  type(text: string): Promise<void> {
    return this.send("Input.insertText", { text });
  }

  async key(name: "Escape" | "Enter" | "Tab" | "Backspace" | "Space", shift = false): Promise<void> {
    const codes = { Escape: 27, Enter: 13, Tab: 9, Backspace: 8, Space: 32 } as const;
    const key = name === "Space" ? " " : name;
    const event = { key, code: name, windowsVirtualKeyCode: codes[name], modifiers: shift ? 8 : 0, ...(name === "Enter" ? { text: "\r" } : name === "Space" ? { text: " " } : {}) };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...event });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
  }

  /** Saves a picture of what is on screen. */
  async shot(file: string): Promise<void> {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(data, "base64"));
  }

  /** Makes requests to matching addresses fail, as a service that does not have them would. */
  block(patterns: string[]): Promise<void> {
    return this.send("Network.setBlockedURLs", { urls: patterns });
  }

  async close(): Promise<void> {
    this.socket.close();
    this.child.kill("SIGKILL");
    await new Promise((resolve) => this.child.once("exit", resolve));
    rmSync(this.profile, { recursive: true, force: true });
  }
}
