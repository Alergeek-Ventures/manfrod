import { logger } from "../log.ts";
import { graphql, installationToken } from "./api.ts";
import { listInstallations } from "./store.ts";

const log = logger("Github.Boards");
const CACHE_MS = 5 * 60_000;
const MAX_PAGES = 10;

export interface AvailableBoard {
  nodeId: string;
  ownerLogin: string;
  number: number;
  title: string;
  closed: boolean;
  url: string;
}

export type BoardRef = { ownerLogin: string; number: number } | { title: string };

interface ProjectsPage {
  projectsV2: {
    nodes: ({ id: string; number: number; title: string; closed: boolean; url: string } | null)[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

const ownerQuery = (field: "organization" | "user") => `
  query($login: String!, $after: String) {
    owner: ${field}(login: $login) {
      projectsV2(first: 100, after: $after) {
        nodes { id number title closed url }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

let cache: { at: number; boards: AvailableBoard[] } | null = null;

async function ownerBoards(installationId: number, login: string, accountType: string): Promise<AvailableBoard[]> {
  const token = await installationToken(installationId);
  const query = ownerQuery(accountType === "Organization" ? "organization" : "user");
  const boards: AvailableBoard[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data: { owner: ProjectsPage | null } = await graphql(token, query, { login, after });
    if (!data.owner) break;
    for (const node of data.owner.projectsV2.nodes) {
      if (node)
        boards.push({ nodeId: node.id, ownerLogin: login, number: node.number, title: node.title, closed: node.closed, url: node.url });
    }
    if (!data.owner.projectsV2.pageInfo.hasNextPage) break;
    after = data.owner.projectsV2.pageInfo.endCursor;
  }
  return boards;
}

export async function availableBoards(options: { fresh?: boolean } = {}): Promise<AvailableBoard[]> {
  if (!options.fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.boards;
  const boards: AvailableBoard[] = [];
  for (const installation of await listInstallations()) {
    if (installation.suspendedAt) continue;
    try {
      boards.push(...(await ownerBoards(installation.id, installation.accountLogin, installation.accountType)));
    } catch (error) {
      log.warn(`Listing Projects v2 boards of ${installation.accountLogin} failed: ${(error as Error).message}`);
    }
  }
  boards.sort((a, b) => a.ownerLogin.localeCompare(b.ownerLogin) || a.title.localeCompare(b.title));
  cache = { at: Date.now(), boards };
  return boards;
}

export function parseBoardRef(reference: string): BoardRef {
  const text = reference.trim();
  const url = text.match(/^https?:\/\/github\.com\/(?:orgs|users)\/([^/\s]+)\/projects\/(\d+)(?:\/views\/\d+)?\/?(?:[?#].*)?$/i);
  if (url) return { ownerLogin: url[1], number: Number(url[2]) };
  const short = text.match(/^@?([A-Za-z0-9-]+)\s*[/#]\s*(\d+)$/);
  if (short) return { ownerLogin: short[1], number: Number(short[2]) };
  return { title: text };
}

export function matchBoards<T extends { ownerLogin: string; number: number; title: string }>(reference: string, boards: T[]): T[] {
  const ref = parseBoardRef(reference);
  if ("title" in ref) {
    const title = ref.title.toLowerCase();
    return boards.filter((board) => board.title.toLowerCase() === title);
  }
  const owner = ref.ownerLogin.toLowerCase();
  return boards.filter((board) => board.ownerLogin.toLowerCase() === owner && board.number === ref.number);
}

export const boardLabel = (board: { ownerLogin: string; number: number; title: string }) =>
  `${board.title} (${board.ownerLogin}/${board.number})`;
