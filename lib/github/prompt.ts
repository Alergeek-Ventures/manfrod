import type { GithubRepository } from "../db/schema.ts";
import { getActiveMapping } from "../memory/access.ts";
import { type LinkedBoard, listProjectBoards, listProjectRepositories } from "./projects.ts";

export function projectGithubPrompt(
  project: string,
  repositories: Pick<GithubRepository, "fullName" | "defaultBranch">[],
  boards: Pick<LinkedBoard, "ownerLogin" | "number" | "title">[],
  clientChannel: boolean,
): string {
  if (repositories.length === 0 && boards.length === 0) return "";
  const lines = [`[GitHub]`, `This channel belongs to the project ${project}.`];
  if (repositories.length > 0) {
    lines.push(
      `Its GitHub repositories: ${repositories.map((repository) => `${repository.fullName} (default branch ${repository.defaultBranch})`).join(", ")}.`,
    );
  }
  if (boards.length > 0) {
    lines.push(`Its task boards: ${boards.map((board) => `${board.ownerLogin}/${board.number} "${board.title}"`).join(", ")}.`);
  }
  lines.push(
    clientChannel
      ? "This is a client channel: only these are available here."
      : "Questions about this project's code, commits, pull requests or tasks are about these unless someone names another repository; the github-* tools can still read any other repository.",
  );
  return lines.join("\n");
}

export async function githubPrompt(channelId: string | null): Promise<string> {
  if (!channelId || channelId.startsWith("D")) return "";
  const mapping = await getActiveMapping(channelId);
  if (!mapping?.projectId || !mapping.project) return "";
  const [repositories, boards] = await Promise.all([listProjectRepositories(mapping.projectId), listProjectBoards(mapping.projectId)]);
  return projectGithubPrompt(mapping.project.name, repositories, boards, Boolean(mapping.clientId));
}
