import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { BufferedMessage } from "../db/schema.ts";
import { EVENTS, ROOT_THREAD_KEY, sendEvent } from "../inngest/client.ts";
import { logger } from "../log.ts";
import { classifyBatch } from "./classifier.ts";

const { memoryBuffer } = tables;
const log = logger("Buffer");

export const FLUSH_AFTER_MESSAGES = 8;

const threadMatch = (threadTs: string | null) =>
  threadTs === null ? isNull(memoryBuffer.threadTs) : eq(memoryBuffer.threadTs, threadTs);

export async function push(channelId: string, threadTs: string | null, channelName: string | null, message: BufferedMessage) {
  await db.insert(memoryBuffer).values({ channelId, threadTs, channelName, message });
  const [{ value }] = await db
    .select({ value: count() })
    .from(memoryBuffer)
    .where(and(eq(memoryBuffer.channelId, channelId), threadMatch(threadTs)));

  if (Number(value) >= FLUSH_AFTER_MESSAGES) {
    void flush(channelId, threadTs).catch((error) => log.error(`Buffer flush failed: ${(error as Error).message}`));
  } else {
    await sendEvent(EVENTS.bufferPushed, { channelId, threadKey: threadTs ?? ROOT_THREAD_KEY });
  }
}

export async function flush(channelId: string, threadTs: string | null): Promise<number> {
  const rows = await db.transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(memoryBuffer)
      .where(and(eq(memoryBuffer.channelId, channelId), threadMatch(threadTs)))
      .orderBy(asc(memoryBuffer.id))
      .for("update", { skipLocked: true });
    if (locked.length > 0) {
      await tx.delete(memoryBuffer).where(inArray(memoryBuffer.id, locked.map((row) => row.id)));
    }
    return locked;
  });
  if (rows.length === 0) return 0;

  log.info(`Buffer flushing ${rows.length} messages from ${channelId}/${threadTs ?? "root"}`);
  const channelName = rows.findLast((row) => row.channelName)?.channelName ?? null;
  await classifyBatch(
    rows.map((row) => row.message as BufferedMessage),
    channelId,
    channelName,
  );
  return rows.length;
}

export async function staleKeys(olderThanSeconds = 120): Promise<{ channelId: string; threadTs: string | null }[]> {
  const rows = await db
    .selectDistinct({ channelId: memoryBuffer.channelId, threadTs: memoryBuffer.threadTs })
    .from(memoryBuffer)
    .where(sql`${memoryBuffer.insertedAt} < timezone('UTC', now()) - make_interval(secs => ${olderThanSeconds})`);
  return rows;
}
