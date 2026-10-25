import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { db, tables } = await import("../../lib/db/index.ts");
const { privateLevel } = await import("../../lib/memory/access.ts");
const { createNode, deleteNodeAs, getSoul, isSoul, updateSoul } = await import("../../lib/memory/nodes.ts");
const { findOrCreateBySlackId } = await import("../../lib/accounts.ts");

const EMBEDDING = Array.from({ length: 1024 }, () => 0.1);
const insertUser = () => findOrCreateBySlackId(`U${randomUUID().slice(0, 10)}`, `D${randomUUID().slice(0, 10)}`);

describe.skipIf(!enabled)("souls", () => {
  it("does not adopt a channel note as the soul", async () => {
    const user = await insertUser();
    await createNode(user.id, ["internal"], { content: "Franek is on vacation next week", embedding: EMBEDDING });
    expect(await getSoul(user.id)).toBeNull();
  });

  it("ignores a legacy soul pointer to a shared note and replaces it with a private soul", async () => {
    const user = await insertUser();
    const shared = await createNode(user.id, ["internal"], { content: "deploys happen on Fridays", embedding: EMBEDDING });
    await db.update(tables.users).set({ soulNodeId: shared.id }).where(eq(tables.users.id, user.id));
    expect(await getSoul(user.id)).toBeNull();
    expect(await isSoul(shared.id)).toBe(false);

    const soul = await updateSoul(user.id, "I am a calm, precise Manfrod for Ola, a backend developer.", EMBEDDING);
    expect(soul.id).not.toBe(shared.id);
    expect(soul.access).toEqual([privateLevel(user.id)]);
    expect((await getSoul(user.id))?.id).toBe(soul.id);
    expect(await isSoul(soul.id)).toBe(true);
  });

  it("gives every user their own soul", async () => {
    const [a, b] = await Promise.all([insertUser(), insertUser()]);
    const soulA = await updateSoul(a.id, "Manfrod for A", EMBEDDING);
    const soulB = await updateSoul(b.id, "Manfrod for B", EMBEDDING);
    expect(soulA.id).not.toBe(soulB.id);
    expect((await getSoul(a.id))?.content).toBe("Manfrod for A");
    expect((await getSoul(b.id))?.content).toBe("Manfrod for B");
  });
});

describe.skipIf(!enabled)("deleting notes", () => {
  it("lets team members delete shared notes but keeps client channels to their own", async () => {
    const [author, teammate] = await Promise.all([insertUser(), insertUser()]);
    const make = () => createNode(author.id, ["internal", "external/acme"], { content: "acme kickoff notes", embedding: EMBEDDING });

    const fromClientChannel = await deleteNodeAs(
      { userId: teammate.id, readableLevels: ["external/acme", "external/all"] },
      (await make()).id,
    );
    expect(fromClientChannel).toEqual({ ok: false, error: "forbidden" });

    const ownFromClientChannel = await deleteNodeAs(
      { userId: author.id, readableLevels: ["external/acme", "external/all"] },
      (await make()).id,
    );
    expect(ownFromClientChannel.ok).toBe(true);

    const fromTeamChannel = await deleteNodeAs({ userId: teammate.id, readableLevels: ["internal", "external/all"] }, (await make()).id);
    expect(fromTeamChannel.ok).toBe(true);
  });

  it("never reaches someone else's private notes", async () => {
    const [owner, other] = await Promise.all([insertUser(), insertUser()]);
    const note = await createNode(owner.id, [privateLevel(owner.id)], { content: "private thought", embedding: EMBEDDING });
    const result = await deleteNodeAs({ userId: other.id, readableLevels: [privateLevel(other.id), "internal", "external/all"] }, note.id);
    expect(result).toEqual({ ok: false, error: "not_found" });
  });
});
