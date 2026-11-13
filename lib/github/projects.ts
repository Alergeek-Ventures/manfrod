import { and, eq } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { GithubRepository } from "../db/schema.ts";

const { githubRepositories, projectGithubBoards, projectGithubRepositories } = tables;

export interface LinkedBoard {
  projectId: string;
  boardNodeId: string;
  ownerLogin: string;
  number: number;
  title: string;
}

export async function listProjectRepositories(projectId: string): Promise<GithubRepository[]> {
  const rows = await db
    .select({ repository: githubRepositories })
    .from(projectGithubRepositories)
    .innerJoin(githubRepositories, eq(githubRepositories.id, projectGithubRepositories.repositoryId))
    .where(eq(projectGithubRepositories.projectId, projectId))
    .orderBy(githubRepositories.fullName);
  return rows.map((row) => row.repository);
}

export async function listRepositoryLinks(): Promise<{ projectId: string; repositoryId: number }[]> {
  return db
    .select({ projectId: projectGithubRepositories.projectId, repositoryId: projectGithubRepositories.repositoryId })
    .from(projectGithubRepositories);
}

export async function linkRepository(projectId: string, repositoryId: number, userId: string | null): Promise<void> {
  await db.insert(projectGithubRepositories).values({ projectId, repositoryId, linkedByUserId: userId }).onConflictDoNothing();
}

export async function unlinkRepository(projectId: string, repositoryId: number): Promise<boolean> {
  const removed = await db
    .delete(projectGithubRepositories)
    .where(and(eq(projectGithubRepositories.projectId, projectId), eq(projectGithubRepositories.repositoryId, repositoryId)))
    .returning();
  return removed.length > 0;
}

export async function listProjectBoards(projectId?: string): Promise<LinkedBoard[]> {
  return db
    .select({
      projectId: projectGithubBoards.projectId,
      boardNodeId: projectGithubBoards.boardNodeId,
      ownerLogin: projectGithubBoards.ownerLogin,
      number: projectGithubBoards.number,
      title: projectGithubBoards.title,
    })
    .from(projectGithubBoards)
    .where(projectId ? eq(projectGithubBoards.projectId, projectId) : undefined)
    .orderBy(projectGithubBoards.title);
}

export async function linkBoard(board: LinkedBoard, userId: string | null): Promise<void> {
  await db
    .insert(projectGithubBoards)
    .values({ ...board, linkedByUserId: userId })
    .onConflictDoUpdate({
      target: [projectGithubBoards.projectId, projectGithubBoards.boardNodeId],
      set: { title: board.title, ownerLogin: board.ownerLogin, number: board.number },
    });
}

export async function unlinkBoard(projectId: string, boardNodeId: string): Promise<boolean> {
  const removed = await db
    .delete(projectGithubBoards)
    .where(and(eq(projectGithubBoards.projectId, projectId), eq(projectGithubBoards.boardNodeId, boardNodeId)))
    .returning();
  return removed.length > 0;
}
