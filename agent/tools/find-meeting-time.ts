import { z } from "zod";
import { getUser } from "../../lib/accounts.ts";
import { config } from "../../lib/config.ts";
import { listReservationsForDate } from "../../lib/desks.ts";
import { freeBusy, listPublicHolidays } from "../../lib/google.ts";
import { addDays, isValidIsoDate, localToday, TIMEZONE, weekdayName, zonedToUtc } from "../../lib/time.ts";
import { calendarToken, freeWindows, RECONNECT_FOR_SCOPE, resolveAttendees, type Interval } from "../lib/calendar.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

const MAX_DAYS = 14;
const TIME = /^\d{2}:\d{2}$/;

const hhmm = (date: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit" }).format(date);

export default defineManfrodTool({
  description:
    "Find times when the user and the given people are all free, from their Google Calendars (free/busy only). Returns free windows per workday in Europe/Warsaw time, skipping weekends and public holidays, and who has a desk booked in the office that day. Use it before proposing or creating a meeting with several people.",
  inputSchema: z.object({
    attendees: z
      .array(z.string())
      .describe(
        "People to meet besides the user: Slack user IDs (e.g. U012ABC) or email addresses. Use list-team-members to find Slack IDs.",
      ),
    duration_minutes: z.number().int().min(15).max(480).describe("How long the meeting should be"),
    from: z.string().optional().describe("First day to search, YYYY-MM-DD (default: today)"),
    to: z
      .string()
      .optional()
      .describe(`Last day to search, YYYY-MM-DD (default and maximum: ${MAX_DAYS - 1} days after from)`),
    earliest: z.string().optional().describe("Earliest start time each day, HH:MM (default 09:00)"),
    latest: z.string().optional().describe("Latest end time each day, HH:MM (default 17:00)"),
  }),
  label: { start: ({ duration_minutes }) => `Find a ${duration_minutes} min meeting slot` },
  async execute({ attendees, duration_minutes, from, to, earliest, latest }, ctx) {
    const access = await calendarToken(ctx.userId);
    if (!access.ok) return access.message;
    const today = localToday();
    const first = from && isValidIsoDate(from) && from > today ? from : today;
    const limit = addDays(first, MAX_DAYS - 1);
    const last = to && isValidIsoDate(to) && to >= first ? (to < limit ? to : limit) : addDays(first, 6);
    const dayStart = earliest && TIME.test(earliest) ? earliest : "09:00";
    const dayEnd = latest && TIME.test(latest) ? latest : "17:00";

    const { attendees: people, unknown } = await resolveAttendees(attendees);
    const calendars = ["primary", ...people.map((person) => person.email)];
    const busy = await freeBusy(access.token, calendars, zonedToUtc(first, "00:00"), zonedToUtc(addDays(last, 1), "00:00"));
    if (!busy.ok) return busy.error === "insufficient_scope" ? RECONNECT_FOR_SCOPE : `Failed to check availability: ${busy.error}`;

    const holidays = await listPublicHolidays(config.holidayCalendarId, zonedToUtc(first, "00:00"), zonedToUtc(addDays(last, 1), "00:00"));
    const holidayDates = new Map(holidays.ok ? holidays.value.map((holiday) => [holiday.date, holiday.name]) : []);
    const allBusy: Interval[] = [...busy.value.values()].flatMap((calendar) => calendar.busy);
    const userIds = new Set([ctx.userId, ...people.flatMap((person) => (person.user ? [person.user.id] : []))]);
    const self = await getUser(ctx.userId);

    const lines: string[] = [];
    for (let date = first; date <= last; date = addDays(date, 1)) {
      const weekday = weekdayName(date);
      if (["Saturday", "Sunday"].includes(weekday)) continue;
      if (holidayDates.has(date)) {
        lines.push(`${date} (${weekday}): public holiday (${holidayDates.get(date)})`);
        continue;
      }
      const start = new Date(Math.max(zonedToUtc(date, dayStart).getTime(), Date.now()));
      const windows = freeWindows(allBusy, { start, end: zonedToUtc(date, dayEnd) }, duration_minutes);
      const inOffice = (await listReservationsForDate(date))
        .filter((reservation) => userIds.has(reservation.userId))
        .map((reservation) =>
          reservation.userId === ctx.userId ? (self?.name ?? "you") : (reservation.user.name ?? reservation.user.email),
        );
      const free =
        windows.length > 0 ? windows.map((window) => `${hhmm(window.start)}–${hhmm(window.end)}`).join(", ") : "no common free time";
      lines.push(`${date} (${weekday}): ${free}${inOffice.length > 0 ? ` · desk booked: ${inOffice.join(", ")}` : ""}`);
    }

    const hidden = [...busy.value.entries()].filter(([, calendar]) => calendar.error).map(([id, calendar]) => `${id} (${calendar.error})`);
    const notes = [
      hidden.length > 0 ? `Could not see these calendars, so their busy times are missing: ${hidden.join(", ")}` : "",
      unknown.length > 0 ? `Unknown attendees (not a Slack ID of a team member or an email): ${unknown.join(", ")}` : "",
    ].filter(Boolean);
    return [
      `Free windows of at least ${duration_minutes} min for you${people.length > 0 ? ` and ${people.map((person) => person.email).join(", ")}` : ""} (Europe/Warsaw, ${dayStart}–${dayEnd}):`,
      ...lines,
      ...notes,
    ].join("\n");
  },
});
