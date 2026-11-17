import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const visits = vi.hoisted(() => ({ recordVisit: vi.fn() }));
const slack = vi.hoisted(() => ({ addReaction: vi.fn(async () => ({ ok: true })), post: vi.fn() }));
const plan = vi.hoisted(() => ({ refreshPlans: vi.fn(async () => [] as string[]) }));

vi.mock("../../lib/office/presence-store.ts", () => visits);
vi.mock("../../lib/slack/api.ts", () => slack);
vi.mock("../../lib/office/plan.ts", () => plan);

const { classifierRules, MEMORY_ACTIONS } = await import("../../lib/memory/action-decider.ts");
const { parseBulkResponse, recordAnnouncedVisit, visitAllowed, visitDates, visitFromResult, VISIT_REACTION } =
  await import("../../lib/memory/classifier.ts");
const { duplicateVisit } = await vi.importActual<typeof import("../../lib/office/presence-store.ts")>("../../lib/office/presence-store.ts");

const TODAY = "2026-11-17";
const source = { channelId: "C1", writeAccess: ["internal"], authorUserId: "user-1", ts: "123.456", text: "w czwartek przyjeżdżamy" };

beforeEach(() => vi.clearAllMocks());

describe("create_visit", () => {
  it("is a classifier action that needs people from outside the office", () => {
    expect(MEMORY_ACTIONS).toContain("create_visit");
    const criteria = classifierRules().criteria.create_visit;
    expect(criteria).toContain("LITERAL visit signal");
    expect(criteria).toContain("OUTSIDE this office");
    expect(criteria).toContain("jutro będziemy w biurze z Kasią");
    expect(readFileSync("lib/prompts/classifier.md", "utf8")).toContain('"author_coming"');
  });

  it("turns a classifier result into a visit", () => {
    const parsed = parseBulkResponse(
      '```json\n[{"action":"create_visit","note":"zespół z Wrocławia","start_date":"2026-11-19","end_date":null,"guests":3,"author_coming":true}]\n```',
    );
    expect(parsed.ok && visitFromResult(parsed.results[0], "user-1", TODAY, "w czwartek przyjeżdżamy z Wrocławia w 4 osoby")).toEqual({
      startsOn: "2026-11-19",
      endsOn: "2026-11-19",
      userIds: ["user-1"],
      guests: 3,
      note: "zespół z Wrocławia",
    });
  });

  it("counts only guests when the author is not coming and falls back to the message text", () => {
    expect(
      visitFromResult(
        { start_date: "2026-11-19", end_date: "2026-11-20", guests: 2, author_coming: false },
        "u",
        TODAY,
        "przyjeżdża 2 osoby",
      ),
    ).toEqual({ startsOn: "2026-11-19", endsOn: "2026-11-20", userIds: [], guests: 2, note: "przyjeżdża 2 osoby" });
  });

  it("rejects results without dates, in the past, reversed or with nobody", () => {
    expect(visitFromResult({ guests: 2 }, "u", TODAY, "x")).toBeNull();
    expect(visitFromResult({ start_date: "2026-11-10", guests: 2 }, "u", TODAY, "x")).toBeNull();
    expect(visitFromResult({ start_date: "2026-11-19", end_date: "2026-11-18", guests: 2 }, "u", TODAY, "x")).toBeNull();
    expect(visitFromResult({ start_date: "2026-11-19", guests: 0, author_coming: false }, "u", TODAY, "x")).toBeNull();
    expect(visitFromResult({ start_date: "2026-11-19", guests: "4", author_coming: true }, null, TODAY, "x")).toBeNull();
    expect(visitFromResult({ start_date: "2026-11-19", guests: 500 }, null, TODAY, "x")?.guests).toBe(100);
  });

  it("only records visits from team channels", () => {
    expect(visitAllowed("C1", ["internal"])).toBe(true);
    expect(visitAllowed("D1", ["internal"])).toBe(false);
    expect(visitAllowed("C1", ["internal", "external/acme"])).toBe(false);
    expect(visitAllowed("C1", ["private/u1"])).toBe(false);
  });

  it("records the visit, reacts to the message and refreshes posted plans", async () => {
    visits.recordVisit.mockResolvedValueOnce({ ok: true, duplicate: false, visit: { startsOn: "2026-11-19", endsOn: "2026-11-20" } });
    const result = { start_date: "2026-11-19", end_date: "2026-11-20", guests: 3, author_coming: true, note: "zespół z Wrocławia" };
    expect(await recordAnnouncedVisit(result, source, TODAY)).toBe(true);
    expect(visits.recordVisit).toHaveBeenCalledWith({
      startsOn: "2026-11-19",
      endsOn: "2026-11-20",
      userIds: ["user-1"],
      guests: 3,
      note: "zespół z Wrocławia",
      createdBy: "user-1",
    });
    expect(slack.addReaction).toHaveBeenCalledWith("C1", "123.456", VISIT_REACTION);
    expect(plan.refreshPlans).toHaveBeenCalledWith(["2026-11-19", "2026-11-20"]);
  });

  it("records a one-client visit too (it just does not force a plan)", async () => {
    visits.recordVisit.mockResolvedValueOnce({ ok: true, duplicate: false, visit: { startsOn: "2026-11-19", endsOn: "2026-11-19" } });
    expect(await recordAnnouncedVisit({ start_date: "2026-11-19", guests: 1, note: "klient" }, source, TODAY)).toBe(true);
    expect(visits.recordVisit.mock.calls[0][0]).toMatchObject({ guests: 1, userIds: [] });
  });

  it("does nothing in a DM or without people", async () => {
    expect(await recordAnnouncedVisit({ start_date: "2026-11-19", guests: 3 }, { ...source, channelId: "D1" }, TODAY)).toBe(false);
    expect(await recordAnnouncedVisit({ start_date: "2026-11-19", guests: 0 }, source, TODAY)).toBe(false);
    expect(visits.recordVisit).not.toHaveBeenCalled();
    expect(slack.addReaction).not.toHaveBeenCalled();
  });

  it("lists the dates of a visit", () => {
    expect(visitDates("2026-11-30", "2026-12-02")).toEqual(["2026-11-30", "2026-12-01", "2026-12-02"]);
  });
});

describe("duplicateVisit", () => {
  const visit = (startsOn: string, endsOn: string, createdBy: string | null, userIds: string[] = []) => ({
    startsOn,
    endsOn,
    createdBy,
    userIds,
  });

  it("matches overlapping visits by the same author or with the same people", () => {
    const existing = [visit("2026-11-19", "2026-11-20", "kamil"), visit("2026-11-19", "2026-11-19", "ola", ["wro1"])];
    expect(duplicateVisit(existing, visit("2026-11-20", "2026-11-21", "kamil"))).toBe(existing[0]);
    expect(duplicateVisit(existing, visit("2026-11-19", "2026-11-19", "ania", ["wro1", "wro2"]))).toBe(existing[1]);
  });

  it("keeps different visits apart", () => {
    const existing = [visit("2026-11-19", "2026-11-20", "kamil")];
    expect(duplicateVisit(existing, visit("2026-11-21", "2026-11-21", "kamil"))).toBeNull();
    expect(duplicateVisit(existing, visit("2026-11-19", "2026-11-19", "ania"))).toBeNull();
    expect(duplicateVisit(existing, visit("2026-11-19", "2026-11-19", null))).toBeNull();
  });
});
