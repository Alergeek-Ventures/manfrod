import { afterAll, describe, expect, it, vi } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const killed: string[] = [];
vi.mock("../../lib/sandboxes.ts", () => ({
  killSessionSandboxes: async (sessionId: string) => {
    killed.push(sessionId);
    return 1;
  },
  killStaleSandboxes: async () => 0,
}));

const { db, tables } = await import("../../lib/db/index.ts");
const { recordPull } = await import("../../lib/self-modify-pulls.ts");
const { eq } = await import("drizzle-orm");

describe.skipIf(!enabled)("recordPull", () => {
  const pullNumber = 900_000 + Math.floor(Math.random() * 99_999);

  afterAll(async () => {
    await db.delete(tables.selfModifyPulls).where(eq(tables.selfModifyPulls.pullNumber, pullNumber));
  });

  it("stops the earlier session's sandbox when another session takes the pull request over", async () => {
    await recordPull(pullNumber, "manfrod/self-modify/abc", "session-1");
    await recordPull(pullNumber, "manfrod/self-modify/abc", "session-1");
    expect(killed).toEqual([]);
    await recordPull(pullNumber, "manfrod/self-modify/abc", "session-2");
    expect(killed).toEqual(["session-1"]);
    const [row] = await db.select().from(tables.selfModifyPulls).where(eq(tables.selfModifyPulls.pullNumber, pullNumber));
    expect(row.sessionId).toBe("session-2");
  });
});
