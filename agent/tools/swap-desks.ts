import { z } from "zod";
import { getUser } from "../../lib/accounts.ts";
import { requestSwap } from "../../lib/office/plan-actions.ts";
import { isValidIsoDate } from "../../lib/time.ts";
import { resolvePerson } from "../lib/people.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Ask another person to swap desks with the caller on a day. That person gets a DM with Accept/Decline; the swap happens only when they accept, and the posted desk plan is updated. Only for the caller's own desk.",
  inputSchema: z.object({
    date: z.string().describe("ISO date (YYYY-MM-DD)"),
    person: z.string().describe("Who to swap with: Slack ID, <@mention>, Manfrod user ID or name"),
  }),
  label: { start: ({ person }) => `Ask ${person} to swap desks` },
  async execute({ date, person }, ctx) {
    if (!ctx.readableLevels.includes("internal")) return "Desk swaps are only available in team channels and DMs.";
    if (!isValidIsoDate(date)) return `Invalid date '${date}'. Use YYYY-MM-DD.`;
    const caller = await getUser(ctx.userId);
    if (!caller) return "I don't know who you are.";
    const match = await resolvePerson(person);
    if (!match.ok) return `Nothing sent: ${match.message}.`;
    const started = await requestSwap(caller, match.user, date);
    return started.ok ? `Asked them by DM. ${started.message}` : `Nothing sent: ${started.message}`;
  },
});
