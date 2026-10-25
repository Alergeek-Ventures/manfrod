import { and, asc, eq, like } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { Node } from "../db/schema.ts";
import { generateText, system, user } from "../llm/index.ts";
import { embedQuery } from "../voyage.ts";
import { privateLevel } from "./access.ts";
import { createNode, getSoul, setSoul } from "./nodes.ts";

const { messages } = tables;

const WELCOME_MESSAGES = 100;
const WELCOME_CHARS = 30_000;
export const NO_SOUL = "NONE";

const SOUL_PROMPT = `You write the "soul" of Manfrod, a Slack assistant, for one person: Manfrod's
own note about who it is for them and who they are. It opens every
conversation with them, so it must hold only what lasts.

You get the person's first direct-message thread with Manfrod, where Manfrod
asked them to introduce themselves and to shape its personality. Read the
whole thread and capture everything it says about the person.

Write the soul in the language the person uses, in Manfrod's first person, as
two short paragraphs:
1. Who I am for this person: personality, tone, how to address them, how long
   and how formal answers should be. Take it from what they asked for or agreed
   to; if they said nothing, match the tone they used.
2. Who they are: name, role, work, interests, goals, values and what they
   expect from Manfrod.

Rules:
- Only what the person said or explicitly agreed to. Never invent, never keep
  Manfrod's own unanswered suggestions.
- Leave out anything about Manfrod's own setup or deployment.
- Never list what is unknown or not yet said.
- Under 120 words, plain text, no headings or lists.

If the person shared nothing about themselves or how Manfrod should be, reply
with exactly ${NO_SOUL}.`;

const dmOf = (userId: string) => and(eq(messages.userId, userId), like(messages.sessionKey, "D%"));

export async function firstDmThread(userId: string): Promise<string | null> {
  const [first] = await db
    .select({ sessionKey: messages.sessionKey })
    .from(messages)
    .where(dmOf(userId))
    .orderBy(asc(messages.receivedAt))
    .limit(1);
  return first?.sessionKey ?? null;
}

export async function welcomeTranscript(userId: string): Promise<string> {
  const sessionKey = await firstDmThread(userId);
  if (!sessionKey) return "";
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.sessionKey, sessionKey)))
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

export async function draftSoul(userId: string, name: string | null): Promise<string | null> {
  const transcript = await welcomeTranscript(userId);
  if (transcript === "") return null;
  const response = await generateText([system(SOUL_PROMPT), user(`Person: ${name ?? "unknown"}\n\nFirst DM thread:\n${transcript}`)], {
    purpose: "soul_draft",
    userId,
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

export async function welcomeSoulAfterConversation(userId: string, name: string | null, sessionKey: string): Promise<Node | null> {
  if (await getSoul(userId)) return null;
  if ((await firstDmThread(userId)) !== sessionKey) return null;
  const draft = await draftSoul(userId, name);
  return draft ? saveWelcomeSoul(userId, draft) : null;
}
