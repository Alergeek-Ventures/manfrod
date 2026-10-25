import { and, eq } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import { logger } from "../log.ts";
import { listFullThread } from "./api.ts";
import { shared, TtlMap } from "./state.ts";

const { threadKicks } = tables;
const log = logger("ThreadPermission");

type Verdict = "allowed" | "denied" | "kicked";

const ALLOWED_TTL_MS = 24 * 60 * 60 * 1000;
const DENIED_TTL_MS = 5 * 60 * 1000;

const verdicts = shared(
  "threadPermission",
  () => new TtlMap<string, Verdict>((verdict) => (verdict === "denied" ? DENIED_TTL_MS : ALLOWED_TTL_MS)),
);

const key = (channel: string, threadTs: string) => `${channel}:${threadTs}`;

async function kickRow(channel: string, threadTs: string): Promise<boolean> {
  const rows = await db
    .select({ id: threadKicks.id })
    .from(threadKicks)
    .where(and(eq(threadKicks.slackChannelId, channel), eq(threadKicks.threadTs, threadTs)))
    .limit(1);
  return rows.length > 0;
}

export async function allow(channel: string, threadTs: string): Promise<void> {
  await db.delete(threadKicks).where(and(eq(threadKicks.slackChannelId, channel), eq(threadKicks.threadTs, threadTs)));
  verdicts.set(key(channel, threadTs), "allowed");
}

export async function kick(
  channel: string,
  threadTs: string,
  attrs: { userId?: string | null; slackUserId?: string | null; source: "shortcut" | "tool" },
): Promise<boolean> {
  try {
    await db
      .insert(threadKicks)
      .values({
        slackChannelId: channel,
        threadTs,
        userId: attrs.userId ?? null,
        slackUserId: attrs.slackUserId ?? null,
        source: attrs.source,
      })
      .onConflictDoNothing({ target: [threadKicks.slackChannelId, threadKicks.threadTs] });
    verdicts.set(key(channel, threadTs), "kicked");
    return true;
  } catch (error) {
    log.error(`ThreadPermission: failed to kick ${channel}/${threadTs}: ${(error as Error).message}`);
    return false;
  }
}

export async function isKicked(channel: string, threadTs: string): Promise<boolean> {
  const verdict = verdicts.get(key(channel, threadTs));
  if (verdict !== undefined) return verdict === "kicked";
  return kickRow(channel, threadTs);
}

async function mentionedInThread(botUserId: string, channel: string, threadTs: string): Promise<boolean> {
  const messages = await listFullThread(channel, threadTs, 1000);
  if (!messages) {
    log.warn(`ThreadPermission: failed to read thread ${channel}/${threadTs}, assuming not invited`);
    return false;
  }
  return messages.some((message) => typeof message.text === "string" && message.text.includes(`<@${botUserId}>`));
}

export async function isAllowed(botUserId: string, channel: string, threadTs: string): Promise<boolean> {
  const cached = verdicts.get(key(channel, threadTs));
  if (cached !== undefined) return cached === "allowed";

  let verdict: Verdict;
  if (await kickRow(channel, threadTs)) verdict = "kicked";
  else if (await mentionedInThread(botUserId, channel, threadTs)) verdict = "allowed";
  else verdict = "denied";

  verdicts.set(key(channel, threadTs), verdict);
  return verdict === "allowed";
}
