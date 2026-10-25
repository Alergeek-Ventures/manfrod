import { z } from "zod";
import { containsSecret } from "../security/secrets.ts";
import {
  deleteMessage,
  downloadFile,
  fetchUserName,
  getChannelCanvasId,
  getFileInfo,
  listCanvases,
  listChannels,
  listFullThread,
  listMessages,
  resolveChannel,
  type SlackBody,
} from "../slack/api.ts";
import { formatLocal, slackTsToDate } from "../time.ts";
import { spec, type MsgCtx } from "./context.ts";

const THREAD_TAIL = 100;
const MENTION_RE = /<@([A-Z0-9]+)>/g;

const blank = (value: string | undefined | null) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

async function channelFor(channel: string | undefined, current: MsgCtx) {
  const target = blank(channel) ?? current.channel;
  if (!target) return { ok: false as const, error: "no_channel" };
  return resolveChannel(target);
}

function authorName(message: SlackBody, names: Map<string, string>): string {
  if (typeof message.bot_id === "string") {
    if (typeof message.username === "string" && message.username !== "") return `${message.username} (bot)`;
    if (typeof message.bot_profile?.name === "string" && message.bot_profile.name !== "") return `${message.bot_profile.name} (bot)`;
    return "bot";
  }
  if (typeof message.user === "string") return names.get(message.user) ?? message.user;
  return "?";
}

async function formatMessages(messages: SlackBody[]): Promise<string> {
  if (messages.length === 0) return "Brak wiadomości.";
  const ids = new Set<string>();
  for (const message of messages) {
    if (typeof message.user === "string") ids.add(message.user);
    for (const match of String(message.text ?? "").matchAll(MENTION_RE)) ids.add(match[1]);
  }
  const names = new Map<string, string>();
  for (const id of ids) names.set(id, (await fetchUserName(id)) ?? id);

  return messages
    .map((message) => {
      const time = message.ts ? formatLocal(slackTsToDate(message.ts)) : "?";
      const raw = String(message.text ?? "");
      const text = containsSecret(raw)
        ? "[wiadomość ukryta — wygląda na klucz API/hasło]"
        : raw.replace(MENTION_RE, (_whole, id: string) => `@${names.get(id) ?? id}`);
      const count = message.reply_count;
      const thread =
        typeof count === "number" && count > 0
          ? ` (${count} ${count === 1 ? "odpowiedź" : "odpowiedzi"} w wątku, thread_ts: ${message.ts})`
          : "";
      return `[${time}] ${authorName(message, names)}: ${text}${thread}`;
    })
    .join("\n");
}

const errorText = (error: string) => `:${error}`;

async function readCanvas(fileId: string): Promise<string> {
  const info = await getFileInfo(fileId);
  if (!info?.url_private) return "Nie udało się odczytać canvasu: :not_found";
  const content = await downloadFile(info.url_private);
  return content ?? "Nie udało się odczytać canvasu: :download_failed";
}

export const tools = {
  read_slack_channel: spec({
    description:
      "Read recent top-level messages from a Slack channel (the current one when no channel is given). Messages that have a thread show its thread_ts - pass it to read_slack_thread to read that thread. Use list_slack_channels first if you're not sure of a channel name.",
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
  }),

  read_slack_thread: spec({
    description:
      "Read a Slack thread: its first message and its latest replies. Call with no arguments to read the thread you are in right now. For another thread, give its thread_ts (shown by read_slack_channel) and its channel.",
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
      const threadTs =
        explicit ?? ((named === null || named === ctx.msgCtx.channel) && ctx.msgCtx.threadTs ? ctx.msgCtx.threadTs : null);
      if (!threadTs) return "Podaj thread_ts wątku - pokazuje go read_slack_channel przy wiadomościach z odpowiedziami.";
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
  }),

  list_slack_channels: spec({
    description:
      "List Slack channels the bot can see, with their IDs and names. Use this to look up a channel_id when a user refers to a channel by name (e.g. for show_desk_map's channel_id argument).",
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
  }),

  delete_slack_message: spec({
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
  }),

  list_slack_canvases: spec({
    description:
      "List canvases (document-like pages) attached to a Slack channel, including its pinned channel canvas if it has one. Use before read_slack_canvas if you don't already know which canvas or file ID to read.",
    inputSchema: z.object({
      channel: z.string().describe("Channel name (e.g. 'general' or '#general') or Slack channel ID"),
    }),
    async execute({ channel }) {
      const resolved = await resolveChannel(channel);
      if (!resolved.ok) {
        return resolved.error === "not_found"
          ? `Nie znalazłem kanału: ${channel}`
          : `Nie udało się pobrać listy canvasów: ${errorText(resolved.error)}`;
      }
      const files = await listCanvases(resolved.id);
      if (!files) return "Nie udało się pobrać listy canvasów: :api_error";
      if (files.length === 0) return "Brak canvasów w tym kanale.";
      const pinned = (await getChannelCanvasId(resolved.id)) ?? null;
      return files
        .map((file) => `${file.id}: ${file.title ?? "(bez tytułu)"}${file.id === pinned ? " [canvas kanału]" : ""}`)
        .join("\n");
    },
  }),

  read_slack_canvas: spec({
    description:
      "Read the full markdown content of a Slack canvas. Give a channel to read that channel's pinned canvas, or a specific canvas/file ID (from list_slack_canvases) to read a particular one.",
    inputSchema: z.object({
      channel: z.string().optional().describe("Channel name or ID whose pinned canvas to read. Ignored if canvas_id is given."),
      canvas_id: z.string().optional().describe("Specific canvas/file ID to read, e.g. from list_slack_canvases (e.g. 'F123ABC')"),
    }),
    async execute({ channel, canvas_id }) {
      if (canvas_id) return readCanvas(canvas_id);
      if (!channel) return "Podaj channel lub canvas_id.";
      const resolved = await resolveChannel(channel);
      if (!resolved.ok) {
        return resolved.error === "not_found"
          ? `Nie znalazłem kanału: ${channel}`
          : `Nie udało się odczytać canvasu: ${errorText(resolved.error)}`;
      }
      const fileId = await getChannelCanvasId(resolved.id);
      if (fileId === undefined) return "Nie udało się odczytać canvasu: :api_error";
      if (fileId === null) return "Ten kanał nie ma przypiętego canvasu.";
      return readCanvas(fileId);
    },
  }),
};
