import { z } from "zod";
import { cardElementSchema } from "../../lib/slack/cards.ts";
import { cardRefusal, describeCardOutcome, showCard } from "../../lib/slack/card-stream.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Show a card in the Slack conversation, rendered live in your reply while you write it. Use it only when a card reads better than text: structured summaries, tables, statuses, sets of links. Call it at most once per turn and keep normal prose in your text reply, not in the card. Elements render in order: header, section (markdown), fields (1-10 short label/value pairs), table (one per card, first row is the header), context (small note), divider, buttons (https links only). A card holds at most 50 elements. Invalid elements are skipped and listed in the result, as are tables cut to fit; shown elements cannot be removed, so mention or fix anything that was dropped in your text.",
  inputSchema: z.object({
    elements: z.array(z.union([cardElementSchema, z.unknown()])).describe("Card elements in display order"),
  }),
  async execute({ elements }, ctx, runtime) {
    const refusal = cardRefusal(ctx.kind);
    if (refusal) return refusal;
    const outcome = await showCard(runtime.callId, elements, ctx);
    return describeCardOutcome(outcome);
  },
});
