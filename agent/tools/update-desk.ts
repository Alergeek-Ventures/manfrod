import { z } from "zod";
import { getDeskByLabel } from "../../lib/desks.ts";
import { updateDesk, type DeskPatch } from "../../lib/office/layout.ts";
import { adminRefusal, deskFields, editorUrl, splitEquipment } from "../lib/office.ts";
import { resolvePerson } from "../../lib/people.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

const NO_OWNER = ["none", "nobody", "-", "brak", "nikt"];

export default defineManfrodTool({
  description:
    "Admin only. Update an existing desk's label, location, equipment or owner. Position, size and rotation are edited on the map in the panel.",
  inputSchema: z.object({
    label: z.string().describe("Existing desk label to update"),
    new_label: z.string().optional().describe("Rename the desk"),
    location_note: deskFields.location_note.describe("New free-text location"),
    equipment: deskFields.equipment.describe("New comma-separated equipment tags (replaces the old ones)"),
    owner: deskFields.owner.describe("New owner (Slack ID, email or name), or 'none' to make the desk bookable by anyone"),
  }),
  async execute(args, ctx) {
    const refusal = await adminRefusal(ctx.userId);
    if (refusal) return refusal;
    const desk = await getDeskByLabel(args.label);
    if (!desk) return `No desk found with label '${args.label}'.`;
    const patch: DeskPatch = {};
    if (args.new_label !== undefined) patch.label = args.new_label;
    if (args.location_note !== undefined) patch.locationNote = args.location_note.trim() || null;
    const equipment = splitEquipment(args.equipment);
    if (equipment) patch.equipment = equipment;
    if (args.owner !== undefined) {
      if (NO_OWNER.includes(args.owner.trim().toLowerCase())) patch.ownerUserId = null;
      else {
        const owner = await resolvePerson(args.owner);
        if (!owner.ok) return owner.message;
        patch.ownerUserId = owner.user.id;
      }
    }
    try {
      const updated = await updateDesk(desk.id, patch);
      return `Updated desk '${updated.label}'. Its place on the map is edited at ${editorUrl()}.`;
    } catch (error) {
      return `Could not update desk: ${(error as Error).message}`;
    }
  },
});
