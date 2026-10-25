import { and, asc, eq, gte, like, lte } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { Node } from "../db/schema.ts";
import { MEMORY_CHAIN, generateText, system, user } from "../llm/index.ts";
import { embedQuery } from "../voyage.ts";
import { privateLevel } from "./access.ts";
import { createNode, getSoul, setSoul } from "./nodes.ts";

const { messages } = tables;

const WELCOME_WINDOW_MS = 24 * 60 * 60 * 1000;
const WELCOME_MESSAGES = 60;
const WELCOME_CHARS = 20_000;
export const NO_SOUL = "NONE";

const SOUL_PROMPT = `You write the "soul" of Manfrod, a Slack assistant, for one person: Manfrod's
own private note about who it is for them and who they are. It opens every
conversation with them, so it must hold what lasts.

You get the first direct-message conversation between Manfrod and this person,
where Manfrod asked them to introduce themselves and to shape its personality.

Write the soul in the language the person used, in Manfrod's first person, as
two short parts:
1. Who I am for this person - personality, tone, how to address them, how long
   and how formal answers should be. Only what they asked for or agreed to; if
   they said nothing about it, keep this part to the tone they used.
2. Who they are - role, work, interests, goals, values and what they expect
   from Manfrod.

Use only what the person said or explicitly agreed to. Never invent details,
never keep Manfrod's own unanswered suggestions, and skip setup trivia such as
where Manfrod is deployed. Keep it under 120 words, plain text, no headings.

If the person shared nothing about themselves or how Manfrod should be, reply
with exactly ${NO_SOUL}.`;

const dmOf = (userId: string) => and(eq(messages.userId, userId), like(messages.sessionKey, "D%"));

async function firstDmAt(userId: string): Promise<Date | null> {
  const [first] = await db
    .select({ receivedAt: messages.receivedAt })
    .from(messages)
    .where(dmOf(userId))
    .orderBy(asc(messages.receivedAt))
    .limit(1);
  return first?.receivedAt ?? null;
}

export async function welcomeTranscript(userId: string): Promise<string> {
  const start = await firstDmAt(userId);
  if (!start) return "";

  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(and(dmOf(userId), gte(messages.receivedAt, start), lte(messages.receivedAt, new Date(start.getTime() + WELCOME_WINDOW_MS))))
    .orderBy(asc(messages.receivedAt), asc(messages.insertedAt))
    .limit(WELCOME_MESSAGES);
  return rows
    .map((row) => `${row.role === "user" ? "Person" : "Manfrod"}: ${row.content.trim()}`)
    .join("\n\n")
    .slice(0, WELCOME_CHARS);
}

export function parseSoulDraft(text: string): string | null {
  const draft = text.trim();
  return draft === "" || draft === NO_SOUL ? null : draft;
}

export async function draftWelcomeSoul(userId: string, name: string | null): Promise<string | null> {
  const transcript = await welcomeTranscript(userId);
  if (transcript === "") return null;
  const response = await generateText([system(SOUL_PROMPT), user(`Person: ${name ?? "unknown"}\n\nConversation:\n${transcript}`)], {
    purpose: "soul_draft",
    userId,
    chain: MEMORY_CHAIN,
  });
  return parseSoulDraft(response.text);
}

export function isOwnSoul(soul: Pick<Node, "userId" | "access">, userId: string): boolean {
  return soul.userId === userId && soul.access.length === 1 && soul.access[0] === privateLevel(userId);
}

export async function needsWelcomeSoul(userId: string): Promise<boolean> {
  const soul = await getSoul(userId);
  return soul === null || !isOwnSoul(soul, userId);
}

export async function saveWelcomeSoul(userId: string, content: string): Promise<Node> {
  const node = await createNode(userId, [privateLevel(userId)], {
    content,
    embedding: await embedQuery(content),
    processedAt: new Date(Math.floor(Date.now() / 1000) * 1000),
  });
  await setSoul(userId, node.id);
  return node;
}

export async function welcomeSoulAfterConversation(userId: string, name: string | null, conversationStartedAt: Date): Promise<Node | null> {
  if (await getSoul(userId)) return null;
  const start = await firstDmAt(userId);
  if (!start || conversationStartedAt.getTime() > start.getTime() + WELCOME_WINDOW_MS) return null;
  const draft = await draftWelcomeSoul(userId, name);
  return draft ? saveWelcomeSoul(userId, draft) : null;
}
