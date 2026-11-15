import { resolve } from "node:path";
import { SETTINGS, initConfig, loadConfig, masked, setValue, unsetValue, type Config, type ResultingConfig } from "@vigile/config";
import { allUsers } from "../answers.js";
import { UsageError, configPath, flag, type Args } from "../args.js";
import { backupPlaceRefused, refusedPlace, unknownRefusal } from "../backup.js";
import { ANSWER_WITHIN_MS, NoAnswerError } from "../client.js";
import { connect, inTheServicesPlace } from "../reach.js";
import { accent, dim, fields, heading, note, pad, type Ui } from "../ui.js";
import { builtin, given, notOneOf, oneOf } from "./builtin.js";

const valueAt = (config: Config, key: string): unknown => key.split(".").reduce<any>((value, part) => value?.[part], config);

const RESTART = "Restart the service for this to take effect.";
/**
 * The command line calls a service only when it goes by the name the config gives it and holds the data folder
 * the config names. A running one is still what it was started as.
 */
const UNTIL_THEN: Record<string, string> = { name: "it still goes by its old name", data_dir: "it still holds the data folder it was started on" };
const applies = (key: string): string =>
  key.startsWith("auth.") ? "Auth settings apply at once, without a restart." : Object.hasOwn(UNTIL_THEN, key) ? `${RESTART} Until then the commands that call the service refuse to: ${UNTIL_THEN[key]}.` : RESTART;

/**
 * The settings that decide whether automatic backups are taken and where they and the data are. A change to any
 * of them is looked at as the config that results, before it is written: where backups may go depends on all
 * three together, so turning backups on is as much a change of place as naming a folder is.
 */
const PLACE_BACKUPS = new Set(["backup.enabled", "backup.folder", "backup.every_hours", "backup.keep", "data_dir"]);
const placesBackups = (key: string, change: string): ((resulting: ResultingConfig) => void) | undefined =>
  PLACE_BACKUPS.has(key)
    ? (resulting) => {
        const refusal = backupPlaceRefused(resulting);
        if (!refusal) return;
        const where = `${change}, the automatic backups would go to ${refusal.backups} (backup.folder) and the data is in ${refusal.data} (data_dir). Nothing was changed.`;
        switch (refusal.code) {
          case "same_data_folder_of_this_instance":
            throw new UsageError(refusedPlace(refusal).message, [where, "Give the backups a folder of their own first: vigile config set backup.folder <folder>. Or turn them off: vigile config set backup.enabled false"]);
          case "data_folder_of_another_instance":
            throw new UsageError(refusedPlace(refusal).message, [where, "Name a folder that is no instance's data folder: vigile config set backup.folder <folder>. Or turn them off: vigile config set backup.enabled false"]);
          default:
            return unknownRefusal(refusal);
        }
      }
    : undefined;

/** How long the service is given to answer is a parameter for the tests, and so is what is called once the data folder is held for a write in the service's place. */
export async function config(args: Args, ui: Ui, answerWithinMs = ANSWER_WITHIN_MS, taken?: () => unknown): Promise<void> {
  const action = args.words.shift();
  oneOf("config", action);
  const json = flag(args, "json");
  const path = resolve(configPath(args));

  switch (action) {
    case "path":
      given(builtin("config path"), args);
      ui.out(json ? JSON.stringify({ path }) : path);
      return;

    case "init": {
      // By the names of the settings, as serve takes them, or by the short names.
      const typed = given(builtin("config init"), args);
      const port = typed.value("listen.port");
      if (port !== undefined && !/^\d+$/.test(port)) throw new UsageError("--listen.port must be a whole number.");
      const name = typed.value("name");
      const address = typed.value("listen.address");
      const { config: created, adminKey, warning } = initConfig(path, { name, address, port: port === undefined ? undefined : Number(port) });
      if (json) return ui.out(JSON.stringify({ path, admin_key: adminKey, config: masked(created), ...(warning ? { warning } : {}) }, null, 2));
      heading(ui, "Config created");
      fields(ui, [
        ["File", path],
        ["Name", created.name],
        ["Listen", `${created.listen.address}:${created.listen.port}`],
        ["Admin key", adminKey],
      ]);
      ui.out();
      note(ui, "ok", "The file is readable by your account only. The admin key is stored in it; the CLI reads it from there.");
      if (warning) note(ui, "warn", warning);
      ui.out(`    ${dim(ui, `Start the service: vigile serve --config ${path}`)}`);
      ui.out();
      return;
    }

    case "show": {
      given(builtin("config show"), args);
      const loaded = loadConfig(path);
      const shown = masked(loaded.config);
      if (json) return ui.out(JSON.stringify({ path: loaded.path, data_dir: loaded.dataDir, backup_folder: loaded.backupDir, config: shown, sources: loaded.sources }, null, 2));
      heading(ui, "Config");
      fields(ui, [
        ["File", loaded.path],
        ["Data", loaded.dataDir],
        ["Backups", loaded.config.backup.enabled ? loaded.backupDir : `${loaded.backupDir} (automatic backups are off)`],
      ]);
      ui.out();
      const size = Math.max(...SETTINGS.map((s) => s.key.length));
      const values = SETTINGS.map((s) => JSON.stringify(valueAt(shown, s.key)));
      const valueSize = Math.max(...values.map((v) => v.length));
      SETTINGS.forEach((setting, i) => {
        ui.out(`  ${accent(ui, pad(setting.key, size))}  ${pad(values[i]!, valueSize)}  ${dim(ui, loaded.sources[setting.key] ?? "default")}`);
      });
      ui.out();
      const users = Object.entries(shown.auth.keys);
      ui.out(`  ${dim(ui, "API keys")}`);
      for (const [user, key] of users) ui.out(`  ${accent(ui, pad(user, size))}  ${key}`);
      ui.out();
      return;
    }

    case "set": {
      const [key, value] = given(builtin("config set"), args).words as [string, string];
      // Auth settings apply at once. A keyless user that does not exist would have every connection without a
      // key refused, and the next start too: the running service is asked whether there is such a user.
      let unchecked: string | undefined;
      let updated: Config | undefined;
      if (key === "auth.keyless_user" && value !== "") {
        const loaded = loadConfig(path);
        try {
          const client = await connect(loaded, "admin", answerWithinMs);
          const users = await allUsers(client);
          if (!users.some((user) => user.username === value)) {
            throw new UsageError(`There is no user called "${value}".`, [`Users: ${users.map((user) => user.username).join(", ")}`, "Create one with: vigile user add <username>"]);
          }
        } catch (error) {
          // A service that took the connection and did not answer is there, and applies the setting the moment
          // it is written: a name that is no user's would shut out every connection without a key. Unasked,
          // nothing is written.
          if (error instanceof NoAnswerError) {
            error.advice = [
              `auth.keyless_user was not changed: the service could not be asked whether there is a user called ${value}.`,
              "Try again when the service answers. Or stop the service first: with none running the setting is written unchecked, and the service does not start if there is no such user.",
            ];
          }
          // A service that is not there cannot be asked, and applies nothing: the setting is written as it is by
          // hand, and what could not be checked is said. Only when no service runs on this config's data, and
          // with the data folder taken for as long as the setting is written, so that none starts meanwhile and
          // applies it unasked. A service that may run, and was not reached or not taken for what answers, would
          // apply the setting the moment it is written: that failure is thrown on from in there instead.
          updated = await inTheServicesPlace(loaded, error, () => setValue(path, key, value), taken);
          unchecked = `The service is not running, so whether there is a user called ${value} could not be checked. It will not start if there is none.`;
        }
      }
      // Any other setting, and this one when the service was asked, is written beside a service that may run:
      // it reads the file when it starts, or took part in the check.
      updated ??= setValue(path, key, value, placesBackups(key, `With ${key} = ${JSON.stringify(value)}`));
      if (json) return ui.out(JSON.stringify({ [key]: valueAt(updated, key), ...(unchecked ? { warning: unchecked } : {}) }));
      note(ui, "ok", `${key} = ${JSON.stringify(valueAt(updated, key))}`, unchecked ?? applies(key));
      return;
    }

    case "unset": {
      const [key] = given(builtin("config unset"), args).words as [string];
      const updated = unsetValue(path, key, placesBackups(key, `With ${key} back to its default`));
      if (json) return ui.out(JSON.stringify({ [key]: valueAt(updated, key) }));
      note(ui, "ok", `${key} is back to its default: ${JSON.stringify(valueAt(updated, key))}`, applies(key));
      return;
    }

    default:
      throw notOneOf("config", action);
  }
}
