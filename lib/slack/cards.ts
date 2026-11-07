import { z } from "zod";
import { fromMarkdown } from "./mrkdwn.ts";

const MAX_SECTION_TEXT = 2900;
const MAX_HEADER_TEXT = 150;

export const cardElementSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("header"), text: z.string().min(1) }),
  z.object({ type: z.literal("section"), text: z.string().min(1) }),
  z.object({ type: z.literal("divider") }),
  z.object({ type: z.literal("table"), rows: z.array(z.array(z.string())).min(1) }),
]);

export type CardElement = z.infer<typeof cardElementSchema>;

export function elementToBlock(element: CardElement): Record<string, unknown> {
  switch (element.type) {
    case "header":
      return { type: "header", text: { type: "plain_text", text: element.text.slice(0, MAX_HEADER_TEXT) } };
    case "section":
      return { type: "section", text: { type: "mrkdwn", text: fromMarkdown(element.text).slice(0, MAX_SECTION_TEXT) } };
    case "divider":
      return { type: "divider" };
    case "table":
      return { type: "table", rows: element.rows.map((row) => row.map((text) => ({ type: "raw_text", text }))) };
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
