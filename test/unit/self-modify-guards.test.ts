import { describe, expect, it } from "vitest";
import { missingToolTests } from "../../agent/lib/self-modify.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("missingToolTests", () => {
  const tool = { path: "agent/tools/edit-slack-canvas.ts", status: "A" as const };

  it("rejects a new tool without a test that imports it", () => {
    expect(missingToolTests([tool], new Map())).toEqual([
      "agent/tools/edit-slack-canvas.ts: a new tool needs a test under test/ that imports it and covers its access rules",
    ]);
    const unrelated = { path: "test/unit/other.test.ts", status: "A" as const };
    expect(missingToolTests([tool, unrelated], new Map([[unrelated.path, bytes('import "../../lib/x.ts";')]]))).toHaveLength(1);
    const mention = { path: "test/unit/mention.test.ts", status: "A" as const };
    const text = 'const name = "agent/tools/edit-slack-canvas.ts"; // tools/edit-slack-canvas';
    expect(missingToolTests([tool, mention], new Map([[mention.path, bytes(text)]]))).toHaveLength(1);
  });

  it("accepts a new tool with a test that imports it, and ignores edits to existing tools", () => {
    const test = { path: "test/unit/canvas.test.ts", status: "A" as const };
    const contents = new Map([[test.path, bytes('await import("../../agent/tools/edit-slack-canvas.ts");')]]);
    expect(missingToolTests([tool, test], contents)).toEqual([]);
    const staticImport = new Map([[test.path, bytes('import tool from "../../agent/tools/edit-slack-canvas.ts";')]]);
    expect(missingToolTests([tool, test], staticImport)).toEqual([]);
    expect(missingToolTests([{ path: "agent/tools/post-slack-message.ts", status: "M" }], new Map())).toEqual([]);
  });
});
