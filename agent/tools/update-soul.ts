import { z } from "zod";
import { privateLevel } from "../../lib/memory/access.ts";
import { updateSoul } from "../../lib/memory/nodes.ts";
import { embedQuery } from "../../lib/voyage.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Rewrite your soul for the person you are talking to. Only when they explicitly ask you to change it (e.g. 'zapisz w swojej duszy...', 'zmień swoją osobowość na...'). Pass the complete new text: read it with get-soul first and keep everything that still holds.",
  inputSchema: z.object({ content: z.string().describe("The complete new soul text") }),
  async execute({ content }, ctx) {
    const trimmed = content.trim();
    if (trimmed === "") return "The soul can't be empty.";
    try {
      const embedding = await embedQuery(trimmed);
      const soul = await updateSoul(ctx.userId, trimmed, embedding, [privateLevel(ctx.userId)]);
      return `Soul updated [${soul.id}]. It opens every new conversation from now on; act on it in this one already.`;
    } catch (error) {
      return `Failed to save the soul: ${(error as Error).message}`;
    }
  },
});
