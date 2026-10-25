import { z } from "zod";
import { listDesks, listReservationsForDate } from "../../lib/desks.ts";
import { DATE_DOC, withDate } from "../lib/office.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description: "List who has which desk reserved on a date (default today), as text.",
  inputSchema: z.object({ date: z.string().optional().describe(DATE_DOC) }),
  execute: ({ date }) =>
    withDate(date, async (day) => {
      const reservations = await listReservationsForDate(day);
      const permanent = (await listDesks()).filter((desk) => desk.permanentOwner);
      if (reservations.length === 0 && permanent.length === 0) return `No desk reservations for ${day}.`;
      const lines = [
        ...permanent.map((desk) => `- ${desk.label}: ${desk.permanentOwner} (stałe przypisanie)`),
        ...reservations.map(
          (reservation) => `- ${reservation.desk.label}: ${reservation.user.name}${reservation.note ? ` — ${reservation.note}` : ""}`,
        ),
      ];
      return `Desk reservations (${day}):\n${lines.join("\n")}`;
    }),
});
