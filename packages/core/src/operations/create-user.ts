import { z } from "zod";
import { isLive } from "../calc.js";
import { afterStored, echo, invalidInput, refused } from "../errors.js";
import { RESERVED_PREFIXES, USERNAME, userId } from "../ids.js";
import { LIMITS, keyMark, type UserNode } from "../model.js";
import { unconfirmed } from "./shared.js";
import { defineWrite } from "../operation.js";
import { userView } from "../views.js";

const looksLikeId = new RegExp(`^(${RESERVED_PREFIXES.join("|")})-\\d+$`, "i");

export const createUser = defineWrite({
  name: "create_user",
  description:
    "Create a user and its API key. Use type agent for an AI agent and person for a human that work can be assigned to. Each agent that should be told apart from the others needs its own user. The key is returned once, here; give it to the client, which sends it in the Authorization header.",
  access: ["admin"],
  input: z.strictObject({
    username: z.string().trim().describe(`Lowercase letters, digits, "-" and "_", starting with a letter; at most ${LIMITS.username} characters.`),
    type: z.enum(["person", "agent"]),
  }),
  run(ctx, input) {
    const username = input.username.toLowerCase();
    if (!USERNAME.test(username) || looksLikeId.test(username)) {
      throw invalidInput(`"${echo(input.username)}" cannot be a username.`, [
        `Use lowercase letters, digits, "-" and "_", starting with a letter, at most ${LIMITS.username} characters, and not something that reads like an ID.`,
      ]);
    }
    const existing = ctx.graph.userByName(username);
    if (existing) {
      throw refused("username_taken", `The username ${username} is already used${isLive(existing) ? "" : " by a deleted user"}.`, {
        actions: isLive(existing) ? ["Choose a different username."] : ["Choose a different username, or call restore to bring that user back."],
      });
    }
    // The key is made before the user is stored, and its mark stored with the user: only this key counts for
    // this user, whatever key is, or stays, under the name where keys are kept.
    const key = ctx.keys.create();
    const user: UserNode = {
      kind: "user",
      id: userId(ctx.plan.next("identity")),
      username,
      type: input.type,
      built_in: false,
      key_marks: [keyMark(key)],
      version: 1,
      created_at: ctx.now,
      created_by: ctx.caller.id,
      updated_at: ctx.now,
      deleted_at: null,
    };
    ctx.plan.put(user);
    ctx.plan.history(user, "created", { username, type: user.type });
    return async () => {
      const warning = await ctx.keys.put(username, key).catch((error: unknown) => {
        throw afterStored(`User ${username} was created, but its API key could not be stored, so it cannot connect yet.`, [`Call reset_user_key for ${username} once the cause, which is in the service's log, is put right.`], error);
      });
      return { user: userView(ctx.graph.get("user", user.id)!), api_key: key, ...(warning ? { warning: unconfirmed(warning) } : {}) };
    };
  },
});
