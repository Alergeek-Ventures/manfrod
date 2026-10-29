import { and, asc, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { getUser, isAdmin, isUuid } from "../accounts.ts";
import { db, tables } from "../db/index.ts";
import type { AgentTask, AgentTaskUpdate } from "../db/schema.ts";
import { cancelJob, enqueue } from "../jobs/index.ts";
import { addDays, dateIsoInZone, formatLocal, zonedParts, zonedToUtc } from "../time.ts";

const { agentTasks, agentTaskUpdates, sentDms } = tables;

export const MIN_CHECK_MINUTES = 15;
export const MAX_CHECK_MINUTES = 7 * 24 * 60;
export const MAX_CHECKS = 100;
export const OPEN_STATUSES = ["active", "blocked"] as const;
export const CLOSED_STATUSES = ["done", "cancelled", "failed"] as const;
export type ClosedStatus = (typeof CLOSED_STATUSES)[number];

const WORK_START = "08:00";
const WORK_START_HOUR = 8;
const WORK_END_HOUR = 18;
const CONTACT_LOOKBACK_DAYS = 30;
const CLIP = 300;

const clip = (text: string, limit = CLIP) => (text.length > limit ? `${text.slice(0, limit)}…` : text);
const isWorkday = (dateIso: string) => [1, 2, 3, 4, 5].includes(new Date(`${dateIso}T12:00:00Z`).getUTCDay());

export function withinWorkingHours(date: Date): Date {
  const { hour } = zonedParts(date);
  let day = dateIsoInZone(date);
  if (isWorkday(day) && hour >= WORK_START_HOUR && hour < WORK_END_HOUR) return date;
  if (isWorkday(day) && hour < WORK_START_HOUR) return zonedToUtc(day, WORK_START);
  do day = addDays(day, 1);
  while (!isWorkday(day));
  return zonedToUtc(day, WORK_START);
}

export const clampInterval = (minutes: number) => Math.min(MAX_CHECK_MINUTES, Math.max(MIN_CHECK_MINUTES, Math.round(minutes)));

export const isFinalCheck = (task: Pick<AgentTask, "checks" | "deadline">, now = Date.now()) =>
  task.checks >= MAX_CHECKS || (task.deadline !== null && task.deadline.getTime() <= now);

export interface NewTask {
  ownerUserId: string;
  title: string;
  goal: string;
  successCriteria: string;
  plan: string | null;
  channelId: string;
  threadTs: string;
  readableLevels: string[];
  writeAccess: string[];
  checkEveryMinutes: number;
  firstCheckAt: Date | null;
  deadline: Date | null;
}

export async function createTask(input: NewTask): Promise<AgentTask> {
  const [task] = await db
    .insert(agentTasks)
    .values({
      ownerUserId: input.ownerUserId,
      title: input.title,
      goal: input.goal,
      successCriteria: input.successCriteria,
      plan: input.plan,
      channelId: input.channelId,
      threadTs: input.threadTs,
      readableLevels: input.readableLevels,
      writeAccess: input.writeAccess,
      checkEveryMinutes: clampInterval(input.checkEveryMinutes),
      deadline: input.deadline,
    })
    .returning();
  const at = input.firstCheckAt ?? new Date(Date.now() + task.checkEveryMinutes * 60_000);
  return { ...task, nextCheckAt: await scheduleCheck(task, at) };
}

export async function getTask(id: string): Promise<AgentTask | null> {
  if (!isUuid(id)) return null;
  const [task] = await db.select().from(agentTasks).where(eq(agentTasks.id, id)).limit(1);
  return task ?? null;
}

export async function listOpenTasks(filter: { ownerUserId?: string; channelId?: string; threadTs?: string } = {}): Promise<AgentTask[]> {
  return db
    .select()
    .from(agentTasks)
    .where(
      and(
        inArray(agentTasks.status, [...OPEN_STATUSES]),
        filter.ownerUserId ? eq(agentTasks.ownerUserId, filter.ownerUserId) : undefined,
        filter.channelId ? eq(agentTasks.channelId, filter.channelId) : undefined,
        filter.threadTs ? eq(agentTasks.threadTs, filter.threadTs) : undefined,
      ),
    )
    .orderBy(asc(agentTasks.insertedAt));
}

export async function addUpdate(taskId: string, content: string): Promise<void> {
  await db.insert(agentTaskUpdates).values({ taskId, content });
  await db.update(agentTasks).set({ updatedAt: new Date() }).where(eq(agentTasks.id, taskId));
}

export async function recentUpdates(taskId: string, limit = 15): Promise<AgentTaskUpdate[]> {
  const rows = await db
    .select()
    .from(agentTaskUpdates)
    .where(eq(agentTaskUpdates.taskId, taskId))
    .orderBy(desc(agentTaskUpdates.insertedAt))
    .limit(limit);
  return rows.reverse();
}

export async function scheduleCheck(task: Pick<AgentTask, "id" | "title" | "jobId">, at: Date): Promise<Date> {
  const when = withinWorkingHours(at);
  if (task.jobId) await cancelJob(task.jobId);
  const { job } = await enqueue("task_check", { task_id: task.id, title: task.title }, { scheduledAt: when });
  await db
    .update(agentTasks)
    .set({ jobId: job?.id ?? null, nextCheckAt: when, updatedAt: new Date() })
    .where(eq(agentTasks.id, task.id));
  return when;
}

export async function editTask(
  task: AgentTask,
  changes: { plan?: string; successCriteria?: string; checkEveryMinutes?: number },
): Promise<AgentTask> {
  const [updated] = await db
    .update(agentTasks)
    .set({
      ...(changes.plan !== undefined ? { plan: changes.plan } : {}),
      ...(changes.successCriteria !== undefined ? { successCriteria: changes.successCriteria } : {}),
      ...(changes.checkEveryMinutes !== undefined ? { checkEveryMinutes: clampInterval(changes.checkEveryMinutes) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(agentTasks.id, task.id))
    .returning();
  return updated ?? task;
}

export async function closeTask(task: AgentTask, status: ClosedStatus, outcome: string): Promise<void> {
  if (task.jobId) await cancelJob(task.jobId);
  await db
    .update(agentTasks)
    .set({ status, outcome, jobId: null, nextCheckAt: null, closedAt: new Date(), updatedAt: new Date() })
    .where(eq(agentTasks.id, task.id));
  await addUpdate(task.id, `Closed as ${status}: ${outcome}`);
}

export async function blockTask(task: AgentTask, note: string): Promise<void> {
  if (task.jobId) await cancelJob(task.jobId);
  await db
    .update(agentTasks)
    .set({ status: "blocked", jobId: null, nextCheckAt: null, updatedAt: new Date() })
    .where(eq(agentTasks.id, task.id));
  await addUpdate(task.id, note);
}

export async function resumeTask(taskId: string, note: string, at: Date): Promise<void> {
  const task = await getTask(taskId);
  if (!task || !(OPEN_STATUSES as readonly string[]).includes(task.status)) return;
  await db.update(agentTasks).set({ status: "active", updatedAt: new Date() }).where(eq(agentTasks.id, task.id));
  await addUpdate(task.id, note);
  await scheduleCheck(task, at);
}

export async function markChecked(task: AgentTask): Promise<AgentTask> {
  const [updated] = await db
    .update(agentTasks)
    .set({ checks: task.checks + 1, nextCheckAt: null, updatedAt: new Date() })
    .where(eq(agentTasks.id, task.id))
    .returning();
  return updated ?? task;
}

async function contacted(taskId: string, channelId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: sentDms.id })
    .from(sentDms)
    .where(and(eq(sentDms.taskId, taskId), eq(sentDms.channelId, channelId)))
    .limit(1);
  return !!row;
}

export async function canManage(task: AgentTask, userId: string, channelId: string | null): Promise<boolean> {
  if (task.ownerUserId === userId || channelId === task.channelId) return true;
  if (channelId && (await contacted(task.id, channelId))) return true;
  return isAdmin(await getUser(userId));
}

export function describeTask(task: AgentTask): string {
  const next = task.nextCheckAt ? `next check ${formatLocal(task.nextCheckAt)}` : "no check scheduled";
  return `- ${task.id} "${task.title}" [${task.status}, ${next}, ${task.checks} check(s) so far${task.deadline ? `, deadline ${formatLocal(task.deadline)}` : ""}]\n  Goal: ${clip(task.goal)}\n  Done when: ${clip(task.successCriteria)}`;
}

async function threadTasksPrompt(channelId: string, threadTs: string): Promise<string> {
  const tasks = await listOpenTasks({ channelId, threadTs });
  if (tasks.length === 0) return "";
  return `[Tasks from this thread]
You are working on these long-running tasks that were given to you here. When someone in this thread changes, finishes or cancels one, update it with update-task.
${tasks.map(describeTask).join("\n")}`;
}

async function dmTasksPrompt(channelId: string): Promise<string> {
  const since = new Date(Date.now() - CONTACT_LOOKBACK_DAYS * 86_400_000);
  const rows = await db
    .select({ dm: sentDms, task: agentTasks })
    .from(sentDms)
    .innerJoin(agentTasks, eq(agentTasks.id, sentDms.taskId))
    .where(
      and(
        eq(sentDms.channelId, channelId),
        isNotNull(sentDms.taskId),
        gte(sentDms.insertedAt, since),
        inArray(agentTasks.status, [...OPEN_STATUSES]),
      ),
    )
    .orderBy(asc(sentDms.insertedAt));
  if (rows.length === 0) return "";
  const lines = rows.map(
    ({ dm, task }) =>
      `- Task ${task.id} "${task.title}" (goal: ${clip(task.goal, 200)}). On ${formatLocal(dm.insertedAt)} you wrote: "${clip(dm.text)}"`,
  );
  return `[Tasks you messaged this person about]
${lines.join("\n")}
If what they write answers or affects one of these, record it with update-task. The note is shared in the thread the task came from, so include only what the task needs, not unrelated private details.`;
}

export async function tasksPrompt(sessionKey: string | null): Promise<string> {
  if (!sessionKey) return "";
  const [channelId, threadTs] = sessionKey.split(":");
  const parts = await Promise.all([threadTasksPrompt(channelId, threadTs), channelId.startsWith("D") ? dmTasksPrompt(channelId) : ""]);
  return parts.filter(Boolean).join("\n\n");
}
