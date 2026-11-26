import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineDurableCallback, defineTool } from "eve/tools";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  listUserMcpTools: vi.fn(),
  callUserMcpTool: vi.fn(),
  getActiveMapping: vi.fn(),
  getConnection: vi.fn(),
  resolveChannel: vi.fn(),
  channelMembers: vi.fn(),
  getUser: vi.fn(),
  createIssue: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../../lib/log.ts", () => ({
  logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mocks.logError }),
  inspect: String,
}));
vi.mock("../../lib/mcp/tools.ts", () => ({ listUserMcpTools: mocks.listUserMcpTools, callUserMcpTool: mocks.callUserMcpTool }));
vi.mock("../../lib/secrets.ts", () => ({
  runWithSecrets: (_use: unknown, input: unknown, run: (resolved: unknown) => Promise<unknown>) => run(input),
}));
vi.mock("../../lib/memory/access.ts", async (original) => ({
  ...(await original<object>()),
  channelAudience: async () => "internal",
  getActiveMapping: mocks.getActiveMapping,
}));
vi.mock("../../lib/linear/index.ts", async (original) => ({
  ...(await original<object>()),
  getConnection: mocks.getConnection,
  authorization: async () => ({ ok: true, value: "Bearer token" }),
}));
vi.mock("../../lib/linear/client.ts", async (original) => ({ ...(await original<object>()), createIssue: mocks.createIssue }));
vi.mock("../../lib/slack/api.ts", async (original) => ({
  ...(await original<object>()),
  resolveChannel: mocks.resolveChannel,
  channelMembers: mocks.channelMembers,
}));
vi.mock("../../lib/accounts.ts", async (original) => ({ ...(await original<object>()), getUser: mocks.getUser }));

const eveFile = (path: string) => new URL(`../../node_modules/eve/dist/src/${path}`, import.meta.url).href;
const { validateDurableDynamicToolCallbacks } = await import(eveFile("context/dynamic-tool-lifecycle.js"));
const { serializeInputSchema } = await import(eveFile("tools/schema.js"));
const { readDurableDynamicToolCallbacks } = await import(eveFile("tools/durable-callbacks.js"));

const integrations = (await import("../../agent/tools/integrations.ts")).default as unknown as {
  events: Record<string, (event: unknown, ctx: unknown) => Promise<Record<string, object> | null>>;
};
const { dynamicToolSet } = await import("../../agent/lib/dynamic-tools.ts");

type Stamped = { callback: (closure: unknown, ...args: unknown[]) => Promise<unknown>; closure: unknown };

const MCP_TOOL = "ca7640b96__t3_thread_list";

const toolsIn = async (channelId: string) =>
  (await integrations.events["turn.started"](
    {},
    {
      session: {
        id: "session-1",
        auth: { current: { principalId: "user-1", attributes: { userId: "user-1", kind: "slack", channelId } }, initiator: null },
      },
    },
  )) ?? {};

function registerAsEve(tools: Record<string, object>) {
  for (const [name, tool] of Object.entries(tools)) {
    expect(readDurableDynamicToolCallbacks(tool)?.execute, `${name} went through eve's transform`).toBeDefined();
    validateDurableDynamicToolCallbacks(name, tool, {
      sessionId: "session-1",
      scope: "turn",
      resolverSlug: "integrations",
      entryKey: name,
      name,
    });
    serializeInputSchema((tool as { inputSchema: unknown }).inputSchema);
  }
}

function durableExecute(tool: object, input: unknown) {
  const stamped = readDurableDynamicToolCallbacks(tool).execute as Stamped;
  return stamped.callback(JSON.parse(JSON.stringify(stamped.closure)), input, {});
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listUserMcpTools.mockResolvedValue([
    {
      name: MCP_TOOL,
      description: "Lists T3 Code threads",
      inputSchema: { type: "object", properties: { limit: { type: "number" } } },
      providerId: "provider-1",
      remoteName: "t3_thread_list",
      host: "t3.example.com",
    },
  ]);
  mocks.callUserMcpTool.mockResolvedValue("threads");
  mocks.getActiveMapping.mockImplementation(async (channel: string) => (channel === "C1" ? { projectId: "p1" } : null));
  mocks.getConnection.mockResolvedValue({ mode: "app", linearTeamId: "team-1", linearTeamName: "Double Pass" });
  mocks.resolveChannel.mockResolvedValue({ ok: true, id: "C1" });
  mocks.channelMembers.mockResolvedValue(["U1"]);
  mocks.getUser.mockResolvedValue({ slackId: "U1", name: "Mateusz", email: "mateusz@example.com", image: null });
  mocks.createIssue.mockResolvedValue({ ok: true, value: { identifier: "DP-1", title: "Fix login", url: "https://linear.app/dp-1" } });
});

describe("integrations dynamic tools as eve registers them", () => {
  it("register MCP and Linear tools in a project channel connected through the app", async () => {
    const tools = await toolsIn("C1");
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining([MCP_TOOL, "linear-list-issues", "linear-create-issue", "linear-list-cycles"]),
    );
    registerAsEve(tools);
  });

  it("register them with a read-only key", async () => {
    mocks.getConnection.mockResolvedValue({ mode: "key", linearTeamId: "team-1", linearTeamName: "Double Pass" });
    const tools = await toolsIn("C1");
    expect(tools["linear-create-issue"]).toBeDefined();
    registerAsEve(tools);
  });

  it("register MCP and Linear tools in a DM", async () => {
    const tools = await toolsIn("D1");
    expect(Object.keys(tools)).toEqual(expect.arrayContaining([MCP_TOOL, "linear-list-issues", "linear-create-issue"]));
    expect(tools["linear-list-cycles"]).toBeUndefined();
    registerAsEve(tools);
  });

  it("register MCP tools in a channel without Linear", async () => {
    const tools = await toolsIn("C2");
    expect(Object.keys(tools)).toEqual([MCP_TOOL]);
    registerAsEve(tools);
  });

  it("run from their durable closures", async () => {
    const channel = await toolsIn("C1");
    expect(await durableExecute(channel["linear-create-issue"], { title: "Fix login" })).toContain("DP-1");
    expect(mocks.createIssue).toHaveBeenLastCalledWith("Bearer token", expect.objectContaining({ teamId: "team-1", title: "Fix login" }));

    const dm = await toolsIn("D1");
    expect(await durableExecute(dm["linear-create-issue"], { channel: "#doublepass", title: "Fix signup" })).toContain("DP-1");
    expect(mocks.createIssue).toHaveBeenLastCalledWith("Bearer token", expect.objectContaining({ title: "Fix signup" }));
    expect(mocks.createIssue.mock.lastCall?.[1]).not.toHaveProperty("channel");

    expect(await durableExecute(dm[MCP_TOOL], { limit: 5 })).toBe("threads");
    expect(mocks.callUserMcpTool).toHaveBeenCalledWith("user-1", "provider-1", "t3_thread_list", { limit: 5 });
  });

  it("keep Linear tools when listing MCP tools fails, and log it", async () => {
    mocks.listUserMcpTools.mockRejectedValue(new Error("provider down"));
    const tools = await toolsIn("C1");
    expect(tools["linear-list-issues"]).toBeDefined();
    expect(tools[MCP_TOOL]).toBeUndefined();
    expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining("provider down"), expect.any(Error));
  });

  it("keep MCP tools when the Linear lookup fails, and log it", async () => {
    mocks.getConnection.mockRejectedValue(new Error("db down"));
    const tools = await toolsIn("C1");
    expect(Object.keys(tools)).toEqual([MCP_TOOL]);
    expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining("db down"), expect.any(Error));
  });
});

describe("dynamicToolSet", () => {
  const good = () =>
    defineTool({
      description: "Good",
      inputSchema: z.object({}),
      execute: defineDurableCallback({ callback: async (closure: { id: string }) => closure.id, closure: { id: "x" } }),
    });

  it("drops a tool eve would reject and keeps the rest", async () => {
    const bad = defineTool({
      description: "Bad",
      inputSchema: z.object({}),
      execute: defineDurableCallback({ callback: async () => "", closure: { run: () => "" } as unknown as Record<string, never> }),
    });
    const tools = await dynamicToolSet("Test", async () => ({ good: good(), bad, "bad name!": good() }));
    expect(Object.keys(tools)).toEqual(["good"]);
    expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining("Dropped dynamic tool bad from Test"));
    expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining("Dropped dynamic tool bad name! from Test"));
    expect(() =>
      validateDurableDynamicToolCallbacks("bad", bad, { sessionId: "s", scope: "turn", resolverSlug: "r", entryKey: "bad", name: "bad" }),
    ).toThrow(/non-serializable/);
  });
});
