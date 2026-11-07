import { z } from "zod";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "EXPERIMENT, call only when someone explicitly asks for a card spike. Renders a card in the thread: write a short sentence first, then call it once with elements such as a header, sections, a divider and a table.",
  inputSchema: z.object({
    elements: z
      .array(
        z.object({
          type: z.enum(["header", "section", "divider", "table"]),
          text: z.string().optional().describe("Text of a header or section; section text is markdown"),
          rows: z.array(z.array(z.string())).optional().describe("Rows of a table, first row is the header"),
        }),
      )
      .describe("Card elements in display order"),
  }),
  async execute() {
    return "Card rendered in the thread.";
  },
});
