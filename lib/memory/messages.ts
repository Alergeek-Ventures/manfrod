import { and, asc, desc, eq, gte, inArray, isNull, max } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { Conversation, Message } from "../db/schema.ts";

const { messages, conversations } = tables;

export interface MessageAttrs {
  role: "user" | "assistant";
  content: string;
  sessionKey: string;
  receivedAt: Date;
  conversationId?: string | null;
}

export async function createMessage(userId: string, attrs: MessageAttrs): Promise<Message> {
  if (!["user", "assistant"].includes(attrs.role)) throw new Error("role: is invalid");
  if (attrs.content.trim() === "") throw new Error("content: can't be blank");
  const [message] = await db
    .insert(messages)
    .values({
      userId,
      role: attrs.role,
      content: attrs.content,
      sessionKey: attrs.sessionKey,
      receivedAt: attrs.receivedAt,
      conversationId: attrs.conversationId ?? null,
    })
    .returning();
  return message;
}

export async function getPendingMessages(userId: string, sessionKey: string): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.sessionKey, sessionKey), isNull(messages.conversationId)))
    .orderBy(asc(messages.receivedAt));
}

export async function getPendingMessagesForSession(sessionKey: string): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionKey, sessionKey), isNull(messages.conversationId)))
    .orderBy(asc(messages.receivedAt));
}

export async function pendingAuthorsForSession(sessionKey: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: messages.userId })
    .from(messages)
    .where(and(eq(messages.sessionKey, sessionKey), isNull(messages.conversationId)));
  return rows.map((row) => row.userId);
}

function windowStart(windowHours: number | null): Date | null {
  return windowHours === null ? null : new Date(Date.now() - windowHours * 3_600_000);
}

export async function getRecentSessionMessages(
  sessionKey: string,
  opts: { limit?: number; windowHours?: number | null } = {},
): Promise<Message[]> {
  const since = windowStart(opts.windowHours === undefined ? 24 : opts.windowHours);
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionKey, sessionKey), since ? gte(messages.receivedAt, since) : undefined))
    .orderBy(desc(messages.receivedAt), desc(messages.insertedAt))
    .limit(opts.limit ?? 60);
  return rows.reverse();
}

export async function lastSessionMessageAt(sessionKey: string, windowHours: number | null): Promise<Date | null> {
  const since = windowStart(windowHours);
  const [row] = await db
    .select({ last: max(messages.receivedAt) })
    .from(messages)
    .where(and(eq(messages.sessionKey, sessionKey), since ? gte(messages.receivedAt, since) : undefined));
  return row?.last ?? null;
}

export async function closeConversation(
  userId: string,
  sessionKey: string,
  attrs: { summary: string; access: string[]; slackChannelId: string | null },
): Promise<Conversation | null> {
  return db.transaction(async (tx) => {
    const pending = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.sessionKey, sessionKey), isNull(messages.conversationId)))
      .orderBy(asc(messages.receivedAt))
      .for("update");
    if (pending.length === 0) return null;

    const [conversation] = await tx
      .insert(conversations)
      .values({
        userId,
        sessionKey,
        summary: attrs.summary,
        access: attrs.access,
        slackChannelId: attrs.slackChannelId,
        startedAt: pending[0].receivedAt,
        endedAt: pending[pending.length - 1].receivedAt,
      })
      .returning();

    await tx
      .update(messages)
      .set({ conversationId: conversation.id })
      .where(inArray(messages.id, pending.map((message) => message.id)));

    return conversation;
  });
}

export async function getConversationWithMessages(userId: string, conversationId: string) {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.userId, userId), eq(conversations.id, conversationId)))
    .limit(1);
  if (!conversation) return null;
  const items = await db.select().from(messages).where(eq(messages.conversationId, conversation.id));
  return { ...conversation, messages: items };
}
