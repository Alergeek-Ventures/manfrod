import { afterAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { db, tables } = await import("../../lib/db/index.ts");
const { findOrCreateBySlackId } = await import("../../lib/accounts.ts");
const { markJudged, sessionsToJudge } = await import("../../lib/self-review/satisfaction.ts");
const { eq, like } = await import("drizzle-orm");

const tag = `S${Math.floor(Math.random() * 1_000_000_000)}`;
const sessionKey = `C${tag}:1.0`;
const hour = 3_600_000;

describe.skipIf(!enabled)("satisfaction judging between scheduled runs", () => {
  afterAll(async () => {
    await db.delete(tables.messages).where(like(tables.messages.sessionKey, `C${tag}:%`));
    await db.delete(tables.selfReviewSessions).where(eq(tables.selfReviewSessions.sessionKey, sessionKey));
  });

  const add = async (userId: string, role: string, at: number) =>
    db.insert(tables.messages).values({ userId, role, content: role, sessionKey, receivedAt: new Date(at) });

  const picked = async (now: number) => (await sessionsToJudge(now, null)).some((row) => row.sessionKey === sessionKey);

  it("judges a conversation once it is quiet, once, and again only after new messages", async () => {
    const person = await findOrCreateBySlackId(`U${tag}`, `D${tag}`);
    const start = Date.now() - 5 * hour;
    await add(person.id, "user", start);
    await add(person.id, "assistant", start + 60_000);
    await add(person.id, "user", start + 120_000);

    expect(await picked(start + 120_000 + 1 * hour)).toBe(false);
    expect(await picked(start + 120_000 + 2 * hour + 60_000)).toBe(true);

    await markJudged(sessionKey, new Date(start + 120_000), "satisfied");
    for (const runs of [2, 4, 6, 8, 10, 22]) expect(await picked(start + runs * hour + 120_000), `${runs} h later`).toBe(false);

    await add(person.id, "user", start + 3 * hour);
    expect(await picked(start + 4 * hour)).toBe(false);
    expect(await picked(start + 5 * hour + 60_000)).toBe(true);
  });

  it("judges a conversation that went quiet on Friday evening at Monday 03:30, once", async () => {
    const weekend = `C${tag}:2.0`;
    const person = await findOrCreateBySlackId(`U${tag}`, `D${tag}`);
    const at = (iso: string) => new Date(iso).getTime();
    await db.insert(tables.messages).values([
      { userId: person.id, role: "user", content: "q", sessionKey: weekend, receivedAt: new Date("2026-11-13T17:00:00Z") },
      { userId: person.id, role: "assistant", content: "a", sessionKey: weekend, receivedAt: new Date("2026-11-13T17:10:00Z") },
      { userId: person.id, role: "user", content: "no", sessionKey: weekend, receivedAt: new Date("2026-11-13T17:30:00Z") },
    ]);
    const found = async (now: number) => (await sessionsToJudge(now, null)).some((row) => row.sessionKey === weekend);
    expect(await found(at("2026-11-13T19:00:00Z"))).toBe(false);
    expect(await found(at("2026-11-16T02:30:00Z"))).toBe(true);
    await markJudged(weekend, new Date("2026-11-13T17:30:00Z"), "unsatisfied");
    expect(await found(at("2026-11-16T07:00:00Z"))).toBe(false);
    await db.delete(tables.selfReviewSessions).where(eq(tables.selfReviewSessions.sessionKey, weekend));
  });
});
