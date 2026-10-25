import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { callUserMcpTool, listUserMcpTools } from "../../lib/mcp/tools.ts";
import { getConnection } from "../../lib/linear/index.ts";
import { runWithSecrets } from "../../lib/secrets.ts";
import { fetchIssue, getCycles, linearProjectForChannel, listIssues, listProjects, searchIssues } from "../../lib/tools/linear.ts";
import { toolCtx } from "../../lib/tools/context.ts";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const { userId, msgCtx, sessionKey } = toolCtx(ctx);
      const entries: Record<string, any> = {};
      const secured =
        <I>(toolName: string, execute: (input: I) => Promise<string>) =>
        (input: I) =>
          runWithSecrets({ toolName, userId, sessionKey }, input, execute);

      if (userId) {
        for (const remote of await listUserMcpTools(userId)) {
          const providerId = remote.providerId;
          const remoteName = remote.remoteName;
          const ownerId = userId;
          entries[remote.name] = defineTool({
            description: remote.description,
            inputSchema: remote.inputSchema as any,
            execute: secured(remote.name, (input) => callUserMcpTool(ownerId, providerId, remoteName, input)),
          });
        }
      }

      const projectId = await linearProjectForChannel(msgCtx.channel);
      if (projectId && (await getConnection(projectId))) {
        entries.linear_list_issues = defineTool({
          description: "Lists recent issues for this project's connected Linear team.",
          inputSchema: z.object({ limit: z.number().int().optional().describe("Max issues to return (default 25)") }),
          execute: secured("linear_list_issues", ({ limit }: { limit?: number }) => listIssues(projectId, limit)),
        });
        entries.linear_get_issue = defineTool({
          description: 'Gets a single Linear issue by its identifier (e.g. "ENG-123").',
          inputSchema: z.object({ identifier: z.string().describe("Issue identifier, e.g. ENG-123") }),
          execute: secured("linear_get_issue", ({ identifier }: { identifier: string }) => fetchIssue(projectId, identifier)),
        });
        entries.linear_search_issues = defineTool({
          description: "Full-text searches this project's connected Linear team's issues.",
          inputSchema: z.object({
            term: z.string().describe("Search term"),
            limit: z.number().int().optional().describe("Max results to return (default 25)"),
          }),
          execute: secured("linear_search_issues", ({ term, limit }: { term: string; limit?: number }) =>
            searchIssues(projectId, term, limit),
          ),
        });
        entries.linear_list_projects = defineTool({
          description: "Lists Linear projects owned by this project's connected team.",
          inputSchema: z.object({}),
          execute: secured("linear_list_projects", () => listProjects(projectId)),
        });
        entries.linear_list_cycles = defineTool({
          description: "Lists recent cycles for this project's connected Linear team.",
          inputSchema: z.object({ limit: z.number().int().optional().describe("Max cycles to return (default 10)") }),
          execute: secured("linear_list_cycles", ({ limit }: { limit?: number }) => getCycles(projectId, limit)),
        });
      }

      return Object.keys(entries).length > 0 ? entries : null;
    },
  },
});
