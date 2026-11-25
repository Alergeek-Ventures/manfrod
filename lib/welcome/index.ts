import { findOrCreateBySlackId, getUserBySlackId } from "../accounts.ts";
import { internalLanguage } from "../agent-settings.ts";
import type { User } from "../db/schema.ts";
import { EVENTS, sendEvent, type WelcomeRequestedData } from "../inngest/client.ts";
import { logger } from "../log.ts";
import { decide } from "../nudges/compose.ts";
import { getLayout } from "../office/layout.ts";
import { deliverProactive } from "../proactive.ts";
import { routineText } from "../routines.ts";
import { botIdentity, fetchWorkspaceMember, historyPageBefore, openDm, type WorkspaceMember } from "../slack/api.ts";
import {
  delayMinutes,
  HISTORY_PAGES,
  historyCutoff,
  historyVerdict,
  isOfficeMessage,
  memberVerdict,
  userVerdict,
  type Verdict,
} from "./rules.ts";
import { claimWelcome, getWelcome, markSent, markSkipped, recordSkip, releaseWelcome, talkedToManfrod, welcomeEnabled } from "./store.ts";

const log = logger("Welcome");

export const WELCOME_KIND = "nudge_welcome";
const OFFICE_CACHE_MS = 60_000;
const MAX_TEXT_CHARS = 1500;

let office: { channelId: string | null; at: number } | null = null;

async function officeChannelId(): Promise<string | null> {
  if (office && Date.now() - office.at < OFFICE_CACHE_MS) return office.channelId;
  const channelId = (await getLayout()).planChannelId ?? null;
  office = { channelId, at: Date.now() };
  return channelId;
}

async function postedBefore(channel: string, slackId: string, before: Date): Promise<boolean | null> {
  const latest = (before.getTime() / 1000).toFixed(6);
  let cursor: string | null = null;
  for (let page = 0; page < HISTORY_PAGES; page++) {
    const result = await historyPageBefore(channel, latest, cursor);
    if (!result) return null;
    if (result.messages.some((message) => message.user === slackId)) return true;
    if (!result.nextCursor) return false;
    cursor = result.nextCursor;
  }
  return false;
}

type Evaluation = { verdict: Verdict; user: User | null; member: WorkspaceMember | null };

async function evaluate(slackId: string, channel: string, now: Date): Promise<Evaluation> {
  const user = await getUserBySlackId(slackId);
  const byUser = userVerdict(user, user ? await talkedToManfrod(user.id) : false, now);
  if (!byUser.eligible) return { verdict: byUser, user, member: null };
  const [member, identity] = await Promise.all([fetchWorkspaceMember(slackId), botIdentity()]);
  const byMember = memberVerdict(member, identity?.teamId ?? null);
  if (!byMember.eligible) return { verdict: byMember, user, member };
  return { verdict: historyVerdict(await postedBefore(channel, slackId, historyCutoff(user, now))), user, member };
}

export async function noticeOfficeMessage(
  message: { channel: string; ts: string; user: string | null; text: string; subtype?: string | null },
  now = new Date(),
  random: () => number = Math.random,
): Promise<string> {
  if (!isOfficeMessage(message, await officeChannelId())) return "ignored";
  const slackId = message.user!;
  if (!(await welcomeEnabled())) return "disabled";
  if (await getWelcome(slackId)) return "handled";
  const { verdict } = await evaluate(slackId, message.channel, now);
  if (!verdict.eligible) {
    if (verdict.final) await recordSkip(slackId, verdict.reason);
    return verdict.reason;
  }
  const delay = delayMinutes(random);
  const scheduledFor = new Date(now.getTime() + delay * 60_000);
  if (!(await claimWelcome({ slackId, channelId: message.channel, messageTs: message.ts, scheduledFor }))) return "handled";
  const data: WelcomeRequestedData = {
    claimKey: `${slackId}-${message.ts}`,
    slackId,
    channelId: message.channel,
    messageTs: message.ts,
    text: message.text.slice(0, MAX_TEXT_CHARS),
    delayMinutes: delay,
  };
  if (!(await sendEvent(EVENTS.welcomeRequested, data, `welcome-${data.claimKey}`))) {
    await releaseWelcome(slackId);
    return "queue_unavailable";
  }
  log.info(`Welcome: scheduled a welcome for ${slackId} in ${delay} minutes`);
  return "scheduled";
}

const memberName = (member: WorkspaceMember) => member.realName ?? member.displayName ?? member.handle;

async function welcomedPerson(user: User | null, member: WorkspaceMember): Promise<User | null> {
  if (user) return user.slackDmChannelId.startsWith("D") ? user : null;
  const dm = await openDm(member.id);
  if (!dm?.startsWith("D")) return null;
  return findOrCreateBySlackId(member.id, dm, memberName(member), member.email);
}

async function welcome(data: WelcomeRequestedData, now: Date): Promise<string> {
  if (!(await welcomeEnabled())) {
    await releaseWelcome(data.slackId);
    return "disabled";
  }
  const { verdict, user, member } = await evaluate(data.slackId, data.channelId, now);
  if (!verdict.eligible) {
    if (verdict.final) await markSkipped(data.slackId, verdict.reason);
    else await releaseWelcome(data.slackId);
    return verdict.reason;
  }
  const person = await welcomedPerson(user, member!);
  if (!person) {
    await markSkipped(data.slackId, "no_dm_channel");
    return "no_dm_channel";
  }
  const name = person.name ?? memberName(member!) ?? person.slackId;
  const decision = await decide({
    kind: "welcome for someone new on the team",
    audience: `a DM to ${name} (<@${person.slackId}>)`,
    guidance: routineText("welcome", "Message"),
    context: `Their name on Slack: ${name}\n\nTheir message in the office channel:\n${data.text}`,
    language: routineText("welcome", "Language", { fallback_language: await internalLanguage() }),
    userId: person.id,
  });
  if (!decision) {
    await releaseWelcome(data.slackId);
    return "no_decision";
  }
  if (!decision.send) {
    await markSkipped(data.slackId, `declined: ${decision.reason}`.slice(0, 500));
    return "declined";
  }
  const prompt = `${routineText("welcome", "Send", { message: decision.message })}\n\n${routineText("welcome", "When they reply")}`;
  const sent = await deliverProactive(person.id, prompt, WELCOME_KIND, decision.message, true);
  if (!sent.ok) {
    await releaseWelcome(data.slackId);
    return sent.error;
  }
  await markSent(data.slackId, person.id);
  log.info(`Welcome: welcomed ${data.slackId}`);
  return "sent";
}

export async function deliverWelcome(data: WelcomeRequestedData, now = new Date()): Promise<{ slackId: string; outcome: string }> {
  const claim = await getWelcome(data.slackId);
  if (claim?.status !== "scheduled" || claim.messageTs !== data.messageTs) return { slackId: data.slackId, outcome: "not_scheduled" };
  try {
    return { slackId: data.slackId, outcome: await welcome(data, now) };
  } catch (error) {
    await releaseWelcome(data.slackId);
    throw error;
  }
}
