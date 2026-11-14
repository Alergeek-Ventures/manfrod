import { describe, expect, it } from "vitest";
import { contextForReply, type ContextEvent } from "../../lib/self-review/memory.ts";

describe("contextForReply", () => {
  const ratedAt = new Date("2026-11-14T10:00:00Z");
  const event = (at: string, id: string, kind: "turn" | "tool" = "turn"): ContextEvent => ({ at, kind, note_ids: [id] });

  it("collects the notes of the rated turn: its start and the lookups that followed", () => {
    const events = [
      event("2026-11-14T09:58:30Z", "lookup", "tool"),
      event("2026-11-14T09:00:00Z", "earlier-turn"),
      event("2026-11-14T09:58:00Z", "turn-start"),
      event("2026-11-14T10:05:00Z", "after-reply", "tool"),
    ];
    expect(contextForReply(events, ratedAt).map((item) => item.note_ids?.[0])).toEqual(["turn-start", "lookup"]);
  });

  it("returns nothing when no turn was recorded before the reply", () => {
    expect(contextForReply([event("2026-11-14T10:05:00Z", "later"), {}], ratedAt)).toEqual([]);
    expect(contextForReply([event("2026-11-14T09:59:00Z", "lookup", "tool")], ratedAt)).toEqual([]);
  });
});
