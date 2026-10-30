import { config } from "../config.ts";
import { logger } from "../log.ts";

const BASE_URL = "https://slack.com/api";
const log = logger("Slack.API");

export type SlackBody = Record<string, any>;
export type SlackResult = { ok: true; body: SlackBody } | { ok: false; error: string };

export function botToken(): string {
  return config.slackBotToken ?? "";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function get(endpoint: string, params: Record<string, unknown> = {}, token = botToken()): Promise<SlackResult> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  try {
    const response = await fetch(`${BASE_URL}/${endpoint}?${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await response.json().catch(() => null)) as SlackBody | null;
    if (response.status === 200 && body?.ok === true) return { ok: true, body };
    if (response.status === 200 && body?.ok === false) {
      log.error(`Slack API error on GET ${endpoint}: ${body.error}`);
      return { ok: false, error: String(body.error) };
    }
    log.error(`Slack API unexpected response on GET ${endpoint}: HTTP ${response.status}`);
    return { ok: false, error: `unexpected_status_${response.status}` };
  } catch (error) {
    log.error(`Slack API transport error on GET ${endpoint}: ${(error as Error).message}`);
    return { ok: false, error: (error as Error).message };
  }
}

export async function post(endpoint: string, body: SlackBody = {}, token = botToken(), retried = false): Promise<SlackResult> {
  try {
    const response = await fetch(`${BASE_URL}/${endpoint}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });

    if (response.status === 429) {
      if (retried) {
        log.error(`Slack API rate limited on POST ${endpoint} after retry`);
        return { ok: false, error: "rate_limited" };
      }
      const retryAfter = Number(response.headers.get("retry-after") ?? "1") || 1;
      log.warn(`Slack API rate limited on POST ${endpoint}, retrying in ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      return post(endpoint, body, token, true);
    }

    const json = (await response.json().catch(() => null)) as SlackBody | null;
    if (response.status === 200 && json?.ok === true) return { ok: true, body: json };
    if (response.status === 200 && json?.ok === false) {
      log.error(`Slack API error on POST ${endpoint}: ${json.error}`);
      return { ok: false, error: String(json.error) };
    }
    log.error(`Slack API unexpected response on POST ${endpoint}: HTTP ${response.status}`);
    return { ok: false, error: `unexpected_status_${response.status}` };
  } catch (error) {
    log.error(`Slack API transport error on POST ${endpoint}: ${(error as Error).message}`);
    return { ok: false, error: (error as Error).message };
  }
}

interface CacheEntry {
  value: unknown;
  at: number;
}

const LOOKUP_TTL_MS = 60 * 60 * 1000;
const lookupCache = new Map<string, CacheEntry>();

async function cached<T>(key: string, fetcher: () => Promise<T | null>): Promise<T | null> {
  const entry = lookupCache.get(key);
  if (entry && Date.now() - entry.at < LOOKUP_TTL_MS) return entry.value as T;
  const value = await fetcher();
  if (value !== null) lookupCache.set(key, { value, at: Date.now() });
  return value;
}

export function clearLookupCache() {
  lookupCache.clear();
}

async function userInfo(slackUserId: string): Promise<SlackBody | null> {
  return cached(`user:${slackUserId}`, async () => {
    const result = await get("users.info", { user: slackUserId });
    return result.ok && result.body.user ? (result.body.user as SlackBody) : null;
  });
}

function displayName(user: SlackBody): string | null {
  if (typeof user.real_name === "string" && user.real_name !== "") return user.real_name;
  if (typeof user.name === "string" && user.name !== "") return user.name;
  return null;
}

export async function fetchUserName(slackUserId: string): Promise<string | null> {
  const user = await userInfo(slackUserId);
  return user ? displayName(user) : null;
}

export async function fetchUserInfo(slackUserId: string): Promise<{ name: string | null; email: string | null } | null> {
  const user = await userInfo(slackUserId);
  if (!user) return null;
  return { name: displayName(user), email: user.profile?.email ?? null };
}

export async function deactivatedSlackIds(): Promise<Set<string>> {
  const ids = await cached("users:deactivated", async () => {
    const deleted: string[] = [];
    let cursor = "";
    do {
      const result = await get("users.list", { limit: 200, ...(cursor ? { cursor } : {}) });
      if (!result.ok) return null;
      for (const member of (result.body.members ?? []) as SlackBody[]) if (member.deleted) deleted.push(member.id);
      cursor = result.body.response_metadata?.next_cursor ?? "";
    } while (cursor);
    return deleted;
  });
  return new Set(ids ?? []);
}

export async function getChannelInfo(channel: string): Promise<SlackBody | null> {
  return cached(`channel:${channel}`, async () => {
    const result = await get("conversations.info", { channel });
    return result.ok && result.body.channel ? (result.body.channel as SlackBody) : null;
  });
}

export function addReaction(channel: string, ts: string, emoji: string) {
  return post("reactions.add", { channel, timestamp: ts, name: emoji });
}

export function setStatus(channel: string, threadTs: string, status: string) {
  return post("assistant.threads.setStatus", { channel_id: channel, thread_ts: threadTs, status });
}

export function setTitle(channel: string, threadTs: string, title: string) {
  return post("assistant.threads.setTitle", { channel_id: channel, thread_ts: threadTs, title });
}

export function setSuggestedPrompts(
  channel: string,
  threadTs: string | null | undefined,
  prompts: { title: string; message: string }[],
  title?: string,
) {
  const body: SlackBody = { channel_id: channel, prompts };
  if (threadTs) body.thread_ts = threadTs;
  if (title) body.title = title;
  return post("assistant.threads.setSuggestedPrompts", body);
}

export async function startStream(channel: string, threadTs: string, opts: SlackBody = {}): Promise<string | null> {
  const result = await post("chat.startStream", { ...opts, channel, thread_ts: threadTs });
  return result.ok && typeof result.body.ts === "string" ? result.body.ts : null;
}

export function appendStream(channel: string, ts: string, chunks: SlackBody[]) {
  return post("chat.appendStream", { channel, ts, chunks });
}

export function stopStream(channel: string, ts: string, chunks: SlackBody[] = []) {
  return post("chat.stopStream", chunks.length > 0 ? { channel, ts, chunks } : { channel, ts });
}

export async function uploadFile(channel: string, filename: string, bytes: Buffer, title = filename): Promise<SlackResult> {
  const form = new URLSearchParams({ filename, length: String(bytes.length) });
  let uploadUrl: string;
  let fileId: string;
  try {
    const response = await fetch(`${BASE_URL}/files.getUploadURLExternal`, {
      method: "POST",
      headers: { authorization: `Bearer ${botToken()}`, "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const body = (await response.json()) as SlackBody;
    if (!body.ok) return { ok: false, error: String(body.error) };
    uploadUrl = body.upload_url;
    fileId = body.file_id;
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const multipart = new FormData();
  multipart.append("file", new Blob([new Uint8Array(bytes)]), filename);
  const upload = await fetch(uploadUrl, { method: "POST", body: multipart }).catch((error: Error) => error);
  if (upload instanceof Error) return { ok: false, error: upload.message };
  if (upload.status !== 200) return { ok: false, error: `upload_failed_${upload.status}` };

  return post("files.completeUploadExternal", { channel_id: channel, files: [{ id: fileId, title }] });
}

export async function listChannels(opts: { types?: string; limit?: number } = {}): Promise<SlackBody[] | null> {
  const result = await get("conversations.list", {
    types: opts.types ?? "public_channel,private_channel",
    limit: opts.limit ?? 200,
    exclude_archived: true,
  });
  return result.ok ? (result.body.channels as SlackBody[]) : null;
}

export async function getPermalink(channel: string, messageTs: string): Promise<string | null> {
  const result = await get("chat.getPermalink", { channel, message_ts: messageTs });
  return result.ok && typeof result.body.permalink === "string" ? result.body.permalink : null;
}

export function deleteMessage(channel: string, ts: string) {
  return post("chat.delete", { channel, ts });
}

export async function listMessages(channel: string, limit = 20): Promise<SlackBody[] | null> {
  const result = await get("conversations.history", { channel, limit });
  return result.ok ? [...(result.body.messages as SlackBody[])].reverse() : null;
}

export async function channelHistory(channel: string, oldest: string, limit = 200): Promise<SlackBody[] | null> {
  const result = await get("conversations.history", { channel, oldest, limit });
  return result.ok ? (result.body.messages as SlackBody[]) : null;
}

export async function channelMembers(channel: string): Promise<string[] | null> {
  const result = await get("conversations.members", { channel, limit: 1000 });
  return result.ok ? (result.body.members as string[]) : null;
}

export async function isActive(slackUserId: string): Promise<boolean> {
  const result = await get("users.getPresence", { user: slackUserId });
  return result.ok && result.body.presence === "active";
}

export async function listFullThread(channel: string, threadTs: string, max = 1000): Promise<SlackBody[] | null> {
  let acc: SlackBody[] = [];
  let cursor: string | undefined;
  for (;;) {
    const result = await get("conversations.replies", { channel, ts: threadTs, limit: 200, cursor });
    if (!result.ok) return acc.length === 0 ? null : acc;
    const seen = new Set(acc.map((message) => message.ts));
    acc = [...acc, ...(result.body.messages as SlackBody[]).filter((message) => !seen.has(message.ts))];
    const next = result.body.response_metadata?.next_cursor;
    if (result.body.has_more === true && typeof next === "string" && next !== "" && acc.length < max) {
      cursor = next;
      continue;
    }
    return acc.slice(0, max);
  }
}

export async function respond(responseUrl: string, body: SlackBody): Promise<boolean> {
  try {
    const response = await fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

export async function openDm(slackUserId: string): Promise<string | null> {
  const result = await post("conversations.open", { users: slackUserId });
  return result.ok ? (result.body.channel?.id ?? null) : null;
}

export async function listCanvases(channel?: string): Promise<SlackBody[] | null> {
  const result = await get("files.list", { types: "canvas", channel });
  return result.ok ? (result.body.files as SlackBody[]) : null;
}

export async function getChannelCanvasId(channel: string): Promise<string | null | undefined> {
  const info = await getChannelInfo(channel);
  if (!info) return undefined;
  return info.properties?.canvas?.file_id ?? null;
}

export async function getFileInfo(fileId: string): Promise<SlackBody | null> {
  const result = await get("files.info", { file: fileId });
  return result.ok ? (result.body.file as SlackBody) : null;
}

export async function downloadFile(urlPrivate: string): Promise<string | null> {
  try {
    const response = await fetch(urlPrivate, { headers: { authorization: `Bearer ${botToken()}` } });
    if (response.status !== 200) {
      log.error(`Slack file download failed: HTTP ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (error) {
    log.error(`Slack file download transport error: ${(error as Error).message}`);
    return null;
  }
}

export async function resolveChannel(id: string | null | undefined): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!id) return { ok: false, error: "not_found" };
  if (/^[CGD][A-Z0-9]{8,}$/.test(id)) return { ok: true, id };
  const wanted = id.replace(/^#/, "").toLowerCase();
  const channels = await listChannels();
  if (!channels) return { ok: false, error: "list_failed" };
  const found = channels.find((channel) => String(channel.name ?? "").toLowerCase() === wanted);
  return found ? { ok: true, id: found.id } : { ok: false, error: "not_found" };
}

let identity: { botId: string; userId: string; teamId: string; url: string } | null = null;

export async function botIdentity(): Promise<{ botId: string; userId: string; teamId: string; url: string } | null> {
  if (identity) return identity;
  const result = await get("auth.test");
  if (!result.ok) return null;
  identity = { botId: result.body.bot_id, userId: result.body.user_id, teamId: result.body.team_id, url: result.body.url };
  return identity;
}

export const archiveLink = (workspaceUrl: string, channel: string, ts: string) =>
  `${workspaceUrl.replace(/\/$/, "")}/archives/${channel}/p${ts.replace(".", "")}`;
