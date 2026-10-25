import { z } from "zod";
import { canModify, deleteLinkAs, getNodeAccessible } from "../../lib/memory/nodes.ts";
import { addOp } from "../../lib/memory/pending.ts";
import { flaggable } from "../../lib/../lib/agent/context.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

const FORBIDDEN = "Outside a team channel or DM you can only unlink the person's own notes.";

export default defineManfrodTool({
  description: "Remove a link between two notes.",
  inputSchema: z.object({
    note_a_id: z.string().describe("First note UUID"),
    note_b_id: z.string().describe("Second note UUID"),
  }),
  async execute({ note_a_id: a, note_b_id: b }, ctx) {
    const actor = { userId: ctx.userId, readableLevels: ctx.readableLevels };
    const ends = await Promise.all([getNodeAccessible(ctx.readableLevels, a), getNodeAccessible(ctx.readableLevels, b)]);
    if (!ends[0] || !ends[1]) return "One or both notes not found or not accessible";
    if (!ends.every((end) => end && canModify(end, actor))) return FORBIDDEN;
    const message = flaggable(ctx.msgCtx);
    if (message) {
      await addOp(message.channel, message.ts, { op: "unlink", a, b, user_id: ctx.userId, readable_levels: ctx.readableLevels });
      return `Zaznaczyłem rozłączenie notatek: ${a} <-> ${b}`;
    }
    const result = await deleteLinkAs(actor, a, b);
    if (result.ok) return `Unlinked ${a} <-> ${b}`;
    return result.error === "forbidden" ? FORBIDDEN : `Link not found: ${a} <-> ${b}`;
  },
});
