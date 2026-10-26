import { type CalendarEvent } from "../../lib/google.ts";

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
