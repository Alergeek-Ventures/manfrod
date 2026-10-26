import { describe, expect, it } from "vitest";
import { askBy, holidayPeriods, nextAction, unsurePlan } from "../../lib/holidays.ts";

const holidays = [
  { date: "2026-06-04", name: "Boże Ciało" },
  { date: "2026-11-01", name: "Wszystkich Świętych" },
  { date: "2026-11-11", name: "Dzień Niepodległości" },
  { date: "2026-12-24", name: "Wigilia Bożego Narodzenia" },
  { date: "2026-12-25", name: "Boże Narodzenie" },
  { date: "2026-12-26", name: "Boże Narodzenie" },
  { date: "2027-01-01", name: "Nowy Rok" },
];

describe("holidayPeriods", () => {
  const periods = holidayPeriods(holidays);

  it("ignores holidays that fall on a weekend", () => {
    expect(periods.some((period) => period.holidays.some((holiday) => holiday.date === "2026-11-01"))).toBe(false);
  });

  it("offers the Friday after a Thursday holiday as a long weekend", () => {
    const corpusChristi = periods.find((period) => period.start === "2026-06-04")!;
    expect(corpusChristi.bridges).toEqual([{ days: ["2026-06-05"], offFrom: "2026-06-04", offTo: "2026-06-07" }]);
  });

  it("offers both sides of a midweek holiday", () => {
    const independence = periods.find((period) => period.start === "2026-11-11")!;
    expect(independence.bridges).toEqual([
      { days: ["2026-11-09", "2026-11-10"], offFrom: "2026-11-07", offTo: "2026-11-11" },
      { days: ["2026-11-12", "2026-11-13"], offFrom: "2026-11-11", offTo: "2026-11-15" },
    ]);
    expect(askBy(independence)).toBe("2026-11-09");
  });

  it("joins Christmas and New Year into one period with the days in between as a bridge", () => {
    const winter = periods.find((period) => period.start === "2026-12-24")!;
    expect(winter.end).toBe("2027-01-03");
    expect(winter.holidays.map((holiday) => holiday.date)).toEqual(["2026-12-24", "2026-12-25", "2026-12-26", "2027-01-01"]);
    expect(winter.bridges[0]).toEqual({
      days: ["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31"],
      offFrom: "2026-12-24",
      offTo: "2027-01-03",
    });
    expect(askBy(winter)).toBe("2026-12-24");
  });
});

describe("nextAction", () => {
  it("asks once inside the window and never after an answer", () => {
    expect(nextAction(null, "2026-10-20", "2026-11-09")).toBeNull();
    expect(nextAction(null, "2026-10-26", "2026-11-09")).toBe("ask");
    expect(nextAction("asked:2026-10-26", "2026-10-27", "2026-11-09")).toBeNull();
    expect(nextAction("working", "2026-10-27", "2026-11-09")).toBeNull();
    expect(nextAction(null, "2026-11-09", "2026-11-09")).toBeNull();
  });

  it("reminds an unsure person once", () => {
    expect(nextAction("unsure:2026-11-01", "2026-10-30", "2026-11-09")).toBeNull();
    expect(nextAction("unsure:2026-11-01", "2026-11-02", "2026-11-09")).toBe("reask");
    expect(unsurePlan("asked:2026-10-26", "2026-10-27", "2026-11-09")).toBe("unsure:2026-10-30");
    expect(unsurePlan("reasked:2026-11-02", "2026-11-03", "2026-11-09")).toBe("unsure");
    expect(unsurePlan(null, "2026-11-07", "2026-11-09")).toBe("unsure");
  });
});
