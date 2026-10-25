import { findOrCreateBySlackId, getUserBySlackId } from "../accounts.ts";
import { decide } from "../agent/response-gate.ts";
import { activeAuthor } from "../agent/turns.ts";
import type { User } from "../db/schema.ts";
import { broadcast } from "../events/index.ts";
import { EVENTS, sendEvent } from "../inngest/client.ts";
import { logger } from "../log.ts";
import { resolveAccess } from "../memory/access.ts";
import { push as bufferPush } from "../memory/buffer.ts";
import { ensureMapping } from "../memory/channel-detector.ts";
import { createMessage, getRecentSessionMessages, lastSessionMessageAt } from "../memory/messages.ts";
import { userAuth } from "../proactive.ts";
import { containsSecret, languageHint, secretWarning } from "../security/secrets.ts";
import { addReaction, botIdentity, fetchUserInfo, fetchUserName, getChannelInfo, listFullThread, listMessages, post, setStatus, type SlackBody } from "./api.ts";
import { firstDelivery, shared, threadSeen, userContext } from "./state.ts";
import { allow, isAllowed, isKicked } from "./thread-permission.ts";

const log = logger("Slack.EventHandler");

const GATE_DEBOUNCE_MS = 6_000;
const TRANSCRIPT_WINDOW = 12;
const CATCH_UP_LIMIT = 50;
const DM_RESTORE_LIMIT = 400;
const CHANNEL_RESTORE_LIMIT = 60;
export const CHANNEL_RESTORE_WINDOW_HOURS = 24;
const LANGUAGE_CONTEXT_LIMIT = 6;
const BOT_NAME_PATTERN = /\bmanfrod\b/i;

export type Auth = ReturnType<typeof userAuth>;

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

export interface Dispatcher {
  send(
    content: string,
    options: { auth: Auth; context?: string[]; history?: HistoryMessage[]; turnPolicy?: "steer" | "queue" },
  ): Promise<unknown>;
  isSubscribed(): Promise<boolean>;
  reset(reason: string): Promise<unknown>;
}

const UNRESUMABLE_SESSION_ERRORS = new Set(["DevelopmentRunUnavailableError", "SessionStrandedError"]);

const unresumable = (error: unknown) => error instanceof Error && UNRESUMABLE_SESSION_ERRORS.has(error.name);

export interface Inbound {
  channel: string;
  ts: string;
  threadTs: string | null;
  text: string;
  user: string | null;
  channelType: string | null;
}

export function inboundFromRaw(raw: Record<string, any>, fallbackChannel: string): Inbound {
  return {
    channel: raw.channel ?? fallbackChannel,
    ts: raw.ts,
    threadTs: raw.thread_ts ?? null,
    text: typeof raw.text === "string" ? raw.text : "",
    user: typeof raw.user === "string" ? raw.user : null,
    channelType: raw.channel_type ?? null,
  };
}

const isDm = (channel: string) => channel.startsWith("D");
const present = (text: string | null | undefined): text is string => typeof text === "string" && text !== "";
const formatAuthor = (name: string | null | undefined, slackUserId: string) => (name ? `${name} <${slackUserId}>` : slackUserId);

interface Gated {
  content: string;
  auth: Auth;
  ts: string;
  channel: string;
  dispatcher: Dispatcher;
  userId: string;
}

const gates = shared("slackGates", () => new Map<string, { pending: Gated[]; timer: NodeJS.Timeout | null }>());
const backlogs = shared("slackBacklogs", () => new Map<string, string[]>());
const lastContent = shared("slackLastContent", () => new Map<string, string>());

export function lastUserContent(sessionKey: string): string | null {
  return lastContent.get(sessionKey) ?? null;
}

function takeBacklog(sessionKey: string): string[] {
  const backlog = backlogs.get(sessionKey) ?? [];
  backlogs.delete(sessionKey);
  return backlog;
}

function addBacklog(sessionKey: string, contents: string[]) {
  backlogs.set(sessionKey, [...(backlogs.get(sessionKey) ?? []), ...contents]);
}

async function channelName(channel: string): Promise<string> {
  return (await getChannelInfo(channel))?.name ?? channel;
}

async function channelInfo(channel: string) {
  const info = await getChannelInfo(channel);
  if (info) return { name: (info.name as string) ?? channel, isIm: info.is_im === true, isMpim: info.is_mpim === true };
  return { name: channel, isIm: isDm(channel), isMpim: false };
}

function privateConversation(inbound: Inbound, info: { isIm: boolean; isMpim: boolean }): boolean {
  if (isDm(inbound.channel)) return true;
  if (inbound.channelType === "im" || inbound.channelType === "mpim") return true;
  return info.isIm || info.isMpim;
}

async function agentChannel(inbound: Inbound, info: { name: string; isIm: boolean; isMpim: boolean }): Promise<string | null> {
  if (privateConversation(inbound, info)) return isDm(inbound.channel) ? inbound.channel : null;
  await ensureMapping(inbound.channel, info.name);
  return inbound.channel;
}

function startThinking(channel: string, threadTs: string) {
  void setStatus(channel, threadTs, "is thinking...");
}

async function restoreHistory(sessionKey: string, excludeLast = 0): Promise<HistoryMessage[]> {
  const options = isDm(sessionKey)
    ? { limit: DM_RESTORE_LIMIT, windowHours: null }
    : { limit: CHANNEL_RESTORE_LIMIT, windowHours: CHANNEL_RESTORE_WINDOW_HOURS };
  const restored = (await getRecentSessionMessages(sessionKey, options)).slice(0, excludeLast > 0 ? -excludeLast : undefined);
  return restored.map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", text: message.content }));
}

function restartNotice(count: number): string {
  return `[SYSTEM] This is a continuation of an ongoing conversation — the ${count} messages above are its earlier history, restored after an idle timeout, restart, or update. Treat them as your own memory of this conversation: do not claim you lack context, and do not repeat actions already taken.`;
}

async function persistUser(userId: string, sessionKey: string, content: string) {
  try {
    await createMessage(userId, {
      role: "user",
      content,
      sessionKey,
      receivedAt: new Date(Math.floor(Date.now() / 1000) * 1000),
    });
  } catch (error) {
    log.error(`Agent.Server failed to persist user message for user ${userId}: ${(error as Error).message}`);
  }
}

async function messageReceived(auth: Auth, sessionKey: string, content: string, channel: string, writeAccess: string[]) {
  await broadcast("message_received", {
    userId: auth.principalId,
    sessionKey,
    source: "slack",
    meta: { write_access: writeAccess, slack_channel_id: channel, content },
  });
}

async function dispatch(
  dispatcher: Dispatcher,
  auth: Auth,
  sessionKey: string,
  contents: string[],
  toPersist: string | null = null,
  alreadyPersisted = 0,
) {
  const userId = auth.principalId;
  if (toPersist !== null) await persistUser(userId, sessionKey, toPersist);
  const persisted = alreadyPersisted + (toPersist !== null ? 1 : 0);
  const context = takeBacklog(sessionKey);
  const current = activeAuthor(sessionKey);
  const turnPolicy = current && current !== userId ? "queue" : "steer";
  lastContent.set(sessionKey, contents.at(-1) ?? "");

  const deliver = async () => {
    const subscribed = await dispatcher.isSubscribed();
    const history = subscribed ? [] : await restoreHistory(sessionKey, persisted + context.length);
    const notices = !subscribed && history.length > 0 ? [restartNotice(history.length)] : [];
    const fullContext = [...context, ...notices];
    await dispatcher.send(contents.join("\n\n"), {
      auth,
      context: fullContext.length > 0 ? fullContext : undefined,
      history: history.length > 0 ? history : undefined,
      turnPolicy,
    });
  };

  try {
    await deliver();
  } catch (error) {
    if (!unresumable(error)) throw error;
    log.warn(`Agent.Server: session for ${sessionKey} cannot be resumed (${(error as Error).name}), starting a fresh one from saved history`);
    await dispatcher.reset("session could not be resumed");
    await deliver();
  }

  await sendEvent(EVENTS.sessionActivity, {
    sessionKey,
    writeAccess: (auth.attributes.writeAccess as string[]) ?? ["internal"],
    slackChannelId: auth.attributes.channelId,
  });
}

function drainGate(sessionKey: string): Gated[] {
  const gate = gates.get(sessionKey);
  if (!gate) return [];
  if (gate.timer) clearTimeout(gate.timer);
  gates.delete(sessionKey);
  return gate.pending;
}

async function deliverImmediate(
  dispatcher: Dispatcher,
  user: User,
  inbound: Inbound,
  threadTs: string,
  content: string,
  accessChannel: string | null,
) {
  const sessionKey = `${inbound.channel}:${threadTs}`;
  const access = await resolveAccess(user.id, accessChannel);
  const auth = userAuth(user.id, inbound.user!, {
    kind: "slack",
    channelId: inbound.channel,
    threadTs,
    messageTs: inbound.ts,
    readableLevels: access.readableLevels,
    writeAccess: access.writeAccess,
  });
  await messageReceived(auth, sessionKey, content, inbound.channel, access.writeAccess);
  const waiting = drainGate(sessionKey).map((gated) => gated.content);
  await dispatch(dispatcher, auth, sessionKey, [...waiting, content], content, waiting.length);
}

async function gateElapsed(sessionKey: string) {
  const pending = drainGate(sessionKey);
  if (pending.length === 0) return;
  const last = pending.at(-1)!;
  const contents = pending.map((gated) => gated.content);

  const recent = await getRecentSessionMessages(sessionKey, { limit: TRANSCRIPT_WINDOW + pending.length });
  const prior = recent
    .slice(0, Math.max(recent.length - pending.length, 0))
    .slice(-TRANSCRIPT_WINDOW)
    .map((message) => (message.role === "assistant" ? `Manfrod: ${message.content}` : message.content));

  const decision = await decide(prior, contents);
  if (decision.kind === "react" || decision.kind === "react_and_respond") {
    const result = await addReaction(last.channel, last.ts, decision.emoji);
    if (!result.ok && result.error !== "already_reacted") {
      log.warn(`Slack ActivityHandler failed to add reaction :${decision.emoji}: in ${last.channel}: ${result.error}`);
    }
    await broadcast("reacted", {
      userId: last.userId,
      sessionKey,
      source: "slack",
      meta: { emoji: decision.emoji, ts: last.ts },
    });
  }
  if (decision.kind === "respond" || decision.kind === "react_and_respond") {
    await dispatch(last.dispatcher, last.auth, sessionKey, contents, null, contents.length);
    return;
  }
  log.debug(`Agent.Server: response gate chose ${decision.kind} for session ${sessionKey}`);
  addBacklog(sessionKey, contents);
}

function scheduleGate(sessionKey: string, gated: Gated) {
  const gate = gates.get(sessionKey) ?? { pending: [], timer: null };
  gate.pending.push(gated);
  if (gate.timer) clearTimeout(gate.timer);
  gate.timer = setTimeout(() => {
    void gateElapsed(sessionKey).catch((error) => log.error(`Response gate failed for ${sessionKey}: ${(error as Error).message}`));
  }, GATE_DEBOUNCE_MS);
  gates.set(sessionKey, gate);
}

async function recentLanguageContext(channel: string, excludeTs: string): Promise<string> {
  const messages = await listMessages(channel, LANGUAGE_CONTEXT_LIMIT);
  if (!messages) return "";
  return messages
    .filter((message) => message.ts !== excludeTs)
    .map((message) => String(message.text ?? ""))
    .filter((text) => text !== "" && !containsSecret(text))
    .slice(-4)
    .join("\n");
}

async function warnAboutSecret(inbound: Inbound) {
  const text = await secretWarning(await recentLanguageContext(inbound.channel, inbound.ts), languageHint(inbound.text));
  const body: SlackBody = { channel: inbound.channel, text };
  if (!isDm(inbound.channel)) body.thread_ts = inbound.threadTs ?? inbound.ts;
  await post("chat.postMessage", body);
  log.warn(
    `Slack EventHandler: withheld likely-secret message in ${inbound.channel} from ${inbound.user} (buffer/classifier/agent never saw it)`,
  );
}

async function withViewingContext(text: string, slackUserId: string): Promise<string> {
  const description = await userContext.describe(slackUserId, async (channel) => (await getChannelInfo(channel))?.name ?? null);
  return description ? `[${description}]\n${text}` : text;
}

function stripBotMention(text: string, botUserId: string): string {
  return text.replaceAll(`<@${botUserId}>`, "").trim();
}

function mentionText(text: string, inThread: boolean): string {
  if (text !== "") return text;
  return inThread ? "(@mention with no text - answer what was most recently said to you in this thread)" : "(@mention with no text)";
}

const ownMessage = (bot: { userId: string; botId: string }, message: SlackBody) =>
  message.user === bot.userId || message.bot_id === bot.botId;

async function threadCatchUp(inbound: Inbound, threadTs: string, sessionKey: string): Promise<string> {
  if (!inbound.threadTs) {
    threadSeen.mark(sessionKey, [inbound.ts]);
    return "";
  }
  const bot = await botIdentity();
  const messages = await listFullThread(inbound.channel, threadTs);
  if (!messages || !bot) {
    log.warn(`Slack EventHandler: failed to read thread ${sessionKey} for catch-up`);
    threadSeen.mark(sessionKey, [inbound.ts]);
    return "";
  }
  const prior = messages.filter((message) => message.ts !== inbound.ts);
  const seen = threadSeen.seen(sessionKey);
  let kind: "joined" | "unseen";
  let catchUp: SlackBody[];
  if (seen.size > 0) {
    kind = "unseen";
    catchUp = prior.filter((message) => !seen.has(message.ts) && !ownMessage(bot, message));
  } else {
    const lastAt = await lastSessionMessageAt(sessionKey, CHANNEL_RESTORE_WINDOW_HOURS);
    if (lastAt) {
      const since = lastAt.getTime() / 1000;
      kind = "unseen";
      catchUp = prior.filter((message) => Number.parseFloat(message.ts) > since && !ownMessage(bot, message));
    } else {
      kind = "joined";
      catchUp = prior;
    }
  }
  threadSeen.mark(sessionKey, [inbound.ts, ...messages.map((message) => message.ts)]);

  const withText = catchUp.filter((message) => present(message.text));
  const names = new Map<string, string | null>();
  for (const message of withText) {
    if (typeof message.user === "string" && message.user !== bot.userId && !names.has(message.user)) {
      names.set(message.user, await fetchUserName(message.user));
    }
  }
  const capped =
    kind === "joined" && withText.length > CATCH_UP_LIMIT
      ? [withText[0], ...withText.slice(1).slice(-(CATCH_UP_LIMIT - 1))]
      : withText.slice(-CATCH_UP_LIMIT);
  if (capped.length === 0) return "";

  const lines = capped.map((message) => {
    const author = ownMessage(bot, message)
      ? "Manfrod"
      : message.user
        ? formatAuthor(names.get(message.user), message.user)
        : (message.username ?? message.bot_profile?.name ?? "bot");
    const text = containsSecret(message.text)
      ? "[message withheld - looks like a secret]"
      : String(message.text).replace(/<@([A-Z0-9]+)>/g, (whole: string, id: string) =>
          id === bot.userId ? "@Manfrod" : names.get(id) ? `@${names.get(id)}` : whole,
        );
    return `${author}: ${text}`;
  });
  const header =
    kind === "joined"
      ? "[Thread history — you were just mentioned in an ongoing thread. These messages were sent before you joined:]"
      : "[Thread messages you have not seen yet, posted since you were last in this conversation:]";
  return `${header}\n${lines.join("\n")}\n[End of thread history]\n`;
}

async function bufferMessage(inbound: Inbound) {
  const [userName, name] = await Promise.all([fetchUserName(inbound.user!), channelName(inbound.channel)]);
  await bufferPush(inbound.channel, inbound.threadTs, name, {
    user: inbound.user!,
    user_name: userName,
    text: inbound.text,
    ts: inbound.ts,
  });
}

async function handleDm(inbound: Inbound, dispatcher: Dispatcher) {
  const threadTs = inbound.threadTs ?? inbound.ts;
  const info = await fetchUserInfo(inbound.user!);
  const user = await findOrCreateBySlackId(inbound.user!, inbound.channel, info?.name ?? null, info?.email ?? null);
  const content = await withViewingContext(inbound.text, inbound.user!);
  await deliverImmediate(dispatcher, user, inbound, threadTs, content, null);
}

export async function handleMention(inbound: Inbound, dispatcher: Dispatcher) {
  if (!firstDelivery(`mention:${inbound.channel}:${inbound.ts}`)) {
    log.debug(`Slack EventHandler ignoring duplicate mention delivery for ${inbound.channel}/${inbound.ts}`);
    return;
  }
  const threadTs = inbound.threadTs ?? inbound.ts;
  const sessionKey = `${inbound.channel}:${threadTs}`;
  if (!inbound.user) {
    log.debug("Slack EventHandler ignoring mention without an author");
    return;
  }
  const user = await getUserBySlackId(inbound.user);
  if (!user) {
    log.info(`Slack EventHandler: unknown user ${inbound.user} in channel, sending DM-first message`);
    await post("chat.postEphemeral", {
      channel: inbound.channel,
      thread_ts: threadTs,
      user: inbound.user,
      text: "Najpierw napisz do mnie w wiadomości prywatnej - dopiero wtedy mogę Ci odpowiadać na kanałach.",
    });
    return;
  }
  startThinking(inbound.channel, threadTs);
  await allow(inbound.channel, threadTs);

  const bot = await botIdentity();
  const info = await channelInfo(inbound.channel);
  const accessChannel = await agentChannel(inbound, info);
  const userName = await fetchUserName(inbound.user);
  const channelContext = `Slack channel: #${info.name}, from: ${formatAuthor(userName, inbound.user)}`;
  const history = await threadCatchUp(inbound, threadTs, sessionKey);
  const text = mentionText(stripBotMention(inbound.text, bot?.userId ?? ""), inbound.threadTs !== null);
  await deliverImmediate(dispatcher, user, inbound, threadTs, `${history}[${channelContext}]\n${text}`, accessChannel);
}

async function handleThreadReply(inbound: Inbound, dispatcher: Dispatcher): Promise<boolean> {
  const bot = await botIdentity();
  if (!inbound.threadTs || !inbound.user || !bot) return false;
  const user = await getUserBySlackId(inbound.user);
  const cleaned = stripBotMention(inbound.text, bot.userId);
  if (!user || !present(cleaned) || !(await isAllowed(bot.userId, inbound.channel, inbound.threadTs))) {
    log.debug(
      `Slack EventHandler not forwarding channel message ${inbound.channel}/${inbound.ts} (top-level, unknown author, or thread the bot was not invited into)`,
    );
    return false;
  }
  const sessionKey = `${inbound.channel}:${inbound.threadTs}`;
  const info = await channelInfo(inbound.channel);
  const accessChannel = await agentChannel(inbound, info);
  threadSeen.mark(sessionKey, [inbound.ts]);
  const content = `[from: ${formatAuthor(user.name, inbound.user)}]\n${cleaned}`;

  if (activeAuthor(sessionKey) === user.id) {
    await deliverImmediate(dispatcher, user, inbound, inbound.threadTs, content, accessChannel);
    return true;
  }

  const access = await resolveAccess(user.id, accessChannel);
  const auth = userAuth(user.id, inbound.user, {
    kind: "slack",
    channelId: inbound.channel,
    threadTs: inbound.threadTs,
    messageTs: inbound.ts,
    readableLevels: access.readableLevels,
    writeAccess: access.writeAccess,
  });
  await messageReceived(auth, sessionKey, content, inbound.channel, access.writeAccess);
  await persistUser(user.id, sessionKey, content);
  scheduleGate(sessionKey, { content, auth, ts: inbound.ts, channel: inbound.channel, dispatcher, userId: user.id });
  return true;
}

export async function handleMessage(inbound: Inbound, dispatcher: Dispatcher, isMentionEvent = false) {
  if (!present(inbound.text) || !inbound.user) {
    log.debug("Slack EventHandler ignoring message with no text or no user");
    return;
  }
  if (containsSecret(inbound.text)) {
    await warnAboutSecret(inbound);
    return;
  }
  if (isMentionEvent) {
    await handleMention(inbound, dispatcher);
    return;
  }
  if (isDm(inbound.channel)) startThinking(inbound.channel, inbound.threadTs ?? inbound.ts);
  await bufferMessage(inbound);

  if (isDm(inbound.channel)) {
    await handleDm(inbound, dispatcher);
    return;
  }
  const bot = await botIdentity();
  if (bot && inbound.text.includes(`<@${bot.userId}>`)) {
    await handleMention(inbound, dispatcher);
    return;
  }
  if (await handleThreadReply(inbound, dispatcher)) return;
  if (BOT_NAME_PATTERN.test(inbound.text)) {
    if (!inbound.threadTs || !(await isKicked(inbound.channel, inbound.threadTs))) {
      await addReaction(inbound.channel, inbound.ts, "eyes");
    }
  }
}
