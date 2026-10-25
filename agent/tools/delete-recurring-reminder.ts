import { z } from "zod";
import { deleteRecurringReminder } from "../../lib/memory/reminders.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description: "Delete a recurring reminder. All pending scheduled jobs for this reminder are cancelled.",
  inputSchema: z.object({ id: z.string().describe("UUID of the recurring reminder to delete") }),
  async execute({ id }, ctx) {
    const reminder = await deleteRecurringReminder(ctx.userId, id);
    return reminder
      ? `Deleted recurring reminder '${reminder.name}' and cancelled all pending jobs.`
      : `Recurring reminder not found: ${id}`;
  },
});
