import { z } from "zod";
import { getUser, isAdmin } from "../../lib/accounts.ts";
import type { Project } from "../../lib/db/schema.ts";
import { type AvailableBoard, availableBoards, boardLabel, matchBoards } from "../../lib/github/boards.ts";
import {
  crossOwnerWarning,
  linkBoard,
  linkRepository,
  listProjectBoards,
  listProjectRepositories,
  listRepositoryLinks,
  repositoryOwner,
  unlinkBoard,
  unlinkRepository,
} from "../../lib/github/projects.ts";
import { getRepository, listRepositories } from "../../lib/github/store.ts";
import { findProject, listProjects } from "../../lib/memory/projects.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

const names = (items: { fullName: string }[]) => (items.length > 0 ? items.map((item) => item.fullName).join(", ") : "none");
const boardNames = (items: { ownerLogin: string; number: number; title: string }[]) =>
  items.length > 0 ? items.map(boardLabel).join(", ") : "none";

async function listAll(): Promise<string> {
  const [projects, links, repositories, boards] = await Promise.all([
    listProjects(),
    listRepositoryLinks(),
    listRepositories(),
    listProjectBoards(),
  ]);
  if (projects.length === 0) return "There are no projects yet.";
  const byId = new Map(repositories.map((repository) => [repository.id, repository]));
  return projects
    .map((project) => {
      const linked = links.flatMap((link) =>
        link.projectId === project.id && byId.has(link.repositoryId) ? [byId.get(link.repositoryId)!] : [],
      );
      const projectBoards = boards.filter((board) => board.projectId === project.id);
      return `- ${project.name} (${project.slug}): repositories: ${names(linked)}; boards: ${boardNames(projectBoards)}`;
    })
    .join("\n");
}

async function listProject(project: Project): Promise<string> {
  const [linked, linkedBoards, repositories, boards] = await Promise.all([
    listProjectRepositories(project.id),
    listProjectBoards(project.id),
    listRepositories(),
    availableBoards(),
  ]);
  const linkedIds = new Set(linked.map((repository) => repository.id));
  const linkedBoardIds = new Set(linkedBoards.map((board) => board.boardNodeId));
  const byOwner = new Map<string, string[]>();
  for (const repository of repositories) {
    if (linkedIds.has(repository.id) || repository.archived) continue;
    const owner = repositoryOwner(repository.fullName);
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), repository.fullName]);
  }
  const openBoards = boards.filter((board) => !board.closed && !linkedBoardIds.has(board.nodeId));
  const closedCount = boards.filter((board) => board.closed && !linkedBoardIds.has(board.nodeId)).length;
  return [
    `${project.name} (${project.slug})`,
    `Linked repositories: ${names(linked)}`,
    `Linked boards: ${boardNames(linkedBoards)}`,
    "Repositories available to link:",
    ...(byOwner.size > 0 ? [...byOwner].map(([owner, repos]) => `- ${owner}: ${repos.join(", ")}`) : ["- none"]),
    `Open boards available to link: ${boardNames(openBoards)}${closedCount > 0 ? ` (plus ${closedCount} closed)` : ""}`,
  ].join("\n");
}

async function findBoards(references: string[]): Promise<{ found: AvailableBoard[]; problems: string[] }> {
  let boards = await availableBoards();
  if (references.some((reference) => matchBoards(reference, boards).length === 0)) boards = await availableBoards({ fresh: true });
  const found: AvailableBoard[] = [];
  const problems: string[] = [];
  for (const reference of references) {
    const matches = matchBoards(reference, boards);
    if (matches.length === 1) found.push(matches[0]);
    else if (matches.length === 0) problems.push(`Unknown board: ${reference}`);
    else problems.push(`"${reference}" matches several boards, use owner/number: ${boardNames(matches)}`);
  }
  return { found, problems };
}

async function link(project: Project, repositories: string[], boards: string[], userId: string): Promise<string> {
  const lines: string[] = [];
  const linked = await listProjectRepositories(project.id);
  const linkedIds = new Set(linked.map((repository) => repository.id));
  const added: string[] = [];
  for (const name of repositories) {
    const repository = await getRepository(name.trim());
    if (!repository) lines.push(`Unknown repository: ${name} (the GitHub App does not see it)`);
    else if (linkedIds.has(repository.id)) lines.push(`Already linked: ${repository.fullName}`);
    else {
      await linkRepository(project.id, repository.id, userId);
      linkedIds.add(repository.id);
      added.push(repository.fullName);
    }
  }
  if (added.length > 0) lines.unshift(`Linked repositories: ${added.join(", ")}`);
  const warning = crossOwnerWarning(
    linked.map((repository) => repository.fullName),
    added,
  );
  if (warning) lines.push(warning);
  if (boards.length > 0) {
    const { found, problems } = await findBoards(boards);
    for (const board of found) {
      await linkBoard(
        { projectId: project.id, boardNodeId: board.nodeId, ownerLogin: board.ownerLogin, number: board.number, title: board.title },
        userId,
      );
    }
    if (found.length > 0) lines.push(`Linked boards: ${boardNames(found)}`);
    lines.push(...problems);
  }
  return [`${project.name} (${project.slug}):`, ...lines].join("\n");
}

async function unlink(project: Project, repositories: string[], boards: string[]): Promise<string> {
  const lines: string[] = [];
  const linked = await listProjectRepositories(project.id);
  const removed: string[] = [];
  for (const name of repositories) {
    const repository = linked.find((candidate) => candidate.fullName.toLowerCase() === name.trim().toLowerCase());
    if (repository && (await unlinkRepository(project.id, repository.id))) removed.push(repository.fullName);
    else lines.push(`Not linked to this project: ${name}`);
  }
  if (removed.length > 0) lines.unshift(`Unlinked repositories: ${removed.join(", ")}`);
  const linkedBoards = await listProjectBoards(project.id);
  const removedBoards: string[] = [];
  for (const reference of boards) {
    const matches = matchBoards(reference, linkedBoards);
    if (matches.length === 0) lines.push(`Not linked to this project: ${reference}`);
    else if (matches.length > 1) lines.push(`"${reference}" matches several linked boards, use owner/number: ${boardNames(matches)}`);
    else if (await unlinkBoard(project.id, matches[0].boardNodeId)) removedBoards.push(boardLabel(matches[0]));
  }
  if (removedBoards.length > 0) lines.push(`Unlinked boards: ${removedBoards.join(", ")}`);
  return [`${project.name} (${project.slug}):`, ...lines].join("\n");
}

export default defineManfrodTool({
  description:
    "Admin only. Link GitHub repositories and GitHub Projects (v2) boards to Manfrod projects, unlink them, or list the links. list without project shows every project's links; with project it also shows what can be linked.",
  inputSchema: z.object({
    action: z.enum(["list", "link", "unlink"]),
    project: z.string().optional().describe("Project slug or name; required for link and unlink"),
    repositories: z.array(z.string()).optional().describe('Repositories as "owner/name"'),
    boards: z.array(z.string()).optional().describe('Boards as "owner/number", a board URL or the exact board title'),
  }),
  async execute({ action, project: query, repositories = [], boards = [] }, ctx) {
    if (!isAdmin(await getUser(ctx.userId))) return "Only admins can manage GitHub links of projects.";
    if (action === "list" && !query) return listAll();
    if (!query) return `Name the project to ${action}.`;
    const project = await findProject(query);
    if (!project) return `No project matches "${query}". Use action "list" to see all projects.`;
    if (action === "list") return listProject(project);
    if (repositories.length === 0 && boards.length === 0) return `Name the repositories or boards to ${action}.`;
    return action === "link" ? link(project, repositories, boards, ctx.userId) : unlink(project, repositories, boards);
  },
});
