import { and, desc, eq, gte, inArray, lt, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { GithubAccount, GithubInstallation, GithubRepository } from "../db/schema.ts";

const { githubCommits, githubInstallations, githubRepositories } = tables;

export interface InstallationInput {
  id: number;
  account: { id: number; login: string; type: string };
  repository_selection: string;
  suspended_at?: string | null;
}

export interface RepositoryInput {
  id: number;
  full_name: string;
  private: boolean;
  default_branch?: string;
  archived?: boolean;
}

export interface CommitInput {
  sha: string;
  authorLogin: string | null;
  authorEmail: string | null;
  authorName: string | null;
  authoredAt: Date;
  committedAt?: Date | null;
  message: string;
  url: string;
}

export interface StoredCommit extends CommitInput {
  repository: string;
  branches: string[];
}

export async function upsertInstallation(installation: InstallationInput, installedByUserId: string | null = null): Promise<void> {
  const values = {
    accountId: installation.account.id,
    accountLogin: installation.account.login,
    accountType: installation.account.type,
    repositorySelection: installation.repository_selection,
    suspendedAt: installation.suspended_at ? new Date(installation.suspended_at) : null,
    updatedAt: new Date(),
  };
  await db
    .insert(githubInstallations)
    .values({ id: installation.id, ...values, installedByUserId })
    .onConflictDoUpdate({
      target: githubInstallations.id,
      set: installedByUserId ? { ...values, installedByUserId } : values,
    });
}

export async function deleteInstallation(id: number): Promise<void> {
  await db.delete(githubInstallations).where(eq(githubInstallations.id, id));
}

export async function setInstallationSuspended(id: number, suspended: boolean): Promise<void> {
  await db
    .update(githubInstallations)
    .set({ suspendedAt: suspended ? new Date() : null, updatedAt: new Date() })
    .where(eq(githubInstallations.id, id));
}

export async function markInstallationSynced(id: number): Promise<void> {
  await db.update(githubInstallations).set({ syncedAt: new Date() }).where(eq(githubInstallations.id, id));
}

export async function listInstallations(): Promise<GithubInstallation[]> {
  return db.select().from(githubInstallations).orderBy(githubInstallations.accountLogin);
}

export async function pruneInstallations(keep: number[]): Promise<void> {
  await db.delete(githubInstallations).where(keep.length > 0 ? notInArray(githubInstallations.id, keep) : undefined);
}

export async function upsertRepositories(installationId: number, repositories: RepositoryInput[]): Promise<void> {
  for (const repository of repositories) {
    const values = {
      installationId,
      fullName: repository.full_name,
      private: repository.private,
      ...(repository.default_branch ? { defaultBranch: repository.default_branch } : {}),
      ...(repository.archived === undefined ? {} : { archived: repository.archived }),
      updatedAt: new Date(),
    };
    await db
      .update(githubRepositories)
      .set({ fullName: sql`${githubRepositories.fullName} || '#stale-' || ${githubRepositories.id}` })
      .where(
        and(sql`lower(${githubRepositories.fullName}) = ${repository.full_name.toLowerCase()}`, ne(githubRepositories.id, repository.id)),
      );
    await db
      .insert(githubRepositories)
      .values({ id: repository.id, defaultBranch: "main", ...values })
      .onConflictDoUpdate({ target: githubRepositories.id, set: values });
  }
}

export async function removeRepositories(ids: number[]): Promise<void> {
  if (ids.length > 0) await db.delete(githubRepositories).where(inArray(githubRepositories.id, ids));
}

export async function pruneRepositories(installationId: number, keep: number[]): Promise<void> {
  await db
    .delete(githubRepositories)
    .where(
      and(eq(githubRepositories.installationId, installationId), keep.length > 0 ? notInArray(githubRepositories.id, keep) : undefined),
    );
}

export async function listRepositories(installationId?: number): Promise<GithubRepository[]> {
  return db
    .select()
    .from(githubRepositories)
    .where(installationId === undefined ? undefined : eq(githubRepositories.installationId, installationId))
    .orderBy(githubRepositories.fullName);
}

export async function getRepository(idOrName: number | string): Promise<GithubRepository | null> {
  const [row] = await db
    .select()
    .from(githubRepositories)
    .where(
      typeof idOrName === "number"
        ? eq(githubRepositories.id, idOrName)
        : sql`lower(${githubRepositories.fullName}) = ${idOrName.toLowerCase()}`,
    )
    .limit(1);
  return row ?? null;
}

export async function repositoriesToBackfill(): Promise<GithubRepository[]> {
  return db
    .select()
    .from(githubRepositories)
    .where(sql`${githubRepositories.backfilledAt} IS NULL`);
}

export async function markBackfilled(id: number): Promise<void> {
  await db.update(githubRepositories).set({ backfilledAt: new Date() }).where(eq(githubRepositories.id, id));
}

export const landedAt = (commit: Pick<CommitInput, "authoredAt" | "committedAt">) => commit.committedAt ?? commit.authoredAt;

const landedColumn = sql<Date>`coalesce(${githubCommits.committedAt}, ${githubCommits.authoredAt})`;

async function isDefaultBranch(repositoryId: number, branch: string | null): Promise<boolean> {
  if (!branch) return false;
  const [repository] = await db
    .select({ defaultBranch: githubRepositories.defaultBranch })
    .from(githubRepositories)
    .where(eq(githubRepositories.id, repositoryId))
    .limit(1);
  return repository?.defaultBranch === branch;
}

export async function storeCommits(repositoryId: number, branch: string | null, commits: CommitInput[]): Promise<number> {
  if (commits.length === 0) return 0;
  const rows = commits.map((commit) => ({ repositoryId, ...commit, branches: branch ? [branch] : [] }));
  const onDefault = await isDefaultBranch(repositoryId, branch);
  await db
    .insert(githubCommits)
    .values(rows)
    .onConflictDoUpdate({
      target: [githubCommits.repositoryId, githubCommits.sha],
      set: {
        branches: sql`array(select distinct unnest(${githubCommits.branches} || excluded.branches))`,
        authorLogin: sql`coalesce(excluded.author_login, ${githubCommits.authorLogin})`,
        committedAt: onDefault
          ? sql`coalesce(excluded.committed_at, ${githubCommits.committedAt})`
          : sql`coalesce(${githubCommits.committedAt}, excluded.committed_at)`,
      },
    });
  return rows.length;
}

export async function deleteCommitsBefore(cutoff: Date): Promise<void> {
  await db.delete(githubCommits).where(lt(landedColumn, cutoff));
}

export function authoredBy(account: Pick<GithubAccount, "login" | "emails">): SQL {
  const byLogin = sql`lower(${githubCommits.authorLogin}) = ${account.login.toLowerCase()}`;
  if (account.emails.length === 0) return byLogin;
  const emails = account.emails.map((email) => email.toLowerCase());
  return or(byLogin, inArray(sql`lower(${githubCommits.authorEmail})`, emails))!;
}

export async function listCommits(filter: {
  since: Date;
  until?: Date;
  repositoryIds?: number[];
  author?: Pick<GithubAccount, "login" | "emails">;
  branch?: string;
  limit?: number;
  time?: "landed" | "written";
}): Promise<StoredCommit[]> {
  if (filter.repositoryIds && filter.repositoryIds.length === 0) return [];
  const landed = filter.time === "written" ? sql<Date>`${githubCommits.authoredAt}` : landedColumn;
  const rows = await db
    .select({ commit: githubCommits, repository: githubRepositories.fullName })
    .from(githubCommits)
    .innerJoin(githubRepositories, eq(githubRepositories.id, githubCommits.repositoryId))
    .where(
      and(
        gte(landed, filter.since),
        filter.until ? lt(landed, filter.until) : undefined,
        filter.repositoryIds ? inArray(githubCommits.repositoryId, filter.repositoryIds) : undefined,
        filter.author ? authoredBy(filter.author) : undefined,
        filter.branch ? sql`${filter.branch} = ANY(${githubCommits.branches})` : undefined,
      ),
    )
    .orderBy(desc(landed))
    .limit(filter.limit ?? 200);
  return rows.map(({ commit, repository }) => ({
    sha: commit.sha,
    authorLogin: commit.authorLogin,
    authorEmail: commit.authorEmail,
    authorName: commit.authorName,
    authoredAt: commit.authoredAt,
    committedAt: commit.committedAt,
    message: commit.message,
    url: commit.url,
    branches: commit.branches,
    repository,
  }));
}
