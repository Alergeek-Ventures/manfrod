import { z } from "zod";
import { listFacts } from "../../lib/facts.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description: "List structured facts with a key prefix. E.g. prefix 'absence:' lists all vacations/absences you can see.",
  inputSchema: z.object({ prefix: z.string().describe("Key prefix to search") }),
  async execute({ prefix }, ctx) {
    const found = await listFacts(prefix, ctx.readableLevels);
    if (found.length === 0) return `No facts found with prefix: ${prefix}`;
    return found.map((fact) => `- ${fact.key}: ${fact.value}`).join("\n");
  },
});
