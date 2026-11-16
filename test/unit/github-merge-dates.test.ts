import { describe, expect, it } from "vitest";
import { formatPullList, matchesPull, pullWhen, type PullSummary } from "../../lib/github/format.ts";

const pull = (overrides: Partial<PullSummary>): PullSummary => ({
  number: 500,
  title: "feat: client projects",
  state: "closed",
  html_url: "https://github.com/acme/app/pull/500",
  user: { login: "natalia" },
  head: { ref: "feat/project", sha: "abc" },
  base: { ref: "main" },
  updated_at: "2026-11-16T10:30:00Z",
  ...overrides,
});

describe("pull request dates", () => {
  it("shows when a pull request was merged, in Warsaw time", () => {
    expect(pullWhen(pull({ merged_at: "2026-11-16T10:02:00Z", closed_at: "2026-11-16T10:02:00Z" }))).toBe("merged 2026-11-16 11:02");
  });

  it("shows when an unmerged pull request was closed, and the update day for open ones", () => {
    expect(pullWhen(pull({ closed_at: "2026-11-10T08:00:00Z" }))).toBe("closed 2026-11-10 09:00");
    expect(pullWhen(pull({ state: "open" }))).toBe("updated 2026-11-16");
  });

  it("lists merge times instead of the last update", () => {
    const text = formatPullList("acme/app", [pull({ merged_at: "2026-11-16T10:02:00Z" })]);
    expect(text).toContain("[merged]");
    expect(text).toContain("merged 2026-11-16 11:02");
    expect(text).not.toContain("updated");
  });
});

describe("matchesPull", () => {
  it("finds a task ID in the title or the branch, ignoring case", () => {
    expect(matchesPull(pull({ head: { ref: "jakub/ons-139-preview", sha: "x" } }), "ONS-139")).toBe(true);
    expect(matchesPull(pull({ title: "ONS-120 client projects" }), "ons-120")).toBe(true);
    expect(matchesPull(pull({}), "ONS-139")).toBe(false);
  });
});
