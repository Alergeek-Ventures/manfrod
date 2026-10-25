import { mkdirSync, writeFileSync } from "node:fs";
import { get, type SlackBody } from "../lib/slack/api.ts";
import { config } from "../lib/config.ts";

const DEFAULT_LIMIT = 30;
const HISTORY_DELAY_MS = 1_200;
const USER_DELAY_MS = 300;
const PAGE_DELAY_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const info = (message: string) => console.log(message);

if (!config.slackBotToken) throw new Error("SLACK_BOT_TOKEN not configured in Infisical or .env.worktree");
const limit = process.argv[2] ? Number.parseInt(process.argv[2], 10) : DEFAULT_LIMIT;

const member = (channel: SlackBody) => channel.is_member === true || channel.is_im === true || channel.is_private === true;

async function listAllChannels(): Promise<SlackBody[]> {
  const acc: SlackBody[] = [];
  let cursor: string | undefined;
  for (;;) {
    const result = await get("conversations.list", { types: "public_channel,private_channel,im", limit: 200, exclude_archived: true, cursor });
    if (!result.ok) {
      console.warn(`conversations.list failed: ${result.error}`);
      return acc;
    }
    acc.push(...(result.body.channels as SlackBody[]).filter(member));
    const next = result.body.response_metadata?.next_cursor;
    if (typeof next !== "string" || next === "") return acc;
    cursor = next;
    await sleep(PAGE_DELAY_MS);
  }
}

const userCache = new Map<string, string>();

async function userName(userId: string): Promise<string> {
  const cached = userCache.get(userId);
  if (cached) return cached;
  const result = await get("users.info", { user: userId });
  const user = result.ok ? (result.body.user as SlackBody) : null;
  const name = user?.real_name || user?.name || userId;
  userCache.set(userId, name);
  await sleep(USER_DELAY_MS);
  return name;
}

const SYSTEM_SUBTYPES = new Set(["channel_join", "channel_leave", "channel_archive", "channel_purpose"]);

function guessKind(channel: SlackBody): string {
  if (channel.is_im) return "dm";
  if (typeof channel.name !== "string") return "unknown";
  if (channel.name.startsWith("av-x-")) return "project_public_client";
  if (channel.name.startsWith("prywatnie-o-")) return "project_internal";
  return "company";
}

function label(channel: SlackBody): string {
  if (channel.is_im) return channel.user ? `DM (user ${channel.user})` : "DM (unknown user)";
  if (channel.name) return channel.is_private ? `#${channel.name} [private]` : `#${channel.name}`;
  return channel.id;
}

info("Fetching workspace info...");
const team = await get("team.info");
const teamId = team.ok ? team.body.team.id : "unknown";
const teamName = team.ok ? team.body.team.name : "unknown";
info(`Workspace: ${teamName} (${teamId})`);

info("Listing joined channels and DMs...");
const channels = await listAllChannels();
info(`Found ${channels.length} channels/DMs`);
info(`Fetching message history (${limit} messages per channel)...`);

const exported = [];
for (const channel of channels) {
  info(`  → ${label(channel)}`);
  const history = await get("conversations.history", { channel: channel.id, limit });
  if (!history.ok) console.warn(`conversations.history failed for ${channel.id}: ${history.error}`);
  const messages = history.ok ? (history.body.messages as SlackBody[]) : [];
  const enriched = [];
  for (const message of messages.filter((candidate) => !SYSTEM_SUBTYPES.has(candidate.subtype) && !candidate.bot_id)) {
    enriched.push({
      ts: message.ts,
      user_id: message.user ?? null,
      user_name: message.user ? await userName(message.user) : null,
      text: message.text,
      thread_ts: message.thread_ts ?? null,
      reply_count: message.reply_count ?? 0,
    });
  }
  await sleep(HISTORY_DELAY_MS);
  exported.push({
    id: channel.id,
    name: channel.name ?? null,
    is_private: channel.is_private ?? false,
    is_im: channel.is_im ?? false,
    dm_user_id: channel.user ?? null,
    guessed_kind: guessKind(channel),
    message_count: enriched.length,
    messages: enriched,
  });
}

const total = exported.reduce((sum, channel) => sum + channel.message_count, 0);
mkdirSync("eval", { recursive: true });
writeFileSync(
  "eval/slack_raw.json",
  JSON.stringify(
    { exported_at: new Date().toISOString(), workspace_id: teamId, workspace_name: teamName, channel_count: exported.length, total_messages: total, channels: exported },
    null,
    2,
  ),
);

info("");
info(`Saved ${total} messages from ${exported.length} channels to eval/slack_raw.json`);
info("");
info("Next steps:");
info("  1. Open eval/slack_raw.json and review messages");
info("  2. Copy interesting samples to eval/dataset.json (see eval/dataset_template.json)");
info("  3. Fill in labels: channel_kind, expected_action, target_scope, safety_class, fact_kind, requires_review, reason");
info("  4. Run: pnpm eval:memory");
info("");
info("⚠️  Do NOT commit eval/slack_raw.json — it contains real Slack messages.");
process.exit(0);
