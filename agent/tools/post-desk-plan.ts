import { z } from "zod";
import { publicHolidayDates } from "../../lib/holidays.ts";
import { evaluateDay, postPlan } from "../../lib/office/plan.ts";
import { nextWorkday } from "../../lib/office/plan-rules.ts";
import { addDays, isValidIsoDate, localToday, withWeekday } from "../../lib/time.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Prepare the desk plan for an office day and post it to the office channel, or refresh the message if it is already posted. Use when someone asks for a desk plan or seating for a day. Manfrod also posts it on its own the afternoon before a crowded day, so only call this on request.",
  inputSchema: z.object({
    date: z.string().optional().describe("ISO date (YYYY-MM-DD); default: the next workday"),
  }),
  label: { start: ({ date }) => `Post desk plan${date ? ` for ${date}` : ""}` },
  async execute({ date }, ctx) {
    if (!ctx.readableLevels.includes("internal")) return "Desk plans are only available in team channels and DMs.";
    const today = localToday();
    const day = date ?? nextWorkday(today, (await publicHolidayDates(today, addDays(today, 14))) ?? new Set());
    if (!isValidIsoDate(day)) return `Invalid date '${date}'. Use YYYY-MM-DD.`;
    if (day < today) return "Can't plan desks for a past day.";
    const evaluation = await evaluateDay(day, { today });
    const posted = await postPlan(day, { today });
    if (!posted.ok)
      return posted.error === "no_plan_channel"
        ? "No office channel for desk plans is set; an admin can set it in the office editor."
        : `Could not post the desk plan: ${posted.error}`;
    const why =
      evaluation.reasons.length > 0
        ? ` Why it may be crowded: ${evaluation.reasons.join("; ")}.`
        : " The office does not look crowded that day.";
    const link = posted.permalink ? ` ${posted.permalink}` : "";
    return `${posted.posted ? "Posted" : "Refreshed"} the desk plan for ${withWeekday(day)} (~${evaluation.expectedInOffice} expected).${why}${link}`;
  },
});
