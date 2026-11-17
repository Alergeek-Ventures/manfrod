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
