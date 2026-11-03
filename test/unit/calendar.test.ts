import { describe, expect, it } from "vitest";
import { freeWindows, parseEventTime } from "../../agent/lib/calendar.ts";

const at = (time: string) => new Date(`2026-11-05T${time}:00Z`);

describe("freeWindows", () => {
  const window = { start: at("08:00"), end: at("16:00") };

  it("returns the gaps between merged busy slots that fit the meeting", () => {
    const busy = [
      { start: at("09:00"), end: at("10:00") },
      { start: at("09:30"), end: at("11:00") },
      { start: at("11:15"), end: at("12:00") },
      { start: at("15:00"), end: at("17:00") },
    ];
    expect(freeWindows(busy, window, 30)).toEqual([
      { start: at("08:00"), end: at("09:00") },
      { start: at("12:00"), end: at("15:00") },
    ]);
  });

  it("returns the whole window when nobody is busy", () => {
    expect(freeWindows([], window, 60)).toEqual([window]);
  });
});

describe("parseEventTime", () => {
  it("reads local times as Europe/Warsaw", () => {
    expect(parseEventTime("2026-11-05T10:00")).toEqual({ allDay: false, at: new Date("2026-11-05T09:00:00Z") });
    expect(parseEventTime("2026-07-01T10:00")).toEqual({ allDay: false, at: new Date("2026-07-01T08:00:00Z") });
  });

  it("keeps explicit offsets and recognises all-day dates", () => {
    expect(parseEventTime("2026-11-05T10:00:00Z")).toEqual({ allDay: false, at: new Date("2026-11-05T10:00:00Z") });
    expect(parseEventTime("2026-11-05")).toEqual({ allDay: true, date: "2026-11-05" });
    expect(parseEventTime("tomorrow 10")).toBeNull();
  });
});
