import { describe, expect, it } from "vitest";
import { extractRecords } from "../../lib/firmowid.ts";

describe("extractRecords", () => {
  const session = { id: "s1", start_datetime: "2026-10-26T14:00:00Z" };

  it("reads paginated list_sessions results", () => {
    expect(extractRecords({ structuredContent: { has_more: true, results: [session] } })).toEqual([session]);
    expect(extractRecords({ content: [{ type: "text", text: JSON.stringify({ has_more: false, results: [session] }) }] })).toEqual([
      session,
    ]);
  });

  it("reads a plain array like get_current_session returns", () => {
    expect(extractRecords({ content: [{ type: "text", text: JSON.stringify([session]) }] })).toEqual([session]);
  });
});
