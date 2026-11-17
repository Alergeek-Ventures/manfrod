import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SELF_REVIEW_CHANNEL_ID = "C_SELF_REVIEW";
process.env.GITHUB_REPOSITORY = "org/repo";

const SKILL_PATH = "agent/skills/desk-booking/SKILL.md";
const SKILL = "---\nname: desk-booking\ndescription: Book desks\n---\n\n# Desk booking\n";

type Row = { decision: string; headSha: string; reason: string | null; mergeSha?: string | null; attempts?: number; retryAt?: Date | null };

const state = vi.hoisted(() => ({
  heads: [] as string[],
  pull: {} as Record<string, unknown>,
  files: [] as { path: string; status: string; changes: number; patch: string; previousPath: null }[],
  changedFiles: 1,
  published: { headSha: "head1", reviewVerdict: "approve" } as { headSha: string | null; reviewVerdict: string | null } | null,
  runs: [] as { id: number; name: string; status: string; conclusion: string; url: string; app: string }[],
  merges: [] as { number: number; sha: string }[],
  mergeResult: null as unknown,
  rows: new Map<string, Row>(),
  posts: [] as { channel: string; text: string }[],
  review: { pass: true, transient: false, reasons: [] as string[] },
  enabled: [] as boolean[],
  ready: [] as string[],
  merging: [] as { pullNumber: number; headSha: string; targets: string[]; mergedAt: Date }[],
  appCommit: undefined as string | undefined,
  deploys: [] as {
    id: string;
    pullNumber: number;
    mergeSha: string;
    targets: string[];
    channelId: string | null;
    threadTs: string | null;
  }[],
  live: new Set<string>(),
  taskError: null as Error | null,
  tasks: [] as string[],
}));

vi.mock("../../lib/config.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/config.ts")>();
  const descriptors = Object.getOwnPropertyDescriptors(original.config);
  return {
    ...original,
    config: Object.defineProperties({}, { ...descriptors, appCommit: { get: () => state.appCommit } }),
  };
});
vi.mock("../../lib/tasks/index.ts", () => ({
  createTask: async (input: { threadTs: string }) => {
    if (state.taskError) throw state.taskError;
    state.tasks.push(input.threadTs);
    return { id: `task-${state.tasks.length}` };
  },
}));
vi.mock("../../lib/memory/access.ts", () => ({ resolveAccess: async () => ({ readableLevels: [], writeAccess: [] }) }));

vi.mock("../../lib/github.ts", () => ({
  getPull: async (number: number) => ({
    number,
    nodeId: "node",
    state: "open",
    draft: true,
    merged: false,
    url: `https://github.com/org/repo/pull/${number}`,
    title: "fix(skills): confirm <desk> & more",
    branch: "manfrod/self-modify/abc",
    headRepository: "org/repo",
    baseRef: "main",
    changedFiles: state.changedFiles,
    mergeCommitSha: null,
    headSha: state.heads.length > 1 ? state.heads.shift()! : state.heads[0],
    ...state.pull,
  }),
  pullFiles: async () => state.files,
  compareCommits: async () => ({ status: "ahead", mergeBaseSha: "base", files: state.files }),
  branchSha: async () => "main",
  fileAt: async (_path: string, ref: string) => (ref === "base" || ref === "main" ? SKILL : `${SKILL}Confirm first.\n`),
  checkRuns: async () => state.runs,
  markReadyForReview: async (nodeId: string) => {
    state.ready.push(nodeId);
  },
  squashMerge: async (number: number, sha: string) => {
    state.merges.push({ number, sha });
    if (state.mergeResult instanceof Error) throw state.mergeResult;
    return state.mergeResult;
  },
}));

vi.mock("../../lib/self-modify-merge/store.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/self-modify-merge/store.ts")>();
  const key = (pullNumber: number, headSha: string) => `${pullNumber}:${headSha}`;
  return {
    MAX_ATTEMPTS: original.MAX_ATTEMPTS,
    settled: original.settled,
    decisionFor: async (pullNumber: number, headSha: string) => state.rows.get(key(pullNumber, headSha)) ?? null,
    recordDecision: async (input: Row & { pullNumber: number }) => {
      state.rows.set(key(input.pullNumber, input.headSha), { ...state.rows.get(key(input.pullNumber, input.headSha)), ...input });
    },
    startMerging: async (pullNumber: number, headSha: string) => {
      state.rows.set(key(pullNumber, headSha), { decision: "merging", headSha, reason: null });
    },
    recordRetry: async (pullNumber: number, headSha: string, reason: string, _targets: string[], replaceMerging = false) => {
      if (state.rows.get(key(pullNumber, headSha))?.decision === "merging" && !replaceMerging) return null;
      const attempts = (state.rows.get(key(pullNumber, headSha))?.attempts ?? 0) + 1;
      state.rows.set(key(pullNumber, headSha), { decision: "retry", headSha, reason, attempts, retryAt: new Date(Date.now() + 60_000) });
      return attempts;
    },
    mergingRows: async () => state.merging,
    mergedSince: async () => [],
    lastThread: async () => null,
    awaitingDeploy: async () => state.deploys.filter((row) => !state.live.has(row.id)),
    claimLive: async (id: string) => {
      if (state.live.has(id)) return false;
      state.live.add(id);
      return true;
    },
    releaseLive: async (id: string) => {
      state.live.delete(id);
    },
    attachThread: async () => undefined,
    attachVerification: async () => undefined,
  };
});

vi.mock("../../lib/self-modify-merge/review.ts", () => ({ JUDGES: {}, securityReview: async () => state.review }));
vi.mock("../../lib/self-modify-merge/settings.ts", () => ({ autoMergeEnabled: async () => state.enabled.shift() ?? true }));
vi.mock("../../lib/self-modify-pulls.ts", () => ({
  isProposal: (pull: { branch: string }) => pull.branch.startsWith("manfrod/self-modify/"),
  recordedOpenPulls: async () => [42],
  publishedHead: async () => state.published,
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

const { detectLive, processPull, runAutoMerge, settleMerging } = await import("../../lib/self-modify-merge/index.ts");

const row = () => state.rows.get("42:head1");

beforeEach(() => {
  state.heads = ["head1"];
  state.pull = {};
  state.files = [{ path: SKILL_PATH, status: "modified", changes: 2, patch: "@@", previousPath: null }];
  state.changedFiles = 1;
  state.published = { headSha: "head1", reviewVerdict: "approve" };
  state.runs = [{ id: 1, name: "test", status: "completed", conclusion: "success", url: "", app: "github-actions" }];
  state.merges = [];
  state.mergeResult = { ok: true, sha: "squash123" };
  state.rows = new Map();
  state.posts = [];
  state.ready = [];
  state.review = { pass: true, transient: false, reasons: [] };
  state.enabled = [];
  state.merging = [];
  state.appCommit = undefined;
  state.deploys = [];
  state.live = new Set();
  state.taskError = null;
  state.tasks = [];
});

describe("auto-merge", () => {
  it("squash-merges the reviewed head SHA and reports it with the title escaped", async () => {
    expect(await processPull(42)).toBe("merged");
    expect(state.ready).toEqual(["node"]);
    expect(state.merges).toEqual([{ number: 42, sha: "head1" }]);
    expect(row()).toMatchObject({ decision: "merged", mergeSha: "squash123" });
    expect(state.posts[0].channel).toBe("C_SELF_REVIEW");
    expect(state.posts[0].text).toContain("confirm &lt;desk&gt; &amp; more");
  });

  it("does not merge when a new commit lands during the review", async () => {
    state.heads = ["head1", "head2"];
    expect(await processPull(42)).toBe("waiting");
    expect(state.merges).toEqual([]);
    expect(row()).toBeUndefined();
  });

  it("blocks a head that is not the commit self-modify published", async () => {
    state.published = { headSha: "other", reviewVerdict: "approve" };
    expect(await processPull(42)).toBe("blocked");
    expect(state.posts[0].text).toContain("not the one self-modify published");
    state.rows.clear();
    state.published = { headSha: null, reviewVerdict: null };
    expect(await processPull(42)).toBe("blocked");
    expect(state.merges).toEqual([]);
  });

  it("blocks a commit the self-modify reviewer did not approve", async () => {
    state.published = { headSha: "head1", reviewVerdict: "overridden" };
    expect(await processPull(42)).toBe("blocked");
    expect(state.posts[0].text).toContain("did not approve");
    expect(state.merges).toEqual([]);
  });

  it("blocks more than ten files or a file count that doesn't match", async () => {
    state.changedFiles = 2;
    expect(await processPull(42)).toBe("blocked");
    expect(state.posts[0].text).toContain("GitHub listed 1 files but the pull request reports 2");
    state.rows.clear();
    state.files = Array.from({ length: 11 }, (_, index) => ({
      path: `agent/skills/s${index}/SKILL.md`,
      status: "modified",
      changes: 1,
      patch: "@@",
      previousPath: null,
    }));
    state.changedFiles = 11;
    expect(await processPull(42)).toBe("blocked");
    expect(state.posts[1].text).toContain("11 files changed; the limit is 10");
  });

  it("re-reads the kill switch right before merging", async () => {
    state.enabled = [false];
    expect(await processPull(42)).toBe("waiting");
    expect(state.merges).toEqual([]);
  });

  it("refuses a branch from a fork or one that does not target main", async () => {
    state.heads = ["head1", "head1"];
    state.pull = { headRepository: "someone/fork" };
    expect(await processPull(42)).toBe("blocked");
    expect(state.posts[0].text).toContain("another repository");
    state.rows.clear();
    state.pull = { baseRef: "release" };
    expect(await processPull(42)).toBe("blocked");
    expect(state.merges).toEqual([]);
  });

  it("does not merge when CI comes from another app", async () => {
    state.runs = [{ id: 1, name: "test", status: "completed", conclusion: "success", url: "", app: "evil-app" }];
    expect(await processPull(42)).toBe("waiting");
    expect(state.merges).toEqual([]);
  });

  it("blocks with the reasons when a judge rejects the change", async () => {
    state.review = { pass: false, transient: false, reasons: ["Jev: Jev judged the change unsafe"] };
    expect(await processPull(42)).toBe("blocked");
    expect(state.merges).toEqual([]);
    expect(row()).toMatchObject({ decision: "blocked" });
  });

  it("retries a failed judge call with backoff and gives up after three attempts", async () => {
    state.review = { pass: false, transient: true, reasons: ["Jev failed: timeout"] };
    expect(await processPull(42)).toBe("retrying");
    expect(await processPull(42)).toBe("ignored");
    row()!.retryAt = new Date(0);
    expect(await processPull(42)).toBe("retrying");
    row()!.retryAt = new Date(0);
    expect(await processPull(42)).toBe("blocked");
    expect(state.posts).toHaveLength(1);
    expect(state.posts[0].text).toContain("Gave up after 3 attempts");
    expect(state.merges).toEqual([]);
  });

  it("leaves a pending merging row when the merge call times out", async () => {
    state.mergeResult = new Error("The operation was aborted due to timeout");
    expect(await processPull(42)).toBe("waiting");
    expect(row()).toMatchObject({ decision: "merging" });
    expect(await processPull(42)).toBe("ignored");
    expect(state.merges).toHaveLength(1);
  });

  it("leaves a GitHub 5xx on merge to be settled but keeps a merge refusal final", async () => {
    state.mergeResult = { ok: false, status: 502, message: "Bad gateway" };
    expect(await processPull(42)).toBe("waiting");
    expect(row()).toMatchObject({ decision: "merging" });
    expect(state.posts).toEqual([]);
    state.rows.clear();
    state.mergeResult = { ok: false, status: 405, message: "Repository rule violations found" };
    expect(await processPull(42)).toBe("blocked");
    expect(row()).toMatchObject({ decision: "blocked" });
    expect(state.posts[0].text).toContain("GitHub refused the merge (HTTP 405)");
  });

  it("does nothing while the kill switch is off", async () => {
    state.enabled = [false];
    expect((await runAutoMerge()).outcomes).toEqual({});
    expect(state.merges).toEqual([]);
    expect((await runAutoMerge()).outcomes).toEqual({ 42: "merged" });
  });

  it("records and reports a merge that went through although the call did not answer", async () => {
    state.merging = [{ pullNumber: 42, headSha: "head1", targets: ["skill:desk-booking"], mergedAt: new Date() }];
    state.pull = { state: "closed", merged: true, mergeCommitSha: "squash999" };
    expect(await settleMerging()).toBe(1);
    expect(row()).toMatchObject({ decision: "merged", mergeSha: "squash999" });
    expect(state.posts[0].text).toContain("confirmed after the merge call did not answer");
  });

  it("turns a stale pending merge on a still open pull request into a retry", async () => {
    state.merging = [{ pullNumber: 42, headSha: "head1", targets: [], mergedAt: new Date(Date.now() - 20 * 60_000) }];
    expect(await settleMerging()).toBe(1);
    expect(row()).toMatchObject({ decision: "retry", attempts: 1 });
    state.merging = [{ pullNumber: 42, headSha: "head1", targets: [], mergedAt: new Date() }];
    state.rows.clear();
    expect(await settleMerging()).toBe(0);
  });

  it("records a merged pull request without a squash commit as merged, never blocked", async () => {
    state.merging = [{ pullNumber: 42, headSha: "head1", targets: [], mergedAt: new Date(Date.now() - 60 * 60_000) }];
    state.pull = { state: "closed", merged: true, mergeCommitSha: null };
    expect(await settleMerging()).toBe(1);
    expect(row()).toMatchObject({ decision: "merged", mergeSha: null });
    expect(state.posts[0].text).toContain("GitHub did not say which squash commit");
  });

  it("does not turn an in-flight merge into a retry", async () => {
    state.rows.set("42:head1", { decision: "merging", headSha: "head1", reason: null });
    state.review = { pass: false, transient: true, reasons: ["Jev failed: timeout"] };
    const { recordRetry } = await import("../../lib/self-modify-merge/store.ts");
    expect(await recordRetry(42, "head1", "timeout", [])).toBeNull();
    expect(row()).toMatchObject({ decision: "merging" });
  });

  it("releases the live claim when the verification task can't be created, then retries", async () => {
    state.appCommit = "a".repeat(40);
    state.deploys = [{ id: "m1", pullNumber: 42, mergeSha: "squash", targets: ["skill:x"], channelId: "C_SELF_REVIEW", threadTs: "1.0" }];
    state.taskError = new Error("database down");
    expect(await detectLive()).toBe(0);
    expect(state.live.has("m1")).toBe(false);
    expect(state.posts).toEqual([]);
    state.taskError = null;
    expect(await detectLive()).toBe(1);
    expect(state.tasks).toEqual(["1.0"]);
    expect(state.posts).toHaveLength(1);
    expect(await detectLive()).toBe(0);
  });

  it("starts a thread when the merged pull request has none", async () => {
    state.appCommit = "a".repeat(40);
    state.deploys = [{ id: "m2", pullNumber: 42, mergeSha: "squash", targets: ["skill:x"], channelId: null, threadTs: null }];
    expect(await detectLive()).toBe(1);
    expect(state.posts[0]).toMatchObject({ channel: "C_SELF_REVIEW" });
    expect(state.tasks).toEqual(["1.0"]);
  });
});
