import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCtx } from "../../lib/agent/context.ts";

const api = vi.hoisted(() => ({
  post: vi.fn(async (_endpoint: string, _body: Record<string, unknown>) => ({ ok: true as boolean, body: {}, error: "" })),
  startStream: vi.fn(async (_channel: string, _threadTs: string, _opts: Record<string, unknown>): Promise<string | null> => "S1"),
  appendStream: vi.fn(async () => ({ ok: true, error: "" })),
  stopStream: vi.fn(async () => ({ ok: true, error: "" })),
  setStatus: vi.fn(async () => ({ ok: true })),
  deleteMessage: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../lib/slack/api.ts", () => api);

const { turnThread } = await import("../../lib/agent/context.ts");
const { cancelCardCall, cardRefusal, cardStreamThread, describeCardOutcome, endCardTurn, showCard, streamCardInput } =
  await import("../../lib/slack/card-stream.ts");
const { ensureStream } = await import("../../lib/slack/stream.ts");

const tick = () => vi.advanceTimersByTimeAsync(0);
let counter = 0;
const nextId = () => `${++counter}`;

const ctx = (overrides: Partial<ToolCtx> & { channel?: string | null; threadTs?: string | null } = {}): ToolCtx => ({
  userId: "u1",
  readableLevels: [],
  writeAccess: [],
  msgCtx: {
    channel: overrides.channel === undefined ? "D1" : overrides.channel,
    ts: null,
    threadTs: overrides.threadTs === undefined ? "1.1" : overrides.threadTs,
    slackUserId: "U1",
  },
  kind: overrides.kind ?? "slack",
  sessionKey: null,
  findingId: null,
  taskId: null,
  capabilityRequestId: null,
});

const elements = [
  { type: "header", text: "Urlopy" },
  {
    type: "table",
    rows: [
      ["Kto", "Kiedy"],
      ["Ania", "pon"],
    ],
  },
  { type: "table", rows: [["drugi"]] },
  { type: "divider" },
];

const input = (items: unknown[]) => JSON.stringify({ elements: items });

function feed(callId: string, thread: { channel: string; threadTs: string }, json: string, size = 7) {
  for (let index = 0; index < json.length; index += size) streamCardInput(callId, thread, json.slice(index, index + size));
}

const posted = () => api.post.mock.calls.filter(([endpoint]) => endpoint === "chat.postMessage");

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  api.startStream.mockResolvedValue("S1");
  api.post.mockResolvedValue({ ok: true, body: {}, error: "" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cardStreamThread", () => {
  it("streams only interactive Slack turns with a thread", () => {
    expect(cardStreamThread(ctx())).toEqual({ channel: "D1", threadTs: "1.1" });
    expect(cardStreamThread(ctx({ channel: "C1" }))).toEqual({ channel: "C1", threadTs: "1.1" });
    for (const kind of ["skill_channel", "skill_user", "self_review", "task"]) expect(cardStreamThread(ctx({ kind }))).toBeNull();
    expect(cardStreamThread(ctx({ threadTs: null }))).toBeNull();
    expect(cardStreamThread(ctx({ channel: null }))).toBeNull();
  });
});

describe("turnThread", () => {
  it("prefers the Slack channel state and falls back to the turn's auth thread", () => {
    const tool = ctx({ channel: "C1", threadTs: "1.1" });
    expect(turnThread(tool)).toEqual({ channel: "C1", threadTs: "1.1" });
    expect(turnThread(tool, { channelId: "C2", threadTs: "2.2" })).toEqual({ channel: "C2", threadTs: "2.2" });
    expect(turnThread(tool, { channelId: undefined, threadTs: null })).toEqual({ channel: "C1", threadTs: "1.1" });
  });

  it("puts the hook's cards in the stream the renderer opens for the same turn", async () => {
    const tool = ctx({ channel: "C1", threadTs: nextId() });
    const thread = cardStreamThread(tool)!;
    const renderer = turnThread(tool, { channelId: tool.msgCtx.channel, threadTs: tool.msgCtx.threadTs });
    streamCardInput("call-same-thread", thread, input([{ type: "divider" }]));
    const stream = ensureStream(renderer.channel!, renderer.threadTs!, null);
    await tick();
    expect(api.startStream.mock.calls[0][2].chunks).toEqual([{ type: "blocks", blocks: [{ type: "divider" }] }]);
    expect(await showCard("call-same-thread", [{ type: "divider" }], tool)).toMatchObject({ streamed: 1, posted: 0 });
    await stream.discard();
  });
});

describe("streamCardInput", () => {
  it("streams each element as it completes and applies per-call limits", async () => {
    const thread = { channel: "C1", threadTs: nextId() };
    const stream = ensureStream(thread.channel, thread.threadTs, null);
    const batches = [];
    const json = input(elements);
    for (let index = 0; index < json.length; index += 5) {
      const batch = streamCardInput("call-limits", thread, json.slice(index, index + 5));
      if (batch) batches.push(batch);
    }
    expect(batches.flatMap((batch) => batch.blocks.map((block) => block.type))).toEqual(["header", "table", "divider"]);
    expect(batches.reduce((sum, batch) => sum + batch.dropped, 0)).toBe(1);
    await tick();
    const chunks = api.startStream.mock.calls[0][2].chunks as { type: string; blocks: { type: string }[] }[];
    expect(chunks.flatMap((chunk) => chunk.blocks.map((block) => block.type))).toEqual(["header", "table", "divider"]);
    cancelCardCall("call-limits");
    await stream.discard();
  });

  it("keeps limits separate for each call", () => {
    const thread = { channel: "C1", threadTs: nextId() };
    const table = input([{ type: "table", rows: [["a"]] }]);
    expect(streamCardInput("call-a", thread, table)?.blocks.map((block) => block.type)).toEqual(["table"]);
    expect(streamCardInput("call-b", thread, table)?.blocks.map((block) => block.type)).toEqual(["table"]);
    cancelCardCall("call-a");
    cancelCardCall("call-b");
  });
});

describe("showCard", () => {
  it("does not post a card that was streamed", async () => {
    const thread = { channel: "C1", threadTs: nextId() };
    const stream = ensureStream(thread.channel, thread.threadTs, null);
    feed("call-streamed", thread, input(elements));
    await tick();
    const outcome = await showCard("call-streamed", elements, ctx(thread));
    expect(posted()).toHaveLength(0);
    expect(outcome).toMatchObject({ streamed: 3, posted: 0, error: null });
    expect(outcome.dropped).toEqual([{ index: 2, type: "table", reason: "a card holds at most one table" }]);
    await stream.discard();
  });

  it("posts the whole card when no stream ever appears and never streams it later", async () => {
    const thread = { channel: "C1", threadTs: nextId() };
    feed("call-no-stream", thread, input(elements));
    const pending = showCard("call-no-stream", elements, ctx(thread));
    await vi.advanceTimersByTimeAsync(1500);
    const outcome = await pending;
    expect(outcome).toMatchObject({ streamed: 0, posted: 3, error: null });
    const [, body] = posted()[0];
    expect(body).toMatchObject({ channel: "C1", thread_ts: thread.threadTs, text: "Urlopy" });
    expect((body.blocks as { type: string }[]).map((block) => block.type)).toEqual(["header", "table", "divider"]);

    const stream = ensureStream(thread.channel, thread.threadTs, null);
    stream.text("x");
    await tick();
    expect(api.startStream.mock.calls.at(-1)![2].chunks).toEqual([{ type: "markdown_text", text: "x" }]);
    await stream.discard();
  });

  it("uses a stream that appears during the grace period", async () => {
    const thread = { channel: "C1", threadTs: nextId() };
    feed("call-late-stream", thread, input(elements));
    const pending = showCard("call-late-stream", elements, ctx(thread));
    await vi.advanceTimersByTimeAsync(200);
    const stream = ensureStream(thread.channel, thread.threadTs, null);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ streamed: 3, posted: 0 });
    expect(posted()).toHaveLength(0);
    await stream.discard();
  });

  it("posts only what did not reach Slack when the stream fails", async () => {
    api.startStream.mockResolvedValue(null);
    const thread = { channel: "C1", threadTs: nextId() };
    const stream = ensureStream(thread.channel, thread.threadTs, null);
    feed("call-failing", thread, input(elements));
    const pending = showCard("call-failing", elements, ctx(thread));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ streamed: 0, posted: 3 });
    expect(posted()).toHaveLength(1);
    api.startStream.mockResolvedValue("S1");
    stream.text("odpowiedź");
    await vi.advanceTimersByTimeAsync(700);
    expect(api.startStream.mock.calls.at(-1)![2].chunks).toEqual([{ type: "markdown_text", text: "odpowiedź" }]);
    await stream.discard();
  });

  it("posts the card in non-streaming contexts and lists dropped elements with their real index", async () => {
    const items = ["not an element", { type: "header", text: "Status" }, { type: "chart" }, { type: "section", text: "Wszystko *działa*" }];
    const outcome = await showCard("call-task", items, ctx({ kind: "task", channel: "C9", threadTs: null }));
    expect(outcome).toMatchObject({ streamed: 0, posted: 2, error: null });
    expect(posted()[0][1]).not.toHaveProperty("thread_ts");
    expect(outcome.dropped.map((item) => [item.index, item.type])).toEqual([
      [0, undefined],
      [2, "chart"],
    ]);
    const text = describeCardOutcome(outcome);
    expect(text).toContain("Card posted in the thread.");
    expect(text).toContain("elements[2] (chart)");
  });

  it("reports tables cut to fit next to dropped elements", async () => {
    const rows = Array.from({ length: 120 }, (_, index) => [`r${index}`]);
    const outcome = await showCard("call-big-table", [{ type: "table", rows }, { type: "nope" }], ctx({ channel: "C9" }));
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toMatchObject({ index: 0, type: "table" });
    const text = describeCardOutcome(outcome);
    expect(text).toContain("elements[1] (nope)");
    expect(text).toContain("Shown but cut short");
    expect(text).toContain("elements[0] (table): table truncated");
  });

  it("reports a failed post and a card with nothing to show", async () => {
    api.post.mockResolvedValueOnce({ ok: false, body: {}, error: "channel_not_found" });
    const failed = await showCard("call-fail", [{ type: "divider" }], ctx({ channel: "C9" }));
    expect(describeCardOutcome(failed)).toBe("Could not post the card: channel_not_found.");
    const empty = await showCard("call-empty", [{ type: "nope" }], ctx({ channel: "C9" }));
    expect(posted()).toHaveLength(1);
    expect(describeCardOutcome(empty)).toContain("Nothing was shown");
  });
});

describe("call lifecycle", () => {
  it("ignores a complete delta that arrives after the result", () => {
    const thread = { channel: "C1", threadTs: nextId() };
    const json = input([{ type: "divider" }]);
    expect(streamCardInput("call-late", thread, json)).not.toBeNull();
    cancelCardCall("call-late");
    expect(streamCardInput("call-late", thread, json)).toBeNull();
  });

  it("drops an ended turn's buffered card so the next turn's stream never shows it", async () => {
    const thread = { channel: "C1", threadTs: nextId() };
    streamCardInput("call-old-turn", thread, input([{ type: "header", text: "stary" }]), "turn-1");
    streamCardInput("call-other-turn", thread, input([{ type: "header", text: "nowy" }]), "turn-2");
    endCardTurn("turn-1");
    expect(streamCardInput("call-old-turn", thread, input([{ type: "divider" }]))).toBeNull();
    const stream = ensureStream(thread.channel, thread.threadTs, null);
    await tick();
    const chunks = api.startStream.mock.calls[0][2].chunks as { blocks: { text: { text: string } }[] }[];
    expect(chunks.flatMap((chunk) => chunk.blocks.map((block) => block.text.text))).toEqual(["nowy"]);
    endCardTurn("turn-2");
    await stream.discard();
  });

  it("does not wait forever on a request in flight and counts it as shown", async () => {
    const thread = { channel: "C1", threadTs: nextId() };
    const stream = ensureStream(thread.channel, thread.threadTs, null);
    api.startStream.mockReturnValueOnce(new Promise(() => {}));
    feed("call-hanging", thread, input([{ type: "divider" }]));
    const pending = showCard("call-hanging", [{ type: "divider" }], ctx(thread));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ streamed: 1, posted: 0 });
    expect(posted()).toHaveLength(0);
    void stream.discard();
  });
});

describe("cardRefusal", () => {
  it("keeps cards out of self-review and task runs", () => {
    expect(cardRefusal("self_review")).toContain("Self-review");
    expect(cardRefusal("task")).toContain("post-slack-message");
    expect(cardRefusal("slack")).toBeNull();
    expect(cardRefusal("skill_user")).toBeNull();
  });
});
