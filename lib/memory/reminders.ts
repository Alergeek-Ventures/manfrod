import { Cron } from "croner";
import { and, asc, eq } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { RecurringReminder, User } from "../db/schema.ts";
import { emit } from "../events/index.ts";
import { cancelPendingTriggerJobs } from "../jobs/index.ts";
import { isValidTimezone } from "../time.ts";
import { isUuid } from "../accounts.ts";
import { ValidationError } from "./nodes.ts";

const { recurringReminders, users } = tables;

export type ReminderWithUser = RecurringReminder & { user: User | null };

export const MIN_INTERVAL_MINUTES = 30;
const INTERVAL_SAMPLE_RUNS = 48;

export function validateCron(cron: string): string | null {
  let schedule: Cron;
  try {
    schedule = new Cron(cron, { paused: true });
  } catch (error) {
    return `invalid cron expression: ${(error as Error).message}`;
  }
  const runs = schedule.nextRuns(INTERVAL_SAMPLE_RUNS);
  const shortest = runs.slice(1).reduce((min, run, index) => Math.min(min, run.getTime() - runs[index].getTime()), Infinity);
  return shortest < MIN_INTERVAL_MINUTES * 60_000
    ? `runs more often than every ${MIN_INTERVAL_MINUTES} minutes; each run is a full agent turn, so pick a sparser schedule`
    : null;
}

function validate(attrs: Partial<RecurringReminder>, requireAll: boolean) {
  const errors: Record<string, string> = {};
  for (const field of ["name", "cron", "instructions"] as const) {
    const value = attrs[field];
    if ((requireAll && (value === undefined || value === null || value === "")) || value === "") {
      errors[field] = "can't be blank";
    }
  }
  if (typeof attrs.cron === "string" && attrs.cron !== "") {
    const cronError = validateCron(attrs.cron);
    if (cronError) errors.cron = cronError;
  }
  if (typeof attrs.timezone === "string" && !isValidTimezone(attrs.timezone)) errors.timezone = "unknown timezone";
  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
}

export async function listAllRecurringReminders(): Promise<ReminderWithUser[]> {
  const rows = await db
    .select({ reminder: recurringReminders, user: users })
    .from(recurringReminders)
    .leftJoin(users, eq(users.id, recurringReminders.userId))
    .orderBy(asc(recurringReminders.name));
  return rows.map((row) => ({ ...row.reminder, user: row.user }));
}

export async function getRecurringReminderById(id: string): Promise<RecurringReminder | null> {
  if (!isUuid(id)) return null;
  const [row] = await db.select().from(recurringReminders).where(eq(recurringReminders.id, id)).limit(1);
  return row ?? null;
}

export async function listRecurringReminders(
  userId: string,
  opts: { enabled?: boolean } = {},
): Promise<RecurringReminder[]> {
  return db
    .select()
    .from(recurringReminders)
    .where(
      and(
        eq(recurringReminders.userId, userId),
        opts.enabled === undefined ? undefined : eq(recurringReminders.enabled, opts.enabled),
      ),
    )
    .orderBy(asc(recurringReminders.name));
}

export async function listEnabledReminders(): Promise<RecurringReminder[]> {
  return db
    .select()
    .from(recurringReminders)
    .where(eq(recurringReminders.enabled, true))
    .orderBy(asc(recurringReminders.name));
}

export async function getRecurringReminder(userId: string, id: string): Promise<RecurringReminder | null> {
  if (!isUuid(id)) return null;
  const [row] = await db
    .select()
    .from(recurringReminders)
    .where(and(eq(recurringReminders.userId, userId), eq(recurringReminders.id, id)))
    .limit(1);
  return row ?? null;
}

export async function createRecurringReminder(
  userId: string,
  attrs: { name: string; cron: string; instructions: string; timezone?: string; enabled?: boolean },
): Promise<RecurringReminder> {
  const values = { ...attrs, timezone: attrs.timezone ?? "Europe/Warsaw" };
  validate(values, true);

  let reminder: RecurringReminder;
  try {
    [reminder] = await db.insert(recurringReminders).values({ ...values, userId }).returning();
  } catch (error) {
    if (String((error as { code?: string }).code) === "23505") {
      throw new ValidationError({ name: "has already been taken" });
    }
    throw error;
  }

  emit("recurring_reminder_created", {
    userId,
    source: "memory",
    meta: { reminder_id: reminder.id, name: reminder.name },
  });
  return reminder;
}

export async function updateRecurringReminder(
  userId: string,
  reminder: RecurringReminder,
  attrs: Partial<Pick<RecurringReminder, "cron" | "instructions" | "timezone" | "enabled" | "name">>,
): Promise<RecurringReminder> {
  validate(attrs, false);
  const cronChanged = attrs.cron !== undefined && attrs.cron !== reminder.cron;
  const [updated] = await db
    .update(recurringReminders)
    .set(attrs)
    .where(eq(recurringReminders.id, reminder.id))
    .returning();

  if (cronChanged) await cancelPendingTriggerJobs(updated.id);

  emit("recurring_reminder_updated", {
    userId,
    source: "memory",
    meta: { reminder_id: updated.id, name: updated.name, cron_changed: cronChanged },
  });
  return updated;
}

export async function deleteRecurringReminder(
  userId: string,
  reminderOrId: RecurringReminder | string,
): Promise<RecurringReminder | null> {
  const reminder =
    typeof reminderOrId === "string" ? await getRecurringReminder(userId, reminderOrId) : reminderOrId;
  if (!reminder) return null;

  await cancelPendingTriggerJobs(reminder.id);
  const [deleted] = await db.delete(recurringReminders).where(eq(recurringReminders.id, reminder.id)).returning();
  emit("recurring_reminder_deleted", {
    userId,
    source: "memory",
    meta: { reminder_id: deleted.id, name: deleted.name },
  });
  return deleted;
}
