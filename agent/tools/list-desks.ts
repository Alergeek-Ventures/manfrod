import { z } from "zod";
import { listDesks, listReservationsForDate } from "../../lib/desks.ts";
import { DATE_DOC, withDate, deskLine } from "../lib/office.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description: "List all desks with their equipment and booking status for a date (default today).",
  inputSchema: z.object({ date: z.string().optional().describe(DATE_DOC) }),
  execute: ({ date }) =>
    withDate(date, async (day) => {
      const desks = await listDesks();
      if (desks.length === 0) return "No desks configured yet.";
      const byDesk = new Map((await listReservationsForDate(day)).map((reservation) => [reservation.deskId, reservation]));
      return `Desks (${day}):\n${desks.map((desk) => deskLine(desk, byDesk.get(desk.id)?.user.name ?? null)).join("\n")}`;
    }),
});
