import { createSign } from "node:crypto";
import { config } from "../config.ts";

export const GITHUB_API = "https://api.github.com";

export class GithubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function appJwt(): string {
  const appId = config.githubAppId;
  const privateKey = config.githubAppPrivateKey;
  if (!appId || !privateKey) throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set.");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
}

export async function githubFetch(token: string, method: string, path: string, body?: unknown, accept = "application/vnd.github+json") {
  return fetch(path.startsWith("https://") ? path : `${GITHUB_API}${path}`, {
    method,
    headers: {
      accept,
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

export async function github<T>(token: string, method: string, path: string, body?: unknown): Promise<T | null> {
  const response = await githubFetch(token, method, path, body);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new GithubError(
      response.status,
      `GitHub ${method} ${path} failed with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
}

const nextLink = (header: string | null) => header?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;

export async function paginate<T>(token: string, path: string, pick?: (page: any) => T[], maxPages = 1000): Promise<T[]> {
  const items: T[] = [];
  let url: string | null = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  for (let page = 0; url && page < maxPages; page += 1) {
    const response = await githubFetch(token, "GET", url);
    if (response.status === 404 || response.status === 409) break;
    if (!response.ok) throw new GithubError(response.status, `GitHub GET ${url} failed with HTTP ${response.status}`);
    const json = await response.json();
    items.push(...(pick ? pick(json) : (json as T[])));
    url = nextLink(response.headers.get("link"));
  }
  return items;
}

export async function graphql<T>(token: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await githubFetch(token, "POST", "/graphql", { query, variables });
  const json = (await response.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
  if (!response.ok || !json?.data) {
    const reason = json?.errors?.map((error) => error.message).join("; ") ?? `HTTP ${response.status}`;
    throw new GithubError(response.status, `GitHub GraphQL failed: ${reason}`);
  }
  return json.data;
}

const tokens = new Map<string, { token: string; expiresAt: number }>();

const READ_PERMISSIONS = { contents: "read", metadata: "read", pull_requests: "read", issues: "read" };
const CHECK_PERMISSIONS = { checks: "read", statuses: "read" };
const checksDenied = new Set<number>();

async function mintToken(installationId: number, key: string, body?: unknown): Promise<string> {
  const cached = tokens.get(key);
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
  const created = await github<{ token: string; expires_at: string }>(
    appJwt(),
    "POST",
    `/app/installations/${installationId}/access_tokens`,
    body,
  );
  if (!created) throw new GithubError(404, `GitHub App installation ${installationId} not found.`);
  tokens.set(key, { token: created.token, expiresAt: new Date(created.expires_at).getTime() });
  return created.token;
}

export const installationToken = (installationId: number) => mintToken(installationId, String(installationId));

export async function repositoryReadToken(installationId: number, fullName: string): Promise<string> {
  const key = `${installationId}:${fullName.toLowerCase()}:read`;
  const repositories = [fullName.split("/")[1]];
  if (!checksDenied.has(installationId)) {
    try {
      return await mintToken(installationId, key, { repositories, permissions: { ...READ_PERMISSIONS, ...CHECK_PERMISSIONS } });
    } catch (error) {
      if (!(error instanceof GithubError) || error.status !== 422) throw error;
      checksDenied.add(installationId);
    }
  }
  return mintToken(installationId, key, { repositories, permissions: READ_PERMISSIONS });
}

let slug: string | null = null;

export async function appSlug(): Promise<string> {
  if (slug) return slug;
  const app = await github<{ slug: string }>(appJwt(), "GET", "/app");
  if (!app) throw new Error("GitHub App not found.");
  slug = app.slug;
  return slug;
}

export async function installUrl(state?: string): Promise<string> {
  const url = `https://github.com/apps/${await appSlug()}/installations/new`;
  return state ? `${url}?state=${encodeURIComponent(state)}` : url;
}
