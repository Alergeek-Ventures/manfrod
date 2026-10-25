import { z } from "zod";
import { getRecurringReminder, updateRecurringReminder } from "../../lib/memory/reminders.ts";
import { formatErrors } from "../lib/reminders.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
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
});
