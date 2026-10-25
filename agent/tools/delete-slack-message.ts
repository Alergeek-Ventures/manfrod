import { z } from "zod";
import { deleteMessage } from "../../lib/slack/api.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Delete a message the bot previously posted, given its channel ID and message timestamp (ts). Only works on the bot's own messages. Only use this when a user explicitly asks you to remove a specific message — never delete messages on your own initiative.",
  inputSchema: z.object({
    channel_id: z.string().describe("Slack channel ID, e.g. 'C087QF130R3'"),
    ts: z.string().describe("Message timestamp ('ts'), e.g. '1719000000.123456'"),
  }),
  async execute({ channel_id, ts }) {
    const result = await deleteMessage(channel_id, ts);
    return result.ok ? "Deleted the message." : `Could not delete the message: "${result.error}"`;
  },
});
