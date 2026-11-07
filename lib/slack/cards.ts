import { z } from "zod";
import { fromMarkdown, MAX_TABLE_COLS, MAX_TABLE_ROWS, tableBlock } from "./mrkdwn.ts";

export const CARD_LIMITS = {
  headerText: 150,
  sectionText: 3000,
  fieldText: 2000,
  contextText: 3000,
  buttonText: 75,
  buttonUrl: 3000,
  minFields: 1,
  maxFields: 10,
  maxButtons: 5,
  maxBlocks: 50,
  maxTables: 1,
  maxCharts: 2,
  chartTitle: 50,
  chartLabel: 20,
  axisLabel: 50,
  minPoints: 1,
  maxPoints: 20,
  maxSeries: 12,
  maxSegments: 12,
  maxColumns: 3,
  maxColumnRows: 5,
  columnTitle: 150,
  layoutLabel: 150,
  tableRows: MAX_TABLE_ROWS,
  tableColumns: MAX_TABLE_COLS,
} as const;

export const CARD_LINK_ACTION_PREFIX = "card_link_";
export const CARD_REPLY_ACTION_PREFIX = "card_reply_";
export const CARD_BUTTONS_BLOCK_PREFIX = "card_buttons_";

const ELLIPSIS = "…";

type Block = Record<string, unknown>;

function httpsHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const text = z.string().trim().min(1);

const button = z
  .object({
    text: text.describe("Button label, plain text"),
    url: z
      .string()
      .trim()
      .superRefine((value, ctx) => {
        const href = httpsHref(value);
        if (href === null) ctx.addIssue({ code: "custom", message: "must be an https URL" });
        else if (href.length > CARD_LIMITS.buttonUrl)
          ctx.addIssue({ code: "custom", message: `must be at most ${CARD_LIMITS.buttonUrl} characters` });
      })
      .optional()
      .describe("Link button: https link the button opens"),
    reply: z
      .literal(true)
      .optional()
      .describe("Reply button: set to true and the click sends you exactly the button text as a message from whoever clicks it"),
    style: z.enum(["primary", "danger"]).optional().describe("Optional color: primary (green) or danger (red)"),
  })
  .superRefine((value, ctx) => {
    if ((value.url === undefined) === (value.reply === undefined))
      ctx.addIssue({ code: "custom", message: "a button needs exactly one of url or reply: true" });
  });

const BROADCAST_MENTION = /<!(channel|here|everyone)(\|[^>]*)?>/gi;

const withoutBroadcasts = (value: string) => value.replace(BROADCAST_MENTION, (_, name: string) => `@${name.toLowerCase()}`);

const shortLabel = (value: string) => truncate(withoutBroadcasts(value), CARD_LIMITS.chartLabel);

function duplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

const chart = z
  .object({
    type: z.literal("chart"),
    kind: z.enum(["line", "area", "bar", "pie"]).describe("line or area for trends over time, bar to compare categories, pie for shares"),
    title: text.describe(`Chart title, at most ${CARD_LIMITS.chartTitle} characters`),
    categories: z
      .array(text)
      .min(CARD_LIMITS.minPoints)
      .max(CARD_LIMITS.maxPoints)
      .describe(
        `${CARD_LIMITS.minPoints}-${CARD_LIMITS.maxPoints} x-axis labels in order (pie: segment labels, at most ${CARD_LIMITS.maxSegments}), each at most ${CARD_LIMITS.chartLabel} characters`,
      ),
    series: z
      .array(
        z.object({
          name: text.describe(`Legend name, unique, at most ${CARD_LIMITS.chartLabel} characters`),
          values: z.array(z.number()).describe("One number per category, in the same order"),
        }),
      )
      .min(1)
      .max(CARD_LIMITS.maxSeries)
      .describe(`1-${CARD_LIMITS.maxSeries} data series (pie: exactly one, all values above 0)`),
    xLabel: text.optional().describe("Optional x-axis title"),
    yLabel: text.optional().describe("Optional y-axis title"),
  })
  .superRefine((value, ctx) => {
    value.series.forEach((series, index) => {
      if (series.values.length !== value.categories.length)
        ctx.addIssue({
          code: "custom",
          path: ["series", index, "values"],
          message: `needs exactly one value per category (${value.categories.length})`,
        });
    });
    const category = duplicate(value.categories.map(shortLabel));
    if (category !== undefined)
      ctx.addIssue({ code: "custom", path: ["categories"], message: `"${category}" repeats within ${CARD_LIMITS.chartLabel} characters` });
    const name = duplicate(value.series.map((series) => shortLabel(series.name)));
    if (name !== undefined)
      ctx.addIssue({ code: "custom", path: ["series"], message: `name "${name}" repeats within ${CARD_LIMITS.chartLabel} characters` });
    if (value.kind !== "pie") return;
    if (value.series.length !== 1) ctx.addIssue({ code: "custom", path: ["series"], message: "a pie chart takes exactly one series" });
    if (value.categories.length > CARD_LIMITS.maxSegments)
      ctx.addIssue({ code: "custom", path: ["categories"], message: `a pie chart takes at most ${CARD_LIMITS.maxSegments} segments` });
    if (value.series.some((series) => series.values.some((number) => number <= 0)))
      ctx.addIssue({ code: "custom", path: ["series"], message: "pie values must be above 0" });
  });

const column = z.object({
  title: text.optional().describe("Optional bold label above the text"),
  text: text.describe("Markdown value, e.g. **$12,400** ▲ 8% or 🔴 -3%"),
});

export const cardElementSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("header"), text: text.describe("Short plain text title") }),
  z.object({
    type: z.literal("section"),
    text: text.describe("Markdown paragraph"),
    button: button.optional().describe("Optional button on the right, e.g. a **bold** title row with a link to the full report"),
  }),
  z.object({
    type: z.literal("fields"),
    fields: z
      .array(text)
      .min(CARD_LIMITS.minFields)
      .max(CARD_LIMITS.maxFields)
      .describe(`1-${CARD_LIMITS.maxFields} short markdown fields shown in two columns, e.g. *Label*\\nvalue`),
  }),
  z.object({
    type: z.literal("table"),
    rows: z
      .array(z.array(z.string()).min(1))
      .min(1)
      .describe(
        `Rows of plain text cells, the first row is the header; at most ${MAX_TABLE_ROWS} rows and ${MAX_TABLE_COLS} columns are shown`,
      ),
  }),
  z.object({ type: z.literal("context"), text: text.describe("Small grey markdown note") }),
  z.object({ type: z.literal("divider") }),
  z.object({
    type: z.literal("buttons"),
    buttons: z.array(button).min(1).max(CARD_LIMITS.maxButtons).describe("Link or reply buttons"),
  }),
  chart,
  z.object({
    type: z.literal("columns"),
    rows: z
      .array(z.array(column).min(1).max(CARD_LIMITS.maxColumns))
      .min(1)
      .max(CARD_LIMITS.maxColumnRows)
      .describe(`1-${CARD_LIMITS.maxColumnRows} rows of 1-${CARD_LIMITS.maxColumns} columns shown side by side (stacked on mobile)`),
  }),
]);

export type CardElement = z.infer<typeof cardElementSchema>;

export interface DroppedElement {
  index: number;
  type?: string;
  reason: string;
}

export interface CardWarning {
  index: number;
  type?: string;
  message: string;
}

export type CardStep = { block: Block; warning?: string } | { reason: string };

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max - ELLIPSIS.length;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end) + ELLIPSIS;
}

function truncateMrkdwn(value: string, max: number): string {
  const cut = truncate(value, max);
  if (cut === value) return cut;
  const body = cut.slice(0, -ELLIPSIS.length);
  const open = body.lastIndexOf("<");
  return open > body.lastIndexOf(">") ? body.slice(0, open) + ELLIPSIS : cut;
}

const mrkdwn = (value: string, max: number) => ({
  type: "mrkdwn",
  text: truncateMrkdwn(withoutBroadcasts(fromMarkdown(value)), max),
});
const plainText = (value: string, max: number) => ({ type: "plain_text", text: truncate(value, max) });

type CardButton = z.infer<typeof button>;
type ChartElement = z.infer<typeof chart>;
type ColumnsElement = Extract<CardElement, { type: "columns" }>;
type Column = z.infer<typeof column>;

function buttonBlock(button: CardButton, index: number): Block {
  const base = {
    type: "button",
    text: plainText(button.text, CARD_LIMITS.buttonText),
    ...(button.style ? { style: button.style } : {}),
  };
  if (button.reply) return { ...base, action_id: `${CARD_REPLY_ACTION_PREFIX}${index}` };
  const url = button.url ?? "";
  return { ...base, action_id: `${CARD_LINK_ACTION_PREFIX}${index}`, url: httpsHref(url) ?? url };
}

export interface ButtonIds {
  blockId?: string;
  firstButton?: number;
}

function chartBlock(element: ChartElement): Block {
  const categories = element.categories.map(shortLabel);
  const title = truncate(withoutBroadcasts(element.title), CARD_LIMITS.chartTitle);
  if (element.kind === "pie") {
    const values = element.series[0].values;
    return {
      type: "data_visualization",
      title,
      chart: { type: "pie", segments: categories.map((label, index) => ({ label, value: values[index] })) },
    };
  }
  return {
    type: "data_visualization",
    title,
    chart: {
      type: element.kind,
      series: element.series.map((series) => ({
        name: shortLabel(series.name),
        data: categories.map((label, index) => ({ label, value: series.values[index] })),
      })),
      axis_config: {
        categories,
        ...(element.xLabel ? { x_label: truncate(withoutBroadcasts(element.xLabel), CARD_LIMITS.axisLabel) } : {}),
        ...(element.yLabel ? { y_label: truncate(withoutBroadcasts(element.yLabel), CARD_LIMITS.axisLabel) } : {}),
      },
    },
  };
}

const columnMarkdown = (column: Column) =>
  column.title ? `**${truncate(column.title, CARD_LIMITS.columnTitle)}**\n${column.text}` : column.text;

function layoutLabel(element: ColumnsElement): string {
  const columns = element.rows.flat();
  const titles = columns.flatMap((column) => (column.title ? [column.title] : []));
  return truncate(withoutBroadcasts(titles.length > 0 ? titles.join(" · ") : columns[0].text), CARD_LIMITS.layoutLabel);
}

function layoutBlock(element: ColumnsElement): Block {
  return {
    type: "layout",
    label: layoutLabel(element),
    rows: element.rows.map((row) => ({
      items: row.map((column) => ({ block: { type: "section", text: mrkdwn(columnMarkdown(column), CARD_LIMITS.sectionText) } })),
    })),
    fallback: element.rows.map((row) => ({
      type: "section",
      fields: row.map((column) => mrkdwn(columnMarkdown(column), CARD_LIMITS.fieldText)),
    })),
  };
}

export function elementToBlock(element: CardElement, ids: ButtonIds = {}): Block {
  switch (element.type) {
    case "header":
      return { type: "header", text: plainText(element.text, CARD_LIMITS.headerText) };
    case "section":
      return {
        type: "section",
        ...(element.button && ids.blockId ? { block_id: ids.blockId } : {}),
        text: mrkdwn(element.text, CARD_LIMITS.sectionText),
        ...(element.button ? { accessory: buttonBlock(element.button, ids.firstButton ?? 0) } : {}),
      };
    case "fields":
      return { type: "section", fields: element.fields.map((field) => mrkdwn(field, CARD_LIMITS.fieldText)) };
    case "table":
      return tableBlock(element.rows);
    case "context":
      return { type: "context", elements: [mrkdwn(element.text, CARD_LIMITS.contextText)] };
    case "divider":
      return { type: "divider" };
    case "buttons":
      return {
        type: "actions",
        ...(ids.blockId ? { block_id: ids.blockId } : {}),
        elements: element.buttons.map((button, index) => buttonBlock(button, (ids.firstButton ?? 0) + index)),
      };
    case "chart":
      return chartBlock(element);
    case "columns":
      return layoutBlock(element);
  }
}

export function parseElement(json: string): CardElement | null {
  try {
    const parsed = cardElementSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Block => typeof value === "object" && value !== null && !Array.isArray(value);

const records = (value: unknown): Block[] => (Array.isArray(value) ? value.filter(isRecord) : []);

const layoutItems = (block: Block) => records(block.rows).flatMap((row) => records(row.items));

export const countTables = (blocks: Block[]) => blocks.filter((block) => block.type === "table").length;

export const countCharts = (blocks: Block[]) =>
  blocks.reduce(
    (sum, block) =>
      sum +
      (block.type === "data_visualization" ? 1 : 0) +
      (block.type === "layout"
        ? layoutItems(block).filter((item) => isRecord(item.block) && item.block.type === "data_visualization").length
        : 0),
    0,
  );

export function blockWeight(block: Block): number {
  return block.type === "layout" ? 1 + layoutItems(block).length + records(block.fallback).length : 1;
}

export const blocksWeight = (blocks: Block[]) => blocks.reduce((sum, block) => sum + blockWeight(block), 0);

const RICH_BLOCK_TYPES = new Set<unknown>(["data_visualization", "layout"]);

export const isRichBlock = (block: Block) => RICH_BLOCK_TYPES.has(block.type);

const numberText = (value: unknown) => (typeof value === "number" ? String(value) : "");

function chartRows(block: Block): string[][] {
  const chart = isRecord(block.chart) ? block.chart : {};
  if (chart.type === "pie") return records(chart.segments).map((segment) => [String(segment.label ?? ""), numberText(segment.value)]);
  const series = records(chart.series);
  const axis = isRecord(chart.axis_config) ? chart.axis_config : {};
  const categories = Array.isArray(axis.categories) ? axis.categories.map(String) : [];
  const valueAt = (entry: Block, label: string) => numberText(records(entry.data).find((point) => point.label === label)?.value);
  return [
    [typeof axis.x_label === "string" ? axis.x_label : "", ...series.map((entry) => String(entry.name ?? ""))],
    ...categories.map((label) => [label, ...series.map((entry) => valueAt(entry, label))]),
  ];
}

function chartLines(rows: string[][], pie: boolean): string {
  const [head, ...body] = rows;
  const lines = pie ? rows : body;
  if (pie || head.length <= 2) return lines.map(([label, ...values]) => `• ${label}: ${values.join(" ")}`).join("\n");
  return body
    .map(([label, ...values]) => `• ${label}: ${values.map((value, index) => `${head[index + 1]} ${value}`).join(" · ")}`)
    .join("\n");
}

function chartFallback(block: Block, withTable: boolean): Block[] {
  const title = typeof block.title === "string" ? block.title : "";
  const rows = chartRows(block);
  const pie = isRecord(block.chart) && block.chart.type === "pie";
  if (withTable) return [{ type: "section", text: mrkdwn(`**${title}**`, CARD_LIMITS.sectionText) }, tableBlock(rows)];
  return [{ type: "section", text: mrkdwn(`**${title}**\n${chartLines(rows, pie)}`, CARD_LIMITS.sectionText) }];
}

export function plainBlocks(blocks: Block[]): Block[] {
  let tables = countTables(blocks.filter((block) => !isRichBlock(block)));
  return blocks.flatMap((block) => {
    if (block.type === "layout") {
      const fallback = records(block.fallback);
      tables += countTables(fallback);
      return fallback;
    }
    if (block.type !== "data_visualization") return [block];
    const withTable = tables < CARD_LIMITS.maxTables;
    if (withTable) tables += 1;
    return chartFallback(block, withTable);
  });
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join("; ");
}

function tableWarning(rows: string[][]): string | undefined {
  const columns = Math.max(...rows.map((row) => row.length));
  const cut = [
    rows.length > MAX_TABLE_ROWS ? `${rows.length - MAX_TABLE_ROWS} row(s) past ${MAX_TABLE_ROWS}` : null,
    columns > MAX_TABLE_COLS ? `${columns - MAX_TABLE_COLS} column(s) past ${MAX_TABLE_COLS}` : null,
  ].filter((part) => part !== null);
  return cut.length > 0 ? `table truncated: ${cut.join(" and ")} not shown` : undefined;
}

function chartWarning(element: ChartElement): string | undefined {
  const cut = [
    element.title.length > CARD_LIMITS.chartTitle ? `title past ${CARD_LIMITS.chartTitle} characters` : null,
    element.categories.some((label) => label.length > CARD_LIMITS.chartLabel) ? `labels past ${CARD_LIMITS.chartLabel} characters` : null,
    element.series.some((series) => series.name.length > CARD_LIMITS.chartLabel)
      ? `series names past ${CARD_LIMITS.chartLabel} characters`
      : null,
    [element.xLabel, element.yLabel].some((label) => label !== undefined && label.length > CARD_LIMITS.axisLabel)
      ? `axis titles past ${CARD_LIMITS.axisLabel} characters`
      : null,
  ].filter((part) => part !== null);
  return cut.length > 0 ? `chart text shortened: ${cut.join(", ")}` : undefined;
}

function elementWarning(element: CardElement): string | undefined {
  if (element.type === "table") return tableWarning(element.rows);
  if (element.type === "chart") return chartWarning(element);
  return undefined;
}

const hasButtons = (element: CardElement) => element.type === "buttons" || (element.type === "section" && element.button !== undefined);

const buttonCount = (element: CardElement) => (element.type === "buttons" ? element.buttons.length : 1);

export function createCardBuilder() {
  const card = crypto.randomUUID().slice(0, 8);
  let weight = 0;
  let tables = 0;
  let charts = 0;
  let rows = 0;
  let buttons = 0;

  const toBlock = (element: CardElement): Block => {
    if (!hasButtons(element)) return elementToBlock(element);
    const block = elementToBlock(element, { blockId: `${CARD_BUTTONS_BLOCK_PREFIX}${card}_${rows}`, firstButton: buttons });
    rows += 1;
    buttons += buttonCount(element);
    return block;
  };

  return function add(value: unknown): CardStep {
    const parsed = cardElementSchema.safeParse(value);
    if (!parsed.success) return { reason: `invalid element (${describeIssues(parsed.error)})` };
    const element = parsed.data;
    if (weight >= CARD_LIMITS.maxBlocks) return { reason: `a card holds at most ${CARD_LIMITS.maxBlocks} blocks` };
    if (element.type === "table" && tables >= CARD_LIMITS.maxTables) return { reason: "a card holds at most one table" };
    if (element.type === "chart" && charts >= CARD_LIMITS.maxCharts)
      return { reason: `a card holds at most ${CARD_LIMITS.maxCharts} charts` };
    const block = toBlock(element);
    const cost = Math.max(blockWeight(block), blocksWeight(plainBlocks([block])));
    if (weight + cost > CARD_LIMITS.maxBlocks) return { reason: `a card holds at most ${CARD_LIMITS.maxBlocks} blocks` };
    weight += cost;
    if (element.type === "table") tables += 1;
    if (element.type === "chart") charts += 1;
    const warning = elementWarning(element);
    return warning ? { block, warning } : { block };
  };
}

function elementType(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
  return typeof value.type === "string" ? value.type : undefined;
}

export function cardToBlocks(elements: unknown[]): {
  blocks: Block[];
  dropped: DroppedElement[];
  warnings: CardWarning[];
} {
  const add = createCardBuilder();
  const blocks: Block[] = [];
  const dropped: DroppedElement[] = [];
  const warnings: CardWarning[] = [];
  elements.forEach((value, index) => {
    const step = add(value);
    if (!("block" in step)) {
      dropped.push({ index, type: elementType(value), reason: step.reason });
      return;
    }
    blocks.push(step.block);
    if (step.warning) warnings.push({ index, type: elementType(value), message: step.warning });
  });
  return { blocks, dropped, warnings };
}
