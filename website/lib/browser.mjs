// A small driver for a headless Chromium, for the site's own browser tests. It speaks the browser's debugging
// protocol directly, so the tests need no dependency: only a Chromium on the machine. It is the site's own, and
// has what the site's tests ask of a browser and nothing more.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Finds a Chromium to test with: the one VIGILE_TEST_BROWSER names, one downloaded by Playwright, or one of the system. */
export function findBrowser() {
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

/**
 * What the browser is given of the environment of the tests: all of it but the bus of a desktop session. An
 * address of that bus that is stale, or of another machine, can make every visit to a plain local page wait
 * for seconds, which turns the suite into one that hangs.
 */
function browserEnvironment(environment = process.env) {
  const { DBUS_SESSION_BUS_ADDRESS: _desktopSession, ...clean } = environment;
  return clean;
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** One page of a browser that was started for it. */
export class Page {
  /** Uncaught errors the page threw. */
  errors = [];
  #nextId = 0;
  #pending = new Map();
  #child;
  #socket;
  #profile;
  #moving = "no-preference";

  constructor(child, socket, profile) {
    this.#child = child;
    this.#socket = socket;
    this.#profile = profile;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown") this.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      const waiting = message.id ? this.#pending.get(message.id) : undefined;
      if (!waiting) return;
      this.#pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    });
  }

  /** Starts the browser at this path, with a profile of its own in a temporary folder, and opens its one page. */
  static async launch(binary) {
    const profile = mkdtempSync(join(tmpdir(), "vigile-site-browser-profile-"));
    const child = spawn(binary, ["--headless=new", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"], env: browserEnvironment() });
    // The browser picks a free port and prints it.
    const port = await new Promise((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(new Error(`The browser did not start: ${text.slice(-300)}`)), 20_000);
      child.stderr.on("data", (chunk) => {
        text += String(chunk);
        const match = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(text);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.once("exit", () => reject(new Error(`The browser exited: ${text.slice(-300)}`)));
    });
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`, { redirect: "error" })).json();
    const socket = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", () => reject(new Error("Could not connect to the browser")));
    });
    const page = new Page(child, socket, profile);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    return page;
  }

  /** Sends one command of the debugging protocol and answers with its result. */
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.#nextId;
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Runs script in the page and returns its result. The script is the body of an async function. */
  async run(body) {
    const result = await this.send("Runtime.evaluate", { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }

  /** Waits until the script returns something that counts as true. */
  async until(body, what, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.run(body)) return;
      await wait(60);
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  /** Goes to an address and waits until the page is loaded. */
  async open(url) {
    await this.send("Page.navigate", { url });
    await this.until("return document.readyState === 'complete'", "the page to load");
  }

  /** Sets the size of the window, as dragging its edge would. `touch` makes it a phone. */
  async size(width, height, touch = false) {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: touch });
    await this.send("Emulation.setTouchEmulationEnabled", { enabled: touch });
    await wait(120);
  }

  /** Says whether the person has asked their system for less motion: "reduce", or "no-preference". */
  async motion(value) {
    this.#moving = value;
    await this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value }] });
    // A page that listens for the change hears of it when it is drawn after the new setting has taken hold: wait
    // for the setting to show in the page, then for two drawings.
    const reduce = this.#moving === "reduce";
    await this.run(
      `const end = Date.now() + 2000;
       const holds = () => matchMedia("(prefers-reduced-motion: reduce)").matches === ${reduce};
       while (!holds() && Date.now() < end) await new Promise((done) => setTimeout(done, 10));
       await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 0))));
       return holds();`,
    ).catch(() => {});
  }

  /** Where an element is in the window, after it was scrolled into view. */
  async box(selector, index = 0) {
    const box = await this.run(`
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
   * covers that spot, which a click made by a script would not notice.
   */
  async click(selector, index = 0) {
    const box = await this.box(selector, index);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const hit = await this.run(`
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      const at = document.elementFromPoint(${x}, ${y});
      return Boolean(at && (at === el || el.contains(at) || at.contains(el)));
    `);
    if (!hit) throw new Error(`${selector} [${index}] is covered by something else at (${Math.round(x)}, ${Math.round(y)})`);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  /** Taps the middle of an element with a finger. */
  async tap(selector, index = 0) {
    const box = await this.box(selector, index);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }

  /** Turns the mouse wheel with the pointer at a point. The pointer is moved there first, as a hand would. */
  async wheel(x, y, deltaY, deltaX = 0) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
  }

  /** Types text into what has the focus. */
  type(text) {
    return this.send("Input.insertText", { text });
  }

  /** Presses and lets go of one key: "Tab", "Enter", "Escape", "Backspace" or "Space". */
  async key(name, shift = false) {
    const codes = { Escape: 27, Enter: 13, Tab: 9, Backspace: 8, Space: 32 };
    const key = name === "Space" ? " " : name;
    const event = { key, code: name, windowsVirtualKeyCode: codes[name], modifiers: shift ? 8 : 0, ...(name === "Enter" ? { text: "\r" } : name === "Space" ? { text: " " } : {}) };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...event });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
  }

  /** Ends the browser and removes its profile. */
  async close() {
    this.#socket.close();
    // A browser that has ended already says so no second time: waiting for it would never end.
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGKILL");
      await new Promise((resolve) => this.#child.once("exit", resolve));
    }
    // The processes the browser started may write to its profile for a moment after it is gone: a folder that
    // one of them has just filled again is not empty when it is to be removed. It is tried again until they are done.
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(this.#profile, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt >= 50) throw error;
        await wait(100);
      }
    }
  }
}
