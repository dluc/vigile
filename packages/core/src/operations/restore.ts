import { z } from "zod";
import { isLive } from "../calc.js";
import { afterStored, forbidden, refused } from "../errors.js";
import { KINDS } from "../model.js";
import { defineWrite } from "../operation.js";
import { describe, resolveRef } from "../rules.js";
import { summary } from "../views.js";
import { kind, touch } from "./shared.js";

export const restore = defineWrite({
  name: "restore",
  description:
    "Bring back a deleted project, task or user. It returns to the lists with the status and links it had. Restoring a user is for admins only, and the user needs a new API key afterwards. An item that was deleted permanently cannot be restored.",
  access: "all",
  input: z.strictObject({
    kind,
    id: z.string().describe("The item's ID, or a username for a user."),
  }),
  run(ctx, input) {
    const node = resolveRef(ctx.graph, input.id, (input.kind ? [input.kind] : KINDS).filter(k => ctx.features.kind(k)));
    if (node.kind === "user" && ctx.caller.type !== "admin") throw forbidden("Only an admin can restore users.", ["Ask an admin to restore this user."]);
    if (isLive(node)) throw refused("not_deleted", `${describe(node)} is not deleted.`, {
      actions: [`Call get with kind "${node.kind}" and id "${node.id}" to read it; no restore is needed.`],
    });
    // A user comes back as one that no key counts for, as the description says: not the key it had, should
    // that still be where keys are kept, nor any other, until one is issued.
    ctx.plan.put(node.kind === "user" && !node.built_in ? touch(node, ctx, { deleted_at: null, key_marks: [] }) : touch(node, ctx, { deleted_at: null }));
    ctx.plan.history(node, "restored");
    return async () => {
      // A user comes back without a key, as the description says: one that was left behind when the user was
      // deleted must not let anyone in again.
      if (node.kind === "user") {
        await ctx.keys.revoke(node.username).catch((error: unknown) => {
          throw afterStored(`User ${node.username} was restored. The key it had before no longer counts for it, but could not be removed from where keys are kept.`, [`Call reset_user_key for ${node.username}: it needs a new key in any case, and that replaces what was left behind.`], error);
        });
      }
      return summary(ctx.features.view(ctx.graph), ctx.graph.node(node)!);
    };
  },
});
