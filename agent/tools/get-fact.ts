import { z } from "zod";
import { getFact } from "../../lib/facts.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description: "Look up a structured fact by key (vacations, meetings). Key format: 'absence:user_id:date', 'meeting:channel:ts'.",
  inputSchema: z.object({ key: z.string().describe("Exact fact key") }),
  async execute({ key }, ctx) {
    const fact = await getFact(key, ctx.readableLevels);
    return fact ? `${fact.key}: ${fact.value}` : `Fact not found: ${key}`;
  },
});
