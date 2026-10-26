import { describe, expect, it } from "vitest";
import { fromMarkdown, toBlocks } from "../../lib/slack/mrkdwn.ts";

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
