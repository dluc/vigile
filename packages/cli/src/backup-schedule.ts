/** What a backup that is whole wrote. */
interface Written {
  /** How many copies were written: one for each tenant. */
  copies: number;
  bytes: number;
}

/**
 * How one backup ended, said once, by whoever settled what it wrote, for everything that has to go by it: the
 * log, the status the doctor reads, and when the next one is due. Either nothing of the backup remains, or all
 * of it does; which of the two is never left to be guessed from why it ended.
 *
 * - `incomplete`: it did not become whole, and nothing of it remains. With why, and what to do when that is known.
 * - `complete`: it is whole, and older backups were removed as they should be.
 * - `complete_retention_failed`: it is whole; older backups that should have gone are still there.
 * - `complete_unconfirmed`: it is whole and in place; the system could not confirm that it will survive a power
 *   cut. Older backups were not removed for it.
 * - `complete_unreported`: it is whole and in place; whatever wrote it ended without saying how it went, so
 *   whether older backups were removed is not known.
 */
export type BackupOutcome =
  | { kind: "incomplete"; reason: string; actions: string[] }
  | ({ kind: "complete"; removed: number } & Written)
  | ({ kind: "complete_retention_failed"; removed: number; notRemoved: string[] } & Written)
  | ({ kind: "complete_unconfirmed"; reason: string } & Written)
  | ({ kind: "complete_unreported"; reason: string | null } & Written);

/**
 * What a store offers so that its data can be backed up on a schedule. The schedule knows when a backup is due
 * and what to do when one fails; how a backup is written, where, and how many are kept is the store's own.
 */
export interface BackupSource {
  /** Completes asynchronous preparation; a scheduled check may create its destination, a status snapshot may not. */
  ready?(create: boolean): Promise<void>;
  /**
   * The moments of all the automatic backups there are that are whole, whatever their dates: also of those
   * dated after now, which do not count yet and will once the clock has come to them. Throws when they
   * cannot be known.
   */
  moments(): number[];
  /**
   * Takes a backup named after the moment, without holding up whoever asks. `done` ends when the backup is over:
   * nothing of it can touch what it wrote any more. It says how the backup ended, and does not fail for a
   * backup that did. `cancel` ends one that is under way, leaves nothing half-written, and returns when it is over.
   */
  take(at: number): { done: Promise<BackupOutcome>; cancel(): Promise<void> };
  /**
   * Takes no further backup, and lets go of whatever was held for taking them: at once when no backup is under
   * way, and otherwise only when the one under way is over. What is held is what keeps others from the place
   * the backups go to, for as long as a backup of this one's can still write or remove there. Ends when it
   * has let go.
   */
  close(): Promise<void>;
}

/**
 * What is kept of the last backup the service began, for the next run of the service: without it, a service
 * that is started again and again would try a backup that fails at every start, however long it is to wait
 * between two tries.
 */
export interface Remembered {
  /** Where the backup went. What is kept of a backup into another place says nothing of this one. */
  folder: string;
  /** The moment the backup is named after. */
  at: number;
  /** When it ended, by the clock of the machine; when it was begun, for one that has not ended. */
  ended: number;
  /** The machine's monotonic uptime when it ended, when written by a version that keeps it. */
  steady?: number;
  /** A shortened pause anchored at `ended` and `steady`, after an earlier machine uptime became incomparable. */
  wait?: number;
  /** How it ended: `begun` for one that has not, which is what a service that was killed leaves. */
  kind: BackupOutcome["kind"] | "begun";
  /** What was said of it, and for one that failed, what is to be done. */
  said: string | null;
  actions: string[];
}

/** What is there cannot be read as what the service keeps, with why. */
export interface Unreadable {
  unreadable: string;
}

/**
 * Where that is kept. `read` gives what was written last, null when nothing was, or that what is there cannot
 * be read. `write` replaces it, or removes it when given null. Written by one service only, the one that has
 * the place it is kept in.
 */
export interface BackupMemory {
  read(): Remembered | Unreadable | null;
  write(remembered: Remembered | null): void | Promise<void>;
  close?(): Promise<void>;
}

/**
 * How much the service keeps of a backup, at the most. What is written is held to these before it is written,
 * and what is read is held to the same: whatever the service writes, it reads again.
 */
export const REMEMBERED_MOST = {
  /** The whole of it, as it is written: a file larger than this is not read at all. */
  bytes: 64 * 1024,
  /** A folder's path. */
  folder: 4096,
  /** What was said of the backup, and each thing that is to be done. */
  text: 8192,
  /** How many things are to be done. */
  actions: 16,
};
/** The most that the service ever writes: a file larger than this is not read at all. */
export const REMEMBERED_MOST_BYTES = REMEMBERED_MOST.bytes;
const KINDS: ReadonlySet<string> = new Set<Remembered["kind"]>(["begun", "incomplete", "complete", "complete_retention_failed", "complete_unconfirmed", "complete_unreported"]);
const FIELDS_V1 = ["actions", "at", "ended", "folder", "kind", "said", "version"];
const FIELDS_V2 = ["actions", "at", "ended", "folder", "kind", "said", "steady", "version"];
const FIELDS_V3 = ["actions", "at", "ended", "folder", "kind", "said", "steady", "version", "wait"];
/** A moment a date can be made of and written out: a whole number of milliseconds within what a date holds. */
const isMoment = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= 8.64e15;
const isText = (value: unknown, most: number): value is string => typeof value === "string" && value.length <= most;

/**
 * A text made no longer than so many characters, the same way each time: its beginning, and after it how much
 * was left out. A character that is written as two is not cut in half.
 */
export function shortened(text: string, most: number): string {
  if (text.length <= most) return text;
  const mark = (left: number): string => `… (${left} more characters)`;
  let kept = Math.max(0, most - mark(text.length).length);
  if (kept > 0 && /[\ud800-\udbff]/.test(text[kept - 1]!)) kept--;
  const cut = `${text.slice(0, kept)}${mark(text.length - kept)}`;
  return cut.length <= most ? cut : text.slice(0, most);
}

/**
 * What the service keeps of a backup, as the text that is written: the one form `decodeRemembered` reads.
 * What was said of the backup and what is to be done are for the next run and for the doctor, and may be as
 * long as paths and the words of the system make them: they are shortened here to what is read again, and
 * further if the whole would be more than is ever written. Which backup it was, when, where to and how it
 * ended are never changed. Null when it cannot be written in a form that is read again: a folder whose path
 * is longer than any path, a moment no date can be made of.
 */
export function encodeRemembered(remembered: Remembered): string | null {
  const { folder, at, ended, kind } = remembered;
  if (!isText(folder, REMEMBERED_MOST.folder) || folder.length === 0 || !isMoment(at) || !isMoment(ended) || !KINDS.has(kind)) return null;
  const said = typeof remembered.said === "string" ? remembered.said : null;
  const actions = Array.isArray(remembered.actions) ? remembered.actions.filter((action): action is string => typeof action === "string") : [];
  // As long as it may be, then half of that, and so on, until the whole is no more than is ever written.
  for (let most = REMEMBERED_MOST.text; ; most = Math.floor(most / 2)) {
    const listed = actions.length > REMEMBERED_MOST.actions ? [...actions.slice(0, REMEMBERED_MOST.actions - 1), `(${actions.length - REMEMBERED_MOST.actions + 1} more)`] : actions;
    const version = remembered.wait === undefined ? remembered.steady === undefined ? 1 : 2 : 3;
    const bounded = { version, folder, at, ended, ...(remembered.steady === undefined ? {} : { steady: remembered.steady }), ...(remembered.wait === undefined ? {} : { wait: remembered.wait }), kind, said: said === null ? null : shortened(said, most), actions: listed.map((action) => shortened(action, most)) };
    const text = `${JSON.stringify(bounded)}\n`;
    if (Buffer.byteLength(text, "utf8") <= REMEMBERED_MOST.bytes && isRemembered(bounded)) return text;
    if (most === 0) return null;
  }
}

/**
 * Whether a value is what the service keeps of a backup, in every part: exactly its fields and no other, each
 * of its kind, the moments such that a date can be made of them, the texts no longer than the service writes.
 * Which of the two moments is the later is not asked: a clock that was set back while a backup was written
 * leaves its end before its beginning. Whatever is given, this answers and does not fail.
 */
export function isRemembered(value: unknown): value is Remembered {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const keys = Object.keys(value).sort();
    // Only what the value itself has, under exactly these names. What the service wrote also says which form it is.
    const own = (name: string): unknown => (Object.hasOwn(value, name) ? (value as Record<string, unknown>)[name] : undefined);
    const version = own("version");
    const hasVersion = Object.hasOwn(value, "version");
    const hasSteady = Object.hasOwn(value, "steady");
    const hasWait = Object.hasOwn(value, "wait");
    const fields = version === 3 || (!hasVersion && hasWait)
      ? (hasVersion ? FIELDS_V3 : FIELDS_V3.filter((name) => name !== "version"))
      : version === 2 || (!hasVersion && hasSteady) ? (hasVersion ? FIELDS_V2 : FIELDS_V2.filter((name) => name !== "version")) : hasVersion ? FIELDS_V1 : FIELDS_V1.filter((name) => name !== "version");
    if (keys.length !== fields.length || keys.some((key, i) => key !== fields[i])) return false;
    if (Object.hasOwn(value, "version") && version !== 1 && version !== 2 && version !== 3) return false;
    const actions = own("actions");
    return (
      isText(own("folder"), REMEMBERED_MOST.folder) &&
      (own("folder") as string).length > 0 &&
      isMoment(own("at")) &&
      isMoment(own("ended")) &&
      (version !== 2 && version !== 3 && !hasWait || (typeof own("steady") === "number" && Number.isFinite(own("steady")) && (own("steady") as number) >= 0)) &&
      (version !== 3 && !hasWait || (typeof own("wait") === "number" && Number.isFinite(own("wait")) && (own("wait") as number) >= 0)) &&
      typeof own("kind") === "string" &&
      KINDS.has(own("kind") as string) &&
      (own("said") === null || isText(own("said"), REMEMBERED_MOST.text)) &&
      Array.isArray(actions) &&
      actions.length <= REMEMBERED_MOST.actions &&
      actions.every((action) => isText(action, REMEMBERED_MOST.text))
    );
  } catch {
    return false;
  }
}

/**
 * What a text says the service kept, or null when the text is not what the service writes: no JSON, JSON of
 * another shape, or more than the service writes. Whatever the text, this answers and does not fail. A name
 * given twice in the text counts as JSON has it, by the last.
 */
export function decodeRemembered(text: string): Remembered | null {
  if (typeof text !== "string" || text.length > REMEMBERED_MOST.bytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRemembered(value) || !Object.hasOwn(value, "version")) return null;
  // Made anew, of exactly the fields there are.
  return { folder: value.folder, at: value.at, ended: value.ended, ...(value.steady === undefined ? {} : { steady: value.steady }), ...(value.wait === undefined ? {} : { wait: value.wait }), kind: value.kind, said: value.said, actions: [...value.actions] };
}

/** Time left in the restart-stable pause after a remembered attempt. */
export function rememberedWait(kept: Remembered | null, folder: string, wall: number, steady: number, pause: number): number {
  if (!kept || kept.folder !== folder) return 0;
  const elapsed = kept.steady !== undefined && steady >= kept.steady ? steady - kept.steady : Math.max(0, wall - kept.ended);
  return Math.max(0, Math.min(pause, kept.wait ?? pause) - elapsed);
}

/** When the schedule looks at its clock. */
export const BACKUP_TIMES = {
  /** How long after the service is up the first look is taken: a backup that is due at the start is taken then. */
  firstMs: 10_000,
  /** How often it looks whether a backup is due. Never one long wait: a machine that slept would wake to a timer that is hours late. */
  checkMs: 30_000,
  /** How long after a backup that failed the next one is tried, when that is sooner than the usual interval. */
  retryMs: 10 * 60_000,
  /** How long a stop waits for a backup under way to end. A copy to a disk that does not answer must not keep the service from stopping. The store keeps what it holds until that backup is over. */
  stopMs: 5_000,
};

export interface BackupStatus {
  enabled: boolean;
  every_hours: number;
  folder: string;
  keep: number;
  /** When the newest automatic backup that is whole, and not dated after now, was taken, or null when there is none. */
  last_at: string | null;
  /**
   * When the next one is due, as the clock of the machine now has it, or null when automatic backups are off:
   * the earliest instant at which a look would begin one (`Standing.startWall`), or, for one that a look would
   * begin now, since when it has been due. Worked out anew each time it is asked for, by the same reckoning
   * that decides what a look does: what the schedule keeps is never a date.
   */
  next_due: string | null;
  running: boolean;
  /**
   * The last try, when it failed. Null again once a backup is taken. `retry_at` is the earliest instant at
   * which a look would begin the next try (`Standing.startWall`): not before the wait after the failure is
   * over, and not while a backup that is there is less than an interval old.
   */
  failure: { at: string; reason: string; actions: string[]; retry_at: string } | null;
  /** How the last backup of this run ended, and what was said of it when that was anything but that it was taken. Null when none has ended yet. */
  outcome: { at: string; kind: BackupOutcome["kind"]; said: string | null } | null;
  /**
   * Why the backups there are could not be looked at just now, or null when they could. When they could not,
   * the last backup given is the one this run took last, if it took one, and nothing else is known.
   */
  unread: string | null;
}

export interface BackupSchedule {
  status(): BackupStatus;
  /** Waits for asynchronous store preparation and refreshes what is known, without taking a backup. */
  ready(): Promise<void>;
  /** Looks whether a backup is due and takes it if so; ends when it is taken or has failed. The timer calls this. */
  check(): Promise<void>;
  /** Takes no further backup and ends the one under way. Returns when that one is over, or after a while without it. */
  stop(): Promise<void>;
  /** Ends when, after a stop, nothing of a backup is left at work and what was held for backups is let go. */
  over(): Promise<void>;
}

export interface BackupScheduleOptions {
  everyHours: number;
  folder: string;
  keep: number;
  /** Nothing to take backups from means that automatic backups are off. */
  source: BackupSource | null;
  /** Where the last backup that was begun is kept over a restart. Without one, each run begins as if none had been. */
  memory?: BackupMemory | null;
  /** The clock of the machine, in UTC: names a backup, and says how old one is. It can be set, forward and back. */
  now(): number;
  /** A clock that only goes forward, by the time that has passed: every wait of the schedule is counted on it. */
  monotonic(): number;
  times: typeof BACKUP_TIMES;
  log(line: string): void;
  warn(line: string): void;
}

const iso = (moment: number): string => new Date(moment).toISOString();

/** Where the schedule stands at one instant: everything that is done and everything that is said comes from this. */
export interface Standing {
  /** The newest whole backup that is not dated after now, or null. */
  last: number | null;
  /** Whether a backup is due by that: there is none, or it is an interval old. */
  due: boolean;
  /** How long, of time that passes, no backup may be begun yet. */
  waitMs: number;
  /** Whether a backup is begun at a look now: one is due, and none has to be waited for. */
  mayAttempt: boolean;
  /** When one became due, or becomes due, by the last backup alone: now when there is none. In the past for one that is due. */
  dueWall: number;
  /**
   * The earliest instant, on the clock of the machine as it stands, at which a backup would be begun if both
   * clocks went on together and the backups stayed as they are: now when one may be begun now. Never before
   * the wait is over, never while a backup is less than an interval old, also one that is dated after now
   * and counts by then.
   */
  startWall: number;
}

/**
 * Where the schedule stands, from the two clocks, the moments of the whole backups there are, the time
 * before which no backup is begun, and the interval. Nothing else decides whether a look begins a backup, and
 * nothing else says when the next one is due or when one that failed is tried again: what is said is what
 * would be done.
 */
export function standing(input: { wall: number; mono: number; moments: readonly number[]; notBefore: number | null; everyMs: number }): Standing {
  const { wall, mono, moments, notBefore } = input;
  const everyMs = Math.ceil(input.everyMs);
  const sorted = [...moments].sort((a, b) => a - b);
  /** The place, among them in order, of the newest that is not after the instant looked at; -1 when there is none. */
  let newest = -1;
  const upTo = (at: number): void => {
    while (newest + 1 < sorted.length && sorted[newest + 1]! <= at) newest++;
  };
  upTo(wall);
  const last = newest < 0 ? null : sorted[newest]!;
  const due = last === null || wall - last >= everyMs;
  const waitMs = notBefore === null ? 0 : Math.max(0, notBefore - mono);
  // From when the wait is over, on to the first instant at which the newest backup by then is an interval old.
  // Each step moves on to an interval after a later backup, of which there are only so many.
  let startWall = wall + waitMs;
  upTo(startWall);
  while (newest >= 0 && startWall - sorted[newest]! < everyMs) {
    startWall = sorted[newest]! + everyMs;
    upTo(startWall);
  }
  return { last, due, waitMs, mayAttempt: due && waitMs === 0, dueWall: last === null ? wall : last + everyMs, startWall };
}

/** How often, in words: "every 24 hours", "every hour", "every 0.5 hours". */
export const everyHours = (hours: number): string => (hours === 1 ? "every hour" : `every ${hours} hours`);

/** A reason as a sentence: with a full stop when it has none. */
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * Has a backup taken whenever the newest one is one interval old. A backup that fails is said once, with why
 * and what to do, and tried again after a shorter while; the service goes on meanwhile.
 *
 * Two clocks, each for what it can be trusted with. The clock of the machine, in UTC, names a backup and says
 * how old a backup is; it can be set forward and back, and nothing here waits for a date on it. Every wait is
 * counted on a clock that only goes forward, by the time that has passed. What is kept between two looks is
 * therefore not a date:
 *
 * - nothing of the backups there are. Their moments, those dated after now among them, are asked of the
 *   store each time the schedule looks or is asked where it stands: the folder says what backups there are,
 *   and a backup that was removed, by the next one making room or by hand, is no backup here either. So the
 *   schedule goes on over a restart as within a run: a start does not take a backup when a fresh one is
 *   there, and restarts do not put the next one off. Only when the store cannot say does the schedule go by
 *   the one backup it took last itself, and it says that it does.
 * - `notBefore`: after a backup has ended, however it ended, the time on the forward clock before which no
 *   other is begun: ten minutes, or the interval if that is shorter. After one that failed this is the wait
 *   before the next try. After one that was taken it only keeps a clock that is set back again and again
 *   from having a backup taken at every look.
 *
 * Where the schedule stands at any instant is worked out from those and the two clocks, in one place
 * (`standing`): whether a backup is due, whether one may be begun, and when the earliest instant is at which
 * one would be. A look begins a backup when that says it may, after the folder has been asked once more, as
 * a start would ask it. What is reported, when the next is due and when one that failed is tried again, is
 * the same reckoning at the instant it is asked for.
 *
 * Over a restart: `notBefore` is taken from what the run before kept of the backup
 * it began last (`Remembered`), which is written before a backup is begun and again when it has ended. A run
 * that starts within the wait of a backup that ended, or was begun and never ended because the service was
 * killed, waits what is left of it: what is left is the wait less the time since, by the clock of the machine,
 * never more than the whole wait and never less than nothing. A date that lies after now, as after a clock set
 * back, leaves the whole wait and no more. What was kept of a backup that failed is the failure of this run
 * too, until a backup is taken. A backup that a stop cut short is forgotten: it did not fail. What cannot be
 * read is said, counts as a backup that has just ended, and is written anew by the next one.
 *
 * So: a clock moved forward, by any length, makes one backup due. A clock moved back never puts one off: no
 * wait hangs on a date, before the first backup, after one that failed, or after one that was taken; what was
 * taken before now still counts, what is dated after now does not, and a backup is due at once when nothing
 * is left that counts. A machine that slept wakes to one backup. Moments are in UTC, so a change of time zone
 * changes nothing.
 */
export function startBackups(options: BackupScheduleOptions): BackupSchedule {
  const { source, now, monotonic, times, log, warn } = options;
  const memory = options.memory ?? null;
  const everyMs = Math.ceil(options.everyHours * 3_600_000);
  /** How long no backup is begun after one has ended. */
  const pause = Math.min(times.retryMs, everyMs);
  const settings = { every_hours: options.everyHours, folder: options.folder, keep: options.keep };
  if (!source) {
    return {
      status: () => ({ enabled: false, ...settings, last_at: null, next_due: null, running: false, failure: null, outcome: null, unread: null }),
      ready: async () => {},
      check: async () => {},
      stop: async () => {},
      over: async () => {},
    };
  }

  /** The moment of the last backup this run took, which was whole when it ended: all that is known when the backups cannot be looked at. */
  let taken: number | null = null;
  /** Why the backups could not be looked at the last time they were, or null. */
  let unread: string | null = null;
  /**
   * The moments of the whole backups there are, as the store has them now. Asked each time it matters and
   * kept nowhere: what was removed, by the backup that made room, by hand or by anyone, is gone from here as
   * well, and what was put there counts. When the store cannot say, the one backup this run is sure of.
   */
  const read = (): number[] => {
    try {
      const moments = source.moments().filter((moment) => Number.isFinite(moment));
      unread = null;
      return moments;
    } catch (error) {
      // Why they cannot be known is also what the next backup fails with, and is said then.
      unread = sentence((error instanceof Error ? error.message : String(error)).slice(0, 500));
      return taken === null ? [] : [taken];
    }
  };
  /** The clock of the machine when the schedule began: what was kept by the run before is measured against it. */
  const seen = now();
  const steadySeen = monotonic();
  // Looked at once now, at the start: the store takes its place for this run, and clears what a run that was
  // killed left there. Why it cannot is said by the first backup, which fails with it.
  read();
  let notBefore: number | null = null;
  let failure: Omit<NonNullable<BackupStatus["failure"]>, "retry_at"> | null = null;
  let outcome: BackupStatus["outcome"] = null;
  let current: { done: Promise<BackupOutcome>; cancel(): Promise<void> } | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;
  let gone: Promise<void> | null = null;

  // What the run before this one kept of the last backup it began.
  // Whatever is there, and whatever the reading of it does: the service is up by now, and this does not fail.
  // What cannot be read, or is not in every part what the service keeps, is said once and counts as a backup
  // that has just ended.
  let kept: Remembered | null = null;
  let unreadable: string | null = null;
  let reanchor: Remembered | null = null;
  try {
    const read = memory?.read() ?? null;
    if (isRemembered(read)) kept = read;
    else if (read !== null) unreadable = typeof (read as Partial<Unreadable>).unreadable === "string" ? (read as Unreadable).unreadable.slice(0, 500) : "it is not what the service writes";
  } catch (error) {
    unreadable = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  }
  if (unreadable !== null) {
    notBefore = steadySeen + pause;
    warn(`What the service kept of its last automatic backup cannot be read: ${sentence(unreadable)} No backup is begun before ${iso(seen + pause)}, as after one that has just ended; the pause is kept anew.`);
  }
  if (kept && kept.folder === options.folder) {
    const uptimeRestarted = kept.steady !== undefined && steadySeen < kept.steady;
    const left = rememberedWait(kept, options.folder, seen, steadySeen, pause);
    if (left > 0) {
      notBefore = steadySeen + left;
      if (uptimeRestarted) reanchor = { ...kept, ended: seen, steady: steadySeen, wait: left };
    }
    if (kept.kind === "incomplete") failure = { at: iso(kept.at), reason: kept.said ?? "It failed.", actions: kept.actions };
    if (kept.kind.startsWith("complete")) taken = kept.at;
    if (kept.kind !== "begun") outcome = { at: iso(kept.at), kind: kept.kind, said: kept.said };
  }
  /** Keeps it for the next run. That it cannot be kept is said once, and changes nothing about this run. */
  let unkept = false;
  const remember = async (remembered: Remembered | null): Promise<void> => {
    try {
      await memory?.write(remembered);
      unkept = false;
    } catch (error) {
      if (!unkept) warn(`What the service keeps of its last automatic backup could not be written: ${sentence(error instanceof Error ? error.message : String(error))} A service started again soon may try a backup sooner than it should.`);
      unkept = true;
    }
  };
  // Replace malformed state immediately with the same restart-stable anchor used for a backup that began now.
  // `ready` waits for this write, so a restart during the recovery pause waits only what remains of it.
  const recoveredMemory = unreadable === null
    ? reanchor ? remember(reanchor) : Promise.resolve()
    : remember({ folder: options.folder, at: seen, ended: seen, steady: steadySeen, kind: "begun", said: null, actions: [] });

  /**
   * Where the schedule stands now, for a look and for whoever asks, from the backups as they are in the folder
   * at this instant: what a look then does is what was said, and the last backup given is one that is there.
   */
  const where = (): Standing & { wall: number } => {
    const wall = now();
    return { ...standing({ wall, mono: monotonic(), moments: read(), notBefore, everyMs }), wall };
  };

  async function attempt(at: number): Promise<void> {
    const began = Date.now();
    let ended: BackupOutcome;
    // Kept before it is begun: a service that is killed while it is written, or by it, has begun one.
    await remember({ folder: options.folder, at, ended: at, steady: monotonic(), kind: "begun", said: null, actions: [] });
    if (stopped) return;
    try {
      current = source!.take(at);
      ended = await current.done;
    } catch (error) {
      // A store that fails instead of saying how the backup ended: nothing is known to be there.
      const hints = (error as { hints?: unknown }).hints;
      ended = { kind: "incomplete", reason: error instanceof Error ? error.message : String(error), actions: Array.isArray(hints) ? (hints as string[]) : [] };
    } finally {
      current = null;
    }
    notBefore = monotonic() + pause;
    // What is kept is written by a service that runs, which has the place it is kept in. One that has stopped
    // has forgotten the backup it cut short, at its stop, and writes nothing any more.
    const keep = async (said: string | null, actions: string[]): Promise<void> => {
      if (!stopped) await remember({ folder: options.folder, at, ended: now(), steady: monotonic(), kind: ended.kind, said, actions });
    };

    if (ended.kind === "incomplete") {
      const reason = sentence(ended.reason);
      outcome = { at: iso(at), kind: ended.kind, said: reason };
      // A backup that was cut short by the service stopping has not failed.
      if (stopped) return;
      const actions = ended.actions.length
        ? ended.actions
        : [`Check that ${options.folder} is there or can be created, that the account the service runs as can write to it, and that its disk has room. Or choose another folder: vigile config set backup.folder <folder>, then restart the service.`];
      failure = { at: iso(at), reason, actions };
      await keep(reason, actions);
      warn(`The automatic backup into ${options.folder} failed: ${reason} ${actions.join(" ")} It is tried again at ${iso(where().startWall)}; the service goes on meanwhile.`);
      return;
    }

    // It is whole and in place, whatever else is to be said of it: the schedule goes by it.
    const recovered = failure !== null;
    taken = at;
    failure = null;
    const said =
      ended.kind === "complete_retention_failed"
        ? `The automatic backup was taken, but ${ended.notRemoved.length === 1 ? "an older one" : `${ended.notRemoved.length} older ones`} could not be removed: ${ended.notRemoved.join("; ")}. Remove them by hand, or give the account the service runs as write access to ${options.folder}.`
        : ended.kind === "complete_unconfirmed"
          ? `The automatic backup into ${options.folder} was taken and is whole, but it is not confirmed: ${sentence(ended.reason)} Older backups were not removed this time.`
          : ended.kind === "complete_unreported"
            ? `The automatic backup into ${options.folder} is whole and in place, but what wrote it ended without reporting how it went${ended.reason ? ` (${ended.reason.replace(/[.!?]$/, "")})` : ""}. Whether older backups were removed is not known; the next backup removes them.`
            : null;
    outcome = { at: iso(at), kind: ended.kind, said };
    await keep(said, []);
    if (stopped) return;
    const result = ended.kind === "complete" ? "ok" : ended.kind.slice("complete_".length);
    log(`${iso(Date.now())} backup=automatic result=${result} copies=${ended.copies} kb=${Math.ceil(ended.bytes / 1024)} removed=${"removed" in ended ? ended.removed : 0} ms=${Date.now() - began} folder=${options.folder}`);
    if (recovered) warn(`Automatic backups work again: one was taken into ${options.folder}.`);
    if (said) warn(said);
  }

  const check = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      await recoveredMemory;
      // Refresh asynchronously without creating the destination. Do not create or take it while the schedule
      // itself says no attempt may begin yet.
      await source.ready?.(false);
      if (stopped || !where().mayAttempt) return;
      await source.ready?.(true);
      if (stopped) return;
      const stands = where();
      if (stands.mayAttempt) await attempt(stands.wall);
    })().finally(() => (running = null));
    return running;
  };

  const ready = async (): Promise<void> => {
    await recoveredMemory;
    await source.ready?.(false);
    read();
  };

  // A first look a little after the start, then one every so often. Neither timer keeps the process alive when
  // everything else has ended.
  let every: NodeJS.Timeout | undefined;
  const first = setTimeout(() => {
    void check();
    every = setInterval(() => void check(), times.checkMs);
    every.unref();
  }, times.firstMs);
  first.unref();

  return {
    status: () => {
      const stands = where();
      return {
        enabled: true,
        ...settings,
        last_at: stands.last === null ? null : iso(stands.last),
        // Since when it has been due, for one that the next look begins; otherwise the instant a look would begin one.
        next_due: iso(stands.mayAttempt ? stands.dueWall : stands.startWall),
        running: running !== null,
        failure: failure && { ...failure, retry_at: iso(stands.startWall) },
        outcome,
        unread,
      };
    },
    ready,
    check,
    async stop() {
      stopped = true;
      clearTimeout(first);
      clearInterval(every);
      // Keep the begun record when this stop cuts a backup short. It is not reported as a failure, and it keeps
      // the minimum interval between attempts across a graceful restart just as it does across an abrupt one.
      // The backup under way is ended, and what it had written so far is cleared. Should it not end in time, the
      // stop goes on without it. The store is told to let go either way, and does so only when the backup is over:
      // until then nobody else may have the place it writes to.
      const under = current;
      const ended = (async () => {
        await under?.cancel();
        await running;
      })();
      let waited: NodeJS.Timeout | undefined;
      try {
        await Promise.race([ended, new Promise((resolve) => (waited = setTimeout(resolve, times.stopMs)))]);
      } finally {
        clearTimeout(waited);
        // Whatever becomes of it later, nobody is left to hear it.
        ended.catch(() => {});
        const sourceGone = source.close().catch(() => {});
        const memoryGone = memory?.close?.().catch(() => {}) ?? Promise.resolve();
        gone ??= Promise.all([sourceGone, memoryGone]).then(() => {});
      }
    },
    over: () => gone ?? Promise.resolve(),
  };
}
