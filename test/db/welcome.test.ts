import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { db, tables } = await import("../../lib/db/index.ts");
const { findOrCreateBySlackId } = await import("../../lib/accounts.ts");
const { createMessage } = await import("../../lib/memory/messages.ts");
const store = await import("../../lib/welcome/store.ts");
const { eq, inArray } = await import("drizzle-orm");

const slackIds: string[] = [];
const newSlackId = () => {
  const id = `UW${randomUUID().slice(0, 10).toUpperCase()}`;
  slackIds.push(id);
  return id;
};
const claim = (slackId: string) =>
  store.claimWelcome({ slackId, channelId: "COFFICE", messageTs: "1.1", scheduledFor: new Date(Date.now() + 600_000) });

describe.skipIf(!enabled)("welcome store", () => {
  afterAll(async () => {
    await db.delete(tables.welcomeMessages).where(inArray(tables.welcomeMessages.slackId, slackIds));
  });

  it("lets exactly one of several concurrent messages claim the welcome", async () => {
    const slackId = newSlackId();
    const results = await Promise.all(Array.from({ length: 5 }, () => claim(slackId)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.getWelcome(slackId))?.status).toBe("scheduled");
    expect(await claim(slackId)).toBe(false);
  });

  it("never turns a scheduled or sent welcome into a skip, and releases only scheduled ones", async () => {
    const slackId = newSlackId();
    expect(await claim(slackId)).toBe(true);
    await store.recordSkip(slackId, "known_too_long");
    expect((await store.getWelcome(slackId))?.status).toBe("scheduled");

    const user = await findOrCreateBySlackId(slackId, `D${slackId.slice(1)}`);
    await store.markSent(slackId, user.id);
    await store.markSkipped(slackId, "talked_to_manfrod");
    await store.releaseWelcome(slackId);
    const sent = await store.getWelcome(slackId);
    expect(sent?.status).toBe("sent");
    expect(sent?.userId).toBe(user.id);
    expect(sent?.sentAt).toBeInstanceOf(Date);
    await db.delete(tables.welcomeMessages).where(eq(tables.welcomeMessages.slackId, slackId));
    await db.delete(tables.users).where(eq(tables.users.id, user.id));
  });

  it("frees a released claim for the next message and keeps a recorded skip for good", async () => {
    const released = newSlackId();
    expect(await claim(released)).toBe(true);
    await store.releaseWelcome(released);
    expect(await store.getWelcome(released)).toBeNull();
    expect(await claim(released)).toBe(true);

    const skipped = newSlackId();
    await store.recordSkip(skipped, "posted_before");
    expect(await store.getWelcome(skipped)).toMatchObject({ status: "skipped", reason: "posted_before" });
    expect(await claim(skipped)).toBe(false);
  });

  it("knows who already talked to Manfrod or got a message from it", async () => {
    const quiet = await findOrCreateBySlackId(newSlackId(), "DQUIET");
    const chatty = await findOrCreateBySlackId(newSlackId(), "DCHATTY");
    const messaged = await findOrCreateBySlackId(newSlackId(), "DMESSAGED");
    const nudged = await findOrCreateBySlackId(newSlackId(), "DNUDGED");
    const declined = await findOrCreateBySlackId(newSlackId(), "DDECLINED");
    await createMessage(chatty.id, { role: "user", content: "hej", sessionKey: "DCHATTY:1.1", receivedAt: new Date() });
    await db.insert(tables.sentDms).values({ recipientUserId: messaged.id, channelId: "DMESSAGED", messageTs: "1.1", text: "hej" });
    await db.insert(tables.nudgeDeliveries).values({ userId: nudged.id, kind: "hours", period: "2026-11-24", sent: true });
    await db.insert(tables.nudgeDeliveries).values({ userId: declined.id, kind: "hours", period: "2026-11-24", sent: false });

    expect(await store.talkedToManfrod(quiet.id)).toBe(false);
    expect(await store.talkedToManfrod(chatty.id)).toBe(true);
    expect(await store.talkedToManfrod(messaged.id)).toBe(true);
    expect(await store.talkedToManfrod(nudged.id)).toBe(true);
    expect(await store.talkedToManfrod(declined.id)).toBe(false);

    const ids = [quiet, chatty, messaged, nudged, declined].map((user) => user.id);
    await db.delete(tables.messages).where(inArray(tables.messages.userId, ids));
    await db.delete(tables.sentDms).where(inArray(tables.sentDms.recipientUserId, ids));
    await db.delete(tables.nudgeDeliveries).where(inArray(tables.nudgeDeliveries.userId, ids));
    await db.delete(tables.users).where(inArray(tables.users.id, ids));
  });

  it("turns welcomes off and on from the panel setting", async () => {
    const [before] = await db.select().from(tables.agentSettings).where(eq(tables.agentSettings.key, "welcome.new_members"));
    await store.setWelcomeEnabled(false, null);
    expect(await store.welcomeEnabled()).toBe(false);
    await store.setWelcomeEnabled(true, null);
    expect(await store.welcomeEnabled()).toBe(true);
    if (before) await store.setWelcomeEnabled(before.value !== "off", null);
    else await db.delete(tables.agentSettings).where(eq(tables.agentSettings.key, "welcome.new_members"));
  });
});
