import { and, eq } from "drizzle-orm";
import { db, tables } from "../db/index.ts";

const { channelNudges, nudgeDeliveries, nudgePreferences } = tables;

export const NUDGE_KINDS = {
  holidays: "pytania o plany na święta i podpowiedzi dni pomostowych",
  waiting: "na początek dnia pracy: wątki, w których ktoś czeka na odpowiedź, i rzeczy, które ta osoba obiecała zrobić",
  absence: "po zgłoszeniu urlopu: propozycje typu wniosek w Firmowidzie, zwolnienie biurek, info na kanałach projektów",
  weekly: "piątkowe podsumowanie tygodnia (godziny w Firmowidzie) i zapowiedź następnego",
  requests: "wiadomości prywatne w imieniu innych osób albo w sprawie zadań, które ktoś zlecił Manfrodowi (np. zbieranie odpowiedzi)",
} as const;

export type NudgeKind = keyof typeof NUDGE_KINDS;

export const isNudgeKind = (value: string): value is NudgeKind => value in NUDGE_KINDS;

export async function preferences(userId: string): Promise<Record<NudgeKind, boolean>> {
  const rows = await db.select().from(nudgePreferences).where(eq(nudgePreferences.userId, userId));
  const result = Object.fromEntries(Object.keys(NUDGE_KINDS).map((kind) => [kind, true])) as Record<NudgeKind, boolean>;
  for (const row of rows) if (isNudgeKind(row.kind)) result[row.kind] = row.enabled;
  return result;
}

export async function isEnabled(userId: string, kind: NudgeKind): Promise<boolean> {
  const [row] = await db
    .select({ enabled: nudgePreferences.enabled })
    .from(nudgePreferences)
    .where(and(eq(nudgePreferences.userId, userId), eq(nudgePreferences.kind, kind)))
    .limit(1);
  return row?.enabled ?? true;
}

export async function setPreference(userId: string, kind: NudgeKind, enabled: boolean): Promise<void> {
  await db
    .insert(nudgePreferences)
    .values({ userId, kind, enabled })
    .onConflictDoUpdate({ target: [nudgePreferences.userId, nudgePreferences.kind], set: { enabled, updatedAt: new Date() } });
}

export async function handled(userId: string, kind: NudgeKind, period: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nudgeDeliveries.id })
    .from(nudgeDeliveries)
    .where(and(eq(nudgeDeliveries.userId, userId), eq(nudgeDeliveries.kind, kind), eq(nudgeDeliveries.period, period)))
    .limit(1);
  return row !== undefined;
}

export async function recordDelivery(userId: string, kind: NudgeKind, period: string, sent: boolean, reason: string | null) {
  await db.insert(nudgeDeliveries).values({ userId, kind, period, sent, reason }).onConflictDoNothing();
}

export async function channelSettings(channelId: string): Promise<{ summaries: boolean; lastSummaryPeriod: string | null }> {
  const [row] = await db.select().from(channelNudges).where(eq(channelNudges.channelId, channelId)).limit(1);
  return { summaries: row?.summaries ?? true, lastSummaryPeriod: row?.lastSummaryPeriod ?? null };
}

export async function setChannelSummaries(channelId: string, summaries: boolean): Promise<void> {
  await db
    .insert(channelNudges)
    .values({ channelId, summaries })
    .onConflictDoUpdate({ target: channelNudges.channelId, set: { summaries, updatedAt: new Date() } });
}

export async function markSummarized(channelId: string, period: string): Promise<void> {
  await db
    .insert(channelNudges)
    .values({ channelId, lastSummaryPeriod: period })
    .onConflictDoUpdate({ target: channelNudges.channelId, set: { lastSummaryPeriod: period, updatedAt: new Date() } });
}
