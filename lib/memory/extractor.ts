import { broadcast } from "../events/index.ts";
import { generateText, user } from "../llm/index.ts";
import { logger } from "../log.ts";
import { worthSummarizing } from "./action-decider.ts";
import { closeConversation, getPendingMessages, pendingAuthorsForSession } from "./messages.ts";

const log = logger("Extractor");

const SUMMARY_PROMPT = `Summarize this conversation in 2-3 sentences. Focus on:
- What was discussed
- Key decisions or outcomes
- Any action items or follow-ups

Conversation:
`;

const SMALL_TALK_SUMMARY = "Small talk with no decisions, facts or tasks.";

export async function extractAndStore(
  userId: string,
  sessionKey: string,
  writeAccess: string[] = ["internal"],
  slackChannelId: string | null = null,
): Promise<void> {
  const pending = await getPendingMessages(userId, sessionKey);
  if (pending.length === 0) {
    log.debug(`Extractor: no pending messages to process for user ${userId}, session ${sessionKey}`);
    return;
  }

  await broadcast("extraction_started", {
    userId,
    sessionKey,
    source: "extractor",
    meta: { message_count: pending.length },
  });

  const conversationText = pending
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n\n");

  try {
    const summary =
      (await worthSummarizing(conversationText)) === false
        ? SMALL_TALK_SUMMARY
        : (await generateText([user(SUMMARY_PROMPT + conversationText)], { purpose: "extractor", userId, sessionKey })).text.trim();
    const conversation = await closeConversation(userId, sessionKey, {
      summary,
      access: writeAccess,
      slackChannelId,
    });
    if (!conversation) {
      log.debug(`Extractor: no pending messages (race condition) for user ${userId}, session ${sessionKey}`);
      return;
    }
    log.info(`Extracted conversation ${conversation.id} for user ${userId}: summary: ${summary.slice(0, 50)}...`);
    await broadcast("extraction_completed", {
      userId,
      sessionKey,
      source: "extractor",
      meta: { conversation_id: conversation.id, node_count: 0, summary_preview: summary.slice(0, 100) },
    });
  } catch (error) {
    log.error(`Extraction failed for user ${userId}, session ${sessionKey}: ${(error as Error).message}`);
    await broadcast("extraction_failed", {
      userId,
      sessionKey,
      source: "extractor",
      meta: { reason: (error as Error).message },
    });
  }
}

export async function extractSession(
  sessionKey: string,
  writeAccess: string[],
  slackChannelId: string | null,
): Promise<number> {
  const authors = await pendingAuthorsForSession(sessionKey);
  for (const userId of authors) {
    log.info(`FlushHandler: idle detected for user ${userId}, session ${sessionKey}, triggering extraction`);
    await broadcast("idle", { userId, sessionKey, source: "agent", meta: { write_access: writeAccess, slack_channel_id: slackChannelId } });
    await extractAndStore(userId, sessionKey, writeAccess, slackChannelId);
  }
  return authors.length;
}
