import { z } from "zod";
import { getUser, isAdmin } from "../../lib/accounts.ts";
import { clearPresence, setPresence } from "../../lib/office/presence.ts";
import { isValidIsoDate, withWeekday } from "../../lib/time.ts";
import { resolvePerson } from "../lib/people.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

const STATUS_LABEL = { office: "w biurze", remote: "zdalnie", leave: "nieobecny/a" };

export default defineManfrodTool({
  description:
    'Record that someone will or won\'t be in the office on given days: in the office, remote, or away (leave). Use whenever a person says it ("jutro zdalnie", "w czwartek będę w biurze", "w piątek mnie nie ma"); it feeds the office headcount and desk plans. status clear removes an earlier statement. Without person it is the caller; setting it for someone else is admin-only.',
  inputSchema: z.object({
    dates: z.array(z.string()).min(1).max(31).describe("ISO dates (YYYY-MM-DD), resolved from relative ones against [Current Context]"),
    status: z.enum(["office", "remote", "leave", "clear"]),
    note: z.string().max(200).optional().describe("Short note in the person's words, e.g. 'od 12', 'u klienta'"),
    person: z.string().optional().describe("Slack ID, <@mention>, Manfrod user ID or name; omit for the caller"),
  }),
  label: { start: ({ status }) => `Set office presence: ${status}` },
  async execute({ dates, status, note, person }, ctx) {
    if (!ctx.readableLevels.includes("internal")) return "Office presence is only available in team channels and DMs.";
    const invalid = dates.filter((date) => !isValidIsoDate(date));
    if (invalid.length > 0) return `Invalid dates: ${invalid.join(", ")}. Use YYYY-MM-DD.`;
    const caller = await getUser(ctx.userId);
    if (!caller) return "I don't know who you are, nothing saved.";
    let target = caller;
    if (person) {
      const match = await resolvePerson(person);
      if (!match.ok) return `Nothing saved: ${match.message}.`;
      target = match.user;
    }
    if (target.id !== caller.id && !isAdmin(caller))
      return "Only admins can set office presence for someone else; ask that person to tell me themselves.";
    const days = [...new Set(dates)].sort();
    const who = target.name ?? target.slackId;
    if (status === "clear") {
      const cleared = await Promise.all(days.map((date) => clearPresence(target.id, date)));
      const removed = days.filter((_, index) => cleared[index]);
      return removed.length > 0
        ? `Removed ${who}'s statement for ${removed.map(withWeekday).join(", ")}; it will be predicted again.`
        : `${who} had no statement for those days.`;
    }
    await Promise.all(days.map((date) => setPresence(target.id, date, status, "chat", note?.trim() || null)));
    return `Saved: ${who} ${STATUS_LABEL[status]} on ${days.map(withWeekday).join(", ")}.`;
  },
});
