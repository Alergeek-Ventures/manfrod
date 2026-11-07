import { getUserBySlackId } from "../accounts.ts";
import { logger } from "../log.ts";
import { botIdentity, getThreadMessage, isBotUser, post, type SlackBody } from "./api.ts";
import { CARD_LIMITS, CARD_REPLY_ACTION_PREFIX } from "./cards.ts";
import { handleMessage, type Dispatcher, type Inbound } from "./routing.ts";
import { firstDelivery } from "./state.ts";

const log = logger("Slack.CardActions");

export interface CardReplyClick {
  actionId: string;
  value: string | undefined;
  label: string | undefined;
  messageTs: string | undefined;
  slackUserId: string;
  channelId: string;
  threadTs: string;
}

export const isCardReplyAction = (actionId: string) => actionId.startsWith(CARD_REPLY_ACTION_PREFIX);

const isReplyButton = (element: SlackBody) =>
  element?.type === "button" && typeof element.action_id === "string" && isCardReplyAction(element.action_id);

const escapeMrkdwn = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function answeredNote(slackUserId: string, label: string): string {
  return `:point_right: <@${slackUserId}>: ${escapeMrkdwn(label)}`;
}

export function answeredBlocks(blocks: SlackBody[], note: string): SlackBody[] | null {
  const noteBlock = { type: "context", elements: [{ type: "mrkdwn", text: note }] };
  let answered = false;
  const result = blocks.flatMap((block) => {
    if (block.type !== "actions" || !Array.isArray(block.elements)) return [block];
    const elements = (block.elements as SlackBody[]).filter((element) => !isReplyButton(element));
    if (elements.length === block.elements.length) return [block];
    const placed = answered ? [] : [noteBlock];
    answered = true;
    return elements.length > 0 ? [{ ...block, elements }, ...placed] : placed;
  });
  return answered ? result : null;
}

let sequence = 0;

export function clickTs(now = Date.now()): string {
  sequence = (sequence + 1) % 1000;
  return `${Math.floor(now / 1000)}.${String(now % 1000).padStart(3, "0")}${String(sequence).padStart(3, "0")}`;
}

const isDm = (channel: string) => channel.startsWith("D");

async function markAnswered(click: CardReplyClick & { messageTs: string }, reply: string): Promise<boolean> {
  const message = await getThreadMessage(click.channelId, click.threadTs, click.messageTs);
  if (!message) {
    log.warn(`Slack CardActions could not read card ${click.channelId}/${click.messageTs}; handling the click without updating it`);
    return true;
  }
  const blocks = answeredBlocks(Array.isArray(message.blocks) ? message.blocks : [], answeredNote(click.slackUserId, click.label ?? reply));
  if (!blocks) return false;
  const updated = await post("chat.update", { channel: click.channelId, ts: click.messageTs, text: message.text ?? reply, blocks });
  if (!updated.ok) log.warn(`Slack CardActions failed to update card ${click.channelId}/${click.messageTs}: ${updated.error}`);
  return true;
}

async function inboundFor(click: CardReplyClick, reply: string): Promise<{ inbound: Inbound; asMention: boolean }> {
  const bot = isDm(click.channelId) ? null : await botIdentity();
  const inbound: Inbound = {
    channel: click.channelId,
    ts: clickTs(),
    threadTs: click.threadTs,
    text: bot ? `<@${bot.userId}> ${reply}` : reply,
    user: click.slackUserId,
    channelType: null,
    files: [],
  };
  return { inbound, asMention: !isDm(click.channelId) && !bot };
}

export async function handleCardReply(click: CardReplyClick, dispatcher: Dispatcher): Promise<void> {
  const reply = click.value?.trim() ?? "";
  if (!isCardReplyAction(click.actionId) || reply === "" || reply.length > CARD_LIMITS.buttonReply || !click.messageTs) return;
  if (await isBotUser(click.slackUserId)) {
    log.debug(`Slack CardActions ignoring a card click by bot ${click.slackUserId}`);
    return;
  }
  const canTalk = isDm(click.channelId) || (await getUserBySlackId(click.slackUserId)) !== null;
  if (canTalk) {
    if (!firstDelivery(`card_reply:${click.channelId}:${click.messageTs}`)) {
      log.debug(`Slack CardActions ignoring a repeated click on ${click.channelId}/${click.messageTs}`);
      return;
    }
    if (!(await markAnswered({ ...click, messageTs: click.messageTs }, reply))) {
      log.debug(`Slack CardActions ignoring a click on an answered card ${click.channelId}/${click.messageTs}`);
      return;
    }
  }
  const { inbound, asMention } = await inboundFor(click, reply);
  await handleMessage(inbound, dispatcher, asMention);
}
