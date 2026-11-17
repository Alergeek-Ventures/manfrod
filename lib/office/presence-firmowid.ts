import { extractRecords } from "../firmowid.ts";
import { logger } from "../log.ts";
import { callTool } from "../mcp/client.ts";
import { firmowidAccess } from "../nudges/signals.ts";
import { dateIsoInZone, isValidIsoDate } from "../time.ts";
import type { LeaveRequest, SessionDay } from "./presence-resolve.ts";

export const SESSION_FETCH_LIMIT = 300;
const CACHE_MS = 15 * 60_000;

const cache = new Map<string, { at: number; value: Record<string, any> }>();

export function clearFirmowidCache(): void {
  cache.clear();
}

type FirmowidAccess = NonNullable<Awaited<ReturnType<typeof firmowidAccess>>>;

async function cachedCall(userId: string, access: FirmowidAccess, tool: string, args: Record<string, unknown>) {
  const key = `${userId}:${tool}:${JSON.stringify(args)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ok: true as const, value: hit.value };
  const result = await callTool(access.mcpUrl, access.token, tool, args);
  if (result.ok) {
    for (const [stale, entry] of cache) if (Date.now() - entry.at >= CACHE_MS) cache.delete(stale);
    cache.set(key, { at: Date.now(), value: result.value });
  }
  return result;
}

const log = logger("Office.Presence");

export interface FirmowidSignals {
  sessionDays: SessionDay[] | null;
  leaveRequests: LeaveRequest[] | null;
}

export function parseSessionDays(records: Record<string, any>[]): SessionDay[] {
  const byDay = new Map<string, boolean>();
  for (const record of records) {
    if (typeof record.is_remote !== "boolean" || typeof record.start_datetime !== "string") continue;
    const start = new Date(record.start_datetime);
    if (Number.isNaN(start.getTime())) continue;
    const day = dateIsoInZone(start);
    byDay.set(day, (byDay.get(day) ?? true) && record.is_remote);
  }
  return [...byDay.entries()].map(([date, remote]) => ({ date, remote })).sort((a, b) => a.date.localeCompare(b.date));
}

const dateOf = (value: unknown) => (typeof value === "string" && isValidIsoDate(value.slice(0, 10)) ? value.slice(0, 10) : null);
const textOf = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

export function parseLeaveRequests(records: Record<string, any>[]): LeaveRequest[] {
  return records.flatMap((record) => {
    const startsOn = dateOf(record.starts_on);
    const endsOn = dateOf(record.ends_on) ?? startsOn;
    if (!startsOn || !endsOn) return [];
    return [{ startsOn, endsOn, status: textOf(record.status), category: textOf(record.category), reason: textOf(record.reason) }];
  });
}

export async function fetchFirmowidSignals(userId: string, from: string, date: string): Promise<FirmowidSignals> {
  const empty = { sessionDays: null, leaveRequests: null };
  try {
    const access = await firmowidAccess(userId);
    if (!access) return empty;
    const [sessions, leaves] = await Promise.all([
      cachedCall(userId, access, "list_sessions", {
        input: { after_date: from },
        limit: SESSION_FETCH_LIMIT,
        sort: [{ field: "start_datetime", direction: "desc" }],
      }),
      cachedCall(userId, access, "list_leave_requests", { input: { start_date: date, end_date: date } }),
    ]);
    if (!sessions.ok) log.warn(`list_sessions failed for ${userId}: ${sessions.error}`);
    if (!leaves.ok) log.warn(`list_leave_requests failed for ${userId}: ${leaves.error}`);
    return {
      sessionDays: sessions.ok ? parseSessionDays(extractRecords(sessions.value)) : null,
      leaveRequests: leaves.ok ? parseLeaveRequests(extractRecords(leaves.value)) : null,
    };
  } catch (error) {
    log.warn(`Firmowid unavailable for ${userId}`, error);
    return empty;
  }
}
