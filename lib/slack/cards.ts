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
  tableRows: MAX_TABLE_ROWS,
  tableColumns: MAX_TABLE_COLS,
} as const;

export const CARD_LINK_ACTION_PREFIX = "card_link_";

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

const linkButton = z.object({
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
    .describe("https link the button opens"),
});

export const cardElementSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("header"), text: text.describe("Short plain text title") }),
  z.object({ type: z.literal("section"), text: text.describe("Markdown paragraph") }),
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
    buttons: z.array(linkButton).min(1).max(CARD_LIMITS.maxButtons).describe("Link buttons"),
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

const BROADCAST_MENTION = /<!(channel|here|everyone)(\|[^>]*)?>/gi;

const withoutBroadcasts = (value: string) => value.replace(BROADCAST_MENTION, (_, name: string) => `@${name.toLowerCase()}`);

const mrkdwn = (value: string, max: number) => ({
  type: "mrkdwn",
  text: truncateMrkdwn(withoutBroadcasts(fromMarkdown(value)), max),
});
const plainText = (value: string, max: number) => ({ type: "plain_text", text: truncate(value, max) });

export function elementToBlock(element: CardElement): Block {
  switch (element.type) {
    case "header":
      return { type: "header", text: plainText(element.text, CARD_LIMITS.headerText) };
    case "section":
      return { type: "section", text: mrkdwn(element.text, CARD_LIMITS.sectionText) };
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
        elements: element.buttons.map((button, index) => ({
          type: "button",
          action_id: `${CARD_LINK_ACTION_PREFIX}${index}`,
          text: plainText(button.text, CARD_LIMITS.buttonText),
          url: httpsHref(button.url) ?? button.url,
        })),
      };
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

export function createCardBuilder() {
  let blocks = 0;
  let tables = 0;

  return function add(value: unknown): CardStep {
    const parsed = cardElementSchema.safeParse(value);
    if (!parsed.success) return { reason: `invalid element (${describeIssues(parsed.error)})` };
    if (blocks >= CARD_LIMITS.maxBlocks) return { reason: `a card holds at most ${CARD_LIMITS.maxBlocks} blocks` };
    if (parsed.data.type === "table") {
      if (tables >= CARD_LIMITS.maxTables) return { reason: "a card holds at most one table" };
      tables += 1;
    }
    blocks += 1;
    const warning = parsed.data.type === "table" ? tableWarning(parsed.data.rows) : undefined;
    return warning ? { block: elementToBlock(parsed.data), warning } : { block: elementToBlock(parsed.data) };
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
