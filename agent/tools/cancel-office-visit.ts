import { z } from "zod";
import { getUser, isAdmin, isUuid } from "../../lib/accounts.ts";
import { cancelVisit, getVisit } from "../../lib/office/presence.ts";
import { datesBetween, refreshNote } from "../lib/desk-plan.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Cancel a recorded office visit, when it was called off or recorded twice. Take its ID from list-office-presence. Its author, the people in it and admins can cancel it.",
  inputSchema: z.object({ visit_id: z.string().describe("Visit ID") }),
  async execute({ visit_id }, ctx) {
    if (!ctx.readableLevels.includes("internal")) return "Office visits are only available in team channels and DMs.";
    const id = visit_id.trim();
    const visit = isUuid(id) ? await getVisit(id) : null;
    if (!visit) return `No visit with ID ${visit_id}.`;
    if (visit.cancelledAt) return "That visit is already cancelled.";
    const allowed = visit.createdBy === ctx.userId || visit.userIds.includes(ctx.userId) || isAdmin(await getUser(ctx.userId));
    if (!allowed) return "Only the person who recorded the visit, the people in it or an admin can cancel it.";
    const cancelled = await cancelVisit(id);
    if (!cancelled) return "That visit is already cancelled.";
    return `Cancelled the visit ${visit.startsOn}..${visit.endsOn}: ${visit.note}.${await refreshNote(datesBetween(visit.startsOn, visit.endsOn))}`;
  },
});
