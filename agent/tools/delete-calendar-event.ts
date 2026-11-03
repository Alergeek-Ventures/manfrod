import { z } from "zod";
import { deleteEvent } from "../../lib/google.ts";
import { calendarToken, RECONNECT_FOR_SCOPE } from "../lib/calendar.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Delete an event from the user's Google Calendar. If the user organizes it, attendees are told it was cancelled; otherwise it only disappears from the user's calendar. Get the event ID from get-calendar-events and confirm with the user before cancelling a meeting with other people.",
  inputSchema: z.object({ event_id: z.string().min(1) }),
  async execute({ event_id }, ctx) {
    const access = await calendarToken(ctx.userId);
    if (!access.ok) return access.message;
    const result = await deleteEvent(access.token, event_id);
    if (result.ok) return `Deleted event ${event_id}.`;
    if (result.error === "not_found") return `Event ${event_id} does not exist or was already deleted.`;
    return result.error === "insufficient_scope" ? RECONNECT_FOR_SCOPE : `Failed to delete the event: ${result.error}`;
  },
});
