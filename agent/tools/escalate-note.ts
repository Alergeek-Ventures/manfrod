import { z } from "zod";
import { escalateNoteAccess } from "../../lib/memory/nodes.ts";
import { addOp } from "../../lib/memory/pending.ts";
import { flaggable } from "../../lib/../lib/agent/context.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Flag an existing note to have its visibility widened (private → internal, or internal → external/client); applied by the background memory. Use when the user explicitly asks to share it more widely. Notes from DMs start private to that person, so sharing one with the team means escalating it to 'internal'.",
  inputSchema: z.object({
    node_id: z.string().describe("Note UUID"),
    new_access_level: z.string().describe("New access level to add: 'internal', 'external/10bps' or 'external/all'"),
  }),
  async execute({ node_id, new_access_level }, ctx) {
    const message = flaggable(ctx.msgCtx);
    if (message) {
      await addOp(message.channel, message.ts, {
        op: "escalate",
        node_id,
        level: new_access_level,
        readable_levels: ctx.readableLevels,
      });
      return `Zaznaczyłem do poszerzenia widoczności: ${node_id} → ${new_access_level}`;
    }
    const result = await escalateNoteAccess(node_id, new_access_level, ctx.readableLevels);
    if (result.ok) return `Nota ${node_id} teraz widoczna jako: ${new_access_level}`;
    return result.error === "not_found" ? `Nota nie znaleziona: ${node_id}` : `Błąd: :${result.error}`;
  },
});
