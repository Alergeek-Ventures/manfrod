import { z } from "zod";
import { getSoul } from "../../lib/memory/nodes.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Show your soul for the person you are talking to: the core note that opens every conversation with them (who they are, how to work with them, who you are for them). Use when they ask what is in it, and before changing it.",
  inputSchema: z.object({}),
  async execute(_args, ctx) {
    const soul = await getSoul(ctx.userId);
    return soul ? `Soul [${soul.id}]:\n${soul.content}` : "There is no soul yet. update-soul creates one.";
  },
});
