import { z } from "zod";
import { getNodeAccessible, setSoul } from "../../lib/memory/nodes.ts";
import { isUuid } from "../../lib/accounts.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Make an existing note your soul for the person you are talking to, replacing the current one (which stays as an ordinary note). Only on their explicit request.",
  inputSchema: z.object({ note_id: z.string().describe("UUID of the note to make the soul") }),
  async execute({ note_id }, ctx) {
    if (!isUuid(note_id) || !(await getNodeAccessible(ctx.readableLevels, note_id))) return `Note not found: ${note_id}`;
    const soul = await setSoul(ctx.userId, note_id);
    return soul ? `Note [${soul.id}] is now the soul:\n${soul.content}` : `Note not found: ${note_id}`;
  },
});
