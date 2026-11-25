import type { User } from "../db/schema.ts";
import type { WorkspaceMember } from "../slack/api.ts";

export const KNOWN_FOR_DAYS = 14;
export const MIN_DELAY_MINUTES = 10;
export const MAX_DELAY_MINUTES = 20;
export const HISTORY_PAGES = 5;

const DAY_MS = 86_400_000;
const WRITTEN_SUBTYPES: ReadonlySet<string> = new Set(["thread_broadcast", "file_share"]);

export type SkipReason =
  "system_user" | "banned" | "known_too_long" | "talked_to_manfrod" | "deleted" | "bot" | "guest" | "external" | "posted_before";

export type TransientReason = "slack_profile_unavailable" | "history_unavailable";

export type Verdict =
  { eligible: true } | { eligible: false; final: true; reason: SkipReason } | { eligible: false; final: false; reason: TransientReason };

const ELIGIBLE: Verdict = { eligible: true };
const skip = (reason: SkipReason): Verdict => ({ eligible: false, final: true, reason });
const retryLater = (reason: TransientReason): Verdict => ({ eligible: false, final: false, reason });

export type KnownUser = Pick<User, "slackId" | "insertedAt" | "banned">;

export interface WelcomeFacts {
  user: KnownUser | null;
  talked: boolean;
  member: WorkspaceMember | null;
  teamId: string | null;
  postedBefore: boolean | null;
  now: Date;
}

export function isOfficeMessage(
  message: { channel: string; user: string | null; subtype?: string | null },
  officeChannelId: string | null,
) {
  if (!officeChannelId || message.channel !== officeChannelId || !message.user) return false;
  return !message.subtype || WRITTEN_SUBTYPES.has(message.subtype);
}

export function userVerdict(user: KnownUser | null, talked: boolean, now: Date): Verdict {
  if (user?.slackId.startsWith("system:")) return skip("system_user");
  if (user?.banned) return skip("banned");
  if (user && now.getTime() - user.insertedAt.getTime() > KNOWN_FOR_DAYS * DAY_MS) return skip("known_too_long");
  if (talked) return skip("talked_to_manfrod");
  return ELIGIBLE;
}

export function memberVerdict(member: WorkspaceMember | null, teamId: string | null): Verdict {
  if (!member || !teamId) return retryLater("slack_profile_unavailable");
  if (member.deleted) return skip("deleted");
  if (member.bot) return skip("bot");
  if (member.restricted || member.ultraRestricted) return skip("guest");
  if (member.stranger || member.teamId !== teamId) return skip("external");
  return ELIGIBLE;
}

export function historyVerdict(postedBefore: boolean | null): Verdict {
  if (postedBefore === null) return retryLater("history_unavailable");
  return postedBefore ? skip("posted_before") : ELIGIBLE;
}

export function welcomeVerdict(facts: WelcomeFacts): Verdict {
  for (const verdict of [
    userVerdict(facts.user, facts.talked, facts.now),
    memberVerdict(facts.member, facts.teamId),
    historyVerdict(facts.postedBefore),
  ])
    if (!verdict.eligible) return verdict;
  return ELIGIBLE;
}

export function historyCutoff(user: KnownUser | null, now: Date): Date {
  return new Date((user?.insertedAt ?? now).getTime() - KNOWN_FOR_DAYS * DAY_MS);
}

export function delayMinutes(random: () => number = Math.random): number {
  const span = MAX_DELAY_MINUTES - MIN_DELAY_MINUTES + 1;
  return MIN_DELAY_MINUTES + Math.min(Math.floor(random() * span), span - 1);
}
