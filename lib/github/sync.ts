import { logger } from "../log.ts";
import { appJwt, github, installationToken, paginate } from "./api.ts";
import {
  type CommitInput,
  type InstallationInput,
  listRepositories,
  markBackfilled,
  markInstallationSynced,
  listInstallations,
  pruneInstallations,
  pruneRepositories,
  type RepositoryInput,
  repositoriesToBackfill,
  storeCommits,
  upsertInstallation,
  upsertRepositories,
} from "./store.ts";

const log = logger("Github.Sync");
const BACKFILL_DAYS = 30;
export const COMMIT_RETENTION_DAYS = 180;

export interface ApiCommit {
  sha: string;
  html_url: string;
  author: { login: string } | null;
  commit: { message: string; author: { name?: string; email?: string; date?: string } | null };
}

export function fromApiCommit(commit: ApiCommit): CommitInput {
  return {
    sha: commit.sha,
    authorLogin: commit.author?.login ?? null,
    authorEmail: commit.commit.author?.email?.toLowerCase() ?? null,
    authorName: commit.commit.author?.name ?? null,
    authoredAt: new Date(commit.commit.author?.date ?? Date.now()),
    message: commit.commit.message,
    url: commit.html_url,
  };
}

export async function syncInstallation(installationId: number): Promise<number[]> {
  const installation = await github<InstallationInput>(appJwt(), "GET", `/app/installations/${installationId}`);
  if (!installation) return [];
  await upsertInstallation(installation);
  const token = await installationToken(installationId);
  const repositories = await paginate<RepositoryInput>(token, "/installation/repositories", (page) => page.repositories);
  await upsertRepositories(installationId, repositories);
  await pruneRepositories(
    installationId,
    repositories.map((repository) => repository.id),
  );
  await markInstallationSynced(installationId);
  return repositories.map((repository) => repository.id);
}

export async function syncAll(): Promise<{ installations: number; repositories: number }> {
  const installations = await paginate<InstallationInput>(appJwt(), "/app/installations");
  let repositories = 0;
  for (const installation of installations) {
    try {
      repositories += (await syncInstallation(installation.id)).length;
    } catch (error) {
      log.error(`Github.Sync: installation ${installation.id} (${installation.account.login}) failed: ${(error as Error).message}`);
    }
  }
  const listed = new Set(installations.map((installation) => installation.id));
  const kept = [...listed];
  for (const stored of await listInstallations()) {
    if (listed.has(stored.id)) continue;
    if (await github(appJwt(), "GET", `/app/installations/${stored.id}`).catch(() => true)) kept.push(stored.id);
  }
  await pruneInstallations(kept);
  return { installations: installations.length, repositories };
}

export async function backfillRepository(repositoryId: number): Promise<number> {
  const repository = (await listRepositories()).find((row) => row.id === repositoryId);
  if (!repository) return 0;
  const token = await installationToken(repository.installationId);
  const since = new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString();
  const branches = await paginate<{ name: string }>(token, `/repos/${repository.fullName}/branches`);
  const ordered = [repository.defaultBranch, ...branches.map((branch) => branch.name).filter((name) => name !== repository.defaultBranch)];
  let stored = 0;
  for (const branch of ordered) {
    const commits = await paginate<ApiCommit>(
      token,
      `/repos/${repository.fullName}/commits?sha=${encodeURIComponent(branch)}&since=${since}`,
    );
    stored += await storeCommits(repository.id, branch, commits.map(fromApiCommit));
  }
  await markBackfilled(repository.id);
  return stored;
}

export async function pendingBackfills(): Promise<number[]> {
  return (await repositoriesToBackfill()).map((repository) => repository.id);
}

export async function completePush(push: {
  installationId: number;
  repositoryId: number;
  fullName: string;
  branch: string;
  before: string;
  after: string;
}): Promise<number> {
  const token = await installationToken(push.installationId);
  const commits = await paginate<ApiCommit>(
    token,
    `/repos/${push.fullName}/compare/${push.before}...${push.after}`,
    (page) => page.commits,
    40,
  );
  return storeCommits(push.repositoryId, push.branch, commits.map(fromApiCommit));
}
