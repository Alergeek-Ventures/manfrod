import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/db/schema.ts";
import { freeSlots, hasEnoughEvidence } from "../../lib/self-review/rules.ts";
import { formatTranscript, parseRanking, parseTriage } from "../../lib/self-review/triage.ts";

const message = (role: "user" | "assistant", content: string, at: number, userId = "rater"): Message =>
  ({ role, content, userId, receivedAt: new Date(at * 1000) }) as Message;

describe("hasEnoughEvidence", () => {
  it("needs two different raters or one admin", () => {
    expect(hasEnoughEvidence([{ slackUserId: "U1", admin: false }])).toBe(false);
    expect(
      hasEnoughEvidence([
        { slackUserId: "U1", admin: false },
        { slackUserId: "U1", admin: false },
      ]),
    ).toBe(false);
    expect(
      hasEnoughEvidence([
        { slackUserId: "U1", admin: false },
        { slackUserId: "U2", admin: false },
      ]),
    ).toBe(true);
    expect(hasEnoughEvidence([{ slackUserId: "U1", admin: true }])).toBe(true);
  });

  it("never opens more than two pull requests at once", () => {
    expect(freeSlots(0)).toBe(2);
    expect(freeSlots(2)).toBe(0);
    expect(freeSlots(3)).toBe(0);
  });
});

describe("parseTriage", () => {
  const finding = { title: "Ignores date", problem: "p", expected: "e", category: "skill", severity: 2 };

  it("links to a known finding and ignores unknown ids", () => {
    expect(parseTriage(JSON.stringify({ verdict: "actionable", reason: "r", match: "f1" }), ["f1"], false)).toEqual({
      verdict: "match",
      reason: "r",
      findingId: "f1",
    });
    expect(parseTriage(JSON.stringify({ verdict: "actionable", reason: "r", match: "zzz", finding }), ["f1"], false)).toEqual({
      verdict: "new",
      reason: "r",
      finding,
    });
    expect(parseTriage(JSON.stringify({ verdict: "actionable", reason: "r", match: "zzz" }), ["f1"], false)).toBeNull();
  });

  it("does not ask twice", () => {
    const raw = "```json\n" + JSON.stringify({ verdict: "unclear", reason: "r", question: "Co było nie tak?" }) + "\n```";
    expect(parseTriage(raw, [], false)).toEqual({ verdict: "unclear", reason: "r", question: "Co było nie tak?" });
    expect(parseTriage(raw, [], true)).toEqual({ verdict: "not_actionable", reason: "r" });
  });

  it("rejects malformed output", () => {
    expect(parseTriage("not json", [], false)).toBeNull();
    expect(parseTriage(JSON.stringify({ verdict: "actionable", finding: { ...finding, category: "infra" } }), [], false)).toBeNull();
  });
});

describe("parseRanking", () => {
  it("keeps only candidate ids, up to the limit", () => {
    expect(parseRanking('["b", "x", "a", "b"]', ["a", "b", "c"], 2)).toEqual(["b", "a"]);
    expect(parseRanking("nonsense", ["a", "b", "c"], 2)).toEqual(["a", "b"]);
  });
});

describe("formatTranscript", () => {
  it("marks the reply closest to the rating and labels the rater", () => {
    const transcript = formatTranscript({
      messages: [
        message("user", "Book a desk", 100),
        message("assistant", "Booked desk 4", 110),
        message("user", "Wrong day", 120, "someone"),
        message("assistant", "Fixed", 200),
      ],
      raterUserId: "rater",
      ratedAt: new Date(115_000),
    });
    expect(transcript).toBe(
      "Person who rated: Book a desk\n\nManfrod [THIS REPLY WAS RATED UNHELPFUL]: Booked desk 4\n\nOther person: Wrong day\n\nManfrod: Fixed",
    );
  });
});
