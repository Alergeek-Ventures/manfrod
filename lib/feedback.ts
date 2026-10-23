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
  await db.execute(sql`
    INSERT INTO message_feedback (id, user_id, slack_user_id, slack_user_name, slack_channel_id, slack_channel_name,
      message_ts, session_key, rating, permalink, inserted_at, updated_at)
    VALUES (${crypto.randomUUID()}, ${attrs.userId}, ${attrs.slackUserId}, ${attrs.slackUserName}, ${attrs.slackChannelId},
      ${attrs.slackChannelName}, ${attrs.messageTs}, ${attrs.sessionKey}, ${attrs.rating}, ${attrs.permalink},
      timezone('UTC', now()), timezone('UTC', now()))
    ON CONFLICT (slack_channel_id, message_ts, slack_user_id)
    DO UPDATE SET rating = EXCLUDED.rating, permalink = EXCLUDED.permalink,
      slack_user_name = EXCLUDED.slack_user_name, updated_at = EXCLUDED.updated_at
  `);
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
