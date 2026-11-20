import { logger } from "../log.ts";
import { resolvePerson } from "../people.ts";

const log = logger("Office.VisitPeople");

export type VisitPeople = { userIds: string[]; guestNames: string[] };

const MENTION = /^<@[A-Z0-9]+(?:\|[^>]*)?>$/;

export async function resolveVisitPeople(names: string[]): Promise<VisitPeople> {
  const userIds: string[] = [];
  const guestNames: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name === "") continue;
    const match = await resolvePerson(name, { strict: true });
    if (match.ok) {
      userIds.push(match.user.id);
      continue;
    }
    if (!match.unknown) log.info(`Office.VisitPeople: "${name}" is ambiguous, keeping it as a named guest: ${match.message}`);
    if (!MENTION.test(name)) guestNames.push(name.replace(/^@/, ""));
  }
  return { userIds: [...new Set(userIds)], guestNames };
}
