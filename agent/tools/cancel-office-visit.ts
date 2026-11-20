import { z } from "zod";
import { isUuid } from "../../lib/accounts.ts";
import { cancelVisit, getVisit } from "../../lib/office/presence.ts";
import { datesBetween, refreshNote } from "../lib/desk-plan.ts";
import { canEditVisits, VISIT_REFUSAL } from "../lib/visits.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Cancel a recorded office visit, when it was called off or recorded twice. Take its ID from list-office-presence; anyone on the team can cancel any visit. To change who comes or when, use update-office-visit instead.",
  inputSchema: z.object({ visit_id: z.string().describe("Visit ID") }),
  async execute({ visit_id }, ctx) {
    if (!canEditVisits(ctx.readableLevels)) return VISIT_REFUSAL;
    const id = visit_id.trim();
    const visit = isUuid(id) ? await getVisit(id) : null;
    if (!visit) return `No visit with ID ${visit_id}.`;
    if (visit.cancelledAt) return "That visit is already cancelled.";
    const cancelled = await cancelVisit(id);
    if (!cancelled) return "That visit is already cancelled.";
    return `Cancelled the visit ${visit.startsOn}..${visit.endsOn}: ${visit.note}.${await refreshNote(datesBetween(visit.startsOn, visit.endsOn))}`;
  },
});
