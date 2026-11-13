import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { db, tables } = await import("../../lib/db/index.ts");
const store = await import("../../lib/github/store.ts");
const { eq } = await import("drizzle-orm");

const installationId = 970_000_000 + Math.floor(Math.random() * 1_000_000);

describe.skipIf(!enabled)("GitHub installation reconciliation", () => {
  beforeAll(async () => {
    await store.upsertInstallation({
      id: installationId,
      account: { id: installationId, login: `stale-${installationId}`, type: "Organization" },
      repository_selection: "all",
    });
  });

  afterAll(async () => {
    await db.delete(tables.githubInstallations).where(eq(tables.githubInstallations.id, installationId));
  });

  it("removes stale installations when GitHub returns an empty list", async () => {
    await store.pruneInstallations([]);
    expect((await store.listInstallations()).some((installation) => installation.id === installationId)).toBe(false);
  });
});
