import { describe, expect, it } from "vitest";
import { describeWeekCommits, describeWeekPulls, type PullSummary } from "../../lib/github/activity.ts";

const commit = (repository: string, at: string, message: string, author: string | null, branches: string[] = ["main"]) => ({
  sha: at,
  authorLogin: author,
  authorEmail: author ? null : "ghost@x.dev",
  authorName: null,
  authoredAt: new Date(at),
  message,
  url: "",
  repository,
  branches,
});

const pull = (overrides: Partial<PullSummary>): PullSummary => ({
  number: 1,
  title: "Change",
  html_url: "https://github.com/acme/app/pull/1",
  state: "open",
  user: { login: "ann" },
  created_at: "2026-11-01T10:00:00Z",
  updated_at: "2026-11-12T10:00:00Z",
  merged_at: null,
  closed_at: null,
  ...overrides,
});

describe("describeWeekCommits", () => {
  it("groups per repository with authors by count, branches and recent messages, skipping merges", () => {
    const text = describeWeekCommits([
      commit("acme/app", "2026-11-10T09:00:00Z", "feat: start\n\nbody", "ann"),
      commit("acme/app", "2026-11-11T09:00:00Z", "Merge branch 'main' into feat/x", "bob", ["feat/x"]),
      commit("acme/app", "2026-11-12T09:00:00Z", "fix: login", "ann", ["feat/x"]),
      commit("acme/site", "2026-11-12T12:00:00Z", "chore: bump", null),
    ]);
    expect(text).toBe(
      [
        "- acme/app: 3 commit(s) by ann (2), bob (1) on main, feat/x",
        "  - 2026-11-10 ann: feat: start",
        "  - 2026-11-12 ann: fix: login",
        "- acme/site: 1 commit(s) by ghost@x.dev (1) on main",
        "  - 2026-11-12 ghost@x.dev: chore: bump",
      ].join("\n"),
    );
  });
});

describe("describeWeekPulls", () => {
  const since = new Date("2026-11-09T00:00:00Z");

  it("labels merged, closed, draft and newly opened pull requests and drops untouched ones", () => {
    const lines = describeWeekPulls(
      "acme/app",
      [
        pull({ number: 1, state: "closed", merged_at: "2026-11-11T10:00:00Z", closed_at: "2026-11-11T10:00:00Z" }),
        pull({ number: 2, state: "closed", closed_at: "2026-11-10T10:00:00Z" }),
        pull({ number: 3, draft: true, created_at: "2026-11-10T10:00:00Z" }),
        pull({ number: 4 }),
        pull({ number: 5, updated_at: "2026-11-01T10:00:00Z" }),
      ],
      since,
    );
    expect(lines.map((line) => line.replace(/ https:\S+$/, ""))).toEqual([
      "- acme/app#1 Change (ann), merged 2026-11-11",
      "- acme/app#2 Change (ann), closed without merging 2026-11-10",
      "- acme/app#3 Change (ann), draft, opened 2026-11-10",
      "- acme/app#4 Change (ann), open",
    ]);
  });
});
