import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/db/schema.ts";
import { feedbackSince, freeSlots, hasEnoughEvidence, NEW_SYSTEM_SINCE } from "../../lib/self-review/rules.ts";
import { humanReplied, judgeInput } from "../../lib/self-review/satisfaction.ts";
import { formatTranscript, parseFixed, parseRanking, parseTriage } from "../../lib/self-review/triage.ts";

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

describe("feedbackSince", () => {
  it("looks back 30 days but never before the new system went live", () => {
    expect(feedbackSince(new Date("2026-10-27T03:30:00Z"))).toEqual(NEW_SYSTEM_SINCE);
    expect(feedbackSince(new Date("2027-01-10T03:30:00Z"))).toEqual(new Date("2026-12-11T03:30:00Z"));
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
      finding: { ...finding, summary: null },
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

describe("parseFixed", () => {
  const commits = [
    {
      sha: "abc1234def",
      message: "fix(prompts): answer in the thread",
      date: "2026-10-28T10:00:00Z",
      url: "u1",
      files: ["lib/agent/prompts.ts"],
    },
    { sha: "fff9999aaa", message: "chore: deps", date: "2026-10-28T11:00:00Z", url: "u2", files: ["package.json"] },
  ];

  it("returns the fixing commit, also from a short sha", () => {
    expect(parseFixed(JSON.stringify({ fixed: true, commit: "abc1234", reason: "r" }), commits)).toEqual({
      commit: commits[0],
      reason: "r",
    });
  });

  it("ignores negative answers, unknown commits and garbage", () => {
    expect(parseFixed(JSON.stringify({ fixed: false, commit: null, reason: "r" }), commits)).toBeNull();
    expect(parseFixed(JSON.stringify({ fixed: true, commit: "0000000", reason: "r" }), commits)).toBeNull();
    expect(parseFixed("nope", commits)).toBeNull();
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

describe("satisfaction review", () => {
  it("only judges conversations where a person wrote after Manfrod", () => {
    expect(humanReplied([{ role: "user" }, { role: "assistant" }])).toBe(false);
    expect(humanReplied([{ role: "user" }, { role: "assistant" }, { role: "user" }])).toBe(true);
    expect(humanReplied([{ role: "assistant" }])).toBe(false);
  });

  it("labels people and marks Manfrod's replies to choose from", () => {
    const history = [
      message("user", "Book a desk", 100, "u1"),
      message("assistant", "Booked desk 4", 110),
      message("user", "Wrong day", 120, "u2"),
      message("user", "Still wrong", 130, "u1"),
    ];
    const input = judgeInput(history);
    expect(input.transcript).toBe("Person 1: Book a desk\n\nManfrod [r1]: Booked desk 4\n\nPerson 2: Wrong day\n\nPerson 1: Still wrong");
    expect(input.replies.map((reply) => reply.key)).toEqual(["r1"]);
  });
});
