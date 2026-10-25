import { z } from "zod";
import { listChannels } from "../../lib/slack/api.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "List Slack channels the bot can see, with their IDs and names. Use this to look up a channel_id when a user refers to a channel by name (e.g. for show-desk-map's channel_id argument).",
  inputSchema: z.object({
    name_filter: z.string().optional().describe("Optional case-insensitive substring to filter channel names by"),
  }),
  async execute({ name_filter }) {
    const channels = await listChannels();
    if (!channels) return "Could not list Slack channels: :api_error";
    const filter = name_filter ? name_filter.toLowerCase() : "";
    const matching = channels.filter(
      (channel) => filter === "" || (typeof channel.name === "string" && channel.name.toLowerCase().includes(filter)),
    );
    if (matching.length === 0) return "No matching channels found.";
    return `Channels:\n${matching
      .map((channel) => `- #${channel.name ?? "?"} (${channel.id ?? "?"}, ${channel.is_private ? "private" : "public"})`)
      .join("\n")}`;
  },
});
