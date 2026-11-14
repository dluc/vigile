/**
 * The parts of the board that are plain reckoning: what a task's card shows, and where a card is while it is in
 * the strip of a collapsed column. They touch nothing of the page, so they hold for a task that has no card on
 * it, and are tested without a browser as well as in one.
 */

/** Whether a task is a bug, an issue or an incident: anything but a plain task. */
export const isTrouble = (task) => task.type !== "task";

/** The first few of a list, then how many more there are, so one card never grows without limit. */
const few = (items, shown = 3) => (items.length > shown ? [...items.slice(0, shown), `+${items.length - shown} more`] : items);

/** A container as a short chip: a numbered project is written without its kind. */
const chip = (ref) => ref.replace(/^project:/, "");

/**
 * What a task's card shows, as plain values: its marks, the line at its top, its title and its tags, each tag
 * with its kind, its text and what it says under the pointer. The card is drawn from these values and from
 * nothing else, so whatever a card shows, now or later, is in here. `context` is what a card goes by besides its
 * task: `byId`, the tasks of the plan by their IDs; `project`, the project the page is narrowed to, whose name
 * the cards then leave out; and `watched`, the tasks that are watched in this tab.
 */
export function cardModel(task, { byId, project, watched }, inside = null) {
  const holders = task.live_containers ?? task.contained_in;
  const groups = holders.filter((ref) => byId.has(ref));
  const projects = holders.filter((ref) => !byId.has(ref));
  const trouble = isTrouble(task);
  const progress = task.progress ?? (inside ? { finished: inside.finished, total: inside.total } : null);
  const tag = (kind, text, title, tone) => ({ kind, text, ...(title === undefined ? {} : { title }), ...(tone === undefined ? {} : { tone }) });
  return {
    id: task.id,
    status: task.status,
    marks: [task.has_problems && "problem", trouble && "trouble", progress && "is-group", inside && "closed"].filter(Boolean),
    type: trouble ? task.type : null,
    priority: task.priority !== 0 ? { text: `P${task.priority}`, high: task.priority >= 5 } : null,
    title: task.title,
    ...(inside
      ? {
          closed: true,
          progress: { ...progress, percent: progress.total ? Math.round((progress.finished / progress.total) * 100) : 0 },
          completed_at: task.completed_at ?? "",
        }
      : {}),
    tags: [
      progress && tag("group", `${progress.finished}/${progress.total} done`, "Tasks finished inside this group"),
      inside?.matching > 0 && tag("match", `${inside.matching} inside ${inside.matching === 1 ? "matches" : "match"}`, "Tasks inside this group that match the filter"),
      inside?.busy > 0 && tag("inside", `${inside.busy} in progress`, "Tasks inside this group that are in progress", "busy"),
      inside?.waiting > 0 && tag("inside", `${inside.waiting} waiting`, "Tasks inside this group that wait for dependencies", "wait"),
      inside?.problems > 0 && tag("warn", `⚠ ${inside.problems} ${inside.problems === 1 ? "problem" : "problems"} inside`, "Tasks inside this group that have problems"),
      inside?.trouble > 0 && tag("trouble", `${inside.trouble} open ${inside.trouble === 1 ? "bug or issue" : "bugs and issues"}`, "Unfinished bugs, issues and incidents inside this group"),
      watched.has(task.id) && tag("watched", "watching", "You are watching this task: a sound plays when it is done"),
      ...few(task.assigned_to).map((user) => tag("who", user)),
      task.is_waiting && tag("waiting", `waits for ${few(task.waiting_for.map(chip)).join(", ")}`, task.waiting_for.map(chip).join(", ")),
      task.has_problems && tag("warn", "⚠ problem"),
      ...few(groups).map((id) => tag("", `in ${id}`, byId.get(id)?.title ?? "")),
      ...(project ? [] : few(projects.map(chip)).map((id) => tag("", id))),
    ].filter(Boolean),
  };
}

/**
 * What a task's card shows, as one text. Two texts that differ are two cards that differ, and the other way
 * round: a refresh that changes it rings the card, or the strip of the collapsed column that holds the task.
 */
export const cardSignature = (task, context, inside = null) => JSON.stringify(cardModel(task, context, inside));

/** The least a card shrinks to in a strip, of its own size: smaller, it could not be seen going in. */
const LEAST = 0.1;

/**
 * Where a card is while it is in the strip of a collapsed column. `card` is the card's box at its own size, where
 * it sets off from or where it lands, and `room` the strip's box; each has `left`, `top`, `width` and `height`.
 * Shrunk around its middle by the `scale` given back, the card fits the strip, and its middle is as near to where
 * it was as the strip allows: level with the card on a strip that is tall, under or over it on a bar that lies
 * across. The box given back is the card's at its own size around that middle, so the way from one box to the
 * other takes the middle of the card to a point of the strip, whatever the sizes of the two.
 */
export function inStrip(card, room) {
  const size = (length) => (Number.isFinite(length) && length > 0 ? length : 0);
  const [width, height, across, down] = [size(card.width), size(card.height), size(room.width), size(room.height)];
  const fits = (space, length) => (length > 0 ? space / length : 1);
  const scale = Math.max(LEAST, Math.min(1, fits(across, width), fits(down, height)));
  // The middle of the shrunk card stays inside the strip with the whole of the shrunk card where that fits, and
  // is the middle of the strip where it does not.
  const within = (middle, start, space, length) => (length >= space ? start + space / 2 : Math.min(Math.max(middle, start + length / 2), start + space - length / 2));
  const x = within(card.left + width / 2, room.left, across, width * scale);
  const y = within(card.top + height / 2, room.top, down, height * scale);
  return { left: x - width / 2, top: y - height / 2, width, height, scale };
}

/**
 * What a reading of the plan changed on the board, told from the board as it was before and as it is after. A
 * board is given as it stands whether or not a card is drawn for each task: `scope` is what it is narrowed to,
 * `context` what its cards go by, and `tasks` every task on it by its ID, each with its `column`. `collapsed`
 * says of a column whether it is collapsed.
 *
 * `cards` are the tasks whose cards are to be ringed: a task that is new on the board, one that is in another
 * column, one whose card shows something else. It makes no difference whether a card is drawn for the task now:
 * the mark is kept, and a card that is drawn for it in time is ringed. `strips` are the collapsed columns whose
 * strips are to be ringed: for a task that came, one that would show something else, and one that left, whether
 * it went to another column or off the board. A task that is gone from the board gets no mark of its own.
 *
 * A board that is narrowed to something else than it was is another board: nothing on it is news of the plan.
 */
export function boardChanges(before, now, collapsed) {
  const [cards, strips] = [new Set(), new Set()];
  if (before.scope !== now.scope) return { cards, strips };
  const strip = (column) => collapsed(column) && strips.add(column);
  for (const [id, { task, column }] of now.tasks) {
    const was = before.tasks.get(id);
    if (was && was.column === column && cardSignature(was.task, before.context, was.closed) === cardSignature(task, now.context, now.tasks.get(id).closed)) continue;
    cards.add(id);
    strip(column);
    if (was && was.column !== column) strip(was.column);
  }
  for (const [id, was] of before.tasks) if (!now.tasks.has(id)) strip(was.column);
  return { cards, strips };
}

/**
 * The marks of what a reading of the plan changed: a ring on a card, or on the strip of a collapsed column. A
 * mark belongs to the board it was made on, which `scope` names: the board as it is narrowed to a project, a
 * group, a filter. On a board that is narrowed to anything else the mark is not there, and it does not come back
 * with the board it was made on: what a person does to the page makes no mark and brings none back. `marks`
 * holds, under the ID of a task or the name of a column's strip, the moment it was marked and the scope.
 */
export function setMarks(marks, names, at, scope) {
  for (const name of names) marks.set(name, { at, scope });
}

/** The moment something was marked on the board that `scope` names, or nothing when it has no mark there. */
export function markedAt(marks, name, scope) {
  const mark = marks.get(name);
  return mark && mark.scope === scope ? mark.at : undefined;
}

/**
 * Forgets the marks that no longer count: those whose time is up, and those that `counts` says are of nothing
 * that is there any more, as the mark of a task that left the board. `at` is the moment now and `lasts` how long
 * a mark lasts. What is left is never more than what is there to be marked.
 */
export function forgetMarks(marks, at, lasts, counts) {
  for (const [name, mark] of marks) if (at - mark.at >= lasts || !counts(name)) marks.delete(name);
}
