import { describe, expect, it } from "vitest";
import { hasActivity } from "../../lib/nudges/hours.ts";

const none = { entered: null, calendar: [], slack: [], issues: [], commits: [] };

describe("evening hours activity", () => {
  it("stays silent when nothing happened today", () => {
    expect(hasActivity(none)).toBe(false);
  });

  it("counts any single signal of work", () => {
    expect(hasActivity({ ...none, entered: new Date() })).toBe(true);
    expect(hasActivity({ ...none, calendar: [{}] })).toBe(true);
    expect(hasActivity({ ...none, slack: [{}] })).toBe(true);
    expect(hasActivity({ ...none, issues: ["LIN-1"] })).toBe(true);
    expect(hasActivity({ ...none, commits: [{}] })).toBe(true);
  });
});
