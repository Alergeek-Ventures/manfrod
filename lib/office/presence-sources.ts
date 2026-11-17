import { and, eq, gte, inArray, like, lte } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { OfficePresence } from "../db/schema.ts";
import { parseDateRange } from "../facts.ts";
import { compareDates } from "../time.ts";

const { deskReservations, desks, facts, officeMembers, officePresence, users } = tables;

export interface PersonRef {
  userId: string;
  name: string | null;
  slackId: string;
}

export async function loadMembers(layoutId: string): Promise<PersonRef[]> {
  return db
    .select({ userId: users.id, name: users.name, slackId: users.slackId })
    .from(officeMembers)
    .innerJoin(users, eq(users.id, officeMembers.userId))
    .where(eq(officeMembers.layoutId, layoutId));
}

export async function loadPeople(userIds: string[]): Promise<PersonRef[]> {
  if (userIds.length === 0) return [];
  return db.select({ userId: users.id, name: users.name, slackId: users.slackId }).from(users).where(inArray(users.id, userIds));
}

export async function loadExplicit(userIds: string[], date: string): Promise<OfficePresence[]> {
  if (userIds.length === 0) return [];
  return db
    .select()
    .from(officePresence)
    .where(and(eq(officePresence.date, date), inArray(officePresence.userId, userIds)));
}

export async function loadAbsences(userIds: string[], date: string): Promise<Map<string, string[]>> {
  const byUser = new Map<string, string[]>();
  if (userIds.length === 0) return byUser;
  const rows = await db
    .select({ userId: facts.setByUserId, value: facts.value })
    .from(facts)
    .where(and(like(facts.key, "absence:%"), inArray(facts.setByUserId, userIds)));
  for (const row of rows) {
    const range = parseDateRange(row.value);
    if (!row.userId || !range || compareDates(date, range.from) < 0 || compareDates(date, range.to) > 0) continue;
    byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row.value]);
  }
  return byUser;
}

export async function loadReservationDates(layoutId: string, userIds: string[], from: string, to: string): Promise<Map<string, string[]>> {
  const byUser = new Map<string, string[]>();
  if (userIds.length === 0) return byUser;
  const rows = await db
    .select({ userId: deskReservations.userId, date: deskReservations.date })
    .from(deskReservations)
    .innerJoin(desks, eq(desks.id, deskReservations.deskId))
    .where(
      and(
        eq(desks.layoutId, layoutId),
        eq(deskReservations.source, "manual"),
        inArray(deskReservations.userId, userIds),
        gte(deskReservations.date, from),
        lte(deskReservations.date, to),
      ),
    );
  for (const row of rows) {
    if (!row.userId) continue;
    byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row.date]);
  }
  return byUser;
}
