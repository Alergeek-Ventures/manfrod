import { z } from "zod";
import { listNodesByDate } from "../../lib/memory/nodes.ts";
import { PROJECT_DOC, noteDate, unknownProject, resolveProject, dateBound } from "../lib/notes.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "List notes in chronological order (newest first), optionally bounded to a date range and/or scoped to one project. Use for activity/project summaries — 'what happened today', 'this week', 'between two dates' — where you need everything in time order, not a relevance search like search-notes.",
  inputSchema: z.object({
    since: z
      .string()
      .optional()
      .describe("Only notes on/after this date (YYYY-MM-DD, Europe/Warsaw calendar day). Omit for no lower bound."),
    until: z
      .string()
      .optional()
      .describe("Only notes on/before this date (YYYY-MM-DD, Europe/Warsaw calendar day). Omit for no upper bound."),
    limit: z.number().int().optional().describe("Max notes to return (default 50)"),
    order: z
      .string()
      .optional()
      .describe("'desc' (default, newest first) or 'asc' (oldest first — use to find the earliest/oldest notes in a range)"),
    project: z.string().optional().describe(PROJECT_DOC),
  }),
  async execute(args, ctx) {
    const since = dateBound(args.since, "since");
    const until = dateBound(args.until, "until");
    if (since === "invalid" || until === "invalid") return "Invalid date — use YYYY-MM-DD.";
    const resolved = await resolveProject(args.project, ctx.msgCtx);
    if (!resolved.ok) return unknownProject(args.project);
    const order = args.order === "asc" ? "asc" : "desc";
    const found = await listNodesByDate(ctx.readableLevels, {
      since,
      until,
      projectId: resolved.id,
      limit: args.limit ?? 50,
      order,
    });
    if (found.length === 0) return "No notes found in that range.";
    const label = order === "asc" ? "oldest first" : "newest first";
    return `Found ${found.length} notes (${label}):\n${found.map((node) => `- ${noteDate(node)} [${node.id}] ${node.content}`).join("\n")}`;
  },
});
