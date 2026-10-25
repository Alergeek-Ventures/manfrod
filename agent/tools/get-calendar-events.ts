import { z } from "zod";
import { getGoogleAccount } from "../../lib/accounts.ts";
import { ensureValidToken, listEvents } from "../../lib/google.ts";
import { addDays, isValidIsoDate, utcToday } from "../../lib/time.ts";
import { dayStart, formatEvents } from "../lib/calendar.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Fetch events from the user's Google Calendar. Returns upcoming events for a given date range. If the user has no Google account linked, returns an error asking them to sign in via the web app.",
  inputSchema: z.object({
    date: z.string().optional().describe("Start date in ISO 8601 format (e.g., '2026-03-05'). Defaults to today if omitted."),
    days: z.number().int().optional().describe("Number of days to fetch from the start date (default: 1)"),
  }),
  async execute({ date, days }, ctx) {
    const identity = await getGoogleAccount(ctx.userId);
    if (!identity) {
      return "ERROR: No Google account linked. The user needs to sign in at the web app to connect their Google Calendar.";
    }
    const token = await ensureValidToken(identity);
    if (!token.ok) {
      return token.error === "no_refresh_token"
        ? "ERROR: Google token expired and no refresh token available. The user needs to re-authenticate at the web app."
        : `Failed to refresh Google token: ${token.error}`;
    }
    const start = date && isValidIsoDate(date) ? date : utcToday();
    const end = addDays(start, days ?? 1);
    const events = await listEvents(token.value, dayStart(start), dayStart(end));
    if (!events.ok) return `Failed to fetch calendar events: ${events.error}`;
    if (events.value.length === 0) return `No events found for ${start} to ${end}.`;
    return formatEvents(events.value, start, end);
  },
});
