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
import { dynamicToolSet } from "../lib/dynamic-tools.ts";

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
const DM_READ_NOTE = "In a direct message, name the project's channel.";
const DM_WRITE_NOTE =
  "Name the project's channel. Works when that project's Linear is connected through the Linear app; with a read-only API key it returns the setup step (/linear-status) instead.";

type LinearInput = Record<string, any>;

interface LinearSpec {
  summary: (where: string) => string;
  fields: z.ZodRawShape;
  write?: true;
  projectOnly?: true;
  run: (projectId: string, input: LinearInput, userId: string) => Promise<string>;
}

const LINEAR_TOOLS: Record<string, LinearSpec> = {
  "linear-list-issues": {
    summary: (where) =>
      `Lists issues of ${where}, most recently updated first, each with its state and when it entered that state. Pass state to get only issues in one state, e.g. everything in Merged.`,
    fields: listIssuesFields,
    run: (projectId, { limit, state }) => listIssues(projectId, limit, state),
  },
  "linear-get-issue": {
    summary: (where) => `Gets a single Linear issue of ${where} by its identifier (e.g. "ENG-123").`,
    fields: { identifier: identifierField },
    run: (projectId, { identifier }) => getIssue(projectId, identifier),
  },
  "linear-search-issues": {
    summary: (where) => `Full-text searches the issues of ${where}.`,
    fields: { term: z.string().describe("Search term"), limit: z.number().int().optional().describe("Max results to return (default 25)") },
    run: (projectId, { term, limit }) => searchIssues(projectId, term, limit),
  },
  "linear-list-projects": {
    summary: () => "Lists Linear projects owned by this project's connected team.",
    fields: {},
    projectOnly: true,
    run: (projectId) => listProjects(projectId),
  },
  "linear-list-cycles": {
    summary: () => "Lists recent cycles for this project's connected Linear team.",
    fields: { limit: z.number().int().optional().describe("Max cycles to return (default 10)") },
    projectOnly: true,
    run: (projectId, { limit }) => getCycles(projectId, limit),
  },
  "linear-create-issue": {
    summary: (where) =>
      `Creates an issue in ${where}. Confirm the title and details with the user first unless they were explicit. Returns the new issue's identifier and URL.`,
    fields: createIssueFields,
    write: true,
    run: async (projectId, { channel: _channel, ...fields }, userId) =>
      createIssue(projectId, fields as z.infer<z.ZodObject<typeof createIssueFields>>, await linearRequester(userId)),
  },
  "linear-update-issue": {
    summary: (where) =>
      `Updates an issue in ${where}: title, description, priority, assignee, state, project, parent, due date, estimate or cycle. Labels are added, not replaced.`,
    fields: updateIssueFields,
    write: true,
    run: async (projectId, { channel: _channel, identifier, ...fields }, userId) =>
      updateIssue(projectId, identifier, fields, await linearRequester(userId)),
  },
  "linear-comment-issue": {
    summary: (where) => `Adds a comment to an issue in ${where}.`,
    fields: commentIssueFields,
    write: true,
    run: async (projectId, { identifier, body }, userId) => commentIssue(projectId, identifier, body, await linearRequester(userId)),
  },
};

function linearDescription(name: string, dm: boolean, mode: LinearMode | null): string {
  const spec = LINEAR_TOOLS[name];
  const where = dm ? "the Linear team of the project whose channel you name" : "this project's connected Linear team";
  const writeNote = dm ? DM_WRITE_NOTE : mode === "key" ? `${READ_ONLY_KEY_NOTE} Until then this returns that setup step.` : "";
  const readNote = [dm ? DM_READ_NOTE : "", mode === "key" ? READ_ONLY_KEY_NOTE : ""].filter(Boolean).join(" ");
  const note = spec.write ? writeNote : readNote;
  const summary = spec.summary(where);
  return note ? `${summary} ${note}` : summary;
}

function linearInputSchema(name: string, dm: boolean) {
  const { fields } = LINEAR_TOOLS[name];
  return dm ? z.object({ channel: projectChannel, ...fields }) : z.object(fields);
}

interface LinearCall {
  kind: string;
  userId: string;
  sessionKey: string | null;
  projectId: string | null;
}

function runLinearTool(name: string, input: LinearInput, { kind, userId, sessionKey, projectId }: LinearCall) {
  const spec = LINEAR_TOOLS[name];
  const use = { toolName: name, userId, sessionKey, ...(spec.write ? { keepPlaceholders: true } : {}) };
  return runGuarded(kind, use, input, async (resolved) => {
    if (projectId) return spec.run(projectId, resolved, userId);
    const found = await linearProjectForPerson(resolved.channel ?? "", userId);
    return found.ok ? spec.run(found.projectId, resolved, userId) : found.message;
  });
}

function linearTools(projectId: string | null, mode: LinearMode | null, kind: string, userId: string, sessionKey: string | null) {
  const dm = projectId === null;
  const tools: Record<string, any> = {};
  for (const name of Object.keys(LINEAR_TOOLS)) {
    if (dm && LINEAR_TOOLS[name].projectOnly) continue;
    tools[name] = defineTool({
      description: linearDescription(name, dm, mode),
      inputSchema: linearInputSchema(name, dm),
      execute: (input: LinearInput) => runLinearTool(name, input, { kind, userId, sessionKey, projectId }),
    });
  }
  return tools;
}

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const { userId, msgCtx, sessionKey, kind } = toolCtx(ctx);

      const mcp = await dynamicToolSet("MCP", async () => {
        const tools: Record<string, any> = {};
        if (!userId) return tools;
        for (const remote of await listUserMcpTools(userId, await channelAudience(msgCtx.channel))) {
          const toolName = remote.name;
          const providerId = remote.providerId;
          const remoteName = remote.remoteName;
          const destinationHost = remote.host;
          tools[toolName] = defineTool({
            description: remote.description,
            inputSchema: remote.inputSchema as any,
            execute: (input: unknown) =>
              runGuarded(kind, { toolName, userId, sessionKey, destinationHost }, input, (resolved) =>
                callUserMcpTool(userId, providerId, remoteName, resolved),
              ),
          });
        }
        return tools;
      });

      const linear = await dynamicToolSet("Linear", async () => {
        const projectId = await linearProjectForChannel(msgCtx.channel);
        const connection = projectId ? await getConnection(projectId) : null;
        if (projectId && connection) return linearTools(projectId, connection.mode, kind, userId, sessionKey);
        if (!projectId && msgCtx.channel?.startsWith("D")) return linearTools(null, null, kind, userId, sessionKey);
        return {};
      });

      const entries = { ...mcp, ...linear };
      return Object.keys(entries).length > 0 ? entries : null;
    },
  },
});
