import { z } from "zod";
import { cancelReservation } from "../../lib/desks.ts";
import { withDate } from "../lib/office.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description: "Cancel your own desk reservation for a specific date.",
  inputSchema: z.object({
    desk_label: z.string().describe("Desk label, e.g. 'A5'"),
    date: z.string().describe("ISO8601 date (YYYY-MM-DD)"),
  }),
  execute: ({ desk_label, date }, ctx) =>
    withDate(date, async (day) =>
      (await cancelReservation(ctx.userId, desk_label, day))
        ? `Cancelled your reservation for desk '${desk_label}' on ${day}.`
        : `You don't have a reservation for desk '${desk_label}' on that date.`,
    ),
});
