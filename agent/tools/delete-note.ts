import { z } from "zod";
import { deleteNode, getNodeAccessible, isSoul } from "../../lib/memory/nodes.ts";
import { addOp } from "../../lib/memory/pending.ts";
import { flaggable } from "../../lib/../lib/agent/context.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description: "Delete a note from your zettelkasten. All links to/from this note are automatically removed.",
  inputSchema: z.object({ id: z.string().describe("UUID of the note to delete") }),
  async execute({ id }, ctx) {
    const soulMessage = `Note ${id} is a soul and can't be deleted. Change it with update-soul instead.`;
    if (await isSoul(id)) return soulMessage;
    const node = await getNodeAccessible(ctx.readableLevels, id);
    if (!node) return `Note not found: ${id}`;
    const message = flaggable(ctx.msgCtx);
    if (message) {
      await addOp(message.channel, message.ts, { op: "delete", node_id: id, user_id: ctx.userId });
      return `Zaznaczyłem notatkę do usunięcia: ${id}`;
    }
    const result = await deleteNode(ctx.userId, id);
    if (result.ok) return `Deleted note: ${id}`;
    return result.error === "soul" ? soulMessage : `Note not found or not yours: ${id}`;
  },
});
