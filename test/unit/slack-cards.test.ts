import { describe, expect, it } from "vitest";
import { CARD_LIMITS, cardToBlocks, createCardBuilder, elementToBlock, parseElement } from "../../lib/slack/cards.ts";

const blockOf = (element: unknown) => {
  const { blocks, dropped } = cardToBlocks([element]);
  expect(dropped).toEqual([]);
  return blocks[0];
};

const reasonOf = (element: unknown) => {
  const { blocks, dropped } = cardToBlocks([element]);
  expect(blocks).toEqual([]);
  return dropped[0].reason;
};

function texts(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => (key === "text" && typeof child === "string" ? [child] : texts(child)));
}

describe("card elements", () => {
  it("builds a header as plain text", () => {
    expect(blockOf({ type: "header", text: "  Urlopy  " })).toEqual({
      type: "header",
      text: { type: "plain_text", text: "Urlopy" },
    });
  });

  it("builds a section from markdown", () => {
    expect(blockOf({ type: "section", text: "**Bold** and [link](https://example.com)" })).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "*Bold* and <https://example.com|link>" },
    });
  });

  it("builds fields as a section with mrkdwn fields", () => {
    expect(blockOf({ type: "fields", fields: ["**Kto**\nAnia", "**Kiedy**\n1-3 XII"] })).toEqual({
      type: "section",
      fields: [
        { type: "mrkdwn", text: "*Kto*\nAnia" },
        { type: "mrkdwn", text: "*Kiedy*\n1-3 XII" },
      ],
    });
  });

  it("accepts a single field", () => {
    expect(blockOf({ type: "fields", fields: ["**Kto**\nAnia"] })).toEqual({
      type: "section",
      fields: [{ type: "mrkdwn", text: "*Kto*\nAnia" }],
    });
  });

  it("normalizes button URLs", () => {
    const [button] = blockOf({ type: "buttons", buttons: [{ text: "Doc", url: " https://example.com/a b?q=x y " }] }).elements as {
      url: string;
    }[];
    expect(button.url).toBe("https://example.com/a%20b?q=x%20y");
  });

  it("builds a table with the shared table helper", () => {
    expect(
      blockOf({
        type: "table",
        rows: [
          ["A", "**B**"],
          ["1", "2"],
        ],
      }),
    ).toEqual({
      type: "table",
      rows: [
        [
          { type: "raw_text", text: "A" },
          {
            type: "rich_text",
            elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "B", style: { bold: true } }] }],
          },
        ],
        [
          { type: "raw_text", text: "1" },
          { type: "raw_text", text: "2" },
        ],
      ],
    });
  });

  it("pads short table rows and fills blank cells", () => {
    expect(blockOf({ type: "table", rows: [["A", "B"], ["", "  "], ["1"]] })).toEqual({
      type: "table",
      rows: [
        [
          { type: "raw_text", text: "A" },
          { type: "raw_text", text: "B" },
        ],
        [
          { type: "raw_text", text: " " },
          { type: "raw_text", text: " " },
        ],
        [
          { type: "raw_text", text: "1" },
          { type: "raw_text", text: " " },
        ],
      ],
    });
  });

  it("builds a context block", () => {
    expect(blockOf({ type: "context", text: "_updated_ **now**" })).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: "_updated_ *now*" }],
    });
  });

  it("builds a divider", () => {
    expect(blockOf({ type: "divider" })).toEqual({ type: "divider" });
  });

  it("builds link buttons as an actions block", () => {
    expect(
      blockOf({
        type: "buttons",
        buttons: [
          { text: "PR", url: "https://github.com/a/b/pull/1" },
          { text: "Linear", url: "https://linear.app/x" },
        ],
      }),
    ).toEqual({
      type: "actions",
      block_id: expect.stringMatching(/^card_buttons_\w+_0$/),
      elements: [
        { type: "button", action_id: "card_link_0", text: { type: "plain_text", text: "PR" }, url: "https://github.com/a/b/pull/1" },
        { type: "button", action_id: "card_link_1", text: { type: "plain_text", text: "Linear" }, url: "https://linear.app/x" },
      ],
    });
  });

  it("keeps elementToBlock and parseElement usable on their own", () => {
    const element = parseElement('{"type":"divider","extra":1}');
    expect(element).toEqual({ type: "divider" });
    expect(elementToBlock(element!)).toEqual({ type: "divider" });
    expect(parseElement("{broken")).toBeNull();
    expect(parseElement('{"type":"unknown"}')).toBeNull();
  });
});

describe("card limits", () => {
  it("truncates a long header with an ellipsis", () => {
    const [text] = texts(blockOf({ type: "header", text: "x".repeat(400) }));
    expect(text).toHaveLength(CARD_LIMITS.headerText);
    expect(text.endsWith("…")).toBe(true);
  });

  it("truncates section, field, context and button text to their limits", () => {
    const long = "y".repeat(5000);
    expect(texts(blockOf({ type: "section", text: long }))[0]).toHaveLength(CARD_LIMITS.sectionText);
    expect(texts(blockOf({ type: "context", text: long }))[0]).toHaveLength(CARD_LIMITS.contextText);
    const [field, short] = texts(blockOf({ type: "fields", fields: [long, "ok"] }));
    expect(field).toHaveLength(CARD_LIMITS.fieldText);
    expect(short).toBe("ok");
    const [label] = texts(blockOf({ type: "buttons", buttons: [{ text: long, url: "https://a.io" }] }));
    expect(label).toHaveLength(CARD_LIMITS.buttonText);
  });

  it("does not leave half of a surrogate pair when truncating", () => {
    expect(texts(blockOf({ type: "header", text: `${"x".repeat(148)}😀😀` }))).toEqual([`${"x".repeat(148)}…`]);
  });

  it("keeps text at the limit untouched", () => {
    const text = "z".repeat(CARD_LIMITS.headerText);
    expect(texts(blockOf({ type: "header", text }))).toEqual([text]);
  });

  it("caps a table at 100 rows and 20 columns and reports the truncation", () => {
    const rows = Array.from({ length: 120 }, (_, row) => Array.from({ length: 25 }, (_, col) => `${row}:${col}`));
    const { blocks, dropped, warnings } = cardToBlocks([{ type: "divider" }, { type: "table", rows }]);
    const tableRows = blocks[1].rows as unknown[][];
    expect(tableRows).toHaveLength(100);
    expect(tableRows[0]).toHaveLength(20);
    expect(dropped).toEqual([]);
    expect(warnings).toEqual([
      { index: 1, type: "table", message: "table truncated: 20 row(s) past 100 and 5 column(s) past 20 not shown" },
    ]);
  });

  it("reports only the table dimension that was cut", () => {
    const add = createCardBuilder();
    expect(add({ type: "table", rows: Array.from({ length: 101 }, () => ["x"]) })).toMatchObject({
      warning: "table truncated: 1 row(s) past 100 not shown",
    });
    expect(createCardBuilder()({ type: "table", rows: [["a"], ["b"]] })).not.toHaveProperty("warning");
  });

  it("does not cut a mrkdwn link in half when truncating", () => {
    const link = "[docs](https://example.com/very/long/path)";
    const prefix = "p".repeat(CARD_LIMITS.sectionText - 20);
    const [text] = texts(blockOf({ type: "section", text: `${prefix} ${link} tail` }));
    expect(text).toBe(`${prefix} …`);
  });

  it("keeps a complete mrkdwn link before the cut", () => {
    const link = "[docs](https://example.com)";
    const prefix = "p".repeat(CARD_LIMITS.sectionText - 40);
    const [text] = texts(blockOf({ type: "section", text: `${prefix} ${link} ${"t".repeat(100)}` }));
    expect(text).toHaveLength(CARD_LIMITS.sectionText);
    expect(text).toContain("<https://example.com|docs>");
    expect(text.endsWith("…")).toBe(true);
  });

  it.each([
    ["an unknown type", { type: "image", url: "https://a.io/x.png" }],
    ["a missing type", { text: "x" }],
    ["an empty header", { type: "header", text: "   " }],
    ["a missing section text", { type: "section" }],
    ["no fields", { type: "fields", fields: [] }],
    ["eleven fields", { type: "fields", fields: Array.from({ length: 11 }, () => "f") }],
    ["an empty table", { type: "table", rows: [] }],
    ["an empty table row", { type: "table", rows: [[]] }],
    ["no buttons", { type: "buttons", buttons: [] }],
    ["six buttons", { type: "buttons", buttons: Array.from({ length: 6 }, () => ({ text: "b", url: "https://a.io" })) }],
    ["an http button", { type: "buttons", buttons: [{ text: "b", url: "http://a.io" }] }],
    ["a javascript button", { type: "buttons", buttons: [{ text: "b", url: "javascript:alert(1)" }] }],
    ["a relative button url", { type: "buttons", buttons: [{ text: "b", url: "/path" }] }],
    ["an overlong button url", { type: "buttons", buttons: [{ text: "b", url: `https://a.io/${"p".repeat(3000)}` }] }],
    ["a non object", "divider"],
    ["null", null],
  ])("rejects %s", (_, element) => {
    expect(reasonOf(element)).toMatch(/^invalid element/);
  });

  it("names the failing path in the reason", () => {
    expect(reasonOf({ type: "buttons", buttons: [{ text: "b", url: "http://a.io" }] })).toContain("buttons.0.url: must be an https URL");
  });
});

describe("cardToBlocks", () => {
  it("keeps order and reports dropped elements with index, type and reason", () => {
    const { blocks, dropped } = cardToBlocks([
      { type: "header", text: "T" },
      { type: "image" },
      { type: "table", rows: [["a"]] },
      { type: "table", rows: [["b"]] },
      42,
      { type: "divider" },
    ]);
    expect(blocks.map((block) => block.type)).toEqual(["header", "table", "divider"]);
    expect(dropped).toEqual([
      { index: 1, type: "image", reason: expect.stringMatching(/^invalid element/) },
      { index: 3, type: "table", reason: "a card holds at most one table" },
      { index: 4, type: undefined, reason: expect.stringMatching(/^invalid element/) },
    ]);
  });

  it("drops elements past 50 blocks", () => {
    const elements = Array.from({ length: 53 }, () => ({ type: "divider" }));
    const { blocks, dropped } = cardToBlocks(elements);
    expect(blocks).toHaveLength(CARD_LIMITS.maxBlocks);
    expect(dropped.map((entry) => entry.index)).toEqual([50, 51, 52]);
    expect(dropped[0].reason).toBe("a card holds at most 50 blocks");
  });

  it("does not count invalid elements toward the block limit", () => {
    const elements = [{ type: "nope" }, ...Array.from({ length: 50 }, () => ({ type: "divider" }))];
    expect(cardToBlocks(elements).blocks).toHaveLength(50);
  });

  it("returns nothing for an empty card", () => {
    expect(cardToBlocks([])).toEqual({ blocks: [], dropped: [], warnings: [] });
  });
});

describe("createCardBuilder", () => {
  it("keeps limits across calls so elements can be added as they stream", () => {
    const add = createCardBuilder();
    expect(add({ type: "table", rows: [["a"]] })).toEqual({ block: expect.objectContaining({ type: "table" }) });
    expect(add({ type: "table", rows: [["b"]] })).toEqual({ reason: "a card holds at most one table" });
    expect(createCardBuilder()({ type: "table", rows: [["c"]] })).toHaveProperty("block");
  });
});

describe("broadcast mentions", () => {
  it("turns channel-wide mentions in card text into plain text", () => {
    const text = "uwaga <!here> <!channel|channel> <!EVERYONE> i <@U123>";
    const plain = "uwaga @here @channel @everyone i <@U123>";
    expect(elementToBlock({ type: "section", text })).toEqual({ type: "section", text: { type: "mrkdwn", text: plain } });
    expect(elementToBlock({ type: "context", text })).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: plain }] });
    expect(elementToBlock({ type: "fields", fields: [text] })).toEqual({ type: "section", fields: [{ type: "mrkdwn", text: plain }] });
  });

  it("leaves normal replies alone", async () => {
    const { fromMarkdown } = await import("../../lib/slack/mrkdwn.ts");
    expect(fromMarkdown("uwaga <!here>")).toBe("uwaga <!here>");
  });
});
