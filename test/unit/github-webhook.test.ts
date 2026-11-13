import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "../../lib/github/oauth.ts";
import { fromApiCommit } from "../../lib/github/sync.ts";
import { isTruncatedPush, type PushPayload, pushBranch, pushCommits } from "../../lib/github/webhook.ts";

const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const push = (count: number, before = "a".repeat(40)): PushPayload => ({
  ref: "refs/heads/feat/x",
  before,
  after: "b".repeat(40),
  installation: { id: 1 },
  repository: { id: 2, full_name: "acme/app", private: true },
  commits: Array.from({ length: count }, (_, index) => ({
    id: `sha${index}`,
    message: `commit ${index}`,
    timestamp: "2026-11-13T10:00:00+01:00",
    url: `https://github.com/acme/app/commit/sha${index}`,
    author: { name: "Ann", email: "Ann@Example.com", username: "ann" },
  })),
});

describe("GitHub webhook signature", () => {
  it("accepts a valid signature and rejects tampered or missing ones", () => {
    const body = JSON.stringify({ zen: "hi" });
    expect(verifyWebhookSignature("secret", body, sign("secret", body))).toBe(true);
    expect(verifyWebhookSignature("secret", `${body} `, sign("secret", body))).toBe(false);
    expect(verifyWebhookSignature("other", body, sign("secret", body))).toBe(false);
    expect(verifyWebhookSignature("secret", body, null)).toBe(false);
    expect(verifyWebhookSignature("secret", body, "sha1=abc")).toBe(false);
  });
});

describe("GitHub push parsing", () => {
  it("reads branches and skips tags", () => {
    expect(pushBranch("refs/heads/feat/x")).toBe("feat/x");
    expect(pushBranch("refs/tags/v1")).toBeNull();
  });

  it("maps commits with lowercased emails and UTC times", () => {
    const [commit] = pushCommits(push(1));
    expect(commit).toMatchObject({ sha: "sha0", authorLogin: "ann", authorEmail: "ann@example.com", authorName: "Ann" });
    expect(commit.authoredAt.toISOString()).toBe("2026-11-13T09:00:00.000Z");
  });

  it("flags pushes GitHub truncated, except new branches", () => {
    expect(isTruncatedPush(push(20))).toBe(false);
    expect(isTruncatedPush(push(2047))).toBe(false);
    expect(isTruncatedPush(push(2048))).toBe(true);
    expect(isTruncatedPush(push(2048, "0".repeat(40)))).toBe(false);
  });

  it("maps API commits without a linked GitHub user", () => {
    const commit = fromApiCommit({
      sha: "abc",
      html_url: "https://github.com/acme/app/commit/abc",
      author: null,
      commit: { message: "fix", author: { name: "Bob", email: "BOB@x.dev", date: "2026-11-12T08:00:00Z" } },
    });
    expect(commit).toMatchObject({ sha: "abc", authorLogin: null, authorEmail: "bob@x.dev", authorName: "Bob" });
  });
});
