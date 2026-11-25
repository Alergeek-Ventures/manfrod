import { and, eq, sql } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { WelcomeMessage } from "../db/schema.ts";

const { agentSettings, conversations, messages, nudgeDeliveries, sentDms, welcomeMessages } = tables;

const ENABLED_KEY = "welcome.new_members";

export async function getWelcome(slackId: string): Promise<WelcomeMessage | null> {
  const [row] = await db.select().from(welcomeMessages).where(eq(welcomeMessages.slackId, slackId)).limit(1);
  return row ?? null;
}

export async function claimWelcome(input: { slackId: string; channelId: string; messageTs: string; scheduledFor: Date }): Promise<boolean> {
  const claimed = await db
    .insert(welcomeMessages)
    .values({ ...input, status: "scheduled" })
    .onConflictDoNothing()
    .returning({ slackId: welcomeMessages.slackId });
  return claimed.length > 0;
}

export async function recordSkip(slackId: string, reason: string): Promise<void> {
  await db.insert(welcomeMessages).values({ slackId, status: "skipped", reason }).onConflictDoNothing();
}

export async function markSkipped(slackId: string, reason: string): Promise<void> {
  await db
    .update(welcomeMessages)
    .set({ status: "skipped", reason, updatedAt: new Date() })
    .where(and(eq(welcomeMessages.slackId, slackId), eq(welcomeMessages.status, "scheduled")));
}

export async function markSent(slackId: string, userId: string): Promise<void> {
  await db
    .update(welcomeMessages)
    .set({ status: "sent", userId, sentAt: new Date(), reason: null, updatedAt: new Date() })
    .where(eq(welcomeMessages.slackId, slackId));
}

export async function releaseWelcome(slackId: string): Promise<void> {
  await db.delete(welcomeMessages).where(and(eq(welcomeMessages.slackId, slackId), eq(welcomeMessages.status, "scheduled")));
}

export async function talkedToManfrod(userId: string): Promise<boolean> {
  const found = await Promise.all([
    db
      .select({ one: sql`1` })
      .from(messages)
      .where(eq(messages.userId, userId))
      .limit(1),
    db
      .select({ one: sql`1` })
      .from(conversations)
      .where(eq(conversations.userId, userId))
      .limit(1),
    db
      .select({ one: sql`1` })
      .from(sentDms)
      .where(eq(sentDms.recipientUserId, userId))
      .limit(1),
    db
      .select({ one: sql`1` })
      .from(nudgeDeliveries)
      .where(and(eq(nudgeDeliveries.userId, userId), eq(nudgeDeliveries.sent, true)))
      .limit(1),
  ]);
  return found.some((rows) => rows.length > 0);
}

export async function welcomeEnabled(): Promise<boolean> {
  const [row] = await db.select({ value: agentSettings.value }).from(agentSettings).where(eq(agentSettings.key, ENABLED_KEY)).limit(1);
  return row?.value !== "off";
}

export async function setWelcomeEnabled(enabled: boolean, userId: string | null): Promise<void> {
  const value = enabled ? "on" : "off";
  await db
    .insert(agentSettings)
    .values({ key: ENABLED_KEY, value, updatedByUserId: userId })
    .onConflictDoUpdate({ target: agentSettings.key, set: { value, updatedByUserId: userId, updatedAt: new Date() } });
}
