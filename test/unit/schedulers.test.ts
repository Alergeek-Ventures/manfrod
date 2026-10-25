import { describe, expect, it } from "vitest";
import { nextOccurrences } from "../../lib/schedulers.ts";

describe("nextOccurrences", () => {
  it("returns runs inside the 12h window in the given timezone", () => {
    const runs = nextOccurrences("0 9 * * *", "Europe/Warsaw", new Date("2026-10-23T05:00:00Z"));
    expect(runs.map((run) => run.toISOString())).toEqual(["2026-10-23T07:00:00.000Z"]);
  });

  it("returns every run for frequent schedules", () => {
    expect(nextOccurrences("0 * * * *", "UTC", new Date("2026-10-23T00:30:00Z"))).toHaveLength(12);
  });

  it("returns nothing for an invalid expression", () => {
    expect(nextOccurrences("not a cron", "UTC", new Date())).toEqual([]);
  });
});
