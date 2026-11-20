import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { OfficePresence, OfficeVisit } from "../db/schema.ts";
import { compareDates, isValidIsoDate } from "../time.ts";
import { getLayout } from "./layout.ts";
import type { StatedStatus } from "./presence-resolve.ts";

const { officeLayouts, officePresence, officeVisits } = tables;

export type PresenceSource = "chat" | "button";

export async function defaultLayoutId(): Promise<string | null> {
  return (await getLayout()).id;
}

export async function setPresence(
  userId: string,
  date: string,
  status: StatedStatus,
  source: PresenceSource,
  note: string | null = null,
): Promise<OfficePresence> {
  const values = { status, source, note, updatedAt: new Date() };
  const [row] = await db
    .insert(officePresence)
    .values({ userId, date, ...values })
    .onConflictDoUpdate({ target: [officePresence.userId, officePresence.date], set: values })
    .returning();
  return row;
}

export async function clearPresence(userId: string, date: string): Promise<boolean> {
  const deleted = await db
    .delete(officePresence)
    .where(and(eq(officePresence.userId, userId), eq(officePresence.date, date)))
    .returning({ id: officePresence.id });
  return deleted.length > 0;
}

export interface VisitInput {
  layoutId?: string;
  startsOn: string;
  endsOn: string;
  userIds: string[];
  guests: number;
  guestNames?: string[];
  note: string;
  createdBy: string | null;
}

export type VisitError = "invalid_dates" | "nobody" | "invalid_guests" | "no_layout";

export const MAX_GUEST_NAME = 60;

export function cleanGuestNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.flatMap((raw) => {
    const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_GUEST_NAME);
    const key = name.toLowerCase();
    if (name === "" || seen.has(key)) return [];
    seen.add(key);
    return [name];
  });
}

export function visitError(
  visit: Pick<VisitInput, "startsOn" | "endsOn" | "userIds" | "guests"> & { guestNames: string[] },
): VisitError | null {
  if (!isValidIsoDate(visit.startsOn) || !isValidIsoDate(visit.endsOn) || compareDates(visit.endsOn, visit.startsOn) < 0)
    return "invalid_dates";
  if (!Number.isInteger(visit.guests) || visit.guests < 0 || visit.guestNames.length > visit.guests) return "invalid_guests";
  if (visit.userIds.length === 0 && visit.guests === 0) return "nobody";
  return null;
}

export type VisitLike = Pick<OfficeVisit, "startsOn" | "endsOn" | "userIds" | "createdBy">;

export function duplicateVisit<T extends VisitLike>(existing: T[], input: VisitLike): T | null {
  return (
    existing.find((visit) => {
      const overlaps = compareDates(visit.startsOn, input.endsOn) <= 0 && compareDates(visit.endsOn, input.startsOn) >= 0;
      if (!overlaps) return false;
      const sameAuthor = input.createdBy !== null && visit.createdBy === input.createdBy;
      const samePeople = input.userIds.some((userId) => visit.userIds.includes(userId));
      return sameAuthor || samePeople;
    }) ?? null
  );
}

export type RecordedVisit = { ok: true; visit: OfficeVisit; duplicate: boolean } | { ok: false; error: VisitError };

export async function recordVisit(input: VisitInput): Promise<RecordedVisit> {
  const userIds = [...new Set(input.userIds)];
  const guestNames = cleanGuestNames(input.guestNames ?? []);
  const error = visitError({ ...input, userIds, guestNames });
  if (error) return { ok: false, error };
  const layoutId = input.layoutId ?? (await defaultLayoutId());
  if (!layoutId) return { ok: false, error: "no_layout" };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('office-visits'), hashtext(${layoutId}))`);
    const overlapping = await tx
      .select()
      .from(officeVisits)
      .where(
        and(
          eq(officeVisits.layoutId, layoutId),
          isNull(officeVisits.cancelledAt),
          lte(officeVisits.startsOn, input.endsOn),
          gte(officeVisits.endsOn, input.startsOn),
        ),
      );
    const duplicate = duplicateVisit(overlapping, { ...input, userIds });
    if (duplicate) {
      const names = cleanGuestNames([...duplicate.guestNames, ...guestNames]);
      const [visit] = await tx
        .update(officeVisits)
        .set({
          startsOn: compareDates(input.startsOn, duplicate.startsOn) < 0 ? input.startsOn : duplicate.startsOn,
          endsOn: compareDates(input.endsOn, duplicate.endsOn) > 0 ? input.endsOn : duplicate.endsOn,
          userIds: [...new Set([...duplicate.userIds, ...userIds])],
          guests: Math.max(duplicate.guests, input.guests, names.length),
          guestNames: names,
        })
        .where(eq(officeVisits.id, duplicate.id))
        .returning();
      return { ok: true as const, visit, duplicate: true };
    }
    const [visit] = await tx
      .insert(officeVisits)
      .values({
        layoutId,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        userIds,
        guests: input.guests,
        guestNames,
        note: input.note,
        createdBy: input.createdBy,
      })
      .returning();
    return { ok: true as const, visit, duplicate: false };
  });
}

export type VisitPatch = Partial<Pick<OfficeVisit, "startsOn" | "endsOn" | "userIds" | "guests" | "guestNames" | "note">>;

export type UpdatedVisit = { ok: true; visit: OfficeVisit; previous: OfficeVisit } | { ok: false; error: VisitError | "not_found" };

export async function updateVisit(id: string, patch: VisitPatch): Promise<UpdatedVisit> {
  return db.transaction(async (tx) => {
    const [previous] = await tx
      .select()
      .from(officeVisits)
      .where(and(eq(officeVisits.id, id), isNull(officeVisits.cancelledAt)))
      .for("update");
    if (!previous) return { ok: false as const, error: "not_found" as const };
    const next = {
      startsOn: patch.startsOn ?? previous.startsOn,
      endsOn: patch.endsOn ?? previous.endsOn,
      userIds: [...new Set(patch.userIds ?? previous.userIds)],
      guestNames: cleanGuestNames(patch.guestNames ?? previous.guestNames),
      guests: patch.guests ?? previous.guests,
      note: patch.note?.trim() || previous.note,
    };
    const error = visitError(next);
    if (error) return { ok: false as const, error };
    const [visit] = await tx.update(officeVisits).set(next).where(eq(officeVisits.id, id)).returning();
    return { ok: true as const, visit, previous };
  });
}

export async function getVisit(id: string): Promise<OfficeVisit | null> {
  const [visit] = await db.select().from(officeVisits).where(eq(officeVisits.id, id)).limit(1);
  return visit ?? null;
}

export async function cancelVisit(id: string): Promise<OfficeVisit | null> {
  const [visit] = await db
    .update(officeVisits)
    .set({ cancelledAt: new Date() })
    .where(and(eq(officeVisits.id, id), isNull(officeVisits.cancelledAt)))
    .returning();
  return visit ?? null;
}

export async function listVisits(from: string, to: string, opts: { layoutId?: string } = {}): Promise<OfficeVisit[]> {
  return db
    .select()
    .from(officeVisits)
    .where(
      and(
        isNull(officeVisits.cancelledAt),
        lte(officeVisits.startsOn, to),
        gte(officeVisits.endsOn, from),
        opts.layoutId ? eq(officeVisits.layoutId, opts.layoutId) : undefined,
      ),
    )
    .orderBy(asc(officeVisits.startsOn), asc(officeVisits.insertedAt));
}
