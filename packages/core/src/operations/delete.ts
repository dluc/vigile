import { z } from "zod";
import { containedTasks, isLive } from "../calc.js";
import { afterStored, forbidden, refused } from "../errors.js";
import { prefixProblem, refText } from "../ids.js";
import { ASSIGNED_TO, CONTAINS } from "../link-types.js";
import { KINDS, type Node } from "../model.js";
import { defineWrite, type ReadContext } from "../operation.js";
import { describe, blockedBy, requireVersion, resolveRef } from "../rules.js";
import { summary } from "../views.js";
import { recordLinkChanges } from "./links.js";
import { kind, touch, version } from "./shared.js";

/** Why an item cannot be deleted yet, as the items in the way and what to do about them. */
function inTheWay(ctx: ReadContext, node: Node, permanent: boolean): void {
  if (node.kind === "project") {
    const tasks = containedTasks(ctx.graph, node, false);
    if (tasks.length) {
      throw refused("contains_tasks", `${describe(node)} still contains ${tasks.length} task${tasks.length === 1 ? "" : "s"}.`, {
        ...blockedBy(tasks),
        actions: ["Delete those tasks first, or call remove_link to move them out of the project."],
      });
    }
    // A deleted task can be restored. Were its project gone for good by then, it would come back in no project,
    // under an ID that still carries the project's prefix.
    const deleted = permanent ? ctx.graph.out(node, CONTAINS).flatMap((link) => ctx.graph.get("task", link.to.id) ?? []).filter((task) => !isLive(task)) : [];
    if (deleted.length) {
      throw refused("contains_deleted_tasks", `${describe(node)} still contains ${deleted.length} deleted task${deleted.length === 1 ? "" : "s"}, which can be restored and would then be in no project.`, {
        ...blockedBy(deleted),
        actions: ["Delete those tasks permanently first, or call remove_link to move them out of the project."],
      });
    }
  }
  if (node.kind === "user") {
    const tasks = ctx.graph
      .in(node, ASSIGNED_TO)
      .flatMap((link) => ctx.graph.get("task", link.from.id) ?? [])
      .filter(isLive);
    if (tasks.length) {
      throw refused("has_assigned_tasks", `${describe(node)} still has ${tasks.length} task${tasks.length === 1 ? "" : "s"} assigned.`, {
        ...blockedBy(tasks),
        actions: ['Reassign them first: call remove_link and add_link with type "assigned to".'],
      });
    }
  }
}

export const deleteItem = defineWrite({
  name: "delete",
  description:
    "Delete a project, task or user. By default the item is only hidden: it leaves the lists, stops holding back what depends on it, and can be brought back with restore. A project that still contains tasks cannot be deleted. Deleting users, and deleting anything permanently, is for admins only; a permanent delete also removes the item's links and its history and cannot be undone. A project cannot be deleted permanently while deleted tasks are still in it, and its prefix is never given to another project.",
  access: "all",
  input: z.strictObject({
    kind,
    id: z.string().describe("The item's ID, or a username for a user."),
    version,
    permanent: z.boolean().optional().describe("true to remove the item for good. Admins only."),
  }),
  run(ctx, input) {
    const node = resolveRef(ctx.graph, input.id, input.kind ? [input.kind] : KINDS);
    const permanent = input.permanent === true;
    if (ctx.caller.type !== "admin" && (permanent || node.kind === "user")) {
      throw forbidden(permanent ? "Only an admin can delete permanently." : "Only an admin can delete users.", [
        ...(permanent && node.kind !== "user" ? ["Call delete without permanent to hide the item instead."] : []),
      ]);
    }
    if (node.kind === "user" && node.built_in) {
      throw refused("built_in", `${describe(node)} is built in and cannot be deleted.`);
    }
    requireVersion(node, input.version, () => summary(ctx.graph, node));
    if (!permanent && !isLive(node)) {
      throw refused("already_deleted", `${describe(node)} is already deleted.`, { actions: ["Call restore to bring it back."] });
    }
    if (permanent || isLive(node)) inTheWay(ctx, node, permanent);

    const username = node.kind === "user" ? node.username : null;
    if (permanent) {
      const links = [...ctx.graph.out(node), ...ctx.graph.in(node)];
      for (const link of links) ctx.plan.unlink(link);
      // What stays behind changes with it: a task that was inside it, depended on it or was assigned to it
      // moves one version on and says in its history what it lost.
      recordLinkChanges(ctx, "link_removed", links, node);
      // The item goes with all that is stored under its kind and ID: its description and its history. Nothing
      // is written about it after that, so that nothing later can be shown the history of an item that is gone.
      ctx.plan.remove(node);
      // Its prefix stays behind, used up: the tasks that were in the project may live on under IDs that carry it.
      if (node.kind === "project" && prefixProblem(node.id) === null) ctx.plan.retire(node.id);
    } else {
      ctx.plan.put(touch(node, ctx, { deleted_at: ctx.now }));
      ctx.plan.history(node, "deleted");
    }
    return async () => {
      if (username) {
        await ctx.keys.revoke(username).catch((error: unknown) => {
          throw afterStored(
            `User ${username} was deleted, but its API key could not be removed from where keys are kept. The key lets nobody in while the user is deleted.`,
            [
              permanent ? `The cause is in the service's log. Remove the line auth.keys.${username} from the config file.` : "The cause is in the service's log. Restoring the user cancels the key.",
              `If auth.keyless_user in the config file is ${username}, set it to nothing: the service does not start while it names a user that is deleted.`,
            ],
            error,
          );
        });
      }
      return { deleted: true, permanent, kind: node.kind, id: refText(node) };
    };
  },
});
