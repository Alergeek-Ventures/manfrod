import { describe, expect, it } from "vitest";
import { matchesQuery, mostFrequent, viewStats } from "../../lib/memory/graph-view.ts";
import type { GraphData, GraphNodeData } from "../../lib/memory/nodes.ts";

const node = (id: string, degree: number, processed = true): GraphNodeData => ({
  id,
  preview: id,
  processed,
  projectId: null,
  userId: "user",
  insertedAt: "2026-11-14T10:00:00.000Z",
  degree,
});

describe("graph view adversarial cases", () => {
  it("returns finite zero stats for an empty graph", () => {
    expect(viewStats({ nodes: [], edges: [] })).toEqual({
      total_nodes: 0,
      total_links: 0,
      slipbox_count: 0,
      orphan_count: 0,
      weakly_connected_count: 0,
      link_to_note_ratio: 0,
    });
  });

  it("does not classify unprocessed notes as weak or orphaned", () => {
    const graph: GraphData = {
      nodes: [node("unprocessed-orphan", 0, false), node("unprocessed-weak", 1, false), node("processed-weak", 1)],
      edges: [],
    };
    expect(viewStats(graph)).toMatchObject({ slipbox_count: 2, orphan_count: 0, weakly_connected_count: 1 });
  });

  it.each([
    ["Zażółć\ngęślą jaźń 🚀🧠", "zazolc gesla", true],
    ["literal regex .*[]() content", ".*[]()", true],
    ["Alpha beta gamma", "GAMMA alpha", true],
    ["Alpha beta gamma", "alpha delta", false],
    ["emoji 🚀🧠 across\nlines", "🚀🧠 lines", true],
    ["anything", "   ", true],
  ])("matches %j against %j as %s", (text, query, expected) => {
    expect(matchesQuery(text, query)).toBe(expected);
  });

  it("uses a deterministic lexical tie-break and respects a zero limit", () => {
    expect(mostFrequent(["ż", "a", "ż", "a"], 2)).toEqual(["a", "ż"]);
    expect(mostFrequent(["a"], 0)).toEqual([]);
  });
});
