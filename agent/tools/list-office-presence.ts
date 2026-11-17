import { z } from "zod";
import { predictOfficeDay } from "../../lib/office/presence.ts";
import { describePrediction } from "../../lib/office/presence-format.ts";
import { isValidIsoDate, localToday } from "../../lib/time.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    'Who is expected in the office on a day: each office member as in the office, remote, away or unknown with the reason and confidence (their own statements, Firmowid leave and sessions, recorded absences, visits, desk bookings, weekday habits), plus recorded visits with their IDs and the expected headcount. Use for questions like "kto jutro w biurze?" and before recording a visit.',
  inputSchema: z.object({ date: z.string().optional().describe("ISO date (YYYY-MM-DD), default today") }),
  label: { start: ({ date }) => `Check office presence${date ? ` on ${date}` : ""}` },
  async execute({ date }, ctx) {
    if (!ctx.readableLevels.includes("internal")) return "Office presence is only available in team channels and DMs.";
    const day = date ?? localToday();
    if (!isValidIsoDate(day)) return `Invalid date '${date}'. Use YYYY-MM-DD.`;
    const prediction = await predictOfficeDay(day);
    if (!prediction.layoutId) return "No office is set up yet.";
    if (prediction.people.length === 0 && prediction.visits.length === 0)
      return "Nobody is on the office member list yet; an admin adds them in the panel's office editor.";
    return describePrediction(prediction);
  },
});
