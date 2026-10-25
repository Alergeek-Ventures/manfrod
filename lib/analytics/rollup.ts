import { and, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { AuditEvent } from "../db/schema.ts";
import { logger } from "../log.ts";
import { cost, uncachedCost } from "../pricing.ts";
import { addDays, utcToday } from "../time.ts";

const { auditEvents, usageDailyRollups, activityDailyRollups, toolDailyRollups } = tables;
const log = logger("Rollup");

const USAGE_TYPES = ["llm_call_succeeded", "llm_call_failed", "llm_retry", "llm_fallback"];
const ACTIVITY_TYPES = ["message_received", "responding", "action_started", "idle", "memory_searched", "memory_node_created"];

const meta = (event: AuditEvent | undefined, key: string): any => (event?.meta as Record<string, unknown> | null)?.[key];
const countType = (events: AuditEvent[], type: string) => events.filter((event) => event.type === type).length;
const toInteger = (value: unknown) => (typeof value === "number" ? Math.trunc(value) : 0);
const toFloat = (value: unknown) => (typeof value === "number" ? value : 0);
const sumMeta = (events: AuditEvent[], key: string) => events.reduce((sum, event) => sum + toInteger(meta(event, key)), 0);
const sumMetaFloat = (events: AuditEvent[], key: string) => events.reduce((sum, event) => sum + toFloat(meta(event, key)), 0);
const decimal = (value: number) => value.toFixed(8);

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    groups.set(value, [...(groups.get(value) ?? []), item]);
  }
  return groups;
}

function dayBounds(date: string): [Date, Date] {
  const start = new Date(`${date}T00:00:00Z`);
  return [start, new Date(start.getTime() + 86_400_000)];
}

async function eventsFor(date: string, types: string[], requireUser = false): Promise<AuditEvent[]> {
  const [start, end] = dayBounds(date);
  return db
    .select()
    .from(auditEvents)
    .where(
      and(
        gte(auditEvents.timestamp, start),
        lt(auditEvents.timestamp, end),
        inArray(auditEvents.type, types),
        requireUser ? isNotNull(auditEvents.userId) : undefined,
      ),
    );
}

function usageKey(event: AuditEvent): string {
  const model = event.type === "llm_fallback" ? meta(event, "from_model") : meta(event, "model");
  return JSON.stringify([event.userId, model ?? "unknown", meta(event, "purpose") ?? "unknown"]);
}

async function rollupUsage(date: string): Promise<number> {
  const rows = [...groupBy(await eventsFor(date, USAGE_TYPES), usageKey)].map(([key, group]) => {
    const [userId, model, purpose] = JSON.parse(key) as [string | null, string, string];
    const succeeded = group.filter((event) => event.type === "llm_call_succeeded");
    const tokens = {
      input_tokens: sumMeta(succeeded, "input_tokens"),
      output_tokens: sumMeta(succeeded, "output_tokens"),
      cached_tokens: sumMeta(succeeded, "cached_tokens"),
      cache_creation_tokens: sumMeta(succeeded, "cache_creation_tokens"),
    };
    const stamped = sumMetaFloat(succeeded, "cost_usd");
    return {
      date,
      userId,
      model,
      purpose,
      provider: meta(group[0], "provider") ?? null,
      tier: meta(group[0], "tier") ?? null,
      calls: succeeded.length,
      failedCalls: countType(group, "llm_call_failed"),
      retries: countType(group, "llm_retry"),
      fallbacks: countType(group, "llm_fallback"),
      inputTokens: tokens.input_tokens,
      outputTokens: tokens.output_tokens,
      cachedTokens: tokens.cached_tokens,
      cacheCreationTokens: tokens.cache_creation_tokens,
      costUsd: decimal(stamped > 0 ? stamped : cost(model, tokens)),
      uncachedCostUsd: decimal(uncachedCost(model, tokens)),
      totalLatencyMs: sumMeta(succeeded, "latency_ms"),
    };
  });
  if (rows.length === 0) return 0;
  await db
    .insert(usageDailyRollups)
    .values(rows)
    .onConflictDoUpdate({
      target: [usageDailyRollups.date, usageDailyRollups.userId, usageDailyRollups.model, usageDailyRollups.purpose],
      set: {
        provider: sql`excluded.provider`,
        tier: sql`excluded.tier`,
        calls: sql`excluded.calls`,
        failedCalls: sql`excluded.failed_calls`,
        retries: sql`excluded.retries`,
        fallbacks: sql`excluded.fallbacks`,
        inputTokens: sql`excluded.input_tokens`,
        outputTokens: sql`excluded.output_tokens`,
        cachedTokens: sql`excluded.cached_tokens`,
        cacheCreationTokens: sql`excluded.cache_creation_tokens`,
        costUsd: sql`excluded.cost_usd`,
        uncachedCostUsd: sql`excluded.uncached_cost_usd`,
        totalLatencyMs: sql`excluded.total_latency_ms`,
      },
    });
  return rows.length;
}

async function rollupActivity(date: string): Promise<number> {
  const rows = [...groupBy(await eventsFor(date, ACTIVITY_TYPES, true), (event) => event.userId!)].map(([userId, group]) => ({
    date,
    userId,
    messagesReceived: countType(group, "message_received"),
    messagesSent: countType(group, "responding"),
    toolCalls: countType(group, "action_started"),
    sessions: countType(group, "idle"),
    memorySearches: countType(group, "memory_searched"),
    notesCreated: countType(group, "memory_node_created"),
  }));
  if (rows.length === 0) return 0;
  await db
    .insert(activityDailyRollups)
    .values(rows)
    .onConflictDoUpdate({
      target: [activityDailyRollups.date, activityDailyRollups.userId],
      set: {
        messagesReceived: sql`excluded.messages_received`,
        messagesSent: sql`excluded.messages_sent`,
        toolCalls: sql`excluded.tool_calls`,
        sessions: sql`excluded.sessions`,
        memorySearches: sql`excluded.memory_searches`,
        notesCreated: sql`excluded.notes_created`,
      },
    });
  return rows.length;
}

async function rollupTool(date: string): Promise<number> {
  const rows = [...groupBy(await eventsFor(date, ["action_started"]), (event) => meta(event, "action") ?? "unknown")].map(
    ([tool, group]) => ({ date, tool, calls: group.length }),
  );
  if (rows.length === 0) return 0;
  await db
    .insert(toolDailyRollups)
    .values(rows)
    .onConflictDoUpdate({ target: [toolDailyRollups.date, toolDailyRollups.tool], set: { calls: sql`excluded.calls` } });
  return rows.length;
}

export async function runForDate(date: string): Promise<[number, number, number]> {
  return [await rollupUsage(date), await rollupActivity(date), await rollupTool(date)];
}

export async function runRecent(days = 3): Promise<void> {
  const today = utcToday();
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDays(today, -offset);
    const [usage, activity, tool] = await runForDate(date);
    log.debug(`Rollup ${date}: ${usage} usage rows, ${activity} activity rows, ${tool} tool rows`);
  }
}

export async function backfill(): Promise<void> {
  const rows = await db
    .selectDistinct({ date: sql<string>`(${auditEvents.timestamp})::date::text` })
    .from(auditEvents)
    .where(inArray(auditEvents.type, [...USAGE_TYPES, ...ACTIVITY_TYPES]));
  const dates = rows.map((row) => row.date).sort();
  log.info(`Analytics backfill: ${dates.length} day(s) with raw events`);
  for (const date of dates) {
    const [usage, activity, tool] = await runForDate(date);
    log.info(`Analytics backfill ${date}: ${usage} usage rows, ${activity} activity rows, ${tool} tool rows`);
  }
}
