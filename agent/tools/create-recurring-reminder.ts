import { z } from "zod";
import { createRecurringReminder } from "../../lib/memory/reminders.ts";
import { formatErrors } from "../lib/reminders.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
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
});
