import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { db, tables } = await import("../../lib/db/index.ts");
const store = await import("../../lib/github/store.ts");
const { eq } = await import("drizzle-orm");

const installationId = 990_000_000 + Math.floor(Math.random() * 1_000_000);
const repositoryId = installationId + 1;

const commit = (sha: string, at: string, author: { login?: string; email?: string }) => ({
  sha,
  authorLogin: author.login ?? null,
  authorEmail: author.email ?? null,
  authorName: null,
  authoredAt: new Date(at),
  message: `msg ${sha}`,
  url: `https://github.com/acme/app/commit/${sha}`,
});

describe.skipIf(!enabled)("github store", () => {
  beforeAll(async () => {
    await store.upsertInstallation({
      id: installationId,
      account: { id: 1, login: "acme", type: "Organization" },
      repository_selection: "all",
    });
    await store.upsertRepositories(installationId, [
      { id: repositoryId, full_name: `acme/app-${repositoryId}`, private: true, default_branch: "main" },
    ]);
  });

  afterAll(async () => {
    await db.delete(tables.githubInstallations).where(eq(tables.githubInstallations.id, installationId));
  });

  it("merges branches when the same commit is pushed to several branches", async () => {
    await store.storeCommits(repositoryId, "feat/x", [commit("s1", "2026-11-13T09:00:00Z", { login: "ann" })]);
    await store.storeCommits(repositoryId, "main", [commit("s1", "2026-11-13T09:00:00Z", {})]);
    const [row] = await store.listCommits({ since: new Date("2026-11-13T00:00:00Z"), repositoryIds: [repositoryId] });
    expect(row.branches.sort()).toEqual(["feat/x", "main"]);
    expect(row.authorLogin).toBe("ann");
  });

  it("finds a person's commits by login or any of their emails", async () => {
    await store.storeCommits(repositoryId, "main", [
      commit("s2", "2026-11-13T10:00:00Z", { email: "ann@private.dev" }),
      commit("s3", "2026-11-13T11:00:00Z", { login: "bob", email: "bob@x.dev" }),
    ]);
    const mine = await store.listCommits({
      since: new Date("2026-11-13T00:00:00Z"),
      repositoryIds: [repositoryId],
      author: { login: "ANN", emails: ["ann@private.dev"] },
    });
    expect(mine.map((row) => row.sha).sort()).toEqual(["s1", "s2"]);
  });

  it("moves a stale repository out of the way when another one takes its name", async () => {
    const stale = await store.getRepository(repositoryId);
    await store.upsertRepositories(installationId, [{ id: repositoryId + 7, full_name: stale!.fullName, private: false }]);
    expect((await store.getRepository(stale!.fullName))?.id).toBe(repositoryId + 7);
    expect((await store.getRepository(repositoryId))?.fullName).toBe(`${stale!.fullName}#stale-${repositoryId}`);
  });

  it("drops repositories and their commits with the installation", async () => {
    await store.deleteInstallation(installationId);
    expect(await store.getRepository(repositoryId)).toBeNull();
    expect(await store.listCommits({ since: new Date(0), repositoryIds: [repositoryId] })).toEqual([]);
  });
});
