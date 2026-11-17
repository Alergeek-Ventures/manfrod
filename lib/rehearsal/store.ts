import { and, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { SelfModifyRehearsal } from "../db/schema.ts";
import type { RehearsalVerdict, Transcript } from "./judge.ts";
import type { PlannedRehearsal } from "./scenarios.ts";

const { selfModifyMerges, selfModifyRehearsals } = tables;

export async function insertPlanned(mergeId: string, planned: PlannedRehearsal[]): Promise<void> {
  if (planned.length === 0) return;
  await db.insert(selfModifyRehearsals).values(
    planned.map((entry) => ({
      mergeId,
      userId: entry.userId,
      channelId: entry.channelId,
      evidenceLink: entry.evidenceLink,
      scenario: entry.scenario,
    })),
  );
}

export interface PendingRehearsal extends SelfModifyRehearsal {
  liveAt: Date;
}

export async function pendingLive(limit: number): Promise<PendingRehearsal[]> {
  const rows = await db
    .select({ rehearsal: selfModifyRehearsals, liveAt: selfModifyMerges.liveAt })
    .from(selfModifyRehearsals)
    .innerJoin(selfModifyMerges, eq(selfModifyMerges.id, selfModifyRehearsals.mergeId))
    .where(and(eq(selfModifyRehearsals.status, "pending"), isNotNull(selfModifyMerges.liveAt)))
    .orderBy(selfModifyRehearsals.insertedAt)
    .limit(limit);
  return rows.map((row) => ({ ...row.rehearsal, liveAt: row.liveAt! }));
}

export async function running(limit: number): Promise<SelfModifyRehearsal[]> {
  return db
    .select()
    .from(selfModifyRehearsals)
    .where(eq(selfModifyRehearsals.status, "running"))
    .orderBy(selfModifyRehearsals.startedAt)
    .limit(limit);
}

export async function failedStart(id: string): Promise<number> {
  const [row] = await db
    .update(selfModifyRehearsals)
    .set({ startAttempts: sql`${selfModifyRehearsals.startAttempts} + 1` })
    .where(eq(selfModifyRehearsals.id, id))
    .returning({ startAttempts: selfModifyRehearsals.startAttempts });
  return row?.startAttempts ?? 0;
}

export async function markRunning(id: string, sessionId: string): Promise<void> {
  await db.update(selfModifyRehearsals).set({ status: "running", sessionId, startedAt: new Date() }).where(eq(selfModifyRehearsals.id, id));
}

export async function finish(
  id: string,
  status: "done" | "failed",
  transcript: Transcript | null,
  verdict: RehearsalVerdict,
  reason: string,
): Promise<void> {
  await db
    .update(selfModifyRehearsals)
    .set({ status, transcript, verdict, reason, finishedAt: new Date() })
    .where(eq(selfModifyRehearsals.id, id));
}

export async function forMerges(mergeIds: string[]): Promise<SelfModifyRehearsal[]> {
  if (mergeIds.length === 0) return [];
  return db.select().from(selfModifyRehearsals).where(inArray(selfModifyRehearsals.mergeId, mergeIds));
}

export async function clearTranscriptsOlderThan(days: number): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const expired = await db
    .update(selfModifyRehearsals)
    .set({
      status: "failed",
      verdict: "unclear",
      reason: "The rehearsal expired before it ran.",
      finishedAt: new Date(),
      scenario: null,
      transcript: null,
    })
    .where(and(inArray(selfModifyRehearsals.status, ["pending", "running"]), lt(selfModifyRehearsals.insertedAt, cutoff)))
    .returning({ id: selfModifyRehearsals.id });
  const cleared = await db
    .update(selfModifyRehearsals)
    .set({ scenario: null, transcript: null })
    .where(
      and(
        inArray(selfModifyRehearsals.status, ["done", "failed"]),
        lt(selfModifyRehearsals.finishedAt, cutoff),
        or(isNotNull(selfModifyRehearsals.scenario), isNotNull(selfModifyRehearsals.transcript)),
      ),
    )
    .returning({ id: selfModifyRehearsals.id });
  return expired.length + cleared.length;
}
