import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/db/schema.ts";
import { CYCLE_CRONS, feedbackSince, freeSlots, hasEnoughEvidence, MAX_OPEN_PULLS, NEW_SYSTEM_SINCE } from "../../lib/self-review/rules.ts";
import { humanReplied, judgeInput } from "../../lib/self-review/satisfaction.ts";
import { formatTranscript, parseFixed, parseMerges, parseRanking, parseTriage } from "../../lib/self-review/triage.ts";

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
    expect(MAX_OPEN_PULLS).toBe(5);
    expect(freeSlots(0)).toBe(5);
    expect(freeSlots(3)).toBe(2);
    expect(freeSlots(5)).toBe(0);
    expect(freeSlots(6)).toBe(0);
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
      memory: null,
    });
    expect(parseTriage(JSON.stringify({ verdict: "actionable", reason: "r", match: "zzz", finding }), ["f1"], false)).toEqual({
      verdict: "new",
      reason: "r",
      finding: { ...finding, summary: null },
      memory: null,
    });
    expect(parseTriage(JSON.stringify({ verdict: "actionable", reason: "r", match: "zzz" }), ["f1"], false)).toBeNull();
  });

  it("does not ask twice", () => {
    const raw = "```json\n" + JSON.stringify({ verdict: "unclear", reason: "r", question: "Co było nie tak?" }) + "\n```";
    expect(parseTriage(raw, [], false)).toEqual({ verdict: "unclear", reason: "r", question: "Co było nie tak?", memory: null });
    expect(parseTriage(raw, [], true)).toEqual({ verdict: "not_actionable", reason: "r", memory: null });
  });

  it("keeps the memory verdict and drops unknown values", () => {
    const parse = (memory: unknown) => parseTriage(JSON.stringify({ verdict: "not_actionable", reason: "r", memory }), [], false);
    expect(parse("wrong")).toEqual({ verdict: "not_actionable", reason: "r", memory: "wrong" });
    expect(parse("maybe")).toEqual({ verdict: "not_actionable", reason: "r", memory: null });
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

describe("parseMerges", () => {
  const findings = [
    { id: "a", status: "open", severity: 1 },
    { id: "b", status: "open", severity: 3 },
    { id: "c", status: "open", severity: 2 },
    { id: "p", status: "proposed", severity: 2 },
    { id: "w", status: "in_progress", severity: 1 },
    { id: "d", status: "dismissed", severity: 3 },
  ];
  const text = { title: "Claims without checking", problem: "p", expected: "e", summary: "s" };
  const parse = (groups: unknown) => parseMerges(JSON.stringify({ groups }), findings);

  it("merges duplicates into the kept finding with the highest severity and the rewritten text", () => {
    expect(parse([{ keep: "a", merge: ["b", "c"], ...text }])).toEqual([{ keepId: "a", mergeIds: ["b", "c"], severity: 3, rewrite: text }]);
  });

  it("keeps the text when the rewrite is incomplete and drops a missing summary", () => {
    expect(parse([{ keep: "a", merge: ["b"], title: "t" }])[0].rewrite).toBeNull();
    expect(parse([{ keep: "a", merge: ["b"], title: "t", problem: "p", expected: "e" }])[0].rewrite).toEqual({
      title: "t",
      problem: "p",
      expected: "e",
      summary: null,
    });
  });

  it("never merges a finding that is being fixed away, but lets it absorb open ones without rewriting it", () => {
    expect(parse([{ keep: "a", merge: ["p", "b"], ...text }])).toEqual([{ keepId: "p", mergeIds: ["a", "b"], severity: 3, rewrite: null }]);
    expect(parse([{ keep: "p", merge: ["w", "c"], ...text }])).toEqual([{ keepId: "p", mergeIds: ["c"], severity: 2, rewrite: null }]);
    expect(parse([{ keep: "p", merge: ["w"] }])).toEqual([]);
  });

  it("ignores unknown, resolved, repeated and self-referencing ids", () => {
    expect(parse([{ keep: "zzz", merge: ["d", "a", "a", "b"] }])).toEqual([{ keepId: "a", mergeIds: ["b"], severity: 3, rewrite: null }]);
    expect(parse([{ keep: "a", merge: ["a"] }])).toEqual([]);
    expect(parse([{ keep: "d", merge: ["zzz"] }])).toEqual([]);
  });

  it("uses each finding in one group only", () => {
    expect(
      parse([
        { keep: "a", merge: ["b"] },
        { keep: "b", merge: ["c"] },
        { keep: "c", merge: ["a"] },
      ]),
    ).toEqual([{ keepId: "a", mergeIds: ["b"], severity: 3, rewrite: null }]);
  });

  it("returns nothing for malformed output", () => {
    expect(parseMerges("not json", findings)).toEqual([]);
    expect(parseMerges(JSON.stringify({ groups: "a,b" }), findings)).toEqual([]);
    expect(parseMerges(JSON.stringify({ groups: [{ merge: ["a", "b"] }] }), findings)).toEqual([]);
    expect(parseMerges(JSON.stringify({ groups: [] }), findings)).toEqual([]);
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

  const cases = ["case-1", "case-2"];

  it("returns the fixed cases with their commits, also from a short sha", () => {
    const raw = JSON.stringify({
      fixed: [
        { case: "case-1", commit: "abc1234" },
        { case: "case-1", commit: "fff9999" },
      ],
      reason: "r",
    });
    expect(parseFixed(raw, cases, commits)).toEqual({ fixed: [{ caseId: "case-1", commit: commits[0] }], reason: "r" });
  });

  it("ignores empty answers, unknown cases or commits and garbage", () => {
    expect(parseFixed(JSON.stringify({ fixed: [], reason: "r" }), cases, commits)).toBeNull();
    expect(parseFixed(JSON.stringify({ fixed: [{ case: "case-3", commit: "abc1234" }], reason: "r" }), cases, commits)).toBeNull();
    expect(parseFixed(JSON.stringify({ fixed: [{ case: "case-2", commit: "0000000" }], reason: "r" }), cases, commits)).toBeNull();
    expect(parseFixed("nope", cases, commits)).toBeNull();
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

describe("commits that may already fix a finding", () => {
  it("leave out auto-merged commits whose rehearsal was still broken", async () => {
    const { withoutBrokenFixes } = await import("../../lib/self-review/index.ts");
    const commit = (sha: string) => ({
      sha,
      message: sha,
      date: "2026-11-17T10:00:00Z",
      url: `https://github.com/o/r/commit/${sha}`,
      files: [],
    });
    expect(withoutBrokenFixes([commit("aaa"), commit("bbb")], new Set(["bbb"])).map((entry) => entry.sha)).toEqual(["aaa"]);
    expect(withoutBrokenFixes([commit("aaa")], new Set())).toHaveLength(1);
  });
});

describe("self-review schedule", () => {
  const warsaw = (date: Date) =>
    date.toLocaleString("en-GB", { timeZone: "Europe/Warsaw", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });

  it("runs on weekdays at 03:30 and every two hours from 8 to 20, never on weekends", async () => {
    const { Cron } = await import("croner");
    const from = new Date("2026-11-15T23:00:00Z");
    const until = new Date("2026-11-22T23:00:00Z");
    const runs = CYCLE_CRONS.flatMap((cron) =>
      new Cron(cron, { timezone: "Europe/Warsaw", paused: true }).nextRuns(60, from).filter((run) => run < until),
    ).sort((a, b) => a.getTime() - b.getTime());
    const day = ["03:30", "08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00"];
    expect(runs.map(warsaw)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"].flatMap((weekday) => day.map((time) => `${weekday} ${time}`)));
  });

  it("is registered as one cron function with both schedules and concurrency 1", async () => {
    const { functions } = await import("../../lib/inngest/functions.ts");
    const found = functions.filter((fn) => (fn as unknown as { opts: { id: string } }).opts.id === "self-review");
    expect(found).toHaveLength(1);
    expect((found[0] as unknown as { opts: unknown }).opts).toMatchObject({
      triggers: CYCLE_CRONS.map((cron) => ({ cron: `TZ=Europe/Warsaw ${cron}` })),
      concurrency: 1,
    });
  });
});
