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

export function parseExpansion(response: string, original: string): string[] {
  const cleaned = response
    .trim()
    .replace(/^```json\s*/, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [original];
  }
  if (!Array.isArray(parsed)) return [original];

  const queries = parsed.filter((item): item is string => typeof item === "string").slice(0, 5);
  const ordered = queries.includes(original) ? [original, ...queries.filter((query) => query !== original)] : [original, ...queries];
  return ordered.slice(0, 3);
}

export async function expand(query: string, opts: { timeoutMs?: number } = {}): Promise<string[]> {
  try {
    const response = await generateSimple(PRIMARY_MODEL, [system(SYSTEM_MESSAGE), user(EXPANSION_PROMPT.replace("{{QUERY}}", query))], {
      purpose: "query_expansion",
      timeoutMs: opts.timeoutMs ?? 10_000,
    });
    return parseExpansion(response, query);
  } catch {
    return [query];
  }
}
