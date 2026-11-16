import { afterAll, describe, expect, it, vi } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const failing = new Set<number>();
vi.mock("../../lib/self-modify-lessons.ts", async (original) => ({
  ...(await original<object>()),
  learnFromPull: async (pullNumber: number) => {
    if (failing.has(pullNumber)) throw new Error("model unavailable");
    return 1;
  },
}));
vi.mock("../../lib/sandboxes.ts", () => ({ killSessionSandboxes: async () => 0, killStaleSandboxes: async () => 0 }));
vi.mock("../../lib/github.ts", async (original) => ({ ...(await original<object>()), deleteBranch: async () => undefined }));

const { db, tables } = await import("../../lib/db/index.ts");
const { cleanUpPull, learnFromClosedPulls, recordPull } = await import("../../lib/self-modify-pulls.ts");
const { eq, inArray } = await import("drizzle-orm");

describe.skipIf(!enabled)("learnFromClosedPulls", () => {
  const base = 700_000 + Math.floor(Math.random() * 90_000);
  const [closedByTool, flaky] = [base, base + 1];

  afterAll(async () => {
    await db.delete(tables.selfModifyPulls).where(inArray(tables.selfModifyPulls.pullNumber, [closedByTool, flaky]));
  });

  const row = async (pullNumber: number) =>
    (await db.select().from(tables.selfModifyPulls).where(eq(tables.selfModifyPulls.pullNumber, pullNumber)))[0];

  it("learns from a pull request closed with close-proposal and retries after a failure", async () => {
    await recordPull(closedByTool, "manfrod/self-modify/a", "session-a");
    await recordPull(flaky, "manfrod/self-modify/b", "session-b");
    await cleanUpPull(closedByTool);
    await cleanUpPull(flaky);
    failing.add(flaky);

    const first = await learnFromClosedPulls();
    expect(first).toContain(closedByTool);
    expect((await row(closedByTool)).learnedAt).not.toBeNull();
    expect((await row(flaky)).learnedAt).toBeNull();
    expect((await row(flaky)).learnAttempts).toBe(1);

    failing.delete(flaky);
    const second = await learnFromClosedPulls();
    expect(second).toContain(flaky);
    expect(second).not.toContain(closedByTool);
  });
});
