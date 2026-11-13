import { z } from "zod";
import type { GithubRepository } from "../../lib/db/schema.ts";
import { deniedMessage, githubErrorMessage, isInternal, resolveScope, userRepositories } from "../../lib/github/access.ts";
import { userToken } from "../../lib/github/accounts.ts";
import { listRepositories } from "../../lib/github/store.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

const details = (isPrivate: boolean, defaultBranch: string, archived: boolean) =>
  `${isPrivate ? "private" : "public"}, default branch ${defaultBranch}${archived ? ", archived" : ""}`;

export default defineManfrodTool({
  description:
    "List the GitHub repositories and task boards you can read in this conversation. In DMs and internal channels that is every repository the GitHub App can read (plus any extra ones the person's own GitHub account sees), with this channel's project repositories listed first; client channels only see the project's repositories. Use it to find the owner/name for the other github-* tools.",
  inputSchema: z.object({}),
  label: { start: () => "List GitHub repositories" },
  async execute(_input, ctx) {
    const scope = await resolveScope(ctx);
    const sections: string[] = [];
    const describe = (repository: GithubRepository) =>
      `${repository.fullName} (${details(repository.private, repository.defaultBranch, repository.archived)})`;
    if (scope.repositories.length > 0) {
      sections.push(`Repositories of this channel's project:\n${scope.repositories.map(describe).join("\n")}`);
    }
    if (scope.boards.length > 0) {
      const lines = scope.boards.map((board) => `${board.ownerLogin}/${board.number} ${board.title}`);
      sections.push(`Boards of this channel's project:\n${lines.join("\n")}`);
    }
    if (!isInternal(scope)) {
      if (sections.length > 0) return sections.join("\n\n");
      return scope.projectId
        ? "No GitHub repositories or boards are linked to this channel's project."
        : deniedMessage(scope, "no_project");
    }
    const linked = new Set(scope.repositories.map((repository) => repository.id));
    const installed = (await listRepositories()).filter((repository) => !linked.has(repository.id));
    if (installed.length > 0) sections.push(`Other repositories the GitHub App can read:\n${installed.map(describe).join("\n")}`);
    const token = await userToken(ctx.userId);
    if (token.ok) {
      try {
        const known = new Set([...scope.repositories, ...installed].map((repository) => repository.fullName.toLowerCase()));
        const own = (await userRepositories(ctx.userId, token.value)).filter(
          (repository) => !known.has(repository.full_name.toLowerCase()),
        );
        const lines = own.map(
          (repository) => `${repository.full_name} (${details(repository.private, repository.default_branch, repository.archived)})`,
        );
        if (lines.length > 0) sections.push(`Also readable with the person's own GitHub account:\n${lines.join("\n")}`);
      } catch (error) {
        sections.push(githubErrorMessage(error));
      }
    }
    return sections.length > 0 ? sections.join("\n\n") : "The GitHub App cannot read any repositories yet.";
  },
});
