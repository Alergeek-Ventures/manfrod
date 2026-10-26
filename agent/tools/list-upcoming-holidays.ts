import { z } from "zod";
import { describePeriod, upcomingPeriods } from "../../lib/holidays.ts";
import { localToday } from "../../lib/time.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

const DEFAULT_DAYS = 30;

export default defineManfrodTool({
  description:
    "List public holidays (days off) in the next N days, grouped into periods of consecutive days off, with bridge days worth taking off for a long weekend. Use to answer questions about upcoming holidays and long weekends, not to check any one user's plans.",
  inputSchema: z.object({
    days: z.number().int().min(1).max(366).optional().describe(`How many days ahead to look (default ${DEFAULT_DAYS})`),
  }),
  async execute({ days }) {
    const span = days ?? DEFAULT_DAYS;
    const periods = await upcomingPeriods(localToday(), span);
    if (!periods.ok) {
      return periods.error === "no_google_api_key"
        ? "ERROR: GOOGLE_API_KEY is not configured — can't read the public holiday calendar."
        : `Failed to fetch holidays: ${periods.error}`;
    }
    if (periods.value.length === 0) return `No public holidays in the next ${span} day(s).`;
    return periods.value.map(describePeriod).join("\n\n");
  },
});
