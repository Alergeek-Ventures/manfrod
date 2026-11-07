import { describe, expect, it } from "vitest";
import { createElementScanner } from "../../lib/slack/card-scan.ts";
import { elementToBlock, parseElement } from "../../lib/slack/cards.ts";

const input = '{"elements":[{"type":"header","text":"Hi {x}"},{"type":"section","text":"a \\"q\\" b"},{"type":"divider"}]}';

function feed(chunkSize: number) {
  const push = createElementScanner();
  const out: string[] = [];
  for (let i = 0; i < input.length; i += chunkSize) out.push(...push(input.slice(i, i + chunkSize)));
  return out;
}

describe("createElementScanner", () => {
  it("emits each element once it closes, whatever the chunking", () => {
    for (const size of [1, 2, 3, 7, 50, 1000]) {
      const elements = feed(size);
      expect(elements.map((e) => JSON.parse(e).type)).toEqual(["header", "section", "divider"]);
    }
  });

  it("does not emit an unfinished element", () => {
    const push = createElementScanner();
    expect(push('{"elements":[{"type":"header","te')).toEqual([]);
    expect(push('xt":"x"}')).toEqual(['{"type":"header","text":"x"}']);
  });

  it("handles braces and escaped quotes inside strings", () => {
    const [header, section] = feed(1);
    expect(JSON.parse(header).text).toBe("Hi {x}");
    expect(JSON.parse(section).text).toBe('a "q" b');
  });

  it("ignores a stray closing brace outside an element", () => {
    const push = createElementScanner();
    expect(push('{"elements":[}{"type":"divider"},{"type":"header","text":"x"}]}')).toEqual([
      '{"type":"divider"}',
      '{"type":"header","text":"x"}',
    ]);
  });

  it("closes a string that ends with an escaped backslash", () => {
    const push = createElementScanner();
    const [section, divider] = push('{"elements":[{"type":"section","text":"C:\\\\"},{"type":"divider"}]}');
    expect(JSON.parse(section).text).toBe("C:\\");
    expect(JSON.parse(divider).type).toBe("divider");
  });
});

describe("cards", () => {
  it("drops elements that do not match the catalog", () => {
    expect(parseElement('{"type":"unknown"}')).toBeNull();
    expect(parseElement('{"type":"header"}')).toBeNull();
    expect(parseElement("{broken")).toBeNull();
  });

  it("rejects blank text and oversized tables", () => {
    expect(parseElement('{"type":"section","text":"   "}')).toBeNull();
    expect(parseElement('{"type":"header","text":""}')).toBeNull();
    expect(parseElement('{"type":"table","rows":[[]]}')).toBeNull();
    expect(parseElement(JSON.stringify({ type: "table", rows: [Array(21).fill("x")] }))).toBeNull();
    expect(parseElement(JSON.stringify({ type: "table", rows: Array(101).fill(["x"]) }))).toBeNull();
  });

  it("pads short rows and fills empty cells", () => {
    const element = parseElement('{"type":"table","rows":[["A","B"],["",""],["1"]]}')!;
    expect(elementToBlock(element)).toEqual({
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

  it("builds a table block", () => {
    const element = parseElement('{"type":"table","rows":[["A","B"],["1","2"]]}')!;
    expect(elementToBlock(element)).toEqual({
      type: "table",
      rows: [
        [
          { type: "raw_text", text: "A" },
          { type: "raw_text", text: "B" },
        ],
        [
          { type: "raw_text", text: "1" },
          { type: "raw_text", text: "2" },
        ],
      ],
    });
  });
});
