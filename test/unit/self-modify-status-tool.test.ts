import { beforeEach, describe, expect, it, vi } from "vitest";

const accounts = vi.hoisted(() => ({ role: "admin" }));
const status = vi.hoisted(() => ({ autoMergeStatus: vi.fn(async (number: number) => `#${number}: qualifies, waiting for CI`) }));
const pulls = vi.hoisted(() => ({
  openProposals: vi.fn(async () => [{ number: 7 }, { number: 9 }]),
}));

vi.mock("../../lib/accounts.ts", () => ({
  getUser: async (id: string) => ({ id, slackId: "UADMIN", name: "Kamil", role: accounts.role }),
  isAdmin: (user: { role: string }) => user.role === "admin",
}));
vi.mock("../../lib/self-modify-merge/status.ts", () => status);
vi.mock("../../lib/self-modify-pulls.ts", () => pulls);
vi.mock("../../lib/secrets.ts", () => ({
  runWithSecrets: (_use: unknown, input: unknown, run: (resolved: unknown) => Promise<unknown>) => run(input),
}));

const tool = (await import("../../agent/tools/self-modify-status.ts")).default as unknown as {
  execute: (input: unknown, ctx: unknown) => Promise<string>;
};
const ctx = (kind = "slack") => ({
  toolName: "self-modify-status",
  session: {
    id: "s",
    auth: { current: { principalId: "kamil", attributes: { userId: "kamil", kind, readableLevels: ["internal"] } }, initiator: null },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  accounts.role = "admin";
});

describe("self-modify-status", () => {
  it("refuses non-admins without reading GitHub", async () => {
    accounts.role = "user";
    expect(await tool.execute({}, ctx())).toContain("Only admins");
    expect(await tool.execute({ pull_number: 7 }, ctx())).toContain("Only admins");
    expect(pulls.openProposals).not.toHaveBeenCalled();
    expect(status.autoMergeStatus).not.toHaveBeenCalled();
  });

  it("lists the status of every open self-modify pull request", async () => {
    const text = await tool.execute({}, ctx());
    expect(text).toBe("- #7: qualifies, waiting for CI\n- #9: qualifies, waiting for CI");
  });

  it("checks one pull request by number", async () => {
    expect(await tool.execute({ pull_number: 9 }, ctx())).toBe("#9: qualifies, waiting for CI");
    expect(pulls.openProposals).not.toHaveBeenCalled();
  });

  it("says when nothing is open", async () => {
    pulls.openProposals.mockResolvedValueOnce([]);
    expect(await tool.execute({}, ctx())).toContain("no open self-modify pull requests");
  });

  it("returns a simulated result in a rehearsal", async () => {
    expect(await tool.execute({}, ctx("rehearsal"))).not.toContain("qualifies");
    expect(status.autoMergeStatus).not.toHaveBeenCalled();
  });
});
