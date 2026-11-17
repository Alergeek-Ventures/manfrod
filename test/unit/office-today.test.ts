import { afterEach, describe, expect, it, vi } from "vitest";
import { withDate } from "../../agent/lib/office.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("desk tools' default date", () => {
  it("uses the Warsaw date just after local midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T23:30:00Z"));
    expect(await withDate(undefined, async (date) => date)).toBe("2026-11-18");
  });

  it("keeps an explicit date", async () => {
    expect(await withDate("2026-07-23", async (date) => date)).toBe("2026-07-23");
  });
});
