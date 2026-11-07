import { describe, expect, it } from "vitest";
import { createElementScanner } from "../../lib/slack/card-scan.ts";

const elements = [
  { type: "header", text: "Hi {x} [y]" },
  { type: "section", text: 'a "q" b \\ c } ] { [' },
  { type: "section", text: 'zażółć ☃ \u{1F600} "quoted"' },
  {
    type: "table",
    rows: [
      ["A", "B"],
      ["}", "]"],
    ],
  },
  { type: "buttons", buttons: [{ text: "Open", url: "https://example.com/?a=[1]&b={2}" }] },
  { type: "divider" },
];

const pretty = JSON.stringify({ elements }, null, 2);
const compact = JSON.stringify({ elements });
const escapedUnicode = compact.replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

function scanChunks(chunks: string[]) {
  const push = createElementScanner();
  return chunks.flatMap((chunk) => push(chunk));
}

function scanAll(input: string) {
  return scanChunks([input]);
}

describe("createElementScanner", () => {
  it.each([
    ["compact", compact],
    ["pretty", pretty],
    ["unicode escapes", escapedUnicode],
  ])("emits every element of %s JSON", (_, input) => {
    expect(scanAll(input).map((json) => JSON.parse(json))).toEqual(elements);
  });

  it.each([
    ["compact", compact],
    ["pretty", pretty],
    ["unicode escapes", escapedUnicode],
  ])("yields identical elements from %s JSON split at every position", (_, input) => {
    const whole = scanAll(input);
    for (let split = 0; split <= input.length; split += 1) {
      expect(scanChunks([input.slice(0, split), input.slice(split)])).toEqual(whole);
    }
  });

  it("yields identical elements when fed one character at a time", () => {
    expect(scanChunks([...escapedUnicode])).toEqual(scanAll(escapedUnicode));
    expect(scanChunks(compact.split(""))).toEqual(scanAll(compact));
  });

  it("emits an element only once it closes", () => {
    const push = createElementScanner();
    expect(push('{"elements":[{"type":"header","te')).toEqual([]);
    expect(push('xt":"x"}')).toEqual(['{"type":"header","text":"x"}']);
    expect(push(',{"type":"divider"')).toEqual([]);
    expect(push("}")).toEqual(['{"type":"divider"}']);
  });

  it("ignores everything after the elements array closes", () => {
    const push = createElementScanner();
    expect(push('{"elements":[{"type":"divider"}],"other":[{"type":"header"}]}')).toEqual(['{"type":"divider"}']);
    expect(push('{"type":"header"}')).toEqual([]);
  });

  it("only reads the top level elements key", () => {
    const input = JSON.stringify({
      note: '"elements":[{"type":"fake"}]',
      meta: { elements: [{ type: "nested" }] },
      list: [{ elements: [{ type: "deep" }] }],
      elements: [{ type: "divider" }],
    });
    expect(scanAll(input)).toEqual(['{"type":"divider"}']);
  });

  it("skips items of the array that are not objects", () => {
    const input = '{"elements":["{",1,null,[{"type":"inner"}],{"type":"divider"}]}';
    expect(scanAll(input)).toEqual(['{"type":"divider"}']);
  });

  it("ignores a stray closing brace outside an element", () => {
    expect(scanAll('{"elements":[}{"type":"divider"},{"type":"header","text":"x"}]}')).toEqual([
      '{"type":"divider"}',
      '{"type":"header","text":"x"}',
    ]);
  });

  it("ignores a closing bracket that does not match the open one", () => {
    expect(scanAll('{"elements":[{"type":"divider"]},{"type":"header","text":"x"}]}')).toEqual([
      '{"type":"divider"]}',
      '{"type":"header","text":"x"}',
    ]);
  });

  it("closes a string that ends with an escaped backslash", () => {
    const [section, divider] = scanAll('{"elements":[{"type":"section","text":"C:\\\\"},{"type":"divider"}]}');
    expect(JSON.parse(section).text).toBe("C:\\");
    expect(JSON.parse(divider).type).toBe("divider");
  });

  it("emits nothing without an elements array", () => {
    expect(scanAll('{"elements":"[{}]","items":[{"type":"divider"}]}')).toEqual([]);
  });
});

describe("scanner performance", () => {
  it("stays linear for a huge element in token-sized deltas", () => {
    const text = "y".repeat(200_000);
    const payload = JSON.stringify({ elements: [{ type: "section", text }] });
    const push = createElementScanner();
    const started = performance.now();
    const completed: string[] = [];
    for (let index = 0; index < payload.length; index += 4) completed.push(...push(payload.slice(index, index + 4)));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(completed).toEqual([JSON.stringify({ type: "section", text })]);
  });
});
