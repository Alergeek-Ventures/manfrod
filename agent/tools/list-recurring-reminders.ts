import { z } from "zod";
import { listRecurringReminders } from "../../lib/memory/reminders.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
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
});
