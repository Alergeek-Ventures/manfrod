import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { tables } from "../db/index.ts";
import { cancelJob, enqueue, getJob, listPendingJobs } from "../jobs/index.ts";
import { ValidationError } from "../memory/nodes.ts";
import {
  createRecurringReminder,
  deleteRecurringReminder,
  getRecurringReminder,
  listRecurringReminders,
  updateRecurringReminder,
} from "../memory/reminders.ts";
import { spec } from "./context.ts";

const { jobs } = tables;

const AT_DOC = "When to trigger (ISO8601 UTC datetime, e.g., '2026-02-04T14:00:00Z')";
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function displayDate(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace("T", " ")}Z`;
}

function parseAt(value: string): Date | null {
  if (!ISO_RE.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const shortHash = (value: string) => Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 7), 16);

function formatErrors(error: unknown): string {
  if (error instanceof ValidationError) {
    return `%{${Object.entries(error.errors)
      .map(([field, message]) => `${field}: [${JSON.stringify(message)}]`)
      .join(", ")}}`;
  }
  return (error as Error).message;
}

export function buildReminderPrompt(message: string): string {
  return `[SYSTEM NOTICE — not a message from the user] The user scheduled the reminder below for themselves, often phrased as a command to themselves (e.g. "Zrób sobie przerwę"). That phrasing is addressed to THEM, not to you. Your only job is to deliver it: send them a short natural message letting them know it's time, referring to them in second person ("you"/"Ty"). Never respond in first person as if you are the one taking the action (do not say things like "I'll take a break" / "Robię sobie przerwę").

Reminder text (written by the user, to the user): "${message}"`;
}

export const tools = {
  set_reminder: spec({
    keepSecretPlaceholders: true,
    description: "Schedule a reminder for yourself at a specific time. You will receive the message as a new conversation.",
    inputSchema: z.object({
      message: z.string().describe("What to remind yourself about"),
      at: z.string().describe(AT_DOC),
    }),
    async execute({ message, at }, ctx) {
      const scheduledAt = parseAt(at);
      if (!scheduledAt) return "Invalid datetime. Use ISO8601 UTC like '2026-02-04T14:00:00Z'";
      if (scheduledAt <= new Date()) return "Cannot set reminder in the past. Provide a future datetime.";
      const { job } = await enqueue(
        "trigger",
        {
          prompt: buildReminderPrompt(message),
          message,
          trigger_id: `reminder_${shortHash(`${message}|${scheduledAt.toISOString()}`)}`,
          user_id: ctx.userId,
        },
        { scheduledAt },
      );
      return `Reminder set (job #${job!.id}) for ${displayDate(scheduledAt)}: ${message}`;
    },
  }),

  schedule_followup_check: spec({
    keepSecretPlaceholders: true,
    description:
      "Schedule a follow-up check for YOURSELF at a specific time — for when you (not the user) need to re-verify something later, e.g. checking back after being told 'still working' or 'not done yet'. Unlike set_reminder, this isn't a user-facing reminder: `instructions` is what you should actually do when it fires (call tools, decide whether there's anything worth saying), written as if telling your future self what to do — not as a message to relay verbatim.",
    inputSchema: z.object({
      instructions: z.string().describe("Full instructions for that future turn — what to check and how to react"),
      at: z.string().describe(AT_DOC),
    }),
    async execute({ instructions, at }, ctx) {
      const scheduledAt = parseAt(at);
      if (!scheduledAt) return "Invalid datetime. Use ISO8601 UTC like '2026-02-04T14:00:00Z'";
      if (scheduledAt <= new Date()) return "Cannot schedule a follow-up in the past. Provide a future datetime.";
      const { job } = await enqueue(
        "trigger",
        {
          prompt: instructions,
          trigger_id: `followup_${shortHash(`${instructions}|${scheduledAt.toISOString()}`)}`,
          user_id: ctx.userId,
        },
        { scheduledAt },
      );
      return `Follow-up check scheduled (job #${job!.id}) for ${displayDate(scheduledAt)}.`;
    },
  }),

  list_reminders: spec({
    description: "List all pending reminders you have scheduled.",
    inputSchema: z.object({}),
    async execute(_args, ctx) {
      const pending = await listPendingJobs(
        "trigger",
        sql`${jobs.args}->>'trigger_id' LIKE 'reminder_%' AND ${jobs.args}->>'user_id' = ${ctx.userId}`,
      );
      if (pending.length === 0) return "No pending reminders.";
      const lines = pending.map(
        (job) => `• #${job.id} at ${displayDate(job.scheduledAt)}: ${(job.args as Record<string, string>).message}`,
      );
      return `Pending reminders:\n${lines.join("\n")}`;
    },
  }),

  cancel_reminder: spec({
    description: "Cancel a pending reminder by its job ID.",
    inputSchema: z.object({ id: z.number().int().describe("The job ID of the reminder to cancel") }),
    async execute({ id }) {
      if (await getJob(id)) await cancelJob(id);
      return `Reminder #${id} cancelled.`;
    },
  }),

  create_recurring_reminder: spec({
    keepSecretPlaceholders: true,
    description:
      "Set up a task that runs itself on a recurring schedule, e.g. 'every day at 8 send me X' or 'every Monday check Y'. When it fires, the instructions become a full agent turn (same tools as a live chat), not just a text reminder.",
    inputSchema: z.object({
      name: z.string().describe("Unique identifier for the reminder (e.g., 'morning_brief', 'weekly_review')"),
      cron: z
        .string()
        .describe(
          "Cron expression (5 fields: minute hour day-of-month month day-of-week). Must not fire more often than every 30 minutes. Examples: '0 8 * * *' (daily at 8:00), '0 9 * * 1' (Mondays at 9:00)",
        ),
      instructions: z
        .string()
        .describe(
          "Full instructions for what you should do each time this fires — written as if telling yourself what to do. This becomes the prompt for that future turn.",
        ),
      timezone: z.string().optional().describe("IANA timezone (default: 'Europe/Warsaw'). Examples: 'UTC', 'America/New_York'"),
    }),
    async execute(args, ctx) {
      try {
        const reminder = await createRecurringReminder(ctx.userId, {
          name: args.name,
          cron: args.cron,
          instructions: args.instructions,
          timezone: args.timezone ?? "Europe/Warsaw",
        });
        return `Created recurring reminder '${reminder.name}' with cron '${reminder.cron}' (${reminder.timezone}).`;
      } catch (error) {
        return `Failed to create recurring reminder: ${formatErrors(error)}`;
      }
    },
  }),

  list_recurring_reminders: spec({
    description: "List all recurring reminders with their schedules and linked notes.",
    inputSchema: z.object({}),
    async execute(_args, ctx) {
      const reminders = await listRecurringReminders(ctx.userId);
      if (reminders.length === 0) return "No recurring reminders configured.";
      const lines = reminders.map(
        (reminder) =>
          `• ${reminder.name} (${reminder.id})\n  Cron: ${reminder.cron} (${reminder.timezone})\n  Status: ${reminder.enabled ? "enabled" : "disabled"}\n  Instructions: ${reminder.instructions}`,
      );
      return `Recurring reminders:\n\n${lines.join("\n\n")}`;
    },
  }),

  update_recurring_reminder: spec({
    keepSecretPlaceholders: true,
    description:
      "Update a recurring reminder. Can change the cron schedule, the instructions that run each time it fires, the timezone, or enabled status.",
    inputSchema: z.object({
      id: z.string().describe("UUID of the recurring reminder to update"),
      cron: z.string().optional().describe("New cron expression"),
      instructions: z.string().optional().describe("New instructions — replaces what runs when this fires"),
      timezone: z.string().optional().describe("New timezone"),
      enabled: z.boolean().optional().describe("Enable/disable the reminder"),
    }),
    async execute({ id, ...rest }, ctx) {
      const reminder = await getRecurringReminder(ctx.userId, id);
      if (!reminder) return `Recurring reminder not found: ${id}`;
      const attrs = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined && value !== null));
      try {
        const updated = await updateRecurringReminder(ctx.userId, reminder, attrs);
        return `Updated recurring reminder '${updated.name}'`;
      } catch (error) {
        return `Failed to update recurring reminder: ${formatErrors(error)}`;
      }
    },
  }),

  delete_recurring_reminder: spec({
    description: "Delete a recurring reminder. All pending scheduled jobs for this reminder are cancelled.",
    inputSchema: z.object({ id: z.string().describe("UUID of the recurring reminder to delete") }),
    async execute({ id }, ctx) {
      const reminder = await deleteRecurringReminder(ctx.userId, id);
      return reminder
        ? `Deleted recurring reminder '${reminder.name}' and cancelled all pending jobs.`
        : `Recurring reminder not found: ${id}`;
    },
  }),
};
