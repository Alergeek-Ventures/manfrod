import { logger } from "../log.ts";
import { github, repositoryReadToken } from "./api.ts";
import { listProjectRepositories } from "./projects.ts";
import { listCommits, type StoredCommit } from "./store.ts";

const log = logger("Github.Activity");
const MESSAGES_PER_REPOSITORY = 8;
const MAX_COMMITS = 1000;

export interface PullSummary {
  number: number;
  title: string;
  html_url: string;
  state: string;
  draft?: boolean;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
}

export interface ProjectGithubWeek {
  commits: string;
  pulls: string;
}

const authorOf = (commit: StoredCommit) => commit.authorLogin ?? commit.authorName ?? commit.authorEmail ?? "unknown";

const day = (date: Date | string) => new Date(date).toISOString().slice(0, 10);

export function describeWeekCommits(commits: StoredCommit[]): string {
  const byRepository = new Map<string, StoredCommit[]>();
  for (const commit of commits) byRepository.set(commit.repository, [...(byRepository.get(commit.repository) ?? []), commit]);
  return [...byRepository.entries()]
    .map(([repository, list]) => {
      const sorted = [...list].sort((a, b) => a.authoredAt.getTime() - b.authoredAt.getTime());
      const authors = new Map<string, number>();
      for (const commit of sorted) authors.set(authorOf(commit), (authors.get(authorOf(commit)) ?? 0) + 1);
      const byAuthor = [...authors.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([author, count]) => `${author} (${count})`)
        .join(", ");
      const branches = [...new Set(sorted.flatMap((commit) => commit.branches))].join(", ");
      const messages = sorted
        .filter((commit) => !commit.message.startsWith("Merge "))
        .slice(-MESSAGES_PER_REPOSITORY)
        .map((commit) => `  - ${day(commit.authoredAt)} ${authorOf(commit)}: ${commit.message.split("\n")[0].slice(0, 120)}`);
      return [`- ${repository}: ${sorted.length} commit(s) by ${byAuthor}${branches ? ` on ${branches}` : ""}`, ...messages].join("\n");
    })
    .join("\n");
}

export function describeWeekPulls(repository: string, pulls: PullSummary[], since: Date): string[] {
  return pulls
    .filter((pull) => new Date(pull.updated_at) >= since)
    .map((pull) => {
      const author = pull.user?.login ?? "unknown";
      const status = pull.merged_at
        ? `merged ${day(pull.merged_at)}`
        : pull.state === "closed"
          ? `closed without merging ${day(pull.closed_at ?? pull.updated_at)}`
          : `${pull.draft ? "draft" : "open"}${new Date(pull.created_at) >= since ? `, opened ${day(pull.created_at)}` : ""}`;
      return `- ${repository}#${pull.number} ${pull.title} (${author}), ${status} ${pull.html_url}`;
    });
}

export async function projectGithubWeek(projectId: string, since: Date): Promise<ProjectGithubWeek> {
  const repositories = await listProjectRepositories(projectId);
  if (repositories.length === 0) return { commits: "", pulls: "" };
  const commits = await listCommits({ since, repositoryIds: repositories.map((repository) => repository.id), limit: MAX_COMMITS });
  const pulls: string[] = [];
  for (const repository of repositories) {
    try {
      const token = await repositoryReadToken(repository.installationId, repository.fullName);
      const list = await github<PullSummary[]>(
        token,
        "GET",
        `/repos/${repository.fullName}/pulls?state=all&sort=updated&direction=desc&per_page=50`,
      );
      pulls.push(...describeWeekPulls(repository.fullName, list ?? [], since));
    } catch (error) {
      log.warn(`Github.Activity: pull requests of ${repository.fullName} unavailable: ${(error as Error).message}`);
    }
  }
  return { commits: describeWeekCommits(commits), pulls: pulls.join("\n") };
}
