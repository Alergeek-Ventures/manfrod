import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { privateLevel } = await import("../../lib/memory/access.ts");
const { createLink, createNode, getGraphData } = await import("../../lib/memory/nodes.ts");
const { findOrCreateBySlackId } = await import("../../lib/accounts.ts");

describe.skipIf(!enabled)("getGraphData adversarial links", () => {
  let level: string;
  let selfId: string;
  let peerId: string;

  beforeAll(async () => {
    const user = await findOrCreateBySlackId(`U${randomUUID().slice(0, 10)}`, `D${randomUUID().slice(0, 10)}`);
    level = privateLevel(user.id);
    selfId = (await createNode(user.id, [level], { content: "self", processedAt: new Date() })).id;
    peerId = (await createNode(user.id, [level], { content: "peer", processedAt: new Date() })).id;
    await createLink(user.id, selfId, selfId);
    await createLink(user.id, selfId, peerId);
    await createLink(user.id, selfId, peerId);
  });

  it("deduplicates duplicate links persisted through conflict handling", async () => {
    const graph = await getGraphData({ accessLevel: level });
    expect(graph.edges).toHaveLength(2);
  });

  it("counts a self-link once in degree", async () => {
    const graph = await getGraphData({ accessLevel: level });
    expect(graph.nodes.find((node) => node.id === selfId)?.degree).toBe(2);
  });
});
