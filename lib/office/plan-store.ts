import { and, eq, inArray, sql } from "drizzle-orm";
import { db, tables, type Db } from "../db/index.ts";
import type { DeskPlan } from "../db/schema.ts";
import { AWAY_STATUSES } from "./away.ts";

const { deskPlans, deskReservations, desks, officePresence } = tables;

export type PlanStatus = "heads_up" | "declined" | "requested" | "posting" | "posted";
export type Executor = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;

export const CLAIM_TIMEOUT_MS = 10 * 60_000;

export async function withPlanLock<T>(layoutId: string, date: string, run: (tx: Executor) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('desk-plan'), hashtext(${`${layoutId}:${date}`}))`);
    return run(tx);
  });
}

export async function getPlan(layoutId: string, date: string, exec: Executor = db): Promise<DeskPlan | null> {
  const [plan] = await exec
    .select()
    .from(deskPlans)
    .where(and(eq(deskPlans.layoutId, layoutId), eq(deskPlans.date, date)))
    .limit(1);
  return plan ?? null;
}

export async function listPlans(layoutId: string, dates: string[], exec: Executor = db): Promise<DeskPlan[]> {
  if (dates.length === 0) return [];
  return exec
    .select()
    .from(deskPlans)
    .where(and(eq(deskPlans.layoutId, layoutId), inArray(deskPlans.date, dates)));
}

export type PlanPatch = Partial<
  Pick<
    DeskPlan,
    "status" | "reason" | "channelId" | "messageTs" | "headsUpTs" | "awayUserIds" | "seating" | "claimedAt" | "message" | "requestedBy"
  >
> & {
  bumpVersion?: boolean;
};

export async function savePlan(
  layoutId: string,
  date: string,
  patch: PlanPatch & { status: PlanStatus },
  exec: Executor = db,
): Promise<DeskPlan> {
  const { bumpVersion, ...values } = patch;
  const [plan] = await exec
    .insert(deskPlans)
    .values({ layoutId, date, ...values })
    .onConflictDoUpdate({
      target: [deskPlans.layoutId, deskPlans.date],
      set: { ...values, updatedAt: new Date(), ...(bumpVersion ? { version: sql`${deskPlans.version} + 1` } : {}) },
    })
    .returning();
  return plan;
}

export async function updatePlan(layoutId: string, date: string, patch: PlanPatch, exec: Executor = db): Promise<DeskPlan | null> {
  const { bumpVersion, ...values } = patch;
  const [plan] = await exec
    .update(deskPlans)
    .set({ ...values, updatedAt: new Date(), ...(bumpVersion ? { version: sql`${deskPlans.version} + 1` } : {}) })
    .where(and(eq(deskPlans.layoutId, layoutId), eq(deskPlans.date, date)))
    .returning();
  return plan ?? null;
}

export async function deletePlan(layoutId: string, date: string, exec: Executor = db): Promise<void> {
  await exec.delete(deskPlans).where(and(eq(deskPlans.layoutId, layoutId), eq(deskPlans.date, date)));
}

export async function claimHeadsUp(layoutId: string, dates: string[], channelId: string): Promise<string[]> {
  if (dates.length === 0) return [];
  const rows = await db
    .insert(deskPlans)
    .values(dates.map((date) => ({ layoutId, date, status: "heads_up", channelId })))
    .onConflictDoNothing()
    .returning({ date: deskPlans.date });
  return rows.map((row) => row.date).sort();
}

export async function setHeadsUpTs(layoutId: string, dates: string[], ts: string): Promise<void> {
  if (dates.length === 0) return;
  await db
    .update(deskPlans)
    .set({ headsUpTs: ts, updatedAt: new Date() })
    .where(and(eq(deskPlans.layoutId, layoutId), inArray(deskPlans.date, dates)));
}

export async function releaseHeadsUp(layoutId: string, dates: string[]): Promise<void> {
  if (dates.length === 0) return;
  await db.delete(deskPlans).where(and(eq(deskPlans.layoutId, layoutId), inArray(deskPlans.date, dates), eq(deskPlans.status, "heads_up")));
}

export async function setUnpostedStatus(
  layoutId: string,
  dates: string[],
  status: "requested" | "declined",
  requestedBy: string | null = null,
): Promise<string[]> {
  if (dates.length === 0) return [];
  const rows = await db
    .update(deskPlans)
    .set({ status, requestedBy: status === "requested" ? requestedBy : null, updatedAt: new Date() })
    .where(
      and(
        eq(deskPlans.layoutId, layoutId),
        inArray(deskPlans.date, dates),
        inArray(deskPlans.status, ["heads_up", "requested", "declined"]),
      ),
    )
    .returning({ date: deskPlans.date });
  return rows.map((row) => row.date).sort();
}

export async function deletePlanSeats(layoutId: string, date: string, exec: Executor = db): Promise<void> {
  const layoutDesks = exec.select({ id: desks.id }).from(desks).where(eq(desks.layoutId, layoutId));
  await exec
    .delete(deskReservations)
    .where(and(eq(deskReservations.date, date), eq(deskReservations.source, "plan"), inArray(deskReservations.deskId, layoutDesks)));
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
