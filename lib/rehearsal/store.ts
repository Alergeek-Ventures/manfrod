import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
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

export async function pendingLive(): Promise<SelfModifyRehearsal[]> {
  return db
    .select({ rehearsal: selfModifyRehearsals })
    .from(selfModifyRehearsals)
    .innerJoin(selfModifyMerges, eq(selfModifyMerges.id, selfModifyRehearsals.mergeId))
    .where(and(eq(selfModifyRehearsals.status, "pending"), isNotNull(selfModifyMerges.liveAt)))
    .then((rows) => rows.map((row) => row.rehearsal));
}

export async function running(): Promise<SelfModifyRehearsal[]> {
  return db.select().from(selfModifyRehearsals).where(eq(selfModifyRehearsals.status, "running"));
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
  const rows = await db
    .update(selfModifyRehearsals)
    .set({ scenario: null, transcript: null })
    .where(and(lt(selfModifyRehearsals.insertedAt, cutoff), isNotNull(selfModifyRehearsals.scenario)))
    .returning({ id: selfModifyRehearsals.id });
  return rows.length;
}
