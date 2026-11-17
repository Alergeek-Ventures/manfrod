import { and, eq, inArray, sql } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { DeskPlan } from "../db/schema.ts";
import { AWAY_STATUSES } from "./away.ts";

const { deskPlans, officePresence } = tables;

export type PlanStatus = "heads_up" | "declined" | "posted";

export async function getPlan(layoutId: string, date: string): Promise<DeskPlan | null> {
  const [plan] = await db
    .select()
    .from(deskPlans)
    .where(and(eq(deskPlans.layoutId, layoutId), eq(deskPlans.date, date)))
    .limit(1);
  return plan ?? null;
}

export async function listPlans(layoutId: string, dates: string[]): Promise<DeskPlan[]> {
  if (dates.length === 0) return [];
  return db
    .select()
    .from(deskPlans)
    .where(and(eq(deskPlans.layoutId, layoutId), inArray(deskPlans.date, dates)));
}

export type PlanPatch = Partial<
  Pick<DeskPlan, "status" | "reason" | "channelId" | "messageTs" | "headsUpTs" | "awayUserIds" | "seating">
> & {
  bumpVersion?: boolean;
};

export async function savePlan(layoutId: string, date: string, patch: PlanPatch & { status: PlanStatus }): Promise<DeskPlan> {
  const { bumpVersion, ...values } = patch;
  const [plan] = await db
    .insert(deskPlans)
    .values({ layoutId, date, ...values })
    .onConflictDoUpdate({
      target: [deskPlans.layoutId, deskPlans.date],
      set: { ...values, updatedAt: new Date(), ...(bumpVersion ? { version: sql`${deskPlans.version} + 1` } : {}) },
    })
    .returning();
  return plan;
}

export async function updatePlan(layoutId: string, date: string, patch: PlanPatch): Promise<DeskPlan | null> {
  const { bumpVersion, ...values } = patch;
  const [plan] = await db
    .update(deskPlans)
    .set({ ...values, updatedAt: new Date(), ...(bumpVersion ? { version: sql`${deskPlans.version} + 1` } : {}) })
    .where(and(eq(deskPlans.layoutId, layoutId), eq(deskPlans.date, date)))
    .returning();
  return plan ?? null;
}

export function mergeAway(stored: readonly string[], recorded: { userId: string; status: string }[]): Set<string> {
  const away = new Set(stored);
  for (const row of recorded) {
    if ((AWAY_STATUSES as readonly string[]).includes(row.status)) away.add(row.userId);
    else away.delete(row.userId);
  }
  return away;
}

export async function planAwayUserIds(layoutId: string, date: string): Promise<Set<string> | null> {
  const plan = await getPlan(layoutId, date);
  if (!plan || plan.status !== "posted") return null;
  const recorded = await db
    .select({ userId: officePresence.userId, status: officePresence.status })
    .from(officePresence)
    .where(eq(officePresence.date, date));
  return mergeAway(plan.awayUserIds, recorded);
}
