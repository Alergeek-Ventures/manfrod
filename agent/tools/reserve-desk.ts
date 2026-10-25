import { z } from "zod";
import { listReservationsForDate, reserveDesk } from "../../lib/desks.ts";
import { withDate } from "../lib/office.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description: "Reserve a desk for yourself on a specific date.",
  inputSchema: z.object({
    desk_label: z.string().describe("Desk label, e.g. 'A5'"),
    date: z.string().describe("ISO8601 date (YYYY-MM-DD)"),
    note: z.string().optional().describe("Optional note"),
  }),
  execute: ({ desk_label, date, note }, ctx) =>
    withDate(date, async (day) => {
      const result = await reserveDesk(desk_label, ctx.userId, day, note ?? null);
      if (result.ok) return `Reserved desk ${result.reservation.desk.label} for ${day}.`;
      switch (result.error) {
        case "not_found":
          return `No desk found with label '${desk_label}'.`;
        case "inactive":
          return `Desk '${desk_label}' is no longer available.`;
        case "permanent_owner":
          return `Desk '${desk_label}' is permanently assigned to ${result.owner} and can't be booked.`;
        case "past_date":
          return "Can't reserve a desk in the past. Provide today or a future date.";
        default: {
          const existing = (await listReservationsForDate(day)).find((reservation) => reservation.desk.label === desk_label);
          return existing
            ? `Desk '${desk_label}' is already booked by ${existing.user.name} on ${day}.`
            : `Could not reserve desk '${desk_label}' — invalid request.`;
        }
      }
    }),
});
