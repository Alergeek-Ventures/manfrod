import { getUserBySlackId } from "../accounts.ts";
import { channelLanguage } from "../agent-settings.ts";
import { logger } from "../log.ts";
import { botIdentity, getThreadMessage, isBotUser, post, type SlackBody } from "./api.ts";
import { CARD_REPLY_ACTION_PREFIX } from "./cards.ts";
import { handleMessage, type Dispatcher, type Inbound } from "./routing.ts";
import { shared, TtlMap } from "./state.ts";
import { getStream } from "./stream.ts";
import { isKicked } from "./thread-permission.ts";

const log = logger("Slack.CardActions");

const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
const ANSWERED_BLOCK_ID = "card_reply_answered";
const CLICK_PREFIX = "[clicked card button]";

export interface CardReplyClick {
  actionId: string;
  messageTs: string | undefined;
  slackUserId: string;
  channelId: string;
  threadTs: string;
}

type Notice = "answered" | "kicked" | "streaming" | "unreadable";

const NOTICES: Record<Notice, { pl: string; en: string }> = {
  answered: { pl: "Ktoś już odpowiedział na tę kartę.", en: "Someone already answered this card." },
  kicked: {
    pl: "Już mnie tu nie ma — oznacz mnie `@Manfrod`, jeśli mam wrócić.",
    en: "I've already left this thread — mention `@Manfrod` if you want me back.",
  },
  streaming: {
    pl: "Poczekaj, aż skończę odpowiadać, i kliknij jeszcze raz.",
    en: "Wait until I finish answering, then click again.",
  },
  unreadable: {
    pl: "Nie mogę odczytać tej karty — napisz odpowiedź w wątku.",
    en: "I couldn't read this card — please type your reply in the thread.",
  },
};

const claims = shared("cardReplyClaims", () => new TtlMap<string, true>(CLAIM_TTL_MS));

export const isCardReplyAction = (actionId: string) => actionId.startsWith(CARD_REPLY_ACTION_PREFIX);

const isReplyButton = (element: SlackBody) =>
  element?.type === "button" && typeof element.action_id === "string" && isCardReplyAction(element.action_id);

const escapeMrkdwn = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const blocksOf = (message: SlackBody): SlackBody[] => (Array.isArray(message.blocks) ? message.blocks : []);

const elementsOf = (block: SlackBody): SlackBody[] =>
  block?.type === "actions" && Array.isArray(block.elements) ? (block.elements as SlackBody[]) : [];

export function answeredNote(slackUserId: string, label: string): string {
  return `:point_right: <@${slackUserId}>: ${escapeMrkdwn(label)}`;
}

export function answeredBlocks(blocks: SlackBody[], note: string): SlackBody[] | null {
  const noteBlock = { type: "context", block_id: ANSWERED_BLOCK_ID, elements: [{ type: "mrkdwn", text: note }] };
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

export function replyLabel(blocks: SlackBody[], actionId: string): string | null {
  for (const element of blocks.flatMap(elementsOf)) {
    if (!isReplyButton(element) || element.action_id !== actionId) continue;
    const label = element.text?.text;
    return typeof label === "string" && label.trim() !== "" ? label.trim() : null;
  }
  return null;
}

const wasAnswered = (blocks: SlackBody[]) => blocks.some((block) => block?.block_id === ANSWERED_BLOCK_ID);

let sequence = 0;

export function clickTs(now = Date.now()): string {
  sequence = (sequence + 1) % 1000;
  return `${Math.floor(now / 1000)}.${String(now % 1000).padStart(3, "0")}${String(sequence).padStart(3, "0")}`;
}

const isDm = (channel: string) => channel.startsWith("D");

async function notify(click: CardReplyClick, notice: Notice): Promise<void> {
  try {
    const { code } = await channelLanguage(click.channelId);
    const result = await post("chat.postEphemeral", {
      channel: click.channelId,
      thread_ts: click.threadTs,
      user: click.slackUserId,
      text: code === "pl" ? NOTICES[notice].pl : NOTICES[notice].en,
    });
    if (!result.ok) throw new Error(result.error);
  } catch (error) {
    log.warn(`Slack CardActions could not tell ${click.slackUserId} about ${notice}: ${(error as Error).message}`);
  }
}

function isStreaming(click: CardReplyClick, messageTs: string): boolean {
  const stream = getStream(click.channelId, click.threadTs);
  return stream !== undefined && !stream.closed && stream.ts === messageTs;
}

async function markAnswered(click: CardReplyClick, messageTs: string, card: SlackBody, label: string): Promise<void> {
  const blocks = answeredBlocks(blocksOf(card), answeredNote(click.slackUserId, label));
  if (!blocks) return;
  const updated = await post("chat.update", { channel: click.channelId, ts: messageTs, text: card.text || label, blocks });
  if (!updated.ok) log.warn(`Slack CardActions failed to update card ${click.channelId}/${messageTs}: ${updated.error}`);
}

async function inboundFor(click: CardReplyClick, label: string): Promise<{ inbound: Inbound; asMention: boolean }> {
  const bot = isDm(click.channelId) ? null : await botIdentity();
  const reply = `${CLICK_PREFIX} ${label}`;
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

async function readLabel(click: CardReplyClick, messageTs: string): Promise<{ card: SlackBody; label: string } | Notice> {
  const card = await getThreadMessage(click.channelId, click.threadTs, messageTs);
  if (!card) {
    log.warn(`Slack CardActions could not read card ${click.channelId}/${messageTs}`);
    return "unreadable";
  }
  const label = replyLabel(blocksOf(card), click.actionId);
  if (label !== null) return { card, label };
  if (wasAnswered(blocksOf(card))) return "answered";
  log.warn(`Slack CardActions found no reply button ${click.actionId} on ${click.channelId}/${messageTs}`);
  return "unreadable";
}

async function dispatch(click: CardReplyClick, label: string, dispatcher: Dispatcher): Promise<void> {
  const { inbound, asMention } = await inboundFor(click, label);
  await handleMessage(inbound, dispatcher, asMention);
}

export async function handleCardReply(click: CardReplyClick, dispatcher: Dispatcher): Promise<void> {
  const messageTs = click.messageTs;
  if (!isCardReplyAction(click.actionId) || !messageTs || !click.slackUserId) return;
  if (await isBotUser(click.slackUserId)) {
    log.debug(`Slack CardActions ignoring a card click by bot ${click.slackUserId}`);
    return;
  }
  if (!isDm(click.channelId) && (await isKicked(click.channelId, click.threadTs))) return notify(click, "kicked");
  if (isStreaming(click, messageTs)) return notify(click, "streaming");

  const canTalk = isDm(click.channelId) || (await getUserBySlackId(click.slackUserId)) !== null;
  if (!canTalk) {
    const read = await readLabel(click, messageTs);
    if (typeof read === "string") return notify(click, read);
    return dispatch(click, read.label, dispatcher);
  }

  const key = `${click.channelId}:${messageTs}`;
  if (claims.has(key)) return notify(click, "answered");
  claims.set(key, true);
  let read: Awaited<ReturnType<typeof readLabel>>;
  try {
    read = await readLabel(click, messageTs);
    if (typeof read !== "string") await dispatch(click, read.label, dispatcher);
  } catch (error) {
    claims.delete(key);
    throw error;
  }
  if (typeof read === "string") {
    claims.delete(key);
    return notify(click, read);
  }
  await markAnswered(click, messageTs, read.card, read.label);
}
