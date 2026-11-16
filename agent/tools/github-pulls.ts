import { z } from "zod";
import { githubErrorMessage, repositoryToken, resolveScope } from "../../lib/github/access.ts";
import { github, paginate } from "../../lib/github/api.ts";
import {
  type CheckRun,
  checksSummary,
  formatPull,
  formatPullList,
  matchesPull,
  type PullDetail,
  type PullFile,
  type PullReview,
  type PullSummary,
} from "../../lib/github/format.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

const SEARCH_PAGES = 5;

async function pullDetails(token: string, repository: string, number: number): Promise<string> {
  const pull = await github<PullDetail>(token, "GET", `/repos/${repository}/pulls/${number}`);
  if (!pull) return `ERROR: Pull request #${number} was not found in ${repository}.`;
  const sha = pull.head.sha;
  const [files, reviews, runs, statuses] = await Promise.all([
    paginate<PullFile>(token, `/repos/${repository}/pulls/${number}/files`, undefined, 3).catch(() => []),
    paginate<PullReview>(token, `/repos/${repository}/pulls/${number}/reviews`, undefined, 3).catch(() => []),
    github<{ check_runs: CheckRun[] }>(token, "GET", `/repos/${repository}/commits/${sha}/check-runs?per_page=100`)
      .then((result) => result?.check_runs ?? [])
      .catch(() => null),
    github<{ statuses: { context: string; state: string }[] }>(token, "GET", `/repos/${repository}/commits/${sha}/status`)
      .then((result) => result?.statuses ?? [])
      .catch(() => []),
  ]);
  return formatPull(repository, pull, files, reviews, checksSummary(runs, statuses));
}

export default defineManfrodTool({
  description:
    "Read GitHub pull requests: list a repository's pull requests (most recently updated first, with when each was merged or closed), find the ones whose title or branch contains search (e.g. a task ID like ONS-139, looking through the last 500), or pass number for one pull request with its description, changed files, review state and checks. A merged pull request's merge time is when its changes reached the base branch; use it, not commit dates, for when something was merged.",
  inputSchema: z.object({
    repository: z.string().describe("Repository as owner/name"),
    number: z.number().int().optional().describe("Pull request number for its details"),
    state: z.enum(["open", "closed", "all"]).optional().describe("Which pull requests to list (default open)"),
    search: z.string().optional().describe("Text the title or branch must contain, e.g. a task ID like 'ONS-139'"),
    limit: z.number().int().min(1).max(100).optional().describe("How many pull requests to list without search (default 30)"),
  }),
  label: { start: ({ repository, number }) => (number ? `Read ${repository}#${number}` : `List pull requests in ${repository}`) },
  async execute({ repository, number, state, search, limit }, ctx) {
    const name = repository.trim();
    const token = await repositoryToken(await resolveScope(ctx), name);
    if (!token.ok) return token.message;
    try {
      if (number !== undefined) return await pullDetails(token.token, name, number);
      if (search?.trim()) {
        const all = await paginate<PullSummary>(
          token.token,
          `/repos/${name}/pulls?state=${state ?? "all"}&sort=updated&direction=desc`,
          undefined,
          SEARCH_PAGES,
        );
        return formatPullList(
          name,
          all.filter((pull) => matchesPull(pull, search)),
        );
      }
      const pulls = await github<PullSummary[]>(
        token.token,
        "GET",
        `/repos/${name}/pulls?state=${state ?? "open"}&sort=updated&direction=desc&per_page=${limit ?? 30}`,
      );
      if (!pulls) return `ERROR: ${name} was not found or is not readable here.`;
      return formatPullList(name, pulls);
    } catch (error) {
      return githubErrorMessage(error);
    }
  },
});
