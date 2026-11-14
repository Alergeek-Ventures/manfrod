import { PRIMARY_MODEL, generateSimple, system, user } from "../llm/index.ts";

const SYSTEM_MESSAGE =
  "You are a query expansion assistant. Rewrite search queries into multiple variations to improve retrieval. Always output valid JSON arrays only, no other text.";

const EXPANSION_PROMPT = `Rewrite this query into 3 different search queries. Include the original as first item.

Rules:
- Each query captures a different angle or phrasing
- Keep queries concise (under 15 words)
- Output ONLY a JSON array of strings

Query: {{QUERY}}
`;

export function readExpansion(response: string, original: string): string[] | null {
  const cleaned = response
    .trim()
    .replace(/^```json\s*/, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const queries = parsed.filter((item): item is string => typeof item === "string").slice(0, 5);
  const ordered = queries.includes(original) ? [original, ...queries.filter((query) => query !== original)] : [original, ...queries];
  return ordered.slice(0, 3);
}

export function parseExpansion(response: string, original: string): string[] {
  return readExpansion(response, original) ?? [original];
}

export async function expand(query: string, opts: { timeoutMs?: number; onError?: (error: Error) => void } = {}): Promise<string[]> {
  try {
    const response = await generateSimple(PRIMARY_MODEL, [system(SYSTEM_MESSAGE), user(EXPANSION_PROMPT.replace("{{QUERY}}", query))], {
      purpose: "query_expansion",
      timeoutMs: opts.timeoutMs ?? 10_000,
    });
    const queries = readExpansion(response, query);
    if (queries) return queries;
    opts.onError?.(new Error("the expansion response is not a JSON array"));
    return [query];
  } catch (error) {
    opts.onError?.(error as Error);
    return [query];
  }
}
