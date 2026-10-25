import { z } from "zod";
import { listFullThread } from "../../lib/slack/api.ts";
import { THREAD_TAIL, blank, channelFor, formatMessages, errorText } from "../lib/slack.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Read a Slack thread: its first message and its latest replies. Call with no arguments to read the thread you are in right now. For another thread, give its thread_ts (shown by read-slack-channel) and its channel.",
  inputSchema: z.object({
    channel: z.string().optional().describe("Channel name or Slack channel ID. Omit for the current channel."),
    thread_ts: z
      .string()
      .optional()
      .describe("thread_ts of the thread's parent message, e.g. '1719000000.123456'. Omit for the current thread."),
  }),
  async execute({ channel, thread_ts }, ctx) {
    const explicit = blank(thread_ts);
    const named = blank(channel);
    const threadTs = explicit ?? ((named === null || named === ctx.msgCtx.channel) && ctx.msgCtx.threadTs ? ctx.msgCtx.threadTs : null);
    if (!threadTs) return "Podaj thread_ts wątku - pokazuje go read-slack-channel przy wiadomościach z odpowiedziami.";
    const resolved = await channelFor(channel, ctx.msgCtx);
    if (!resolved.ok) {
      if (resolved.error === "no_channel") return "Nie wiem, w którym kanale jest ten wątek - podaj kanał.";
      if (resolved.error === "not_found") return `Nie znalazłem kanału: ${channel}`;
      return `Nie udało się odczytać wątku: ${errorText(resolved.error)}`;
    }
    const messages = await listFullThread(resolved.id, threadTs);
    if (!messages) return "Nie udało się odczytać wątku: :api_error";
    const [root, ...replies] = messages;
    const tail = replies.length > THREAD_TAIL && root ? [root, ...replies.slice(-THREAD_TAIL)] : messages;
    return formatMessages(tail);
  },
});
