import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubRepository } from "../../lib/db/schema.ts";
import {
  allowsPersonal,
  decideBoard,
  decideRepository,
  deniedMessage,
  encodePath,
  type GithubScope,
  isRepositoryName,
  userCanRead,
} from "../../lib/github/access.ts";
import { fetchBoard, filterItems, formatBoard, type RawItem, toBoardItem } from "../../lib/github/board-items.ts";
import {
  checksSummary,
  commitWindow,
  formatCommits,
  formatDirectory,
  formatFile,
  formatPull,
  formatTreeMatches,
  latestReviews,
} from "../../lib/github/format.ts";
import type { LinkedBoard } from "../../lib/github/projects.ts";

const repo = (id: number, fullName: string): GithubRepository => ({
  id,
  installationId: 1,
  fullName,
  private: true,
  defaultBranch: "main",
  archived: false,
  backfilledAt: null,
  insertedAt: new Date(),
  updatedAt: new Date(),
});

const board = (title: string, number = 1): LinkedBoard => ({
  projectId: "p1",
  boardNodeId: `PVT_${number}`,
  ownerLogin: "acme",
  number,
  title,
});

const scope = (overrides: Partial<GithubScope> = {}): GithubScope => ({
  userId: "u1",
  audience: "internal",
  mapped: true,
  background: false,
  projectId: "p1",
  repositories: [repo(10, "acme/app")],
  boards: [board("Sprint")],
  ...overrides,
});

describe("GitHub access decisions", () => {
  it("uses the installation token for the project's linked repositories in every audience", () => {
    for (const audience of ["dm", "internal", "external"] as const) {
      expect(decideRepository(scope({ audience }), "ACME/App")).toMatchObject({ use: "installation", repository: { id: 10 } });
    }
    expect(decideRepository(scope({ background: true }), "acme/app").use).toBe("installation");
  });

  it("falls back to the person's own token only in DMs and internal channels", () => {
    expect(decideRepository(scope({ audience: "dm", projectId: null, repositories: [] }), "acme/other")).toEqual({ use: "user" });
    expect(decideRepository(scope(), "acme/other")).toEqual({ use: "user" });
    expect(decideRepository(scope({ audience: "external" }), "acme/other")).toEqual({ use: "denied", reason: "outside_project" });
    expect(decideRepository(scope({ background: true }), "acme/other")).toEqual({ use: "denied", reason: "outside_project" });
    expect(decideRepository(scope({ audience: "dm", background: true, projectId: null, repositories: [] }), "acme/app")).toEqual({
      use: "denied",
      reason: "no_project",
    });
  });

  it("allows personal access only in DMs and mapped internal channels, never in background runs", () => {
    expect(allowsPersonal({ audience: "dm", mapped: false, background: false })).toBe(true);
    expect(allowsPersonal({ audience: "internal", mapped: true, background: false })).toBe(true);
    expect(allowsPersonal({ audience: "internal", mapped: false, background: false })).toBe(false);
    expect(allowsPersonal({ audience: "external", mapped: true, background: false })).toBe(false);
    expect(allowsPersonal({ audience: "dm", mapped: false, background: true })).toBe(false);
  });

  it("rejects dot segments in repository names and paths", () => {
    expect(isRepositoryName("acme/app")).toBe(true);
    expect(isRepositoryName("../app")).toBe(false);
    expect(isRepositoryName("acme/..")).toBe(false);
    expect(encodePath("../../secret/contents/.env")).toBeNull();
    expect(encodePath("src/./x.ts")).toBeNull();
    expect(encodePath("src\\..\\x")).toBeNull();
    expect(encodePath(".github/workflows")).toBe(".github/workflows");
  });

  it("lists what is available when refusing", () => {
    expect(deniedMessage(scope({ audience: "external" }), "outside_project")).toContain("acme/app");
    expect(deniedMessage(scope(), "no_board", "board")).toContain("acme/1 (Sprint)");
  });

  it("decides boards", () => {
    expect(decideBoard(scope(), undefined)).toEqual({ use: "installation", boards: [board("Sprint")] });
    expect(decideBoard(scope({ boards: [] }), undefined)).toEqual({ use: "denied", reason: "no_board" });
    expect(decideBoard(scope(), "sprint")).toMatchObject({ use: "installation" });
    expect(decideBoard(scope(), "acme/1")).toMatchObject({ use: "installation" });
    expect(decideBoard(scope(), "other/4")).toEqual({ use: "user", owner: "other", number: 4 });
    expect(decideBoard(scope(), "Roadmap", [board("Roadmap", 7)])).toEqual({ use: "user", owner: "acme", number: 7 });
    expect(decideBoard(scope(), "Nope")).toEqual({ use: "denied", reason: "unknown_board" });
    expect(decideBoard(scope({ audience: "external" }), "other/4")).toEqual({ use: "denied", reason: "outside_project" });
  });

  it("encodes content paths segment by segment", () => {
    expect(encodePath("/src/a b/#x.ts/")).toBe("src/a%20b/%23x.ts");
    expect(encodePath("")).toBe("");
  });
});

describe("user access check", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks GitHub once and caches the answer", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ full_name: "acme/secret" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await userCanRead("u-cache", "token", "acme/secret")).toBe(true);
    expect(await userCanRead("u-cache", "token", "ACME/secret")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockImplementation(async () => new Response("", { status: 404 }));
    expect(await userCanRead("u-cache", "token", "acme/hidden")).toBe(false);
  });
});

describe("GitHub formatting", () => {
  it("reads commit windows in Warsaw time", () => {
    const now = new Date("2026-11-13T12:00:00Z");
    const fallback = commitWindow(undefined, undefined, now);
    expect(fallback).toEqual({ ok: true, since: new Date("2026-11-06T12:00:00Z") });
    expect(commitWindow("2026-11-01", "2026-11-02", now)).toEqual({
      ok: true,
      since: new Date("2026-10-31T23:00:00Z"),
      until: new Date("2026-11-02T23:00:00Z"),
    });
    expect(commitWindow("yesterday", undefined, now).ok).toBe(false);
  });

  it("formats commits as compact lines", () => {
    const commits = [
      {
        sha: "abcdef1234567",
        authorLogin: "ann",
        authorEmail: null,
        authorName: "Ann",
        authoredAt: new Date("2026-11-13T09:05:00Z"),
        message: "fix: thing\n\nlong body",
        url: "",
        repository: "acme/app",
        branches: ["main", "feat/x"],
      },
      {
        sha: "1234567890",
        authorLogin: null,
        authorEmail: "bob@example.com",
        authorName: null,
        authoredAt: new Date("2026-11-12T09:00:00Z"),
        message: "chore",
        url: "",
        repository: "acme/web",
        branches: [],
      },
    ];
    expect(formatCommits(commits, 5)).toBe(
      "2 commits (times Europe/Warsaw):\n2026-11-13 10:05 acme/app [main, feat/x] abcdef1 fix: thing (ann)\n2026-11-12 10:00 acme/web 1234567 chore (bob@example.com)",
    );
    expect(formatCommits(commits, 1)).toContain("Newest 1 commits");
    expect(formatCommits(commits, 1)).toContain("more commits match");
    expect(formatCommits([], 5)).toBe("No commits found.");
  });

  it("lists directories with folders first", () => {
    const listing = formatDirectory("acme/app", "src", [
      { name: "b.ts", path: "src/b.ts", type: "file", size: 10 },
      { name: "lib", path: "src/lib", type: "dir", size: 0 },
    ]);
    expect(listing).toBe("acme/app:src\nlib/\nb.ts (10 B)");
  });

  it("truncates large files and says so", () => {
    const text = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");
    const result = formatFile("acme/app", "a.txt", text, 50);
    expect(result).toContain("truncated: showing the first");
    expect(result).toContain("of 100 lines");
    expect(formatFile("acme/app", "a.txt", "short")).toBe("acme/app:a.txt\nshort");
    expect(formatFile("acme/app", "a.png", "x\u0000y")).toContain("binary");
  });

  it("filters the tree by substring", () => {
    expect(formatTreeMatches("acme/app", "Card", ["lib/cards.ts", "lib/time.ts", "test/card.test.ts"], false)).toBe(
      '2 paths in acme/app contain "Card":\nlib/cards.ts\ntest/card.test.ts',
    );
    expect(formatTreeMatches("acme/app", "zzz", ["a"], true)).toContain("truncated the tree");
  });

  it("summarizes reviews and checks", () => {
    expect(
      latestReviews([
        { user: { login: "ann" }, state: "CHANGES_REQUESTED" },
        { user: { login: "ann" }, state: "COMMENTED" },
        { user: { login: "ann" }, state: "APPROVED" },
        { user: { login: "bob" }, state: "COMMENTED" },
      ]),
    ).toEqual(["ann: approved"]);
    expect(
      checksSummary(
        [
          { name: "test", status: "completed", conclusion: "success" },
          { name: "lint", status: "completed", conclusion: "failure" },
          { name: "build", status: "in_progress", conclusion: null },
        ],
        [{ context: "vercel", state: "success" }],
      ),
    ).toBe("2 success, 1 failure, 1 in_progress (failing: lint)");
    expect(checksSummary(null)).toBe("unavailable");
    expect(checksSummary([])).toBe("none");
  });

  it("formats one pull request", () => {
    const text = formatPull(
      "acme/app",
      {
        number: 7,
        title: "Add cards",
        state: "closed",
        merged_at: "2026-11-12T10:00:00Z",
        html_url: "https://github.com/acme/app/pull/7",
        user: { login: "ann" },
        head: { ref: "feat/cards", sha: "abc" },
        base: { ref: "main" },
        updated_at: "2026-11-12T10:00:00Z",
        body: "Body",
        additions: 5,
        deletions: 1,
        changed_files: 1,
        requested_reviewers: [{ login: "bob" }],
      },
      [{ filename: "a.ts", status: "modified", additions: 5, deletions: 1 }],
      [],
      "1 success",
    );
    expect(text).toContain("acme/app#7 Add cards [merged]");
    expect(text).toContain("Reviews: none; requested: bob");
    expect(text).toContain("modified a.ts +5 -1");
  });
});

const rawItem = (overrides: Partial<RawItem> = {}): RawItem => ({
  isArchived: false,
  type: "ISSUE",
  fieldValues: {
    nodes: [
      { text: "Login page", field: { name: "Title" } },
      { name: "In Progress", field: { name: "Status" } },
      { name: "P1", field: { name: "Priority" } },
      { title: "Sprint 3", startDate: "2026-11-09", field: { name: "Iteration" } },
      {},
    ],
  },
  content: {
    title: "Login page",
    number: 12,
    state: "OPEN",
    url: "https://github.com/acme/app/issues/12",
    repository: { nameWithOwner: "acme/app" },
    assignees: { nodes: [{ login: "ann" }] },
  },
  ...overrides,
});

describe("GitHub boards", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads status, iteration, fields and the linked issue", () => {
    expect(toBoardItem(rawItem())).toEqual({
      title: "Login page",
      type: "ISSUE",
      status: "In Progress",
      iteration: "Sprint 3 (from 2026-11-09)",
      fields: { Priority: "P1" },
      assignees: ["ann"],
      reference: "acme/app#12",
      state: "open",
      url: "https://github.com/acme/app/issues/12",
    });
  });

  it("filters and groups items by status", () => {
    const items = [
      toBoardItem(rawItem()),
      toBoardItem(rawItem({ type: "DRAFT_ISSUE", fieldValues: { nodes: [] }, content: { title: "Idea", assignees: { nodes: [] } } })),
    ];
    expect(filterItems(items, { status: "progress" })).toHaveLength(1);
    expect(filterItems(items, { assignee: "@ANN" })).toHaveLength(1);
    expect(filterItems(items, { status: "no status" })[0].title).toBe("Idea");
    const text = formatBoard({ title: "Sprint", url: "https://github.com/orgs/acme/projects/1", items, truncated: false }, items);
    expect(text).toContain(
      "In Progress (1):\n- acme/app#12 Login page | open | ann | iteration: Sprint 3 (from 2026-11-09) | Priority: P1",
    );
    expect(text).toContain("No status (1):\n- Idea (draft issue) | unassigned");
  });

  it("pages through items and skips archived ones", async () => {
    const page = (hasNextPage: boolean, items: RawItem[]) =>
      new Response(
        JSON.stringify({
          data: { node: { title: "Sprint", url: "u", closed: false, items: { pageInfo: { hasNextPage, endCursor: "c1" }, nodes: items } } },
        }),
        { status: 200 },
      );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(page(true, [rawItem(), rawItem({ isArchived: true })]))
      .mockResolvedValueOnce(page(false, [rawItem()]));
    vi.stubGlobal("fetch", fetch);
    const result = await fetchBoard("token", { nodeId: "PVT_1" });
    expect(result?.items).toHaveLength(2);
    expect(result?.truncated).toBe(false);
    expect(JSON.parse(fetch.mock.calls[1][1].body).variables).toEqual({ id: "PVT_1", after: "c1" });
  });

  it("falls back from organization to user boards", async () => {
    const board = { title: "Mine", url: "u", closed: false, items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: { organization: null, user: { projectV2: board } } }), { status: 200 })),
    );
    expect(await fetchBoard("token", { owner: "ann", number: 2 })).toEqual({ title: "Mine", url: "u", items: [], truncated: false });
  });
});
