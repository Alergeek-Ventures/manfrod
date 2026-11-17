import { afterAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { db, tables } = await import("../../lib/db/index.ts");
const store = await import("../../lib/self-modify-merge/store.ts");
const rehearsals = await import("../../lib/rehearsal/store.ts");
const { targetFor } = await import("../../lib/rehearsal/scenarios.ts");
const { reopenFinding } = await import("../../lib/self-review/store.ts");
const { recordPull } = await import("../../lib/self-modify-pulls.ts");
const { findOrCreateBySlackId } = await import("../../lib/accounts.ts");
const { eq, inArray } = await import("drizzle-orm");

const pullNumber = 800_000 + Math.floor(Math.random() * 99_999);
const tag = `t${pullNumber}`;
const findingPull = pullNumber + 100_000;
const requestPull = pullNumber + 200_000;
const describedPull = pullNumber + 300_000;
const created: { findings: string[]; requests: string[]; merges: string[]; users: string[] } = {
  findings: [],
  requests: [],
  merges: [],
  users: [],
};

describe.skipIf(!enabled)("self-modify auto-merge store", () => {
  afterAll(async () => {
    await db.delete(tables.selfModifyMerges).where(eq(tables.selfModifyMerges.pullNumber, pullNumber));
    await db
      .delete(tables.selfModifyRehearsals)
      .where(
        inArray(tables.selfModifyRehearsals.mergeId, created.merges.length ? created.merges : ["00000000-0000-0000-0000-000000000000"]),
      );
    if (created.findings.length) await db.delete(tables.selfReviewFindings).where(inArray(tables.selfReviewFindings.id, created.findings));
    if (created.requests.length) await db.delete(tables.capabilityRequests).where(inArray(tables.capabilityRequests.id, created.requests));
    await db.delete(tables.selfModifyPulls).where(eq(tables.selfModifyPulls.pullNumber, describedPull));
  });

  it("records one decision per head SHA and counts recent and pending merges", async () => {
    expect(await store.decisionFor(pullNumber, "head1")).toBeNull();
    await store.recordDecision({ pullNumber, headSha: "head1", decision: "blocked", reason: "CI failed", targets: [] });
    expect(store.settled(await store.decisionFor(pullNumber, "head1"))).toBe(true);
    const since = new Date(Date.now() - 60_000);
    const before = (await store.mergedSince(since)).length;
    await store.startMerging(pullNumber, "head2", [`skill:desk-${tag}`]);
    expect((await store.mergedSince(since)).length).toBe(before + 1);
    expect((await store.mergingRows()).some((row) => row.pullNumber === pullNumber && row.headSha === "head2")).toBe(true);
    await store.recordDecision({
      pullNumber,
      headSha: "head2",
      decision: "merged",
      reason: null,
      targets: [`skill:desk-${tag}`],
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

  it("stores planned rehearsals, runs them once live and clears old transcripts", async () => {
    await store.recordDecision({ pullNumber, headSha: "head6", decision: "merged", reason: null, targets: [], mergeSha: "squash6" });
    const merge = (await store.decisionFor(pullNumber, "head6"))!;
    created.merges.push(merge.id);
    const userId = "00000000-0000-4000-8000-000000000001";
    await rehearsals.insertPlanned(merge.id, [
      { userId, channelId: "C1", evidenceLink: "https://slack.example/1", scenario: { history: [], message: "book a desk" } },
    ]);
    expect((await rehearsals.pendingLive()).some((row) => row.mergeId === merge.id)).toBe(false);
    await store.claimLive(merge.id);
    const [pending] = (await rehearsals.pendingLive()).filter((row) => row.mergeId === merge.id);
    expect(pending.scenario).toEqual({ history: [], message: "book a desk" });
    await rehearsals.markRunning(pending.id, "session-1");
    expect((await rehearsals.running()).some((row) => row.id === pending.id)).toBe(true);
    await rehearsals.finish(pending.id, "done", { finished: "completed", reply: "Which day?", actions: [] }, "fixed", "It asked first.");
    const [done] = await rehearsals.forMerges([merge.id]);
    expect(done).toMatchObject({ status: "done", verdict: "fixed", reason: "It asked first." });
    expect((await store.liveUnjudged()).some((row) => row.id === merge.id)).toBe(true);
    await store.recordVerdict(merge.id, "fixed");
    expect((await store.liveUnjudged()).some((row) => row.id === merge.id)).toBe(false);
    await db
      .update(tables.selfModifyRehearsals)
      .set({ insertedAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(eq(tables.selfModifyRehearsals.id, pending.id));
    expect(await rehearsals.clearTranscriptsOlderThan(7)).toBeGreaterThanOrEqual(1);
    const [cleared] = await rehearsals.forMerges([merge.id]);
    expect(cleared).toMatchObject({ scenario: null, transcript: null, verdict: "fixed", reason: "It asked first." });
  });

  it("finds what a merge was meant to fix for self-review findings and admin requests", async () => {
    const [finding] = await db
      .insert(tables.selfReviewFindings)
      .values({
        title: `Desk ${tag}`,
        problem: "Booked without asking",
        expected: "Asks first",
        category: "skill",
        status: "merged",
        pullNumber: findingPull,
      })
      .returning();
    created.findings.push(finding.id);
    expect(await targetFor(findingPull, "fix(skills): ask first")).toEqual({
      source: "finding",
      title: `Desk ${tag}`,
      problem: "Booked without asking",
      expected: "Asks first",
      findingId: finding.id,
    });
    const requester = await findOrCreateBySlackId(`U${tag}`, `D${tag}`);
    const [request] = await db
      .insert(tables.capabilityRequests)
      .values({
        requestedByUserId: requester.id,
        title: "Polish replies",
        description: "Answer in Polish",
        reason: "It answered in English",
        channelId: "C1",
        threadTs: "1.0",
        status: "approved",
        pullNumber: requestPull,
      })
      .returning();
    created.requests.push(request.id);
    expect(await targetFor(requestPull, "feat: polish")).toMatchObject({
      source: "request",
      problem: "It answered in English",
      expected: "Answer in Polish",
    });
    await recordPull(describedPull, "manfrod/self-modify/x", "session-x", {
      headSha: "c1",
      reviewVerdict: "approve",
      description: "Confirms the day before booking a desk.",
      requestedByUserId: null,
    });
    expect(await targetFor(describedPull, "fix(skills): confirm day")).toMatchObject({
      source: "description",
      title: "fix(skills): confirm day",
      expected: "Confirms the day before booking a desk.",
    });
    expect(await targetFor(pullNumber + 400_000, "nothing")).toBeNull();
    await reopenFinding(finding.id);
    const [reopened] = await db.select().from(tables.selfReviewFindings).where(eq(tables.selfReviewFindings.id, finding.id));
    expect(reopened).toMatchObject({ status: "open", resolvedAt: null, notifiedAt: null });
  });
});
