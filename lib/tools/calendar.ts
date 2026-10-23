import { z } from "zod";
import { getGoogleAccount, isSystemUser, listUsers } from "../accounts.ts";
import { config } from "../config.ts";
import { getFact, listFactsByUser, parseDateRange, setFact } from "../facts.ts";
import { ensureValidToken, listEvents, listHolidayEvents, type CalendarEvent } from "../google.ts";
import { sendProactive } from "../proactive.ts";
import { addDays, isValidIsoDate, utcToday } from "../time.ts";
import { spec } from "./context.ts";

const DEFAULT_DAYS = 7;
const DEFAULT_SNOOZE_DAYS = 2;

const dayStart = (date: string) => new Date(`${date}T00:00:00Z`);

function formatEvents(events: CalendarEvent[], from: string, to: string): string {
  const lines = events.map((event) => {
    const time = event.all_day ? `All day (${event.start})` : `${event.start} — ${event.end}`;
    const parts = [`• ${event.summary}`, `  Time: ${time}`];
    if (event.location) parts.push(`  Location: ${event.location}`);
    if (event.attendees.length > 0) {
      parts.push(`  Attendees: ${event.attendees.map((attendee) => `${attendee.name ?? attendee.email} (${attendee.status})`).join(", ")}`);
    }
    return parts.join("\n");
  });
  return `Calendar events from ${from} to ${to}:\n${lines.join("\n\n")}`;
}

async function absenceCovering(readableLevels: string[], userId: string, target: string): Promise<string | null> {
  for (const fact of await listFactsByUser("absence:", userId, readableLevels)) {
    const range = parseDateRange(fact.value);
    if (range && target >= range.from && target <= range.to) return fact.value;
  }
  return null;
}

function snoozedStatus(recheckDate: string): string {
  if (!isValidIsoDate(recheckDate)) return "needs_ask — malformed snooze fact, treat as unresolved.";
  return utcToday() < recheckDate
    ? `snoozed — user was unsure, don't ask again until ${recheckDate}.`
    : `needs_ask — earlier 'unsure' snooze expired (was until ${recheckDate}).`;
}

async function holidayPlanStatus(readableLevels: string[], userId: string, date: string): Promise<string> {
  const covering = await absenceCovering(readableLevels, userId, date);
  if (covering) return `resolved — already has an absence/vacation covering this date: ${covering}`;
  const fact = await getFact(`holiday-plan:${userId}:${date}`, readableLevels);
  if (!fact) return "needs_ask — no plan recorded for this date yet.";
  if (fact.value === "working") return "resolved — user already confirmed they're working that day.";
  if (fact.value.startsWith("unsure:")) return snoozedStatus(fact.value.slice("unsure:".length));
  return `resolved — recorded plan: ${fact.value}`;
}

async function writePlanFact(userId: string, date: string, value: string, success: string) {
  try {
    await setFact(`holiday-plan:${userId}:${date}`, value, ["internal"], userId);
    return success;
  } catch (error) {
    return `Błąd zapisu: ${(error as Error).message}`;
  }
}

export const tools = {
  get_calendar_events: spec({
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
  }),

  list_upcoming_holidays: spec({
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
  }),

  list_team_members: spec({
    description: "List everyone Manfrod knows about (id + name) — for holiday-check fan-out.",
    inputSchema: z.object({}),
    async execute() {
      const members = (await listUsers()).filter((user) => !isSystemUser(user));
      if (members.length === 0) return "No team members found.";
      return members.map((user) => `- ${user.id}: ${user.name ?? user.email}`).join("\n");
    },
  }),

  check_holiday_plan: spec({
    description:
      "Check whether a specific user already has a resolved plan for a given date: an absence/vacation covering it, a confirmed 'working' answer, or a not-yet-expired 'unsure' snooze. Returns whether they still need to be asked. Call this before ask_user_about_holiday so you don't nag someone who already answered.",
    inputSchema: z.object({
      user_id: z.string().describe("User UUID to check"),
      date: z.string().describe("Date ISO8601 (YYYY-MM-DD)"),
    }),
    async execute({ user_id, date }, ctx) {
      if (!isValidIsoDate(date)) return `Invalid date: ${date}`;
      return holidayPlanStatus(ctx.readableLevels, user_id, date);
    },
  }),

  ask_user_about_holiday: spec({
    keepSecretPlaceholders: true,
    description:
      "Proactively DM a specific user asking whether they're working or taking vacation on an upcoming holiday. Safe to call directly — it re-checks the plan itself and is a no-op if already resolved/snoozed — but prefer check_holiday_plan first when fanning out over a whole team, so you don't waste calls.",
    inputSchema: z.object({
      user_id: z.string().describe("User UUID to ask"),
      date: z.string().describe("Holiday date ISO8601 (YYYY-MM-DD)"),
      holiday_name: z.string().describe("Holiday name, e.g. 'Boże Ciało'"),
    }),
    async execute({ user_id, date, holiday_name }, ctx) {
      if (!isValidIsoDate(date)) return `Invalid date: ${date}`;
      const status = await holidayPlanStatus(ctx.readableLevels, user_id, date);
      if (!status.startsWith("needs_ask")) return `Pomijam ${user_id} na ${date} — już rozwiązane: ${status}`;
      const prompt = `[Proaktywne sprawdzenie święta]
Za mniej niż tydzień jest ${holiday_name} (${date}). Nie masz nic zapisanego na ten dzień —
ani urlopu, ani informacji że pracujesz. Zapytaj krótko, czy w tym dniu pracujesz, czy
bierzesz urlop.

Gdy user odpowie:
- że pracuje → wywołaj record_holiday_plan(date: "${date}", status: "working")
- że bierze urlop / będzie nieobecny → wywołaj report_vacation jak zwykle (nie record_holiday_plan)
- że jeszcze nie wie → wywołaj record_holiday_plan(date: "${date}", status: "unsure"); zapytasz
  go ponownie za 2-3 dni
`;
      const sent = await sendProactive(user_id, prompt);
      return sent.ok
        ? `Wysłano pytanie do usera ${user_id} o ${holiday_name} (${date}).`
        : `Nie udało się wysłać pytania do ${user_id}: :${sent.error}`;
    },
  }),

  record_holiday_plan: spec({
    keepSecretPlaceholders: true,
    description:
      "Record the current user's plan for an upcoming holiday: 'working' (working as normal that day) or 'unsure' (they'll decide later — you'll check back in a couple of days). For vacation, call report_vacation instead, not this.",
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
      return `Nieznany status: ${status}. Użyj 'working' albo 'unsure' (dla urlopu użyj report_vacation).`;
    },
  }),
};
