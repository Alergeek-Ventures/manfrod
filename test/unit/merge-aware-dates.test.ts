import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCommits } from "../../lib/github/format.ts";
import type { StoredCommit } from "../../lib/github/store.ts";
import { fromApiCommit } from "../../lib/github/sync.ts";
import { pushCommits } from "../../lib/github/webhook.ts";
import { listIssues } from "../../lib/linear/client.ts";
import { formatIssue, stateSince } from "../../lib/linear/calls.ts";

const stored = (overrides: Partial<StoredCommit>): StoredCommit => ({
  sha: "0d13c583aaaa",
  authorLogin: "jakub",
  authorEmail: null,
  authorName: null,
  authoredAt: new Date("2026-11-06T09:00:00Z"),
  committedAt: new Date("2026-11-13T10:52:00Z"),
  message: "ONS-110 expo-router",
  url: "https://github.com/acme/onside/commit/0d13c583",
  repository: "acme/onside",
  branches: ["main"],
  ...overrides,
});

describe("commit dates", () => {
  it("lists when a commit landed and when it was written if that was earlier", () => {
    const text = formatCommits([stored({})], 10);
    expect(text).toContain("2026-11-13 11:52 acme/onside [main]");
    expect(text).toContain("written 2026-11-06");
  });

  it("does not repeat the date for a commit that landed the day it was written", () => {
    expect(formatCommits([stored({ committedAt: new Date("2026-11-06T12:00:00Z") })], 10)).not.toContain("written");
    expect(formatCommits([stored({ committedAt: null })], 10)).toContain("2026-11-06 10:00");
  });

  it("takes the committer date from the API and the delivery time from a push", () => {
    const commit = fromApiCommit({
      sha: "abc",
      html_url: "https://github.com/acme/onside/commit/abc",
      author: null,
      commit: { message: "m", author: { date: "2026-11-06T09:00:00Z" }, committer: { date: "2026-11-13T10:52:00Z" } },
    });
    expect(commit.committedAt?.toISOString()).toBe("2026-11-13T10:52:00.000Z");
    const received = new Date("2026-11-13T10:52:30Z");
    const [pushed] = pushCommits(
      {
        ref: "refs/heads/main",
        before: "0".repeat(40),
        repository: { id: 1 } as never,
        commits: [{ id: "abc", message: "m", timestamp: "2026-11-06T09:00:00Z", url: "u" }],
      } as never,
      received,
    );
    expect(pushed.committedAt).toBe(received);
  });
});

describe("Linear issue states", () => {
  const issue = {
    identifier: "ONS-120",
    title: "Client projects",
    state: { name: "Merged" },
    assignee: { name: "Natalia" },
    url: "https://linear.app/x/issue/ONS-120",
    history: {
      nodes: [
        { createdAt: "2026-11-12T09:00:00Z", toState: { name: "In Review" } },
        { createdAt: "2026-11-16T10:05:00Z", toState: { name: "Merged" } },
        { createdAt: "2026-11-01T08:00:00Z", toState: { name: "Merged" } },
      ],
    },
  };

  it("finds the last time an issue entered its current state", () => {
    expect(stateSince(issue)).toBe("2026-11-16T10:05:00Z");
    expect(formatIssue(issue)).toContain("[Merged since 2026-11-16 11:05]");
    expect(stateSince({ ...issue, history: { nodes: [] } })).toBeNull();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("filters by state and follows pages until it has enough", async () => {
    const bodies: any[] = [];
    const pages = [
      {
        nodes: Array.from({ length: 50 }, (_, index) => ({ identifier: `ONS-${index}` })),
        pageInfo: { hasNextPage: true, endCursor: "c1" },
      },
      { nodes: [{ identifier: "ONS-50" }], pageInfo: { hasNextPage: false, endCursor: null } },
    ];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ data: { issues: pages[bodies.length - 1] } }), { status: 200 });
    });
    const result = await listIssues("token", "team", 100, "Merged");
    expect(result.ok && result.value.length).toBe(51);
    expect(bodies[0].query).toContain("eqIgnoreCase: $state");
    expect(bodies[0].variables).toMatchObject({ state: "Merged", first: 50, after: null });
    expect(bodies[1].variables).toMatchObject({ after: "c1", first: 50 });
  });
});
