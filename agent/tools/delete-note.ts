import { z } from "zod";
import { canModify, deleteNodeAs, getNodeAccessible, isSoul } from "../../lib/memory/nodes.ts";
import { addOp } from "../../lib/memory/pending.ts";
import { flaggable } from "../../lib/../lib/agent/context.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

const FORBIDDEN = "Outside a team channel or DM you can only delete your own notes.";

export default defineManfrodTool({
  description:
    "Delete a note from your zettelkasten. All links to/from this note are automatically removed. Works on any note visible here when in a DM or team channel; in client channels only on the person's own notes. Delete only what the person asked for. If the note also holds other content, don't re-save that content as a new note on your own; ask first. Never move another person's details or preferences into notes about the person asking. During a conversation the deletion is queued, not done: say it is queued, never that the note is already gone.",
  inputSchema: z.object({ id: z.string().describe("UUID of the note to delete") }),
  async execute({ id }, ctx) {
    const soulMessage = `Note ${id} is a soul and can't be deleted. Change it with update-soul instead.`;
    if (await isSoul(id)) return soulMessage;
    const actor = { userId: ctx.userId, readableLevels: ctx.readableLevels };
    const node = await getNodeAccessible(ctx.readableLevels, id);
    if (!node) return `Note not found: ${id}`;
    if (!canModify(node, actor)) return FORBIDDEN;
    const message = flaggable(ctx.msgCtx);
    if (message) {
      await addOp(message.channel, message.ts, { op: "delete", node_id: id, user_id: ctx.userId, readable_levels: ctx.readableLevels });
      return `Queued note ${id} for deletion. The background memory deletes it after it processes this message, usually within minutes; until then it still shows up. Tell the person it is queued, not that it is already deleted.`;
    }
    const result = await deleteNodeAs(actor, id);
    if (result.ok) return `Deleted note: ${id}`;
    if (result.error === "soul") return soulMessage;
    return result.error === "forbidden" ? FORBIDDEN : `Note not found: ${id}`;
  },
});
