import type { GraphData, GraphStats } from "./nodes.ts";

export function viewStats(graph: GraphData): GraphStats {
  let slipbox = 0;
  let orphans = 0;
  let weak = 0;
  for (const node of graph.nodes) {
    if (!node.processed) {
      slipbox += 1;
      continue;
    }
    if (node.degree === 0) orphans += 1;
    if (node.degree === 1) weak += 1;
  }
  const total = graph.nodes.length;
  return {
    total_nodes: total,
    total_links: graph.edges.length,
    slipbox_count: slipbox,
    orphan_count: orphans,
    weakly_connected_count: weak,
    link_to_note_ratio: total > 0 ? Math.round((graph.edges.length / total) * 100) / 100 : 0,
  };
}

export function mostFrequent(values: (string | null)[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

export const normalizeText = (text: string) =>
  text
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

export function matchesQuery(text: string, query: string): boolean {
  const haystack = normalizeText(text);
  return normalizeText(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}
