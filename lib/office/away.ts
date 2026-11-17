import { and, eq, inArray } from "drizzle-orm";
import { db, tables } from "../db/index.ts";

const { officePresence } = tables;

export const AWAY_STATUSES = ["remote", "leave"] as const;

export async function recordedAwayUserIds(date: string): Promise<Set<string>> {
  const rows = await db
    .select({ userId: officePresence.userId })
    .from(officePresence)
    .where(and(eq(officePresence.date, date), inArray(officePresence.status, [...AWAY_STATUSES])));
  return new Set(rows.map((row) => row.userId));
}

export const CONFIRMED_AWAY_SOURCES: ReadonlySet<string> = new Set([
  "explicit_chat",
  "explicit_button",
  "firmowid_leave",
  "absence",
  "firmowid_session",
]);

export const isConfirmedAway = (person: { status: string; sources: readonly string[] }) =>
  (AWAY_STATUSES as readonly string[]).includes(person.status) && person.sources.some((source) => CONFIRMED_AWAY_SOURCES.has(source));
