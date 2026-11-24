import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { callUserMcpTool, listUserMcpTools } from "../../lib/mcp/tools.ts";
import { channelAudience } from "../../lib/memory/access.ts";
import { getConnection, type LinearMode } from "../../lib/linear/index.ts";
import {
  commentIssue,
  createIssue,
  getCycles,
  getIssue,
  listIssues,
  listProjects,
  searchIssues,
  updateIssue,
} from "../../lib/linear/calls.ts";
import { linearProjectForChannel, linearProjectForPerson, linearRequester } from "../lib/linear.ts";
import { toolCtx } from "../../lib/agent/context.ts";
import { runGuarded } from "../../lib/rehearsal/guard.ts";

const issueFields = {
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

const listIssuesFields = {
  limit: z.number().int().min(1).max(250).optional().describe("Max issues to return (default 25, up to 250)"),
  state: z.string().optional().describe('Only issues in this workflow state, e.g. "Merged"'),
};
const projectChannel = z.string().describe("The Slack channel of the project whose Linear team to use, e.g. #doublepass");
const identifierField = z.string().describe("Issue identifier, e.g. ENG-123");

const createIssueFields = { title: z.string().describe("Issue title"), ...issueFields };
const updateIssueFields = { identifier: identifierField, title: z.string().optional().describe("New title"), ...issueFields };
const commentIssueFields = { identifier: identifierField, body: z.string().describe("Markdown comment body") };

const READ_ONLY_KEY_NOTE =
  "This project's Linear is connected with a read-only API key, so creating, updating and commenting don't work yet. Someone in the project has to run /linear-status in the project's channel and connect the Linear app; writing works right after that.";
const DM_WRITE_NOTE =
  "Name the project's channel. Works when that project's Linear is connected through the Linear app; with a read-only API key it returns the setup step (/linear-status) instead.";

interface LinearScope {
  dm: boolean;
  mode: LinearMode | null;
  inProject: <T>(channel: string | undefined, run: (projectId: string) => Promise<T>) => Promise<T | string>;
}

interface GuardCtx {
  kind: string;
  userId: string;
  sessionKey: string | null;
}

function linearTools(scope: LinearScope, { kind, userId, sessionKey }: GuardCtx): Record<string, any> {
  const where = scope.dm ? "the Linear team of the project whose channel you name" : "this project's connected Linear team";
  const readNote = [scope.dm ? "In a direct message, name the project's channel." : "", scope.mode === "key" ? READ_ONLY_KEY_NOTE : ""]
    .filter(Boolean)
    .join(" ");
  const writeNote = scope.dm ? DM_WRITE_NOTE : scope.mode === "key" ? `${READ_ONLY_KEY_NOTE} Until then this returns that setup step.` : "";
  const describe = (text: string, note: string) => (note ? `${text} ${note}` : text);
  const schema = <S extends z.ZodRawShape>(fields: S) => (scope.dm ? z.object({ channel: projectChannel, ...fields }) : z.object(fields));

  const tool = <I extends { channel?: string }>(
    name: string,
    description: string,
    fields: z.ZodRawShape,
    run: (projectId: string, input: I) => Promise<string>,
    keepPlaceholders = false,
  ) =>
    defineTool({
      description,
      inputSchema: schema(fields),
      execute: (input: I) =>
        runGuarded(kind, { toolName: name, userId, sessionKey, ...(keepPlaceholders ? { keepPlaceholders } : {}) }, input, (resolved) =>
          scope.inProject(resolved.channel, (projectId) => run(projectId, resolved)),
        ),
    });

  const tools: Record<string, any> = {
    "linear-list-issues": tool<{ channel?: string; limit?: number; state?: string }>(
      "linear-list-issues",
      describe(
        `Lists issues of ${where}, most recently updated first, each with its state and when it entered that state. Pass state to get only issues in one state, e.g. everything in Merged.`,
        readNote,
      ),
      listIssuesFields,
      (projectId, { limit, state }) => listIssues(projectId, limit, state),
    ),
    "linear-get-issue": tool<{ channel?: string; identifier: string }>(
      "linear-get-issue",
      describe(`Gets a single Linear issue of ${where} by its identifier (e.g. "ENG-123").`, readNote),
      { identifier: identifierField },
      (projectId, { identifier }) => getIssue(projectId, identifier),
    ),
    "linear-search-issues": tool<{ channel?: string; term: string; limit?: number }>(
      "linear-search-issues",
      describe(`Full-text searches the issues of ${where}.`, readNote),
      { term: z.string().describe("Search term"), limit: z.number().int().optional().describe("Max results to return (default 25)") },
      (projectId, { term, limit }) => searchIssues(projectId, term, limit),
    ),
    "linear-create-issue": tool<z.infer<z.ZodObject<typeof createIssueFields>> & { channel?: string }>(
      "linear-create-issue",
      describe(
        `Creates an issue in ${where}. Confirm the title and details with the user first unless they were explicit. Returns the new issue's identifier and URL.`,
        writeNote,
      ),
      createIssueFields,
      async (projectId, { channel: _channel, ...fields }) => createIssue(projectId, fields, await linearRequester(userId)),
      true,
    ),
    "linear-update-issue": tool<z.infer<z.ZodObject<typeof updateIssueFields>> & { channel?: string }>(
      "linear-update-issue",
      describe(
        `Updates an issue in ${where}: title, description, priority, assignee, state, project, parent, due date, estimate or cycle. Labels are added, not replaced.`,
        writeNote,
      ),
      updateIssueFields,
      async (projectId, { channel: _channel, identifier, ...fields }) =>
        updateIssue(projectId, identifier, fields, await linearRequester(userId)),
      true,
    ),
    "linear-comment-issue": tool<{ channel?: string; identifier: string; body: string }>(
      "linear-comment-issue",
      describe(`Adds a comment to an issue in ${where}.`, writeNote),
      commentIssueFields,
      async (projectId, { identifier, body }) => commentIssue(projectId, identifier, body, await linearRequester(userId)),
      true,
    ),
  };
  if (!scope.dm) {
    tools["linear-list-projects"] = tool(
      "linear-list-projects",
      describe("Lists Linear projects owned by this project's connected team.", readNote),
      {},
      (projectId) => listProjects(projectId),
    );
    tools["linear-list-cycles"] = tool<{ channel?: string; limit?: number }>(
      "linear-list-cycles",
      describe("Lists recent cycles for this project's connected Linear team.", readNote),
      { limit: z.number().int().optional().describe("Max cycles to return (default 10)") },
      (projectId, { limit }) => getCycles(projectId, limit),
    );
  }
  return tools;
}

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const { userId, msgCtx, sessionKey, kind } = toolCtx(ctx);
      const entries: Record<string, any> = {};

      if (userId) {
        for (const remote of await listUserMcpTools(userId, await channelAudience(msgCtx.channel))) {
          const toolName = remote.name;
          const providerId = remote.providerId;
          const remoteName = remote.remoteName;
          const destinationHost = remote.host;
          entries[toolName] = defineTool({
            description: remote.description,
            inputSchema: remote.inputSchema as any,
            execute: (input: unknown) =>
              runGuarded(kind, { toolName, userId, sessionKey, destinationHost }, input, (resolved) =>
                callUserMcpTool(userId, providerId, remoteName, resolved),
              ),
          });
        }
      }

      const projectId = await linearProjectForChannel(msgCtx.channel);
      const linear = projectId ? await getConnection(projectId) : null;
      const guard = { kind, userId, sessionKey };
      if (projectId && linear) {
        Object.assign(entries, linearTools({ dm: false, mode: linear.mode, inProject: (_channel, run) => run(projectId) }, guard));
      } else if (!projectId && msgCtx.channel?.startsWith("D")) {
        const inProject = async <T>(channel: string | undefined, run: (id: string) => Promise<T>): Promise<T | string> => {
          const found = await linearProjectForPerson(channel ?? "", userId);
          return found.ok ? run(found.projectId) : found.message;
        };
        Object.assign(entries, linearTools({ dm: true, mode: null, inProject }, guard));
      }

      return Object.keys(entries).length > 0 ? entries : null;
    },
  },
});
