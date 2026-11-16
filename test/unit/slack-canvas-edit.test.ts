import { afterEach, describe, expect, it, vi } from "vitest";
import { editCanvas, lookupCanvasSections } from "../../lib/slack/api.ts";

function stubSlack(response: Record<string, unknown>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(response), { status: 200 });
  });
  return calls;
}

describe("Slack canvas editing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends markdown content for an insert after a section", async () => {
    const calls = stubSlack({ ok: true });
    const result = await editCanvas("F1", { operation: "insert_after", markdown: "## May", sectionId: "temp:C:1" });
    expect(result.ok).toBe(true);
    expect(calls[0].url).toMatch(/canvases\.edit$/);
    expect(calls[0].body).toEqual({
      canvas_id: "F1",
      changes: [{ operation: "insert_after", section_id: "temp:C:1", document_content: { type: "markdown", markdown: "## May" } }],
    });
  });

  it("passes the Slack error through", async () => {
    stubSlack({ ok: false, error: "missing_scope" });
    expect(await editCanvas("F1", { operation: "replace", markdown: "x" })).toEqual({ ok: false, error: "missing_scope" });
  });

  it("returns section IDs from a lookup", async () => {
    const calls = stubSlack({ ok: true, sections: [{ id: "temp:C:1" }, { id: "temp:C:2" }] });
    const result = await lookupCanvasSections("F1", { sectionTypes: ["any_header"], containsText: "May" });
    expect(result).toEqual({ ok: true, ids: ["temp:C:1", "temp:C:2"] });
    expect(calls[0].body).toEqual({ canvas_id: "F1", criteria: { section_types: ["any_header"], contains_text: "May" } });
  });
});
