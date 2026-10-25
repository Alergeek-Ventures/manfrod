import { and, asc, desc, eq, gt, gte, inArray, lt, lte, ne, or, sql } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import { addDays, utcToday } from "../time.ts";
import { toActivity, type Activity } from "./index.ts";

const ae = tables.auditEvents;

export async function getEventsSince(since: Date, opts: { limit?: number; types?: string[] } = {}): Promise<Activity[]> {
  const conditions = [gt(ae.timestamp, since)];
  if (opts.types) conditions.push(inArray(ae.type, opts.types));
  const rows = await db
    .select()
    .from(ae)
    .where(and(...conditions))
    .orderBy(asc(ae.timestamp))
    .limit(opts.limit ?? 100);
  return rows.map(toActivity);
}

export interface RecentFilter {
  includeAllLogs?: boolean;
  from?: Date | null;
  to?: Date | null;
  source?: string | null;
  userId?: string | null;
}

export async function listRecentFiltered(limit = 200, filter: RecentFilter = {}): Promise<Activity[]> {
  const conditions = [];
  if (!filter.includeAllLogs) {
    conditions.push(or(ne(ae.type, "log"), sql`(${ae.meta}->>'level')::text in ('warning', 'error')`));
  }
  if (filter.from) conditions.push(gte(ae.timestamp, filter.from));
  if (filter.to) conditions.push(lte(ae.timestamp, filter.to));
  if (filter.source) conditions.push(eq(ae.source, filter.source));
  if (filter.userId) conditions.push(eq(ae.userId, filter.userId));

  const rows = await db
    .select()
    .from(ae)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(ae.timestamp))
    .limit(limit);
  return rows.map(toActivity);
}

const RUN_EVENT_TYPES = [
  "narrating",
  "action_started",
  "action_completed",
  "memory_node_created",
  "memory_node_updated",
  "memory_node_deleted",
  "memory_link_created",
  "memory_link_deleted",
  "memory_node_processed",
  "memory_searched",
];

export async function listRunEvents(startedAt: Date, endedAt: Date | null): Promise<Activity[]> {
  const rows = await db
    .select()
    .from(ae)
    .where(
      and(
        gte(ae.timestamp, startedAt),
        lte(ae.timestamp, endedAt ?? new Date()),
        inArray(ae.source, ["retrospector", "memory"]),
        inArray(ae.type, RUN_EVENT_TYPES),
      ),
    )
    .orderBy(asc(ae.timestamp));
  return rows.map(toActivity);
}

export async function deleteOlderThan(days: number): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const result = await db.delete(ae).where(lt(ae.timestamp, cutoff));
  return result.rowCount ?? 0;
}

export async function deleteLogsOlderThan(hours: number): Promise<number> {
  const cutoff = new Date(Date.now() - hours * 3_600_000);
  const result = await db.delete(ae).where(and(eq(ae.type, "log"), lt(ae.timestamp, cutoff)));
  return result.rowCount ?? 0;
}

export type RunOutcome = "success" | "failure" | "running" | "interrupted";
export type RunKind = "slipbox_drain" | "graph_review" | null;

export interface AgentRun {
  agent: "retrospector";
  startedAt: Date;
  endedAt: Date | null;
  durationMs: number | null;
  outcome: RunOutcome;
  intent: string;
  stats: Record<string, unknown>;
  kind: RunKind;
}

const STALE_AFTER_MS = 30 * 60 * 1000;

function parseKind(value: unknown): RunKind {
  return value === "graph_review" || value === "slipbox_drain" ? value : null;
}

function intentText(kind: RunKind, slipboxCount: number, reviewCount: number): string {
  if (kind === "graph_review") return `Deep review of ${reviewCount} graph nodes (no slipbox)`;
  return `Process ${slipboxCount} slipbox nodes, review ${reviewCount} graph nodes`;
}

export function agentRunFromEvents(start: Activity, end?: Activity): AgentRun {
  const slipboxCount = Number(start.meta.slipbox_count ?? 0);
  const reviewCount = Number(start.meta.review_count ?? 0);
  const kind = parseKind(start.meta.kind);

  if (!end) {
    return {
      agent: "retrospector",
      startedAt: start.timestamp,
      endedAt: null,
      durationMs: null,
      outcome: Date.now() - start.timestamp.getTime() > STALE_AFTER_MS ? "interrupted" : "running",
      intent: intentText(kind, slipboxCount, reviewCount),
      stats: {},
      kind,
    };
  }

  const outcome: RunOutcome = end.type.endsWith("_completed") ? "success" : end.type.endsWith("_failed") ? "failure" : "running";

  return {
    agent: "retrospector",
    startedAt: start.timestamp,
    endedAt: end.timestamp,
    durationMs: end.timestamp.getTime() - start.timestamp.getTime(),
    outcome,
    intent: intentText(kind, slipboxCount, reviewCount),
    stats: end.meta ?? {},
    kind,
  };
}

export async function listAgentRuns(days = 7): Promise<AgentRun[]> {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select()
    .from(ae)
    .where(and(gte(ae.timestamp, cutoff), inArray(ae.type, ["retrospection_started", "retrospection_completed", "retrospection_failed"])))
    .orderBy(asc(ae.timestamp));
  const events = rows.map(toActivity);
  const starts = events.filter((e) => e.type === "retrospection_started");
  const ends = events.filter((e) => e.type !== "retrospection_started");

  return starts
    .map((start) => {
      const end = ends.find(
        (candidate) =>
          candidate.timestamp >= start.timestamp &&
          !starts.some((other) => other !== start && other.timestamp > start.timestamp && other.timestamp < candidate.timestamp),
      );
      return agentRunFromEvents(start, end);
    })
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

export interface DailyLlmMetrics {
  date: string;
  free_calls: number;
  paid_calls: number;
  retries: number;
  fallbacks: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_creation_tokens: number;
  messages_received: number;
  messages_sent: number;
  tool_calls: number;
}

const METRIC_KEYS = [
  "free_calls",
  "paid_calls",
  "retries",
  "fallbacks",
  "input_tokens",
  "output_tokens",
  "cached_tokens",
  "cache_creation_tokens",
  "messages_received",
  "messages_sent",
  "tool_calls",
] as const;

export async function aggregateLlmMetrics(days = 7) {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select()
    .from(ae)
    .where(
      and(
        gte(ae.timestamp, cutoff),
        inArray(ae.type, ["llm_call_succeeded", "llm_retry", "llm_fallback", "message_received", "responding", "action_started"]),
      ),
    );

  const byDate = new Map<string, DailyLlmMetrics>();
  const blank = (date: string): DailyLlmMetrics => ({
    date,
    free_calls: 0,
    paid_calls: 0,
    retries: 0,
    fallbacks: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    cache_creation_tokens: 0,
    messages_received: 0,
    messages_sent: 0,
    tool_calls: 0,
  });

  for (const row of rows) {
    const date = row.timestamp.toISOString().slice(0, 10);
    const day = byDate.get(date) ?? blank(date);
    byDate.set(date, day);
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    const num = (key: string) => Number(meta[key] ?? 0) || 0;
    switch (row.type) {
      case "llm_call_succeeded":
        if (meta.tier === "free") day.free_calls += 1;
        if (meta.tier === "paid") day.paid_calls += 1;
        day.input_tokens += num("input_tokens");
        day.output_tokens += num("output_tokens");
        day.cached_tokens += num("cached_tokens");
        day.cache_creation_tokens += num("cache_creation_tokens");
        break;
      case "llm_retry":
        day.retries += 1;
        break;
      case "llm_fallback":
        day.fallbacks += 1;
        break;
      case "message_received":
        day.messages_received += 1;
        break;
      case "responding":
        day.messages_sent += 1;
        break;
      case "action_started":
        day.tool_calls += 1;
        break;
    }
  }

  const today = utcToday();
  const daily: DailyLlmMetrics[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = addDays(today, -offset);
    daily.push(byDate.get(date) ?? blank(date));
  }

  const totals = Object.fromEntries(METRIC_KEYS.map((key) => [key, daily.reduce((sum, day) => sum + day[key], 0)])) as Omit<
    DailyLlmMetrics,
    "date"
  >;

  return { daily, totals };
}
