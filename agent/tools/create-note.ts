import { z } from "zod";
import { createNode } from "../../lib/memory/nodes.ts";
import { flagMessage } from "../../lib/memory/pending.ts";
import { embedQuery } from "../../lib/voyage.ts";
import { flaggable } from "../../lib/../lib/agent/context.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Flag content for the background memory to save as a note (the memory batch does the actual write, deduplicated with passive capture). Use for facts worth remembering. Save only what the person told you or asked you to remember: never copy another person's details or preferences into notes about the person you're talking to, and don't re-save the leftover content of a note you were asked to delete unless they asked for it.",
  inputSchema: z.object({ content: z.string().describe("The atomic idea or fact (1-2 sentences)") }),
  async execute({ content }, ctx) {
    const message = flaggable(ctx.msgCtx);
    if (message) {
      await flagMessage(message.channel, message.ts, "create_memory", { content });
      return "Queued for the background memory, which writes the note after it processes this message, usually within minutes. The note doesn't exist yet: say it will be saved, not that it is saved.";
    }
    let embedding: number[];
    try {
      embedding = await embedQuery(content);
    } catch (error) {
      return `Failed to generate embedding: ${(error as Error).message}`;
    }
    try {
      const node = await createNode(ctx.userId, ctx.writeAccess, { content, embedding });
      return `Created note in slipbox: ${node.id}`;
    } catch (error) {
      return `Failed to create note: ${(error as Error).message}`;
    }
  },
});
