import { z } from "zod";
import { listVisits, recordVisit } from "../../lib/office/presence.ts";
import { describeVisit } from "../../lib/office/presence-format.ts";
import { isValidIsoDate } from "../../lib/time.ts";
import { datesBetween, longStayHint, refreshNote } from "../lib/desk-plan.ts";
import { canEditVisits, nameMap, resolveVisitors, VISIT_ERRORS, VISIT_REFUSAL } from "../lib/visits.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Record that people are coming to the office on given days: colleagues from another city (e.g. the team from Wrocław), newcomers, a team day, or outside guests. Everyone named goes in people (their Slack account is looked up even if they never talked to Manfrod); only named people without a Slack account go in guest_names, and guests counts the unnamed rest. Call list-office-presence for those days first; to change a visit that is already there use update-office-visit instead.",
  inputSchema: z.object({
    start_date: z.string().describe("First day, YYYY-MM-DD"),
    end_date: z.string().optional().describe("Last day, YYYY-MM-DD (default: start_date)"),
    people: z
      .array(z.string())
      .max(40)
      .optional()
      .describe("People coming who have Slack: Slack IDs, <@mentions>, Manfrod user IDs or names"),
    guest_names: z.array(z.string().min(1).max(60)).max(40).optional().describe("Named guests without a Slack account"),
    guests: z.number().int().min(0).max(100).optional().describe("How many more people come without a name"),
    note: z.string().min(1).max(300).describe("What it is, e.g. 'zespół z Wrocławia', 'warsztaty z klientem X'"),
  }),
  label: { start: ({ start_date }) => `Record office visit on ${start_date}` },
  async execute({ start_date, end_date, people, guest_names, guests, note }, ctx) {
    if (!canEditVisits(ctx.readableLevels)) return VISIT_REFUSAL;
    const endsOn = end_date ?? start_date;
    if (!isValidIsoDate(start_date) || !isValidIsoDate(endsOn)) return VISIT_ERRORS.invalid_dates;
    const resolved = await resolveVisitors(people ?? []);
    if (!resolved.ok) return resolved.message;
    const existing = await listVisits(start_date, endsOn);
    const named = guest_names ?? [];
    const recorded = await recordVisit({
      startsOn: start_date,
      endsOn,
      userIds: resolved.userIds,
      guests: (guests ?? 0) + named.length,
      guestNames: named,
      note: note.trim(),
      createdBy: ctx.userId || null,
    });
    if (!recorded.ok) return VISIT_ERRORS[recorded.error];
    const names = nameMap(resolved.everyone);
    const verb = recorded.duplicate ? "Already recorded, merged into it" : "Recorded";
    const dates = datesBetween(recorded.visit.startsOn, recorded.visit.endsOn);
    const lines = [
      `${verb}: ${describeVisit(recorded.visit, names)}${await refreshNote(dates)}${await longStayHint(recorded.visit, names)}`,
    ];
    const others = existing.filter((visit) => visit.id !== recorded.visit.id);
    if (others.length > 0)
      lines.push(
        `Other visits already recorded on those days (fix them with update-office-visit, or cancel duplicates with cancel-office-visit):\n${others.map((visit) => `- ${describeVisit(visit, names)}`).join("\n")}`,
      );
    return lines.join("\n");
  },
});
