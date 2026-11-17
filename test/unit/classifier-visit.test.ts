import { describe, expect, it } from "vitest";
import { classifierRules, MEMORY_ACTIONS } from "../../lib/memory/action-decider.ts";
import { parseBulkResponse, visitAllowed, visitFromResult } from "../../lib/memory/classifier.ts";

const TODAY = "2026-11-17";

describe("create_visit", () => {
  it("is a classifier action with its own criteria", () => {
    expect(MEMORY_ACTIONS).toContain("create_visit");
    expect(classifierRules().criteria.create_visit).toContain("LITERAL visit signal");
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
    ).toEqual({
      startsOn: "2026-11-19",
      endsOn: "2026-11-20",
      userIds: [],
      guests: 2,
      note: "przyjeżdża 2 osoby",
    });
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
});
