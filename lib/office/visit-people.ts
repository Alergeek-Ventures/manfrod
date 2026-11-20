import { resolvePerson } from "../people.ts";

export type VisitPeople = { userIds: string[]; guestNames: string[] };

const MENTION = /^<@[A-Z0-9]+(?:\|[^>]*)?>$/;

export async function resolveVisitPeople(names: string[]): Promise<VisitPeople> {
  const userIds: string[] = [];
  const guestNames: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name === "") continue;
    const match = await resolvePerson(name);
    if (match.ok) userIds.push(match.user.id);
    else if (!MENTION.test(name)) guestNames.push(name.replace(/^@/, ""));
  }
  return { userIds: [...new Set(userIds)], guestNames };
}
