import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getIssue: vi.fn(),
  teamContext: vi.fn(),
  updateIssue: vi.fn(),
}));

vi.mock("../../lib/linear/index.ts", async (original) => ({
  ...(await original<object>()),
  getConnection: async () => ({ mode: "app", linearTeamId: "team-1", linearTeamName: "onside" }),
  authorization: async () => ({ ok: true, value: "Bearer token" }),
}));
vi.mock("../../lib/linear/client.ts", async (original) => ({
  ...(await original<object>()),
  getIssue: mocks.getIssue,
  teamContext: mocks.teamContext,
  updateIssue: mocks.updateIssue,
}));

const { updateIssue } = await import("../../lib/linear/calls.ts");

const DONE_SINCE = "2026-11-24T09:48:00Z";
const issue = {
  id: "issue-151",
  identifier: "ONS-151",
  title: "Fix login",
  priority: 2,
  state: { id: "state-done", name: "Done" },
  assignee: { id: "member-1", name: "Natalia" },
  labels: { nodes: [{ id: "label-bug" }] },
  url: "https://linear.app/ons-151",
  history: { nodes: [{ createdAt: DONE_SINCE, toState: { name: "Done" } }] },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getIssue.mockResolvedValue({ ok: true, value: issue });
  mocks.teamContext.mockResolvedValue({
    ok: true,
    value: {
      states: [
        { id: "state-done", name: "Done" },
        { id: "state-progress", name: "In Progress" },
      ],
      members: [{ id: "member-1", name: "Natalia", displayName: "natalia", email: "natalia@example.com" }],
      labels: [{ id: "label-bug", name: "Bug" }],
      projects: [],
      cycles: [],
    },
  });
  mocks.updateIssue.mockImplementation(async (_auth: string, _id: string, input: Record<string, unknown>) => ({
    ok: true,
    value: { ...issue, state: input.stateId === "state-progress" ? { id: "state-progress", name: "In Progress" } : issue.state },
  }));
});

describe("updateIssue", () => {
  it("does not report a change when the issue already has the requested state", async () => {
    const result = await updateIssue("dp", "ONS-151", { state: "Done" }, null);
    expect(result).toMatch(/^ONS-151 was already in Done since .+; nothing changed\.$/);
    expect(result).not.toContain("Zaktualizowano");
    expect(mocks.updateIssue).not.toHaveBeenCalled();
    expect(mocks.getIssue).toHaveBeenCalledTimes(1);
  });

  it("says nothing changed when every requested field already matches", async () => {
    const result = await updateIssue("dp", "ONS-151", { assignee: "Natalia", labels: ["Bug"], priority: 2 }, null);
    expect(result).toBe("ONS-151 was already set to the requested priority, assignee, label; nothing changed.");
    expect(mocks.updateIssue).not.toHaveBeenCalled();
  });

  it("sends only the fields that differ and names the ones left as they were", async () => {
    const result = await updateIssue("dp", "ONS-151", { state: "In Progress", assignee: "Natalia" }, null);
    expect(mocks.updateIssue).toHaveBeenCalledWith("Bearer token", "issue-151", { stateId: "state-progress" });
    expect(result).toContain("Zaktualizowano ONS-151 [In Progress]");
    expect(result).toContain("(ONS-151 was already set to the requested assignee, left as it was)");
  });

  it("updates normally when everything differs", async () => {
    const result = await updateIssue("dp", "ONS-151", { state: "In Progress", title: "Fix signup" }, null);
    expect(mocks.updateIssue).toHaveBeenCalledWith("Bearer token", "issue-151", { stateId: "state-progress", title: "Fix signup" });
    expect(result).not.toContain("already");
  });
});
