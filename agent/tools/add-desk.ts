import { z } from "zod";
import { createDesk } from "../../lib/desks.ts";
import { adminRefusal, deskAttrs, deskFields } from "../lib/office.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description: "Admin only. Add a new desk to the office layout (location, equipment, map position).",
  inputSchema: z.object({
    label: z.string().describe("Desk label, e.g. 'A5'"),
    location_note: deskFields.location_note.describe("Free-text location, e.g. 'przy oknie'"),
    equipment: deskFields.equipment.describe("Comma-separated equipment tags, e.g. 'usb-c,mac_mini'"),
    map_x: deskFields.map_x.describe("Pixel x on the base map image"),
    map_y: deskFields.map_y.describe("Pixel y on the base map image"),
    permanent_owner: deskFields.permanent_owner.describe("If set, desk is always occupied by this person and never bookable"),
  }),
  async execute(args, ctx) {
    const refusal = await adminRefusal(ctx.userId);
    if (refusal) return refusal;
    try {
      const desk = await createDesk({ label: args.label, ...deskAttrs(args) });
      return `Added desk '${desk.label}'.`;
    } catch (error) {
      return `Could not add desk: ${(error as Error).message}`;
    }
  },
});
