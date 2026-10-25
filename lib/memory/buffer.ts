import { and, asc, count, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { BufferedMessage } from "../db/schema.ts";
import { EVENTS, ROOT_THREAD_KEY, sendEvent } from "../inngest/client.ts";
import { logger } from "../log.ts";
import { classifyBatch } from "./classifier.ts";

const { memoryBuffer } = tables;
const log = logger("Buffer");

export const FLUSH_AFTER_MESSAGES = 8;
export const MAX_ATTEMPTS = 5;
const CLAIM_TTL_MS = 30 * 60 * 1000;

const threadMatch = (threadTs: string | null) => (threadTs === null ? isNull(memoryBuffer.threadTs) : eq(memoryBuffer.threadTs, threadTs));

const claimable = () => or(isNull(memoryBuffer.claimedAt), lt(memoryBuffer.claimedAt, new Date(Date.now() - CLAIM_TTL_MS)));

export async function push(channelId: string, threadTs: string | null, channelName: string | null, message: BufferedMessage) {
  await db.insert(memoryBuffer).values({ channelId, threadTs, channelName, message });
  const [{ value }] = await db
    .select({ value: count() })
    .from(memoryBuffer)
    .where(and(eq(memoryBuffer.channelId, channelId), threadMatch(threadTs), isNull(memoryBuffer.claimedAt)));

  if (Number(value) >= FLUSH_AFTER_MESSAGES) {
    void flush(channelId, threadTs).catch((error) => log.error(`Buffer flush failed: ${(error as Error).message}`));
  } else {
    await sendEvent(EVENTS.bufferPushed, { channelId, threadKey: threadTs ?? ROOT_THREAD_KEY });
  }
}

async function claim(channelId: string, threadTs: string | null) {
  return db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: memoryBuffer.id })
      .from(memoryBuffer)
      .where(and(eq(memoryBuffer.channelId, channelId), threadMatch(threadTs), claimable()))
      .orderBy(asc(memoryBuffer.id))
      .for("update", { skipLocked: true });
    if (locked.length === 0) return [];
    return tx
      .update(memoryBuffer)
      .set({ claimedAt: new Date(), attempts: sql`${memoryBuffer.attempts} + 1` })
      .where(
        inArray(
          memoryBuffer.id,
          locked.map((row) => row.id),
        ),
      )
      .returning();
  });
}

export async function flush(channelId: string, threadTs: string | null): Promise<number> {
  const rows = (await claim(channelId, threadTs)).sort((a, b) => a.id - b.id);
  if (rows.length === 0) return 0;
  const ids = rows.map((row) => row.id);

  log.info(`Buffer flushing ${rows.length} messages from ${channelId}/${threadTs ?? "root"}`);
  const channelName = rows.findLast((row) => row.channelName)?.channelName ?? null;
  try {
    await classifyBatch(
      rows.map((row) => row.message as BufferedMessage),
      channelId,
      channelName,
    );
  } catch (error) {
    await release(ids);
    throw error;
  }
  await db.delete(memoryBuffer).where(inArray(memoryBuffer.id, ids));
  return rows.length;
}

async function release(ids: number[]) {
  const dropped = await db
    .delete(memoryBuffer)
    .where(and(inArray(memoryBuffer.id, ids), gte(memoryBuffer.attempts, MAX_ATTEMPTS)))
    .returning({ id: memoryBuffer.id });
  if (dropped.length > 0) log.error(`Buffer dropped ${dropped.length} message(s) after ${MAX_ATTEMPTS} failed classifications`);
  await db.update(memoryBuffer).set({ claimedAt: null }).where(inArray(memoryBuffer.id, ids));
}

export async function staleKeys(olderThanSeconds = 120): Promise<{ channelId: string; threadTs: string | null }[]> {
  const rows = await db
    .selectDistinct({ channelId: memoryBuffer.channelId, threadTs: memoryBuffer.threadTs })
    .from(memoryBuffer)
    .where(and(lt(memoryBuffer.insertedAt, new Date(Date.now() - olderThanSeconds * 1000)), claimable()));
  return rows;
}
