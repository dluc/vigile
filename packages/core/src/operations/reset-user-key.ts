import { z } from "zod";
import { afterStored } from "../errors.js";
import { defineWrite } from "../operation.js";
import { requireLive, resolveRef } from "../rules.js";
import { areKeyMarks, keyMark } from "../model.js";
import { userView } from "../views.js";
import { touch, unconfirmed } from "./shared.js";

export const resetUserKey = defineWrite({
  name: "reset_user_key",
  description:
    "Issue a new API key for a user and cancel the old one. The new key is returned once, here. Use it when a key is lost or leaked, or after restoring a deleted user. A warning in the answer means the key works but could not be confirmed to last; issue another when that is put right.",
  access: ["admin"],
  input: z.strictObject({
    user: z.string().describe("A username or user ID."),
  }),
  run(ctx, input) {
    const user = resolveRef(ctx.graph, input.user, ["user"]);
    requireLive(user);
    const key = ctx.keys.create();
    if (!user.built_in) {
      // The new key's mark goes with the user, and beside it stays the mark of the key that is stored for it
      // now, if that key is its own: should the new key not get stored, the stored one goes on working, as the
      // answer then says, however many times in a row that happens. A key stored under the name that is not
      // this user's, left there by an earlier user of the name, is not taken over. A user from before marks
      // were kept owns whatever key is stored for it.
      const now = ctx.keys.stored(user.username);
      const theirs = now !== undefined && (user.key_marks === undefined || (areKeyMarks(user.key_marks) && user.key_marks.includes(keyMark(now))));
      ctx.plan.put(touch(user, ctx, { key_marks: [keyMark(key), ...(theirs ? [keyMark(now)] : [])] }));
    }
    ctx.plan.history(user, "key_reset");
    return async () => {
      const warning = await ctx.keys.put(user.username, key).catch((error: unknown) => {
        throw afterStored(`No new API key could be stored for ${user.username}. The key it had, if any, still works.`, ["Call reset_user_key again once the cause, which is in the service's log, is put right."], error);
      });
      return { user: userView(ctx.graph.get("user", user.id)!), api_key: key, ...(warning ? { warning: unconfirmed(warning) } : {}) };
    };
  },
});
