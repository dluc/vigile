import { z } from "zod";
import { isLive } from "../calc.js";
import { userNumber } from "../ids.js";
import { defineRead } from "../operation.js";
import { userView } from "../views.js";

export const listUsers = defineRead({
  name: "list_users",
  description:
    'List the users, to find who work can be assigned to. A user is an admin, a person or an agent. Assign a task with add_link and type "assigned to".',
  access: "all",
  input: z.strictObject({}),
  run(ctx) {
    const users = ctx.graph.all("user").filter(isLive);
    users.sort((a, b) => userNumber(a.id) - userNumber(b.id));
    return { users: users.map(userView), you: ctx.caller.username };
  },
});
