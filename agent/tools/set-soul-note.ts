import { z } from "zod";
import { getNodeAccessible, updateSoul } from "../../lib/memory/nodes.ts";
import { embedQuery } from "../../lib/voyage.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Replace your soul for the person you are talking to with the content of an existing note. The note itself stays as it is; the soul remains private to this person. Only on their explicit request.",
  inputSchema: z.object({ note_id: z.string().describe("UUID of the note whose content becomes the soul") }),
  async execute({ note_id }, ctx) {
    const note = await getNodeAccessible(ctx.readableLevels, note_id);
    if (!note) return `Note not found: ${note_id}`;
    try {
      const soul = await updateSoul(ctx.userId, note.content, note.embedding ?? (await embedQuery(note.content)));
      return `The soul [${soul.id}] now reads:\n${soul.content}`;
    } catch (error) {
      return `Failed to save the soul: ${(error as Error).message}`;
    }
  },
});
