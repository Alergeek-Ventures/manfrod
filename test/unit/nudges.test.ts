import { describe, expect, it } from "vitest";
import { parseDecision } from "../../lib/nudges/compose.ts";
import { sessionsOn, slackActivity } from "../../lib/nudges/hours.ts";
import { linkIssues } from "../../lib/nudges/projects.ts";
import { ownMessagesSince, waitingFor } from "../../lib/nudges/waiting.ts";
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

describe("ownMessagesSince", () => {
  it("lists the person's own later messages from every thread, newest first", () => {
    const found = ownMessagesSince(
      "U1",
      [
        { channelId: "C1", channelName: "onside", messages: [{ user: "U1", ts: ts("2026-10-26T10:00:00Z"), text: "stare" }] },
        {
          channelId: "C2",
          channelName: "manfrod",
          messages: [
            { user: "U2", ts: ts("2026-10-26T12:00:00Z"), text: "pytanie" },
            { user: "U1", ts: ts("2026-10-26T13:00:00Z"), text: "zrobione" },
          ],
        },
        { channelId: "C3", channelName: "general", messages: [{ user: "U1", ts: ts("2026-10-26T14:00:00Z"), text: "wysłałem" }] },
      ],
      ts("2026-10-26T11:00:00Z"),
    );
    expect(found.map((message) => [message.channelName, message.text])).toEqual([
      ["general", "wysłałem"],
      ["manfrod", "zrobione"],
    ]);
  });

  it("skips system and empty messages so they don't take slots", () => {
    const messages = [
      { user: "U1", ts: ts("2026-10-26T15:00:00Z"), text: "<@U1> has joined the channel", subtype: "channel_join" },
      { user: "U1", ts: ts("2026-10-26T14:30:00Z"), text: "  " },
      ...Array.from({ length: 16 }, (_, index) => ({
        user: "U1",
        ts: ts(`2026-10-26T${String(12 + Math.floor(index / 6)).padStart(2, "0")}:${String((index % 6) * 10).padStart(2, "0")}:00Z`),
        text: `msg ${index}`,
      })),
    ];
    const found = ownMessagesSince("U1", [{ channelId: "C1", channelName: "general", messages }], ts("2026-10-26T11:00:00Z"));
    expect(found).toHaveLength(15);
    expect(found.every((message) => message.text.startsWith("msg "))).toBe(true);
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

  it("finds the decision inside surrounding prose and code fences", () => {
    expect(parseDecision('Here is my decision:\n```json\n{"send": false, "reason": "r"}\n```\nDone.')).toEqual({
      send: false,
      reason: "r",
    });
  });

  it("accepts raw newlines inside the message", () => {
    expect(parseDecision('{"send": true, "reason": "r", "message": "hej\n\ndopisać AV - HR 12:27-13:00?\t\\"ok\\""}')).toEqual({
      send: true,
      reason: "r",
      message: 'hej\n\ndopisać AV - HR 12:27-13:00?\t"ok"',
    });
  });

  it("rejects invalid JSON and wrong shapes", () => {
    expect(parseDecision('{"send": true, "reason": ')).toBeNull();
    expect(parseDecision('{"send": "yes"}')).toBeNull();
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

describe("sessionsOn", () => {
  it("keeps only the given Warsaw day, in order, and marks running sessions", () => {
    const records = [
      { start_datetime: "2026-11-03T17:00:00Z", end_datetime: null, title: "pdfs", project: { name: "Saltfish" } },
      { start_datetime: "2026-11-03T07:30:00Z", end_datetime: "2026-11-03T11:00:00Z", title: "review" },
      { start_datetime: "2026-11-02T23:30:00Z", end_datetime: "2026-11-03T00:30:00Z", title: "late night" },
      { start_datetime: "2026-11-02T10:00:00Z", end_datetime: "2026-11-02T12:00:00Z", title: "yesterday" },
    ];
    expect(sessionsOn(records, "2026-11-03").map((session) => [session.title, session.project, session.end === null])).toEqual([
      ["late night", null, false],
      ["review", null, false],
      ["pdfs", "Saltfish", true],
    ]);
  });
});

describe("slackActivity", () => {
  it("counts the person's own messages since the start of the day per channel", () => {
    const since = new Date("2026-11-03T00:00:00Z");
    const threads = [
      {
        channelId: "C1",
        channelName: "saltfish",
        messages: [
          { user: "U1", ts: ts("2026-11-02T15:00:00Z") },
          { user: "U1", ts: ts("2026-11-03T09:00:00Z") },
          { user: "U2", ts: ts("2026-11-03T09:05:00Z") },
          { user: "U1", ts: ts("2026-11-03T16:00:00Z") },
        ],
      },
      { channelId: "C2", channelName: "random", messages: [{ user: "U1", ts: ts("2026-11-03T12:00:00Z"), subtype: "channel_join" }] },
    ];
    expect(slackActivity("U1", threads, since)).toEqual([
      {
        channelId: "C1",
        channelName: "saltfish",
        count: 2,
        first: new Date("2026-11-03T09:00:00Z"),
        last: new Date("2026-11-03T16:00:00Z"),
      },
    ]);
  });
});
