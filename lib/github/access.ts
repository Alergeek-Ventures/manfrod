import { createHash } from "node:crypto";
import { isBackgroundKind, type ToolCtx } from "../agent/context.ts";
import { config } from "../config.ts";
import type { GithubRepository } from "../db/schema.ts";
import { type ChannelAudience, channelAudience, getActiveMapping } from "../memory/access.ts";
import { userToken } from "./accounts.ts";
import { github, GithubError, installationToken, paginate, repositoryReadToken } from "./api.ts";
import { type BoardRef, parseBoardRef } from "./boards.ts";
import { type LinkedBoard, listProjectBoards, listProjectRepositories } from "./projects.ts";
import { listInstallations } from "./store.ts";

export interface GithubScope {
  userId: string;
  audience: ChannelAudience;
  mapped: boolean;
  background: boolean;
  projectId: string | null;
  repositories: GithubRepository[];
  boards: LinkedBoard[];
}

export type RepositoryDecision =
  { use: "installation"; repository: GithubRepository } | { use: "user" } | { use: "denied"; reason: "outside_project" | "no_project" };

export type BoardDecision =
  | { use: "installation"; boards: LinkedBoard[] }
  | { use: "user"; owner: string; number: number }
  | { use: "denied"; reason: "outside_project" | "no_project" | "no_board" | "unknown_board" };

export type TokenResult = { ok: true; token: string; via: "installation" | "user" } | { ok: false; message: string };

const CACHE_MS = 5 * 60_000;
const REPOSITORY_NAME = /^[\w.-]+\/[\w.-]+$/;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const isRepositoryName = (value: string) =>
  REPOSITORY_NAME.test(value) && value.split("/").every((part) => part !== "." && part !== "..");

export const allowsPersonal = (scope: Pick<GithubScope, "audience" | "background" | "mapped">) =>
  !scope.background && (scope.audience === "dm" || (scope.audience === "internal" && scope.mapped));

export function decideRepository(scope: GithubScope, fullName: string): RepositoryDecision {
  const linked = scope.repositories.find((repository) => same(repository.fullName, fullName));
  if (linked) return { use: "installation", repository: linked };
  if (allowsPersonal(scope)) return { use: "user" };
  return { use: "denied", reason: scope.projectId ? "outside_project" : "no_project" };
}

const boardMatches = (board: LinkedBoard, ref: BoardRef) =>
  "title" in ref ? same(board.title, ref.title) : same(board.ownerLogin, ref.ownerLogin) && board.number === ref.number;

export function decideBoard(scope: GithubScope, value: string | undefined, knownBoards: LinkedBoard[] = []): BoardDecision {
  if (!value?.trim())
    return scope.boards.length > 0 ? { use: "installation", boards: scope.boards } : { use: "denied", reason: "no_board" };
  const ref = parseBoardRef(value);
  const linked = scope.boards.filter((board) => boardMatches(board, ref));
  if (linked.length > 0) return { use: "installation", boards: linked };
  if (!allowsPersonal(scope)) return { use: "denied", reason: scope.projectId ? "outside_project" : "no_project" };
  if (!("title" in ref)) return { use: "user", owner: ref.ownerLogin, number: ref.number };
  const known = knownBoards.find((board) => boardMatches(board, ref));
  return known ? { use: "user", owner: known.ownerLogin, number: known.number } : { use: "denied", reason: "unknown_board" };
}

export const integrationsUrl = () => `${config.appUrl}/integrations`;

export function connectionMessage(error: string): string {
  if (error === "not_connected") {
    return `ERROR: The user has not connected their GitHub account, so only repositories linked to this channel's project are available. They can connect it at ${integrationsUrl()}`;
  }
  if (error === "expired") return `ERROR: The user's GitHub connection has expired. They can reconnect it at ${integrationsUrl()}`;
  return `ERROR: Could not use the user's GitHub connection (${error}).`;
}

export function deniedMessage(scope: GithubScope, reason: string, what = "repository"): string {
  const linked =
    what === "board"
      ? scope.boards.map((board) => `${board.ownerLogin}/${board.number} (${board.title})`)
      : scope.repositories.map((repository) => repository.fullName);
  const available = linked.length > 0 ? ` Available here: ${linked.join(", ")}.` : "";
  if (reason === "no_board") return `ERROR: No board is linked to this channel's project. Pass a board as owner/number.${available}`;
  if (reason === "unknown_board") return `ERROR: No linked board has that title. Pass it as owner/number.${available}`;
  if (reason === "no_project") return `ERROR: GitHub data is only available in project channels, DMs and internal channels.`;
  return `ERROR: In this channel only the ${what === "board" ? "boards" : "repositories"} linked to its project are available.${available}`;
}

export async function resolveScope(ctx: ToolCtx): Promise<GithubScope> {
  const channel = ctx.msgCtx.channel;
  const mapping = await getActiveMapping(channel);
  const projectId = mapping?.projectId ?? null;
  const [audience, repositories, boards] = await Promise.all([
    channelAudience(channel),
    projectId ? listProjectRepositories(projectId) : Promise.resolve([]),
    projectId ? listProjectBoards(projectId) : Promise.resolve([]),
  ]);
  return {
    userId: ctx.userId,
    audience,
    mapped: mapping !== null,
    background: isBackgroundKind(ctx.kind),
    projectId,
    repositories,
    boards,
  };
}

async function appToken(mint: () => Promise<string>): Promise<TokenResult> {
  try {
    return { ok: true, token: await mint(), via: "installation" };
  } catch (error) {
    if (error instanceof GithubError) return { ok: false, message: `ERROR: Could not get a GitHub App token (HTTP ${error.status}).` };
    throw error;
  }
}

export async function personalToken(userId: string): Promise<TokenResult> {
  const token = await userToken(userId);
  return token.ok ? { ok: true, token: token.value, via: "user" } : { ok: false, message: connectionMessage(token.error) };
}

export async function repositoryToken(scope: GithubScope, fullName: string): Promise<TokenResult> {
  if (!isRepositoryName(fullName)) return { ok: false, message: `ERROR: Pass the repository as owner/name, got "${fullName}".` };
  const decision = decideRepository(scope, fullName);
  if (decision.use === "denied") return { ok: false, message: deniedMessage(scope, decision.reason) };
  if (decision.use === "installation") {
    const { installationId, fullName: linkedName } = decision.repository;
    return appToken(() => repositoryReadToken(installationId, linkedName));
  }
  return personalToken(scope.userId);
}

export async function boardToken(scope: GithubScope, owner: string, via: "installation" | "user"): Promise<TokenResult> {
  if (via === "installation") {
    const installation = (await listInstallations()).find((entry) => same(entry.accountLogin, owner) && !entry.suspendedAt);
    if (installation) return appToken(() => installationToken(installation.id));
    if (!allowsPersonal(scope)) return { ok: false, message: `ERROR: The GitHub App is not installed on ${owner}.` };
  }
  return personalToken(scope.userId);
}

const tokenKey = (userId: string, token: string) => `${userId}:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;

const repositoryChecks = new Map<string, { allowed: boolean; at: number }>();

export async function userCanRead(userId: string, token: string, fullName: string): Promise<boolean> {
  const key = `${tokenKey(userId, token)}:${fullName.toLowerCase()}`;
  const cached = repositoryChecks.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.allowed;
  const repository = await github<{ full_name: string }>(token, "GET", `/repos/${fullName}`).catch(() => null);
  repositoryChecks.set(key, { allowed: repository !== null, at: Date.now() });
  return repository !== null;
}

export interface AccessibleRepository {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
  archived: boolean;
}

const userRepositoryCache = new Map<string, { repositories: AccessibleRepository[]; at: number }>();

export async function userRepositories(userId: string, token: string): Promise<AccessibleRepository[]> {
  const key = tokenKey(userId, token);
  const cached = userRepositoryCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.repositories;
  const installations = await paginate<{ id: number }>(token, "/user/installations", (page) => page.installations);
  const repositories: AccessibleRepository[] = [];
  for (const installation of installations) {
    repositories.push(
      ...(await paginate<AccessibleRepository>(token, `/user/installations/${installation.id}/repositories`, (page) => page.repositories)),
    );
  }
  repositories.sort((a, b) => a.full_name.localeCompare(b.full_name));
  userRepositoryCache.set(key, { repositories, at: Date.now() });
  return repositories;
}

export function githubErrorMessage(error: unknown): string {
  if (!(error instanceof GithubError)) throw error;
  if (error.status === 401 || error.status === 403) {
    return `ERROR: GitHub refused the request (HTTP ${error.status}). The token used here may lack access or permission for this.`;
  }
  return `ERROR: GitHub request failed (HTTP ${error.status}).`;
}

export function encodePath(path: string): string | null {
  const segments = path.split("/").filter(Boolean);
  if (path.includes("\\") || segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}
