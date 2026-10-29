import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { isSystemUser } from "../accounts.ts";
import { db, tables } from "../db/index.ts";
import type { SentDm, User } from "../db/schema.ts";
import { isEnabled } from "../nudges/store.ts";
import { channelHistory, deactivatedSlackIds, listFullThread, post } from "../slack/api.ts";

const { sentDms } = tables;

export const DM_COOLDOWN_MINUTES = 120;

export async function dmRefusal(recipient: User, taskId: string | null): Promise<string | null> {
  if (isSystemUser(recipient) || recipient.banned) return `${recipient.name ?? recipient.id} can't receive messages from you.`;
  if ((await deactivatedSlackIds()).has(recipient.slackId)) return `${recipient.name ?? recipient.id}'s Slack account is deactivated.`;
  if (!(await isEnabled(recipient.id, "requests")))
    return `${recipient.name ?? recipient.id} turned off messages sent on other people's behalf (set-proactive-preferences "requests"). Ask in a shared channel instead.`;
  const since = new Date(Date.now() - DM_COOLDOWN_MINUTES * 60_000);
  const [recent] = await db
    .select({ at: sentDms.insertedAt })
    .from(sentDms)
    .where(
      and(
        eq(sentDms.recipientUserId, recipient.id),
        taskId ? eq(sentDms.taskId, taskId) : isNull(sentDms.taskId),
        gte(sentDms.insertedAt, since),
      ),
    )
    .limit(1);
  if (recent)
    return `You already wrote to ${recipient.name ?? recipient.id} about this less than ${DM_COOLDOWN_MINUTES} minutes ago; give them time.`;
  return null;
}

export async function sendDm(input: {
  recipient: User;
  senderUserId: string | null;
  taskId: string | null;
  text: string;
}): Promise<{ ok: true; ts: string } | { ok: false; error: string }> {
  const result = await post("chat.postMessage", { channel: input.recipient.slackDmChannelId, text: input.text });
  if (!result.ok) return { ok: false, error: result.error };
  const ts = result.body.ts as string;
  await db.insert(sentDms).values({
    taskId: input.taskId,
    senderUserId: input.senderUserId,
    recipientUserId: input.recipient.id,
    channelId: input.recipient.slackDmChannelId,
    messageTs: ts,
    text: input.text,
  });
  return { ok: true, ts };
}

export async function taskDms(taskId: string): Promise<SentDm[]> {
  return db.select().from(sentDms).where(eq(sentDms.taskId, taskId)).orderBy(desc(sentDms.insertedAt)).limit(30);
}

export async function repliedSince(dm: SentDm, slackUserId: string): Promise<boolean> {
  const later = (await channelHistory(dm.channelId, dm.messageTs, 50)) ?? [];
  const thread = (await listFullThread(dm.channelId, dm.messageTs, 50)) ?? [];
  return [...later, ...thread].some((message) => message.user === slackUserId && Number(message.ts) > Number(dm.messageTs));
}
