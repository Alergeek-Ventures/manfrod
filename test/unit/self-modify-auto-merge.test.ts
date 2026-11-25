import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SELF_REVIEW_CHANNEL_ID = "C_SELF_REVIEW";
process.env.GITHUB_REPOSITORY = "org/repo";

const SKILL_PATH = "agent/skills/desk-booking/SKILL.md";
const SKILL = "---\nname: desk-booking\ndescription: Book desks\n---\n\n# Desk booking\n";

type Row = {
  decision: string;
  headSha: string;
  reason: string | null;
  mergeSha?: string | null;
  attempts?: number;
  retryAt?: Date | null;
  mergedAt?: Date | null;
};

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
  postFails: false,
  rehearsalRuns: 0,
  target: {
    source: "finding",
    title: null as string | null,
    problem: "Booked without asking",
    expected: "Asks first",
    findingId: "f1",
  } as Record<string, unknown>,
  planned: [
    { userId: "person", channelId: "C1", evidenceLink: "https://slack.example/1", scenario: { history: [], message: "book" } },
  ] as unknown[],
  inserted: [] as { mergeId: string; planned: unknown[] }[],
  targets: [] as { id: string; target: Record<string, unknown> }[],
  origin: null as { channelId: string; threadTs: string } | null,
  finding: null as { sessionChannelId: string | null; sessionThreadTs: string | null } | null,
  events: [] as { name: string; data: unknown }[],
  open: [42] as number[],
}));

vi.mock("../../lib/inngest/client.ts", () => ({
  EVENTS: { selfModifyPullChanged: "manfrod/self-modify.pull.changed" },
  sendEvent: async (name: string, data: unknown) => {
    state.events.push({ name, data });
    return true;
  },
}));

vi.mock("../../lib/config.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/config.ts")>();
  const descriptors = Object.getOwnPropertyDescriptors(original.config);
  return {
    ...original,
    config: Object.defineProperties({}, { ...descriptors, appCommit: { get: () => state.appCommit } }),
  };
});
vi.mock("../../lib/rehearsal/index.ts", () => ({
  runRehearsals: async () => {
    state.rehearsalRuns += 1;
    return { started: 0, finished: 0, settled: 0 };
  },
}));
vi.mock("../../lib/rehearsal/scenarios.ts", () => ({
  targetFor: async (pullNumber: number, title: string) => ({ ...state.target, title: state.target.title ?? title, pullNumber }),
  planRehearsals: async () => state.planned,
}));
vi.mock("../../lib/rehearsal/store.ts", () => ({
  insertPlanned: async (mergeId: string, planned: unknown[]) => {
    state.inserted.push({ mergeId, planned });
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
      state.rows.set(key(pullNumber, headSha), { decision: "merging", headSha, reason: null, mergedAt: new Date() });
    },
    recordRetry: async (pullNumber: number, headSha: string, reason: string, _targets: string[], replaceMerging = false) => {
      if (state.rows.get(key(pullNumber, headSha))?.decision === "merging" && !replaceMerging) return null;
      const attempts = (state.rows.get(key(pullNumber, headSha))?.attempts ?? 0) + 1;
      state.rows.set(key(pullNumber, headSha), { decision: "retry", headSha, reason, attempts, retryAt: new Date(Date.now() + 60_000) });
      return attempts;
    },
    mergingRows: async () => state.merging,
    mergedPull: async (pullNumber: number) =>
      [...state.rows.values()].find((entry) => entry.decision === "merged") ? { pullNumber } : null,
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
    recordTarget: async (id: string, target: Record<string, unknown>) => {
      state.targets.push({ id, target });
    },
  };
});

vi.mock("../../lib/self-modify-merge/review.ts", () => ({ JUDGES: {}, securityReview: async () => state.review }));
vi.mock("../../lib/self-modify-merge/settings.ts", () => ({ autoMergeEnabled: async () => state.enabled.shift() ?? true }));
vi.mock("../../lib/self-modify-pulls.ts", () => ({
  isProposal: (pull: { branch: string }) => pull.branch.startsWith("manfrod/self-modify/"),
  recordedOpenPulls: async () => state.open,
  publishedHead: async () => state.published,
  pullOrigin: async () => state.origin,
}));
vi.mock("../../lib/self-review/store.ts", () => ({
  findingForPull: async () => state.finding,
  linkedCases: async () => [],
  selfReviewUserId: async () => "self-review",
}));
vi.mock("../../lib/slack/api.ts", () => ({
  post: async (_endpoint: string, body: { channel: string; text: string }) => {
    if (state.postFails) return { ok: false, error: "channel_not_found" };
    state.posts.push(body);
    return { ok: true, body: { ts: "1.0" } };
  },
}));

const { detectLive, pickThread, processPull, runPull, settleMerging, sweepAutoMerge } =
  await import("../../lib/self-modify-merge/index.ts");
const { autoMergeStatus, publishOutlook } = await import("../../lib/self-modify-merge/status.ts");
const { outlookText, preCheck } = await import("../../lib/self-modify-merge/outlook.ts");

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
  state.postFails = false;
  state.rehearsalRuns = 0;
  state.inserted = [];
  state.targets = [];
  state.target = { source: "finding", title: null, problem: "Booked without asking", expected: "Asks first", findingId: "f1" };
  state.origin = null;
  state.finding = null;
  state.events = [];
  state.open = [42];
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
    expect(await runPull(42, "webhook")).toEqual({ outcome: "waiting", settled: 0, next: null });
    expect(state.merges).toEqual([]);
    expect((await runPull(42, "webhook")).outcome).toBe("merged");
  });

  it("waits instead of blocking a head self-modify has not recorded yet when a webhook triggers it", async () => {
    state.published = null;
    expect((await runPull(42, "webhook")).outcome).toBe("waiting");
    expect(row()).toBeUndefined();
    expect(state.posts).toEqual([]);
    state.published = { headSha: "other", reviewVerdict: "approve" };
    expect((await runPull(42, "published")).outcome).toBe("waiting");
    expect(row()).toBeUndefined();
    expect((await runPull(42, "sweep")).outcome).toBe("blocked");
    expect(state.merges).toEqual([]);
  });

  it("leaves failed CI to the sweep so a fix in progress is not reported as blocked", async () => {
    state.runs = [{ id: 1, name: "test", status: "completed", conclusion: "failure", url: "", app: "github-actions" }];
    expect((await runPull(42, "webhook")).outcome).toBe("waiting");
    expect(state.posts).toEqual([]);
    expect(row()).toBeUndefined();
    expect((await runPull(42, "sweep")).outcome).toBe("blocked");
    expect(state.posts[0].text).toContain("CI did not pass on this commit");
    expect(state.merges).toEqual([]);
  });

  it("asks to run again at the retry time after a failed judge call", async () => {
    state.review = { pass: false, transient: true, reasons: ["Jev failed: timeout"] };
    const run = await runPull(42, "webhook");
    expect(run.outcome).toBe("retrying");
    expect(run.next).toBe(row()!.retryAt!.toISOString());
  });

  it("asks to settle an unanswered merge after the merge timeout", async () => {
    state.mergeResult = new Error("timeout");
    const run = await runPull(42, "webhook");
    expect(run.outcome).toBe("waiting");
    expect(new Date(run.next!).getTime()).toBeGreaterThan(Date.now() + 15 * 60_000);
  });

  it("settles only the pull request it runs for", async () => {
    state.merging = [{ pullNumber: 7, headSha: "head1", targets: [], mergedAt: new Date() }];
    state.pull = { state: "closed", merged: true, mergeCommitSha: "squash" };
    expect((await runPull(42, "webhook")).settled).toBe(0);
    expect(state.posts).toEqual([]);
  });

  it("sweeps open pull requests and merges in flight through events", async () => {
    state.open = [42, 43];
    state.merging = [{ pullNumber: 7, headSha: "head1", targets: [], mergedAt: new Date() }];
    expect(await sweepAutoMerge()).toEqual({ requested: 3 });
    expect(state.events.map((event) => event.data)).toEqual([
      { pullNumber: 7, source: "sweep" },
      { pullNumber: 42, source: "sweep" },
      { pullNumber: 43, source: "sweep" },
    ]);
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

  it("releases the live claim when the announcement can't be posted, then retries", async () => {
    state.appCommit = "a".repeat(40);
    state.deploys = [{ id: "m1", pullNumber: 42, mergeSha: "squash", targets: ["skill:x"], channelId: "C_SELF_REVIEW", threadTs: "1.0" }];
    state.postFails = true;
    expect(await detectLive()).toBe(0);
    expect(state.live.has("m1")).toBe(false);
    state.postFails = false;
    expect(await detectLive()).toBe(1);
    expect(state.posts[0]).toMatchObject({ channel: "C_SELF_REVIEW", thread_ts: "1.0" });
    expect(state.posts[0].text).toContain("replaying the scenario");
    expect(await detectLive()).toBe(0);
  });

  it("starts a thread when the merged pull request has none", async () => {
    state.appCommit = "a".repeat(40);
    state.deploys = [{ id: "m2", pullNumber: 42, mergeSha: "squash", targets: ["skill:x"], channelId: null, threadTs: null }];
    expect(await detectLive()).toBe(1);
    expect(state.posts[0]).toMatchObject({ channel: "C_SELF_REVIEW" });
    expect(state.posts[0]).not.toHaveProperty("thread_ts");
  });

  it("stores the target and the planned scenarios when it merges", async () => {
    state.rows.set("42:head1", { decision: "merging", headSha: "head1", reason: null });
    expect(await processPull(42)).toBe("ignored");
    state.rows.clear();
    expect(await processPull(42)).toBe("merged");
    expect(state.targets).toHaveLength(1);
    expect(state.targets[0].target).toMatchObject({ source: "finding", problem: "Booked without asking", findingId: "f1" });
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0].planned).toEqual(state.planned);
  });

  it("stores an admin request as the target too", async () => {
    state.target = {
      source: "request",
      title: "Answer in Polish",
      problem: "Answered in English",
      expected: "Answers in Polish",
      findingId: null,
    };
    expect(await processPull(42)).toBe("merged");
    expect(state.targets[0].target).toMatchObject({ source: "request", expected: "Answers in Polish", findingId: null });
  });
});

describe("where the outcome is posted", () => {
  it("prefers the finding's thread, then the request's thread, then an earlier post, then the eval channel", () => {
    const origin = { channelId: "D_ADMIN", threadTs: "5.0" };
    const earlier = { channelId: "C_SELF_REVIEW", threadTs: "1.0" };
    const finding = { sessionChannelId: "C_TEAM", sessionThreadTs: "2.0" };
    expect(pickThread({ finding, origin, earlier, fallbackChannelId: "C" })).toEqual({ channelId: "C_TEAM", threadTs: "2.0" });
    const unthreaded = { sessionChannelId: null, sessionThreadTs: null };
    expect(pickThread({ finding: unthreaded, origin, earlier, fallbackChannelId: "C" })).toEqual(origin);
    expect(pickThread({ finding: null, origin: null, earlier, fallbackChannelId: "C" })).toEqual(earlier);
    expect(pickThread({ finding: null, origin: null, earlier: null, fallbackChannelId: "C" })).toEqual({ channelId: "C", threadTs: null });
  });

  it("posts the decision in the thread the admin asked in, and the deploy check follows it", async () => {
    state.origin = { channelId: "D_ADMIN", threadTs: "5.0" };
    expect(await processPull(42)).toBe("merged");
    expect(state.posts[0]).toMatchObject({ channel: "D_ADMIN", thread_ts: "5.0" });
    expect(row()).toMatchObject({ channelId: "D_ADMIN", threadTs: "5.0" });
  });

  it("keeps self-review pull requests in the finding's thread", async () => {
    state.origin = { channelId: "D_ADMIN", threadTs: "5.0" };
    state.finding = { sessionChannelId: "C_TEAM", sessionThreadTs: "2.0" };
    state.review = { pass: false, transient: false, reasons: ["Jev: unsafe"] };
    expect(await processPull(42)).toBe("blocked");
    expect(state.posts[0]).toMatchObject({ channel: "C_TEAM", thread_ts: "2.0" });
  });

  it("falls back to the eval channel when the origin is unknown", async () => {
    expect(await processPull(42)).toBe("merged");
    expect(state.posts[0].channel).toBe("C_SELF_REVIEW");
    expect(state.posts[0]).not.toHaveProperty("thread_ts");
  });
});

describe("auto-merge outlook", () => {
  it("tells at publish time that an approved skill edit merges on its own", async () => {
    const view = await publishOutlook(42, "head1");
    expect(view).toEqual({ status: "qualifies", targets: ["skill:desk-booking"] });
    expect(outlookText(view)).toContain("Will merge on its own once CI is green and the security review passes");
  });

  it("gives the same reasons as the evaluation that blocks it", async () => {
    state.files = [
      { path: SKILL_PATH, status: "modified", changes: 2, patch: "@@", previousPath: null },
      { path: "agent/routines/proactive-style/ROUTINE.md", status: "modified", changes: 2, patch: "@@", previousPath: null },
    ];
    state.changedFiles = 2;
    const view = await publishOutlook(42, "head1");
    expect(view.status).toBe("blocked");
    expect(outlookText(view)).toContain("never merges on its own");
    expect(await processPull(42)).toBe("blocked");
    expect(row()!.reason).toBe(view.status === "blocked" ? view.reasons.join("\n") : null);
  });

  it("says a code change or an unapproved commit needs a person", async () => {
    state.files = [{ path: "lib/desks.ts", status: "modified", changes: 2, patch: "@@", previousPath: null }];
    expect(outlookText(await publishOutlook(42, "head1"))).toContain("Won't auto-merge");
    state.files = [{ path: SKILL_PATH, status: "modified", changes: 2, patch: "@@", previousPath: null }];
    state.published = { headSha: "head1", reviewVerdict: "overridden" };
    expect(outlookText(await publishOutlook(42, "head1"))).toContain("did not approve");
  });

  it("names the kill switch", async () => {
    state.enabled = [false];
    expect(outlookText(await publishOutlook(42, "head1"))).toContain("switched off");
  });

  it("checks the published commit even before GitHub moves the pull request's head", async () => {
    state.heads = ["old"];
    expect((await publishOutlook(42, "head1")).status).toBe("qualifies");
  });

  it("shares its gate with the evaluation", () => {
    const pull = { headSha: "h", baseRef: "main", branch: "manfrod/self-modify/x", headRepository: "org/repo" };
    expect(preCheck({ pull, published: null, files: [], versions: new Map() })).toEqual({ verdict: "code" });
    const files = [{ path: SKILL_PATH, status: "modified", changes: 1, patch: "@@", previousPath: null }];
    const published = { headSha: "h", reviewVerdict: "approve" };
    expect(preCheck({ pull, published, files, versions: new Map(), listed: ["mismatch"] })).toEqual({
      verdict: "blocked",
      reasons: ["mismatch"],
    });
  });
});

describe("auto-merge status", () => {
  it("reports waiting for CI, blocked, merged and refuses other branches", async () => {
    state.runs = [{ id: 1, name: "test", status: "in_progress", conclusion: "", url: "", app: "github-actions" }];
    expect(await autoMergeStatus(42)).toContain("qualifies, waiting for CI");
    state.rows.set("42:head1", { decision: "blocked", headSha: "head1", reason: "CI did not pass on this commit" });
    expect(await autoMergeStatus(42)).toContain("Won't auto-merge, a person has to review and merge it:\n- CI did not pass");
    state.rows.set("42:head1", { decision: "merged", headSha: "head1", reason: null });
    state.pull = { state: "closed", merged: true };
    expect(await autoMergeStatus(42)).toContain("merged automatically");
    state.pull = { branch: "feature/x" };
    expect(await autoMergeStatus(42)).toBe("#42 is not a self-modify pull request.");
  });
});
