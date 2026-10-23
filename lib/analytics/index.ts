import { sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { listNegative, stats as feedbackStats } from "../feedback.ts";
import { isFree, isKnown, label, pricingTable } from "../pricing.ts";
import { addDays, utcToday } from "../time.ts";

const SYSTEM_PREFIX = "system:%";

const INTENT_TOOLS = new Set([
  "reserve_desk",
  "cancel_desk_reservation",
  "open_office_door",
  "set_reminder",
  "cancel_reminder",
  "create_recurring_reminder",
  "update_recurring_reminder",
  "delete_recurring_reminder",
  "escalate_note",
  "ask_user_about_holiday",
  "record_holiday_plan",
  "report_vacation",
  "create_note",
  "delete_note",
  "link_notes",
  "unlink_notes",
  "update_soul",
  "set_soul_note",
  "delete_slack_message",
  "leave_thread",
  "list_office_access_log",
  "list_slack_canvases",
  "read_slack_canvas",
  "linear_list_issues",
  "linear_get_issue",
]);

const ACTIVE = sql.raw("(r.messages_received > 0 OR r.sessions > 0 OR r.tool_calls > 0 OR r.messages_sent > 0)");

const int = (value: unknown) => (value === null || value === undefined ? 0 : Math.trunc(Number(value)));
const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
const startDate = (days: number) => addDays(utcToday(), -(days - 1));
const safeRatio = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10);
const safeDiv = (value: number, divisor: number) => (divisor === 0 ? 0 : value / divisor);

function dateList(days: number): string[] {
  const today = utcToday();
  return Array.from({ length: days }, (_, index) => addDays(today, -(days - 1 - index)));
}

async function rows<T = Record<string, any>>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

async function totalsBetween(from: string, to: string) {
  const [usage] = await rows(sql`
    SELECT sum(calls) calls, sum(failed_calls) failed_calls, sum(retries) retries, sum(fallbacks) fallbacks,
      sum(input_tokens) input_tokens, sum(output_tokens) output_tokens, sum(cached_tokens) cached_tokens,
      sum(cache_creation_tokens) cache_creation_tokens, sum(cost_usd) cost_usd, sum(uncached_cost_usd) uncached_cost_usd,
      sum(total_latency_ms) total_latency_ms
    FROM usage_daily_rollups WHERE date >= ${from} AND date <= ${to}`);
  const [activity] = await rows(sql`
    SELECT sum(r.messages_received) messages_received, sum(r.messages_sent) messages_sent, sum(r.tool_calls) tool_calls, sum(r.sessions) sessions
    FROM activity_daily_rollups r JOIN users u ON u.id = r.user_id
    WHERE r.date >= ${from} AND r.date <= ${to} AND u.slack_id NOT LIKE ${SYSTEM_PREFIX}`);
  const calls = int(usage?.calls);
  return {
    calls,
    failed_calls: int(usage?.failed_calls),
    retries: int(usage?.retries),
    fallbacks: int(usage?.fallbacks),
    input_tokens: int(usage?.input_tokens),
    output_tokens: int(usage?.output_tokens),
    cached_tokens: int(usage?.cached_tokens),
    cache_creation_tokens: int(usage?.cache_creation_tokens),
    cost_usd: num(usage?.cost_usd),
    uncached_cost_usd: num(usage?.uncached_cost_usd),
    avg_latency_ms: calls === 0 ? 0 : Math.trunc(int(usage?.total_latency_ms) / calls),
    messages_received: int(activity?.messages_received),
    messages_sent: int(activity?.messages_sent),
    tool_calls: int(activity?.tool_calls),
    sessions: int(activity?.sessions),
  };
}

async function activeUsersBetween(from: string, to: string): Promise<number> {
  const [row] = await rows(sql`
    SELECT count(DISTINCT r.user_id) n FROM activity_daily_rollups r JOIN users u ON u.id = r.user_id
    WHERE r.date >= ${from} AND r.date <= ${to} AND ${ACTIVE} AND u.slack_id NOT LIKE ${SYSTEM_PREFIX}`);
  return int(row?.n);
}

async function peopleCount(): Promise<number> {
  const [row] = await rows(sql`SELECT count(*) n FROM users WHERE slack_id NOT LIKE ${SYSTEM_PREFIX}`);
  return int(row?.n);
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
  const usage = new Map(
    (
      await rows(sql`
        SELECT date::text date, sum(calls) calls, sum(input_tokens) input_tokens, sum(output_tokens) output_tokens,
          sum(cached_tokens) cached_tokens, sum(cost_usd) cost_usd, sum(failed_calls) failed_calls
        FROM usage_daily_rollups WHERE date >= ${from} GROUP BY date`)
    ).map((row) => [row.date, row]),
  );
  const activity = new Map(
    (
      await rows(sql`
        SELECT r.date::text date, sum(r.messages_received) messages_received, sum(r.messages_sent) messages_sent,
          sum(r.tool_calls) tool_calls, count(DISTINCT r.user_id) active_users
        FROM activity_daily_rollups r JOIN users u ON u.id = r.user_id
        WHERE r.date >= ${from} AND ${ACTIVE} AND u.slack_id NOT LIKE ${SYSTEM_PREFIX} GROUP BY r.date`)
    ).map((row) => [row.date, row]),
  );
  return dateList(days).map((date) => {
    const u = usage.get(date) ?? {};
    const a = activity.get(date) ?? {};
    return {
      date,
      calls: int(u.calls),
      failed_calls: int(u.failed_calls),
      input_tokens: int(u.input_tokens),
      output_tokens: int(u.output_tokens),
      cached_tokens: int(u.cached_tokens),
      cost_usd: num(u.cost_usd),
      messages_received: int(a.messages_received),
      messages_sent: int(a.messages_sent),
      tool_calls: int(a.tool_calls),
      active_users: int(a.active_users),
    };
  });
}

async function byModel(days: number) {
  const result = await rows(sql`
    SELECT model, sum(calls) calls, sum(failed_calls) failed_calls, sum(retries) retries, sum(fallbacks) fallbacks,
      sum(input_tokens) input_tokens, sum(output_tokens) output_tokens, sum(cached_tokens) cached_tokens,
      sum(cost_usd) cost_usd, sum(uncached_cost_usd) uncached_cost_usd, sum(total_latency_ms) total_latency_ms,
      min(date)::text first_seen, max(date)::text last_seen
    FROM usage_daily_rollups WHERE date >= ${startDate(days)} GROUP BY model`);
  return result
    .map((row) => {
      const calls = int(row.calls);
      return {
        model: row.model as string,
        calls,
        failed_calls: int(row.failed_calls),
        retries: int(row.retries),
        fallbacks: int(row.fallbacks),
        input_tokens: int(row.input_tokens),
        output_tokens: int(row.output_tokens),
        cached_tokens: int(row.cached_tokens),
        cost_usd: num(row.cost_usd),
        uncached_cost_usd: num(row.uncached_cost_usd),
        first_seen: row.first_seen as string,
        last_seen: row.last_seen as string,
        label: label(row.model),
        free: isFree(row.model),
        unpriced: !isKnown(row.model),
        avg_latency_ms: calls === 0 ? 0 : Math.trunc(int(row.total_latency_ms) / calls),
        cache_hit_rate: safeRatio(int(row.cached_tokens), int(row.input_tokens)),
      };
    })
    .sort((a, b) => b.cost_usd - a.cost_usd);
}

async function modelTimeline(days: number) {
  const result = await rows(sql`
    SELECT date::text date, model, sum(calls) calls, sum(cost_usd) cost_usd
    FROM usage_daily_rollups WHERE date >= ${startDate(days)} GROUP BY date, model`);
  const models = [...new Set(result.map((row) => row.model as string))].sort();
  const series = dateList(days).map((date) => ({
    date,
    models: Object.fromEntries(
      models.map((model) => {
        const row = result.find((candidate) => candidate.date === date && candidate.model === model);
        return [model, { calls: row ? int(row.calls) : 0, cost_usd: row ? num(row.cost_usd) : 0 }];
      }),
    ),
  }));
  return { models, series };
}

async function byPurpose(days: number) {
  const result = await rows(sql`
    SELECT purpose, sum(calls) calls, sum(cost_usd) cost_usd
    FROM usage_daily_rollups WHERE date >= ${startDate(days)} GROUP BY purpose`);
  return result
    .map((row) => ({ purpose: row.purpose as string, calls: int(row.calls), cost_usd: num(row.cost_usd) }))
    .sort((a, b) => b.cost_usd - a.cost_usd);
}

async function byTool(days: number) {
  const result = (
    await rows(sql`SELECT tool, sum(calls) calls FROM tool_daily_rollups WHERE date >= ${startDate(days)} GROUP BY tool`)
  )
    .map((row) => ({
      tool: row.tool as string,
      calls: int(row.calls),
      category: INTENT_TOOLS.has(row.tool) ? ("intent" as const) : ("everyday" as const),
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
  const activity = new Map(
    (
      await rows(sql`
        SELECT user_id, sum(messages_received) messages_received, sum(messages_sent) messages_sent, sum(tool_calls) tool_calls,
          sum(sessions) sessions, sum(memory_searches) memory_searches, sum(notes_created) notes_created,
          count(DISTINCT date) active_days, max(date)::text last_active
        FROM activity_daily_rollups WHERE date >= ${from} GROUP BY user_id`)
    ).map((row) => [row.user_id, row]),
  );
  const usage = new Map(
    (
      await rows(sql`
        SELECT user_id, sum(calls) calls, sum(input_tokens) input_tokens, sum(output_tokens) output_tokens, sum(cost_usd) cost_usd
        FROM usage_daily_rollups WHERE date >= ${from} AND user_id IS NOT NULL GROUP BY user_id`)
    ).map((row) => [row.user_id, row]),
  );
  const users = await rows(sql`SELECT id, name, email, slack_id FROM users ORDER BY name`);
  return users
    .map((user) => {
      const a = activity.get(user.id) ?? {};
      const p = usage.get(user.id) ?? {};
      return {
        user_id: user.id as string,
        name: (user.name || user.email || user.slack_id) as string,
        email: user.email as string | null,
        system: String(user.slack_id ?? "").startsWith("system:"),
        messages_received: int(a.messages_received),
        messages_sent: int(a.messages_sent),
        tool_calls: int(a.tool_calls),
        sessions: int(a.sessions),
        memory_searches: int(a.memory_searches),
        notes_created: int(a.notes_created),
        active_days: int(a.active_days),
        last_active: (a.last_active as string) ?? null,
        calls: int(p.calls),
        input_tokens: int(p.input_tokens),
        output_tokens: int(p.output_tokens),
        cost_usd: num(p.cost_usd),
        attributed: int(p.calls) > 0,
      };
    })
    .filter((user) => !(user.messages_received === 0 && user.calls === 0 && user.active_days === 0))
    .sort((a, b) => b.messages_received - a.messages_received || b.active_days - a.active_days);
}

async function adoption(days: number) {
  const from = startDate(days);
  const weekly = (
    await rows(sql`
      SELECT date_trunc('week', r.date)::date::text week, count(DISTINCT r.user_id) active_users,
        sum(r.messages_received) messages, sum(r.sessions) sessions
      FROM activity_daily_rollups r JOIN users u ON u.id = r.user_id
      WHERE r.date >= ${from} AND ${ACTIVE} AND u.slack_id NOT LIKE ${SYSTEM_PREFIX}
      GROUP BY date_trunc('week', r.date) ORDER BY date_trunc('week', r.date)`)
  ).map((row) => ({ week: row.week as string, active_users: int(row.active_users), messages: int(row.messages), sessions: int(row.sessions) }));
  const active = await activeUsersBetween(from, utcToday());
  const people = await peopleCount();
  const series = await dailySeries(days);
  const avgDaily = series.length === 0 ? 0 : series.reduce((sum, day) => sum + day.active_users, 0) / series.length;
  return {
    weekly,
    active_users: active,
    total_people: people,
    never_used: Math.max(people - active, 0),
    reach: safeRatio(active, people),
    avg_daily_active: Math.round(avgDaily * 10) / 10,
    stickiness: active > 0 ? Math.round((avgDaily / active) * 1000) / 1000 : 0,
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
