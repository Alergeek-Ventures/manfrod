import { getUser, getUserBySlackId, isSystemUser, isUuid, listUsers } from "../../lib/accounts.ts";
import type { User } from "../../lib/db/schema.ts";

export type PersonMatch = { ok: true; user: User } | { ok: false; message: string };

const MENTION = /^<@([A-Z0-9]+)(?:\|[^>]*)?>$/;

export async function resolvePerson(reference: string, everyone?: User[]): Promise<PersonMatch> {
  const needle = reference.trim().replace(MENTION, "$1").replace(/^@/, "");
  const exact = (await getUserBySlackId(needle)) ?? (isUuid(needle) ? await getUser(needle) : null);
  if (exact) return { ok: true, user: exact };
  const lowered = needle.toLowerCase();
  const people = (everyone ?? (await listUsers())).filter((user) => !isSystemUser(user) && !user.banned);
  const named = people.filter((user) => (user.name ?? "").toLowerCase() === lowered);
  const matches = named.length > 0 ? named : people.filter((user) => (user.name ?? "").toLowerCase().includes(lowered));
  if (matches.length === 1) return { ok: true, user: matches[0] };
  if (matches.length === 0) return { ok: false, message: `nie znam nikogo takiego jak "${reference}"` };
  return {
    ok: false,
    message: `"${reference}" pasuje do kilku osób: ${matches.map((user) => `${user.name} (${user.slackId})`).join(", ")} — podaj Slack ID`,
  };
}
