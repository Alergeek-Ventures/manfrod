import { z } from "zod";
import { sendProactive } from "../../lib/proactive.ts";
import { isValidIsoDate } from "../../lib/time.ts";
import { holidayPlanStatus } from "../lib/calendar.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Proactively DM a specific user asking whether they're working or taking vacation on an upcoming holiday. Safe to call directly — it re-checks the plan itself and is a no-op if already resolved/snoozed — but prefer check-holiday-plan first when fanning out over a whole team, so you don't waste calls.",
  inputSchema: z.object({
    user_id: z.string().describe("User UUID to ask"),
    date: z.string().describe("Holiday date ISO8601 (YYYY-MM-DD)"),
    holiday_name: z.string().describe("Holiday name, e.g. 'Boże Ciało'"),
  }),
  async execute({ user_id, date, holiday_name }, ctx) {
    if (!isValidIsoDate(date)) return `Invalid date: ${date}`;
    const status = await holidayPlanStatus(ctx.readableLevels, user_id, date);
    if (!status.startsWith("needs_ask")) return `Pomijam ${user_id} na ${date} — już rozwiązane: ${status}`;
    const prompt = `[Proaktywne sprawdzenie święta]
Za mniej niż tydzień jest ${holiday_name} (${date}). Nie masz nic zapisanego na ten dzień —
ani urlopu, ani informacji że pracujesz. Zapytaj krótko, czy w tym dniu pracujesz, czy
bierzesz urlop.

Gdy user odpowie:
- że pracuje → wywołaj record-holiday-plan(date: "${date}", status: "working")
- że bierze urlop / będzie nieobecny → wywołaj report-vacation jak zwykle (nie record-holiday-plan)
- że jeszcze nie wie → wywołaj record-holiday-plan(date: "${date}", status: "unsure"); zapytasz
go ponownie za 2-3 dni
`;
    const sent = await sendProactive(user_id, prompt);
    return sent.ok
      ? `Wysłano pytanie do usera ${user_id} o ${holiday_name} (${date}).`
      : `Nie udało się wysłać pytania do ${user_id}: :${sent.error}`;
  },
});
