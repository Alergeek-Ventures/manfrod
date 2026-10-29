import { createSign } from "node:crypto";
import { config } from "./config.ts";

const API = "https://api.github.com";

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
}

export interface TreeEntry {
  path: string;
  mode: "100644" | "100755";
  sha: string | null;
}

let cached: { token: string; expiresAt: number } | null = null;

const repository = () => config.githubRepository;

function appJwt(): string {
  const appId = config.githubAppId;
  const privateKey = config.githubAppPrivateKey;
  if (!appId || !privateKey) throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set.");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
}

async function call(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`GitHub ${method} ${path} failed with HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  return response;
}

async function installationToken(): Promise<string> {
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
  const jwt = appJwt();
  const installation = await call(jwt, "GET", `/repos/${repository()}/installation`);
  if (installation.status === 404) throw new Error(`The GitHub App is not installed on ${repository()}.`);
  const { id } = (await installation.json()) as { id: number };
  const created = await call(jwt, "POST", `/app/installations/${id}/access_tokens`, {
    repositories: [repository().split("/")[1]],
  });
  const { token, expires_at } = (await created.json()) as { token: string; expires_at: string };
  cached = { token, expiresAt: new Date(expires_at).getTime() };
  return token;
}

async function repo<T>(method: string, path: string, body?: unknown): Promise<T | null> {
  const response = await call(await installationToken(), method, `/repos/${repository()}${path}`, body);
  if (response.status === 404) return null;
  return (await response.json()) as T;
}

async function required<T>(method: string, path: string, body?: unknown): Promise<T> {
  const result = await repo<T>(method, path, body);
  if (result === null) throw new Error(`GitHub ${method} ${path} returned 404.`);
  return result;
}

export async function branchSha(branch: string): Promise<string | null> {
  const ref = await repo<{ object: { sha: string } }>("GET", `/git/ref/heads/${branch}`);
  return ref?.object.sha ?? null;
}

export interface CommitSummary {
  sha: string;
  message: string;
  date: string;
  url: string;
  files: string[];
}

export async function commitsSince(since: Date, branch: string, limit = 20): Promise<CommitSummary[]> {
  const list =
    (await repo<{ sha: string; html_url: string; commit: { message: string; committer: { date: string } | null } }[]>(
      "GET",
      `/commits?sha=${encodeURIComponent(branch)}&since=${since.toISOString()}&per_page=${limit}`,
    )) ?? [];
  const commits: CommitSummary[] = [];
  for (const item of list) {
    const detail = await repo<{ files?: { filename: string }[] }>("GET", `/commits/${item.sha}`);
    commits.push({
      sha: item.sha,
      message: item.commit.message,
      date: item.commit.committer?.date ?? "",
      url: item.html_url,
      files: (detail?.files ?? []).map((file) => file.filename),
    });
  }
  return commits;
}

export async function commitTree(sha: string): Promise<string> {
  return (await required<{ tree: { sha: string } }>("GET", `/git/commits/${sha}`)).tree.sha;
}

export async function tarball(sha: string): Promise<Uint8Array> {
  const response = await fetch(`${API}/repos/${repository()}/tarball/${sha}`, {
    headers: { authorization: `Bearer ${await installationToken()}`, "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`GitHub tarball download failed with HTTP ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function createBlob(content: Uint8Array): Promise<string> {
  const body = { content: Buffer.from(content).toString("base64"), encoding: "base64" };
  return (await required<{ sha: string }>("POST", "/git/blobs", body)).sha;
}

export async function createTree(baseTree: string, entries: TreeEntry[]): Promise<string> {
  const tree = entries.map((entry) => ({ path: entry.path, mode: entry.mode, type: "blob", sha: entry.sha }));
  return (await required<{ sha: string }>("POST", "/git/trees", { base_tree: baseTree, tree })).sha;
}

export async function createCommit(message: string, tree: string, parent: string): Promise<string> {
  return (await required<{ sha: string }>("POST", "/git/commits", { message, tree, parents: [parent] })).sha;
}

export async function createBranch(branch: string, sha: string): Promise<void> {
  await required("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha });
}

export async function moveBranch(branch: string, sha: string): Promise<void> {
  await required("PATCH", `/git/refs/heads/${branch}`, { sha, force: false });
}

export async function createDraftPull(branch: string, base: string, title: string, body: string) {
  const pull = await required<{ number: number; html_url: string }>("POST", "/pulls", {
    head: branch,
    base,
    title,
    body,
    draft: true,
  });
  return { number: pull.number, url: pull.html_url };
}

export async function checkRuns(sha: string): Promise<CheckRun[]> {
  const result = await required<{
    check_runs: { id: number; name: string; status: string; conclusion: string | null; html_url: string }[];
  }>("GET", `/commits/${sha}/check-runs?per_page=100`);
  return result.check_runs.map((run) => ({
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
  }));
}

export async function jobLog(jobId: number): Promise<string> {
  const response = await fetch(`${API}/repos/${repository()}/actions/jobs/${jobId}/logs`, {
    headers: { authorization: `Bearer ${await installationToken()}`, "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) return `Log unavailable (HTTP ${response.status}).`;
  return response.text();
}

export async function getPull(number: number) {
  const pull = await repo<{
    number: number;
    node_id: string;
    state: string;
    draft: boolean;
    merged: boolean;
    html_url: string;
    head: { ref: string };
  }>("GET", `/pulls/${number}`);
  return (
    pull && {
      number: pull.number,
      nodeId: pull.node_id,
      state: pull.state,
      draft: pull.draft,
      merged: pull.merged,
      url: pull.html_url,
      branch: pull.head.ref,
    }
  );
}

export async function markReadyForReview(nodeId: string): Promise<void> {
  const response = await call(await installationToken(), "POST", "/graphql", {
    query: "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }",
    variables: { id: nodeId },
  });
  const result = (await response.json()) as { errors?: { message: string }[] };
  if (result.errors?.length) throw new Error(`GitHub could not mark the pull request ready: ${result.errors[0].message}`);
}

export async function commentOnPull(number: number, body: string): Promise<void> {
  await required("POST", `/issues/${number}/comments`, { body });
}

export async function closePull(number: number): Promise<void> {
  await required("PATCH", `/pulls/${number}`, { state: "closed" });
}

export async function deleteBranch(branch: string): Promise<void> {
  const response = await fetch(`${API}/repos/${repository()}/git/refs/heads/${branch}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${await installationToken()}`, "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok && response.status !== 404 && response.status !== 422) {
    throw new Error(`GitHub DELETE branch ${branch} failed with HTTP ${response.status}.`);
  }
}
