import { z } from "zod";
import { config } from "../../lib/config.ts";
import { listHolidayEvents } from "../../lib/google.ts";
import { addDays, utcToday } from "../../lib/time.ts";
import { DEFAULT_DAYS, dayStart } from "../lib/calendar.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "List public holidays coming up in the next N days from the configured country's holiday calendar. Use to find out what's coming, not to check any one user's plans.",
  inputSchema: z.object({ days: z.number().int().optional().describe("How many days ahead to look (default 7)") }),
  async execute({ days }) {
    const span = days ?? DEFAULT_DAYS;
    const today = utcToday();
    const events = await listHolidayEvents(config.holidayCalendarId, dayStart(today), dayStart(addDays(today, span)));
    if (!events.ok) {
      return events.error === "no_google_api_key"
        ? "ERROR: GOOGLE_API_KEY is not configured — can't read the public holiday calendar."
        : `Failed to fetch holidays: ${events.error}`;
    }
    if (events.value.length === 0) return `No public holidays in the next ${span} day(s).`;
    return events.value.map((event) => `- ${event.start}: ${event.summary}`).join("\n");
  },
});
