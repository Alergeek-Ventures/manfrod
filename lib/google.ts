import { eq } from "drizzle-orm";
import { GOOGLE_CALENDAR_SCOPE } from "./auth-constants.ts";
import { config } from "./config.ts";
import { db, tables } from "./db/index.ts";
import type { Account } from "./db/schema.ts";
import { logger } from "./log.ts";

const BASE_URL = "https://www.googleapis.com/calendar/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const EXPIRY_BUFFER_SECONDS = 60;
const log = logger("Google");

export type GResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type CalendarStatus = "connected" | "expired" | "missing_scope" | "not_connected";

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string | null;
  end: string | null;
  all_day: boolean;
  location: string | null;
  link: string | null;
  attendees: { email: string | null; name: string | null; status: string | null }[];
}

function eventTime(value: Record<string, string> | undefined): [string | null, boolean] {
  if (value?.dateTime) return [value.dateTime, false];
  if (value?.date) return [value.date, true];
  return [null, false];
}

function normalize(raw: Record<string, any>): CalendarEvent {
  const [start, allDay] = eventTime(raw.start);
  const [end] = eventTime(raw.end);
  return {
    id: raw.id ?? "",
    summary: raw.summary ?? "(no title)",
    start,
    end,
    all_day: allDay,
    location: raw.location ?? null,
    link: raw.htmlLink ?? null,
    attendees: ((raw.attendees ?? []) as Record<string, any>[])
      .filter((attendee) => attendee.self !== true)
      .map((attendee) => ({
        email: attendee.email ?? null,
        name: attendee.displayName ?? null,
        status: attendee.responseStatus ?? null,
      })),
  };
}

const iso = (date: Date) => `${date.toISOString().slice(0, 19)}Z`;

async function fetchEvents(url: string, headers: Record<string, string>): Promise<GResult<CalendarEvent[]>> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    const body = (await response.json().catch(() => null)) as Record<string, any> | null;
    if (response.status !== 200) return { ok: false, error: `{:api_error, ${response.status}, ${JSON.stringify(body)}}` };
    return {
      ok: true,
      value: ((body?.items ?? []) as Record<string, any>[]).filter((item) => item.status !== "cancelled").map(normalize),
    };
  } catch (error) {
    return { ok: false, error: `{:http_error, ${(error as Error).message}}` };
  }
}

export function listEvents(accessToken: string, timeMin: Date, timeMax: Date, maxResults = 250) {
  const params = new URLSearchParams({
    timeMin: iso(timeMin),
    timeMax: iso(timeMax),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(maxResults),
  });
  return fetchEvents(`${BASE_URL}/calendars/primary/events?${params}`, { authorization: `Bearer ${accessToken}` });
}

async function calendarRequest(accessToken: string, method: string, path: string, body?: unknown): Promise<GResult<Record<string, any>>> {
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 204) return { ok: true, value: {} };
    const json = (await response.json().catch(() => null)) as Record<string, any> | null;
    if (response.status === 403 && JSON.stringify(json).includes("insufficient")) return { ok: false, error: "insufficient_scope" };
    if (response.status === 404 || response.status === 410) return { ok: false, error: "not_found" };
    if (!response.ok) return { ok: false, error: `{:api_error, ${response.status}, ${JSON.stringify(json)}}` };
    return { ok: true, value: json ?? {} };
  } catch (error) {
    return { ok: false, error: `{:http_error, ${(error as Error).message}}` };
  }
}

export interface BusyCalendar {
  busy: { start: Date; end: Date }[];
  error: string | null;
}

export async function freeBusy(
  accessToken: string,
  calendars: string[],
  timeMin: Date,
  timeMax: Date,
): Promise<GResult<Map<string, BusyCalendar>>> {
  const result = await calendarRequest(accessToken, "POST", "/freeBusy", {
    timeMin: iso(timeMin),
    timeMax: iso(timeMax),
    items: calendars.map((id) => ({ id })),
  });
  if (!result.ok) return result;
  const entries = Object.entries((result.value.calendars ?? {}) as Record<string, any>).map(([id, calendar]) => {
    const busy = ((calendar.busy ?? []) as { start: string; end: string }[]).map((slot) => ({
      start: new Date(slot.start),
      end: new Date(slot.end),
    }));
    const error = ((calendar.errors ?? []) as { reason?: string }[])[0]?.reason ?? null;
    return [id, { busy, error }] as const;
  });
  return { ok: true, value: new Map(entries) };
}

const WRITE_QUERY = "sendUpdates=all&conferenceDataVersion=1";

export async function getEvent(accessToken: string, id: string): Promise<GResult<Record<string, any>>> {
  return calendarRequest(accessToken, "GET", `/calendars/primary/events/${encodeURIComponent(id)}`);
}

export async function createEvent(accessToken: string, event: Record<string, unknown>): Promise<GResult<Record<string, any>>> {
  return calendarRequest(accessToken, "POST", `/calendars/primary/events?${WRITE_QUERY}`, event);
}

export async function updateEvent(accessToken: string, id: string, patch: Record<string, unknown>): Promise<GResult<Record<string, any>>> {
  return calendarRequest(accessToken, "PATCH", `/calendars/primary/events/${encodeURIComponent(id)}?${WRITE_QUERY}`, patch);
}

export async function deleteEvent(accessToken: string, id: string): Promise<GResult<Record<string, any>>> {
  return calendarRequest(accessToken, "DELETE", `/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=all`);
}

const PUBLIC_HOLIDAY = /^(Święto państwowe|Public holiday)/i;

export async function listPublicHolidays(
  calendarId: string,
  timeMin: Date,
  timeMax: Date,
): Promise<GResult<{ date: string; name: string }[]>> {
  const apiKey = config.googleApiKey;
  if (!apiKey) return { ok: false, error: "no_google_api_key" };
  const params = new URLSearchParams({
    key: apiKey,
    timeMin: iso(timeMin),
    timeMax: iso(timeMax),
    singleEvents: "true",
    orderBy: "startTime",
  });
  try {
    const response = await fetch(`${BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events?${params}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => null)) as Record<string, any> | null;
    if (response.status !== 200) return { ok: false, error: `{:api_error, ${response.status}, ${JSON.stringify(body)}}` };
    const items = (body?.items ?? []) as Record<string, any>[];
    return {
      ok: true,
      value: items
        .filter((item) => item.status !== "cancelled" && item.start?.date && PUBLIC_HOLIDAY.test(item.description ?? ""))
        .map((item) => ({ date: item.start.date as string, name: item.summary as string })),
    };
  } catch (error) {
    return { ok: false, error: `{:http_error, ${(error as Error).message}}` };
  }
}

export async function ensureValidToken(identity: Account): Promise<GResult<string>> {
  const expiresAt = identity.accessTokenExpiresAt?.getTime() ?? 0;
  if (identity.accessToken && Date.now() + EXPIRY_BUFFER_SECONDS * 1000 < expiresAt) {
    return { ok: true, value: identity.accessToken };
  }
  if (!identity.refreshToken) return { ok: false, error: "no_refresh_token" };

  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: identity.refreshToken,
        client_id: config.googleClientId ?? "",
        client_secret: config.googleClientSecret ?? "",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => null)) as Record<string, any> | null;
    if (response.status !== 200 || !body) {
      log.error(`Google token refresh failed: ${response.status} — ${JSON.stringify(body)}`);
      return { ok: false, error: `{:refresh_failed, ${response.status}, ${JSON.stringify(body)}}` };
    }
    await db
      .update(tables.account)
      .set({ accessToken: body.access_token, accessTokenExpiresAt: new Date(Date.now() + Number(body.expires_in) * 1000) })
      .where(eq(tables.account.id, identity.id));
    log.debug(`Refreshed Google token for identity ${identity.id}`);
    return { ok: true, value: body.access_token };
  } catch (error) {
    log.error(`Google token refresh HTTP error: ${(error as Error).message}`);
    return { ok: false, error: `{:http_error, ${(error as Error).message}}` };
  }
}

export async function calendarStatus(identity: Account | null): Promise<CalendarStatus> {
  if (!identity) return "not_connected";
  if (!(identity.scope ?? "").includes(GOOGLE_CALENDAR_SCOPE)) return "missing_scope";
  return (await ensureValidToken(identity)).ok ? "connected" : "expired";
}
