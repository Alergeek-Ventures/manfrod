import { z } from "zod";
import { createDesk } from "../../lib/office/layout.ts";
import { personName } from "../../lib/accounts.ts";
import { adminRefusal, deskFields, editorUrl, splitEquipment } from "../lib/office.ts";
import { resolvePerson } from "../lib/people.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Admin only. Add a new desk (label, location, equipment, owner). Its position on the office map is set by dragging it in the panel editor afterwards.",
  inputSchema: z.object({
    label: z.string().describe("Desk label, e.g. 'A5'"),
    location_note: deskFields.location_note.describe("Free-text location, e.g. 'przy oknie'"),
    equipment: deskFields.equipment.describe("Comma-separated equipment tags, e.g. 'usb-c,mac_mini'"),
    owner: deskFields.owner.describe(
      "Person the desk belongs to (Slack ID, email or name); others can book it only on days the owner is away",
    ),
  }),
  async execute(args, ctx) {
    const refusal = await adminRefusal(ctx.userId);
    if (refusal) return refusal;
    const owner = args.owner ? await resolvePerson(args.owner) : null;
    if (owner && !owner.ok) return owner.message;
    try {
      const desk = await createDesk({
        label: args.label,
        locationNote: args.location_note?.trim() || null,
        equipment: splitEquipment(args.equipment),
        ownerUserId: owner?.ok ? owner.user.id : undefined,
      });
      const ownerText = owner?.ok ? ` owned by ${personName(owner.user)}` : "";
      return `Added desk '${desk.label}'${ownerText}. Place it on the map at ${editorUrl()}.`;
    } catch (error) {
      return `Could not add desk: ${(error as Error).message}`;
    }
  },
});
