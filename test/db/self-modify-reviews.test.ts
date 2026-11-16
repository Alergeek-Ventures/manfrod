import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { latestReview, recordReview, reviewRounds } = await import("../../lib/self-modify-pulls.ts");

describe.skipIf(!enabled)("self-modify reviews", () => {
  it("returns the latest verdict for the exact snapshot and counts rejected versions as rounds", async () => {
    const session = randomUUID();
    await recordReview(session, "hash-1", "request_changes", "high agent/tools/x.ts:10 no access check");
    expect(await latestReview(session, "hash-2")).toBeNull();
    await recordReview(session, "hash-2", "approve", "");
    expect((await latestReview(session, "hash-2"))?.verdict).toBe("approve");
    expect((await latestReview(session, "hash-1"))?.verdict).toBe("request_changes");
    expect(await reviewRounds(session)).toBe(1);
    await recordReview(session, "hash-1", "request_changes", "same snapshot again");
    expect(await reviewRounds(session)).toBe(1);
    await recordReview(session, "hash-3", "request_changes", "another rejected version");
    expect(await reviewRounds(session)).toBe(2);
    expect(await reviewRounds(randomUUID())).toBe(0);
  });
});
