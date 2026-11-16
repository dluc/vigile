import { isIP } from "node:net";
import { z } from "zod";

export const KEY_PREFIX = "vig_";
const USERNAME = /^[a-z][a-z0-9_-]{0,31}$/;
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

const address = z
  .string()
  .refine((value) => isIP(value) !== 0 || HOSTNAME.test(value), "must be an IP address or a host name");

const apiKey = z
  .string()
  .min(20, "must have at least 20 characters")
  .regex(/^[A-Za-z0-9_-]+$/, 'may hold only letters, digits, "_" and "-"');

/**
 * How often an automatic backup may be taken, in hours. The service looks at its clock twice a minute, and a
 * backup of a large plan is tens of megabytes: more often than every quarter of an hour fills a disk and says
 * little more.
 */
export const BACKUP_EVERY_HOURS = { least: 0.25, most: 8760 };
/** The most automatic backups of a tenant that can be asked to be kept. */
export const BACKUP_KEEP_MOST = 10_000;

export const configSchema = z.strictObject({
  name: z.string().min(1).max(40).default("vigile"),
  data_dir: z.string().min(1).default("data"),
  log_level: z.enum(["debug", "info", "quiet"]).default("info"),
  listen: z
    .strictObject({
      address: address.default("127.0.0.1"),
      port: z.number().int().min(1).max(65535).default(8700),
    })
    .default({ address: "127.0.0.1", port: 8700 }),
  auth: z
    .strictObject({
      keyless_user: z
        .string()
        .refine((value) => value === "" || USERNAME.test(value), "must be a username, or empty to refuse connections without a key")
        .default("agent1"),
      keys: z.record(z.string().regex(USERNAME, "must be a username"), apiKey).default({}),
    })
    .default({ keyless_user: "agent1", keys: {} }),
  backup: z
    .strictObject({
      enabled: z.boolean().default(true),
      every_hours: z
        .number()
        .min(BACKUP_EVERY_HOURS.least, `must be at least ${BACKUP_EVERY_HOURS.least}, which is a quarter of an hour`)
        .max(BACKUP_EVERY_HOURS.most, `must be at most ${BACKUP_EVERY_HOURS.most}, which is a year`)
        .default(24),
      folder: z.string().min(1).default("backups"),
      keep: z.number().int().min(1, "must be at least 1").max(BACKUP_KEEP_MOST, `must be at most ${BACKUP_KEEP_MOST}`).default(30),
    })
    .default({ enabled: true, every_hours: 24, folder: "backups", keep: 30 }),
});

export type Config = z.output<typeof configSchema>;

export interface Setting {
  key: string;
  /** A number is a whole number; a decimal may have a fraction; a boolean is `true` or `false`. */
  type: "string" | "number" | "decimal" | "boolean";
  env: string;
  description: string;
}

/** The settings a person changes with `vigile config set`. API keys are managed with `vigile user` instead. */
export const SETTINGS: readonly Setting[] = [
  { key: "name", type: "string", env: "VIGILE_NAME", description: "A label for this instance, shown in the web page and at startup" },
  { key: "data_dir", type: "string", env: "VIGILE_DATA_DIR", description: "Where the data lives; relative paths start at the config file's folder" },
  { key: "log_level", type: "string", env: "VIGILE_LOG_LEVEL", description: "debug, info or quiet" },
  { key: "listen.address", type: "string", env: "VIGILE_LISTEN_ADDRESS", description: "The address to listen on" },
  { key: "listen.port", type: "number", env: "VIGILE_LISTEN_PORT", description: "The port to listen on" },
  {
    key: "auth.keyless_user",
    type: "string",
    env: "VIGILE_AUTH_KEYLESS_USER",
    description: "Who a connection without an API key acts as; empty refuses such connections",
  },
  { key: "backup.enabled", type: "boolean", env: "VIGILE_BACKUP_ENABLED", description: "Whether the service takes backups of the data by itself: true or false" },
  { key: "backup.every_hours", type: "decimal", env: "VIGILE_BACKUP_EVERY_HOURS", description: "How many hours lie between two automatic backups; 0.5 is half an hour" },
  { key: "backup.folder", type: "string", env: "VIGILE_BACKUP_FOLDER", description: "Where automatic backups go; relative paths start at the config file's folder" },
  { key: "backup.keep", type: "number", env: "VIGILE_BACKUP_KEEP", description: "How many automatic backups of each tenant are kept; older ones are removed" },
];

export const findSetting = (key: string): Setting | undefined => SETTINGS.find((s) => s.key === key);

export class ConfigError extends Error {
  constructor(
    readonly issues: string[],
    readonly path?: string,
  ) {
    super(`${path ? `${path}: ` : ""}${issues.join("; ")}`);
    this.name = "ConfigError";
  }
}

/**
 * The key the config has for a user, if it has one. Asked of what the config itself holds and of nothing else:
 * "constructor" is a name a user can have, and every object answers to it with something that is not a key.
 */
export const keyOf = (auth: Config["auth"], username: string): string | undefined => (Object.hasOwn(auth.keys, username) ? auth.keys[username] : undefined);

/** Rules that span several values, on top of what the schema checks one value at a time. */
function crossChecks(config: Config): string[] {
  const issues: string[] = [];
  if (!config.auth.keys.admin) issues.push('auth.keys.admin: the admin user must have an API key; run "vigile config init" or "vigile user reset-key admin"');
  if (config.auth.keyless_user === "admin") issues.push("auth.keyless_user: admin always needs a key, so it cannot be the keyless user");
  const seen = new Map<string, string>();
  for (const [username, key] of Object.entries(config.auth.keys)) {
    const other = seen.get(key);
    if (other) issues.push(`auth.keys.${username}: has the same key as ${other}; every user needs its own`);
    seen.set(key, username);
  }
  return issues;
}

/** Checks a config as read from TOML and fills in defaults. Throws `ConfigError` listing every problem. */
export function validateConfig(raw: unknown, path?: string): Config {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.flatMap((issue) => {
      const where = issue.path.join(".");
      if (issue.code === "unrecognized_keys") {
        return issue.keys.map((key) => `${where ? `${where}.` : ""}${key}: is not a setting`);
      }
      return [`${where || "config"}: ${issue.message}`];
    });
    throw new ConfigError(issues, path);
  }
  const issues = crossChecks(parsed.data);
  if (issues.length) throw new ConfigError(issues, path);
  return parsed.data;
}

/** Keys in the config for users that do not exist. Such a key lets nobody in; it is clutter, left by a delete whose last step failed or by a hand edit. */
export function staleKeys(config: Config, usernames: readonly string[]): string[] {
  return Object.keys(config.auth.keys).filter((username) => !usernames.includes(username));
}

/** Checks that need the stored users: every name in the config must be a real, live user. */
export function checkUsers(config: Config, usernames: readonly string[]): string[] {
  const issues = staleKeys(config, usernames).map((username) => `auth.keys.${username}: there is no user called ${username}`);
  if (config.auth.keyless_user && !usernames.includes(config.auth.keyless_user)) {
    issues.push(`auth.keyless_user: there is no user called ${config.auth.keyless_user}`);
  }
  return issues;
}
