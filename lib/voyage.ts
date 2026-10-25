import { config } from "./config.ts";

const BASE_URL = "https://api.voyageai.com/v1";
const EMBED_MODEL = "voyage-4-lite";
const RERANK_MODEL = "rerank-2.5-lite";

export class VoyageError extends Error {
  constructor(
    readonly status: number | null,
    readonly body: unknown,
  ) {
    super(`Voyage request failed${status ? ` (HTTP ${status})` : ""}`);
  }
}

export async function embed(texts: string[], opts: { inputType?: "document" | "query"; apiKey?: string } = {}): Promise<number[][]> {
  const response = await fetch(`${BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.apiKey ?? config.voyageApiKey ?? ""}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ input: texts, model: EMBED_MODEL, input_type: opts.inputType ?? "document" }),
  });
  const body = (await response.json().catch(() => null)) as {
    data?: { index: number; embedding: number[] }[];
  } | null;
  if (response.status !== 200 || !body?.data) throw new VoyageError(response.status, body);
  return [...body.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
}

export async function embedQuery(text: string): Promise<number[]> {
  const [embedding] = await embed([text], { inputType: "query" });
  return embedding;
}

export interface RerankResult {
  index: number;
  relevance_score: number;
}

export async function rerank(query: string, documents: string[], opts: { topK?: number; apiKey?: string } = {}): Promise<RerankResult[]> {
  const payload: Record<string, unknown> = { query, documents, model: RERANK_MODEL };
  if (Number.isInteger(opts.topK)) payload.top_k = opts.topK;

  const response = await fetch(`${BASE_URL}/rerank`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.apiKey ?? config.voyageApiKey ?? ""}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => null)) as {
    data?: { index: number; relevance_score: number }[];
  } | null;
  if (response.status !== 200 || !body?.data) throw new VoyageError(response.status, body);
  return body.data.map((item) => ({ index: item.index, relevance_score: item.relevance_score }));
}
