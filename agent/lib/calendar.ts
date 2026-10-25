import { getFact, listFactsByUser, parseDateRange, setFact } from "../../lib/facts.ts";
import { type CalendarEvent } from "../../lib/google.ts";
import { isValidIsoDate, utcToday } from "../../lib/time.ts";

export const DEFAULT_DAYS = 7;
export const DEFAULT_SNOOZE_DAYS = 2;

export const dayStart = (date: string) => new Date(`${date}T00:00:00Z`);

export function formatEvents(events: CalendarEvent[], from: string, to: string): string {
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

export async function absenceCovering(readableLevels: string[], userId: string, target: string): Promise<string | null> {
  for (const fact of await listFactsByUser("absence:", userId, readableLevels)) {
    const range = parseDateRange(fact.value);
    if (range && target >= range.from && target <= range.to) return fact.value;
  }
  return null;
}

export function snoozedStatus(recheckDate: string): string {
  if (!isValidIsoDate(recheckDate)) return "needs_ask — malformed snooze fact, treat as unresolved.";
  return utcToday() < recheckDate
    ? `snoozed — user was unsure, don't ask again until ${recheckDate}.`
    : `needs_ask — earlier 'unsure' snooze expired (was until ${recheckDate}).`;
}

export async function holidayPlanStatus(readableLevels: string[], userId: string, date: string): Promise<string> {
  const covering = await absenceCovering(readableLevels, userId, date);
  if (covering) return `resolved — already has an absence/vacation covering this date: ${covering}`;
  const fact = await getFact(`holiday-plan:${userId}:${date}`, readableLevels);
  if (!fact) return "needs_ask — no plan recorded for this date yet.";
  if (fact.value === "working") return "resolved — user already confirmed they're working that day.";
  if (fact.value.startsWith("unsure:")) return snoozedStatus(fact.value.slice("unsure:".length));
  return `resolved — recorded plan: ${fact.value}`;
}

export async function writePlanFact(userId: string, date: string, value: string, success: string) {
  try {
    await setFact(`holiday-plan:${userId}:${date}`, value, ["internal"], userId);
    return success;
  } catch (error) {
    return `Błąd zapisu: ${(error as Error).message}`;
  }
}
