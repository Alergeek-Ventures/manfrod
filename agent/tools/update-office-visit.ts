import { z } from "zod";
import { isUuid } from "../../lib/accounts.ts";
import { getVisit, updateVisit } from "../../lib/office/presence.ts";
import { describeVisit } from "../../lib/office/presence-format.ts";
import { isValidIsoDate } from "../../lib/time.ts";
import { datesBetween, longStayHint, refreshNote } from "../lib/desk-plan.ts";
import { canEditVisits, nameMap, resolveVisitors, VISIT_ERRORS, VISIT_REFUSAL } from "../lib/visits.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Fix a recorded office visit: who comes, named or unnamed guests, the days or the note. Prefer this over cancelling and recording it again. Take the ID from list-office-presence; anyone on the team can fix any visit. Lists replace the old ones: pass the full people or guest_names list. Leave out what doesn't change.",
  inputSchema: z.object({
    visit_id: z.string().describe("Visit ID"),
    start_date: z.string().optional().describe("New first day, YYYY-MM-DD"),
    end_date: z.string().optional().describe("New last day, YYYY-MM-DD"),
    people: z
      .array(z.string())
      .max(40)
      .optional()
      .describe("Everyone coming who has Slack (replaces the list): Slack IDs, <@mentions>, names"),
    guest_names: z.array(z.string().min(1).max(60)).max(40).optional().describe("Named guests without a Slack account (replaces the list)"),
    guests: z.number().int().min(0).max(100).optional().describe("How many more people come without a name"),
    note: z.string().min(1).max(300).optional().describe("New description"),
  }),
  label: { start: () => "Update office visit" },
  async execute({ visit_id, start_date, end_date, people, guest_names, guests, note }, ctx) {
    if (!canEditVisits(ctx.readableLevels)) return VISIT_REFUSAL;
    const id = visit_id.trim();
    const visit = isUuid(id) ? await getVisit(id) : null;
    if (!visit || visit.cancelledAt) return VISIT_ERRORS.not_found;
    if ([start_date, end_date].some((date) => date !== undefined && !isValidIsoDate(date))) return VISIT_ERRORS.invalid_dates;
    const resolved = await resolveVisitors(people ?? []);
    if (!resolved.ok) return resolved.message;
    const named = guest_names ?? visit.guestNames;
    const unnamed = guests ?? Math.max(visit.guests - visit.guestNames.length, 0);
    const updated = await updateVisit(id, {
      startsOn: start_date,
      endsOn: end_date,
      userIds: people ? resolved.userIds : undefined,
      guestNames: named,
      guests: unnamed + named.length,
      note,
    });
    if (!updated.ok) return VISIT_ERRORS[updated.error];
    const names = nameMap(resolved.everyone);
    const dates = [
      ...datesBetween(updated.previous.startsOn, updated.previous.endsOn),
      ...datesBetween(updated.visit.startsOn, updated.visit.endsOn),
    ];
    return `Updated: ${describeVisit(updated.visit, names)}${await refreshNote(dates)}${await longStayHint(updated.visit, names)}`;
  },
});
