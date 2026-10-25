import { eq } from "drizzle-orm";
import { getUser } from "./accounts.ts";
import { db, tables } from "./db/index.ts";
import { EVENTS, sendEvent } from "./inngest/client.ts";
import { agentRuntime, type HandoffAuth } from "./inngest/runtime.ts";
import { logger } from "./log.ts";
import { post } from "./slack/api.ts";

const { proactiveThreads } = tables;
const log = logger("Proactive");

export type ProactiveResult = { ok: true } | { ok: false; error: string };

export const PLACEHOLDER_TEXT = "Thinking...";

export async function sendProactive(userId: string, prompt: string): Promise<ProactiveResult> {
  const user = await getUser(userId);
  if (!user) return { ok: false, error: "user_not_found" };
  if (!user.slackDmChannelId) {
    log.warn(`Proactive: user ${userId} has no DM channel, skipping proactive message`);
    return { ok: false, error: "no_dm_channel" };
  }
  const queued = await sendEvent(EVENTS.proactiveRequested, { userId, prompt });
  return queued ? { ok: true } : { ok: false, error: "queue_unavailable" };
}

export function userAuth(userId: string, slackUserId: string, attributes: Record<string, string | string[]> = {}): HandoffAuth {
  return {
    authenticator: "manfrod",
    principalType: "user",
    principalId: userId,
    attributes: { userId, slackUserId, ...attributes },
  };
}

export async function startThread(channel: string): Promise<{ ok: true; threadTs: string } | { ok: false; error: string }> {
  const result = await post("chat.postMessage", { channel, text: PLACEHOLDER_TEXT });
  if (!result.ok) return { ok: false, error: result.error };
  const threadTs = result.body.ts as string;
  await db.insert(proactiveThreads).values({ channelId: channel, threadTs }).onConflictDoNothing();
  return { ok: true, threadTs };
}

export async function deliverProactive(userId: string, prompt: string, kind = "proactive"): Promise<ProactiveResult> {
  const user = await getUser(userId);
  if (!user?.slackDmChannelId) return { ok: false, error: "no_dm_channel" };
  const channel = user.slackDmChannelId;
  const thread = await startThread(channel);
  if (!thread.ok) {
    log.error(`Proactive: failed to start thread for user ${userId}: ${thread.error}`);
    return thread;
  }
  await agentRuntime().sendToSlack(
    { channelId: channel, threadTs: thread.threadTs },
    prompt,
    userAuth(userId, user.slackId, { kind, channelId: channel, threadTs: thread.threadTs }),
  );
  return { ok: true };
}

export async function isUntitledProactiveThread(channelId: string, threadTs: string): Promise<boolean> {
  const [row] = await db
    .select({ titled: proactiveThreads.titled, channelId: proactiveThreads.channelId })
    .from(proactiveThreads)
    .where(eq(proactiveThreads.threadTs, threadTs))
    .limit(1);
  return !!row && row.channelId === channelId && !row.titled;
}

export async function markProactiveThreadTitled(threadTs: string): Promise<void> {
  await db.update(proactiveThreads).set({ titled: true }).where(eq(proactiveThreads.threadTs, threadTs));
}
