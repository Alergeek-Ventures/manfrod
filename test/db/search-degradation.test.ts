import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const emitted: { type: string; meta?: Record<string, unknown> }[] = [];

vi.mock("../../lib/voyage.ts", () => ({
  embed: async () => {
    throw new Error("voyage down");
  },
  rerank: async () => {
    throw new Error("voyage down");
  },
}));
vi.mock("../../lib/events/index.ts", async (original) => ({
  ...(await original<object>()),
  emit: (type: string, attrs: { meta?: Record<string, unknown> } = {}) => emitted.push({ type, meta: attrs.meta }),
}));

const { privateLevel } = await import("../../lib/memory/access.ts");
const { createNode } = await import("../../lib/memory/nodes.ts");
const { search } = await import("../../lib/memory/search.ts");
const { findOrCreateBySlackId } = await import("../../lib/accounts.ts");

describe.skipIf(!enabled)("search when Voyage is down", () => {
  let level: string;
  const word = `zebrafish${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    const user = await findOrCreateBySlackId(`U${randomUUID().slice(0, 10)}`, `D${randomUUID().slice(0, 10)}`);
    level = privateLevel(user.id);
    await createNode(user.id, [level], { content: `The ${word} tank needs cleaning`, embedding: Array.from({ length: 1024 }, () => 0.1) });
    await createNode(user.id, [level], { content: `Another ${word} note`, embedding: Array.from({ length: 1024 }, () => 0.2) });
  });

  it("still answers from full-text search and reports which stages failed", async () => {
    const found = await search(null, [level], word, { expandQuery: false });
    expect(found.length).toBe(2);
    const stats = emitted.find((event) => event.type === "memory_searched")?.meta?.stats as { degraded: string[] };
    expect(stats.degraded.sort()).toEqual(["embed", "rerank"]);
  });
});
