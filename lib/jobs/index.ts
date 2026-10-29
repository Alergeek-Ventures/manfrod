import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { Job } from "../db/schema.ts";
import { getUser } from "../accounts.ts";
import { EVENTS, sendEvent, type JobScheduledData } from "../inngest/client.ts";

const { jobs } = tables;

export type JobKind = "trigger" | "skill_trigger" | "firmowid_session_check" | "firmowid_morning_session_check" | "task_check";

export interface EnqueueOptions {
  scheduledAt?: Date;
  uniqueKey?: string;
  meta?: Record<string, unknown>;
  maxAttempts?: number;
}

export interface EnqueueResult {
  job: Job | null;
  conflict: boolean;
}

export function jobLabel(kind: string, args: Record<string, unknown>, personName: string | null): string {
  const who = personName ? ` (${personName})` : "";
  switch (kind) {
    case "skill_trigger":
      return `${String(args.skill_name ?? "skill")}${who}`;
    case "trigger":
      return `${args.recurring_reminder_id ? "recurring reminder" : "reminder"}${who}`;
    case "firmowid_session_check":
      return `firmowid evening check${who}`;
    case "firmowid_morning_session_check":
      return `firmowid morning check${who}`;
    case "task_check":
      return `task: ${String(args.title ?? args.task_id)}`;
    default:
      return `${kind}${who}`;
  }
}

export async function describeJob(job: Job): Promise<JobScheduledData> {
  const args = job.args as Record<string, unknown>;
  const meta = job.meta as Record<string, unknown>;
  const userId = typeof args.user_id === "string" ? args.user_id : null;
  const personName = typeof meta.user_name === "string" ? meta.user_name : userId ? ((await getUser(userId))?.name ?? null) : null;
  return { jobId: job.id, kind: job.kind, label: jobLabel(job.kind, args, personName), userId, scheduledAt: job.scheduledAt.toISOString() };
}

export async function dispatch(job: Job): Promise<void> {
  if (await sendEvent(EVENTS.jobScheduled, await describeJob(job))) {
    await db.update(jobs).set({ dispatchedAt: new Date() }).where(eq(jobs.id, job.id));
  }
}

export async function enqueue(kind: JobKind, args: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<EnqueueResult> {
  const [job] = await db
    .insert(jobs)
    .values({
      kind,
      args,
      meta: opts.meta ?? {},
      scheduledAt: opts.scheduledAt ?? new Date(),
      uniqueKey: opts.uniqueKey ?? null,
      maxAttempts: opts.maxAttempts ?? 3,
      state: "scheduled",
    })
    .onConflictDoNothing({ target: jobs.uniqueKey })
    .returning();

  if (!job) return { job: null, conflict: true };
  await dispatch(job);
  return { job, conflict: false };
}

export async function getJob(id: number): Promise<Job | null> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return job ?? null;
}

export async function markExecuting(id: number): Promise<Job | null> {
  const [job] = await db
    .update(jobs)
    .set({ state: "executing", attempt: sql`${jobs.attempt} + 1` })
    .where(and(eq(jobs.id, id), inArray(jobs.state, ["scheduled", "executing"])))
    .returning();
  return job ?? null;
}

export async function completeJob(id: number): Promise<void> {
  await db.update(jobs).set({ state: "completed", completedAt: new Date() }).where(eq(jobs.id, id));
}

export async function failJob(id: number, error: unknown, final: boolean): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db
    .update(jobs)
    .set(final ? { state: "discarded", lastError: message, completedAt: new Date() } : { lastError: message })
    .where(eq(jobs.id, id));
}

export async function cancelJob(id: number): Promise<boolean> {
  const result = await db
    .update(jobs)
    .set({ state: "cancelled", completedAt: new Date() })
    .where(and(eq(jobs.id, id), eq(jobs.state, "scheduled")));
  const cancelled = (result.rowCount ?? 0) > 0;
  if (cancelled) await sendEvent(EVENTS.jobCancelled, { jobId: id });
  return cancelled;
}

export async function listPendingJobs(kind: JobKind, where?: ReturnType<typeof sql>): Promise<Job[]> {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, kind), eq(jobs.state, "scheduled"), where))
    .orderBy(asc(jobs.scheduledAt));
}

async function cancelWhere(where: ReturnType<typeof sql> | ReturnType<typeof and>): Promise<number> {
  const cancelled = await db
    .update(jobs)
    .set({ state: "cancelled", completedAt: new Date() })
    .where(and(eq(jobs.state, "scheduled"), where))
    .returning({ id: jobs.id });
  await Promise.all(cancelled.map((job) => sendEvent(EVENTS.jobCancelled, { jobId: job.id })));
  return cancelled.length;
}

export function cancelPendingTriggerJobs(recurringReminderId: string): Promise<number> {
  return cancelWhere(and(eq(jobs.kind, "trigger"), sql`${jobs.args}->>'recurring_reminder_id' = ${recurringReminderId}`));
}

export async function dispatchUndispatched(): Promise<number> {
  const pending = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.state, "scheduled"), isNull(jobs.dispatchedAt)))
    .orderBy(asc(jobs.scheduledAt))
    .limit(500);
  for (const job of pending) await dispatch(job);
  return pending.length;
}

export async function pruneJobs(maxAgeDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000);
  const result = await db
    .delete(jobs)
    .where(and(inArray(jobs.state, ["completed", "cancelled", "discarded"]), lt(jobs.completedAt, cutoff)));
  return result.rowCount ?? 0;
}
