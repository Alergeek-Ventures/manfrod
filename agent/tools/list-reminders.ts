import { sql } from "drizzle-orm";
import { z } from "zod";
import { listPendingJobs } from "../../lib/jobs/index.ts";
import { jobs, displayDate } from "../lib/reminders.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description: "List all pending reminders you have scheduled.",
  inputSchema: z.object({}),
  async execute(_args, ctx) {
    const pending = await listPendingJobs(
      "trigger",
      sql`${jobs.args}->>'trigger_id' LIKE 'reminder_%' AND ${jobs.args}->>'user_id' = ${ctx.userId}`,
    );
    if (pending.length === 0) return "No pending reminders.";
    const lines = pending.map((job) => `• #${job.id} at ${displayDate(job.scheduledAt)}: ${(job.args as Record<string, string>).message}`);
    return `Pending reminders:\n${lines.join("\n")}`;
  },
});
