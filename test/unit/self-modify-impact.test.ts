import { describe, expect, it, vi } from "vitest";

const users = vi.hoisted(() => new Map<string, { id: string; slackId: string; role: string }>());
const merges = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../../lib/accounts.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/accounts.ts")>()),
  getUser: async (id: string) => users.get(id) ?? null,
}));
vi.mock("../../lib/secrets.ts", () => ({
  runWithSecrets: (_use: unknown, input: unknown, run: (resolved: unknown) => Promise<string>) => run(input),
}));
vi.mock("../../lib/self-modify-merge/store.ts", () => ({
  mergedPull: async () => {
    merges.calls += 1;
    return null;
  },
}));

const { default: tool } = await import("../../agent/tools/self-modify-impact.ts");
const { verdictText, windows } = await import("../../lib/self-modify-merge/impact.ts");

const run = (userId: string) =>
  (tool as unknown as { execute: (input: unknown, ctx: unknown) => Promise<string> }).execute(
    { pull_number: 7 },
    { toolName: "self-modify-impact", session: { auth: { current: { principalId: userId, attributes: { userId } }, initiator: null } } },
  );

describe("self-modify-impact", () => {
  it("answers only admins and self-review", async () => {
    users.set("member", { id: "member", slackId: "U1", role: "member" });
    users.set("admin", { id: "admin", slackId: "U2", role: "admin" });
    users.set("self-review", { id: "self-review", slackId: "system:self-review", role: "member" });
    expect(await run("member")).toBe("Only an admin or Manfrod's self-review can do that.");
    expect(merges.calls).toBe(0);
    expect(await run("admin")).toBe("#7 was not merged automatically.");
    expect(await run("self-review")).toBe("#7 was not merged automatically.");
  });

  it("compares windows of equal length, capped by the audit retention", () => {
    const live = new Date("2026-11-17T10:00:00Z");
    const short = windows(live, new Date("2026-11-17T12:00:00Z"));
    expect(short.before.from.toISOString()).toBe("2026-11-17T08:00:00.000Z");
    expect(short.after).toEqual({ from: live, to: new Date("2026-11-17T12:00:00Z") });
    const long = windows(live, new Date("2026-11-22T10:00:00Z"));
    expect(long.before.from.getTime()).toBeGreaterThan(new Date("2026-11-15T10:00:00Z").getTime());
  });

  it("recommends a revert on worse without doing it", () => {
    expect(verdictText(7, "https://github.com/o/r/pull/7", "worse", "2 of 5 rated bad")).toContain("I recommend reverting");
    expect(verdictText(7, null, "better", "fewer 👎")).not.toContain("revert");
  });
});
