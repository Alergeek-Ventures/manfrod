import { getUserBySlackId } from "../accounts.ts";
import { broadcast } from "../events/index.ts";
import { record } from "../feedback.ts";
import { logger } from "../log.ts";
import { deleteMessage, getChannelInfo, getPermalink } from "./api.ts";

const log = logger("Slack.Feedback");

export const FEEDBACK_ACTION_ID = "manfrod_feedback";
export const REMOVE_ACTION_ID = "manfrod_feedback_remove";

const encode = (rating: string, sessionKey: string | null) => (sessionKey ? `${rating}:${sessionKey}` : rating);

function decode(value: unknown): { rating: string; sessionKey: string | null } {
  if (typeof value !== "string") return { rating: "unknown", sessionKey: null };
  const index = value.indexOf(":");
  return index === -1 ? { rating: value, sessionKey: null } : { rating: value.slice(0, index), sessionKey: value.slice(index + 1) };
}

export function feedbackBlock(sessionKey: string | null) {
  return {
    type: "context_actions",
    elements: [
      {
        type: "feedback_buttons",
        action_id: FEEDBACK_ACTION_ID,
        positive_button: {
          text: { type: "plain_text", text: "Dobra odpowiedź" },
          value: encode("good", sessionKey),
          accessibility_label: "Oceń odpowiedź pozytywnie",
        },
        negative_button: {
          text: { type: "plain_text", text: "Słaba odpowiedź" },
          value: encode("bad", sessionKey),
          accessibility_label: "Oceń odpowiedź negatywnie",
        },
      },
      {
        type: "icon_button",
        action_id: REMOVE_ACTION_ID,
        icon: "trash",
        text: { type: "plain_text", text: "Usuń" },
        accessibility_label: "Usuń tę odpowiedź",
      },
    ],
  };
}

export function feedbackChunk(sessionKey: string | null) {
  return { type: "blocks", blocks: [feedbackBlock(sessionKey)] };
}

export async function removeMessage(channelId: string, messageTs: string): Promise<void> {
  const result = await deleteMessage(channelId, messageTs);
  if (!result.ok) log.warn(`Slack feedback: failed to remove ${channelId}/${messageTs}: ${result.error}`);
}

export async function recordFeedback(payload: Record<string, any>, action: Record<string, any>): Promise<void> {
  const { rating, sessionKey } = decode(action.value);
  const slackUserId: string | null = payload.user?.id ?? null;
  const channelId: string | null = payload.channel?.id ?? null;
  const messageTs: string | null = payload.message?.ts ?? null;
  const user = await getUserBySlackId(slackUserId);

  await broadcast("feedback_received", {
    userId: user?.id ?? null,
    sessionKey,
    source: "slack",
    meta: { rating, slack_user_id: slackUserId, slack_channel_id: channelId, message_ts: messageTs },
  });

  if (channelId && messageTs) {
    const channelName = channelId.startsWith("D") ? "DM" : ((await getChannelInfo(channelId))?.name ?? null);
    try {
      await record({
        userId: user?.id ?? null,
        slackUserId,
        slackUserName: user?.name && user.name !== "" ? user.name : (payload.user?.username ?? null),
        slackChannelId: channelId,
        slackChannelName: channelName,
        messageTs,
        sessionKey,
        rating,
        permalink: await getPermalink(channelId, messageTs),
      });
    } catch (error) {
      log.warn(`Slack feedback: failed to store rating: ${(error as Error).message}`);
    }
  }
  log.info(`Slack feedback: ${rating} from ${slackUserId} on ${channelId}/${messageTs} (session ${sessionKey ?? "unknown"})`);
}
