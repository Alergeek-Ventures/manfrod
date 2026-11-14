import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { privateLevel } = await import("../../lib/memory/access.ts");
const { createLink, createNode, getGraphData, GRAPH_PREVIEW_LENGTH } = await import("../../lib/memory/nodes.ts");
const { findOrCreateBySlackId } = await import("../../lib/accounts.ts");

const EMBEDDING = Array.from({ length: 1024 }, () => 0.1);

describe.skipIf(!enabled)("getGraphData", () => {
  let level: string;
  let ids: Record<"long" | "short" | "internal", string>;

  beforeAll(async () => {
    const uid = (await findOrCreateBySlackId(`U${randomUUID().slice(0, 10)}`, `D${randomUUID().slice(0, 10)}`)).id;
    level = privateLevel(uid);
    const make = async (access: string[], content: string) => (await createNode(uid, access, { content, embedding: EMBEDDING })).id;
    ids = {
      long: await make([level], "x".repeat(GRAPH_PREVIEW_LENGTH + 500)),
      short: await make([level], "short private note"),
      internal: await make(["internal"], "internal note linked to a private one"),
    };
    await createLink(uid, ids.long, ids.short);
    await createLink(uid, ids.long, ids.internal);
  });

  it("returns only readable notes, trimmed previews and links between them", async () => {
    const graph = await getGraphData({ accessLevel: level });
    expect(graph.nodes.map((node) => node.id).sort()).toEqual([ids.long, ids.short].sort());
    expect(graph.nodes.find((node) => node.id === ids.long)?.preview).toHaveLength(GRAPH_PREVIEW_LENGTH);
    expect(graph.edges.map((edge) => [...edge].sort())).toEqual([[ids.long, ids.short].sort()]);
  });
});
