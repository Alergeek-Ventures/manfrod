import { and, eq, gte } from "drizzle-orm";
import { getGoogleAccount, isSystemUser, listUsers } from "../accounts.ts";
import { db, tables } from "../db/index.ts";
import type { User } from "../db/schema.ts";
import { overlappingAbsences } from "../facts.ts";
import { hasActiveSession } from "../firmowid.ts";
import { ensureValidToken as googleToken, listEvents, type CalendarEvent } from "../google.ts";
import { builtinProviders, ensureValidToken, getConnection } from "../mcp/index.ts";
import { deactivatedSlackIds } from "../slack/api.ts";
import { zonedToUtc } from "../time.ts";

const { messages } = tables;

export async function nudgeablePeople(): Promise<User[]> {
  const deactivated = await deactivatedSlackIds();
  return (await listUsers()).filter(
    (user) => !isSystemUser(user) && !user.banned && user.slackDmChannelId && !deactivated.has(user.slackId),
  );
}

export async function firmowidAccess(userId: string): Promise<{ mcpUrl: string; token: string } | null> {
  const provider = builtinProviders().find((candidate) => candidate.id === "firmowid");
  const connection = await getConnection(userId, "firmowid");
  if (!provider || !connection || connection.status === "disconnected") return null;
  const token = await ensureValidToken(connection);
  return token.ok ? { mcpUrl: provider.mcpUrl, token: token.value } : null;
}

export async function isAbsent(userId: string, date: string): Promise<boolean> {
  return (await overlappingAbsences(userId, date, date)).some((fact) => !/pracuje poza biurem/i.test(fact.value));
}

export async function wroteToday(userId: string, today: string): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.role, "user"), gte(messages.receivedAt, zonedToUtc(today, "00:00:00"))))
    .limit(1);
  return row !== undefined;
}

export async function firmowidSessionActive(userId: string): Promise<boolean> {
  const access = await firmowidAccess(userId);
  if (!access) return false;
  const active = await hasActiveSession(access.mcpUrl, access.token);
  return active.ok && active.value;
}

export async function meetings(userId: string, from: string, toExclusive: string): Promise<CalendarEvent[] | null> {
  const account = await getGoogleAccount(userId);
  if (!account) return null;
  const token = await googleToken(account);
  if (!token.ok) return null;
  const events = await listEvents(token.value, zonedToUtc(from, "00:00:00"), zonedToUtc(toExclusive, "00:00:00"));
  if (!events.ok) return null;
  return events.value.filter((event) => !event.all_day && event.attendees.length > 0);
}

function attendeeNames(event: CalendarEvent, shown = 3): string {
  const names = event.attendees.map((attendee) => attendee.name ?? attendee.email?.split("@")[0] ?? "?");
  return `${names.slice(0, shown).join(", ")}${names.length > shown ? ` and ${names.length - shown} more` : ""}`;
}

export function describeMeetings(events: CalendarEvent[], limit = 12): string {
  return events
    .slice(0, limit)
    .map((event) => `- ${event.start}: ${event.summary} (with ${attendeeNames(event)})`)
    .join("\n");
}
