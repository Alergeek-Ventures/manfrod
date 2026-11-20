import { beforeEach, describe, expect, it, vi } from "vitest";

const VISIT_ID = "11111111-2222-3333-4444-555555555555";

const presence = vi.hoisted(() => ({
  getVisit: vi.fn(),
  updateVisit: vi.fn(),
  cancelVisit: vi.fn(),
  recordVisit: vi.fn(),
  listVisits: vi.fn(async () => [] as unknown[]),
}));
const people = vi.hoisted(() => ({ resolvePerson: vi.fn() }));
const deskPlan = vi.hoisted(() => ({
  refreshNote: vi.fn(async () => ""),
  longStayHint: vi.fn(async () => ""),
  datesBetween: (from: string, to: string) => (from === to ? [from] : [from, to]),
}));

vi.mock("../../lib/office/presence.ts", () => presence);
vi.mock("../../lib/people.ts", () => people);
vi.mock("../../agent/lib/desk-plan.ts", () => deskPlan);
vi.mock("../../lib/accounts.ts", () => ({
  listUsers: async () => [{ id: "staszek", slackId: "USTASZEK", name: "Staszek" }],
  isUuid: (value: string) => /^[0-9a-f-]{36}$/.test(value),
}));
vi.mock("../../lib/secrets.ts", () => ({
  runWithSecrets: (_use: unknown, input: unknown, run: (resolved: unknown) => Promise<unknown>) => run(input),
}));

type Run = (input: unknown, ctx: unknown) => Promise<string>;
const load = async (name: string) => (await import(`../../agent/tools/${name}.ts`)).default as unknown as { execute: Run };

const ctx = (readableLevels: string[], userId = "natalia") => ({
  toolName: "test",
  session: { id: "s1", auth: { current: { principalId: userId, attributes: { userId, kind: "slack", readableLevels } }, initiator: null } },
});
const TEAM = ctx(["internal", "external/all"]);
const CLIENT = ctx(["external/acme", "external/all"]);

const stored = {
  id: VISIT_ID,
  layoutId: "layout-1",
  startsOn: "2026-11-19",
  endsOn: "2026-12-02",
  userIds: ["staszek"],
  guests: 2,
  guestNames: [] as string[],
  note: "Odul i Mariusz na okres próbny",
  createdBy: "staszek",
  cancelledAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  presence.getVisit.mockResolvedValue(stored);
  people.resolvePerson.mockImplementation(async (name: string) =>
    name === "Nikt"
      ? { ok: false, unknown: true, message: 'nie znam nikogo takiego jak "Nikt"' }
      : { ok: true, user: { id: name.toLowerCase(), slackId: `U${name}`, name } },
  );
});

describe("update-office-visit", () => {
  it("lets anyone on the team replace anonymous guests with the named people", async () => {
    const tool = await load("update-office-visit");
    presence.updateVisit.mockResolvedValueOnce({
      ok: true,
      previous: stored,
      visit: { ...stored, userIds: ["odul", "mariusz"], guests: 0 },
    });
    const reply = await tool.execute({ visit_id: VISIT_ID, people: ["Odul", "Mariusz"], guests: 0 }, TEAM);
    expect(presence.updateVisit).toHaveBeenCalledWith(VISIT_ID, {
      startsOn: undefined,
      endsOn: undefined,
      userIds: ["odul", "mariusz"],
      guestNames: [],
      guests: 0,
      note: undefined,
    });
    expect(reply).toContain("Updated:");
    expect(reply).toContain("Odul, Mariusz");
    expect(deskPlan.refreshNote).toHaveBeenCalledWith(["2026-11-19", "2026-12-02", "2026-11-19", "2026-12-02"]);
  });

  it("keeps the people and the anonymous count it is not told to change", async () => {
    const tool = await load("update-office-visit");
    presence.getVisit.mockResolvedValueOnce({ ...stored, guests: 3, guestNames: ["Zenek"] });
    presence.updateVisit.mockResolvedValueOnce({ ok: true, previous: stored, visit: stored });
    await tool.execute({ visit_id: VISIT_ID, end_date: "2026-11-20" }, TEAM);
    expect(presence.updateVisit).toHaveBeenCalledWith(
      VISIT_ID,
      expect.objectContaining({ userIds: undefined, guestNames: ["Zenek"], guests: 3 }),
    );
  });

  it("refuses outside team channels, unknown visits, bad dates and unknown people", async () => {
    const tool = await load("update-office-visit");
    expect(await tool.execute({ visit_id: VISIT_ID, guests: 0 }, CLIENT)).toContain("only available in team channels");
    expect(await tool.execute({ visit_id: "nope", guests: 0 }, TEAM)).toContain("No active visit");
    presence.getVisit.mockResolvedValueOnce({ ...stored, cancelledAt: new Date() });
    expect(await tool.execute({ visit_id: VISIT_ID, guests: 0 }, TEAM)).toContain("No active visit");
    expect(await tool.execute({ visit_id: VISIT_ID, start_date: "19.11" }, TEAM)).toContain("Invalid dates");
    const unknown = await tool.execute({ visit_id: VISIT_ID, people: ["Nikt"] }, TEAM);
    expect(unknown).toContain("Nothing saved");
    expect(unknown).toContain("guest_names");
    presence.updateVisit.mockResolvedValueOnce({ ok: false, error: "nobody" });
    expect(await tool.execute({ visit_id: VISIT_ID, people: [], guests: 0, guest_names: [] }, TEAM)).toContain("Nothing saved");
    expect(presence.updateVisit).toHaveBeenCalledTimes(1);
  });
});

describe("cancel-office-visit", () => {
  it("lets anyone on the team cancel a visit someone else recorded", async () => {
    const tool = await load("cancel-office-visit");
    presence.cancelVisit.mockResolvedValueOnce({ ...stored, cancelledAt: new Date() });
    expect(await tool.execute({ visit_id: VISIT_ID }, TEAM)).toContain("Cancelled the visit");
    expect(presence.cancelVisit).toHaveBeenCalledWith(VISIT_ID);
  });

  it("refuses in client channels and for missing or cancelled visits", async () => {
    const tool = await load("cancel-office-visit");
    expect(await tool.execute({ visit_id: VISIT_ID }, CLIENT)).toContain("only available in team channels");
    presence.getVisit.mockResolvedValueOnce(null);
    expect(await tool.execute({ visit_id: VISIT_ID }, TEAM)).toContain("No visit");
    presence.getVisit.mockResolvedValueOnce({ ...stored, cancelledAt: new Date() });
    expect(await tool.execute({ visit_id: VISIT_ID }, TEAM)).toContain("already cancelled");
    expect(presence.cancelVisit).not.toHaveBeenCalled();
  });
});

describe("record-office-visit", () => {
  it("records named people with Slack as people and the rest as named or counted guests", async () => {
    const tool = await load("record-office-visit");
    presence.recordVisit.mockResolvedValueOnce({
      ok: true,
      duplicate: false,
      visit: { ...stored, userIds: ["odul"], guests: 2, guestNames: ["Zenek"] },
    });
    const reply = await tool.execute(
      { start_date: "2026-11-19", end_date: "2026-12-02", people: ["Odul"], guest_names: ["Zenek"], guests: 1, note: "okres próbny" },
      TEAM,
    );
    expect(presence.recordVisit).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: ["odul"], guests: 2, guestNames: ["Zenek"], createdBy: "natalia" }),
    );
    expect(reply).toContain("Zenek (guest without a Slack account)");
    expect(reply).toContain("1 unnamed guest");
    expect(deskPlan.longStayHint).toHaveBeenCalled();
  });

  it("refuses in client channels and names it cannot resolve", async () => {
    const tool = await load("record-office-visit");
    expect(await tool.execute({ start_date: "2026-11-19", guests: 2, note: "x" }, CLIENT)).toContain("only available in team channels");
    expect(await tool.execute({ start_date: "2026-11-19", people: ["Nikt"], note: "x" }, TEAM)).toContain("Nothing saved");
    expect(presence.recordVisit).not.toHaveBeenCalled();
  });
});
