import { z } from "zod";
import { getEvent, updateEvent } from "../../lib/google.ts";
import {
  calendarToken,
  describeCreated,
  googleTime,
  meetRequest,
  parseEventTime,
  RECONNECT_FOR_SCOPE,
  resolveAttendees,
  type EventTime,
} from "../lib/calendar.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

function existingTime(value: Record<string, string> | undefined): EventTime | null {
  if (value?.date) return { allDay: true, date: value.date };
  if (value?.dateTime) return { allDay: false, at: new Date(value.dateTime) };
  return null;
}

export default defineManfrodTool({
  description:
    "Change an event in the user's Google Calendar: move it, rename it, add or remove attendees, change the description or location, or add a Google Meet link. Attendees get an update. Get the event ID from get-calendar-events. Confirm changes that notify other people with the user first. Times without an offset are Europe/Warsaw.",
  inputSchema: z.object({
    event_id: z.string().min(1),
    summary: z.string().optional(),
    start: z
      .string()
      .optional()
      .describe("New start: YYYY-MM-DDTHH:MM, or YYYY-MM-DD for all-day. The duration is kept unless end is given."),
    end: z.string().optional().describe("New end: YYYY-MM-DDTHH:MM, or the last day (inclusive) YYYY-MM-DD for all-day"),
    add_attendees: z.array(z.string()).optional().describe("Slack user IDs or emails to invite"),
    remove_attendees: z.array(z.string()).optional().describe("Slack user IDs or emails to remove"),
    description: z.string().optional(),
    location: z.string().optional(),
    meet: z.boolean().optional().describe("Set to true to add a Google Meet link if the event has none"),
  }),
  async execute({ event_id, summary, start, end, add_attendees = [], remove_attendees = [], description, location, meet }, ctx) {
    const access = await calendarToken(ctx.userId);
    if (!access.ok) return access.message;
    const current = await getEvent(access.token, event_id);
    if (!current.ok)
      return current.error === "not_found" ? `ERROR: no event with ID ${event_id}.` : `Failed to load the event: ${current.error}`;

    const patch: Record<string, unknown> = {};
    if (summary) patch.summary = summary;
    if (description !== undefined) patch.description = description;
    if (location !== undefined) patch.location = location;

    if (start || end) {
      const oldStart = existingTime(current.value.start);
      const oldEnd = existingTime(current.value.end);
      const newStart = start ? parseEventTime(start) : oldStart;
      if (!newStart) return "ERROR: start must be YYYY-MM-DDTHH:MM or YYYY-MM-DD.";
      let newEnd: EventTime | null = end ? parseEventTime(end) : null;
      if (end && (!newEnd || newEnd.allDay !== newStart.allDay)) return "ERROR: end must use the same format as start.";
      if (!newEnd && oldStart && oldEnd && !oldStart.allDay && !oldEnd.allDay && !newStart.allDay) {
        newEnd = { allDay: false, at: new Date(newStart.at.getTime() + (oldEnd.at.getTime() - oldStart.at.getTime())) };
      }
      if (!newEnd) newEnd = newStart.allDay ? newStart : { allDay: false, at: new Date(newStart.at.getTime() + 30 * 60_000) };
      patch.start = googleTime(newStart);
      patch.end = googleTime(newEnd, true);
    }

    if (add_attendees.length > 0 || remove_attendees.length > 0) {
      const added = await resolveAttendees(add_attendees);
      const removed = await resolveAttendees(remove_attendees);
      const unknown = [...added.unknown, ...removed.unknown];
      if (unknown.length > 0) return `ERROR: unknown attendees (use Slack user IDs of team members or emails): ${unknown.join(", ")}`;
      const removing = new Set(removed.attendees.map((person) => person.email));
      const kept = ((current.value.attendees ?? []) as { email: string }[]).filter(
        (attendee) => !removing.has(attendee.email.toLowerCase()),
      );
      const known = new Set(kept.map((attendee) => attendee.email.toLowerCase()));
      patch.attendees = [
        ...kept,
        ...added.attendees.filter((person) => !known.has(person.email)).map((person) => ({ email: person.email })),
      ];
    }

    if (meet && !current.value.hangoutLink) patch.conferenceData = meetRequest();
    if (Object.keys(patch).length === 0) return "Nothing to change.";
    const updated = await updateEvent(access.token, event_id, patch);
    if (!updated.ok) return updated.error === "insufficient_scope" ? RECONNECT_FOR_SCOPE : `Failed to update the event: ${updated.error}`;
    return `Updated the event.\n${describeCreated(updated.value)}`;
  },
});
