import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { db, tables } = await import("../../lib/db/index.ts");
const { createFinding, getFinding, insertCase, linkedCases, mergeFindings, ratersOf, resolveFinding } =
  await import("../../lib/self-review/store.ts");
const { hasEnoughEvidence } = await import("../../lib/self-review/rules.ts");
const { eq, inArray } = await import("drizzle-orm");

const tag = randomUUID().slice(0, 8);

describe.skipIf(!enabled)("merging duplicate findings", () => {
  const findingIds: string[] = [];
  const feedbackIds: string[] = [];

  afterAll(async () => {
    await db.delete(tables.selfReviewCases).where(inArray(tables.selfReviewCases.feedbackId, feedbackIds));
    await db.delete(tables.messageFeedback).where(inArray(tables.messageFeedback.id, feedbackIds));
    await db.delete(tables.selfReviewFindings).where(inArray(tables.selfReviewFindings.id, findingIds));
  });

  const finding = async (title: string, severity = 2) => {
    const created = await createFinding({ title, problem: "p", expected: "e", summary: "s", category: "prompt", severity });
    findingIds.push(created.id);
    return created;
  };

  const rated = async (findingId: string, rater: string) => {
    const [feedback] = await db
      .insert(tables.messageFeedback)
      .values({
        slackUserId: `U${tag}${rater}`,
        slackChannelId: `C${tag}`,
        messageTs: `${Date.now()}.${randomUUID().slice(0, 6)}`,
        rating: "bad",
      })
      .returning();
    feedbackIds.push(feedback.id);
    await insertCase(feedback.id, { status: "linked", findingId, reason: "r" });
  };

  it("moves the cases onto the kept finding, dismisses the duplicates and pools their raters", async () => {
    const keep = await finding("Denies having a tool", 1);
    const duplicate = await finding("Offers actions it cannot perform", 3);
    await rated(keep.id, "a");
    await rated(duplicate.id, "b");
    expect(hasEnoughEvidence(ratersOf(await linkedCases([keep.id])))).toBe(false);

    const rewrite = { title: "States its capabilities without checking its tools", problem: "p2", expected: "e2", summary: "s2" };
    expect(await mergeFindings({ keepId: keep.id, mergeIds: [duplicate.id], severity: 3, rewrite })).toEqual([duplicate.id]);

    expect(await getFinding(keep.id)).toMatchObject({ ...rewrite, status: "open", severity: 3 });
    expect(await getFinding(duplicate.id)).toMatchObject({ status: "dismissed" });
    const cases = await linkedCases([keep.id]);
    expect(cases).toHaveLength(2);
    expect(hasEnoughEvidence(ratersOf(cases))).toBe(true);
  });

  it("does not merge away a finding that is no longer open, nor into a resolved one", async () => {
    const keep = await finding("Kept");
    const proposed = await finding("Being fixed");
    await db.update(tables.selfReviewFindings).set({ status: "proposed" }).where(eq(tables.selfReviewFindings.id, proposed.id));
    expect(await mergeFindings({ keepId: keep.id, mergeIds: [proposed.id], severity: 2, rewrite: null })).toEqual([]);
    expect(await getFinding(proposed.id)).toMatchObject({ status: "proposed" });

    const open = await finding("Open duplicate");
    await rated(open.id, "c");
    await resolveFinding(keep.id, "dismissed");
    expect(await mergeFindings({ keepId: keep.id, mergeIds: [open.id], severity: 2, rewrite: null })).toEqual([]);
    expect(await getFinding(open.id)).toMatchObject({ status: "open" });
    expect(await linkedCases([open.id])).toHaveLength(1);
  });

  it("does not let a finding that is being fixed absorb open ones", async () => {
    const proposed = await finding("Being fixed");
    await db.update(tables.selfReviewFindings).set({ status: "proposed" }).where(eq(tables.selfReviewFindings.id, proposed.id));
    const duplicate = await finding("Duplicate");
    await rated(duplicate.id, "d");
    const rewrite = { title: "New", problem: "p3", expected: "e3", summary: null };
    expect(await mergeFindings({ keepId: proposed.id, mergeIds: [duplicate.id], severity: 3, rewrite })).toEqual([]);
    expect(await getFinding(proposed.id)).toMatchObject({ title: "Being fixed", status: "proposed", severity: 2 });
    expect(await getFinding(duplicate.id)).toMatchObject({ status: "open" });
    expect(await linkedCases([proposed.id])).toHaveLength(0);
    expect(await linkedCases([duplicate.id])).toHaveLength(1);
  });
});
