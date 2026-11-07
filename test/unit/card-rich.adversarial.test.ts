import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCtx } from "../../lib/agent/context.ts";

type Body = Record<string, any>;

const api = vi.hoisted(() => ({
  post: vi.fn(async (_endpoint: string, _body: Record<string, unknown>) => ({ ok: true as boolean, body: {}, error: "" })),
  startStream: vi.fn(async (_channel: string, _threadTs: string, _opts: Record<string, any>): Promise<string | null> => "S1"),
  appendStream: vi.fn(async (_channel: string, _ts: string, _chunks: Body[]) => ({ ok: true as boolean, error: "" })),
  stopStream: vi.fn(async (_channel: string, _ts: string, _chunks?: Body[]) => ({ ok: true as boolean, error: "" })),
  setStatus: vi.fn(async () => ({ ok: true })),
  deleteMessage: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../lib/slack/api.ts", () => api);

const { CARD_LIMITS, cardToBlocks, countCharts, plainBlocks, parseElement, blockWeight } = await import("../../lib/slack/cards.ts");
const { answeredBlocks, replyLabel } = await import("../../lib/slack/card-actions.ts");
const { showCard, streamCardInput, cancelCardCall } = await import("../../lib/slack/card-stream.ts");
const { ensureStream } = await import("../../lib/slack/stream.ts");

const tick = () => vi.advanceTimersByTimeAsync(0);
let counter = 0;
const nextId = () => `7${++counter}.1`;

const ctx = (channel: string, threadTs: string): ToolCtx => ({
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

const invalidBlocks = { ok: false, body: {}, error: "invalid_blocks" };
const posted = () => api.post.mock.calls.filter(([endpoint]) => endpoint === "chat.postMessage").map(([, body]) => body as Body);
const sentChunks = () => [
  ...api.startStream.mock.calls.flatMap((call) => (call[2].chunks ?? []) as Body[]),
  ...api.appendStream.mock.calls.flatMap((call) => call[2]),
  ...api.stopStream.mock.calls.flatMap((call) => call[2] ?? []),
];
const sentBlocks = () =>
  sentChunks()
    .filter((chunk) => chunk.type === "blocks")
    .flatMap((chunk) => chunk.blocks as Body[]);
const sentText = () =>
  sentChunks()
    .filter((chunk) => chunk.type === "markdown_text")
    .map((chunk) => chunk.text)
    .join("");

const chart = (over: Body = {}) => ({
  type: "chart",
  kind: "line",
  title: "T",
  categories: ["a", "b"],
  series: [{ name: "s", values: [1, 2] }],
  ...over,
});
const accepted = (element: unknown) => cardToBlocks([element]).blocks.length === 1;
const rejected = (element: unknown) => cardToBlocks([element]).dropped.length === 1;
const build = (element: unknown) => cardToBlocks([element]).blocks[0] as Body;

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

describe("chart values", () => {
  it("rejects string numbers, null, NaN and Infinity", () => {
    for (const bad of ["1", null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
      expect(rejected(chart({ series: [{ name: "s", values: [bad, 2] }] }))).toBe(true);
  });

  it("serialises to JSON without losing numbers that survive parsing", () => {
    const json = '{"type":"chart","kind":"bar","title":"x","categories":["a","b"],"series":[{"name":"s","values":[1e999,2]}]}';
    expect(parseElement(json)).toBeNull();
  });

  it("accepts negative, zero, huge and tiny values on non-pie charts", () => {
    const block = build(chart({ series: [{ name: "s", values: [-1e300, 0] }] }));
    expect(block.chart.series[0].data.map((p: Body) => p.value)).toEqual([-1e300, 0]);
    expect(accepted(chart({ series: [{ name: "s", values: [Number.MAX_VALUE, Number.MIN_VALUE] }] }))).toBe(true);
  });

  it("rejects empty categories, empty series, mismatched lengths and an empty values array", () => {
    expect(rejected(chart({ categories: [] }))).toBe(true);
    expect(rejected(chart({ series: [] }))).toBe(true);
    expect(rejected(chart({ series: [{ name: "s", values: [1] }] }))).toBe(true);
    expect(rejected(chart({ series: [{ name: "s", values: [1, 2, 3] }] }))).toBe(true);
    expect(rejected(chart({ series: [{ name: "s", values: [] }] }))).toBe(true);
  });

  it("enforces 12 series and 20 points exactly", () => {
    const series = (count: number, points: number) =>
      Array.from({ length: count }, (_, index) => ({ name: `s${index}`, values: Array(points).fill(1) }));
    const categories = (points: number) => Array.from({ length: points }, (_, index) => `c${index}`);
    expect(accepted(chart({ categories: categories(20), series: series(12, 20) }))).toBe(true);
    expect(rejected(chart({ categories: categories(20), series: series(13, 20) }))).toBe(true);
    expect(rejected(chart({ categories: categories(21), series: series(1, 21) }))).toBe(true);
  });

  it("rejects duplicate series names and categories, including after truncation and broadcast rewriting", () => {
    const long = "x".repeat(25);
    expect(
      rejected(
        chart({
          series: [
            { name: `${long}1`, values: [1, 2] },
            { name: `${long}2`, values: [1, 2] },
          ],
        }),
      ),
    ).toBe(true);
    expect(rejected(chart({ categories: [`${long}1`, `${long}2`] }))).toBe(true);
    expect(rejected(chart({ categories: ["a", "a"] }))).toBe(true);
  });

  it("does not split a surrogate pair at the 20 and 50 character cuts", () => {
    const emoji = "😀";
    for (const offset of [17, 18, 19, 20, 21]) {
      const label = "a".repeat(offset) + emoji.repeat(5);
      const block = build(chart({ title: "a".repeat(offset + 30) + emoji.repeat(5), categories: [label, "z"] }));
      const strings = [block.title, ...block.chart.axis_config.categories, ...block.chart.series[0].data.map((p: Body) => p.label)];
      for (const value of strings) {
        expect(value.isWellFormed()).toBe(true);
        expect(value.length).toBeLessThanOrEqual(50);
      }
      expect(block.chart.axis_config.categories[0].length).toBeLessThanOrEqual(CARD_LIMITS.chartLabel);
    }
  });

  it("keeps surrogate pairs whole at the title cut", () => {
    for (const offset of [45, 46, 47, 48, 49]) {
      const block = build(chart({ title: "a".repeat(offset) + "😀".repeat(5) }));
      expect(block.title.isWellFormed()).toBe(true);
      expect(block.title.length).toBeLessThanOrEqual(50);
    }
  });

  it("keeps multi-codepoint labels from creating Slack-side duplicates after truncation", () => {
    const block = build(chart({ categories: ["a".repeat(30), "b".repeat(30)] }));
    expect(new Set(block.chart.axis_config.categories).size).toBe(2);
  });
});

describe("pie", () => {
  const pie = (values: number[]) =>
    chart({ kind: "pie", categories: values.map((_, index) => `c${index}`), series: [{ name: "s", values }] });

  it("rejects zero and negative segments, accepts tiny positive ones", () => {
    expect(rejected(pie([1, 0]))).toBe(true);
    expect(rejected(pie([1, -1]))).toBe(true);
    expect(accepted(pie([1, Number.MIN_VALUE]))).toBe(true);
  });

  it("enforces 12 segments and a single series", () => {
    expect(accepted(pie(Array(12).fill(1)))).toBe(true);
    expect(rejected(pie(Array(13).fill(1)))).toBe(true);
    expect(
      rejected(
        chart({
          kind: "pie",
          series: [
            { name: "a", values: [1, 2] },
            { name: "b", values: [1, 2] },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("broadcast mentions", () => {
  const attacks = ["<!channel>", "<!here|here>", "<!EVERYONE>", "x<!everyone|all>y"];

  it("neutralises them in chart title, labels, series names and axis titles", () => {
    for (const attack of attacks) {
      const block = build(
        chart({ title: attack, categories: [attack, "z"], series: [{ name: attack, values: [1, 2] }], xLabel: attack, yLabel: attack }),
      );
      expect(JSON.stringify(block)).not.toMatch(/<!(channel|here|everyone)/i);
    }
  });

  it("neutralises them in columns titles, text, label and fallback", () => {
    for (const attack of attacks) {
      const untitled = build({ type: "columns", rows: [[{ text: attack }]] });
      const titled = build({ type: "columns", rows: [[{ title: attack, text: attack }, { text: `**${attack}**` }]] });
      expect(JSON.stringify([untitled, titled])).not.toMatch(/<!(channel|here|everyone)/i);
    }
  });

  it("neutralises them in the chart text fallback and table fallback", () => {
    for (const attack of attacks) {
      const rich = cardToBlocks([chart({ title: attack, categories: [attack, "z"], series: [{ name: attack, values: [1, 2] }] })]).blocks;
      expect(JSON.stringify(plainBlocks(rich))).not.toMatch(/<!(channel|here|everyone)/i);
      const withTable = cardToBlocks([{ type: "table", rows: [["a"], ["b"]] }, ...rich]).blocks;
      expect(JSON.stringify(plainBlocks(withTable))).not.toMatch(/<!(channel|here|everyone)/i);
    }
  });

  it("neutralises them in a section with a button", () => {
    const block = build({ type: "section", text: "<!channel>", button: { text: "<!channel>", reply: true } });
    expect(block.text.text).not.toMatch(/<!channel/i);
  });
});

describe("columns", () => {
  const col = (text = "v") => ({ text });

  it("rejects 4 columns, 6 rows, empty rows and empty columns, accepts 5x3", () => {
    expect(rejected({ type: "columns", rows: [[col(), col(), col(), col()]] })).toBe(true);
    expect(rejected({ type: "columns", rows: Array(6).fill([col()]) })).toBe(true);
    expect(rejected({ type: "columns", rows: [] })).toBe(true);
    expect(rejected({ type: "columns", rows: [[]] })).toBe(true);
    expect(rejected({ type: "columns", rows: [[{ text: "  " }]] })).toBe(true);
    expect(rejected({ type: "columns", rows: [[{ title: "", text: "x" }]] })).toBe(true);
    expect(accepted({ type: "columns", rows: Array(5).fill([col(), col(), col()]) })).toBe(true);
  });

  it("cuts huge column text to Slack limits in layout and fallback", () => {
    const block = build({ type: "columns", rows: [[{ title: "t".repeat(500), text: "y".repeat(10_000) }]] });
    expect(block.rows[0].items[0].block.text.text.length).toBeLessThanOrEqual(3000);
    expect(block.fallback[0].fields[0].text.length).toBeLessThanOrEqual(2000);
    expect(block.label.length).toBeLessThanOrEqual(150);
  });

  it("does not leave a cut-off link in a truncated column", () => {
    const text = "a".repeat(2990) + " [link](https://example.com/very/long/path/that/goes/past)";
    const block = build({ type: "columns", rows: [[{ text }]] });
    const out = block.rows[0].items[0].block.text.text as string;
    expect(out.lastIndexOf("<")).toBeLessThanOrEqual(out.lastIndexOf(">"));
  });

  it("keeps the column fallback fields at most 10 per section and sections non-empty", () => {
    const block = build({ type: "columns", rows: [[col("a"), col("b"), col("c")]] });
    for (const section of block.fallback) {
      expect(section.fields.length).toBeGreaterThan(0);
      for (const field of section.fields) expect(field.text.length).toBeGreaterThan(0);
    }
  });

  it("weighs a 5-row layout so ten fit nowhere near Slack's 50 blocks", () => {
    const block = build({ type: "columns", rows: Array(5).fill([col(), col(), col()]) });
    expect(blockWeight(block)).toBe(1 + 15 + 5);
    const many = Array(5).fill({ type: "columns", rows: Array(5).fill([col(), col(), col()]) });
    const result = cardToBlocks(many);
    expect(result.blocks.length + result.dropped.length).toBe(5);
    const total = result.blocks.reduce((sum, b) => sum + blockWeight(b as Body), 0);
    expect(total).toBeLessThanOrEqual(50);
    expect(plainBlocks(result.blocks).length).toBeLessThanOrEqual(50);
  });
});

describe("plainBlocks", () => {
  const rich = (...elements: unknown[]) => cardToBlocks(elements).blocks;

  it("never produces more than one table nor more than 50 blocks for charts plus an existing table", () => {
    const blocks = rich({ type: "table", rows: [["a"], ["b"]] }, chart(), chart({ title: "two" }));
    const plain = plainBlocks(blocks);
    expect(plain.filter((b) => b.type === "table")).toHaveLength(1);
    expect(plain.some((b) => b.type === "data_visualization")).toBe(false);
  });

  it("gives the first of two charts the table when no table exists, and text to the second", () => {
    const plain = plainBlocks(rich(chart(), chart({ title: "two" })));
    expect(plain.filter((b) => b.type === "table")).toHaveLength(1);
    expect(JSON.stringify(plain)).toContain("two");
  });

  it("keeps all data of a 20-point 12-series chart in the fallback table", () => {
    const categories = Array.from({ length: 20 }, (_, index) => `c${index}`);
    const series = Array.from({ length: 12 }, (_, index) => ({ name: `s${index}`, values: categories.map((_, point) => point) }));
    const table = plainBlocks(rich(chart({ categories, series }))).find((b) => b.type === "table") as Body;
    expect(table.rows).toHaveLength(21);
    expect(table.rows[0]).toHaveLength(13);
  });

  it("keeps numbers like 0, negatives and large values in the fallback text", () => {
    const text = JSON.stringify(
      plainBlocks(rich({ type: "table", rows: [["a"], ["b"]] }, chart({ series: [{ name: "s", values: [0, -5.5] }] }))),
    );
    expect(text).toContain("0");
    expect(text).toContain("-5.5");
  });

  it("does not turn an empty-string x label into an empty first header cell that Slack rejects", () => {
    const table = plainBlocks(rich(chart())).find((b) => b.type === "table") as Body;
    for (const row of table.rows) for (const cell of row) expect(JSON.stringify(cell)).not.toContain('"text":""');
  });

  it("leaves a degraded card with no rich blocks and a non-empty text", () => {
    const plain = plainBlocks(rich(chart(), { type: "columns", rows: [[{ text: "v" }]] }, chart({ title: "b" })));
    expect(plain.some((b) => b.type === "layout" || b.type === "data_visualization")).toBe(false);
  });
});

describe("three charts", () => {
  it("drops the third chart within one card", () => {
    const { blocks, dropped } = cardToBlocks([chart(), chart({ title: "2" }), chart({ title: "3" })]);
    expect(blocks).toHaveLength(2);
    expect(dropped[0].reason).toContain("at most 2 charts");
  });

  it("counts charts in a streamed message across two calls", async () => {
    const thread = { channel: "C1", threadTs: nextId() };
    const stream = ensureStream(thread.channel, thread.threadTs, null);
    stream.text("hi");
    await tick();
    streamCardInput("call-a", thread, JSON.stringify({ elements: [chart(), chart({ title: "2" })] }));
    streamCardInput("call-b", thread, JSON.stringify({ elements: [chart({ title: "3" })] }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(countCharts(sentBlocks())).toBeLessThanOrEqual(2);
    const outcomeB = await showCard("call-b", [chart({ title: "3" })], ctx(thread.channel, thread.threadTs));
    const outcomeA = await showCard("call-a", [chart(), chart({ title: "2" })], ctx(thread.channel, thread.threadTs));
    await vi.advanceTimersByTimeAsync(2000);
    const separate = posted().flatMap((body) => body.blocks as Body[]);
    expect(countCharts(sentBlocks()) + countCharts(separate)).toBe(3);
    expect(outcomeA.error ?? outcomeB.error).toBeNull();
    cancelCardCall("call-a");
    await stream.discard();
  });
});

describe("accessory reply buttons on a rich message", () => {
  const card = () =>
    cardToBlocks([
      { type: "section", text: "**Raport**", button: { text: "Pokaż", reply: true } },
      {
        type: "columns",
        rows: [
          [
            { title: "A", text: "1" },
            { title: "B", text: "2" },
          ],
        ],
      },
      chart(),
      chart({ title: "2" }),
      {
        type: "buttons",
        buttons: [
          { text: "Odśwież", reply: true },
          { text: "Link", url: "https://example.com" },
        ],
      },
    ]).blocks as Body[];

  it("matches only the right block_id and action_id", () => {
    const blocks = card();
    const [section, , , , row] = blocks;
    expect(replyLabel(blocks, section.block_id, "card_reply_0")).toBe("Pokaż");
    expect(replyLabel(blocks, row.block_id, "card_reply_1")).toBe("Odśwież");
    expect(replyLabel(blocks, row.block_id, "card_reply_0")).toBeNull();
    expect(replyLabel(blocks, section.block_id, "card_reply_1")).toBeNull();
    expect(replyLabel(blocks, undefined, "card_reply_0")).toBeNull();
  });

  it("answers the message keeping layout, charts and link buttons intact", () => {
    const blocks = card();
    const result = answeredBlocks(blocks, "note")!;
    expect(result.filter((b) => b.type === "layout")).toHaveLength(1);
    expect(result.filter((b) => b.type === "data_visualization")).toHaveLength(2);
    expect(result.filter((b) => b.block_id === "card_answered" || b.type === "context")).toHaveLength(1);
    const actions = result.find((b) => b.type === "actions")!;
    expect(actions.elements.map((e: Body) => e.action_id)).toEqual(["card_link_2"]);
    expect(result.find((b) => b.type === "section")).not.toHaveProperty("accessory");
    expect(answeredBlocks(result, "again")).toBeNull();
  });

  it("does not mistake a reply-like accessory inside a layout for a button of the card", () => {
    const blocks = card();
    expect(replyLabel(blocks, blocks[1].block_id, "card_reply_0")).toBeNull();
  });

  it("two accessory buttons in separate sections get different block_ids and action_ids", () => {
    const blocks = cardToBlocks([
      { type: "section", text: "a", button: { text: "x", reply: true } },
      { type: "section", text: "b", button: { text: "y", reply: true } },
    ]).blocks as Body[];
    expect(blocks[0].block_id).not.toBe(blocks[1].block_id);
    expect(blocks[0].accessory.action_id).not.toBe(blocks[1].accessory.action_id);
  });
});

describe("invalid_blocks handling", () => {
  it("degrades a postMessage once, without duplicates, keeping all non-rich blocks and the text", async () => {
    api.post.mockResolvedValueOnce(invalidBlocks);
    const elements = [{ type: "header", text: "H" }, chart(), { type: "columns", rows: [[{ text: "colval" }]] }, { type: "divider" }];
    const outcome = await showCard("c1", elements, ctx("C1", nextId()));
    expect(posted()).toHaveLength(2);
    const second = posted()[1];
    expect(second.text).toBeTruthy();
    expect(second.blocks.map((b: Body) => b.type)).toContain("header");
    expect(second.blocks.map((b: Body) => b.type)).toContain("divider");
    expect(JSON.stringify(second.blocks)).toContain("colval");
    expect(outcome.error).toBeNull();
  });

  it("does not degrade when a different error occurs and reports it", async () => {
    api.post.mockResolvedValue({ ok: false, body: {}, error: "invalid_blocks_format" });
    const outcome = await showCard("c2", [chart()], ctx("C1", nextId()));
    expect(posted().length).toBeLessThanOrEqual(2);
    expect(outcome.error).toBeTruthy();
  });

  it("uses a non-empty notification text for chart-only and columns-only posts", async () => {
    await showCard("c3", [chart()], ctx("C1", nextId()));
    await showCard("c4", [{ type: "columns", rows: [[{ text: "v" }]] }], ctx("C1", nextId()));
    for (const body of posted()) expect(body.text.trim()).not.toBe("");
  });

  it("keeps the reply text intact when appendStream rejects a chart, and posts the chart fallback once", async () => {
    const shown: string[] = [];
    const accept = (chunks: Body[] = []) => {
      if (chunks.some((chunk) => chunk.type === "blocks" && countCharts(chunk.blocks) > 0)) return invalidBlocks;
      shown.push(...chunks.filter((chunk) => chunk.type === "markdown_text").map((chunk) => chunk.text));
      return { ok: true, error: "" };
    };
    api.startStream.mockImplementation(async (_c, _t, opts) => (accept(opts.chunks as Body[]).ok ? "S1" : null));
    api.appendStream.mockImplementation(async (_c, _t, chunks) => accept(chunks));
    api.stopStream.mockImplementation(async (_c, _t, chunks) => accept(chunks));
    api.post.mockResolvedValueOnce(invalidBlocks);
    const thread = { channel: "C1", threadTs: nextId() };
    const stream = ensureStream(thread.channel, thread.threadTs, null);
    stream.text("Przed. ");
    await tick();
    const elements = [chart(), chart({ title: "2" })];
    streamCardInput("c5", thread, JSON.stringify({ elements }));
    stream.text("Po.");
    const pending = showCard("c5", elements, ctx(thread.channel, thread.threadTs));
    await vi.advanceTimersByTimeAsync(3000);
    const outcome = await pending;
    expect(await stream.finish("Przed. Po.", [])).toBe("ok");
    expect(shown.join("")).toBe("Przed. Po.");
    const fallbackText = JSON.stringify(posted().map((b) => b.blocks));
    expect(posted()).toHaveLength(2);
    expect(fallbackText.split("data_visualization").length - 1).toBe(2);
    expect(JSON.stringify(posted()[1].blocks)).not.toContain("data_visualization");
    expect(outcome.error).toBeNull();
  });

  it("when the stream start itself carries a rejected chart, the reply text is still sent", async () => {
    api.startStream.mockResolvedValueOnce(null);
    const thread = { channel: "C1", threadTs: nextId() };
    const stream = ensureStream(thread.channel, thread.threadTs, null);
    stream.text("Odpowiedź");
    streamCardInput("c6", thread, JSON.stringify({ elements: [chart()] }));
    await vi.advanceTimersByTimeAsync(3000);
    await showCard("c6", [chart()], ctx(thread.channel, thread.threadTs));
    await stream.finish("Odpowiedź", []);
    const everywhere =
      sentText() +
      posted()
        .map((b) => b.text)
        .join("");
    expect(everywhere).toContain("Odpowiedź");
  });
});

describe("streamed JSON split at every position", () => {
  const elements = [
    { type: "section", text: "**Raport**", button: { text: "Pokaż", reply: true } },
    {
      type: "columns",
      rows: [
        [
          { title: "A", text: "1" },
          { title: "B", text: '{"}\\' },
        ],
      ],
    },
    chart({ title: 'q"uote' }),
    { type: "divider" },
  ];
  const json = JSON.stringify({ elements });
  const expected = cardToBlocks(elements).blocks.map((b) => String(b.type));

  it("emits the same blocks no matter where the input is cut in two", () => {
    for (let at = 0; at <= json.length; at += 1) {
      const thread = { channel: "C1", threadTs: nextId() };
      const id = `split-${at}`;
      const first = streamCardInput(id, thread, json.slice(0, at));
      const second = streamCardInput(id, thread, json.slice(at));
      const got = [...(first?.blocks ?? []), ...(second?.blocks ?? [])].map((b) => b.type);
      cancelCardCall(id);
      expect(got, `split at ${at}`).toEqual(expected);
    }
  });

  it("emits the same blocks fed one character at a time and in 3-char steps", () => {
    for (const size of [1, 3, 7]) {
      const thread = { channel: "C1", threadTs: nextId() };
      const id = `size-${size}`;
      const got: string[] = [];
      for (let index = 0; index < json.length; index += size)
        got.push(...(streamCardInput(id, thread, json.slice(index, index + size))?.blocks ?? []).map((b) => b.type));
      cancelCardCall(id);
      expect(got, `size ${size}`).toEqual(expected);
    }
  });
});
