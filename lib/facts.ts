import { and, asc, eq, inArray, like, ne } from "drizzle-orm";
import { db, tables } from "./db/index.ts";
import type { Fact } from "./db/schema.ts";
import { accessOverlaps } from "./memory/access.ts";
import { compareDates, isValidIsoDate } from "./time.ts";
import { isUuid } from "./accounts.ts";

const { facts } = tables;

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (match) => `\\${match}`);

export async function setFact(key: string, value: string, access: string[], userId: string | null): Promise<Fact> {
  if (access.length < 1) throw new Error("access: should have at least 1 item(s)");
  const setByUserId = isUuid(userId) ? userId : null;
  const [existing] = await db.select().from(facts).where(eq(facts.key, key)).limit(1);

  if (!existing) {
    const [created] = await db.insert(facts).values({ key, value, access, setByUserId }).returning();
    return created;
  }

  const [updated] = await db.update(facts).set({ value, access }).where(eq(facts.id, existing.id)).returning();
  return updated;
}

export async function addAccess(key: string, level: string): Promise<Fact | null> {
  const [existing] = await db.select().from(facts).where(eq(facts.key, key)).limit(1);
  if (!existing) return null;
  const [updated] = await db
    .update(facts)
    .set({ access: [...new Set([...existing.access, level])] })
    .where(eq(facts.id, existing.id))
    .returning();
  return updated;
}

export async function getFact(key: string, readableLevels: string[]): Promise<Fact | null> {
  const [fact] = await db
    .select()
    .from(facts)
    .where(and(eq(facts.key, key), accessOverlaps(facts.access, readableLevels)))
    .limit(1);
  return fact ?? null;
}

export async function listFacts(prefix: string, readableLevels: string[]): Promise<Fact[]> {
  return db
    .select()
    .from(facts)
    .where(and(like(facts.key, `${escapeLike(prefix)}%`), accessOverlaps(facts.access, readableLevels)))
    .orderBy(asc(facts.key));
}

export async function listFactsByUser(prefix: string, userId: string, readableLevels: string[]): Promise<Fact[]> {
  if (!isUuid(userId)) return [];
  return db
    .select()
    .from(facts)
    .where(
      and(
        like(facts.key, `${escapeLike(prefix)}%`),
        eq(facts.setByUserId, userId),
        accessOverlaps(facts.access, readableLevels),
      ),
    )
    .orderBy(asc(facts.key));
}

export async function listFactsByUserUnscoped(prefix: string, userId: string): Promise<Fact[]> {
  if (!isUuid(userId)) return [];
  return db
    .select()
    .from(facts)
    .where(and(like(facts.key, `${escapeLike(prefix)}%`), eq(facts.setByUserId, userId)))
    .orderBy(asc(facts.key));
}

export function parseDateRange(value: string): { from: string; to: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/.exec(value);
  if (!match || !isValidIsoDate(match[1]) || !isValidIsoDate(match[2])) return null;
  return { from: match[1], to: match[2] };
}

export async function overlappingAbsences(userId: string, startDate: string, endDate: string): Promise<Fact[]> {
  if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate)) return [];
  const absences = await listFactsByUserUnscoped("absence:", userId);
  return absences.filter((fact) => {
    const range = parseDateRange(fact.value);
    return range !== null && compareDates(startDate, range.to) <= 0 && compareDates(endDate, range.from) >= 0;
  });
}

export async function putAbsence(
  userId: string,
  startDate: string,
  endDate: string,
  description: string,
  access: string[],
): Promise<{ fact: Fact; outcome: "created" | "replaced" }> {
  const key = `absence:${userId}:${startDate}`;
  const value = `${startDate}..${endDate} — ${description}`;

  return db.transaction(async (tx) => {
    const overlapping = await overlappingAbsences(userId, startDate, endDate);

    if (overlapping.length === 0) {
      const [existing] = await tx.select().from(facts).where(eq(facts.key, key)).limit(1);
      if (existing) {
        const [updated] = await tx.update(facts).set({ value, access }).where(eq(facts.id, existing.id)).returning();
        return { fact: updated, outcome: "created" as const };
      }
      const [created] = await tx.insert(facts).values({ key, value, access, setByUserId: userId }).returning();
      return { fact: created, outcome: "created" as const };
    }

    const [kept, ...others] = overlapping;
    if (others.length > 0) await tx.delete(facts).where(inArray(facts.id, others.map((fact) => fact.id)));
    await tx.delete(facts).where(and(eq(facts.key, key), ne(facts.id, kept.id)));
    const [updated] = await tx.update(facts).set({ key, value }).where(eq(facts.id, kept.id)).returning();
    return { fact: updated, outcome: "replaced" as const };
  });
}

export async function deleteAbsences(userId: string, startDate: string, endDate: string): Promise<Fact[]> {
  const absences = await overlappingAbsences(userId, startDate, endDate);
  if (absences.length > 0) await db.delete(facts).where(inArray(facts.id, absences.map((fact) => fact.id)));
  return absences;
}

export async function deleteAbsencesEndedBefore(date: string): Promise<number> {
  const absences = await db.select().from(facts).where(like(facts.key, "absence:%"));
  const ids = absences
    .filter((fact) => {
      const range = parseDateRange(fact.value);
      return range !== null && compareDates(range.to, date) < 0;
    })
    .map((fact) => fact.id);
  if (ids.length === 0) return 0;
  const result = await db.delete(facts).where(inArray(facts.id, ids));
  return result.rowCount ?? 0;
}
