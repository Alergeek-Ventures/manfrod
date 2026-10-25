import { z } from "zod";
import { enqueue } from "../../lib/jobs/index.ts";
import { AT_DOC, displayDate, parseAt, shortHash, buildReminderPrompt } from "../lib/reminders.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
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
});
