import { containsSecret } from "../../lib/security/secrets.ts";
import {
  channelMembers,
  downloadFile,
  fetchUserName,
  getChannelCanvasId,
  getFileInfo,
  resolveChannel,
  type SlackBody,
} from "../../lib/slack/api.ts";
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

export async function resolveCanvas(
  channel: string | undefined,
  canvasId: string | undefined,
): Promise<{ ok: true; id: string; channelId: string | null } | { ok: false; message: string }> {
  if (blank(canvasId)) return { ok: true, id: canvasId!.trim(), channelId: null };
  if (!blank(channel)) return { ok: false, message: "Give a channel or a canvas_id." };
  const resolved = await resolveChannel(channel!.trim());
  if (!resolved.ok) {
    return {
      ok: false,
      message:
        resolved.error === "not_found" ? `Channel not found: ${channel}` : `Could not find the channel: ${errorText(resolved.error)}`,
    };
  }
  const fileId = await getChannelCanvasId(resolved.id);
  if (fileId === undefined) return { ok: false, message: "Could not read the channel info: :api_error" };
  if (fileId === null) return { ok: false, message: "This channel has no pinned canvas." };
  return { ok: true, id: fileId, channelId: resolved.id };
}

export function canvasChannels(file: SlackBody): string[] {
  const ids = [
    ...(file.channels ?? []),
    ...(file.groups ?? []),
    ...Object.keys(file.shares?.public ?? {}),
    ...Object.keys(file.shares?.private ?? {}),
  ];
  return [...new Set(ids.map(String))];
}

export async function canvasLink(fileId: string): Promise<string | null> {
  const info = await getFileInfo(fileId);
  return typeof info?.permalink === "string" ? info.permalink : null;
}

export async function canvasEditDenial(
  canvas: { id: string; channelId: string | null },
  person: { slackId: string; name: string | null },
): Promise<string | null> {
  if (canvas.channelId?.startsWith("D")) return "Canvases in direct messages can't be edited.";
  let channels = canvas.channelId ? [canvas.channelId] : [];
  if (!canvas.channelId) {
    const file = await getFileInfo(canvas.id);
    if (!file) return "Could not read the canvas details, so I changed nothing.";
    channels = canvasChannels(file).filter((id) => !id.startsWith("D"));
    if (channels.length === 0) return "This canvas isn't shared in any channel, so I can't check that you may edit it.";
  }
  for (const channel of channels) if (await isChannelMember(channel, person.slackId)) return null;
  const where = channels.map((id) => `<#${id}>`).join(", ");
  return `${person.name ?? person.slackId} is not a member of ${where}, so you can't edit this canvas for them.`;
}

export function canvasErrorText(error: string, scope: string): string {
  if (error === "missing_scope")
    return `the Slack app lacks the ${scope} scope; an admin has to add it to the bot token scopes and reinstall the app`;
  if (error === "canvas_not_found" || error === "not_found") return "canvas not found or not shared with the bot";
  if (error === "access_denied" || error === "not_allowed" || error === "restricted_action")
    return "the bot has no edit access to this canvas; someone has to share it with the bot with edit rights";
  return errorText(error);
}
