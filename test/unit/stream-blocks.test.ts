import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  startStream: vi.fn(async (_channel: string, _threadTs: string, _opts: Record<string, unknown>): Promise<string | null> => "S1"),
  appendStream: vi.fn(async (_channel: string, _ts: string, _chunks: Record<string, unknown>[]) => ({ ok: true as boolean, error: "" })),
  stopStream: vi.fn(async (_channel: string, _ts: string, _chunks?: Record<string, unknown>[]) => ({ ok: true as boolean, error: "" })),
  setStatus: vi.fn(async () => ({ ok: true })),
  deleteMessage: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../lib/slack/api.ts", () => api);

const { ensureStream, getStream, sendBlocks } = await import("../../lib/slack/stream.ts");

const tick = () => vi.advanceTimersByTimeAsync(0);
const header = (text: string) => ({ type: "header", text: { type: "plain_text", text } });
let thread = 0;
const nextThread = () => `100.${++thread}`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  api.startStream.mockResolvedValue("S1");
  api.appendStream.mockResolvedValue({ ok: true, error: "" });
  api.stopStream.mockResolvedValue({ ok: true, error: "" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("StreamSession blocks", () => {
  it("keeps text and blocks in the order they were written", async () => {
    const stream = ensureStream("C1", nextThread(), null);
    stream.text("Przed ");
    const delivery = stream.blocks([header("Karta")]);
    stream.text("po.");
    await tick();
    expect(api.startStream.mock.calls[0][2].chunks).toEqual([
      { type: "markdown_text", text: "Przed " },
      { type: "blocks", blocks: [header("Karta")] },
      { type: "markdown_text", text: "po." },
    ]);
    expect(await delivery.delivered).toBe(true);
    await stream.discard();
  });

  it("appends later blocks between text chunks and reports a failed append", async () => {
    const stream = ensureStream("C1", nextThread(), null);
    stream.text("a");
    await tick();
    stream.text("b");
    const first = stream.blocks([header("1")]);
    stream.text("c");
    await vi.advanceTimersByTimeAsync(700);
    expect(api.appendStream.mock.calls[0][2]).toEqual([
      { type: "markdown_text", text: "b" },
      { type: "blocks", blocks: [header("1")] },
      { type: "markdown_text", text: "c" },
    ]);
    expect(await first.delivered).toBe(true);

    api.appendStream.mockResolvedValueOnce({ ok: false, error: "invalid_blocks" });
    const second = stream.blocks([header("2")]);
    await vi.advanceTimersByTimeAsync(700);
    expect(await second.delivered).toBe(false);
    await stream.discard();
  });

  it("can withdraw blocks that are still queued and never sends them", async () => {
    const stream = ensureStream("C1", nextThread(), null);
    stream.text("a");
    await tick();
    const delivery = stream.blocks([header("x")]);
    stream.text("b");
    expect(delivery.cancel()).toBe(true);
    expect(await delivery.delivered).toBe(false);
    await vi.advanceTimersByTimeAsync(700);
    expect(api.appendStream.mock.calls[0][2]).toEqual([{ type: "markdown_text", text: "b" }]);
    await stream.discard();
  });

  it("resends the text of a rejected append without its card blocks and stops there", async () => {
    const stream = ensureStream("C1", nextThread(), null);
    stream.text("a");
    await tick();
    api.appendStream.mockResolvedValueOnce({ ok: false, error: "invalid_blocks" });
    stream.text("b");
    const delivery = stream.blocks([header("x")]);
    stream.text("c");
    await vi.advanceTimersByTimeAsync(700);
    expect(await delivery.delivered).toBe(false);
    expect(api.appendStream.mock.calls.map((call) => call[2])).toEqual([
      [
        { type: "markdown_text", text: "b" },
        { type: "blocks", blocks: [header("x")] },
        { type: "markdown_text", text: "c" },
      ],
      [
        { type: "markdown_text", text: "b" },
        { type: "markdown_text", text: "c" },
      ],
    ]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.appendStream).toHaveBeenCalledTimes(2);
    await stream.discard();
  });

  it("starts without the card blocks when Slack rejects them in the first call", async () => {
    api.startStream.mockResolvedValueOnce(null);
    const stream = ensureStream("C1", nextThread(), null);
    stream.text("a");
    const delivery = stream.blocks([header("x")]);
    await tick();
    expect(await delivery.delivered).toBe(false);
    expect(api.startStream).toHaveBeenCalledTimes(2);
    expect(api.startStream.mock.calls[1][2].chunks).toEqual([{ type: "markdown_text", text: "a" }]);
    expect(stream.ts).toBe("S1");
    await stream.discard();
  });

  it("gives up starting after a few attempts so the reply is posted normally", async () => {
    api.startStream.mockResolvedValue(null);
    const stream = ensureStream("C1", nextThread(), null);
    stream.text("a");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.startStream).toHaveBeenCalledTimes(3);
    expect(await stream.blocks([header("x")]).delivered).toBe(false);
    expect(await stream.finish("a", [])).toBe("not_streaming");
  });

  it("resolves queued blocks as not delivered when the stream never started", async () => {
    api.startStream.mockResolvedValue(null);
    const stream = ensureStream("C1", nextThread(), null);
    const delivery = stream.blocks([header("x")]);
    await tick();
    expect(await stream.finish("odpowiedź", [])).toBe("not_streaming");
    expect(await delivery.delivered).toBe(false);
  });

  it("resolves blocks sent with stopStream from its result", async () => {
    const stream = ensureStream("C1", nextThread(), null);
    stream.text("a");
    await tick();
    const delivery = stream.blocks([header("x")]);
    await stream.finish("a", []);
    expect(api.stopStream.mock.calls[0][2]).toContainEqual({ type: "blocks", blocks: [header("x")] });
    expect(await delivery.delivered).toBe(true);
  });

  it("refuses blocks on a closed stream", async () => {
    const stream = ensureStream("C1", nextThread(), null);
    await stream.discard();
    const delivery = stream.blocks([header("x")]);
    expect(await delivery.delivered).toBe(false);
    expect(delivery.cancel()).toBe(false);
  });
});

describe("StreamSession card budget", () => {
  const table = { type: "table", rows: [] };

  it("keeps one table per message across calls", async () => {
    const stream = ensureStream("C1", nextThread(), null);
    const first = stream.blocks([table]);
    const second = stream.blocks([table]);
    const other = stream.blocks([header("x")]);
    await vi.advanceTimersByTimeAsync(700);
    expect(await first.delivered).toBe(true);
    expect(await second.delivered).toBe(false);
    expect(await other.delivered).toBe(true);
    await stream.discard();
  });

  it("frees the table when the block carrying it was rejected", async () => {
    const stream = ensureStream("C1", nextThread(), null);
    stream.text("a");
    await tick();
    api.appendStream.mockResolvedValueOnce({ ok: false, error: "invalid_blocks" });
    const first = stream.blocks([table]);
    await vi.advanceTimersByTimeAsync(700);
    expect(await first.delivered).toBe(false);
    const second = stream.blocks([table]);
    await vi.advanceTimersByTimeAsync(700);
    expect(await second.delivered).toBe(true);
    await stream.discard();
  });

  it("refuses a card table after a markdown table in the streamed text", async () => {
    const stream = ensureStream("C1", nextThread(), null);
    stream.text("| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(await stream.blocks([table]).delivered).toBe(false);
    await stream.discard();
  });

  it("leaves room for the feedback block", async () => {
    const stream = ensureStream("C1", nextThread(), null);
    const many = Array.from({ length: 49 }, (_, index) => header(`${index}`));
    const full = stream.blocks(many);
    expect(await stream.blocks([header("one more")]).delivered).toBe(false);
    expect(await full.delivered).toBe(true);
    await stream.discard();
  });
});

describe("StreamSession finish", () => {
  it("retries stopStream without card blocks so the answer is not lost", async () => {
    const stream = ensureStream("C1", nextThread(), null);
    stream.text("a");
    await tick();
    const delivery = stream.blocks([header("x")]);
    api.stopStream.mockResolvedValueOnce({ ok: false, error: "invalid_blocks" });
    expect(await stream.finish("a b", [{ type: "blocks", blocks: [{ type: "context" }] }])).toBe("ok");
    expect(await delivery.delivered).toBe(false);
    expect(api.stopStream.mock.calls[1][2]).toEqual([
      { type: "markdown_text", text: " b" },
      { type: "blocks", blocks: [{ type: "context" }] },
    ]);
  });

  it("reports an error when stopping fails for other reasons", async () => {
    const stream = ensureStream("C1", nextThread(), null);
    stream.text("a");
    await tick();
    api.stopStream.mockResolvedValueOnce({ ok: false, error: "message_not_found" });
    expect(await stream.finish("a", [])).toBe("error");
    expect(api.stopStream).toHaveBeenCalledTimes(1);
  });
});

describe("sendBlocks", () => {
  it("goes straight to an open stream", async () => {
    const threadTs = nextThread();
    const stream = ensureStream("C1", threadTs, null);
    const delivery = sendBlocks("C1", threadTs, [header("x")]);
    expect(delivery.waitingForStream()).toBe(false);
    await tick();
    expect(await delivery.delivered).toBe(true);
    await stream.discard();
  });

  it("buffers blocks until the stream is created and flushes them first, in order", async () => {
    const threadTs = nextThread();
    const first = sendBlocks("C1", threadTs, [header("1")]);
    const second = sendBlocks("C1", threadTs, [header("2")]);
    expect(first.waitingForStream()).toBe(true);
    expect(getStream("C1", threadTs)).toBeUndefined();
    await tick();
    expect(api.startStream).not.toHaveBeenCalled();

    const stream = ensureStream("C1", threadTs, null);
    stream.task({ id: "call", title: "Show card", status: "in_progress" });
    await tick();
    expect(api.startStream.mock.calls[0][2].chunks).toEqual([
      { type: "blocks", blocks: [header("1")] },
      { type: "blocks", blocks: [header("2")] },
      { type: "task_update", id: "call", title: "Show card", status: "in_progress" },
    ]);
    expect(first.waitingForStream()).toBe(false);
    expect(await first.delivered).toBe(true);
    expect(await second.delivered).toBe(true);
    await stream.discard();
  });

  it("drops cancelled buffered blocks so a later stream never shows them", async () => {
    const threadTs = nextThread();
    const kept = sendBlocks("C1", threadTs, [header("kept")]);
    const cancelled = sendBlocks("C1", threadTs, [header("cancelled")]);
    expect(cancelled.cancel()).toBe(true);
    expect(cancelled.cancel()).toBe(false);
    expect(await cancelled.delivered).toBe(false);

    const stream = ensureStream("C1", threadTs, null);
    stream.text("x");
    await tick();
    expect(api.startStream.mock.calls[0][2].chunks).toEqual([
      { type: "blocks", blocks: [header("kept")] },
      { type: "markdown_text", text: "x" },
    ]);
    expect(await kept.delivered).toBe(true);
    await stream.discard();
  });

  it("keeps buffers of different threads apart", async () => {
    const a = nextThread();
    const b = nextThread();
    sendBlocks("C1", a, [header("a")]);
    const other = sendBlocks("C1", b, [header("b")]);
    const stream = ensureStream("C1", a, null);
    await tick();
    expect(api.startStream.mock.calls[0][2].chunks).toEqual([{ type: "blocks", blocks: [header("a")] }]);
    expect(other.waitingForStream()).toBe(true);
    other.cancel();
    await stream.discard();
  });
});

describe("StreamSession text after a card table", () => {
  const table = { type: "table", rows: [] };
  const sentText = () =>
    [
      ...api.startStream.mock.calls.flatMap((call) => call[2].chunks as Record<string, any>[]),
      ...api.appendStream.mock.calls.flatMap((call) => call[2]),
      ...api.stopStream.mock.calls.flatMap((call) => call[2] ?? []),
    ]
      .filter((chunk) => chunk.type === "markdown_text")
      .map((chunk) => chunk.text)
      .join("");

  it("streams later markdown tables as plain rows, even when split across deltas", async () => {
    const stream = ensureStream("C1", nextThread(), null);
    stream.blocks([table]);
    const text = "Wyniki:\n| a | b |\n|---|-";
    for (const delta of [text, "--|\n| 1 | 2 |\n", "koniec"]) stream.text(delta);
    await vi.advanceTimersByTimeAsync(700);
    expect(await stream.finish("Wyniki:\n| a | b |\n|---|---|\n| 1 | 2 |\nkoniec", [])).toBe("ok");
    expect(sentText()).toBe("Wyniki:\n| a | b |\n| 1 | 2 |\nkoniec");
  });

  it("strips the separator from a table that only arrives in the final reply", async () => {
    const stream = ensureStream("C1", nextThread(), null);
    stream.text("Patrz:\n");
    stream.blocks([table]);
    await vi.advanceTimersByTimeAsync(700);
    expect(await stream.finish("Patrz:\n| x |\n| --- |\n| y |", [])).toBe("ok");
    expect(sentText()).toBe("Patrz:\n| x |\n| y |");
  });

  it("keeps markdown tables untouched while no card table was streamed", async () => {
    const stream = ensureStream("C1", nextThread(), null);
    stream.text("| a |\n|---|\n| 1 |\n");
    await tick();
    expect(sentText()).toBe("| a |\n|---|\n| 1 |\n");
    await stream.discard();
  });
});
