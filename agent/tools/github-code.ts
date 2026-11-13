import { z } from "zod";
import { encodePath, githubErrorMessage, repositoryToken, resolveScope } from "../../lib/github/access.ts";
import { github, githubFetch, GithubError } from "../../lib/github/api.ts";
import { type ContentEntry, formatDirectory, formatFile, formatTreeMatches } from "../../lib/github/format.ts";
import { getRepository } from "../../lib/github/store.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

const MAX_FILE_BYTES = 5_000_000;

interface FileContent extends ContentEntry {
  content?: string;
  encoding?: string;
  target?: string;
  submodule_git_url?: string;
}

async function readFile(token: string, repository: string, file: FileContent, query: string): Promise<string> {
  if (file.type === "symlink") return `${repository}:${file.path} is a symlink to ${file.target ?? "?"}.`;
  if (file.type === "submodule") return `${repository}:${file.path} is a submodule (${file.submodule_git_url ?? "?"}).`;
  if (file.size > MAX_FILE_BYTES) return `${repository}:${file.path} is too large to read (${file.size} B).`;
  if (file.content && file.encoding === "base64")
    return formatFile(repository, file.path, Buffer.from(file.content, "base64").toString("utf8"));
  const response = await githubFetch(
    token,
    "GET",
    `/repos/${repository}/contents/${encodePath(file.path) ?? ""}${query}`,
    undefined,
    "application/vnd.github.raw+json",
  );
  if (!response.ok) throw new GithubError(response.status, `GitHub raw content failed with HTTP ${response.status}`);
  return formatFile(repository, file.path, await response.text());
}

export default defineManfrodTool({
  description:
    "Read code from a GitHub repository: a directory listing, or a file's content (large files are truncated, and the output says so). Pass find to search the whole repository tree for paths containing a substring instead.",
  inputSchema: z.object({
    repository: z.string().describe("Repository as owner/name"),
    path: z.string().optional().describe("File or directory path; omit for the repository root"),
    ref: z.string().optional().describe("Branch, tag or commit sha; default branch when omitted"),
    find: z.string().optional().describe("Case-insensitive substring to find in file paths (searched under path, recursively)"),
  }),
  label: { start: ({ repository, path }) => `Read ${repository}${path ? `/${path}` : ""}` },
  async execute({ repository, path, ref, find }, ctx) {
    const name = repository.trim();
    const token = await repositoryToken(await resolveScope(ctx), name);
    if (!token.ok) return token.message;
    const cleanPath = encodePath(path ?? "");
    if (cleanPath === null) return `ERROR: Paths may not contain "." or ".." segments.`;
    try {
      if (find?.trim()) {
        const tree = ref ?? (await getRepository(name))?.defaultBranch ?? "HEAD";
        const result = await github<{ tree: { path: string; type: string }[]; truncated: boolean }>(
          token.token,
          "GET",
          `/repos/${name}/git/trees/${encodeURIComponent(tree)}?recursive=1`,
        );
        if (!result) return `ERROR: ${name}@${tree} was not found or is not readable here.`;
        const prefix = decodeURIComponent(cleanPath);
        const paths = result.tree
          .map((entry) => (entry.type === "tree" ? `${entry.path}/` : entry.path))
          .filter((entry) => !prefix || entry.startsWith(`${prefix}/`));
        return formatTreeMatches(name, find.trim(), paths, result.truncated);
      }
      const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const content = await github<FileContent | ContentEntry[]>(token.token, "GET", `/repos/${name}/contents/${cleanPath}${query}`);
      if (!content) return `ERROR: ${name}:${path ?? "/"}${ref ? `@${ref}` : ""} was not found or is not readable here.`;
      if (Array.isArray(content)) return formatDirectory(name, decodeURIComponent(cleanPath), content);
      return await readFile(token.token, name, content, query);
    } catch (error) {
      return githubErrorMessage(error);
    }
  },
});
