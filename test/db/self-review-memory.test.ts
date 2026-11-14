import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { MessageFeedback } from "../../lib/db/schema.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { broadcast } = await import("../../lib/events/index.ts");
const { privateLevel } = await import("../../lib/memory/access.ts");
const { createNode } = await import("../../lib/memory/nodes.ts");
const { memoryShown } = await import("../../lib/self-review/memory.ts");
const { findOrCreateBySlackId } = await import("../../lib/accounts.ts");

const EMBEDDING = Array.from({ length: 1024 }, () => 0.1);

describe.skipIf(!enabled)("memoryShown", () => {
  const sessionKey = `C${randomUUID().slice(0, 8)}:1731577000.000100`;
  const feedback = { sessionKey, messageTs: "1731577000.000100" } as MessageFeedback;
  let shownId: string;
  let otherId: string;

  beforeAll(async () => {
    const owner = await findOrCreateBySlackId(`U${randomUUID().slice(0, 10)}`, `D${randomUUID().slice(0, 10)}`);
    shownId = (await createNode(owner.id, ["internal"], { content: "The office moves to Wrocław in March", embedding: EMBEDDING })).id;
    otherId = (await createNode(owner.id, [privateLevel(owner.id)], { content: "A private note", embedding: EMBEDDING })).id;
    await broadcast("memory_context", {
      sessionKey,
      source: "memory",
      meta: { note_ids: [shownId, otherId], readable_levels: ["internal"], at: new Date().toISOString() },
    });
  });

  it("returns the notes that were in context, without notes the reader could not see", async () => {
    const shown = await memoryShown(feedback, new Date(Date.now() + 1000));
    expect(shown).toContain("The office moves to Wrocław in March");
    expect(shown).not.toContain("A private note");
  });

  it("returns null when no context was recorded before the reply", async () => {
    expect(await memoryShown(feedback, new Date(Date.now() - 3_600_000))).toBeNull();
  });
});
