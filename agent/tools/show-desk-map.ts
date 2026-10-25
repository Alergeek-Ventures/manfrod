import { z } from "zod";
import { postMap } from "../../lib/desk-map.ts";
import { DATE_DOC, withDate } from "../lib/office.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Render the office desk map as an image for a date (default today) and post it to Slack. Posts to this channel by default, or to channel_id if given.",
  inputSchema: z.object({
    date: z.string().optional().describe(DATE_DOC),
    channel_id: z.string().optional().describe("Slack channel ID to post to instead of the current channel, e.g. 'C087QF130R3'"),
  }),
  async execute({ date, channel_id }, ctx) {
    const channel = channel_id ?? ctx.msgCtx.channel;
    if (!channel) return "Can't post the map outside a Slack channel.";
    return withDate(date, async (day) => {
      try {
        const result = await postMap(channel, day);
        return result.ok ? `Posted the desk map for ${day}.` : `Could not render/post the desk map: ${result.error}`;
      } catch (error) {
        return `Could not render/post the desk map: ${(error as Error).message}`;
      }
    });
  },
});
