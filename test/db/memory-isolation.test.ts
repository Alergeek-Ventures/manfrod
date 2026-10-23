import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { db, tables } = await import("../../lib/db/index.ts");
const { accessOverlaps, privateLevel, resolveForRead, resolveForWrite } = await import("../../lib/memory/access.ts");
const { createNode, escalateNoteAccess } = await import("../../lib/memory/nodes.ts");
const { findOrCreateBySlackId } = await import("../../lib/accounts.ts");

const EMBEDDING = Array.from({ length: 1024 }, () => 0.1);
const insertUser = () => findOrCreateBySlackId(`U${randomUUID().slice(0, 10)}`, `D${randomUUID().slice(0, 10)}`);

async function accessibleIds(userId: string, readable: string[], ids: string[]) {
  const rows = await db
    .select({ id: tables.nodes.id })
    .from(tables.nodes)
    .where(and(eq(tables.nodes.userId, userId), inArray(tables.nodes.id, ids), accessOverlaps(tables.nodes.access, readable)));
  return rows.map((row) => row.id);
}

describe.skipIf(!enabled)("memory access isolation", () => {
  let uid: string;
  let ids: Record<"internal" | "ext10bps" | "extAll" | "kenley" | "private", string>;

  beforeAll(async () => {
    uid = (await insertUser()).id;
    const make = async (access: string[], content: string) => (await createNode(uid, access, { content, embedding: EMBEDDING })).id;
    ids = {
      internal: await make(["internal"], "internal only secret"),
      ext10bps: await make(["internal", "external/10bps"], "10bps project data"),
      extAll: await make(["internal", "external/all"], "vacation external all"),
      kenley: await make(["external/kenley"], "kenley only record"),
      private: await make([privateLevel(uid)], "something told to the bot in a DM"),
    };
  });

  const visible = (readable: string[]) => accessibleIds(uid, readable, Object.values(ids));

  it("internal readers see internal nodes but not kenley or private", async () => {
    expect((await visible(["internal"])).sort()).toEqual([ids.internal, ids.ext10bps, ids.extAll].sort());
  });

  it("external/10bps readers see 10bps and external/all only", async () => {
    expect((await visible(["external/10bps", "external/all"])).sort()).toEqual([ids.ext10bps, ids.extAll].sort());
  });

  it("kenley readers see only kenley", async () => {
    expect(await visible(["external/kenley"])).toEqual([ids.kenley]);
  });

  it("external/all readers see only public-scoped nodes", async () => {
    expect(await visible(["external/all"])).toEqual([ids.extAll]);
  });

  it("DM writes land in the author's private space, falling back to internal", async () => {
    expect(await resolveForWrite("D0001", uid)).toEqual([privateLevel(uid)]);
    expect(await resolveForWrite("D0001", null)).toEqual(["internal"]);
  });

  it("a DM reader sees their own private space, nobody else's", async () => {
    const other = await insertUser();
    const levels = await resolveForRead(uid, "D0001");
    expect(levels).toContain(privateLevel(uid));
    expect(levels).toContain("internal");
    expect(levels).not.toContain(privateLevel(other.id));
    expect(await visible([privateLevel(other.id)])).toEqual([]);
    expect(await visible([privateLevel(uid)])).toEqual([ids.private]);
  });

  it("rejects escalations from a context without internal access and to private levels", async () => {
    const other = await insertUser();
    const levels = [privateLevel(uid), "internal"];
    expect(await escalateNoteAccess(ids.private, "internal", ["external/10bps"])).toEqual({
      ok: false,
      error: "external_channel_escalation_not_allowed",
    });
    expect(await escalateNoteAccess(ids.private, privateLevel(other.id), levels)).toEqual({ ok: false, error: "invalid_escalation_level" });
  });

  it("escalates private → internal → external/all and rejects repeats", async () => {
    const levels = [privateLevel(uid), "internal"];
    const first = await escalateNoteAccess(ids.private, "internal", levels);
    expect(first.ok && first.node.access).toEqual([privateLevel(uid), "internal"]);
    expect(await visible(["internal"])).toContain(ids.private);
    expect(await escalateNoteAccess(ids.private, "internal", levels)).toEqual({ ok: false, error: "already_accessible" });

    const second = await escalateNoteAccess(ids.private, "external/all", levels);
    expect(second.ok && second.node.access).toContain("external/all");
    expect(await visible(["external/all"])).toContain(ids.private);
  });
});
