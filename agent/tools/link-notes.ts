import { z } from "zod";
import { createLink, getNodeAccessible } from "../../lib/memory/nodes.ts";
import { addOp } from "../../lib/memory/pending.ts";
import { flaggable } from "../../lib/../lib/agent/context.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description: "Create a link between two notes. Links are undirected - order doesn't matter.",
  inputSchema: z.object({
    note_a_id: z.string().describe("First note UUID"),
    note_b_id: z.string().describe("Second note UUID"),
  }),
  async execute({ note_a_id: a, note_b_id: b }, ctx) {
    const accessible = (await getNodeAccessible(ctx.readableLevels, a)) && (await getNodeAccessible(ctx.readableLevels, b));
    if (!accessible) return "One or both notes not found or not accessible";
    const message = flaggable(ctx.msgCtx);
    if (message) {
      await addOp(message.channel, message.ts, { op: "link", a, b, user_id: ctx.userId });
      return `Zaznaczyłem połączenie notatek: ${a} <-> ${b}`;
    }
    const result = await createLink(ctx.userId, a, b);
    return result.ok ? `Linked ${a} <-> ${b}` : `Failed to create link: ${result.error}`;
  },
});
