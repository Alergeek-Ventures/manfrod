import { describe, expect, it } from "vitest";
import { matchesQuery, mostFrequent, nodeDegrees, viewStats } from "../../lib/memory/graph-view.ts";
import type { GraphData } from "../../lib/memory/nodes.ts";

const note = (id: string, processed = true) => ({
  id,
  preview: id,
  processed,
  projectId: null,
  userId: "u",
  insertedAt: "2026-11-14T10:00:00.000Z",
});

describe("graph view", () => {
  const graph: GraphData = {
    nodes: [note("a"), note("b"), note("c"), note("orphan"), note("slipbox", false)],
    edges: [
      ["a", "b"],
      ["a", "c"],
    ],
  };

  it("counts degrees, orphans and weak notes among processed notes only", () => {
    const degrees = nodeDegrees(graph);
    expect(degrees.get("a")).toBe(2);
    expect(degrees.get("slipbox")).toBe(0);
    expect(viewStats(graph, degrees)).toEqual({
      total_nodes: 5,
      total_links: 2,
      slipbox_count: 1,
      orphan_count: 1,
      weakly_connected_count: 2,
      link_to_note_ratio: 0.4,
    });
  });

  it("ranks the most frequent values and skips nulls", () => {
    expect(mostFrequent(["x", null, "y", "x", null, "z", "y", "x"], 2)).toEqual(["x", "y"]);
  });

  it("matches every search term regardless of case and Polish diacritics", () => {
    expect(matchesQuery("Stanisław Madej ustalił termin wdrożenia", "stanislaw WDROZENIA")).toBe(true);
    expect(matchesQuery("Stanisław Madej ustalił termin", "madej budżet")).toBe(false);
  });
});
