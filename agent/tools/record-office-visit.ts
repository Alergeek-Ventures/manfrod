import { z } from "zod";
import { listUsers } from "../../lib/accounts.ts";
import { listVisits, recordVisit } from "../../lib/office/presence.ts";
import { describeVisit } from "../../lib/office/presence-format.ts";
import { isValidIsoDate } from "../../lib/time.ts";
import { resolvePerson } from "../lib/people.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

const ERRORS = {
  invalid_dates: "Invalid dates: use YYYY-MM-DD and end_date on or after start_date.",
  invalid_guests: "guests must be a whole number, 0 or more.",
  nobody: "Nothing saved: name at least one person or give a guest count.",
  no_layout: "Nothing saved: no office is set up yet.",
};

export default defineManfrodTool({
  description:
    "Record that people are coming to the office on given days: colleagues from another city (e.g. the team from Wrocław), a team day, or outside guests. Known teammates go in people, everyone else is counted in guests. Call list-office-presence for those days first and don't record a visit that is already there.",
  inputSchema: z.object({
    start_date: z.string().describe("First day, YYYY-MM-DD"),
    end_date: z.string().optional().describe("Last day, YYYY-MM-DD (default: start_date)"),
    people: z.array(z.string()).max(40).optional().describe("Teammates coming: Slack IDs, <@mentions>, Manfrod user IDs or names"),
    guests: z.number().int().min(0).max(100).optional().describe("How many other people come (not teammates listed in people)"),
    note: z.string().min(1).max(300).describe("What it is, e.g. 'zespół z Wrocławia', 'warsztaty z klientem X'"),
  }),
  label: { start: ({ start_date }) => `Record office visit on ${start_date}` },
  async execute({ start_date, end_date, people, guests, note }, ctx) {
    if (!ctx.readableLevels.includes("internal")) return "Office visits are only available in team channels and DMs.";
    const endsOn = end_date ?? start_date;
    if (!isValidIsoDate(start_date) || !isValidIsoDate(endsOn)) return ERRORS.invalid_dates;
    const everyone = await listUsers();
    const matches = await Promise.all((people ?? []).map((person) => resolvePerson(person, everyone)));
    const problems = matches.flatMap((match) => (match.ok ? [] : [match.message]));
    if (problems.length > 0) return `Nothing saved: ${problems.join("; ")}. Fix the names, or count people who aren't teammates in guests.`;
    const userIds = matches.flatMap((match) => (match.ok ? [match.user.id] : []));
    const existing = await listVisits(start_date, endsOn);
    const recorded = await recordVisit({
      startsOn: start_date,
      endsOn,
      userIds,
      guests: guests ?? 0,
      note: note.trim(),
      createdBy: ctx.userId || null,
    });
    if (!recorded.ok) return ERRORS[recorded.error];
    const names = new Map(everyone.map((user) => [user.id, user.name ?? user.slackId]));
    const lines = [`Recorded: ${describeVisit(recorded.visit, names)}`];
    if (existing.length > 0)
      lines.push(
        `Other visits already recorded on those days (cancel duplicates with cancel-office-visit):\n${existing.map((visit) => `- ${describeVisit(visit, names)}`).join("\n")}`,
      );
    return lines.join("\n");
  },
});
