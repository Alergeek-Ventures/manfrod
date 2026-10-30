import { containsSecret } from "../../lib/security/secrets.ts";
import { channelMembers, downloadFile, fetchUserName, getFileInfo, resolveChannel, type SlackBody } from "../../lib/slack/api.ts";
import { formatLocal, slackTsToDate } from "../../lib/time.ts";
import { type MsgCtx } from "../../lib/../lib/agent/context.ts";

export const THREAD_TAIL = 100;
export const MENTION_RE = /<@([A-Z0-9]+)>/g;

export const blank = (value: string | undefined | null) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

export async function channelFor(channel: string | undefined, current: MsgCtx) {
  const target = blank(channel) ?? current.channel;
  if (!target) return { ok: false as const, error: "no_channel" };
  return resolveChannel(target);
}

export function authorName(message: SlackBody, names: Map<string, string>): string {
  if (typeof message.bot_id === "string") {
    if (typeof message.username === "string" && message.username !== "") return `${message.username} (bot)`;
    if (typeof message.bot_profile?.name === "string" && message.bot_profile.name !== "") return `${message.bot_profile.name} (bot)`;
    return "bot";
  }
  if (typeof message.user === "string") {
    const name = names.get(message.user);
    return name ? `${name} <${message.user}>` : message.user;
  }
  return "?";
}

export async function formatMessages(messages: SlackBody[]): Promise<string> {
  if (messages.length === 0) return "Brak wiadomości.";
  const ids = new Set<string>();
  for (const message of messages) {
    if (typeof message.user === "string") ids.add(message.user);
    for (const match of String(message.text ?? "").matchAll(MENTION_RE)) ids.add(match[1]);
  }
  const names = new Map<string, string>();
  for (const id of ids) {
    const name = await fetchUserName(id);
    if (name) names.set(id, name);
  }

  return messages
    .map((message) => {
      const time = message.ts ? formatLocal(slackTsToDate(message.ts)) : "?";
      const raw = String(message.text ?? "");
      const text = containsSecret(raw)
        ? "[wiadomość ukryta — wygląda na klucz API/hasło]"
        : raw.replace(MENTION_RE, (whole, id: string) => (names.get(id) ? `${whole} (${names.get(id)})` : whole));
      const count = message.reply_count;
      const thread =
        typeof count === "number" && count > 0
          ? ` (${count} ${count === 1 ? "odpowiedź" : "odpowiedzi"} w wątku, thread_ts: ${message.ts})`
          : "";
      return `[${time}] ${authorName(message, names)}: ${text}${thread}`;
    })
    .join("\n");
}

export const errorText = (error: string) => `:${error}`;

export async function isChannelMember(channelId: string, slackUserId: string): Promise<boolean> {
  return ((await channelMembers(channelId)) ?? []).includes(slackUserId);
}

export async function readCanvas(fileId: string): Promise<string> {
  const info = await getFileInfo(fileId);
  if (!info?.url_private) return "Nie udało się odczytać canvasu: :not_found";
  const content = await downloadFile(info.url_private);
  return content ?? "Nie udało się odczytać canvasu: :download_failed";
}
