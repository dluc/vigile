import { timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { UnconfirmedWrite, generateKey, readRaw, removeKeyWhileServing, setKeyWhileServing } from "./file.js";
import { keyOf, validateConfig, type Config } from "./schema.js";

export type Identity = { ok: true; username: string; keyless: boolean } | { ok: false; reason: "invalid_key" | "key_required" };

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Who a request acts as, from its `Authorization` header. A wrong key is refused; it never falls back to the keyless user. */
export function identify(auth: Config["auth"], authorization: string | undefined): Identity {
  const key = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (key) {
    for (const [username, expected] of Object.entries(auth.keys)) {
      if (same(key, expected)) return { ok: true, username, keyless: false };
    }
    return { ok: false, reason: "invalid_key" };
  }
  if (auth.keyless_user) return { ok: true, username: auth.keyless_user, keyless: true };
  return { ok: false, reason: "key_required" };
}

/**
 * The auth settings of a running service. They are read again whenever the config file changes,
 * so adding a user or resetting a key needs no restart. Other settings still do.
 */
export class LiveAuth {
  private auth: Config["auth"];
  /** Which file the settings in `auth` were read from: see `stamp`. Empty when the file has to be read again. */
  private read = "";
  private lastError: string | null = null;
  /** Says what went wrong to whoever listens. That it could not be said changes nothing about what was done. */
  private readonly onProblem: (message: string) => void;

  constructor(
    private readonly path: string,
    initial: Config["auth"],
    onProblem: (message: string) => void = () => {},
    /** Settings given for this run in the environment or as options. They stay, whatever the file says later. */
    private readonly fixed: Partial<Pick<Config["auth"], "keyless_user">> = {},
  ) {
    // The file is read at the first look: it may have changed since `initial` was read from it.
    this.auth = initial;
    this.onProblem = (message) => {
      try {
        onProblem(message);
      } catch {
        // Not said.
      }
    };
  }

  private fromFile(config: Config): Config["auth"] {
    return { ...config.auth, ...this.fixed };
  }

  /**
   * What tells one state of the file from the next: every change puts a new file in its place, so the file
   * itself is another one, besides its time and its size.
   */
  private stamp(): string {
    try {
      const { mtimeMs, ino, size } = statSync(this.path);
      return `${mtimeMs} ${ino} ${size}`;
    } catch {
      return "none";
    }
  }

  current(): Config["auth"] {
    // Looked at before the file is read: a change that falls between the two is then read again next time.
    const stamp = this.stamp();
    if (stamp !== this.read) {
      this.read = stamp;
      try {
        this.auth = this.fromFile(validateConfig(readRaw(this.path), this.path));
        this.lastError = null;
      } catch (error) {
        // A broken edit must not lock everyone out or let everyone in: keep the last settings that passed the check.
        const message = (error as Error).message;
        if (message !== this.lastError) this.onProblem(`The config file changed but does not pass the check; keeping the previous auth settings. ${message}`);
        this.lastError = message;
      }
    }
    return this.auth;
  }

  identify(authorization: string | undefined): Identity {
    return identify(this.current(), authorization);
  }

  /** Makes a new key. Nothing is stored yet. */
  create(): string {
    return generateKey();
  }

  /** The key the file has for the user now, if any. */
  stored(username: string): string | undefined {
    return keyOf(this.current(), username);
  }

  /**
   * Writes a key for the user to the config file, replacing any earlier one. It applies at once. Returns a
   * warning when the key is in the file but the system could not confirm that it will survive a power cut:
   * the key works, and whoever asked for it must get it, with that said.
   */
  async put(username: string, key: string): Promise<string | undefined> {
    return this.written(() => setKeyWhileServing(this.path, username, key));
  }

  /** Takes up what a change wrote to the file. A change that is in place but unconfirmed is taken up too, and said. */
  private async written(change: () => Promise<Config>): Promise<string | undefined> {
    let warning: string | undefined;
    try {
      this.auth = this.fromFile(await change());
    } catch (error) {
      if (!(error instanceof UnconfirmedWrite)) throw error;
      this.auth = this.fromFile(error.config);
      warning = error.message;
      this.onProblem(error.message);
    }
    // What the change wrote applies at once. It is not taken for what the file says now, though: between the
    // change letting go of the file and this line, someone else may have changed it again, and to note the
    // file as read here would keep their change out until the next one. The next look reads the file anew.
    this.read = "";
    return warning;
  }

  /** Makes a key for the user and writes it to the config file. */
  async issue(username: string): Promise<string> {
    const key = this.create();
    await this.put(username, key);
    return key;
  }

  async revoke(username: string): Promise<void> {
    await this.written(() => removeKeyWhileServing(this.path, username));
  }
}
