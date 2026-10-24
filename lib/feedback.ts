import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, tables } from "./db/index.ts";
import type { MessageFeedback, User } from "./db/schema.ts";

const { messageFeedback, users } = tables;

export type FeedbackAttrs = {
  userId: string | null;
  slackUserId: string | null;
  slackUserName: string | null;
  slackChannelId: string;
  slackChannelName: string | null;
  messageTs: string;
  sessionKey: string | null;
  rating: string;
  permalink: string | null;
};

export async function record(attrs: FeedbackAttrs): Promise<void> {
  if (!["good", "bad"].includes(attrs.rating)) throw new Error("rating: is invalid");
  await db
    .insert(messageFeedback)
    .values(attrs)
    .onConflictDoUpdate({
      target: [messageFeedback.slackChannelId, messageFeedback.messageTs, messageFeedback.slackUserId],
      set: {
        rating: sql`excluded.rating`,
        permalink: sql`excluded.permalink`,
        slackUserName: sql`excluded.slack_user_name`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

const since = (days: number) => new Date(Math.floor((Date.now() - days * 86_400_000) / 1000) * 1000);

export async function stats(days: number) {
  const rows = await db
    .select({ rating: messageFeedback.rating, count: sql<number>`count(*)::int` })
    .from(messageFeedback)
    .where(gte(messageFeedback.insertedAt, since(days)))
    .groupBy(messageFeedback.rating);
  const counts = Object.fromEntries(rows.map((row) => [row.rating, Number(row.count)]));
  const good = counts.good ?? 0;
  const bad = counts.bad ?? 0;
  const total = good + bad;
  return { good, bad, total, score: total > 0 ? Math.round((good * 1000) / total) / 10 : null };
}

export async function listNegative(days: number, limit = 50): Promise<(MessageFeedback & { user: User | null })[]> {
  const rows = await db
    .select({ feedback: messageFeedback, user: users })
    .from(messageFeedback)
    .leftJoin(users, eq(users.id, messageFeedback.userId))
    .where(and(eq(messageFeedback.rating, "bad"), gte(messageFeedback.insertedAt, since(days))))
    .orderBy(desc(messageFeedback.insertedAt))
    .limit(limit);
  return rows.map((row) => ({ ...row.feedback, user: row.user }));
}
