import { z } from "zod";
import { enqueue } from "../../lib/jobs/index.ts";
import { AT_DOC, displayDate, parseAt, shortHash } from "../lib/reminders.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Schedule a follow-up check for YOURSELF at a specific time — for when you (not the user) need to re-verify something later, e.g. checking back after being told 'still working' or 'not done yet'. Unlike set-reminder, this isn't a user-facing reminder: `instructions` is what you should actually do when it fires (call tools, decide whether there's anything worth saying), written as if telling your future self what to do — not as a message to relay verbatim.",
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
});
