import { z } from "zod";
import { getNodeAccessible, getNodeLinksAccessible } from "../../lib/memory/nodes.ts";
import { noteDate } from "../lib/notes.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Fetch a specific note by its UUID. Also returns linked notes for context. Use when you have a note ID from the context and want more details or related notes.",
  inputSchema: z.object({
    id: z.string().describe("UUID of the note to fetch (e.g., '550e8400-e29b-41d4-a716-446655440000')"),
  }),
  async execute({ id }, ctx) {
    const node = await getNodeAccessible(ctx.readableLevels, id);
    if (!node) return `Note not found: ${id}`;
    const linked = await getNodeLinksAccessible(ctx.readableLevels, node.id);
    const linkedContent =
      linked.length === 0
        ? "No linked notes."
        : `Linked notes:\n${linked.map((other) => `- ${noteDate(other)} [${other.id}] ${other.content}`).join("\n")}`;
    return `Note [${node.id}] (${noteDate(node)}):\n${node.content}\n\n${linkedContent}\n`;
  },
});
