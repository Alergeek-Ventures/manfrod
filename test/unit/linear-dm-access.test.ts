import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveChannel: vi.fn(),
  channelMembers: vi.fn(),
  getActiveMapping: vi.fn(),
  getConnection: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock("../../lib/slack/api.ts", async (original) => ({
  ...(await original<object>()),
  resolveChannel: mocks.resolveChannel,
  channelMembers: mocks.channelMembers,
}));
vi.mock("../../lib/memory/access.ts", async (original) => ({ ...(await original<object>()), getActiveMapping: mocks.getActiveMapping }));
vi.mock("../../lib/linear/index.ts", async (original) => ({ ...(await original<object>()), getConnection: mocks.getConnection }));
vi.mock("../../lib/accounts.ts", async (original) => ({ ...(await original<object>()), getUser: mocks.getUser }));

const { linearProjectForPerson } = await import("../../agent/lib/linear.ts");

describe("linearProjectForPerson", () => {
  beforeEach(() => {
    mocks.resolveChannel.mockResolvedValue({ ok: true, id: "C1" });
    mocks.getActiveMapping.mockResolvedValue({ projectId: "p1" });
    mocks.getConnection.mockResolvedValue({ linearTeamId: "t1" });
    mocks.getUser.mockResolvedValue({ slackId: "U1", name: "Mateusz" });
    mocks.channelMembers.mockResolvedValue(["U1"]);
  });

  it("gives the project of a channel the person is in", async () => {
    expect(await linearProjectForPerson("#doublepass", "user-1")).toEqual({ ok: true, projectId: "p1" });
  });

  it("refuses a channel the person is not in", async () => {
    mocks.channelMembers.mockResolvedValue(["U2"]);
    const found = await linearProjectForPerson("#doublepass", "user-1");
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.message).toContain("not a member of <#C1>");
  });

  it("refuses a channel without a Linear project", async () => {
    mocks.getConnection.mockResolvedValue(null);
    const found = await linearProjectForPerson("#random", "user-1");
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.message).toContain("no project connected to Linear");
  });
});
