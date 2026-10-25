import { config } from "./config.ts";

const BASE_URL = "https://api.search.brave.com/res/v1";

export class BraveSearchError extends Error {
  constructor(
    readonly reason: "api_key_not_configured" | "rate_limited" | "http" | "transport",
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
  page_age?: string;
}

function formatAge(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

function formatResults(query: string, results: BraveResult[]): string {
  if (results.length === 0) return `No web results found for: ${query}`;
  const formatted = results
    .map((result, index) => {
      const title = result.title || "Untitled";
      const url = result.url || "";
      const description = result.description || "";
      const age = formatAge(result.page_age);
      const ageSuffix = age ? ` (${age})` : "";
      return `${index + 1}. ${title}${ageSuffix}\n   ${url}\n   ${description}`;
    })
    .join("\n\n");
  return `Web results for "${query}":\n\n${formatted}`;
}

export async function search(query: string, opts: { count?: number; freshness?: string; apiKey?: string } = {}): Promise<string> {
  const apiKey = opts.apiKey ?? config.braveSearchApiKey;
  if (!apiKey) throw new BraveSearchError("api_key_not_configured");

  const params = new URLSearchParams({ q: query, count: String(opts.count ?? 5) });
  if (opts.freshness) params.set("freshness", opts.freshness);

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/web/search?${params}`, {
      headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
    });
  } catch (error) {
    throw new BraveSearchError("transport", (error as Error).message);
  }

  if (response.status === 429) throw new BraveSearchError("rate_limited");
  if (response.status !== 200) {
    throw new BraveSearchError("http", `${response.status} ${await response.text().catch(() => "")}`);
  }
  const body = (await response.json()) as { web?: { results?: BraveResult[] } };
  return formatResults(query, body.web?.results ?? []);
}
