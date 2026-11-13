import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { db, tables } = await import("../../lib/db/index.ts");
const store = await import("../../lib/github/store.ts");
const links = await import("../../lib/github/projects.ts");
const { eq } = await import("drizzle-orm");

const installationId = 980_000_000 + Math.floor(Math.random() * 1_000_000);
const clientRepo = installationId + 1;
const internalRepo = installationId + 2;
let projectId = "";

describe.skipIf(!enabled)("github project links", () => {
  beforeAll(async () => {
    await store.upsertInstallation({
      id: installationId,
      account: { id: 1, login: "acme", type: "Organization" },
      repository_selection: "all",
    });
    await store.upsertRepositories(installationId, [
      { id: clientRepo, full_name: `client-co/app-${clientRepo}`, private: true },
      { id: internalRepo, full_name: `acme/internal-${internalRepo}`, private: true },
    ]);
    const [project] = await db
      .insert(tables.projects)
      .values({ slug: `gh-links-${installationId}`, name: `GH links ${installationId}` })
      .returning();
    projectId = project.id;
  });

  afterAll(async () => {
    if (projectId) await db.delete(tables.projects).where(eq(tables.projects.id, projectId));
    await db.delete(tables.githubInstallations).where(eq(tables.githubInstallations.id, installationId));
  });

  it("links and unlinks repositories and flags a second owner", async () => {
    await links.linkRepository(projectId, clientRepo, null);
    await links.linkRepository(projectId, clientRepo, null);
    const linked = await links.listProjectRepositories(projectId);
    expect(linked.map((repository) => repository.id)).toEqual([clientRepo]);
    expect(
      links.crossOwnerWarning(
        linked.map((repository) => repository.fullName),
        [`acme/internal-${internalRepo}`],
      ),
    ).toContain("acme/internal");
    expect((await links.listRepositoryLinks()).filter((link) => link.projectId === projectId)).toHaveLength(1);
    expect(await links.unlinkRepository(projectId, clientRepo)).toBe(true);
    expect(await links.unlinkRepository(projectId, clientRepo)).toBe(false);
  });

  it("keeps one row per board and refreshes its title", async () => {
    const board = { projectId, boardNodeId: `PVT_${installationId}`, ownerLogin: "acme", number: 4, title: "Old" };
    await links.linkBoard(board, null);
    await links.linkBoard({ ...board, title: "New" }, null);
    expect((await links.listProjectBoards(projectId)).map((row) => row.title)).toEqual(["New"]);
    expect(await links.unlinkBoard(projectId, board.boardNodeId)).toBe(true);
    expect(await links.listProjectBoards(projectId)).toEqual([]);
  });
});
