import { z } from "zod";
import { loadMapState } from "../../lib/office/map.ts";
import { DATE_DOC, deskLine, withDate } from "../lib/office.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "List all desks with their equipment and status for a date (default today): free, booked by someone, used by its owner, or free because its owner is away.",
  inputSchema: z.object({ date: z.string().optional().describe(DATE_DOC) }),
  execute: ({ date }) =>
    withDate(date, async (day) => {
      const state = await loadMapState(day);
      if (state.desks.length === 0) return "No desks configured yet.";
      return `Desks (${day}):\n${state.desks.map(deskLine).join("\n")}`;
    }),
});
