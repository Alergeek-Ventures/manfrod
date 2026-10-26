import { z } from "zod";
import { getFact, setFact } from "../../lib/facts.ts";
import { planKey, unsurePlan } from "../../lib/holidays.ts";
import { isValidIsoDate, localToday } from "../../lib/time.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

const CONFIRMATIONS = {
  working: "Zanotowane, pracujesz w tym czasie. Nie będę już pytać.",
  off: "Zanotowane, masz wolne. Nie będę już pytać.",
  declined: "Jasne, nie będę już pytać o ten termin.",
};

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Record the current user's answer to a holiday check-in, for the period start date given in that check-in: 'working' (works on the holiday), 'off' (has the holiday off; record any extra days off with report-vacation first), 'unsure' (decides later; you'll remind them once) or 'declined' (doesn't want to say). After this they won't be asked about that period again.",
  inputSchema: z.object({
    period: z.string().describe("Period start date ISO8601 (YYYY-MM-DD) from the check-in"),
    status: z.enum(["working", "off", "unsure", "declined"]),
    note: z.string().max(300).optional().describe("Short Polish note on their plan, e.g. 'wolne do 3.01, potem zdalnie'"),
  }),
  async execute({ period, status, note }, ctx) {
    if (!isValidIsoDate(period)) return `Invalid date: ${period}`;
    try {
      const key = planKey(ctx.userId, period);
      if (status === "unsure") {
        const plan = unsurePlan((await getFact(key, ["internal"]))?.value ?? null, localToday(), period);
        await setFact(key, plan, ["internal"], ctx.userId);
        return plan === "unsure" ? "Zanotowane, nie będę już dopytywać." : "Zanotowane, przypomnę się raz, bliżej terminu.";
      }
      await setFact(key, note ? `${status} — ${note}` : status, ["internal"], ctx.userId);
      return CONFIRMATIONS[status];
    } catch (error) {
      return `Błąd zapisu: ${(error as Error).message}`;
    }
  },
});
