import { and, eq, lt, sql } from "drizzle-orm";
import { db, tables } from "../db/index.ts";

const { memoryPendingOps, memoryPendingConfirmations } = tables;

const OPS_TTL_MS = 6 * 60 * 60 * 1000;
const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface Flag {
  action: string;
  content?: string;
  start_date?: string;
  end_date?: string;
  working?: boolean;
}

export type PendingOp =
  | { op: "escalate"; node_id: string; level: string; readable_levels: string[] }
  | { op: "delete"; node_id: string; user_id: string }
  | { op: "link"; a: string; b: string; user_id: string }
  | { op: "unlink"; a: string; b: string; user_id: string };

const expiry = (ttl: number) => new Date(Date.now() + ttl);

export async function flagMessage(channelId: string, ts: string, action: string, extra: Omit<Flag, "action"> = {}) {
  const flag = { ...extra, action };
  await db
    .insert(memoryPendingOps)
    .values({ channelId, ts, flag, ops: [], expiresAt: expiry(OPS_TTL_MS) })
    .onConflictDoUpdate({
      target: [memoryPendingOps.channelId, memoryPendingOps.ts],
      set: { flag, expiresAt: expiry(OPS_TTL_MS) },
    });
}

export async function addOp(channelId: string, ts: string, op: PendingOp) {
  await db
    .insert(memoryPendingOps)
    .values({ channelId, ts, flag: null, ops: [op], expiresAt: expiry(OPS_TTL_MS) })
    .onConflictDoUpdate({
      target: [memoryPendingOps.channelId, memoryPendingOps.ts],
      set: {
        ops: sql`${memoryPendingOps.ops} || ${JSON.stringify([op])}::jsonb`,
        expiresAt: expiry(OPS_TTL_MS),
      },
    });
}

export async function take(
  channelId: string | null | undefined,
  ts: string | null | undefined,
): Promise<{ flag: Flag | null; ops: PendingOp[] }> {
  if (!channelId || !ts) return { flag: null, ops: [] };
  const [row] = await db
    .delete(memoryPendingOps)
    .where(and(eq(memoryPendingOps.channelId, channelId), eq(memoryPendingOps.ts, ts)))
    .returning();
  if (!row || row.expiresAt < new Date()) return { flag: null, ops: [] };
  return { flag: (row.flag as Flag | null) ?? null, ops: row.ops as PendingOp[] };
}

export interface ConfirmationPayload {
  node_id: string;
  options: string[];
  preselected: string[];
  write_access: string[];
  fact_key: string | null;
  lang: "pl" | "en";
  author_slack_id?: string;
}

export async function putConfirmation(botTs: string, channelId: string, payload: ConfirmationPayload) {
  await db
    .insert(memoryPendingConfirmations)
    .values({ botTs, channelId, payload: { ...payload }, expiresAt: expiry(CONFIRMATION_TTL_MS) })
    .onConflictDoUpdate({
      target: memoryPendingConfirmations.botTs,
      set: { channelId, payload: { ...payload }, expiresAt: expiry(CONFIRMATION_TTL_MS) },
    });
}

export async function getConfirmation(
  botTs: string,
): Promise<{ channelId: string; payload: ConfirmationPayload } | null> {
  const [row] = await db
    .select()
    .from(memoryPendingConfirmations)
    .where(eq(memoryPendingConfirmations.botTs, botTs))
    .limit(1);
  if (!row || row.expiresAt < new Date()) return null;
  return { channelId: row.channelId, payload: row.payload as unknown as ConfirmationPayload };
}

export async function deleteConfirmation(botTs: string) {
  await db.delete(memoryPendingConfirmations).where(eq(memoryPendingConfirmations.botTs, botTs));
}

export async function sweep(): Promise<void> {
  const now = new Date();
  await db.delete(memoryPendingOps).where(lt(memoryPendingOps.expiresAt, now));
  await db.delete(memoryPendingConfirmations).where(lt(memoryPendingConfirmations.expiresAt, now));
}
