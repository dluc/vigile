import { z } from "zod";
import { isLive } from "../calc.js";
import { defineRead } from "../operation.js";
import { userView } from "../views.js";
import { describeList } from "../paging.js";
import { continuation, cursor, paginate, type Cursor } from "./shared.js";

/**
 * The tokens of the list of users. The list is in the order of the IDs, and a token carries the ID of the last
 * user returned as it is written: the number in an ID is never made into a JavaScript number, which cannot
 * tell every ID from the next.
 */
export const usersCursor = (input: Record<string, unknown> = {}): Cursor<string> => cursor(describeList("list_users", input));

export const listUsers = defineRead({
  name: "list_users",
  description:
    'List the users, to find who work can be assigned to. A user is an admin, a person or an agent. Assign a task with add_link and type "assigned to". Returns at most 100 per call, ordered by ID.',
  access: "all",
  input: z.strictObject({ continuation }),
  run(ctx, input) {
    const users = ctx.graph.all("user").filter(isLive);
    const tokens = usersCursor(input);
    users.sort((a, b) => tokens.list.compare(a.id, b.id));
    const page = paginate(users, (user) => user.id, input.continuation, tokens);
    return { users: page.items.map(userView), you: ctx.caller.username, ...(page.continuation ? { continuation: page.continuation } : {}) };
  },
});
