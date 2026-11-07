import { describe, expect, it } from "vitest";
import { createElementScanner } from "../../lib/slack/card-scan.ts";

function prng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function scanChunks(chunks: string[]) {
  const push = createElementScanner();
  return chunks.flatMap((chunk) => push(chunk));
}

function randomChunks(input: string, random: () => number, max: number) {
  const chunks: string[] = [];
  for (let index = 0; index < input.length;) {
    const size = 1 + Math.floor(random() * max);
    chunks.push(input.slice(index, index + size));
    index += size;
  }
  return chunks;
}

const nasty = [
  { type: "section", text: 'quote " backslash \\ brace } bracket ] \\" \\\\" end' },
  { type: "section", text: "emoji \u{1F600}\u{1F468}‍\u{1F469}‍\u{1F467} and \u{10FFFF} done" },
  { type: "header", text: "\\u0022 \\n \\\\ \\/ ] }" },
  {
    type: "table",
    rows: [
      ["{", "["],
      ['"', "\\"],
    ],
  },
  { type: "divider" },
];

describe("scanner random chunking", () => {
  const payloads = [
    JSON.stringify({ elements: nasty }),
    JSON.stringify({ elements: nasty }, null, 2),
    JSON.stringify({ elements: nasty }).replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`),
  ];

  it("gives the same result for 500 random splits, including inside escapes and surrogate pairs", () => {
    const random = prng(42);
    for (const payload of payloads) {
      const whole = scanChunks([payload]);
      expect(whole.map((json) => JSON.parse(json))).toEqual(nasty);
      for (let round = 0; round < 500; round += 1) {
        expect(scanChunks(randomChunks(payload, random, 1 + (round % 12)))).toEqual(whole);
      }
    }
  });

  it("survives a split between the two halves of every surrogate pair", () => {
    const payload = payloads[0];
    const whole = scanChunks([payload]);
    for (let index = 0; index < payload.length; index += 1) {
      const code = payload.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) expect(scanChunks([payload.slice(0, index + 1), payload.slice(index + 1)])).toEqual(whole);
    }
  });
});

describe("scanner shapes", () => {
  const scan = (value: string) => scanChunks([value]);

  it("ignores non-object items and nested arrays but emits objects around them", () => {
    const out = scan('{"elements":[1,null,"x",true,[{"type":"divider"}],{"type":"header","text":"h"},[],{}]}');
    expect(out).toEqual(['{"type":"header","text":"h"}', "{}"]);
  });

  it("does not mistake nested or earlier keys for the root elements array", () => {
    const out = scan('{"meta":{"elements":[{"type":"divider"}]},"note":"elements","elements":[{"type":"header","text":"h"}]}');
    expect(out).toEqual(['{"type":"header","text":"h"}']);
  });

  it("ignores elements declared as a non-array and anything after the array closes", () => {
    expect(scan('{"elements":{"type":"divider"}}')).toEqual([]);
    const push = createElementScanner();
    expect(push('{"elements":[{"type":"divider"}]}')).toEqual(['{"type":"divider"}']);
    expect(push('{"elements":[{"type":"divider"}]}')).toEqual([]);
  });

  it("emits nothing for garbage, empty and truncated input", () => {
    for (const value of ["", "not json", "[]", "[{}]", '{"elements":[{"type":"div', '{"elements":', "}}}]]]"])
      expect(scan(value)).toEqual([]);
  });

  it("handles deeply nested element content", () => {
    const deep = `${"[".repeat(500)}${"]".repeat(500)}`;
    const element = `{"type":"table","rows":${deep}}`;
    expect(scan(`{"elements":[${element}]}`)).toEqual([element]);
  });
});

describe("scanner size", () => {
  it("handles thousands of elements and a megabyte string quickly", () => {
    const many = Array.from({ length: 5000 }, (_, index) => ({ type: "section", text: `row ${index}` }));
    const big = { type: "section", text: "x".repeat(1_000_000) };
    const payload = JSON.stringify({ elements: [...many, big] });
    const started = Date.now();
    const out = scanChunks([payload]);
    expect(out).toHaveLength(5001);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
