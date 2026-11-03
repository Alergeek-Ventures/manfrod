import { getGoogleAccount, getUserBySlackId } from "../../lib/accounts.ts";
import type { User } from "../../lib/db/schema.ts";
import { ensureValidToken, type CalendarEvent } from "../../lib/google.ts";
import { addDays, isValidIsoDate, TIMEZONE, zonedToUtc } from "../../lib/time.ts";

export const dayStart = (date: string) => new Date(`${date}T00:00:00Z`);

export function formatEvents(events: CalendarEvent[], from: string, to: string): string {
  const lines = events.map((event) => {
    const time = event.all_day ? `All day (${event.start})` : `${event.start} — ${event.end}`;
    const parts = [`• ${event.summary}`, `  Time: ${time}`, `  Event ID: ${event.id}`];
    if (event.location) parts.push(`  Location: ${event.location}`);
    if (event.attendees.length > 0) {
      parts.push(`  Attendees: ${event.attendees.map((attendee) => `${attendee.name ?? attendee.email} (${attendee.status})`).join(", ")}`);
    }
    return parts.join("\n");
  });
  return `Calendar events from ${from} to ${to}:\n${lines.join("\n\n")}`;
}

export async function calendarToken(userId: string): Promise<{ ok: true; token: string } | { ok: false; message: string }> {
  const identity = await getGoogleAccount(userId);
  if (!identity) {
    return {
      ok: false,
      message: "ERROR: No Google account linked. The user needs to sign in at the web app to connect their Google Calendar.",
    };
  }
  const token = await ensureValidToken(identity);
  if (token.ok) return { ok: true, token: token.value };
  return {
    ok: false,
    message:
      token.error === "no_refresh_token"
        ? "ERROR: Google token expired and no refresh token available. The user needs to re-authenticate at the web app."
        : `Failed to refresh Google token: ${token.error}`,
  };
}

export const RECONNECT_FOR_SCOPE =
  "ERROR: Google did not grant this permission. The user needs to reconnect Google Calendar on the web app's Integrations page, then try again.";

export interface Attendee {
  email: string;
  user: User | null;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export async function resolveAttendees(values: string[]): Promise<{ attendees: Attendee[]; unknown: string[] }> {
  const attendees: Attendee[] = [];
  const unknown: string[] = [];
  for (const raw of values) {
    const value = raw.trim().replace(/^<@([A-Z0-9]+)(\|[^>]*)?>$/, "$1");
    if (EMAIL.test(value)) {
      attendees.push({ email: value.toLowerCase(), user: null });
      continue;
    }
    const user = /^[UW][A-Z0-9]{5,}$/.test(value) ? await getUserBySlackId(value) : null;
    if (user?.email) attendees.push({ email: user.email.toLowerCase(), user });
    else unknown.push(raw);
  }
  return {
    attendees: attendees.filter((attendee, index) => attendees.findIndex((other) => other.email === attendee.email) === index),
    unknown,
  };
}

export type EventTime = { allDay: true; date: string } | { allDay: false; at: Date };

export function parseEventTime(value: string): EventTime | null {
  const trimmed = value.trim();
  if (isValidIsoDate(trimmed)) return { allDay: true, date: trimmed };
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)$/.exec(trimmed);
  if (local && isValidIsoDate(local[1])) return { allDay: false, at: zonedToUtc(local[1], local[2]) };
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    const at = new Date(trimmed);
    return Number.isNaN(at.getTime()) ? null : { allDay: false, at };
  }
  return null;
}

export function googleTime(time: EventTime, exclusiveEnd = false): Record<string, string> {
  if (time.allDay) return { date: exclusiveEnd ? addDays(time.date, 1) : time.date };
  return { dateTime: time.at.toISOString(), timeZone: TIMEZONE };
}

export function meetRequest(): Record<string, unknown> {
  return { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
}

export function describeCreated(event: Record<string, any>): string {
  const when = event.start?.dateTime ?? event.start?.date ?? "?";
  const until = event.end?.dateTime ?? event.end?.date ?? "?";
  const invited = ((event.attendees ?? []) as { email: string }[]).map((attendee) => attendee.email);
  return [
    `Event ID: ${event.id}`,
    `Title: ${event.summary ?? "(no title)"}`,
    `Time: ${when} — ${until}`,
    event.htmlLink ? `Link: ${event.htmlLink}` : "",
    event.hangoutLink ? `Google Meet: ${event.hangoutLink}` : "",
    invited.length > 0 ? `Attendees: ${invited.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface Interval {
  start: Date;
  end: Date;
}

export function freeWindows(busy: Interval[], window: Interval, minMinutes: number): Interval[] {
  const sorted = busy
    .filter((slot) => slot.end > window.start && slot.start < window.end)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const free: Interval[] = [];
  let cursor = window.start;
  for (const slot of sorted) {
    if (slot.start > cursor) free.push({ start: cursor, end: slot.start });
    if (slot.end > cursor) cursor = slot.end;
  }
  if (cursor < window.end) free.push({ start: cursor, end: window.end });
  return free.filter((gap) => gap.end.getTime() - gap.start.getTime() >= minMinutes * 60_000);
}
