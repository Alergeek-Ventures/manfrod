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
});

describe("cards", () => {
  it("drops elements that do not match the catalog", () => {
    expect(parseElement('{"type":"unknown"}')).toBeNull();
    expect(parseElement('{"type":"header"}')).toBeNull();
    expect(parseElement("{broken")).toBeNull();
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
