import { describe, expect, it } from "vitest";
import { contextBefore } from "../../lib/self-review/memory.ts";

describe("contextBefore", () => {
  const ratedAt = new Date("2026-11-14T10:00:00Z");
  const event = (at: string, id: string) => ({ at, note_ids: [id] });

  it("picks the last context Manfrod had before the rated reply", () => {
    const events = [event("2026-11-14T09:00:00Z", "early"), event("2026-11-14T09:59:58Z", "rated"), event("2026-11-14T10:05:00Z", "later")];
    expect(contextBefore(events, ratedAt)?.note_ids).toEqual(["rated"]);
  });

  it("returns null when nothing was recorded before the reply", () => {
    expect(contextBefore([event("2026-11-14T10:05:00Z", "later"), {}], ratedAt)).toBeNull();
  });
});
