import { z } from "zod";
import { deleteLink, getNodeAccessible } from "../../lib/memory/nodes.ts";
import { addOp } from "../../lib/memory/pending.ts";
import { flaggable } from "../../lib/../lib/agent/context.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description: "Remove a link between two notes.",
  inputSchema: z.object({
    note_a_id: z.string().describe("First note UUID"),
    note_b_id: z.string().describe("Second note UUID"),
  }),
  async execute({ note_a_id: a, note_b_id: b }, ctx) {
    const accessible = (await getNodeAccessible(ctx.readableLevels, a)) && (await getNodeAccessible(ctx.readableLevels, b));
    if (!accessible) return "One or both notes not found or not accessible";
    const message = flaggable(ctx.msgCtx);
    if (message) {
      await addOp(message.channel, message.ts, { op: "unlink", a, b, user_id: ctx.userId });
      return `Zaznaczyłem rozłączenie notatek: ${a} <-> ${b}`;
    }
    const link = await deleteLink(ctx.userId, a, b);
    return link ? `Unlinked ${a} <-> ${b}` : `Link not found: ${a} <-> ${b}`;
  },
});
