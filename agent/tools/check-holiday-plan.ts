import { z } from "zod";
import { isValidIsoDate } from "../../lib/time.ts";
import { holidayPlanStatus } from "../lib/calendar.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Check whether a specific user already has a resolved plan for a given date: an absence/vacation covering it, a confirmed 'working' answer, or a not-yet-expired 'unsure' snooze. Returns whether they still need to be asked. Call this before ask-user-about-holiday so you don't nag someone who already answered.",
  inputSchema: z.object({
    user_id: z.string().describe("User UUID to check"),
    date: z.string().describe("Date ISO8601 (YYYY-MM-DD)"),
  }),
  async execute({ user_id, date }, ctx) {
    if (!isValidIsoDate(date)) return `Invalid date: ${date}`;
    return holidayPlanStatus(ctx.readableLevels, user_id, date);
  },
});
