import { describe, expect, it } from "vitest";
import { CARD_LIMITS, cardToBlocks, createCardBuilder, elementToBlock, parseElement } from "../../lib/slack/cards.ts";

type Block = Record<string, any>;

const sectionText = (text: string) => (elementToBlock({ type: "section", text }) as Block).text.text as string;
const hasLoneSurrogate = (value: string) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value);
const angleBalanced = (value: string) => {
  let open = false;
  for (const char of value) {
    if (char === "<") {
      if (open) return false;
      open = true;
    } else if (char === ">") {
      if (!open) return false;
      open = false;
    }
  }
  return !open;
};

describe("truncation boundaries", () => {
  it("never leaves a dangling < when a markdown link straddles the section limit", () => {
    const link = "[Raport kwartalny](https://example.com/very/long/path?x=1)";
    for (let pad = 2900; pad <= 3010; pad += 1) {
      const out = sectionText(`${"a".repeat(pad)} ${link} koniec`);
      expect(out.length).toBeLessThanOrEqual(CARD_LIMITS.sectionText);
      expect(angleBalanced(out)).toBe(true);
    }
  });

  it("never splits a surrogate pair at any section, header, field or button boundary", () => {
    for (let pad = 140; pad <= 155; pad += 1) {
      const header = (elementToBlock({ type: "header", text: `${"a".repeat(pad)}\u{1F600}\u{1F600}` }) as Block).text.text as string;
      expect(header.length).toBeLessThanOrEqual(CARD_LIMITS.headerText);
      expect(hasLoneSurrogate(header)).toBe(false);
    }
    for (let pad = 2990; pad <= 3005; pad += 1) {
      const out = sectionText(`${"a".repeat(pad)}\u{1F600}\u{1F600}\u{1F600}`);
      expect(out.length).toBeLessThanOrEqual(CARD_LIMITS.sectionText);
      expect(hasLoneSurrogate(out)).toBe(false);
    }
    for (let pad = 70; pad <= 80; pad += 1) {
      const block = elementToBlock({
        type: "buttons",
        buttons: [{ text: `${"a".repeat(pad)}\u{1F600}\u{1F600}`, url: "https://example.com" }],
      }) as Block;
      const label = block.elements[0].text.text as string;
      expect(label.length).toBeLessThanOrEqual(CARD_LIMITS.buttonText);
      expect(hasLoneSurrogate(label)).toBe(false);
    }
  });

  it("keeps short text untouched and ends truncated text with an ellipsis", () => {
    expect(sectionText("x".repeat(3000))).toHaveLength(3000);
    const cut = sectionText("x".repeat(3001));
    expect(cut).toHaveLength(3000);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("truncates each of fields to the field limit", () => {
    const block = elementToBlock({ type: "fields", fields: ["a".repeat(5000), "b"] }) as Block;
    expect(block.fields[0].text.length).toBeLessThanOrEqual(CARD_LIMITS.fieldText);
    expect(block.fields[1].text).toBe("b");
  });

  it("handles 100k character text without throwing", () => {
    expect(sectionText("z".repeat(100_000)).length).toBe(3000);
  });
});

describe("link buttons", () => {
  const accepted = (url: string) => parseElement(JSON.stringify({ type: "buttons", buttons: [{ text: "x", url }] })) !== null;

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>1</script>",
    "http://example.com",
    "ftp://example.com",
    "file:///etc/passwd",
    "//example.com",
    "example.com",
    "https://",
    "https://exa mple.com",
    "",
    "   ",
    "mailto:a@b.c",
    "slack://open",
  ])("rejects %j", (url) => {
    expect(accepted(url)).toBe(false);
  });

  it.each([
    "https://example.com",
    "  https://example.com  ",
    "HTTPS://EXAMPLE.COM/A",
    "https://example.com/a b",
    "https://zażółć.pl/ścieżka?q=ą",
  ])("accepts %j and emits an escaped https URL", (url) => {
    expect(accepted(url)).toBe(true);
    const element = parseElement(JSON.stringify({ type: "buttons", buttons: [{ text: "x", url }] }))!;
    const emitted = (elementToBlock(element) as Block).elements[0].url as string;
    expect(emitted.startsWith("https://")).toBe(true);
    expect(emitted).not.toMatch(/[\sĀ-￿]/);
  });

  it("rejects URLs over 3000 characters after normalisation, accepts exactly at the limit", () => {
    const base = "https://example.com/";
    expect(accepted(base + "a".repeat(3000 - base.length))).toBe(true);
    expect(accepted(base + "a".repeat(3001 - base.length))).toBe(false);
    expect(accepted(base + "a b".repeat(700))).toBe(false);
  });

  it("numbers action ids by position and caps buttons at five", () => {
    const buttons = Array.from({ length: 5 }, (_, index) => ({ text: `b${index}`, url: "https://example.com" }));
    const block = elementToBlock(parseElement(JSON.stringify({ type: "buttons", buttons }))!) as Block;
    expect(block.elements.map((button: Block) => button.action_id)).toEqual([
      "card_link_0",
      "card_link_1",
      "card_link_2",
      "card_link_3",
      "card_link_4",
    ]);
    expect(parseElement(JSON.stringify({ type: "buttons", buttons: [...buttons, buttons[0]] }))).toBeNull();
  });
});

describe("card builder limits", () => {
  it("keeps the first 50 blocks of 60 and rejects the rest", () => {
    const { blocks, dropped } = cardToBlocks(Array.from({ length: 60 }, () => ({ type: "divider" })));
    expect(blocks).toHaveLength(50);
    expect(dropped).toHaveLength(10);
    expect(dropped[0]).toMatchObject({ index: 50 });
  });

  it("allows one table and drops the second without consuming a block", () => {
    const table = { type: "table", rows: [["a"]] };
    const { blocks, dropped } = cardToBlocks([table, table, { type: "divider" }]);
    expect(blocks.map((block) => block.type)).toEqual(["table", "divider"]);
    expect(dropped).toEqual([{ index: 1, type: "table", reason: "a card holds at most one table" }]);
  });

  it("does not count invalid elements toward the table or block quota", () => {
    const { blocks, dropped } = cardToBlocks([
      { type: "table", rows: [] },
      { type: "table", rows: [["ok"]] },
    ]);
    expect(blocks).toHaveLength(1);
    expect(dropped).toHaveLength(1);
  });

  it("drops wrong shapes while keeping valid neighbours and the real index", () => {
    const items = [
      null,
      5,
      "text",
      [],
      {},
      { type: 7 },
      { type: "header" },
      { type: "header", text: "   " },
      { type: "fields", fields: [] },
      { type: "header", text: "ok" },
    ];
    const { blocks, dropped } = cardToBlocks(items);
    expect(blocks).toHaveLength(1);
    expect(dropped.map((item) => item.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(dropped[5].type).toBeUndefined();
  });

  it("rejects 11 fields, accepts 10", () => {
    expect(parseElement(JSON.stringify({ type: "fields", fields: Array.from({ length: 11 }, () => "x") }))).toBeNull();
    expect(parseElement(JSON.stringify({ type: "fields", fields: Array.from({ length: 10 }, () => "x") }))).not.toBeNull();
  });

  it("builders are independent", () => {
    const first = createCardBuilder();
    const second = createCardBuilder();
    expect(first({ type: "table", rows: [["a"]] })).toHaveProperty("block");
    expect(second({ type: "table", rows: [["a"]] })).toHaveProperty("block");
    expect(first({ type: "table", rows: [["a"]] })).toHaveProperty("reason");
  });

  it("does not throw on hostile values", () => {
    const circularFree = [
      { type: "table", rows: [[null]] },
      { type: "table", rows: "x" },
      { type: "section", text: { toString: () => "x" } },
      { type: "__proto__" },
      Object.create(null),
    ];
    expect(() => cardToBlocks(circularFree)).not.toThrow();
  });
});

describe("tables", () => {
  it("pads ragged rows, replaces blank cells and cuts to 100x20 with a warning", () => {
    const rows = Array.from({ length: 130 }, (_, row) =>
      Array.from({ length: row === 0 ? 30 : 3 }, (_, col) => (col === 1 ? "" : `${row}:${col}`)),
    );
    const { blocks, warnings } = cardToBlocks([{ type: "table", rows }]);
    const table = blocks[0] as Block;
    expect(table.rows).toHaveLength(100);
    for (const row of table.rows) expect(row).toHaveLength(20);
    expect(warnings[0].message).toContain("30 row(s)");
    expect(warnings[0].message).toContain("10 column(s)");
  });

  it("copes with huge cells and bold markup", () => {
    const { blocks } = cardToBlocks([{ type: "table", rows: [["**bold**", "x".repeat(100_000)]] }]);
    expect((blocks[0] as Block).rows[0]).toHaveLength(2);
  });
});
