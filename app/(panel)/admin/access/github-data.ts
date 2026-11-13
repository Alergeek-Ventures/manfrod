import { availableBoards } from "@/lib/github/boards.ts";
import { listProjectBoards, listRepositoryLinks, repositoryOwner } from "@/lib/github/projects.ts";
import { listInstallations, listRepositories } from "@/lib/github/store.ts";
import { listProjects } from "@/lib/memory/projects.ts";

export type GithubData = Awaited<ReturnType<typeof loadGithubData>>;

export async function loadGithubData() {
  const [installations, repositories, projects, links, linkedBoards, boards] = await Promise.all([
    listInstallations(),
    listRepositories(),
    listProjects(),
    listRepositoryLinks(),
    listProjectBoards(),
    availableBoards(),
  ]);
  const repositoryRows = repositories.map((repository) => ({
    id: repository.id,
    fullName: repository.fullName,
    owner: repositoryOwner(repository.fullName),
    private: repository.private,
    archived: repository.archived,
  }));
  const byId = new Map(repositoryRows.map((repository) => [repository.id, repository]));
  return {
    installations: installations.map((installation) => ({
      id: installation.id,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      repositoryCount: repositories.filter((repository) => repository.installationId === installation.id).length,
      suspended: installation.suspendedAt !== null,
      syncedAt: installation.syncedAt?.toISOString() ?? null,
    })),
    repositories: repositoryRows,
    boards,
    projects: projects.map((project) => ({
      id: project.id,
      slug: project.slug,
      name: project.name,
      repositories: links.flatMap((link) =>
        link.projectId === project.id && byId.has(link.repositoryId) ? [byId.get(link.repositoryId)!] : [],
      ),
      boards: linkedBoards.filter((board) => board.projectId === project.id),
    })),
  };
}
