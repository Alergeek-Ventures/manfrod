import { eq } from "drizzle-orm";
import { config } from "./config.ts";
import { db, tables } from "./db/index.ts";
import type { KalafiorniaConnection } from "./db/schema.ts";
import { logger } from "./log.ts";

const { kalafiorniaConnections } = tables;
const BASE_URL = "https://kalafiornia.pl";
const log = logger("Kalafiornia.Client");

export type KResult<T> = { ok: true; value: T } | { ok: false; error: string };

const timeout = () => AbortSignal.timeout(10_000);

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if ((response.headers.get("content-type") ?? "").includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

export async function requestPin(email: string): Promise<KResult<null>> {
  try {
    const response = await fetch(`${BASE_URL}/login/`, {
      method: "POST",
      body: new URLSearchParams({ email }),
      redirect: "manual",
      signal: timeout(),
    });
    return response.status >= 200 && response.status < 400
      ? { ok: true, value: null }
      : { ok: false, error: `unexpected_status_${response.status}` };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

async function loginWithPinRequest(pin: string): Promise<KResult<string>> {
  try {
    const response = await fetch(`${BASE_URL}/login-by-pin`, {
      method: "POST",
      body: new URLSearchParams({ pin }),
      redirect: "manual",
      signal: timeout(),
    });
    if (response.status < 200 || response.status >= 400) return { ok: false, error: `unexpected_status_${response.status}` };
    const session = response.headers
      .getSetCookie()
      .map((header) => /^session=([^;]+)/.exec(header)?.[1])
      .find(Boolean);
    return session ? { ok: true, value: session } : { ok: false, error: "no_session_cookie" };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

async function openDoorRequest(session: string, doorId: string): Promise<KResult<unknown>> {
  try {
    const response = await fetch(`${BASE_URL}/open-door`, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        cookie: `session=${session}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ doorId }),
      signal: timeout(),
    });
    const body = await readBody(response);
    if (response.status === 200) {
      if (typeof body === "string" && body.trim() === "Not logged in.") return { ok: false, error: "not_logged_in" };
      return { ok: true, value: body };
    }
    log.warn(`Kalafiornia.Client: open_door failed: HTTP ${response.status} ${JSON.stringify(body)}`);
    return { ok: false, error: `unexpected_status_${response.status}` };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export interface AccessEntry {
  time: Date;
  event: string;
  door_id: string;
  user_name: string;
  opened_by: string;
}

async function officeAccessLog(): Promise<KResult<Record<string, string>[]>> {
  try {
    const response = await fetch(`${BASE_URL}/api/log/office-access`, {
      headers: { "x-api-key": config.kalafiorniaOfficeAccessApiKey ?? "" },
      signal: timeout(),
    });
    const body = await readBody(response);
    if (response.status === 200 && Array.isArray(body)) return { ok: true, value: body };
    log.warn(`Kalafiornia.Client: office_access_log failed: HTTP ${response.status} ${JSON.stringify(body)}`);
    return { ok: false, error: `unexpected_status_${response.status}` };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export async function getConnection(userId: string): Promise<KalafiorniaConnection | null> {
  const [row] = await db.select().from(kalafiorniaConnections).where(eq(kalafiorniaConnections.userId, userId)).limit(1);
  return row ?? null;
}

export async function loginWithPin(userId: string, email: string, pin: string): Promise<KResult<KalafiorniaConnection>> {
  const session = await loginWithPinRequest(pin);
  if (!session.ok) return session;
  const values = { userId, email, session: session.value, status: "connected" };
  const existing = await getConnection(userId);
  const [row] = existing
    ? await db.update(kalafiorniaConnections).set(values).where(eq(kalafiorniaConnections.id, existing.id)).returning()
    : await db.insert(kalafiorniaConnections).values(values).returning();
  return { ok: true, value: row };
}

export async function disconnect(userId: string): Promise<void> {
  await db.delete(kalafiorniaConnections).where(eq(kalafiorniaConnections.userId, userId));
}

export async function listOfficeAccessLog(opts: { since?: string | Date; userName?: string } = {}): Promise<KResult<AccessEntry[]>> {
  const raw = await officeAccessLog();
  if (!raw.ok) return raw;
  let entries = raw.value.map((entry) => ({
    time: new Date(entry.time),
    event: entry.event,
    door_id: entry.doorId,
    user_name: entry.userName,
    opened_by: entry.openedBy,
  }));
  if (opts.since !== undefined) {
    const since = typeof opts.since === "string" ? new Date(`${opts.since}T00:00:00Z`) : opts.since;
    entries = entries.filter((entry) => entry.time >= since);
  }
  if (opts.userName) {
    const wanted = opts.userName.toLowerCase();
    entries = entries.filter((entry) => (entry.user_name ?? "").toLowerCase().includes(wanted));
  }
  return { ok: true, value: entries };
}

export async function openDoor(userId: string, doorId: string): Promise<KResult<unknown>> {
  const connection = await getConnection(userId);
  if (!connection) return { ok: false, error: "not_connected" };
  if (connection.status === "invalid") return { ok: false, error: "session_invalid" };
  const result = await openDoorRequest(connection.session, doorId);
  if (!result.ok && result.error === "not_logged_in") {
    await db.update(kalafiorniaConnections).set({ status: "invalid" }).where(eq(kalafiorniaConnections.id, connection.id));
    return { ok: false, error: "session_invalid" };
  }
  return result;
}
