import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveMapping: vi.fn(),
  getConnection: vi.fn(),
  providersForUser: vi.fn(),
  listConnections: vi.fn(),
}));

vi.mock("../../lib/memory/access.ts", async (original) => ({
  ...(await original<object>()),
  getActiveMapping: mocks.getActiveMapping,
  channelAudience: async (channel: string | null) =>
    !channel || channel.startsWith("D") ? "dm" : (await mocks.getActiveMapping(channel))?.clientId ? "external" : "internal",
}));
vi.mock("../../lib/linear/index.ts", async (original) => ({ ...(await original<object>()), getConnection: mocks.getConnection }));
vi.mock("../../lib/mcp/index.ts", async (original) => ({
  ...(await original<object>()),
  providersForUser: mocks.providersForUser,
  listConnections: mocks.listConnections,
}));

const { integrationsPrompt, integrationsSection } = await import("../../lib/agent/integrations.ts");
const { channelLinearScope, linearToolNames } = await import("../../lib/linear/scope.ts");

const USER = "0b2f6c3e-5b1a-4c55-9a52-3f0d3c1e9a10";
const provider = (id: string, name: string, availability: string[] = ["dm", "internal", "external"]) => ({
  id,
  name,
  mcpUrl: `https://${id}.example.com/mcp`,
  mock: false,
  logoUrl: null,
  custom: true,
  scope: null,
  authHeader: null,
  availability,
});
const connection = (status: string, notifiedExpiredAt: Date | null = null) => ({ status, notifiedExpiredAt });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getActiveMapping.mockImplementation(async (channel: string) =>
    channel === "C0B2W9W9KTQ"
      ? { projectId: "dp", clientId: null, project: { name: "Double Pass" } }
      : channel === "CKEY"
        ? { projectId: "tenbps", clientId: null, project: { name: "10bps" } }
        : channel === "CNOLINEAR"
          ? { projectId: "blank", clientId: null, project: { name: "Blank" } }
          : null,
  );
  mocks.getConnection.mockImplementation(async (projectId: string) =>
    projectId === "dp"
      ? { mode: "app", linearTeamName: "onside" }
      : projectId === "tenbps"
        ? { mode: "key", linearTeamName: "10BPS" }
        : null,
  );
  mocks.providersForUser.mockResolvedValue([]);
  mocks.listConnections.mockResolvedValue(new Map());
});

describe("integrations section", () => {
  it("lists read and write Linear tools in a project channel connected through the app", async () => {
    const prompt = await integrationsPrompt(USER, "C0B2W9W9KTQ");
    expect(prompt).toContain("[Your integrations in this conversation]");
    expect(prompt).toContain("overrides anything said earlier in this thread");
    expect(prompt).toContain("project Double Pass (Linear team onside) is connected through the Linear app");
    expect(prompt).toContain("linear-update-issue");
    expect(prompt).toContain("linear-list-cycles");
  });

  it("says a read-only key reads but returns the setup step for writes", async () => {
    const prompt = await integrationsPrompt(USER, "CKEY");
    expect(prompt).toContain("project 10bps (Linear team 10BPS) is connected with a read-only API key");
    expect(prompt).toContain(
      "Reading works (linear-list-issues, linear-get-issue, linear-search-issues, linear-list-projects, linear-list-cycles)",
    );
    expect(prompt).toContain("linear-create-issue, linear-update-issue, linear-comment-issue return the setup step");
    expect(prompt).toContain("/linear-status");
  });

  it("says there is no Linear in a channel whose project has none and in a channel without a project", async () => {
    expect(await integrationsPrompt(USER, "CNOLINEAR")).toContain(
      "project Blank has no Linear connected, so there are no linear-* tools here",
    );
    expect(await integrationsPrompt(USER, "CRANDOM")).toContain("this channel belongs to no project, so there are no linear-* tools here");
  });

  it("asks for the project's channel in a DM and leaves out project-only tools", async () => {
    const prompt = await integrationsPrompt(USER, "D123");
    expect(prompt).toContain("pass that channel as `channel` to linear-list-issues");
    expect(prompt).toContain("linear-update-issue");
    expect(prompt).not.toContain("linear-list-cycles");
  });

  it("names connected MCP servers, ones awaiting reconnect and ones turned off for this audience", async () => {
    mocks.providersForUser.mockResolvedValue([
      provider("firmowid", "Firmowid"),
      provider("t3", "T3 Code", ["dm", "internal"]),
      provider("granola", "Granola", ["dm"]),
      provider("gmail", "Gmail"),
      provider("coolify", "AV Coolify"),
    ]);
    mocks.listConnections.mockResolvedValue(
      new Map([
        ["firmowid", connection("connected")],
        ["t3", connection("expired")],
        ["granola", connection("connected")],
        ["gmail", connection("expired", new Date("2026-11-20T10:00:00Z"))],
      ]),
    );
    const prompt = await integrationsPrompt(USER, "C0B2W9W9KTQ");
    expect(prompt).toContain("- MCP servers this person connected: Firmowid, T3 Code.");
    expect(prompt).toContain("Awaiting reconnect, so their tools are unavailable: Gmail;");
    expect(prompt).toContain("/integrations");
    expect(prompt).toContain("turned off for this kind of conversation: Granola.");
    expect(prompt).not.toContain("AV Coolify");
    expect(mocks.listConnections).toHaveBeenCalledWith(USER);
  });

  it("says when the person has no MCP server connected", async () => {
    mocks.providersForUser.mockResolvedValue([provider("firmowid", "Firmowid")]);
    expect(await integrationsPrompt(USER, "D123")).toContain("this person has none connected");
  });

  it("leaves MCP out without a user and adds nothing without a user or a channel", async () => {
    const prompt = await integrationsPrompt("", "C0B2W9W9KTQ");
    expect(prompt).toContain("Linear team onside");
    expect(prompt).not.toContain("MCP");
    expect(mocks.providersForUser).not.toHaveBeenCalled();
    expect(await integrationsPrompt("", null)).toBe("");
  });

  it("adds nothing when a lookup fails", async () => {
    mocks.getConnection.mockRejectedValue(new Error("db down"));
    expect(await integrationsPrompt(USER, "C0B2W9W9KTQ")).toBe("");
  });

  it("decides the same Linear tools the dynamic tools register", async () => {
    expect(linearToolNames(await channelLinearScope("C0B2W9W9KTQ"))).toHaveLength(8);
    expect(linearToolNames(await channelLinearScope("D1"))).not.toContain("linear-list-projects");
    expect(linearToolNames(await channelLinearScope("CNOLINEAR"))).toEqual([]);
    expect(integrationsSection({ linear: null, mcp: null }, "https://app")).toBe("");
  });
});
