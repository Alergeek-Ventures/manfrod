import { and, desc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { SelfModifyMerge } from "../db/schema.ts";

const { selfModifyMerges } = tables;

export type Decision = "merged" | "blocked" | "skipped";
export type Verdict = "better" | "no_change" | "worse" | "not_enough_data";

export interface NewDecision {
  pullNumber: number;
  headSha: string;
  decision: Decision;
  reason: string | null;
  targets: string[];
  mergeSha?: string | null;
  channelId?: string | null;
  threadTs?: string | null;
}

export async function decided(pullNumber: number, headSha: string): Promise<boolean> {
  const [row] = await db
    .select({ id: selfModifyMerges.id })
    .from(selfModifyMerges)
    .where(and(eq(selfModifyMerges.pullNumber, pullNumber), eq(selfModifyMerges.headSha, headSha)))
    .limit(1);
  return !!row;
}

export async function recordDecision(input: NewDecision): Promise<void> {
  await db
    .insert(selfModifyMerges)
    .values({ ...input, mergedAt: input.decision === "merged" ? new Date() : null })
    .onConflictDoNothing();
}

export async function mergedSince(since: Date): Promise<Date[]> {
  const rows = await db
    .select({ mergedAt: selfModifyMerges.mergedAt })
    .from(selfModifyMerges)
    .where(and(eq(selfModifyMerges.decision, "merged"), gt(selfModifyMerges.mergedAt, since)));
  return rows.flatMap((row) => (row.mergedAt ? [row.mergedAt] : []));
}

export async function lastThread(pullNumber: number): Promise<{ channelId: string; threadTs: string } | null> {
  const [row] = await db
    .select({ channelId: selfModifyMerges.channelId, threadTs: selfModifyMerges.threadTs })
    .from(selfModifyMerges)
    .where(and(eq(selfModifyMerges.pullNumber, pullNumber), isNotNull(selfModifyMerges.threadTs)))
    .orderBy(desc(selfModifyMerges.insertedAt))
    .limit(1);
  return row?.channelId && row.threadTs ? { channelId: row.channelId, threadTs: row.threadTs } : null;
}

export async function awaitingDeploy(): Promise<SelfModifyMerge[]> {
  return db
    .select()
    .from(selfModifyMerges)
    .where(and(eq(selfModifyMerges.decision, "merged"), isNotNull(selfModifyMerges.mergeSha), isNull(selfModifyMerges.liveAt)));
}

export async function markLive(id: string, taskId: string | null): Promise<void> {
  await db.update(selfModifyMerges).set({ liveAt: new Date(), taskId }).where(eq(selfModifyMerges.id, id));
}

export async function mergedPull(pullNumber: number): Promise<SelfModifyMerge | null> {
  const [row] = await db
    .select()
    .from(selfModifyMerges)
    .where(and(eq(selfModifyMerges.pullNumber, pullNumber), eq(selfModifyMerges.decision, "merged")))
    .limit(1);
  return row ?? null;
}

export async function recordVerdict(id: string, verdict: Verdict): Promise<void> {
  await db.update(selfModifyMerges).set({ verdict }).where(eq(selfModifyMerges.id, id));
}
