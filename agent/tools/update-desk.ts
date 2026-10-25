import { z } from "zod";
import { getDeskByLabel, updateDesk } from "../../lib/desks.ts";
import { adminRefusal, deskFields, deskAttrs } from "../lib/office.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description: "Admin only. Update an existing desk's location, equipment, map position, or permanent owner.",
  inputSchema: z.object({
    label: z.string().describe("Existing desk label to update"),
    location_note: deskFields.location_note.describe("New free-text location"),
    equipment: deskFields.equipment.describe("New comma-separated equipment tags"),
    map_x: deskFields.map_x.describe("New pixel x on the base map image"),
    map_y: deskFields.map_y.describe("New pixel y on the base map image"),
    permanent_owner: deskFields.permanent_owner.describe("Set to permanently assign the desk, or leave unset to keep it as-is"),
  }),
  async execute(args, ctx) {
    const refusal = await adminRefusal(ctx.userId);
    if (refusal) return refusal;
    const desk = await getDeskByLabel(args.label);
    if (!desk) return `No desk found with label '${args.label}'.`;
    try {
      const updated = await updateDesk(desk, deskAttrs(args));
      return `Updated desk '${updated.label}'.`;
    } catch (error) {
      return `Could not update desk: ${(error as Error).message}`;
    }
  },
});
