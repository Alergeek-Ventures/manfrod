import { z } from "zod";
import { deactivateDesk, getDeskByLabel } from "../../lib/desks.ts";
import { adminRefusal } from "../lib/office.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description: "Admin only. Remove a desk from the bookable layout (soft delete).",
  inputSchema: z.object({ label: z.string().describe("Desk label to deactivate") }),
  async execute({ label }, ctx) {
    const refusal = await adminRefusal(ctx.userId);
    if (refusal) return refusal;
    const desk = await getDeskByLabel(label);
    if (!desk) return `No desk found with label '${label}'.`;
    await deactivateDesk(desk);
    return `Deactivated desk '${label}'.`;
  },
});
