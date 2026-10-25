import { z } from "zod";
import { listMessages } from "../../lib/slack/api.ts";
import { channelFor, formatMessages, errorText } from "../lib/slack.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Read recent top-level messages from a Slack channel (the current one when no channel is given). Messages that have a thread show its thread_ts - pass it to read-slack-thread to read that thread. Use list-slack-channels first if you're not sure of a channel name.",
  inputSchema: z.object({
    channel: z
      .string()
      .optional()
      .describe("Channel name (e.g. 'general' or '#general') or Slack channel ID (e.g. 'C087QF130R3'). Omit for the current channel."),
    limit: z.number().int().optional().describe("Max messages to return, newest included (default 20, max 100)"),
  }),
  async execute({ channel, limit }, ctx) {
    const resolved = await channelFor(channel, ctx.msgCtx);
    if (!resolved.ok) {
      if (resolved.error === "no_channel") return "Nie wiem, który kanał odczytać - podaj nazwę kanału.";
      if (resolved.error === "not_found") return `Nie znalazłem kanału: ${channel}`;
      return `Nie udało się odczytać kanału: ${errorText(resolved.error)}`;
    }
    const count = typeof limit === "number" ? Math.min(Math.max(limit, 1), 100) : 20;
    const messages = await listMessages(resolved.id, count);
    if (!messages) return "Nie udało się odczytać kanału: :api_error";
    return formatMessages(messages);
  },
});
