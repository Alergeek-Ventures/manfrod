import { z } from "zod";
import { getAccount, listAccounts } from "../../lib/github/accounts.ts";
import {
  allowsPersonal,
  connectionMessage,
  decideRepository,
  deniedMessage,
  githubErrorMessage,
  type GithubScope,
  isRepositoryName,
  personalToken,
  resolveScope,
  userCanRead,
  userRepositories,
} from "../../lib/github/access.ts";
import { commitWindow, formatCommits } from "../../lib/github/format.ts";
import { getRepository, listCommits } from "../../lib/github/store.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

type Resolved<T> = { ok: true; value: T } | { ok: false; message: string };

async function repositoryIds(scope: GithubScope, repository: string | undefined, mine: boolean): Promise<Resolved<number[] | undefined>> {
  if (repository) {
    if (!isRepositoryName(repository)) return { ok: false, message: `ERROR: Pass the repository as owner/name, got "${repository}".` };
    const decision = decideRepository(scope, repository);
    if (decision.use === "denied") return { ok: false, message: deniedMessage(scope, decision.reason) };
    if (decision.use === "installation") return { ok: true, value: [decision.repository.id] };
    const stored = await getRepository(repository);
    if (!stored) return { ok: false, message: `No commits are stored for ${repository}: the GitHub App is not installed on it.` };
    const token = await personalToken(scope.userId);
    if (!token.ok) return token;
    if (!(await userCanRead(scope.userId, token.token, stored.fullName))) {
      return { ok: false, message: `ERROR: The person's GitHub account cannot read ${repository}.` };
    }
    return { ok: true, value: [stored.id] };
  }
  if (!mine && scope.repositories.length > 0) return { ok: true, value: scope.repositories.map((entry) => entry.id) };
  if (!allowsPersonal(scope)) {
    return scope.repositories.length > 0
      ? { ok: true, value: scope.repositories.map((entry) => entry.id) }
      : { ok: false, message: deniedMessage(scope, "no_project") };
  }
  const token = await personalToken(scope.userId);
  if (!token.ok) return token;
  return { ok: true, value: (await userRepositories(scope.userId, token.token)).map((entry) => entry.id) };
}

export default defineManfrodTool({
  description:
    "List recent GitHub commits from every branch (default: the last 7 days). In a project channel it covers the project's linked repositories; author \"me\" in a DM or internal channel covers the person's own commits in all repositories. One line per commit: time (Europe/Warsaw), repository, branches, short sha, first line of the message, author.",
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
