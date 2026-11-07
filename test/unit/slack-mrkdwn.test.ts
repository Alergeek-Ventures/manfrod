import { describe, expect, it } from "vitest";
import { fromMarkdown, tableBlock, toBlocks } from "../../lib/slack/mrkdwn.ts";

const PR_URL = "https://github.com/Alergeek-Ventures/manfrod/pull/125";

describe("fromMarkdown", () => {
  it("keeps Slack links to pull requests intact", () => {
    const text = `<${PR_URL}|#125> czeka na review`;
    expect(fromMarkdown(text)).toBe(text);
  });

  it("keeps a Slack pull request link at the start of a line", () => {
    const text = `zrobione\n<${PR_URL}|#125> zamknięty`;
    expect(fromMarkdown(text)).toBe(text);
  });

  it("converts markdown pull request links to Slack links", () => {
    expect(fromMarkdown(`[#125](${PR_URL}) czeka na review`)).toBe(`<${PR_URL}|#125> czeka na review`);
  });

  it("keeps Slack pull request links in plain text output", () => {
    const text = `- <${PR_URL}|#125> czeka na review`;
    expect(toBlocks(text)).toEqual({ text: `• <${PR_URL}|#125> czeka na review`, blocks: null });
  });
});

describe("tableBlock", () => {
  it("pads ragged rows to the widest row and replaces blank cells with a space", () => {
    expect(tableBlock([["A", "B", "C"], ["1"], ["", " ", "x"]])).toEqual({
      type: "table",
      rows: [
        [
          { type: "raw_text", text: "A" },
          { type: "raw_text", text: "B" },
          { type: "raw_text", text: "C" },
        ],
        [
          { type: "raw_text", text: "1" },
          { type: "raw_text", text: " " },
          { type: "raw_text", text: " " },
        ],
        [
          { type: "raw_text", text: " " },
          { type: "raw_text", text: " " },
          { type: "raw_text", text: "x" },
        ],
      ],
    });
  });

  it("pads markdown tables with empty cells", () => {
    const { blocks } = toBlocks("| A | B |\n|---|---|\n| 1 | |\n| 2 |");
    expect(blocks).toEqual([
      tableBlock([
        ["A", "B"],
        ["1", " "],
        ["2", " "],
      ]),
    ]);
  });
});
