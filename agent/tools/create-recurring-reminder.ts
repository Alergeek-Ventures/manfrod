import { z } from "zod";
import { createRecurringReminder } from "../../lib/memory/reminders.ts";
import { formatErrors } from "../lib/reminders.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Set up a job that runs itself on a calendar schedule with no end, e.g. 'every day at 8 send me X' or 'every Friday ask the team for Y'. When it fires, the instructions become a full agent turn (same tools as a live chat), not just a text reminder. Each run starts fresh. For something that should stop once a goal is reached, e.g. checking daily until someone answers, use create-task instead.",
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
        "Full instructions for each run, written for a future you that knows nothing else: who asked and why, channel and people IDs, the steps with the tools to use, where the results go (the run's own reply only reaches the owner's DM). Follow-up over days goes into create-task in the thread of the post. No private details. Load the recurring-jobs skill for the full checklist.",
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
});
