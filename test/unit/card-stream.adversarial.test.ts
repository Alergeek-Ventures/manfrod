import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCtx } from "../../lib/agent/context.ts";

const api = vi.hoisted(() => ({
  post: vi.fn(async (_endpoint: string, _body: Record<string, unknown>) => ({ ok: true as boolean, body: {}, error: "" })),
  startStream: vi.fn(async (_channel: string, _threadTs: string, _opts: Record<string, any>): Promise<string | null> => "S1"),
  appendStream: vi.fn(async (_channel: string, _ts: string, _chunks: Record<string, any>[]) => ({ ok: true as boolean, error: "" })),
  stopStream: vi.fn(async (_channel: string, _ts: string, _chunks?: Record<string, any>[]) => ({ ok: true as boolean, error: "" })),
  setStatus: vi.fn(async () => ({ ok: true })),
  deleteMessage: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../lib/slack/api.ts", () => api);

const { cancelCardCall, cardStreamThread, showCard, streamCardInput } = await import("../../lib/slack/card-stream.ts");
const { ensureStream, sendBlocks } = await import("../../lib/slack/stream.ts");
const hook = (await import("../../agent/hooks/card-stream.ts")).default as any;

const tick = () => vi.advanceTimersByTimeAsync(0);
let counter = 0;
const nextId = () => `${++counter}`;
let threadCounter = 0;
const nextThread = () => `900.${++threadCounter}`;

const ctx = (channel: string, threadTs: string | null): ToolCtx => ({
  userId: "u1",
  readableLevels: [],
  writeAccess: [],
  msgCtx: { channel, ts: null, threadTs, slackUserId: "U1" },
  kind: "slack",
  sessionKey: null,
  findingId: null,
  taskId: null,
  capabilityRequestId: null,
});

const divider = { type: "divider" };
const header = (text: string) => ({ type: "header", text });
const input = (items: unknown[]) => JSON.stringify({ elements: items });
const feed = (callId: string, thread: { channel: string; threadTs: string }, json: string, size: number) => {
  for (let index = 0; index < json.length; index += size) streamCardInput(callId, thread, json.slice(index, index + size));
};
const posted = () => api.post.mock.calls.filter(([endpoint]) => endpoint === "chat.postMessage");
const postedBlocks = () => posted().flatMap(([, body]) => body.blocks as { type: string }[]);
const allSentChunks = () => [
  ...api.startStream.mock.calls.flatMap((call) => call[2].chunks as Record<string, any>[]),
  ...api.appendStream.mock.calls.flatMap((call) => call[2]),
  ...api.stopStream.mock.calls.flatMap((call) => call[2] ?? []),
];
const sentHeaders = () =>
  allSentChunks()
    .filter((chunk) => chunk.type === "blocks")
    .flatMap((chunk) => chunk.blocks.map((block: any) => block.text?.text ?? block.type));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  api.startStream.mockResolvedValue("S1");
  api.appendStream.mockResolvedValue({ ok: true, error: "" });
  api.stopStream.mockResolvedValue({ ok: true, error: "" });
  api.post.mockResolvedValue({ ok: true, body: {}, error: "" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("exactly-once delivery", () => {
  it("shows every element exactly once for random delta sizes, whether streamed or posted", async () => {
    const items = [
      header("h1"),
      { type: "section", text: 'a "b" } ] \\ \u{1F600}' },
      null,
      5,
      divider,
      header("h2"),
      { nope: true },
      header("h3"),
    ];
    for (const size of [1, 2, 3, 7, 13, 50, 10_000]) {
      vi.clearAllMocks();
      const thread = { channel: "C1", threadTs: nextThread() };
      const stream = ensureStream(thread.channel, thread.threadTs, null);
      const callId = `rand-${size}-${nextId()}`;
      feed(callId, thread, input(items), size);
      await tick();
      const outcome = await showCard(callId, items, ctx(thread.channel, thread.threadTs));
      await stream.discard();
      expect(outcome).toMatchObject({ streamed: 5, posted: 0, error: null });
      expect(outcome.dropped.map((item) => item.index)).toEqual([2, 3, 6]);
      expect(sentHeaders().filter((value) => value === "h1")).toHaveLength(1);
      expect(posted()).toHaveLength(0);
    }
  });

  it("posts only the elements that did not reach Slack when a later append fails", async () => {
    const thread = { channel: "C1", threadTs: nextThread() };
    const stream = ensureStream(thread.channel, thread.threadTs, null);
    const items = [header("first"), header("second"), header("third")];
    const json = input(items);
    const callId = `partial-${nextId()}`;
    const cut = json.indexOf('{"type":"header","text":"second"}') + 5;
    feed(callId, thread, json.slice(0, cut), 9);
    await tick();
    expect(sentHeaders()).toEqual(["first"]);
    api.appendStream.mockResolvedValueOnce({ ok: false, error: "msg_too_long" });
    feed(callId, thread, json.slice(cut), 9);
    const pending = showCard(callId, items, ctx(thread.channel, thread.threadTs));
    await vi.advanceTimersByTimeAsync(2000);
    const outcome = await pending;
    expect(outcome).toMatchObject({ streamed: 1, posted: 2, error: null });
    expect(postedBlocks().map((block: any) => block.text.text)).toEqual(["second", "third"]);
    expect(sentHeaders().filter((value) => value === "first")).toHaveLength(1);
    await stream.discard();
  });

  it("posts the whole card once when the tool runs without any deltas", async () => {
    const outcome = await showCard(`nodeltas-${nextId()}`, [header("a"), divider], ctx("C1", nextThread()));
    expect(outcome).toMatchObject({ streamed: 0, posted: 2 });
    expect(posted()).toHaveLength(1);
  });

  it("reports the stream as not used when the tool runs with a partial delta only", async () => {
    const thread = { channel: "C1", threadTs: nextThread() };
    const callId = `half-${nextId()}`;
    streamCardInput(callId, thread, '{"elements":[{"type":"header","text":"a"},{"type":"header","te');
    const pending = showCard(callId, [header("a"), header("b")], ctx(thread.channel, thread.threadTs));
    await vi.advanceTimersByTimeAsync(2000);
    const outcome = await pending;
    expect(outcome).toMatchObject({ streamed: 0, posted: 2 });
    expect(posted()).toHaveLength(1);
  });

  it("drops more than 50 elements whether they arrive in one delta or many, streaming at most 49 blocks next to the feedback block", async () => {
    for (const size of [10_000, 3]) {
      vi.clearAllMocks();
      const thread = { channel: "C1", threadTs: nextThread() };
      const stream = ensureStream(thread.channel, thread.threadTs, null);
      const items = Array.from({ length: 80 }, (_, index) => header(`h${index}`));
      const callId = `many-${size}-${nextId()}`;
      feed(callId, thread, input(items), size);
      await tick();
      const outcome = await showCard(callId, items, ctx(thread.channel, thread.threadTs));
      await stream.discard();
      expect(outcome).toMatchObject({ streamed: 49, posted: 1 });
      expect(outcome.dropped).toHaveLength(30);
      const chunks = allSentChunks().filter((chunk) => chunk.type === "blocks");
      expect(chunks.flatMap((chunk) => chunk.blocks)).toHaveLength(49);
      expect(postedBlocks().map((block: any) => block.text.text)).toEqual(["h49"]);
      for (const chunk of chunks) expect(chunk.blocks.length).toBeLessThanOrEqual(50);
    }
  });

  it("streams one table per message: a second table in the same call is dropped, one from another call is posted instead", async () => {
    const thread = { channel: "C1", threadTs: nextThread() };
    const stream = ensureStream(thread.channel, thread.threadTs, null);
    const table = { type: "table", rows: [["a"]] };
    feed("tbl-1", thread, input([table, table]), 4);
    feed("tbl-2", thread, input([table]), 4);
    await tick();
    expect(
      allSentChunks()
        .filter((chunk) => chunk.type === "blocks")
        .flatMap((chunk) => chunk.blocks),
    ).toHaveLength(1);
    cancelCardCall("tbl-1");
    expect(await showCard("tbl-2", [table], ctx(thread.channel, thread.threadTs))).toMatchObject({ streamed: 0, posted: 1 });
    await stream.discard();
  });
});

describe("stream lifecycle", () => {
  it("posts what was buffered when the stream is closed mid-call and later elements arrive", async () => {
    const thread = { channel: "C1", threadTs: nextThread() };
    const stream = ensureStream(thread.channel, thread.threadTs, null);
    const items = [header("early"), header("late")];
    const json = input(items);
    const callId = `closed-${nextId()}`;
    const cut = json.indexOf('{"type":"header","text":"late"}');
    feed(callId, thread, json.slice(0, cut), 6);
    await tick();
    await stream.finish("answer", []);
    feed(callId, thread, json.slice(cut), 6);
    const pending = showCard(callId, items, ctx(thread.channel, thread.threadTs));
    await vi.advanceTimersByTimeAsync(2000);
    const outcome = await pending;
    expect(outcome).toMatchObject({ streamed: 1, posted: 1, error: null });
    expect(postedBlocks().map((block: any) => block.text.text)).toEqual(["late"]);
  });

  it("does not leak cancelled buffered blocks into the next turn's stream in the same thread", async () => {
    const thread = { channel: "C1", threadTs: nextThread() };
    const callId = `leak-${nextId()}`;
    feed(callId, thread, input([header("stale")]), 8);
    const pending = showCard(callId, [header("stale")], ctx(thread.channel, thread.threadTs));
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    const next = ensureStream(thread.channel, thread.threadTs, null);
    next.text("hello");
    await tick();
    expect(allSentChunks().filter((chunk) => chunk.type === "blocks")).toEqual([]);
    await next.discard();
  });

  it("keeps two concurrent calls in different threads apart", async () => {
    const a = { channel: "C1", threadTs: nextThread() };
    const b = { channel: "C1", threadTs: nextThread() };
    const streamA = ensureStream(a.channel, a.threadTs, null);
    const streamB = ensureStream(b.channel, b.threadTs, null);
    const jsonA = input([header("A1"), header("A2")]);
    const jsonB = input([header("B1"), header("B2")]);
    for (let index = 0; index < Math.max(jsonA.length, jsonB.length); index += 5) {
      streamCardInput("conc-a", a, jsonA.slice(index, index + 5));
      streamCardInput("conc-b", b, jsonB.slice(index, index + 5));
    }
    await tick();
    const startedFor = (thread: { threadTs: string }) =>
      api.startStream.mock.calls
        .find((call) => call[1] === thread.threadTs)![2]
        .chunks.flatMap((chunk: any) => chunk.blocks.map((block: any) => block.text.text));
    expect(startedFor(a)).toEqual(["A1", "A2"]);
    expect(startedFor(b)).toEqual(["B1", "B2"]);
    expect(await showCard("conc-a", [header("A1"), header("A2")], ctx(a.channel, a.threadTs))).toMatchObject({ streamed: 2, posted: 0 });
    expect(await showCard("conc-b", [header("B1"), header("B2")], ctx(b.channel, b.threadTs))).toMatchObject({ streamed: 2, posted: 0 });
    await streamA.discard();
    await streamB.discard();
  });

  it("keeps two interleaved calls in the same thread apart by call id", async () => {
    const thread = { channel: "C1", threadTs: nextThread() };
    const stream = ensureStream(thread.channel, thread.threadTs, null);
    const jsonA = input([header("A1"), header("A2")]);
    const jsonB = input([header("B1")]);
    for (let index = 0; index < jsonA.length; index += 4) {
      streamCardInput("same-a", thread, jsonA.slice(index, index + 4));
      streamCardInput("same-b", thread, jsonB.slice(index, index + 4));
    }
    await tick();
    expect(sentHeaders().sort()).toEqual(["A1", "A2", "B1"]);
    expect(await showCard("same-a", [header("A1"), header("A2")], ctx(thread.channel, thread.threadTs))).toMatchObject({
      streamed: 2,
      posted: 0,
    });
    expect(await showCard("same-b", [header("B1")], ctx(thread.channel, thread.threadTs))).toMatchObject({ streamed: 1, posted: 0 });
    await stream.discard();
  });

  it("keeps blocks and text in write order across batches", async () => {
    const thread = { channel: "C1", threadTs: nextThread() };
    const stream = ensureStream(thread.channel, thread.threadTs, null);
    stream.text("one ");
    sendBlocks(thread.channel, thread.threadTs, [{ type: "divider" }]);
    stream.text("two ");
    sendBlocks(thread.channel, thread.threadTs, [{ type: "divider" }]);
    stream.text("three");
    await tick();
    expect(api.startStream.mock.calls[0][2].chunks.map((chunk: any) => (chunk.type === "blocks" ? "B" : chunk.text))).toEqual([
      "one ",
      "B",
      "two ",
      "B",
      "three",
    ]);
    await stream.discard();
  });

  it("rejects delivery when appendStream throws-like failures repeat and never double-posts", async () => {
    api.appendStream.mockResolvedValue({ ok: false, error: "ratelimited" });
    const thread = { channel: "C1", threadTs: nextThread() };
    const stream = ensureStream(thread.channel, thread.threadTs, null);
    stream.text("x");
    await tick();
    const items = [header("a"), header("b")];
    const callId = `fail-${nextId()}`;
    feed(callId, thread, input(items), 5);
    const pending = showCard(callId, items, ctx(thread.channel, thread.threadTs));
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toMatchObject({ streamed: 0, posted: 2 });
    expect(posted()).toHaveLength(1);
    await stream.discard();
  });
});

describe("late and repeated input", () => {
  it("ignores late deltas after the result when they are only a fragment", () => {
    const thread = { channel: "C1", threadTs: nextThread() };
    const callId = `late-${nextId()}`;
    feed(callId, thread, input([divider]), 5);
    cancelCardCall(callId);
    expect(streamCardInput(callId, thread, '"}]}')).toBeNull();
    cancelCardCall(callId);
  });

  it("is safe to cancel unknown calls and to cancel twice", () => {
    expect(() => {
      cancelCardCall("never-seen");
      cancelCardCall("never-seen");
    }).not.toThrow();
  });
});

describe("hook", () => {
  const event = (toolName: string, callId: string, delta: string) => ({ data: { toolName, callId, inputTextDelta: delta } });
  const hookCtx = (channel: string | null, threadTs: string | null, kind = "slack") => ({
    session: {
      auth: {
        current: { principalId: "p", attributes: { ...(channel ? { channelId: channel } : {}), ...(threadTs ? { threadTs } : {}), kind } },
        initiator: null,
      },
    },
  });

  it("streams only show-card deltas for Slack turns with a thread", async () => {
    const threadTs = nextThread();
    const stream = ensureStream("C1", threadTs, null);
    const json = input([header("hooked")]);
    hook.events["action.input.appended"](event("other-tool", "hk-1", json), hookCtx("C1", threadTs));
    hook.events["action.input.appended"](event("show-card", "hk-2", json), hookCtx("C1", null));
    hook.events["action.input.appended"](event("show-card", "hk-3", json), hookCtx("C1", threadTs, "task"));
    await tick();
    expect(sentHeaders()).toEqual([]);
    hook.events["action.input.appended"](event("show-card", "hk-4", json), hookCtx("C1", threadTs));
    await tick();
    expect(sentHeaders()).toEqual(["hooked"]);
    hook.events["action.result"]({ data: { result: { callId: "hk-4" } } });
    await stream.discard();
  });

  it("does not throw on an empty delta or when auth is missing", () => {
    expect(() => hook.events["action.input.appended"](event("show-card", "hk-5", ""), hookCtx("C1", nextThread()))).not.toThrow();
    expect(() =>
      hook.events["action.input.appended"](event("show-card", "hk-6", "{}"), { session: { auth: { current: null, initiator: null } } }),
    ).not.toThrow();
    cancelCardCall("hk-5");
  });

  it("cardStreamThread is null for background kinds", () => {
    expect(cardStreamThread({ ...ctx("C1", "1.1"), kind: "self_review" })).toBeNull();
  });
});
