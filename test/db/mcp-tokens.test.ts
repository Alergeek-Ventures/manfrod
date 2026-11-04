import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { db, tables } = await import("../../lib/db/index.ts");
const { getConnection, listAllConnectionsWithProvider, saveTokens } = await import("../../lib/mcp/index.ts");
const { findOrCreateBySlackId } = await import("../../lib/accounts.ts");
const { and, eq } = await import("drizzle-orm");

const { mcpConnections } = tables;

describe.skipIf(!enabled)("mcp token encryption", () => {
  let userId: string;
  const stored = async () =>
    (
      await db
        .select()
        .from(mcpConnections)
        .where(and(eq(mcpConnections.userId, userId), eq(mcpConnections.provider, "firmowid")))
    )[0];

  beforeAll(async () => {
    userId = (await findOrCreateBySlackId(`U${randomUUID().slice(0, 10)}`, `D${randomUUID().slice(0, 10)}`)).id;
    await db.insert(mcpConnections).values({ userId, provider: "firmowid", accessToken: "legacy-access", refreshToken: "legacy-refresh" });
  });

  afterAll(async () => {
    await db.delete(mcpConnections).where(eq(mcpConnections.userId, userId));
  });

  it("keeps reading legacy plaintext tokens without rewriting them", async () => {
    expect(await getConnection(userId, "firmowid")).toMatchObject({ accessToken: "legacy-access", refreshToken: "legacy-refresh" });
    expect((await stored()).accessToken).toBe("legacy-access");
  });

  it("encrypts legacy tokens during the hourly sweep and still returns them", async () => {
    await listAllConnectionsWithProvider();
    const row = await stored();
    expect(row.accessToken).toBeNull();
    expect(row.refreshToken).toBeNull();
    expect(row.accessTokenEncrypted?.toString("utf8")).not.toContain("legacy-access");
    expect(await getConnection(userId, "firmowid")).toMatchObject({ accessToken: "legacy-access", refreshToken: "legacy-refresh" });
  });

  it("stores new tokens only encrypted", async () => {
    const saved = await saveTokens(userId, "firmowid", { accessToken: "new-access", refreshToken: "new-refresh" });
    expect(saved).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
    const row = await stored();
    expect(row.accessToken).toBeNull();
    expect(row.refreshTokenEncrypted?.toString("utf8")).not.toContain("new-refresh");
  });
});
