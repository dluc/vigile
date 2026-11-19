import { z } from "zod";
import { GUIDE_TOPICS } from "../guide-topics.js";
import { guide } from "../guide.js";
import { defineRead } from "../operation.js";

export const getGuide = defineRead({
  name: "get_guide",
  description:
    'Read the guide to this service: what it holds, the ways to organise work in it (flat lists, groups nested as deep as needed, dependencies, bugs), the routine for working on a task, and complete examples of calls to copy. Start with topic "overview"; every answer lists the other topics. Worth reading before planning larger work.',
  access: "all",
  input: z.strictObject({
    topic: z.enum(GUIDE_TOPICS).optional().describe('Which part to read: "overview" (the default), "organising", "working" or "examples".'),
  }),
  run(_ctx, input) {
    return guide(input.topic);
  },
});
