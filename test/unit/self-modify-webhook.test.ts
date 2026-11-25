import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.GITHUB_REPOSITORY = "org/repo";

const state = vi.hoisted(() => ({
  events: [] as { name: string; data: unknown }[],
  onBranch: [] as number[],
  branchLookups: [] as string[],
}));

vi.mock("../../lib/inngest/client.ts", () => ({
  EVENTS: { selfModifyPullChanged: "manfrod/self-modify.pull.changed" },
  sendEvent: async (name: string, data: unknown) => {
    state.events.push({ name, data });
    return true;
  },
}));
vi.mock("../../lib/self-modify-pulls.ts", () => ({
  SELF_MODIFY_BRANCH_PREFIX: "manfrod/self-modify/",
  openPullsOnBranch: async (branch: string) => {
    state.branchLookups.push(branch);
    return state.onBranch;
  },
}));
vi.mock("../../lib/github/store.ts", () => ({}));
vi.mock("../../lib/github/sync.ts", () => ({}));

const { handleWebhook, selfModifyTrigger } = await import("../../lib/github/webhook.ts");

const BRANCH = "manfrod/self-modify/abcd1234";
const repository = { full_name: "org/repo" };
const pullRequest = (action: string, branch = BRANCH, headRepo = "org/repo") => ({
  action,
  repository,
  pull_request: { number: 42, head: { ref: branch, sha: "h", repo: { full_name: headRepo } } },
});
const checkSuite = (action: string, branch: string, pulls: { number: number }[] = [{ number: 42 }]) => ({
  action,
  repository,
  check_suite: { head_branch: branch, head_sha: "h", pull_requests: pulls },
});
const checkRun = (branch: string, pulls: { number: number }[] = [{ number: 42 }]) => ({
  action: "completed",
  repository,
  check_run: { head_sha: "h", check_suite: { head_branch: branch }, pull_requests: pulls },
});

beforeEach(() => {
  state.events = [];
  state.onBranch = [];
  state.branchLookups = [];
});

describe("self-modify webhook routing", () => {
  it("enqueues an evaluation when CI finishes or the pull request changes on a self-modify branch", async () => {
    for (const action of ["opened", "reopened", "ready_for_review", "synchronize", "closed"]) {
      await handleWebhook("pull_request", pullRequest(action));
    }
    await handleWebhook("check_suite", checkSuite("completed", BRANCH));
    await handleWebhook("check_run", checkRun(BRANCH));
    expect(state.events).toHaveLength(7);
    expect(state.events[0]).toEqual({ name: "manfrod/self-modify.pull.changed", data: { pullNumber: 42, source: "webhook" } });
  });

  it("ignores other branches, other repositories, forks and actions that change nothing", async () => {
    await handleWebhook("pull_request", pullRequest("opened", "feature/x"));
    await handleWebhook("pull_request", pullRequest("opened", BRANCH, "someone/fork"));
    await handleWebhook("pull_request", pullRequest("labeled"));
    await handleWebhook("pull_request", { ...pullRequest("opened"), repository: { full_name: "other/repo" } });
    await handleWebhook("check_suite", checkSuite("requested", BRANCH));
    await handleWebhook("check_suite", checkSuite("completed", "main"));
    await handleWebhook("check_run", { ...checkRun(BRANCH), action: "created" });
    await handleWebhook("check_run", checkRun("feature/x"));
    expect(state.events).toEqual([]);
    expect(state.branchLookups).toEqual([]);
  });

  it("finds the pull request by branch when GitHub lists none on the check", async () => {
    state.onBranch = [42];
    await handleWebhook("check_suite", checkSuite("completed", BRANCH, []));
    expect(state.branchLookups).toEqual([BRANCH]);
    expect(state.events.map((event) => event.data)).toEqual([{ pullNumber: 42, source: "webhook" }]);
    state.events = [];
    state.onBranch = [];
    await handleWebhook("check_run", checkRun(BRANCH, []));
    expect(state.events).toEqual([]);
  });

  it("reads the branch and pull requests from each payload shape", () => {
    expect(selfModifyTrigger("check_run", checkRun(BRANCH, [{ number: 5 }, { number: 6 }]), "org/repo")).toEqual({
      branch: BRANCH,
      pullNumbers: [5, 6],
    });
    expect(selfModifyTrigger("pull_request", pullRequest("synchronize"), undefined)).toBeNull();
    expect(selfModifyTrigger("push", { repository }, "org/repo")).toBeNull();
  });
});
