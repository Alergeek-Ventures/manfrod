import { z } from "zod";
import { getAccount, listAccounts } from "../../lib/github/accounts.ts";
import {
  connectionMessage,
  decideRepository,
  deniedMessage,
  githubErrorMessage,
  type GithubScope,
  isInternal,
  isRepositoryName,
  resolveScope,
} from "../../lib/github/access.ts";
import { commitWindow, formatCommits } from "../../lib/github/format.ts";
import { getRepository, listCommits } from "../../lib/github/store.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

type Resolved<T> = { ok: true; value: T } | { ok: false; message: string };

async function repositoryIds(scope: GithubScope, repository: string | undefined, mine: boolean): Promise<Resolved<number[] | undefined>> {
  if (repository) {
    if (!isRepositoryName(repository)) return { ok: false, message: `ERROR: Pass the repository as owner/name, got "${repository}".` };
    const decision = decideRepository(scope, repository, isInternal(scope) ? await getRepository(repository) : null);
    if (decision.use === "denied") return { ok: false, message: deniedMessage(scope, decision.reason) };
    if (decision.use === "user")
      return { ok: false, message: `No commits are stored for ${repository}: the GitHub App is not installed on it.` };
    return { ok: true, value: [decision.repository.id] };
  }
  const project = scope.repositories.map((entry) => entry.id);
  if (isInternal(scope)) return { ok: true, value: !mine && project.length > 0 ? project : undefined };
  return project.length > 0 ? { ok: true, value: project } : { ok: false, message: deniedMessage(scope, "no_project") };
}

export default defineManfrodTool({
  description:
    "List recent GitHub commits from every branch (default: the last 7 days). Without a repository it covers this channel's project repositories when it has any, otherwise (and for author \"me\") every repository in DMs and internal channels; client channels only see the project's repositories. One line per commit: time (Europe/Warsaw), repository, branches, short sha, first line of the message, author.",
  inputSchema: z.object({
    repository: z
      .string()
      .optional()
      .describe('Repository as owner/name. Omit for the project\'s repositories (or all of yours with author "me").'),
    author: z.string().optional().describe('"me" for the person asking, or a GitHub login'),
    since: z.string().optional().describe("Start, YYYY-MM-DD (Europe/Warsaw) or an ISO timestamp. Default: 7 days ago."),
    until: z.string().optional().describe("End, YYYY-MM-DD (inclusive, Europe/Warsaw) or an ISO timestamp. Default: now."),
    branch: z.string().optional().describe("Only commits on this branch"),
    limit: z.number().int().optional().describe("Max commits to show (default 50, max 200)"),
  }),
  label: { start: ({ repository, author }) => `Check commits${repository ? ` in ${repository}` : ""}${author ? ` by ${author}` : ""}` },
  async execute({ repository, author, since, until, branch, limit }, ctx) {
    const window = commitWindow(since, until);
    if (!window.ok) return window.message;
    const count = Math.min(Math.max(limit ?? 50, 1), 200);
    const scope = await resolveScope(ctx);
    const login = author?.trim().replace(/^@/, "");
    const mine = login?.toLowerCase() === "me";

    let authorFilter: { login: string; emails: string[] } | undefined;
    if (mine) {
      const account = await getAccount(ctx.userId);
      if (!account) return connectionMessage("not_connected");
      authorFilter = { login: account.login, emails: account.emails };
    } else if (login) {
      const known = (await listAccounts()).find((account) => account.login.toLowerCase() === login.toLowerCase());
      authorFilter = { login, emails: known?.emails ?? [] };
    }

    const ids = await repositoryIds(scope, repository?.trim(), mine).catch((error: unknown): Resolved<undefined> => ({
      ok: false,
      message: githubErrorMessage(error),
    }));
    if (!ids.ok) return ids.message;

    const commits = await listCommits({
      since: window.since,
      until: window.until,
      repositoryIds: ids.value,
      author: authorFilter,
      branch: branch?.trim() || undefined,
      limit: count + 1,
    });
    return formatCommits(commits, count);
  },
});
