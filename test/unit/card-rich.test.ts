import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCtx } from "../../lib/agent/context.ts";

type Body = Record<string, any>;

const api = vi.hoisted(() => ({
  post: vi.fn(async (_endpoint: string, _body: Record<string, unknown>) => ({ ok: true as boolean, body: {}, error: "" })),
  startStream: vi.fn(async (_channel: string, _threadTs: string, _opts: Record<string, unknown>): Promise<string | null> => "S1"),
  appendStream: vi.fn(async (_channel: string, _ts: string, _chunks: Body[]) => ({ ok: true, error: "" })),
  stopStream: vi.fn(async (_channel: string, _ts: string, _chunks?: Body[]) => ({ ok: true, error: "" })),
  setStatus: vi.fn(async () => ({ ok: true })),
  deleteMessage: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../lib/slack/api.ts", () => api);

const { blockWeight, CARD_LIMITS, cardToBlocks, countCharts, degradeBlocks, plainBlocks } = await import("../../lib/slack/cards.ts");
const { cancelCardCall, describeCardOutcome, showCard, streamCardInput } = await import("../../lib/slack/card-stream.ts");
const { ensureStream } = await import("../../lib/slack/stream.ts");

const blockOf = (element: unknown) => {
  const { blocks, dropped } = cardToBlocks([element]);
  expect(dropped).toEqual([]);
  return blocks[0] as Body;
};

const reasonOf = (element: unknown) => {
  const { blocks, dropped } = cardToBlocks([element]);
  expect(blocks).toEqual([]);
  return dropped[0].reason;
};

const lineChart = {
  type: "chart",
  kind: "line",
  title: "Weekly Paper Sales",
  categories: ["Week 1", "Week 2", "Week 3"],
  series: [
    { name: "Website", values: [32000, 35000, 29000] },
    { name: "In-store", values: [12000, -500, 9000.5] },
  ],
  xLabel: "Week",
  yLabel: "Paper Sales (USD)",
};

const pieChart = {
  type: "chart",
  kind: "pie",
  title: "Candy",
  categories: ["Kit Kat", "Twix"],
  series: [{ name: "Votes", values: [45, 28] }],
};

const longCategories = Array.from({ length: 20 }, (_, index) => `Category number ${index}`.slice(0, 20));

const longChart = {
  type: "chart",
  kind: "bar",
  title: "Everything",
  categories: longCategories,
  series: Array.from({ length: 12 }, (_, index) => ({
    name: `Series name ${index}`,
    values: longCategories.map((_, point) => point * 1000),
  })),
};

const kpis = {
  type: "columns",
  rows: [
    [
      { title: "Stage", text: "Negotiation" },
      { title: "Amount", text: "**$125,000** ▲ 8%" },
      { title: "Close", text: "2026-08-15" },
    ],
    [{ text: "Schedule sponsor meeting" }],
  ],
};

describe("chart element", () => {
  it("builds a line chart in Slack's data_visualization shape", () => {
    expect(blockOf(lineChart)).toEqual({
      type: "data_visualization",
      title: "Weekly Paper Sales",
      chart: {
        type: "line",
        series: [
          {
            name: "Website",
            data: [
              { label: "Week 1", value: 32000 },
              { label: "Week 2", value: 35000 },
              { label: "Week 3", value: 29000 },
            ],
          },
          {
            name: "In-store",
            data: [
              { label: "Week 1", value: 12000 },
              { label: "Week 2", value: -500 },
              { label: "Week 3", value: 9000.5 },
            ],
          },
        ],
        axis_config: { categories: ["Week 1", "Week 2", "Week 3"], x_label: "Week", y_label: "Paper Sales (USD)" },
      },
    });
  });

  it.each(["area", "bar"])("builds a %s chart without optional axis titles", (kind) => {
    const block = blockOf({ ...lineChart, kind, xLabel: undefined, yLabel: undefined });
    expect(block.chart.type).toBe(kind);
    expect(block.chart.axis_config).toEqual({ categories: ["Week 1", "Week 2", "Week 3"] });
  });

  it("builds a pie chart as segments", () => {
    expect(blockOf(pieChart)).toEqual({
      type: "data_visualization",
      title: "Candy",
      chart: {
        type: "pie",
        segments: [
          { label: "Kit Kat", value: 45 },
          { label: "Twix", value: 28 },
        ],
      },
    });
  });

  it("shortens long titles, labels and names to Slack's limits and reports it", () => {
    const { blocks, warnings } = cardToBlocks([
      {
        ...lineChart,
        title: "T".repeat(80),
        categories: ["Revenue in January 2026", "February"],
        series: [{ name: "Dunder Mifflin Infinity Website", values: [1, 2] }],
        xLabel: "x".repeat(60),
      },
    ]);
    const block = blocks[0] as Body;
    expect(block.title).toHaveLength(CARD_LIMITS.chartTitle);
    expect(block.title.endsWith("…")).toBe(true);
    expect(block.chart.axis_config.categories).toEqual(["Revenue in January …", "February"]);
    expect(block.chart.series[0].name).toHaveLength(CARD_LIMITS.chartLabel);
    expect(block.chart.series[0].data.map((point: Body) => point.label)).toEqual(block.chart.axis_config.categories);
    expect(block.chart.axis_config.x_label).toHaveLength(CARD_LIMITS.axisLabel);
    expect(warnings).toEqual([
      {
        index: 0,
        type: "chart",
        message:
          "chart text shortened: title past 50 characters, labels past 20 characters, series names past 20 characters, axis titles past 50 characters",
      },
    ]);
  });

  it.each([
    ["a series missing a value", { ...lineChart, series: [{ name: "A", values: [1, 2] }] }, "needs exactly one value per category"],
    ["duplicate series names", { ...lineChart, series: [lineChart.series[0], { ...lineChart.series[1], name: "Website" }] }, "repeats"],
    [
      "series names equal once shortened",
      {
        ...lineChart,
        series: [
          { name: "Revenue by month 2025", values: [1, 2, 3] },
          { name: "Revenue by month 2026", values: [1, 2, 3] },
        ],
      },
      "repeats within 20 characters",
    ],
    ["duplicate categories", { ...lineChart, categories: ["Week 1", "Week 1", "Week 3"] }, "repeats"],
    ["no categories", { ...lineChart, categories: [], series: [{ name: "A", values: [] }] }, "categories"],
    ["21 points", { ...lineChart, categories: Array.from({ length: 21 }, (_, index) => `d${index}`), series: [] }, "categories"],
    ["13 series", { ...lineChart, series: Array.from({ length: 13 }, (_, index) => ({ name: `s${index}`, values: [1, 2, 3] })) }, "series"],
    ["a non-number value", { ...lineChart, series: [{ name: "A", values: [1, "2", 3] }] }, "series.0.values.1"],
    ["an unknown kind", { ...lineChart, kind: "scatter" }, "kind"],
    ["a pie with two series", { ...pieChart, series: [pieChart.series[0], { name: "B", values: [1, 2] }] }, "exactly one series"],
    ["a pie with a zero value", { ...pieChart, series: [{ name: "A", values: [0, 3] }] }, "above 0"],
    [
      "a pie with 13 segments",
      {
        ...pieChart,
        categories: Array.from({ length: 13 }, (_, index) => `c${index}`),
        series: [{ name: "A", values: Array(13).fill(1) }],
      },
      "at most 12 segments",
    ],
  ])("rejects %s", (_, element, reason) => {
    expect(reasonOf(element)).toContain(reason);
  });

  it("keeps at most two charts per card", () => {
    const { blocks, dropped } = cardToBlocks([lineChart, pieChart, lineChart]);
    expect(countCharts(blocks)).toBe(2);
    expect(dropped).toEqual([{ index: 2, type: "chart", reason: "a card holds at most 2 charts" }]);
  });
});

describe("columns element", () => {
  it("builds a layout block of sections with a fallback from the same content", () => {
    expect(blockOf(kpis)).toEqual({
      type: "layout",
      label: "Stage · Amount · Close",
      rows: [
        {
          items: [
            { block: { type: "section", text: { type: "mrkdwn", text: "*Stage*\nNegotiation" } } },
            { block: { type: "section", text: { type: "mrkdwn", text: "*Amount*\n*$125,000* ▲ 8%" } } },
            { block: { type: "section", text: { type: "mrkdwn", text: "*Close*\n2026-08-15" } } },
          ],
        },
        { items: [{ block: { type: "section", text: { type: "mrkdwn", text: "Schedule sponsor meeting" } } }] },
      ],
      fallback: [
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: "*Stage*\nNegotiation" },
            { type: "mrkdwn", text: "*Amount*\n*$125,000* ▲ 8%" },
            { type: "mrkdwn", text: "*Close*\n2026-08-15" },
          ],
        },
        { type: "section", fields: [{ type: "mrkdwn", text: "Schedule sponsor meeting" }] },
      ],
    });
  });

  it("labels an untitled layout with its first text and keeps the label within 150 characters", () => {
    expect(blockOf({ type: "columns", rows: [[{ text: "a".repeat(200) }]] }).label).toHaveLength(CARD_LIMITS.layoutLabel);
  });

  it("truncates column text to the section and field limits", () => {
    const block = blockOf({ type: "columns", rows: [[{ text: "x".repeat(5000) }]] });
    expect(block.rows[0].items[0].block.text.text).toHaveLength(CARD_LIMITS.sectionText);
    expect(block.fallback[0].fields[0].text).toHaveLength(CARD_LIMITS.fieldText);
  });

  it("neutralizes broadcast mentions in columns and charts", () => {
    expect(JSON.stringify(blockOf({ type: "columns", rows: [[{ title: "<!channel>", text: "<!here>" }]] }))).not.toContain("<!");
    const chart = { ...lineChart, title: "<!everyone>", categories: ["<!here>", "b", "c"], xLabel: "<!channel>" };
    expect(JSON.stringify(blockOf(chart))).not.toContain("<!");
  });

  it.each([
    ["four columns in a row", { type: "columns", rows: [Array(4).fill({ text: "a" })] }],
    ["six rows", { type: "columns", rows: Array(6).fill([{ text: "a" }]) }],
    ["an empty row", { type: "columns", rows: [[]] }],
    ["no rows", { type: "columns", rows: [] }],
    ["a column without text", { type: "columns", rows: [[{ title: "Only title" }]] }],
  ])("rejects %s", (_, element) => {
    expect(reasonOf(element)).toContain("invalid element");
  });

  it("counts every nested section and fallback block toward the card limit", () => {
    const full = { type: "columns", rows: Array(5).fill(Array(3).fill({ text: "a" })) };
    expect(blockWeight(blockOf(full))).toBe(1 + 15 + 5);
    const { blocks, dropped } = cardToBlocks([full, full, full]);
    expect(blocks).toHaveLength(2);
    expect(dropped).toEqual([{ index: 2, type: "columns", reason: "a card holds at most 50 blocks" }]);
  });
});

describe("plainBlocks", () => {
  it("replaces a layout with its fallback and a chart with a title and a table of its numbers", () => {
    const { blocks } = cardToBlocks([{ type: "header", text: "Raport" }, kpis, lineChart]);
    const plain = plainBlocks(blocks);
    expect(plain.map((block) => block.type)).toEqual(["header", "section", "section", "section", "table"]);
    expect(plain[3]).toEqual({ type: "section", text: { type: "mrkdwn", text: "*Weekly Paper Sales*" } });
    const cells = (plain[4].rows as Body[][]).map((row) => row.map((cell) => JSON.stringify(cell)));
    expect(cells).toHaveLength(4);
    expect(cells[0].join()).toContain("Website");
    expect(cells[2].join()).toContain("-500");
    expect(cells[3].join()).toContain("9000.5");
  });

  it("writes the numbers as text when the message already holds a table", () => {
    const { blocks } = cardToBlocks([{ type: "table", rows: [["a"]] }, lineChart, pieChart]);
    const plain = plainBlocks(blocks);
    expect(plain.filter((block) => block.type === "table")).toHaveLength(1);
    expect(plain.at(-2)).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Weekly Paper Sales*\n• Week 1: Website 32000 · In-store 12000\n• Week 2: Website 35000 · In-store -500\n• Week 3: Website 29000 · In-store 9000.5",
      },
    });
    expect(plain.at(-1)).toEqual({ type: "section", text: { type: "mrkdwn", text: "*Candy*\n• Kit Kat: 45\n• Twix: 28" } });
  });

  it("gives a pie's fallback table a header row so the first segment stays a data row", () => {
    const table = plainBlocks(cardToBlocks([pieChart]).blocks).find((block) => block.type === "table") as Body;
    const cells = (table.rows as Body[][]).map((row) => JSON.stringify(row));
    expect(cells).toHaveLength(3);
    expect(cells[0]).toContain("Candy");
    expect(cells[1]).toContain("Kit Kat");
    expect(cells[1]).toContain("45");
    expect(cells[2]).toContain("Twix");
  });

  it("reports which charts' text fallback was cut to fit a section", () => {
    const { blocks } = cardToBlocks([{ type: "table", rows: [["a"]] }, longChart, lineChart]);
    const { blocks: plain, cut } = degradeBlocks(blocks);
    expect(cut).toEqual([1]);
    expect((plain[1].text as Body).text).toHaveLength(CARD_LIMITS.sectionText);
  });

  it("uses one table for the first chart and text for the second", () => {
    const plain = plainBlocks(cardToBlocks([pieChart, lineChart]).blocks);
    expect(plain.map((block) => block.type)).toEqual(["section", "table", "section"]);
  });

  it("leaves cards without charts or columns untouched", () => {
    const { blocks } = cardToBlocks([{ type: "section", text: "a" }, { type: "divider" }]);
    expect(plainBlocks(blocks)).toEqual(blocks);
  });

  it("always fits a degraded card in Slack's 50 blocks", () => {
    const full = { type: "columns", rows: Array(5).fill([{ text: "a" }]) };
    const { blocks } = cardToBlocks([...Array(20).fill(full), lineChart, pieChart, ...Array(60).fill({ type: "divider" })]);
    expect(plainBlocks(blocks).length).toBeLessThanOrEqual(CARD_LIMITS.maxBlocks);
  });
});

const tick = () => vi.advanceTimersByTimeAsync(0);
let counter = 0;
const nextId = () => `${++counter}.0`;

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

const posted = () => api.post.mock.calls.filter(([endpoint]) => endpoint === "chat.postMessage").map(([, body]) => body as Body);
const types = (blocks: Body[]) => blocks.map((block) => block.type);
const streamedBlocks = () =>
  [
    ...api.startStream.mock.calls.map(([, , opts]) => opts.chunks as Body[]),
    ...api.appendStream.mock.calls.map(([, , chunks]) => chunks),
    ...api.stopStream.mock.calls.map(([, , chunks]) => chunks ?? []),
  ]
    .flat()
    .filter((chunk) => chunk.type === "blocks")
    .flatMap((chunk) => chunk.blocks as Body[]);

const chartBlock = () => blockOf(lineChart);
const invalidBlocks = { ok: false, body: {}, error: "invalid_blocks" };

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

describe("charts per message", () => {
  it("refuses a third chart in one streamed message", async () => {
    const stream = ensureStream("C1", nextId(), null);
    const first = stream.blocks([chartBlock(), chartBlock()]);
    const third = stream.blocks([chartBlock()]);
    expect(await third.delivered).toBe(false);
    await tick();
    expect(await first.delivered).toBe(true);
    expect(countCharts(streamedBlocks())).toBe(2);
    await stream.discard();
  });

  it("frees the chart slots of a batch Slack rejected", async () => {
    const stream = ensureStream("C1", nextId(), null);
    stream.text("start");
    await tick();
    api.appendStream.mockResolvedValueOnce(invalidBlocks).mockResolvedValue({ ok: true, error: "" });
    const rejected = stream.blocks([chartBlock(), chartBlock()]);
    await vi.advanceTimersByTimeAsync(700);
    expect(await rejected.delivered).toBe(false);
    const retried = stream.blocks([chartBlock(), chartBlock()]);
    await vi.advanceTimersByTimeAsync(700);
    expect(await retried.delivered).toBe(true);
    await stream.discard();
  });

  it("counts charts per call so a second card in the same turn cannot pass two", () => {
    const thread = { channel: "C1", threadTs: nextId() };
    const charts = JSON.stringify({ elements: [lineChart, pieChart, lineChart] });
    expect(streamCardInput("call-charts", thread, charts)?.blocks.map((block) => block.type)).toEqual([
      "data_visualization",
      "data_visualization",
    ]);
    cancelCardCall("call-charts");
  });
});

describe("degrading charts and columns Slack rejects", () => {
  const card = [{ type: "section", text: "*Revenue*", button: { text: "View report", url: "https://example.com/r" } }, kpis, lineChart];

  it("reposts a rejected card with the fallback built from the same data", async () => {
    api.post.mockResolvedValueOnce(invalidBlocks);
    const thread = nextId();
    const outcome = await showCard("call-degrade", card, ctx("C1", thread));
    expect(posted()).toHaveLength(2);
    expect(types(posted()[0].blocks)).toEqual(["section", "layout", "data_visualization"]);
    expect(types(posted()[1].blocks)).toEqual(["section", "section", "section", "section", "table"]);
    expect(posted()[1].blocks[0].accessory).toMatchObject({ type: "button", url: "https://example.com/r" });
    expect(JSON.stringify(posted()[1].blocks)).toContain("Negotiation");
    expect(JSON.stringify(posted()[1].blocks)).toContain("35000");
    expect(outcome).toMatchObject({ posted: 3, degraded: 2, error: null });
    expect(describeCardOutcome(outcome)).toContain("Slack did not accept 2 chart or columns element(s)");
    expect(describeCardOutcome(outcome)).toContain("with the same data");
    expect(outcome.cut).toBe(0);
  });

  it("warns when a chart's text fallback had to be cut instead of claiming the same data", async () => {
    api.post.mockResolvedValueOnce(invalidBlocks);
    const outcome = await showCard("call-degrade-cut", [{ type: "table", rows: [["a"]] }, longChart], ctx("C1", nextId()));
    expect(outcome).toMatchObject({ posted: 2, degraded: 1, cut: 1, error: null });
    expect(outcome.warnings).toEqual([{ index: 1, type: "chart", message: expect.stringContaining("cut at 3000 characters") }]);
    const text = describeCardOutcome(outcome);
    expect(text).not.toContain("same data");
    expect(text).toContain("1 of them did not fit and were cut short");
    expect(text).toContain("- elements[1] (chart): posted as a text list cut at 3000 characters");
  });

  it("does not retry other errors or cards without charts and columns", async () => {
    api.post.mockResolvedValueOnce({ ok: false, body: {}, error: "channel_not_found" });
    expect(await showCard("call-other-error", card, ctx("C1", nextId()))).toMatchObject({ error: "channel_not_found", degraded: 0 });
    api.post.mockResolvedValueOnce(invalidBlocks);
    expect(await showCard("call-plain", [{ type: "section", text: "a" }], ctx("C1", nextId()))).toMatchObject({
      error: "invalid_blocks",
    });
    expect(posted()).toHaveLength(2);
  });

  it("reports a fallback Slack rejects as well", async () => {
    api.post.mockResolvedValue(invalidBlocks);
    expect(await showCard("call-double", card, ctx("C1", nextId()))).toMatchObject({ posted: 0, error: "invalid_blocks" });
    expect(posted()).toHaveLength(2);
  });

  it("keeps the reply text when the stream rejects a chart and posts its fallback once", async () => {
    const shown: string[] = [];
    const accept = (chunks: Body[] = []) => {
      if (chunks.some((chunk) => chunk.type === "blocks" && countCharts(chunk.blocks) > 0)) return invalidBlocks;
      shown.push(...chunks.filter((chunk) => chunk.type === "markdown_text").map((chunk) => chunk.text));
      return { ok: true, error: "" };
    };
    api.startStream.mockImplementation(async (_channel, _threadTs, opts) => (accept(opts.chunks as Body[]).ok ? "S1" : null));
    api.appendStream.mockImplementation(async (_channel, _ts, chunks) => accept(chunks));
    api.stopStream.mockImplementation(async (_channel, _ts, chunks) => accept(chunks));
    api.post.mockResolvedValueOnce(invalidBlocks);
    const thread = { channel: "C1", threadTs: nextId() };
    const stream = ensureStream(thread.channel, thread.threadTs, null);
    stream.text("Przychody rosną. ");
    await tick();
    const elements = [{ type: "header", text: "Raport" }, lineChart];
    streamCardInput("call-stream-degrade", thread, JSON.stringify({ elements }));
    stream.text("Szczegóły poniżej.");
    const pending = showCard("call-stream-degrade", elements, ctx(thread.channel, thread.threadTs));
    await vi.advanceTimersByTimeAsync(2000);
    const outcome = await pending;
    expect(await stream.finish("Przychody rosną. Szczegóły poniżej.", [])).toBe("ok");

    expect(shown.join("")).toBe("Przychody rosną. Szczegóły poniżej.");
    expect(countCharts(streamedBlocks())).toBe(1);
    expect(posted()).toHaveLength(2);
    expect(types(posted()[1].blocks)).toEqual(["header", "section", "table"]);
    expect(outcome).toMatchObject({ streamed: 0, posted: 2, degraded: 1, error: null });
  });
});
