import { afterAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { db, tables } = await import("../../lib/db/index.ts");
const store = await import("../../lib/self-modify-merge/store.ts");
const { usage } = await import("../../lib/self-modify-merge/impact.ts");
const { eq, inArray, sql } = await import("drizzle-orm");

const pullNumber = 800_000 + Math.floor(Math.random() * 99_999);
const tag = `t${pullNumber}`;
const skill = `skill-${tag}`;
const routine = `routine-${tag}`;
const sessionKey = (name: string) => `C${tag}:${name}`;

describe.skipIf(!enabled)("self-modify auto-merge store", () => {
  afterAll(async () => {
    await db.delete(tables.selfModifyMerges).where(eq(tables.selfModifyMerges.pullNumber, pullNumber));
    await db.delete(tables.auditEvents).where(sql`${tables.auditEvents.meta} ->> 'session_key' like ${`C${tag}:%`}`);
    await db.delete(tables.messageFeedback).where(inArray(tables.messageFeedback.slackChannelId, [`C${tag}`]));
  });

  it("records one decision per head SHA and counts recent and pending merges", async () => {
    expect(await store.decisionFor(pullNumber, "head1")).toBeNull();
    await store.recordDecision({ pullNumber, headSha: "head1", decision: "blocked", reason: "CI failed", targets: [] });
    expect(store.settled(await store.decisionFor(pullNumber, "head1"))).toBe(true);
    const since = new Date(Date.now() - 60_000);
    const before = (await store.mergedSince(since)).length;
    await store.startMerging(pullNumber, "head2", [`skill:${skill}`]);
    expect((await store.mergedSince(since)).length).toBe(before + 1);
    expect((await store.mergingRows()).some((row) => row.pullNumber === pullNumber && row.headSha === "head2")).toBe(true);
    await store.recordDecision({
      pullNumber,
      headSha: "head2",
      decision: "merged",
      reason: null,
      targets: [`skill:${skill}`],
      mergeSha: "squash",
      channelId: "C1",
      threadTs: "1.0",
    });
    expect((await store.mergedSince(since)).length).toBe(before + 1);
    expect((await store.mergingRows()).some((row) => row.pullNumber === pullNumber)).toBe(false);
    expect(await store.lastThread(pullNumber)).toEqual({ channelId: "C1", threadTs: "1.0" });
    const merged = await store.mergedPull(pullNumber);
    expect(merged?.headSha).toBe("head2");
    expect((await store.awaitingDeploy()).some((row) => row.pullNumber === pullNumber)).toBe(true);
    expect(await store.claimLive(merged!.id)).toBe(true);
    expect(await store.claimLive(merged!.id)).toBe(false);
    expect((await store.awaitingDeploy()).some((row) => row.pullNumber === pullNumber)).toBe(false);
  });

  it("backs off between retries and counts the attempts", async () => {
    expect(await store.recordRetry(pullNumber, "head3", "timeout", [])).toBe(1);
    const first = await store.decisionFor(pullNumber, "head3");
    expect(first?.decision).toBe("retry");
    expect(store.settled(first)).toBe(true);
    expect(store.settled(first, new Date(Date.now() + 11 * 60_000))).toBe(false);
    expect(await store.recordRetry(pullNumber, "head3", "timeout", [])).toBe(2);
    const second = await store.decisionFor(pullNumber, "head3");
    expect(second!.retryAt!.getTime() - Date.now()).toBeGreaterThan(15 * 60_000);
  });

  it("leaves a merge in flight alone unless settling replaces it", async () => {
    await store.startMerging(pullNumber, "head4", []);
    expect(await store.recordRetry(pullNumber, "head4", "timeout", [])).toBeNull();
    expect((await store.decisionFor(pullNumber, "head4"))?.decision).toBe("merging");
    expect(await store.recordRetry(pullNumber, "head4", "no answer", [], true)).toBe(1);
    expect((await store.decisionFor(pullNumber, "head4"))?.decision).toBe("retry");
  });

  it("releases a live claim so the next run can retry", async () => {
    await store.recordDecision({ pullNumber, headSha: "head5", decision: "merged", reason: null, targets: [], mergeSha: "squash5" });
    const row = (await store.awaitingDeploy()).find((candidate) => candidate.headSha === "head5" && candidate.pullNumber === pullNumber)!;
    expect(await store.claimLive(row.id)).toBe(true);
    await store.releaseLive(row.id);
    expect(await store.claimLive(row.id)).toBe(true);
  });

  it("counts skill loads and routine runs with their negative ratings", async () => {
    const now = Date.now();
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
    await db.insert(tables.auditEvents).values([
      {
        type: "action_started",
        timestamp: at(30),
        meta: { action: "load-skill", args: JSON.stringify({ name: skill }), session_key: sessionKey("a") },
      },
      {
        type: "action_started",
        timestamp: at(20),
        meta: { action: "load-skill", args: JSON.stringify({ name: skill }), session_key: sessionKey("a") },
      },
      {
        type: "action_started",
        timestamp: at(10),
        meta: { action: "load-skill", args: JSON.stringify({ name: `${skill}-other` }), session_key: sessionKey("b") },
      },
      { type: "thinking", timestamp: at(15), meta: { kind: "skill_user", skill_name: routine, session_key: sessionKey("c") } },
      { type: "thinking", timestamp: at(5), meta: { kind: "slack", skill_name: null, session_key: sessionKey("c") } },
    ]);
    await db.insert(tables.messageFeedback).values([
      {
        slackChannelId: `C${tag}`,
        messageTs: "1.1",
        slackUserId: "U1",
        sessionKey: sessionKey("a"),
        rating: "bad",
        permalink: "https://slack/a",
      },
      { slackChannelId: `C${tag}`, messageTs: "1.2", slackUserId: "U2", sessionKey: sessionKey("a"), rating: "good" },
      { slackChannelId: `C${tag}`, messageTs: "1.3", slackUserId: "U1", sessionKey: sessionKey("c"), rating: "inferred_bad" },
    ]);
    const window = { from: at(60), to: new Date(now + 1000) };
    const skillUsage = await usage("skill", skill, window);
    expect(skillUsage.uses).toBe(1);
    expect(skillUsage.negative.map((entry) => entry.permalink)).toEqual(["https://slack/a"]);
    const routineUsage = await usage("routine", routine, window);
    expect(routineUsage.sessions).toBe(1);
    expect(routineUsage.negative.map((entry) => entry.rating)).toEqual(["inferred_bad"]);
    expect((await usage("skill", skill, { from: at(60), to: at(40) })).uses).toBe(0);
  });
});
