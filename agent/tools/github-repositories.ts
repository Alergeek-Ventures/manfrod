import { z } from "zod";
import {
  allowsPersonal,
  deniedMessage,
  githubErrorMessage,
  personalToken,
  resolveScope,
  userRepositories,
} from "../../lib/github/access.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

const details = (isPrivate: boolean, defaultBranch: string, archived: boolean) =>
  `${isPrivate ? "private" : "public"}, default branch ${defaultBranch}${archived ? ", archived" : ""}`;

export default defineManfrodTool({
  description:
    "List the GitHub repositories and task boards you can read in this conversation: those linked to this channel's project and, in DMs and internal channels, every repository the person's own connected GitHub account can see. Use it to find the owner/name for the other github-* tools.",
  inputSchema: z.object({}),
  label: { start: () => "List GitHub repositories" },
  async execute(_input, ctx) {
    const scope = await resolveScope(ctx);
    const sections: string[] = [];
    const linked = new Set(scope.repositories.map((repository) => repository.fullName.toLowerCase()));
    if (scope.repositories.length > 0) {
      const lines = scope.repositories.map(
        (repository) => `${repository.fullName} (${details(repository.private, repository.defaultBranch, repository.archived)})`,
      );
      sections.push(`Repositories linked to this channel's project:\n${lines.join("\n")}`);
    }
    if (scope.boards.length > 0) {
      const lines = scope.boards.map((board) => `${board.ownerLogin}/${board.number} ${board.title}`);
      sections.push(`Boards linked to this project:\n${lines.join("\n")}`);
    }
    if (allowsPersonal(scope)) {
      const token = await personalToken(ctx.userId);
      if (!token.ok) sections.push(token.message);
      else {
        try {
          const own = (await userRepositories(ctx.userId, token.token)).filter(
            (repository) => !linked.has(repository.full_name.toLowerCase()),
          );
          const lines = own.map(
            (repository) => `${repository.full_name} (${details(repository.private, repository.default_branch, repository.archived)})`,
          );
          if (lines.length > 0) sections.push(`Readable with the person's GitHub account:\n${lines.join("\n")}`);
        } catch (error) {
          sections.push(githubErrorMessage(error));
        }
      }
    }
    if (sections.length > 0) return sections.join("\n\n");
    return scope.projectId ? "No GitHub repositories or boards are linked to this channel's project." : deniedMessage(scope, "no_project");
  },
});
