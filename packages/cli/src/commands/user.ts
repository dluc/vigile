import { resolve } from "node:path";
import { UnconfirmedWrite, generateKey, keyOf, loadConfig, readRaw, setKey } from "@vigile/config";
import { areTexts, isRecord, keyRefused, notAsVigile, showing, usersOf } from "../answers.js";
import { configPath, flag, type Args } from "../args.js";
import { ANSWER_WITHIN_MS, NoAnswerError } from "../client.js";
import { accepted } from "../expected.js";
import { connect, inTheServicesPlace } from "../reach.js";
import { printable } from "../render.js";
import { dim, fields, note, table, type Ui } from "../ui.js";
import { builtin, given, notOneOf, oneOf } from "./builtin.js";

/** The settings an MCP client needs to connect as a user. */
function mcpSettings(url: string, key: string | undefined): string {
  const server: Record<string, unknown> = { type: "http", url };
  if (key) server.headers = { Authorization: `Bearer ${key}` };
  return JSON.stringify({ mcpServers: { vigile: server } }, null, 2);
}

function showKey(ui: Ui, username: string, key: string, base: string, created: boolean, warning?: string): void {
  ui.out();
  note(ui, "ok", created ? `User ${username} created` : `${username} has a new API key; the old one no longer works`);
  if (warning) note(ui, "warn", warning);
  ui.out();
  fields(ui, [
    ["Username", username],
    ["API key", key],
    ["MCP URL", `${base}/mcp`],
  ]);
  ui.out();
  ui.out(`  ${dim(ui, "Paste this into the agent's MCP configuration:")}`);
  ui.out();
  for (const line of mcpSettings(`${base}/mcp`, key).split("\n")) ui.out(`  ${line}`);
  ui.out();
  ui.out(`  ${dim(ui, "The key is stored in the config file and applies at once, without a restart.")}`);
  ui.out();
}

/** Whether the file lacks an admin key and nothing else keeps it from being read. */
function lacksAdminKey(path: string): boolean {
  try {
    const keys = (readRaw(path) as { auth?: { keys?: Record<string, unknown> } }).auth?.keys;
    return !(typeof keys?.admin === "string" && keys.admin);
  } catch {
    // Not a config that a key would repair: the ordinary path says what is wrong with it.
    return false;
  }
}

/**
 * Writes a new admin key straight to the config file and hands it over. A key that is in the file although the
 * system could not confirm that the file will survive a power cut is handed over too, with that said: it is
 * the admin key from now on, and withholding it would leave nobody able to reach the service.
 */
function writeAdminKey(ui: Ui, path: string, json: boolean): void {
  const key = generateKey();
  let warning: string | undefined;
  try {
    setKey(path, "admin", key);
  } catch (error) {
    if (!(error instanceof UnconfirmedWrite)) throw error;
    warning = error.message;
  }
  if (json) return ui.out(JSON.stringify({ user: { username: "admin" }, api_key: key, written_to: path, ...(warning ? { warning } : {}) }, null, 2));
  ui.out();
  note(ui, "ok", "admin has a new API key, written straight to the config file");
  fields(ui, [["API key", key]]);
  if (warning) note(ui, "warn", warning);
  ui.out(`    ${dim(ui, "A running service takes it up at once.")}`);
  ui.out();
}

/**
 * A call that got no answer, with what that means for the command that made it. The service carries out what it
 * took also after the connection has ended, and possibly after what was sent later: the command line does
 * nothing in its place, and says nothing of a second try that does not hold in whatever order the two are
 * carried out. When the request is over is said with every call that got no answer, where failures are reported.
 */
function unanswered(error: unknown, advice: string[]): unknown {
  if (error instanceof NoAnswerError && error.change) error.advice = advice;
  return error;
}

/** How long the service is given to answer is a parameter for the tests, and so is what is called once the data folder is held for a write in the service's place. */
export async function user(args: Args, ui: Ui, answerWithinMs = ANSWER_WITHIN_MS, taken?: () => unknown): Promise<void> {
  const action = args.words.shift();
  oneOf("user", action);
  const json = flag(args, "json");
  const path = resolve(configPath(args));
  // A config without an admin key does not pass the check, and the message it gives says to run this very
  // command. So for this one command the file is repaired first, and checked as a whole when it is written.
  // This is done whether or not a service runs, on purpose: no service can be asked without an admin key, no
  // key that works is cancelled by it, since the file has none, and a service that runs takes the new one up.
  if (action === "reset-key" && args.words[0] === "admin" && lacksAdminKey(path)) {
    given(builtin("user reset-key"), args);
    writeAdminKey(ui, path, json);
    return;
  }
  const loaded = loadConfig(path);
  // Asked for by the command that is about to call the service, and not before: what is not a command says so
  // without a service. Who answers is made sure of first, before the admin key goes out for anything, a reading
  // included.
  const service = () => connect(loaded, "admin", answerWithinMs);

  switch (action) {
    case "list": {
      given(builtin("user list"), args);
      const client = await service();
      const users = usersOf(client.base, await client.call("list_users"));
      const { auth } = loadConfig(path).config;
      // A key in the config lets its user in only if it was issued for that user: the service says which keys
      // it refuses on that ground.
      // That it could not be asked is not that it refuses none: a failure to answer, or a refusal, is reported.
      const status: unknown = await client.get("/api/admin/status");
      // A service from before it said which keys it refuses says nothing of them, and refuses none: its status
      // has no "auth", or an "auth" without that list. A status of any other shape says nothing to go by.
      const live = isRecord(status) ? (status.auth ?? {}) : undefined;
      const others = isRecord(live) ? (live.keys_of_someone_else ?? []) : undefined;
      if (!areTexts(others)) {
        throw notAsVigile(client.base, "GET /api/admin/status", !isRecord(status) ? "the answer is not an object" : !isRecord(live) ? '"auth" is not an object' : '"auth.keys_of_someone_else" is not a list of texts');
      }
      const refused = new Set<string>(others);
      const rows = users.map((u) => ({
        ...u,
        access: keyOf(auth, u.username) && !refused.has(u.username) ? "API key" : auth.keyless_user === u.username ? "no key needed" : "cannot connect",
        ...(refused.has(u.username) ? { key_refused: true } : {}),
      }));
      showing(ui, client.base, "POST /api/list-users", (page) => {
        if (json) return page.out(JSON.stringify(rows, null, 2));
        const shown = printable(rows);
        page.out();
        table(page, shown, [
          { title: "ID", value: (u) => u.id, style: () => "cyan" },
          { title: "USERNAME", value: (u) => u.username },
          { title: "TYPE", value: (u) => u.type },
          { title: "CONNECTS WITH", value: (u) => u.access, style: (u) => (u.access === "cannot connect" ? "yellow" : undefined) },
        ]);
        page.out();
        if (auth.keyless_user) page.out(`  ${dim(page, `A connection without a key acts as ${auth.keyless_user}.`)}`);
        else page.out(`  ${dim(page, "Every connection needs an API key.")}`);
        for (const username of printable([...refused])) {
          page.out(`  ${dim(page, `The key the config has for ${username} was not issued for the user as the data has it, and is refused. Issue a new one: vigile user reset-key ${username}`)}`);
        }
        page.out();
      });
      return;
    }

    case "add": {
      const typed = given(builtin("user add"), args);
      const username = typed.words[0]!;
      const type = typed.value("type") ?? "agent";
      const client = await service();
      const answer = await client.call("create_user", { username, type }).catch((error: unknown) => {
        throw unanswered(error, [
          `vigile user list shows whether ${username} is there now. Until this request is over it may still create ${username}: it goes by the name, and creates the user if the name is free when it is carried out.`,
          `While a user has the name, a request to create it is refused: run again, the command is refused if this request has created ${username} by then, and this request is refused if the other has. A name is free again once its user has been removed for good, so do not remove ${username} for good while this request is outstanding.`,
          `If ${username} is there and its key was not handed over, issue one: vigile user reset-key ${username}`,
        ]);
      });
      // That the user was created and has a key is said by the answer of create_user about this user, and by no other.
      const result = accepted<{ user: { username: string }; api_key: string; warning?: string }>(
        client.base,
        "create_user",
        { username, type },
        answer,
        `vigile user list shows whether ${username} is there. If it is, its key was not shown: issue one with vigile user reset-key ${username}`,
      );
      showing(ui, client.base, "POST /api/create-user", (page) => {
        if (json) return page.out(JSON.stringify({ ...result, mcp_url: `${client.base}/mcp` }, null, 2));
        showKey(page, printable(result.user.username), printable(result.api_key), client.base, true, printable(result.warning ?? undefined));
      });
      return;
    }

    case "remove": {
      const typed = given(builtin("user remove"), args);
      const username = typed.words[0]!;
      const permanent = typed.yes("permanent");
      const client = await service();
      // The user as it is now, for its ID and its version: the answer of get about this user, and no other.
      const current = accepted<{ id: string; username: string; version: number }>(client.base, "get", { kind: "user", id: username }, await client.call("get", { kind: "user", id: username }), "");
      // The removal names the user that was read by its ID, which is never given to another user, and not by the
      // name, which is: a removal that is carried out late must not remove whoever has the name by then. A user
      // that was removed for good and created again has the name, and the version the first one had.
      const asked = { kind: "user", id: current.id, version: current.version, ...(permanent ? { permanent: true } : {}) };
      const answer = await client.call("delete", asked).catch((error: unknown) => {
        throw unanswered(error, [
          `vigile user list shows whether ${username} is still there. Until this request is over, the user it read may still be removed.`,
          `This request names the user it read by its ID, ${current.id}, and its version, ${current.version}: it removes that user at most once, and no user that gets the name ${username} later. Running the command again looks the name up afresh, and removes whoever has it then: look first, with vigile user list, that it is the user you mean.`,
        ]);
      });
      // That the user is deleted, and whether for good as was asked, is said by the answer of delete about the
      // user of that ID, and by no other. On any other answer the command does not say that it was done.
      const result = accepted<{ permanent: boolean }>(client.base, "delete", asked, answer, `vigile user list shows whether ${username} is still there.`);
      const name = printable(current.username);
      showing(ui, client.base, "POST /api/delete", (page) => {
        if (json) return page.out(JSON.stringify(result, null, 2));
        note(
          page,
          "ok",
          `User ${name} deleted${result.permanent ? " permanently" : ""}; its API key no longer works`,
          result.permanent ? undefined : `To bring it back: vigile restore ${name} --kind user, then vigile user reset-key ${name}`,
        );
      });
      return;
    }

    case "reset-key": {
      const username = given(builtin("user reset-key"), args).words[0]!;
      // The reset is asked for the user that has the name now, by its ID: carried out late, it must not replace
      // the key of another user that has the name by then.
      let id: string | undefined;
      try {
        const client = await service();
        id = accepted<{ id: string }>(client.base, "get", { kind: "user", id: username }, await client.call("get", { kind: "user", id: username }), "").id;
        const result = accepted<{ user: { username: string }; api_key: string; warning?: string }>(
          client.base,
          "reset_user_key",
          { user: id },
          await client.call("reset_user_key", { user: id }),
          `The key ${username} had may no longer work. Run the command again: the key it then shows is the one that works.`,
        );
        showing(ui, client.base, "POST /api/reset-user-key", (page) => {
          if (json) return page.out(JSON.stringify({ ...result, mcp_url: `${client.base}/mcp` }, null, 2));
          showKey(page, printable(result.user.username), printable(result.api_key), client.base, false, printable(result.warning ?? undefined));
        });
      } catch (error) {
        // A reset that got no answer may have been done, or may yet be: the service carries out what it took
        // also after the connection has ended. A key written here would then be replaced by the service's own,
        // and the one handed over would open nothing. So nothing is written, and the outcome is said to be open.
        // A second reset is no way out of that while the first may still come: a reset names no version, and
        // the one carried out last cancels the key of the other, whichever of them answered.
        unanswered(error, [
          `The key of ${username} may have been replaced, or may yet be. No new key was handed over, and none was written by the command line.`,
          `A reset that is carried out later cancels the key of every reset before it, also of one that was sent after it and has answered. So do not rely on the key of another reset until this request is over. Then run: vigile user reset-key ${username}`,
          `This request names the user it read by its ID, ${id}: it does not touch a user that gets the name ${username} later. Running the command again looks the name up afresh, and resets the key of whoever has it then.`,
          username === "admin"
            ? "With the service stopped, that command writes the new admin key straight to the config file. The command line reads the admin key from that file, which is also where the service writes one it issues."
            : `The reset needs the running service. Until one has answered with no other outstanding, whoever uses a key of ${username} may be refused.`,
        ]);
        // The admin key is how the CLI reaches the service, so replacing a lost or broken one has to work without
        // it, in two cases and no other. Neither leaves a reset under way.
        if (username !== "admin") throw error;
        // The service answered that it refuses the key: 401, in its own words. It runs, and takes the new key
        // up from the file, which is where it writes one that it issues itself.
        if (keyRefused(error)) return writeAdminKey(ui, path, json);
        // Or no service runs on this config's data: nothing was sent to anyone, and the data folder is taken
        // for as long as the key is written, so that none starts meanwhile on a key that is being replaced.
        // A service that was not reached, or something at its address that was not taken for it while a process
        // holds the data, is not a service that does not run: a key written then would cancel the one its
        // clients use, which nobody refused. That is thrown on from in there, and nothing is written.
        await inTheServicesPlace(loaded, error, () => writeAdminKey(ui, path, json), taken);
      }
      return;
    }

    default:
      throw notOneOf("user", action);
  }
}
