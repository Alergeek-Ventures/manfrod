import { z } from "zod";
import { createEvent } from "../../lib/google.ts";
import {
  calendarToken,
  describeCreated,
  googleTime,
  meetRequest,
  parseEventTime,
  RECONNECT_FOR_SCOPE,
  resolveAttendees,
} from "../lib/calendar.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Create an event in the user's Google Calendar and send invitations to attendees. Before inviting other people, confirm the title, time and attendees with the user unless they already gave all of them explicitly. Times without an offset are Europe/Warsaw.",
  inputSchema: z.object({
    summary: z.string().min(1).describe("Event title"),
    start: z.string().describe("Start: YYYY-MM-DDTHH:MM for a timed event, or YYYY-MM-DD for an all-day event"),
    end: z
      .string()
      .optional()
      .describe("End: YYYY-MM-DDTHH:MM, or the last day (inclusive) YYYY-MM-DD for an all-day event. Omit to use duration_minutes."),
    duration_minutes: z.number().int().min(5).max(1440).optional().describe("Length of a timed event when end is omitted (default 30)"),
    attendees: z.array(z.string()).optional().describe("People to invite: Slack user IDs (e.g. U012ABC) or email addresses"),
    description: z.string().optional(),
    location: z.string().optional(),
    meet: z.boolean().optional().describe("Add a Google Meet link (default: true when inviting others and no location is given)"),
  }),
  label: { start: ({ summary }) => `Create event "${summary}"` },
  async execute({ summary, start, end, duration_minutes, attendees = [], description, location, meet }, ctx) {
    const startTime = parseEventTime(start);
    if (!startTime) return "ERROR: start must be YYYY-MM-DDTHH:MM or YYYY-MM-DD.";
    const endTime = end ? parseEventTime(end) : null;
    if (end && (!endTime || endTime.allDay !== startTime.allDay)) return "ERROR: end must use the same format as start.";
    const resolvedEnd =
      endTime ??
      (startTime.allDay ? startTime : { allDay: false as const, at: new Date(startTime.at.getTime() + (duration_minutes ?? 30) * 60_000) });
    if (!startTime.allDay && !resolvedEnd.allDay && resolvedEnd.at <= startTime.at) return "ERROR: end must be after start.";

    const { attendees: people, unknown } = await resolveAttendees(attendees);
    if (unknown.length > 0) return `ERROR: unknown attendees (use Slack user IDs of team members or emails): ${unknown.join(", ")}`;
    const access = await calendarToken(ctx.userId);
    if (!access.ok) return access.message;

    const withMeet = meet ?? (people.length > 0 && !location);
    const created = await createEvent(access.token, {
      summary,
      start: googleTime(startTime),
      end: googleTime(resolvedEnd, true),
      ...(description ? { description } : {}),
      ...(location ? { location } : {}),
      ...(people.length > 0 ? { attendees: people.map((person) => ({ email: person.email })) } : {}),
      ...(withMeet ? { conferenceData: meetRequest() } : {}),
    });
    if (!created.ok) return created.error === "insufficient_scope" ? RECONNECT_FOR_SCOPE : `Failed to create the event: ${created.error}`;
    return `Created the event.\n${describeCreated(created.value)}`;
  },
});
