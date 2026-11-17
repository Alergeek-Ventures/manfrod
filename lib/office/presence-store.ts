import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
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
  note: string;
  createdBy: string | null;
}

export type VisitError = "invalid_dates" | "nobody" | "invalid_guests" | "no_layout";

export async function recordVisit(input: VisitInput): Promise<{ ok: true; visit: OfficeVisit } | { ok: false; error: VisitError }> {
  if (!isValidIsoDate(input.startsOn) || !isValidIsoDate(input.endsOn) || compareDates(input.endsOn, input.startsOn) < 0)
    return { ok: false, error: "invalid_dates" };
  if (!Number.isInteger(input.guests) || input.guests < 0) return { ok: false, error: "invalid_guests" };
  const userIds = [...new Set(input.userIds)];
  if (userIds.length === 0 && input.guests === 0) return { ok: false, error: "nobody" };
  const layoutId = input.layoutId ?? (await defaultLayoutId());
  if (!layoutId) return { ok: false, error: "no_layout" };
  const [visit] = await db
    .insert(officeVisits)
    .values({
      layoutId,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      userIds,
      guests: input.guests,
      note: input.note,
      createdBy: input.createdBy,
    })
    .returning();
  return { ok: true, visit };
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
