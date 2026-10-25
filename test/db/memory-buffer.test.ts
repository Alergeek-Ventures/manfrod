import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const classifyBatch = vi.fn();
vi.mock("../../lib/memory/classifier.ts", () => ({ classifyBatch }));

const { db, tables } = await import("../../lib/db/index.ts");
const { flush, MAX_ATTEMPTS } = await import("../../lib/memory/buffer.ts");

const { memoryBuffer } = tables;

async function buffered(channelId: string, count: number) {
  await db.insert(memoryBuffer).values(
    Array.from({ length: count }, (_, index) => ({
      channelId,
      threadTs: null,
      channelName: "general",
      message: { user: "U1", text: `message ${index}`, ts: `${index}` },
    })),
  );
}

const rowsFor = (channelId: string) => db.select().from(memoryBuffer).where(eq(memoryBuffer.channelId, channelId));

describe.skipIf(!enabled)("memory buffer flush", () => {
  let channelId: string;

  beforeEach(() => {
    channelId = `C${randomUUID().slice(0, 8)}`;
    classifyBatch.mockReset();
  });

  it("deletes the batch only after it was classified", async () => {
    await buffered(channelId, 3);
    classifyBatch.mockResolvedValue(undefined);
    expect(await flush(channelId, null)).toBe(3);
    expect(classifyBatch).toHaveBeenCalledOnce();
    expect(await rowsFor(channelId)).toEqual([]);
  });

  it("keeps the batch for a retry when classification fails", async () => {
    await buffered(channelId, 2);
    classifyBatch.mockRejectedValue(new Error("llm down"));
    await expect(flush(channelId, null)).rejects.toThrow("llm down");
    const rows = await rowsFor(channelId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.claimedAt === null && row.attempts === 1)).toBe(true);
  });

  it("drops the batch after the last allowed attempt", async () => {
    await buffered(channelId, 1);
    classifyBatch.mockRejectedValue(new Error("llm down"));
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) await expect(flush(channelId, null)).rejects.toThrow();
    expect(await rowsFor(channelId)).toEqual([]);
  });

  it("does not hand rows that are being classified to a second flush", async () => {
    await buffered(channelId, 2);
    let release: () => void = () => {};
    classifyBatch.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    const first = flush(channelId, null);
    await vi.waitFor(() => expect(classifyBatch).toHaveBeenCalledOnce());
    expect(await flush(channelId, null)).toBe(0);
    release();
    expect(await first).toBe(2);
  });
});
