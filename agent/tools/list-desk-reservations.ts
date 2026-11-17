import { z } from "zod";
import { loadMapState } from "../../lib/office/map.ts";
import { DATE_DOC, withDate } from "../lib/office.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description: "List who sits at which desk on a date (default today), as text: bookings and owners who are in.",
  inputSchema: z.object({ date: z.string().optional().describe(DATE_DOC) }),
  execute: ({ date }) =>
    withDate(date, async (day) => {
      const state = await loadMapState(day);
      const lines = state.desks.flatMap((desk) => {
        if (desk.status === "owner_present") return [`- ${desk.label}: ${desk.ownerName} (właściciel)`];
        if (desk.status !== "taken" || !desk.reservation) return [];
        const guest = desk.reservation.userId ? "" : " (gość)";
        const note = desk.reservation.source === "plan" ? " — z planu biurek" : "";
        return [`- ${desk.label}: ${desk.fullName}${guest}${note}`];
      });
      if (lines.length === 0) return `No desk reservations for ${day}.`;
      return `Desk reservations (${day}):\n${lines.join("\n")}`;
    }),
});
