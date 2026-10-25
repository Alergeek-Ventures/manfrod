import { z } from "zod";
import { webSearchText } from "../../lib/memory/retrospector.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Search the web for current information. Use this when you need up-to-date facts, news, documentation, or anything not in your notes.",
  inputSchema: z.object({ query: z.string().describe("Search query - what to look up on the web") }),
  async execute({ query }) {
    return webSearchText(query);
  },
});
