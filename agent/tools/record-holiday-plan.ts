import { z } from "zod";
import { addDays, utcToday } from "../../lib/time.ts";
import { DEFAULT_SNOOZE_DAYS, writePlanFact } from "../lib/calendar.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Record the current user's plan for an upcoming holiday: 'working' (working as normal that day) or 'unsure' (they'll decide later — you'll check back in a couple of days). For vacation, call report-vacation instead, not this.",
  inputSchema: z.object({
    date: z.string().describe("Holiday date ISO8601 (YYYY-MM-DD)"),
    status: z.string().describe("'working' or 'unsure'"),
    recheck_in_days: z.number().int().optional().describe("Only for status 'unsure': days to wait before asking again (default 2)"),
  }),
  async execute({ date, status, recheck_in_days }, ctx) {
    if (status === "working") return writePlanFact(ctx.userId, date, "working", `Zanotowane — pracujesz ${date}.`);
    if (status === "unsure") {
      const recheckIn = recheck_in_days ?? DEFAULT_SNOOZE_DAYS;
      const recheckDate = addDays(utcToday(), recheckIn);
      return writePlanFact(
        ctx.userId,
        date,
        `unsure:${recheckDate}`,
        `Zanotowane — wrócę z pytaniem o ${date} za ${recheckIn} dni (${recheckDate}).`,
      );
    }
    return `Nieznany status: ${status}. Użyj 'working' albo 'unsure' (dla urlopu użyj report-vacation).`;
  },
});
