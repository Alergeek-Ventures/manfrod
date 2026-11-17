import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SELF_REVIEW_CHANNEL_ID = "C_SELF_REVIEW";

const SKILL_PATH = "agent/skills/desk-booking/SKILL.md";
const SKILL = "---\nname: desk-booking\ndescription: Book desks\n---\n\n# Desk booking\n";

const state = vi.hoisted(() => ({
  heads: [] as string[],
  merges: [] as { number: number; sha: string }[],
  mergeResult: { ok: true, sha: "squash123" } as { ok: true; sha: string } | { ok: false; status: number; message: string },
  decisions: [] as { decision: string; headSha: string; reason: string | null; mergeSha?: string | null }[],
  posts: [] as { channel: string; text: string }[],
  review: { pass: true, reasons: [] as string[] },
  enabled: true,
  ready: [] as string[],
}));

vi.mock("../../lib/github.ts", () => ({
  getPull: async (number: number) => ({
    number,
    nodeId: "node",
    state: "open",
    draft: true,
    merged: false,
    url: `https://github.com/org/repo/pull/${number}`,
    title: "fix(skills): confirm desk",
    branch: "manfrod/self-modify/abc",
    headSha: state.heads.length > 1 ? state.heads.shift()! : state.heads[0],
  }),
  compareCommits: async () => ({
    status: "ahead",
    mergeBaseSha: "base",
    files: [{ path: SKILL_PATH, status: "modified", changes: 2, patch: "@@", previousPath: null }],
  }),
  branchSha: async () => "main",
  fileAt: async (_path: string, ref: string) => (ref === "base" || ref === "main" ? SKILL : `${SKILL}Confirm first.\n`),
  checkRuns: async () => [{ id: 1, name: "test", status: "completed", conclusion: "success", url: "" }],
  markReadyForReview: async (nodeId: string) => {
    state.ready.push(nodeId);
  },
  squashMerge: async (number: number, sha: string) => {
    state.merges.push({ number, sha });
    return state.mergeResult;
  },
}));

vi.mock("../../lib/self-modify-merge/store.ts", () => ({
  decided: async () => false,
  recordDecision: async (input: (typeof state.decisions)[number]) => {
    state.decisions.push(input);
  },
  mergedSince: async () => [],
  lastThread: async () => null,
  awaitingDeploy: async () => [],
  markLive: async () => undefined,
}));

vi.mock("../../lib/self-modify-merge/review.ts", () => ({
  JUDGES: {},
  securityReview: async () => state.review,
}));

vi.mock("../../lib/self-modify-merge/settings.ts", () => ({ autoMergeEnabled: async () => state.enabled }));
vi.mock("../../lib/self-modify-pulls.ts", () => ({
  isProposal: (pull: { branch: string }) => pull.branch.startsWith("manfrod/self-modify/"),
  recordedOpenPulls: async () => [42],
}));
vi.mock("../../lib/self-review/store.ts", () => ({
  findingForPull: async () => null,
  linkedCases: async () => [],
  selfReviewUserId: async () => "self-review",
}));
vi.mock("../../lib/slack/api.ts", () => ({
  post: async (_endpoint: string, body: { channel: string; text: string }) => {
    state.posts.push(body);
    return { ok: true, body: { ts: "1.0" } };
  },
}));

const { processPull, runAutoMerge } = await import("../../lib/self-modify-merge/index.ts");

beforeEach(() => {
  state.heads = ["head1"];
  state.merges = [];
  state.decisions = [];
  state.posts = [];
  state.ready = [];
  state.review = { pass: true, reasons: [] };
  state.mergeResult = { ok: true, sha: "squash123" };
  state.enabled = true;
});

describe("auto-merge", () => {
  it("squash-merges the reviewed head SHA and reports it in the self-review channel", async () => {
    expect(await processPull(42)).toBe("merged");
    expect(state.ready).toEqual(["node"]);
    expect(state.merges).toEqual([{ number: 42, sha: "head1" }]);
    expect(state.decisions).toMatchObject([{ decision: "merged", headSha: "head1", mergeSha: "squash123" }]);
    expect(state.posts[0].channel).toBe("C_SELF_REVIEW");
    expect(state.posts[0].text).toContain("squash123".slice(0, 7));
  });

  it("does not merge when a new commit lands during the review", async () => {
    state.heads = ["head1", "head2"];
    expect(await processPull(42)).toBe("waiting");
    expect(state.merges).toEqual([]);
    expect(state.decisions).toEqual([]);
  });

  it("blocks and posts why when the security review does not pass", async () => {
    state.review = { pass: false, reasons: ["Jev failed: timeout"] };
    expect(await processPull(42)).toBe("blocked");
    expect(state.merges).toEqual([]);
    expect(state.decisions).toMatchObject([{ decision: "blocked", headSha: "head1" }]);
    expect(state.posts[0].text).toContain("Jev failed: timeout");
  });

  it("leaves the pull request open when GitHub refuses the merge", async () => {
    state.mergeResult = { ok: false, status: 405, message: "Repository rule violations found" };
    expect(await processPull(42)).toBe("blocked");
    expect(state.decisions).toMatchObject([{ decision: "blocked", headSha: "head1" }]);
    expect(state.posts[0].text).toContain("HTTP 405");
  });

  it("does nothing while the kill switch is off", async () => {
    state.enabled = false;
    expect((await runAutoMerge()).outcomes).toEqual({});
    expect(state.merges).toEqual([]);
    state.enabled = true;
    expect((await runAutoMerge()).outcomes).toEqual({ 42: "merged" });
  });
});
