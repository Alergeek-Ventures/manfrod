import { z } from "zod";
import { listEvents } from "../../lib/google.ts";
import { addDays, isValidIsoDate, utcToday } from "../../lib/time.ts";
import { calendarToken, dayStart, formatEvents } from "../lib/calendar.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Fetch events from the user's Google Calendar for a date range, with each event's ID for update-calendar-event and delete-calendar-event. If the user has no Google account linked, returns an error asking them to sign in via the web app.",
  inputSchema: z.object({
    date: z.string().optional().describe("Start date in ISO 8601 format (e.g., '2026-03-05'). Defaults to today if omitted."),
    days: z.number().int().optional().describe("Number of days to fetch from the start date (default: 1)"),
  }),
  label: { start: ({ date, days }) => (date ? `Check the calendar ${days && days > 1 ? "from" : "for"} ${date}` : "Check the calendar") },
  async execute({ date, days }, ctx) {
    const access = await calendarToken(ctx.userId);
    if (!access.ok) return access.message;
    const start = date && isValidIsoDate(date) ? date : utcToday();
    const end = addDays(start, days ?? 1);
    const events = await listEvents(access.token, dayStart(start), dayStart(end));
    if (!events.ok) return `Failed to fetch calendar events: ${events.error}`;
    if (events.value.length === 0) return `No events found for ${start} to ${end}.`;
    return formatEvents(events.value, start, end);
  },
});
