import { listUsers } from "../../lib/accounts.ts";
import type { User } from "../../lib/db/schema.ts";
import { resolvePerson } from "../../lib/people.ts";

export const VISIT_ERRORS = {
  invalid_dates: "Invalid dates: use YYYY-MM-DD and end_date on or after start_date.",
  invalid_guests: "guests must be a whole number, 0 or more.",
  nobody: "Nothing saved: name at least one person or give a guest count.",
  no_layout: "Nothing saved: no office is set up yet.",
  not_found: "No active visit with that ID; check list-office-presence.",
};

export const VISIT_REFUSAL = "Office visits are only available in team channels and DMs.";

export const canEditVisits = (readableLevels: readonly string[]) => readableLevels.includes("internal");

export type ResolvedPeople = { ok: true; userIds: string[]; everyone: User[] } | { ok: false; message: string };

export async function resolveVisitors(people: string[]): Promise<ResolvedPeople> {
  const everyone = await listUsers();
  const matches = await Promise.all(people.map((person) => resolvePerson(person, everyone)));
  const problems = matches.flatMap((match) => (match.ok ? [] : [match.message]));
  if (problems.length > 0)
    return {
      ok: false,
      message: `Nothing saved: ${problems.join("; ")}. Fix the names, or put people who have no Slack account in guest_names.`,
    };
  const users = matches.flatMap((match) => (match.ok ? [match.user] : []));
  return { ok: true, userIds: users.map((user) => user.id), everyone: [...everyone, ...users.filter((user) => !everyone.includes(user))] };
}

export const nameMap = (users: User[]) => new Map(users.map((user) => [user.id, user.name ?? user.slackId]));
