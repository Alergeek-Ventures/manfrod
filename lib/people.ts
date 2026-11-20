import { findOrCreateBySlackId, getUser, getUserByEmail, getUserBySlackId, isSystemUser, isUuid, listUsers } from "./accounts.ts";
import type { User } from "./db/schema.ts";
import { logger } from "./log.ts";
import { foldName } from "./names.ts";
import { botIdentity, fetchWorkspaceMember, openDm, workspaceMembers, type WorkspaceMember } from "./slack/api.ts";

const log = logger("People");

export type PersonMatch = { ok: true; user: User } | { ok: false; message: string; unknown: boolean };

export type ResolveOptions = { everyone?: User[]; adopt?: boolean; strict?: boolean };

const MENTION = /^<@([A-Z0-9]+)(?:\|[^>]*)?>$/;
const SLACK_USER_ID = /^[UW][A-Z0-9]{6,}$/;

const firstWord = (text: string) => text.split(" ")[0];

function pick<T>(candidates: T[], names: (candidate: T) => string[], needle: string): T[] {
  const named = candidates.filter((candidate) => names(candidate).some((name) => name === needle));
  if (named.length > 0) return named;
  return candidates.filter((candidate) => names(candidate).some((name) => firstWord(name) === needle));
}

const memberNames = (member: WorkspaceMember) =>
  [member.realName, member.displayName, member.handle].flatMap((name) => (name ? [foldName(name)] : []));

export const adoptable = (member: WorkspaceMember, teamId: string) =>
  !member.deleted && !member.bot && !member.restricted && !member.ultraRestricted && !member.stranger && member.teamId === teamId;

async function ownTeam(): Promise<string | null> {
  return (await botIdentity())?.teamId ?? null;
}

async function adopt(member: WorkspaceMember): Promise<User | null> {
  try {
    const dm = (await openDm(member.id)) ?? member.id;
    return await findOrCreateBySlackId(member.id, dm, member.realName ?? member.displayName ?? member.handle, member.email);
  } catch (error) {
    log.warn(`People: could not add Slack user ${member.id}: ${(error as Error).message}`);
    return null;
  }
}

async function fromSlackId(slackId: string): Promise<User | null> {
  const team = await ownTeam();
  if (!team) return null;
  const member = (await workspaceMembers())?.find((candidate) => candidate.id === slackId) ?? (await fetchWorkspaceMember(slackId));
  return member && adoptable(member, team) ? adopt(member) : null;
}

async function fromSlackName(reference: string, needle: string, everyone: User[]): Promise<PersonMatch | null> {
  const team = await ownTeam();
  const listed = team ? await workspaceMembers() : null;
  if (!team || !listed) return null;
  const matches = pick(
    listed.filter((member) => adoptable(member, team)),
    memberNames,
    needle,
  );
  if (matches.length === 0) return null;
  if (matches.length > 1)
    return {
      ok: false,
      unknown: false,
      message: `"${reference}" pasuje do kilku osób na Slacku: ${matches.map((member) => `${member.realName ?? member.handle} (${member.id})`).join(", ")} — podaj Slack ID`,
    };
  const [member] = matches;
  const existing = everyone.find((user) => user.slackId === member.id);
  if (existing) return existing.banned ? null : { ok: true, user: existing };
  const user = await adopt(member);
  return user ? { ok: true, user } : null;
}

export async function resolvePerson(reference: string, options: ResolveOptions = {}): Promise<PersonMatch> {
  const { everyone, adopt: mayAdopt = true, strict = false } = options;
  const needle = reference.trim().replace(MENTION, "$1").replace(/^@/, "");
  const byEmail = needle.includes("@") ? await getUserByEmail(needle.toLowerCase()) : null;
  const exact = (await getUserBySlackId(needle)) ?? byEmail ?? (isUuid(needle) ? await getUser(needle) : null);
  if (exact) return { ok: true, user: exact };
  if (mayAdopt && SLACK_USER_ID.test(needle)) {
    const adopted = await fromSlackId(needle);
    if (adopted) return { ok: true, user: adopted };
  }
  const folded = foldName(needle);
  const all = everyone ?? (await listUsers());
  const people = all.filter((user) => !isSystemUser(user) && !user.banned);
  const local = pick(people, (user) => (user.name ? [foldName(user.name)] : []), folded);
  const matches = local.length > 0 || strict ? local : people.filter((user) => foldName(user.name ?? "").includes(folded));
  if (matches.length === 1) return { ok: true, user: matches[0] };
  if (matches.length > 1)
    return {
      ok: false,
      unknown: false,
      message: `"${reference}" pasuje do kilku osób: ${matches.map((user) => `${user.name} (${user.slackId})`).join(", ")} — podaj Slack ID`,
    };
  if (mayAdopt && folded !== "") {
    const slack = await fromSlackName(reference, folded, all).catch((error) => {
      log.warn(`People: Slack lookup for "${reference}" failed: ${(error as Error).message}`);
      return null;
    });
    if (slack) return slack;
  }
  return { ok: false, unknown: true, message: `nie znam nikogo takiego jak "${reference}" (nie ma go też na Slacku)` };
}
