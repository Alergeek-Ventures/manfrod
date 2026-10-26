import { and, asc, count, countDistinct, eq, gt, gte, isNotNull, lte, max, min, notLike, or, sql, sum } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import { listNegative, stats as feedbackStats } from "../feedback.ts";
import { isFree, isKnown, label, pricingTable } from "../pricing.ts";
import { addDays, utcToday } from "../time.ts";

const SYSTEM_PREFIX = "system:%";

const INTENT_TOOLS = new Set([
  "reserve-desk",
  "cancel-desk-reservation",
  "open-office-door",
  "set-reminder",
  "cancel-reminder",
  "create-recurring-reminder",
  "update-recurring-reminder",
  "delete-recurring-reminder",
  "escalate-note",
  "record-holiday-plan",
  "set-proactive-preferences",
  "announce-absence",
  "set-channel-summaries",
  "report-vacation",
  "create-note",
  "delete-note",
  "link-notes",
  "unlink-notes",
  "update-soul",
  "set-soul-note",
  "delete-slack-message",
  "leave-thread",
  "list-office-access-log",
  "list-slack-canvases",
  "read-slack-canvas",
  "linear-list-issues",
  "linear-get-issue",
  "linear-create-issue",
  "linear-update-issue",
  "linear-comment-issue",
]);

const { usageDailyRollups: usage, activityDailyRollups: activity, toolDailyRollups: toolRollups, users } = tables;

const active = or(gt(activity.messagesReceived, 0), gt(activity.sessions, 0), gt(activity.toolCalls, 0), gt(activity.messagesSent, 0));
const human = notLike(users.slackId, SYSTEM_PREFIX);
const week = sql<string>`date_trunc('week', ${activity.date})::date::text`;

const int = (value: unknown) => (value === null || value === undefined ? 0 : Math.trunc(Number(value)));
const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
const startDate = (days: number) => addDays(utcToday(), -(days - 1));
const safeRatio = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10);
const safeDiv = (value: number, divisor: number) => (divisor === 0 ? 0 : value / divisor);

function dateList(days: number): string[] {
  const today = utcToday();
  return Array.from({ length: days }, (_, index) => addDays(today, -(days - 1 - index)));
}

async function totalsBetween(from: string, to: string) {
  const [totals] = await db
    .select({
      calls: sum(usage.calls),
      failedCalls: sum(usage.failedCalls),
      retries: sum(usage.retries),
      fallbacks: sum(usage.fallbacks),
      inputTokens: sum(usage.inputTokens),
      outputTokens: sum(usage.outputTokens),
      cachedTokens: sum(usage.cachedTokens),
      cacheCreationTokens: sum(usage.cacheCreationTokens),
      costUsd: sum(usage.costUsd),
      uncachedCostUsd: sum(usage.uncachedCostUsd),
      totalLatencyMs: sum(usage.totalLatencyMs),
    })
    .from(usage)
    .where(and(gte(usage.date, from), lte(usage.date, to)));
  const [people] = await db
    .select({
      messagesReceived: sum(activity.messagesReceived),
      messagesSent: sum(activity.messagesSent),
      toolCalls: sum(activity.toolCalls),
      sessions: sum(activity.sessions),
    })
    .from(activity)
    .innerJoin(users, eq(users.id, activity.userId))
    .where(and(gte(activity.date, from), lte(activity.date, to), human));
  const calls = int(totals?.calls);
  return {
    calls,
    failed_calls: int(totals?.failedCalls),
    retries: int(totals?.retries),
    fallbacks: int(totals?.fallbacks),
    input_tokens: int(totals?.inputTokens),
    output_tokens: int(totals?.outputTokens),
    cached_tokens: int(totals?.cachedTokens),
    cache_creation_tokens: int(totals?.cacheCreationTokens),
    cost_usd: num(totals?.costUsd),
    uncached_cost_usd: num(totals?.uncachedCostUsd),
    avg_latency_ms: calls === 0 ? 0 : Math.trunc(int(totals?.totalLatencyMs) / calls),
    messages_received: int(people?.messagesReceived),
    messages_sent: int(people?.messagesSent),
    tool_calls: int(people?.toolCalls),
    sessions: int(people?.sessions),
  };
}

async function activeUsersBetween(from: string, to: string): Promise<number> {
  const [row] = await db
    .select({ n: countDistinct(activity.userId) })
    .from(activity)
    .innerJoin(users, eq(users.id, activity.userId))
    .where(and(gte(activity.date, from), lte(activity.date, to), active, human));
  return int(row?.n);
}

async function peopleCount(): Promise<number> {
  return db.$count(users, human);
}

async function summary(days: number) {
  const from = startDate(days);
  const current = await totalsBetween(from, utcToday());
  const prevEnd = addDays(from, -1);
  const prevStart = addDays(prevEnd, -(days - 1));
  const previous = await totalsBetween(prevStart, prevEnd);
  const active = await activeUsersBetween(from, utcToday());
  return {
    ...current,
    active_users: active,
    previous_active_users: await activeUsersBetween(prevStart, prevEnd),
    total_people: await peopleCount(),
    previous_cost_usd: previous.cost_usd,
    previous_calls: previous.calls,
    previous_messages: previous.messages_received,
    cost_per_active_user: safeDiv(current.cost_usd, active),
    cost_per_message: safeDiv(current.cost_usd, current.messages_received),
    cache_savings_usd: current.uncached_cost_usd - current.cost_usd,
    cache_hit_rate: safeRatio(current.cached_tokens, current.input_tokens),
    projected_monthly_cost: days > 0 ? (current.cost_usd / days) * 30 : 0,
  };
}

async function dailySeries(days: number) {
  const from = startDate(days);
  const usageByDate = new Map(
    (
      await db
        .select({
          date: usage.date,
          calls: sum(usage.calls),
          inputTokens: sum(usage.inputTokens),
          outputTokens: sum(usage.outputTokens),
          cachedTokens: sum(usage.cachedTokens),
          costUsd: sum(usage.costUsd),
          failedCalls: sum(usage.failedCalls),
        })
        .from(usage)
        .where(gte(usage.date, from))
        .groupBy(usage.date)
    ).map((row) => [row.date, row]),
  );
  const activityByDate = new Map(
    (
      await db
        .select({
          date: activity.date,
          messagesReceived: sum(activity.messagesReceived),
          messagesSent: sum(activity.messagesSent),
          toolCalls: sum(activity.toolCalls),
          activeUsers: countDistinct(activity.userId),
        })
        .from(activity)
        .innerJoin(users, eq(users.id, activity.userId))
        .where(and(gte(activity.date, from), active, human))
        .groupBy(activity.date)
    ).map((row) => [row.date, row]),
  );
  return dateList(days).map((date) => {
    const u = usageByDate.get(date);
    const a = activityByDate.get(date);
    return {
      date,
      calls: int(u?.calls),
      failed_calls: int(u?.failedCalls),
      input_tokens: int(u?.inputTokens),
      output_tokens: int(u?.outputTokens),
      cached_tokens: int(u?.cachedTokens),
      cost_usd: num(u?.costUsd),
      messages_received: int(a?.messagesReceived),
      messages_sent: int(a?.messagesSent),
      tool_calls: int(a?.toolCalls),
      active_users: int(a?.activeUsers),
    };
  });
}

async function byModel(days: number) {
  const result = await db
    .select({
      model: usage.model,
      calls: sum(usage.calls),
      failedCalls: sum(usage.failedCalls),
      retries: sum(usage.retries),
      fallbacks: sum(usage.fallbacks),
      inputTokens: sum(usage.inputTokens),
      outputTokens: sum(usage.outputTokens),
      cachedTokens: sum(usage.cachedTokens),
      costUsd: sum(usage.costUsd),
      uncachedCostUsd: sum(usage.uncachedCostUsd),
      totalLatencyMs: sum(usage.totalLatencyMs),
      firstSeen: min(usage.date),
      lastSeen: max(usage.date),
    })
    .from(usage)
    .where(gte(usage.date, startDate(days)))
    .groupBy(usage.model);
  return result
    .map((row) => {
      const calls = int(row.calls);
      return {
        model: row.model,
        calls,
        failed_calls: int(row.failedCalls),
        retries: int(row.retries),
        fallbacks: int(row.fallbacks),
        input_tokens: int(row.inputTokens),
        output_tokens: int(row.outputTokens),
        cached_tokens: int(row.cachedTokens),
        cost_usd: num(row.costUsd),
        uncached_cost_usd: num(row.uncachedCostUsd),
        first_seen: row.firstSeen as string,
        last_seen: row.lastSeen as string,
        label: label(row.model),
        free: isFree(row.model),
        unpriced: !isKnown(row.model),
        avg_latency_ms: calls === 0 ? 0 : Math.trunc(int(row.totalLatencyMs) / calls),
        cache_hit_rate: safeRatio(int(row.cachedTokens), int(row.inputTokens)),
      };
    })
    .sort((a, b) => b.cost_usd - a.cost_usd);
}

async function modelTimeline(days: number) {
  const result = await db
    .select({ date: usage.date, model: usage.model, calls: sum(usage.calls), costUsd: sum(usage.costUsd) })
    .from(usage)
    .where(gte(usage.date, startDate(days)))
    .groupBy(usage.date, usage.model);
  const models = [...new Set(result.map((row) => row.model))].sort();
  const series = dateList(days).map((date) => ({
    date,
    models: Object.fromEntries(
      models.map((model) => {
        const row = result.find((candidate) => candidate.date === date && candidate.model === model);
        return [model, { calls: row ? int(row.calls) : 0, cost_usd: row ? num(row.costUsd) : 0 }];
      }),
    ),
  }));
  return { models, series };
}

async function byPurpose(days: number) {
  const result = await db
    .select({ purpose: usage.purpose, calls: sum(usage.calls), costUsd: sum(usage.costUsd) })
    .from(usage)
    .where(gte(usage.date, startDate(days)))
    .groupBy(usage.purpose);
  return result
    .map((row) => ({ purpose: row.purpose, calls: int(row.calls), cost_usd: num(row.costUsd) }))
    .sort((a, b) => b.cost_usd - a.cost_usd);
}

async function byTool(days: number) {
  const result = (
    await db
      .select({ tool: toolRollups.tool, calls: sum(toolRollups.calls) })
      .from(toolRollups)
      .where(gte(toolRollups.date, startDate(days)))
      .groupBy(toolRollups.tool)
  )
    .map((row) => ({
      tool: row.tool,
      calls: int(row.calls),
      category: INTENT_TOOLS.has(row.tool.replaceAll("_", "-")) ? ("intent" as const) : ("everyday" as const),
    }))
    .sort((a, b) => b.calls - a.calls);
  return {
    all: result,
    everyday: result.filter((row) => row.category === "everyday"),
    intent: result.filter((row) => row.category === "intent"),
    total_calls: result.reduce((sum, row) => sum + row.calls, 0),
  };
}

async function byUser(days: number) {
  const from = startDate(days);
  const activityByUser = new Map(
    (
      await db
        .select({
          userId: activity.userId,
          messagesReceived: sum(activity.messagesReceived),
          messagesSent: sum(activity.messagesSent),
          toolCalls: sum(activity.toolCalls),
          sessions: sum(activity.sessions),
          memorySearches: sum(activity.memorySearches),
          notesCreated: sum(activity.notesCreated),
          activeDays: countDistinct(activity.date),
          lastActive: max(activity.date),
        })
        .from(activity)
        .where(gte(activity.date, from))
        .groupBy(activity.userId)
    ).map((row) => [row.userId, row]),
  );
  const usageByUser = new Map(
    (
      await db
        .select({
          userId: usage.userId,
          calls: sum(usage.calls),
          inputTokens: sum(usage.inputTokens),
          outputTokens: sum(usage.outputTokens),
          costUsd: sum(usage.costUsd),
        })
        .from(usage)
        .where(and(gte(usage.date, from), isNotNull(usage.userId)))
        .groupBy(usage.userId)
    ).map((row) => [row.userId, row]),
  );
  const people = await db
    .select({ id: users.id, name: users.name, email: users.email, slackId: users.slackId })
    .from(users)
    .orderBy(asc(users.name));
  return people
    .map((user) => {
      const a = activityByUser.get(user.id);
      const p = usageByUser.get(user.id);
      return {
        user_id: user.id,
        name: user.name || user.email || user.slackId,
        email: user.email,
        system: user.slackId.startsWith("system:"),
        messages_received: int(a?.messagesReceived),
        messages_sent: int(a?.messagesSent),
        tool_calls: int(a?.toolCalls),
        sessions: int(a?.sessions),
        memory_searches: int(a?.memorySearches),
        notes_created: int(a?.notesCreated),
        active_days: int(a?.activeDays),
        last_active: a?.lastActive ?? null,
        calls: int(p?.calls),
        input_tokens: int(p?.inputTokens),
        output_tokens: int(p?.outputTokens),
        cost_usd: num(p?.costUsd),
        attributed: int(p?.calls) > 0,
      };
    })
    .filter((user) => !(user.messages_received === 0 && user.calls === 0 && user.active_days === 0))
    .sort((a, b) => b.messages_received - a.messages_received || b.active_days - a.active_days);
}

async function adoption(days: number) {
  const from = startDate(days);
  const weekly = (
    await db
      .select({
        week,
        activeUsers: countDistinct(activity.userId),
        messages: sum(activity.messagesReceived),
        sessions: sum(activity.sessions),
      })
      .from(activity)
      .innerJoin(users, eq(users.id, activity.userId))
      .where(and(gte(activity.date, from), active, human))
      .groupBy(week)
      .orderBy(week)
  ).map((row) => ({ week: row.week, active_users: int(row.activeUsers), messages: int(row.messages), sessions: int(row.sessions) }));
  const activeUsers = await activeUsersBetween(from, utcToday());
  const people = await peopleCount();
  const series = await dailySeries(days);
  const avgDaily = series.length === 0 ? 0 : series.reduce((sum, day) => sum + day.active_users, 0) / series.length;
  return {
    weekly,
    active_users: activeUsers,
    total_people: people,
    never_used: Math.max(people - activeUsers, 0),
    reach: safeRatio(activeUsers, people),
    avg_daily_active: Math.round(avgDaily * 10) / 10,
    stickiness: activeUsers > 0 ? Math.round((avgDaily / activeUsers) * 1000) / 1000 : 0,
  };
}

function pricingRows() {
  return Object.entries(pricingTable())
    .map(([model, price]) => ({ ...price, model }))
    .sort((a, b) => Number(a.free) - Number(b.free) || a.model.localeCompare(b.model));
}

export async function overview(days = 30) {
  const negative = await listNegative(days);
  return {
    days,
    range: [startDate(days), utcToday()] as const,
    summary: await summary(days),
    daily: await dailySeries(days),
    by_model: await byModel(days),
    by_purpose: await byPurpose(days),
    by_user: await byUser(days),
    by_tool: await byTool(days),
    model_timeline: await modelTimeline(days),
    adoption: await adoption(days),
    feedback: await feedbackStats(days),
    negative_feedback: negative.map((feedback) => ({
      inserted_at: feedback.insertedAt.toISOString(),
      rater: feedback.user?.name || feedback.slackUserName || feedback.slackUserId || "unknown",
      where:
        feedback.slackChannelName === "DM"
          ? "DM"
          : feedback.slackChannelName
            ? `#${feedback.slackChannelName}`
            : (feedback.slackChannelId ?? "–"),
      permalink: feedback.permalink,
    })),
    pricing: pricingRows(),
  };
}

export type Overview = Awaited<ReturnType<typeof overview>>;
