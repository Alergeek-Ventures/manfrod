import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { callUserMcpTool, listUserMcpTools } from "../../lib/mcp/tools.ts";
import { getConnection } from "../../lib/linear/index.ts";
import { runWithSecrets } from "../../lib/secrets.ts";
import {
  commentIssue,
  createIssue,
  fetchIssue,
  getCycles,
  linearProjectForChannel,
  linearRequester,
  listIssues,
  listProjects,
  searchIssues,
  updateIssue,
} from "../../lib/tools/linear.ts";
import { toolCtx } from "../../lib/tools/context.ts";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const { userId, msgCtx, sessionKey } = toolCtx(ctx);
      const entries: Record<string, any> = {};
      const secured =
        <I>(toolName: string, execute: (input: I) => Promise<string>, keepPlaceholders = false) =>
        (input: I) =>
          runWithSecrets({ toolName, userId, sessionKey, keepPlaceholders }, input, execute);

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
      const linear = projectId ? await getConnection(projectId) : null;
      if (projectId && linear) {
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

      if (projectId && linear?.mode === "app") {
        const fields = {
          description: z.string().optional().describe("Markdown description"),
          priority: z.number().int().min(0).max(4).optional().describe("0 none, 1 urgent, 2 high, 3 medium, 4 low"),
          assignee: z.string().optional().describe('Linear member name or email, or "me" for the person asking'),
          state: z.string().optional().describe('Workflow state name, e.g. "Todo", "In Progress", "Done"'),
          labels: z.array(z.string()).optional().describe("Label names"),
          project: z.string().optional().describe("Linear project name"),
          parent: z.string().optional().describe("Parent issue identifier, e.g. ENG-120, to make this a sub-issue"),
          dueDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("Due date, YYYY-MM-DD"),
          estimate: z.number().int().min(0).optional().describe("Estimate in the team's points scale"),
          cycle: z.string().optional().describe('Cycle number, or "current" / "next"'),
        };
        entries.linear_create_issue = defineTool({
          description:
            "Creates an issue in this project's connected Linear team. Confirm the title and details with the user first unless they were explicit. Returns the new issue's identifier and URL.",
          inputSchema: z.object({ title: z.string().describe("Issue title"), ...fields }),
          execute: secured(
            "linear_create_issue",
            async (input: Parameters<typeof createIssue>[1]) => createIssue(projectId, input, await linearRequester(userId)),
            true,
          ),
        });
        entries.linear_update_issue = defineTool({
          description:
            "Updates an issue in this project's connected Linear team: title, description, priority, assignee, state, project, parent, due date, estimate or cycle. Labels are added, not replaced.",
          inputSchema: z.object({
            identifier: z.string().describe("Issue identifier, e.g. ENG-123"),
            title: z.string().optional().describe("New title"),
            ...fields,
          }),
          execute: secured(
            "linear_update_issue",
            async ({ identifier, ...input }: { identifier: string } & Parameters<typeof updateIssue>[2]) =>
              updateIssue(projectId, identifier, input, await linearRequester(userId)),
            true,
          ),
        });
        entries.linear_comment_issue = defineTool({
          description: "Adds a comment to an issue in this project's connected Linear team.",
          inputSchema: z.object({
            identifier: z.string().describe("Issue identifier, e.g. ENG-123"),
            body: z.string().describe("Markdown comment body"),
          }),
          execute: secured(
            "linear_comment_issue",
            async ({ identifier, body }: { identifier: string; body: string }) =>
              commentIssue(projectId, identifier, body, await linearRequester(userId)),
            true,
          ),
        });
      }

      return Object.keys(entries).length > 0 ? entries : null;
    },
  },
});
