import { z } from "zod";
import { describeLessons, recentLessons } from "../../../../../../lib/self-modify-lessons.ts";
import { defineManfrodTool } from "../../../../../lib/define-tool.ts";
import { authorize } from "../../../../../lib/self-modify.ts";

export default defineManfrodTool({
  description:
    "List the lessons learned from people's corrections to earlier self-modify pull requests. Read them before planning or reviewing a change and don't repeat those mistakes.",
  inputSchema: z.object({}),
  label: { start: () => "Reading lessons from earlier corrections" },
  async execute(_input, ctx) {
    const requester = await authorize(ctx);
    if (typeof requester === "string") return requester;
    return describeLessons(await recentLessons());
  },
});
