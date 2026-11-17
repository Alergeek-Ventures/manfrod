import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { SelfModifyMerge } from "../db/schema.ts";

const { selfModifyMerges } = tables;

export type Decision = "merging" | "merged" | "retry" | "blocked" | "skipped";
export type Verdict = "better" | "no_change" | "worse" | "not_enough_data";

export const MAX_ATTEMPTS = 3;
const RETRY_BASE_MINUTES = 10;

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

export const retryDelayMinutes = (attempts: number) => RETRY_BASE_MINUTES * 2 ** Math.max(attempts - 1, 0);

export function settled(row: Pick<SelfModifyMerge, "decision" | "retryAt"> | null, now = new Date()): boolean {
  if (!row) return false;
  if (row.decision !== "retry") return true;
  return row.retryAt !== null && row.retryAt > now;
}

export async function decisionFor(pullNumber: number, headSha: string): Promise<SelfModifyMerge | null> {
  const [row] = await db
    .select()
    .from(selfModifyMerges)
    .where(and(eq(selfModifyMerges.pullNumber, pullNumber), eq(selfModifyMerges.headSha, headSha)))
    .limit(1);
  return row ?? null;
}

export async function recordDecision(input: NewDecision): Promise<void> {
  const values = {
    decision: input.decision,
    reason: input.reason,
    targets: input.targets,
    mergeSha: input.mergeSha ?? null,
    channelId: input.channelId ?? null,
    threadTs: input.threadTs ?? null,
    mergedAt: input.decision === "merged" ? new Date() : null,
    retryAt: null,
  };
  await db
    .insert(selfModifyMerges)
    .values({ pullNumber: input.pullNumber, headSha: input.headSha, ...values })
    .onConflictDoUpdate({ target: [selfModifyMerges.pullNumber, selfModifyMerges.headSha], set: values });
}

export async function startMerging(pullNumber: number, headSha: string, targets: string[]): Promise<void> {
  const values = { decision: "merging", reason: null, targets, mergedAt: new Date(), retryAt: null };
  await db
    .insert(selfModifyMerges)
    .values({ pullNumber, headSha, ...values })
    .onConflictDoUpdate({ target: [selfModifyMerges.pullNumber, selfModifyMerges.headSha], set: values });
}

export async function recordRetry(
  pullNumber: number,
  headSha: string,
  reason: string,
  targets: string[],
  replaceMerging = false,
): Promise<number | null> {
  const [row] = await db
    .insert(selfModifyMerges)
    .values({ pullNumber, headSha, decision: "retry", reason, targets, attempts: 1, retryAt: retryAt(1) })
    .onConflictDoUpdate({
      target: [selfModifyMerges.pullNumber, selfModifyMerges.headSha],
      set: {
        decision: "retry",
        reason,
        targets,
        mergedAt: null,
        attempts: sql`${selfModifyMerges.attempts} + 1`,
        retryAt: sql`timezone('UTC'::text, now()) + make_interval(mins => ${RETRY_BASE_MINUTES} * power(2, ${selfModifyMerges.attempts})::int)`,
      },
      setWhere: replaceMerging ? undefined : ne(selfModifyMerges.decision, "merging"),
    })
    .returning({ attempts: selfModifyMerges.attempts });
  return row?.attempts ?? null;
}

function retryAt(attempts: number): Date {
  return new Date(Date.now() + retryDelayMinutes(attempts) * 60_000);
}

export async function mergingRows(): Promise<SelfModifyMerge[]> {
  return db.select().from(selfModifyMerges).where(eq(selfModifyMerges.decision, "merging"));
}

export async function mergedSince(since: Date): Promise<Date[]> {
  const rows = await db
    .select({ mergedAt: selfModifyMerges.mergedAt })
    .from(selfModifyMerges)
    .where(and(inArray(selfModifyMerges.decision, ["merged", "merging"]), gt(selfModifyMerges.mergedAt, since)));
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

export async function claimLive(id: string): Promise<boolean> {
  const rows = await db
    .update(selfModifyMerges)
    .set({ liveAt: new Date() })
    .where(and(eq(selfModifyMerges.id, id), isNull(selfModifyMerges.liveAt)))
    .returning({ id: selfModifyMerges.id });
  return rows.length > 0;
}

export async function releaseLive(id: string): Promise<void> {
  await db.update(selfModifyMerges).set({ liveAt: null }).where(eq(selfModifyMerges.id, id));
}

export async function attachThread(id: string, channelId: string, threadTs: string): Promise<void> {
  await db.update(selfModifyMerges).set({ channelId, threadTs }).where(eq(selfModifyMerges.id, id));
}

export async function attachVerification(id: string, taskId: string, channelId: string, threadTs: string): Promise<void> {
  await db.update(selfModifyMerges).set({ taskId, channelId, threadTs }).where(eq(selfModifyMerges.id, id));
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
