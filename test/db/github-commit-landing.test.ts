import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { db, tables } = await import("../../lib/db/index.ts");
const store = await import("../../lib/github/store.ts");
const { and, eq } = await import("drizzle-orm");

const installationId = 980_000_000 + Math.floor(Math.random() * 1_000_000);
const repositoryId = installationId + 1;

const commit = (sha: string, written: string, landed: string) => ({
  sha,
  authorLogin: "ann",
  authorEmail: null,
  authorName: null,
  authoredAt: new Date(written),
  committedAt: new Date(landed),
  message: `msg ${sha}`,
  url: `https://github.com/acme/app/commit/${sha}`,
});

const stored = async (sha: string) =>
  (
    await db
      .select()
      .from(tables.githubCommits)
      .where(and(eq(tables.githubCommits.repositoryId, repositoryId), eq(tables.githubCommits.sha, sha)))
  )[0];

describe.skipIf(!enabled)("commit landing times", () => {
  beforeAll(async () => {
    await store.upsertInstallation({
      id: installationId,
      account: { id: 1, login: "acme", type: "Organization" },
      repository_selection: "all",
    });
    await store.upsertRepositories(installationId, [
      { id: repositoryId, full_name: `acme/landing-${repositoryId}`, private: true, default_branch: "main" },
    ]);
  });

  afterAll(async () => {
    await db.delete(tables.githubInstallations).where(eq(tables.githubInstallations.id, installationId));
  });

  it("moves the landing time to when the commit reached the default branch, and keeps it after later feature pushes", async () => {
    await store.storeCommits(repositoryId, "feat/x", [commit("l1", "2026-11-06T09:00:00Z", "2026-11-06T09:05:00Z")]);
    expect((await stored("l1")).committedAt?.toISOString()).toBe("2026-11-06T09:05:00.000Z");
    await store.storeCommits(repositoryId, "main", [commit("l1", "2026-11-06T09:00:00Z", "2026-11-13T10:52:00Z")]);
    expect((await stored("l1")).committedAt?.toISOString()).toBe("2026-11-13T10:52:00.000Z");
    await store.storeCommits(repositoryId, "feat/y", [commit("l1", "2026-11-06T09:00:00Z", "2026-11-15T08:00:00Z")]);
    expect((await stored("l1")).committedAt?.toISOString()).toBe("2026-11-13T10:52:00.000Z");
  });

  it("filters by landing time by default and by writing time when asked", async () => {
    const window = { since: new Date("2026-11-13T00:00:00Z"), until: new Date("2026-11-14T00:00:00Z"), repositoryIds: [repositoryId] };
    expect((await store.listCommits(window)).map((row) => row.sha)).toContain("l1");
    expect((await store.listCommits({ ...window, time: "written" })).map((row) => row.sha)).not.toContain("l1");
  });

  it("keeps an old commit that landed recently when pruning by age", async () => {
    await store.storeCommits(repositoryId, "main", [commit("l2", "2026-03-01T09:00:00Z", "2026-11-13T10:00:00Z")]);
    await store.deleteCommitsBefore(new Date("2026-05-20T00:00:00Z"));
    expect(await stored("l2")).toBeDefined();
  });
});
