import { z } from "zod";
import { getNodeLinksAccessible } from "../../lib/memory/nodes.ts";
import { search } from "../../lib/memory/search.ts";
import { PROJECT_DOC, noteDate, unknownProject, resolveProject } from "../lib/notes.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Search your zettelkasten for relevant notes. Use this when you need to find facts, preferences, or context not in the initial note context.",
  inputSchema: z.object({
    query: z.string().describe("Search query - what you want to find"),
    project: z.string().optional().describe(PROJECT_DOC),
  }),
  async execute({ query, project }, ctx) {
    const resolved = await resolveProject(project, ctx.msgCtx);
    if (!resolved.ok) return unknownProject(project);
    const found = await search(ctx.userId, ctx.readableLevels, query, { limit: 10, projectId: resolved.id });
    if (found.length === 0) return `No relevant notes found for: ${query}`;
    const lines = await Promise.all(
      found.map(async (node) => {
        const linked = (await getNodeLinksAccessible(ctx.readableLevels, node.id)).map((other) => other.id).join(", ");
        const line = `- ${noteDate(node)} [${node.id}] ${node.content}`;
        return linked === "" ? line : `${line}\n  Linked to: ${linked}`;
      }),
    );
    return `Found ${found.length} notes:\n${lines.join("\n")}`;
  },
});
