import { beforeEach, describe, expect, it, vi } from "vitest";

const people = vi.hoisted(() => ({ resolvePerson: vi.fn() }));
const presence = vi.hoisted(() => ({ setPresence: vi.fn(async () => ({})), clearPresence: vi.fn(async () => true) }));
const accounts = vi.hoisted(() => ({ role: "user" }));

vi.mock("../../lib/people.ts", () => people);
vi.mock("../../lib/office/presence.ts", () => presence);
vi.mock("../../lib/desks.ts", () => ({ cancelReservationsForDate: async () => [] }));
vi.mock("../../agent/lib/desk-plan.ts", () => ({ refreshNote: async () => "" }));
vi.mock("../../lib/accounts.ts", () => ({
  getUser: async (id: string) => ({ id, slackId: "UNAT", name: "Natalia", role: accounts.role }),
  isAdmin: (user: { role: string }) => user.role === "admin",
}));
vi.mock("../../lib/secrets.ts", () => ({
  runWithSecrets: (_use: unknown, input: unknown, run: (resolved: unknown) => Promise<unknown>) => run(input),
}));

const tool = (await import("../../agent/tools/set-office-presence.ts")).default as unknown as {
  execute: (input: unknown, ctx: unknown) => Promise<string>;
};
const ctx = (readableLevels = ["internal"]) => ({
  toolName: "set-office-presence",
  session: {
    id: "s",
    auth: { current: { principalId: "natalia", attributes: { userId: "natalia", kind: "slack", readableLevels } }, initiator: null },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  accounts.role = "user";
  people.resolvePerson.mockImplementation(async (name: string) =>
    name === "Natalia"
      ? { ok: true, user: { id: "natalia", slackId: "UNAT", name: "Natalia" } }
      : { ok: false, unknown: true, message: "?" },
  );
});

describe("set-office-presence", () => {
  it("refuses a non-admin setting someone else's presence without looking them up on Slack", async () => {
    expect(await tool.execute({ dates: ["2026-11-23"], status: "remote", person: "Odul" }, ctx())).toContain("Only admins");
    expect(people.resolvePerson).toHaveBeenCalledWith("Odul", { adopt: false });
    expect(presence.setPresence).not.toHaveBeenCalled();
  });

  it("lets a non-admin name themselves", async () => {
    expect(await tool.execute({ dates: ["2026-11-23"], status: "remote", person: "Natalia" }, ctx())).toContain("Saved");
    expect(presence.setPresence).toHaveBeenCalledWith("natalia", "2026-11-23", "remote", "chat", null);
  });

  it("lets an admin set it for a Slack member Manfrod has to add first", async () => {
    accounts.role = "admin";
    people.resolvePerson.mockResolvedValueOnce({ ok: true, user: { id: "odul", slackId: "UODUL", name: "Odul" } });
    expect(await tool.execute({ dates: ["2026-11-23"], status: "office", person: "Odul" }, ctx())).toContain("Saved: Odul");
    expect(people.resolvePerson).toHaveBeenCalledWith("Odul", { adopt: true });
  });

  it("refuses outside team channels", async () => {
    expect(await tool.execute({ dates: ["2026-11-23"], status: "office" }, ctx(["external/acme"]))).toContain("only available");
    expect(people.resolvePerson).not.toHaveBeenCalled();
  });
});
