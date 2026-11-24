import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveMapping: vi.fn(),
  getConnection: vi.fn(),
  resolveChannel: vi.fn(),
  channelMembers: vi.fn(),
  getUser: vi.fn(),
  createIssue: vi.fn(),
  getIssue: vi.fn(),
  createComment: vi.fn(),
}));

vi.mock("../../lib/mcp/tools.ts", () => ({ listUserMcpTools: async () => [], callUserMcpTool: async () => "" }));
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
vi.mock("../../lib/linear/client.ts", async (original) => ({
  ...(await original<object>()),
  createIssue: mocks.createIssue,
  getIssue: mocks.getIssue,
  createComment: mocks.createComment,
}));
vi.mock("../../lib/slack/api.ts", async (original) => ({
  ...(await original<object>()),
  resolveChannel: mocks.resolveChannel,
  channelMembers: mocks.channelMembers,
}));
vi.mock("../../lib/accounts.ts", async (original) => ({ ...(await original<object>()), getUser: mocks.getUser }));

const integrations = (await import("../../agent/tools/integrations.ts")).default as unknown as {
  events: Record<string, (event: unknown, ctx: unknown) => Promise<Record<string, Tool> | null>>;
};
const { READ_ONLY_KEY_RESULT } = await import("../../lib/linear/calls.ts");

type Tool = {
  description: string;
  inputSchema: { shape: Record<string, unknown> };
  execute: (input: unknown, ctx: unknown) => Promise<unknown>;
};

const WRITE_TOOLS = ["linear-create-issue", "linear-update-issue", "linear-comment-issue"];

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

const connected = (mode: "app" | "key") => ({ mode, linearTeamId: "team-1", linearTeamName: "Double Pass" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getActiveMapping.mockImplementation(async (channel: string) => (channel === "C1" ? { projectId: "p1" } : null));
  mocks.getConnection.mockResolvedValue(connected("app"));
  mocks.resolveChannel.mockResolvedValue({ ok: true, id: "C1" });
  mocks.channelMembers.mockResolvedValue(["U1"]);
  mocks.getUser.mockResolvedValue({ slackId: "U1", name: "Mateusz", email: "mateusz@example.com", image: null });
  mocks.createIssue.mockResolvedValue({ ok: true, value: { identifier: "DP-1", title: "Fix login", url: "https://linear.app/dp-1" } });
  mocks.getIssue.mockResolvedValue({ ok: true, value: { id: "issue-1", identifier: "DP-1" } });
  mocks.createComment.mockResolvedValue({ ok: true, value: { url: "https://linear.app/dp-1#comment" } });
});

describe("Linear tools in a project channel", () => {
  it("write through the Linear app", async () => {
    const tools = await toolsIn("C1");
    for (const name of WRITE_TOOLS) expect(tools[name]?.description).not.toContain("read-only");
    expect(await tools["linear-create-issue"].execute({ title: "Fix login" }, {})).toContain("DP-1");
    expect(mocks.createIssue).toHaveBeenCalledWith("Bearer token", expect.objectContaining({ teamId: "team-1", title: "Fix login" }));
  });

  it("with a read-only key still offer writes, which point to /linear-status", async () => {
    mocks.getConnection.mockResolvedValue(connected("key"));
    const tools = await toolsIn("C1");
    expect(tools["linear-list-issues"].description).toContain("/linear-status");
    for (const name of WRITE_TOOLS) expect(tools[name].description).toContain("/linear-status");
    expect(await tools["linear-create-issue"].execute({ title: "Fix login" }, {})).toBe(READ_ONLY_KEY_RESULT);
    expect(await tools["linear-comment-issue"].execute({ identifier: "DP-1", body: "hi" }, {})).toBe(READ_ONLY_KEY_RESULT);
    expect(READ_ONLY_KEY_RESULT).toContain("/linear-status");
    expect(mocks.createIssue).not.toHaveBeenCalled();
    expect(mocks.createComment).not.toHaveBeenCalled();
  });

  it("are absent when the project has no Linear connection", async () => {
    mocks.getConnection.mockResolvedValue(null);
    expect(Object.keys(await toolsIn("C1")).filter((name) => name.startsWith("linear-"))).toEqual([]);
  });
});

describe("Linear tools in a DM", () => {
  it("create, update and comment in a project the person is in, connected through the app", async () => {
    const tools = await toolsIn("D1");
    for (const name of WRITE_TOOLS) expect(tools[name].inputSchema.shape).toHaveProperty("channel");
    expect(tools["linear-list-projects"]).toBeUndefined();
    expect(await tools["linear-create-issue"].execute({ channel: "#doublepass", title: "Fix login" }, {})).toContain("DP-1");
    expect(mocks.createIssue).toHaveBeenCalledWith(
      "Bearer token",
      expect.objectContaining({ teamId: "team-1", title: "Fix login", createAsUser: "Mateusz" }),
    );
    expect(mocks.createIssue.mock.calls[0][1]).not.toHaveProperty("channel");
    expect(await tools["linear-comment-issue"].execute({ channel: "#doublepass", identifier: "DP-1", body: "hi" }, {})).toContain("DP-1");
    expect(mocks.getConnection).toHaveBeenCalledWith("p1");
  });

  it("point to /linear-status when the project uses a read-only key", async () => {
    mocks.getConnection.mockResolvedValue(connected("key"));
    const tools = await toolsIn("D1");
    expect(await tools["linear-create-issue"].execute({ channel: "#tenbps", title: "Fix login" }, {})).toBe(READ_ONLY_KEY_RESULT);
    expect(await tools["linear-update-issue"].execute({ channel: "#tenbps", identifier: "DP-1", state: "Done" }, {})).toBe(
      READ_ONLY_KEY_RESULT,
    );
    expect(mocks.createIssue).not.toHaveBeenCalled();
  });

  it("refuse a project channel the person is not in", async () => {
    mocks.channelMembers.mockResolvedValue(["U2"]);
    const tools = await toolsIn("D1");
    for (const [name, input] of [
      ["linear-create-issue", { channel: "#doublepass", title: "Fix login" }],
      ["linear-comment-issue", { channel: "#doublepass", identifier: "DP-1", body: "hi" }],
      ["linear-update-issue", { channel: "#doublepass", identifier: "DP-1", title: "x" }],
      ["linear-list-issues", { channel: "#doublepass" }],
    ] as const) {
      expect(await tools[name].execute(input, {}), name).toContain("not a member of <#C1>");
    }
    expect(mocks.createIssue).not.toHaveBeenCalled();
    expect(mocks.getIssue).not.toHaveBeenCalled();
    expect(mocks.createComment).not.toHaveBeenCalled();
  });

  it("refuse an unknown channel and a channel without Linear", async () => {
    const tools = await toolsIn("D1");
    mocks.resolveChannel.mockResolvedValueOnce({ ok: false });
    expect(await tools["linear-create-issue"].execute({ channel: "#nope", title: "x" }, {})).toContain("Channel not found");
    mocks.getConnection.mockResolvedValue(null);
    expect(await tools["linear-create-issue"].execute({ channel: "#random", title: "x" }, {})).toContain("no project connected to Linear");
    expect(mocks.createIssue).not.toHaveBeenCalled();
  });

  it("refuse someone Manfrod doesn't know", async () => {
    mocks.getUser.mockResolvedValue(null);
    const tools = await toolsIn("D1");
    expect(await tools["linear-create-issue"].execute({ channel: "#doublepass", title: "x" }, {})).toContain("I don't know who you are");
    expect(mocks.createIssue).not.toHaveBeenCalled();
  });
});
