import { z } from "zod";
import { cardElementSchema } from "../../lib/slack/cards.ts";
import { cardRefusal, describeCardOutcome, showCard } from "../../lib/slack/card-stream.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Show a card in the Slack conversation, rendered live in your reply while you write it. Use it only when a card reads better than text: structured summaries, tables, statuses, sets of links, or a chart/report the person asked for. Never use it for short conversational answers. Call it at most once per turn and keep normal prose in your text reply, not in the card. Elements render in order: header, section (markdown, optionally with one button on the right, e.g. a **bold** title row with a link to the full report), fields (1-10 short label/value pairs), columns (1-5 rows of 1-3 side-by-side columns, each an optional bold title plus a markdown value, for KPIs like title 'Revenue' with text '**$12,400** ▲ 8%'), chart (line, area, bar or pie; at most 2 per card; only for numbers the person asked to see or that are clearly a trend or comparison), table (one per card, first row is the header), context (small note), divider, buttons (up to 5: link buttons with an https url, or reply buttons with reply: true, optionally styled primary or danger). Text has no colour: show change with ▲/▼ or 🟢/🔴. A reply button sends exactly its text to you in this thread as a message from whoever clicks it, marked [clicked card button], and only the first click on a card counts; it grants no extra rights, so handle it like a typed message. Use reply buttons only for clear next steps. A card holds at most 50 blocks: a columns element costs 1 + its rows + all its columns (a full 5x3 one costs 21), a chart costs 2, every other element costs 1. Invalid elements are skipped and listed in the result, as are tables or chart labels cut to fit; shown elements cannot be removed, so mention or fix anything that was dropped in your text.",
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
