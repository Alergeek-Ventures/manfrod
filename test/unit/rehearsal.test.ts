import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  merges: [] as Record<string, unknown>[],
  rehearsals: [] as Record<string, unknown>[],
  events: new Map<string, { type: string; data?: Record<string, unknown> }[]>(),
  started: [] as { address: string; message: string; auth: { attributes: Record<string, unknown> }; history: unknown[] }[],
  ended: [] as string[],
  posts: [] as { channel: string; thread_ts?: string; text: string }[],
  verdicts: new Map<string, string>(),
  reopened: [] as string[],
}));

vi.mock("../../lib/inngest/runtime.ts", () => ({
  agentRuntime: () => ({
    sendToSlack: async () => {
      throw new Error("a rehearsal must never reach Slack");
    },
    startHeadless: async (address: string, message: string, auth: { attributes: Record<string, unknown> }, history: unknown[]) => {
      state.started.push({ address, message, auth, history });
      return `session-${state.started.length}`;
    },
    sessionEvents: async (sessionId: string) => state.events.get(sessionId) ?? [],
    endSession: async (sessionId: string) => {
      state.ended.push(sessionId);
    },
  }),
}));
vi.mock("../../lib/rehearsal/store.ts", () => ({
  pendingLive: async () => state.rehearsals.filter((row) => row.status === "pending"),
  running: async () => state.rehearsals.filter((row) => row.status === "running"),
  markRunning: async (id: string, sessionId: string) => {
    Object.assign(
      state.rehearsals.find((row) => row.id === id)!,
      { status: "running", sessionId, startedAt: new Date() },
    );
  },
  finish: async (id: string, status: string, transcript: unknown, verdict: string, reason: string) => {
    Object.assign(
      state.rehearsals.find((row) => row.id === id)!,
      { status, transcript, verdict, reason },
    );
  },
  forMerges: async (ids: string[]) => state.rehearsals.filter((row) => ids.includes(row.mergeId as string)),
}));
vi.mock("../../lib/self-modify-merge/store.ts", () => ({
  liveUnjudged: async () => state.merges.filter((merge) => !state.verdicts.has(merge.id as string)),
  recordVerdict: async (id: string, verdict: string) => {
    state.verdicts.set(id, verdict);
  },
}));
vi.mock("../../lib/self-review/store.ts", () => ({
  reopenFinding: async (id: string) => {
    state.reopened.push(id);
  },
}));
vi.mock("../../lib/accounts.ts", () => ({
  getUser: async (id: string) => (id === "gone" ? null : { id, slackId: `U-${id}` }),
}));
vi.mock("../../lib/memory/access.ts", () => ({ resolveAccess: async () => ({ readableLevels: ["internal"], writeAccess: ["internal"] }) }));
vi.mock("../../lib/slack/api.ts", () => ({
  post: async (_endpoint: string, body: { channel: string; thread_ts?: string; text: string }) => {
    state.posts.push(body);
    return { ok: true, body: { ts: "9.9" } };
  },
}));

const { runRehearsals, outcomeText } = await import("../../lib/rehearsal/index.ts");
const { outcome, transcriptFrom } = await import("../../lib/rehearsal/judge.ts");
const { parseScenario, scenarioFromMessages } = await import("../../lib/rehearsal/scenarios.ts");

const PRIVATE = "my salary is 12000 and my manager is Ala";
const merge = (id: string, findingId: string | null) => ({
  id,
  pullNumber: 221,
  findingId,
  targetSource: findingId ? "finding" : "request",
  targetTitle: "Confirm desk bookings",
  targetProblem: "Booked a desk without asking",
  targetExpected: "Asks which day before booking",
  channelId: "C_SELF_REVIEW",
  threadTs: "1.0",
});
const rehearsal = (id: string, mergeId: string, extra: Record<string, unknown> = {}) => ({
  id,
  mergeId,
  userId: "person",
  channelId: "C_TEAM",
  evidenceLink: `https://slack.example/${id}`,
  scenario: { history: [{ role: "user", text: "earlier" }], message: PRIVATE },
  status: "pending",
  ...extra,
});
const finished = (reply: string) => [
  { type: "turn.started", data: {} },
  { type: "actions.requested", data: { actions: [{ callId: "c1", toolName: "reserve-desk", input: { day: "monday" } }] } },
  { type: "action.result", data: { result: { callId: "c1", toolName: "reserve-desk", output: "[rehearsal] not executed: reserve-desk" } } },
  { type: "message.completed", data: { message: reply, finishReason: "stop" } },
  { type: "turn.completed", data: {} },
  { type: "session.waiting", data: {} },
];

beforeEach(() => {
  state.merges = [];
  state.rehearsals = [];
  state.events = new Map();
  state.started = [];
  state.ended = [];
  state.posts = [];
  state.verdicts = new Map();
  state.reopened = [];
});

describe("scenarios", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 17, 10, minute));
  const messages = [
    { role: "user", content: "hi", receivedAt: at(0) },
    { role: "assistant", content: "hello", receivedAt: at(1) },
    { role: "user", content: "book me a desk", receivedAt: at(2) },
    { role: "user", content: "near the window", receivedAt: at(3) },
    { role: "assistant", content: "Booked desk 4 for today", receivedAt: at(4) },
    { role: "user", content: "that's wrong", receivedAt: at(5) },
  ];

  it("replays the person's messages that led to the rated reply, with the earlier thread as history", () => {
    expect(scenarioFromMessages(messages, at(4))).toEqual({
      history: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
      ],
      message: "book me a desk\n\nnear the window",
    });
  });

  it("has nothing to replay without a rated reply or a question before it", () => {
    expect(scenarioFromMessages(messages, new Date(Date.UTC(2026, 10, 17, 9)))).toBeNull();
    expect(scenarioFromMessages([{ role: "assistant", content: "hello", receivedAt: at(1) }], at(1))).toBeNull();
  });

  it("reads a written scenario only from well-formed JSON", () => {
    expect(parseScenario('```json\n{"message":"Book me a desk for Monday"}\n```')).toBe("Book me a desk for Monday");
    expect(parseScenario("sure!")).toBeNull();
    expect(parseScenario('{"message":""}')).toBeNull();
  });
});

describe("transcript and outcome", () => {
  it("reads the reply and the attempted tool calls once the session is waiting", () => {
    expect(transcriptFrom(finished("Which day?").slice(0, 4))).toBeNull();
    expect(transcriptFrom(finished("Which day?"))).toEqual({
      finished: "completed",
      reply: "Which day?",
      actions: [{ tool: "reserve-desk", input: { day: "monday" }, result: "[rehearsal] not executed: reserve-desk" }],
    });
  });

  it("is fixed only when every scenario is fixed and broken when any is", () => {
    expect(outcome(["fixed", "fixed"])).toBe("fixed");
    expect(outcome(["fixed", "still_broken", "unclear"])).toBe("still_broken");
    expect(outcome(["fixed", "unclear"])).toBe("unclear");
    expect(outcome([])).toBe("unclear");
  });

  it("posts reasons and evidence links, never the conversation", () => {
    const text = outcomeText(
      { pullNumber: 221, findingId: "f1" },
      [{ verdict: "still_broken", reason: "It booked <desk> & did not ask", evidenceLink: "https://slack.example/r1" }],
      "still_broken",
    );
    expect(text).toContain("<https://slack.example/r1|scenario 1>: still_broken, It booked &lt;desk&gt; &amp; did not ask");
    expect(text).toContain("I reopened the finding");
    expect(text).not.toContain(PRIVATE);
  });
});

describe("rehearsal runs", () => {
  const judge = vi.fn(async (_target: unknown, _scenario: unknown, transcript: { reply: string }) =>
    transcript.reply.includes("Which day")
      ? { verdict: "fixed" as const, reason: "It asked for the day first." }
      : { verdict: "still_broken" as const, reason: "It booked without asking." },
  );

  it("starts a headless session as the original person, never on Slack", async () => {
    state.merges = [merge("m1", "f1")];
    state.rehearsals = [rehearsal("r1", "m1")];
    await runRehearsals(judge);
    expect(state.started).toHaveLength(1);
    expect(state.started[0]).toMatchObject({ address: "rehearsal:r1", message: PRIVATE, history: [{ role: "user", text: "earlier" }] });
    expect(state.started[0].auth.attributes).toMatchObject({
      userId: "person",
      slackUserId: "U-person",
      kind: "rehearsal",
      channelId: "C_TEAM",
      readableLevels: ["internal"],
    });
    expect(state.started[0].auth.attributes.threadTs).toBeUndefined();
    expect(state.posts).toEqual([]);
  });

  it("posts fixed when every scenario behaves as expected", async () => {
    state.merges = [merge("m1", "f1")];
    state.rehearsals = [rehearsal("r1", "m1", { status: "running", sessionId: "s1", startedAt: new Date() })];
    state.events.set("s1", finished("Which day should I book it for?"));
    await runRehearsals(judge);
    expect(state.verdicts.get("m1")).toBe("fixed");
    expect(state.reopened).toEqual([]);
    expect(state.ended).toEqual(["s1"]);
    expect(state.posts[0]).toMatchObject({ channel: "C_SELF_REVIEW", thread_ts: "1.0" });
    expect(state.posts[0].text).toContain(":white_check_mark: Fixed");
    expect(state.posts[0].text).not.toContain("Which day should I book");
  });

  it("posts still broken and reopens the finding when any scenario still fails", async () => {
    state.merges = [merge("m1", "f1")];
    state.rehearsals = [
      rehearsal("r1", "m1", { status: "running", sessionId: "s1", startedAt: new Date() }),
      rehearsal("r2", "m1", { status: "running", sessionId: "s2", startedAt: new Date() }),
    ];
    state.events.set("s1", finished("Which day?"));
    state.events.set("s2", finished("Booked desk 4."));
    await runRehearsals(judge);
    expect(state.verdicts.get("m1")).toBe("still_broken");
    expect(state.reopened).toEqual(["f1"]);
    expect(state.posts[0].text).toContain(":x: Still broken");
    expect(state.posts[0].text).toContain("<https://slack.example/r2|scenario 2>");
    expect(state.posts[0].text).not.toContain(PRIVATE);
  });

  it("waits for a run in progress and calls it unclear after the timeout", async () => {
    state.merges = [merge("m1", null)];
    state.rehearsals = [rehearsal("r1", "m1", { status: "running", sessionId: "s1", startedAt: new Date() })];
    state.events.set("s1", finished("Which day?").slice(0, 3));
    await runRehearsals(judge);
    expect(state.verdicts.size).toBe(0);
    (state.rehearsals[0] as { startedAt: Date }).startedAt = new Date(Date.now() - 31 * 60_000);
    await runRehearsals(judge);
    expect(state.verdicts.get("m1")).toBe("unclear");
    expect(state.posts[0].text).toContain(":grey_question: Unclear");
  });

  it("calls it unclear when the judge fails or there was nothing to rehearse", async () => {
    state.merges = [merge("m1", null), merge("m2", null)];
    state.rehearsals = [rehearsal("r1", "m1", { status: "running", sessionId: "s1", startedAt: new Date() })];
    state.events.set("s1", finished("Which day?"));
    await runRehearsals(async () => {
      throw new Error("timeout");
    });
    expect(state.verdicts.get("m1")).toBe("unclear");
    expect(state.verdicts.get("m2")).toBe("unclear");
    expect(state.posts.map((entry) => entry.text).join("\n")).toContain("there was no scenario to rehearse");
  });
});
