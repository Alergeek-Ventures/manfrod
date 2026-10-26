import { callTool } from "./mcp/client.ts";
import { dateIsoInZone, secondsOfDay, timeFromSeconds } from "./time.ts";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function extractRecords(result: Record<string, any>): Record<string, any>[] {
  const structured = result.structuredContent;
  if (structured && Array.isArray(structured.records)) return structured.records;
  if (structured && Array.isArray(structured.results)) return structured.results;
  if (Array.isArray(structured)) return structured;
  if (Array.isArray(result.content)) {
    const text = result.content
      .filter((part: Record<string, unknown>) => part.type === "text" && typeof part.text === "string")
      .map((part: Record<string, string>) => part.text)
      .join("\n");
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.records)) return parsed.records;
      if (parsed && Array.isArray(parsed.results)) return parsed.results;
    } catch {}
  }
  return [];
}

export async function fetchRecentSessions(mcpUrl: string, accessToken: string, limit: number): Promise<Result<Record<string, any>[]>> {
  const result = await callTool(mcpUrl, accessToken, "list_sessions", {
    input: {},
    limit,
    sort: [{ field: "start_datetime", direction: "desc" }],
  });
  return result.ok ? { ok: true, value: extractRecords(result.value) } : result;
}

export async function hasActiveSession(mcpUrl: string, accessToken: string): Promise<Result<boolean>> {
  const result = await callTool(mcpUrl, accessToken, "get_current_session", {});
  return result.ok ? { ok: true, value: extractRecords(result.value).length > 0 } : result;
}

export function averageTimeOfDay(
  sessions: Record<string, any>[],
  today: string,
  field: "start_datetime" | "end_datetime",
  agg: "min" | "max",
): string | null {
  const byDay = new Map<string, Date[]>();
  for (const session of sessions) {
    const value = session[field];
    if (typeof value !== "string") continue;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    const day = dateIsoInZone(date);
    if (day === today) continue;
    byDay.set(day, [...(byDay.get(day) ?? []), date]);
  }
  const seconds = [...byDay.values()].map((dates) => {
    const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
    return secondsOfDay(agg === "min" ? sorted[0] : sorted[sorted.length - 1]);
  });
  if (seconds.length === 0) return null;
  return timeFromSeconds(Math.round(seconds.reduce((sum, value) => sum + value, 0) / seconds.length));
}
