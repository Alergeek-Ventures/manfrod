import { describe, expect, it } from "vitest";
import { parseDecision } from "../../lib/nudges/compose.ts";
import { linkIssues } from "../../lib/nudges/projects.ts";
import { waitingFor } from "../../lib/nudges/waiting.ts";
import { weekLog } from "../../lib/nudges/weekly.ts";

const NOW = Date.parse("2026-10-27T09:00:00Z");
const ts = (iso: string) => String(Date.parse(iso) / 1000);

describe("waitingFor", () => {
  const thread = (messages: Record<string, unknown>[]) => ({ channelId: "C1", channelName: "onside", messages });

  it("finds mentions the person has not answered yet", () => {
    const found = waitingFor(
      "U1",
      [
        thread([{ user: "U2", ts: ts("2026-10-26T10:00:00Z"), text: "<@U1> możesz zerknąć na PR?" }]),
        thread([
          { user: "U3", ts: ts("2026-10-26T11:00:00Z"), text: "<@U1> kiedy release?" },
          { user: "U1", ts: ts("2026-10-26T11:30:00Z"), text: "jutro" },
        ]),
        thread([{ user: "U1", ts: ts("2026-10-26T12:00:00Z"), text: "<@U1> notka do siebie" }]),
        thread([{ bot_id: "B1", ts: ts("2026-10-26T12:00:00Z"), text: "<@U1> przypomnienie" }]),
        thread([{ user: "U2", ts: ts("2026-10-27T08:50:00Z"), text: "<@U1> świeże pytanie" }]),
      ],
      NOW,
    );
    expect(found.map((entry) => entry.text)).toEqual(["<@U1> możesz zerknąć na PR?"]);
  });

  it("treats a channel message from the person right after a root mention as an answer", () => {
    const found = waitingFor(
      "U1",
      [
        thread([{ user: "U2", ts: ts("2026-10-27T09:03:00Z"), text: "<@U1> to jest zamierzone?" }]),
        thread([{ user: "U1", ts: ts("2026-10-27T09:04:00Z"), text: "tak, zamierzone" }]),
      ],
      Date.parse("2026-10-28T08:00:00Z"),
    );
    expect(found).toEqual([]);
  });
});

describe("weekLog", () => {
  it("sums sessions per local day and marks empty days", () => {
    const days = weekLog(
      [
        { start_datetime: "2026-10-26T08:00:00Z", end_datetime: "2026-10-26T12:30:00Z", title: "onside" },
        { start_datetime: "2026-10-26T13:00:00Z", end_datetime: "2026-10-26T15:00:00Z", title: "onside" },
        { start_datetime: "2026-10-28T08:00:00Z", end_datetime: "2026-10-28T09:00:00Z", title: "manfrod" },
      ],
      "2026-10-26",
      "2026-10-28",
    );
    expect(days).toEqual([
      { date: "2026-10-26", minutes: 390, titles: ["onside"] },
      { date: "2026-10-27", minutes: 0, titles: [] },
      { date: "2026-10-28", minutes: 60, titles: ["manfrod"] },
    ]);
  });
});

describe("parseDecision", () => {
  it("only sends when there is a message", () => {
    expect(parseDecision('{"send": true, "reason": "r", "message": " hej "}')).toEqual({ send: true, reason: "r", message: "hej" });
    expect(parseDecision('{"send": true, "reason": "r", "message": null}')).toEqual({ send: false, reason: "r" });
    expect(parseDecision('{"send": false, "reason": "r"}')).toEqual({ send: false, reason: "r" });
    expect(parseDecision("nope")).toBeNull();
  });
});

describe("linkIssues", () => {
  const team = { key: "BLA", urlKey: "blaise" };

  it("links bare identifiers of the team and leaves existing links alone", () => {
    expect(linkIssues("w toku (BLA-164), potem BLA-16 i ABC-1", team)).toBe(
      "w toku (<https://linear.app/blaise/issue/BLA-164|BLA-164>), potem <https://linear.app/blaise/issue/BLA-16|BLA-16> i ABC-1",
    );
    const linked = "<https://linear.app/blaise/issue/BLA-164/spaces|BLA-164>";
    expect(linkIssues(linked, team)).toBe(linked);
  });
});
