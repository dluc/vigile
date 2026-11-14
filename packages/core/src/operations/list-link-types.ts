import { z } from "zod";
import { LINK_TYPES } from "../link-types.js";
import { defineRead } from "../operation.js";

export const listLinkTypes = defineRead({
  name: "list_link_types",
  description:
    "List the link types that add_link and remove_link accept: each type's name, its reverse name, the kinds of item it connects, and what the product does because of it.",
  access: "all",
  input: z.strictObject({}),
  run() {
    return {
      link_types: LINK_TYPES.map((t) => ({
        type: t.type,
        reverse: t.reverse,
        from: t.from,
        to: t.to,
        built_in: t.built_in,
        effect: t.description,
      })),
    };
  },
});
