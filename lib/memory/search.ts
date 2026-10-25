import { and, cosineDistance, eq, inArray, isNotNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { Node } from "../db/schema.ts";
import { emit } from "../events/index.ts";
import { embed, rerank } from "../voyage.ts";
import { accessOverlaps } from "./access.ts";
import { getSoulAnchor } from "./nodes.ts";
import { expand } from "./query-expander.ts";

const { nodes, links } = tables;

export const RELEVANCE_THRESHOLD = 0.4;
export const RERANK_THRESHOLD = 0.25;
const NOTE_CONTEXT_CHARS = 6_000;
const NOTE_CHARS = 600;
const RRF_K = 60;

type Scored = { node: Node; distance: number };

function projectBound(projectId: string | null | undefined): SQL | undefined {
  return projectId ? eq(nodes.projectId, projectId) : undefined;
}

async function embedQueries(queries: string[]): Promise<(number[] | null)[]> {
  if (queries.length === 0) return [];
  try {
    return await embed(queries, { inputType: "query" });
  } catch {
    return queries.map(() => null);
  }
}

async function vectorSearchWithDistance(
  readableLevels: string[],
  embedding: number[],
  limit: number,
  projectId: string | null,
): Promise<Scored[]> {
  const distance = cosineDistance(nodes.embedding, embedding);
  const rows = await db
    .select({ node: nodes, distance })
    .from(nodes)
    .where(and(isNotNull(nodes.embedding), accessOverlaps(nodes.access, readableLevels), projectBound(projectId)))
    .orderBy(distance)
    .limit(limit);
  return rows.map((row) => ({ node: row.node, distance: Number(row.distance) }));
}

export async function searchBm25(
  readableLevels: string[],
  queryText: string,
  limit = 10,
  projectId: string | null = null,
): Promise<Node[]> {
  const score = sql<number>`paradedb.score(${nodes.id})`;
  try {
    const rows = await db
      .select({ node: nodes, score })
      .from(nodes)
      .where(
        and(
          sql`${nodes.id} @@@ paradedb.match(${"content"}::paradedb.fieldname, ${queryText}, distance => 0, transposition_cost_one => true, prefix => false, conjunction_mode => false)`,
          accessOverlaps(nodes.access, readableLevels),
          projectBound(projectId),
        ),
      )
      .orderBy(sql`${score} DESC`)
      .limit(limit);
    return rows.map((row) => row.node);
  } catch {
    return [];
  }
}

export async function similarNodes(
  node: Node,
  readableLevels: string[],
  opts: { limit?: number; maxDistance?: number } = {},
): Promise<Scored[]> {
  if (!node.embedding) return [];
  const distance = cosineDistance(nodes.embedding, node.embedding);
  const rows = await db
    .select({ node: nodes, distance })
    .from(nodes)
    .where(
      and(
        ne(nodes.id, node.id),
        isNotNull(nodes.embedding),
        accessOverlaps(nodes.access, readableLevels),
        lt(distance, opts.maxDistance ?? 1.0),
      ),
    )
    .orderBy(distance)
    .limit(opts.limit ?? 3);
  return rows.map((row) => ({ node: row.node, distance: Number(row.distance) }));
}

export function rrfMerge(rankedLists: (Node | Scored)[][]): Node[] {
  const scores = new Map<string, { node: Node; score: number }>();
  for (const list of rankedLists) {
    list.forEach((item, index) => {
      const node = "node" in item && "distance" in item ? item.node : (item as Node);
      const entry = scores.get(node.id) ?? { node, score: 0 };
      entry.score += 1 / (RRF_K + index + 1);
      scores.set(node.id, entry);
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score).map((entry) => entry.node);
}

async function rerankNodes(query: string, candidatesIn: Node[], topK: number) {
  const candidates = candidatesIn.slice(0, topK);
  try {
    const rankings = await rerank(
      query,
      candidates.map((node) => node.content),
      { topK },
    );
    const reordered = rankings.map((ranking) => ({ node: candidates[ranking.index], score: ranking.relevance_score }));
    return {
      nodes: reordered.map((item) => item.node),
      scores: reordered.map((item) => ({
        node_id: item.node.id,
        score: item.score,
        content_preview: (item.node.content ?? "").slice(0, 60),
      })),
    };
  } catch {
    return { nodes: candidates, scores: [] };
  }
}

async function expandWithLinks(found: Node[], readableLevels: string[], max: number): Promise<Node[]> {
  if (found.length === 0) return [];
  const ids = found.map((node) => node.id);
  const linked = await db
    .select({ node: nodes })
    .from(nodes)
    .innerJoin(
      links,
      or(and(inArray(links.nodeAId, ids), eq(links.nodeBId, nodes.id)), and(inArray(links.nodeBId, ids), eq(links.nodeAId, nodes.id))),
    )
    .where(accessOverlaps(nodes.access, readableLevels));

  const seen = new Set<string>();
  const all = [...found, ...linked.map((row) => row.node)].filter((node) => (seen.has(node.id) ? false : (seen.add(node.id), true)));
  return all.slice(0, max);
}

async function retrieveLists(readableLevels: string[], queries: string[], limit: number, projectId: string | null) {
  const [embeddings, bm25] = await Promise.all([
    embedQueries(queries),
    Promise.all(queries.map((query) => searchBm25(readableLevels, query, limit, projectId))),
  ]);
  const vector = await Promise.all(
    embeddings.map((embedding) => (embedding ? vectorSearchWithDistance(readableLevels, embedding, limit, projectId) : [])),
  );
  return { vector, bm25 };
}

export interface SearchOptions {
  limit?: number;
  expandQuery?: boolean;
  rerank?: boolean;
  projectId?: string | null;
}

export async function search(
  userId: string | null,
  readableLevels: string[],
  queryText: string,
  opts: SearchOptions = {},
): Promise<Node[]> {
  const limit = opts.limit ?? 10;
  const expandQuery = opts.expandQuery ?? true;
  const rerankEnabled = opts.rerank ?? true;
  const projectId = opts.projectId ?? null;

  const retrieve = (batch: string[]) => retrieveLists(readableLevels, batch, limit, projectId);
  const [original, queries] = await Promise.all([retrieve([queryText]), expandQuery ? expand(queryText) : [queryText]]);
  const expanded = await retrieve(queries.filter((query) => query !== queryText));

  const vectorLists = [...original.vector, ...expanded.vector];
  const bm25Lists = [...original.bm25, ...expanded.bm25];
  const vectorResults = vectorLists.flat();
  const bm25Results = bm25Lists.flat();
  const merged = rrfMerge([...vectorLists, ...bm25Lists]);

  const rerankRan = rerankEnabled && merged.length > 1;
  const { nodes: reranked, scores: rerankScores } = rerankRan
    ? await rerankNodes(queryText, merged, limit * 2)
    : { nodes: merged, scores: [] as { node_id: string; score: number; content_preview: string }[] };

  const minDistances = new Map<string, number>();
  for (const { node, distance } of vectorResults) {
    const current = minDistances.get(node.id);
    minDistances.set(node.id, current === undefined ? distance : Math.min(current, distance));
  }

  const rerankScore = new Map(rerankScores.map((entry) => [entry.node_id, entry.score]));
  const relevant = (node: Node) => {
    if (rerankScores.length > 0) return (rerankScore.get(node.id) ?? 0) >= RERANK_THRESHOLD;
    const distance = minDistances.get(node.id);
    return distance === undefined || distance <= RELEVANCE_THRESHOLD;
  };
  const filtered = reranked.filter(relevant).slice(0, limit);

  const results = await expandWithLinks(filtered, readableLevels, limit * 2);

  emit("memory_searched", {
    userId,
    source: "memory",
    meta: {
      query: queryText,
      expanded_queries: queries,
      rerank_scores: rerankScores,
      stats: {
        vector: vectorResults.length,
        bm25: bm25Results.length,
        merged: merged.length,
        reranked: reranked.length,
        filtered: filtered.length,
        final: results.length,
        relevance_threshold: RELEVANCE_THRESHOLD,
        rerank_threshold: RERANK_THRESHOLD,
        rerank_enabled: rerankEnabled,
        rerank_ran: rerankRan,
        expand_query_enabled: expandQuery,
      },
    },
  });

  return results;
}

export function buildContext(items: Node[], budget = NOTE_CONTEXT_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  for (const node of items) {
    const content = node.content.length > NOTE_CHARS ? `${node.content.slice(0, NOTE_CHARS)}…` : node.content;
    const line = `- [${node.id}] ${content}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length;
  }
  if (lines.length === 0) return "";
  return `Relevant memories, most relevant first (search-notes finds more, get-note shows a note in full):\n${lines.join("\n")}`;
}

export async function getNoteContext(
  userId: string,
  readableLevels: string[],
  query: string,
  projectId: string | null = null,
  soulInPrompt = true,
): Promise<string> {
  const [anchor, relevant] = await Promise.all([
    soulInPrompt ? getSoulAnchor(userId, readableLevels) : null,
    search(userId, readableLevels, query, { limit: 10, projectId }),
  ]);
  const inSystemPrompt = new Set(anchor ? [anchor.soul.id, ...anchor.linked.map((node) => node.id)] : []);
  return buildContext(relevant.filter((node) => !inSystemPrompt.has(node.id)));
}
