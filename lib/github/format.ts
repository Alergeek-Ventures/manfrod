import { addDays, formatLocal, isValidIsoDate, zonedToUtc } from "../time.ts";
import type { StoredCommit } from "./store.ts";

export const MAX_FILE_CHARS = 30_000;
export const MAX_TREE_MATCHES = 200;
const MAX_BODY_CHARS = 4_000;
const MAX_FILES = 100;

export const firstLine = (text: string | null | undefined) => (text ?? "").split("\n")[0].trim();
const shortSha = (sha: string) => sha.slice(0, 7);
const day = (iso: string | null | undefined) => (iso ? formatLocal(new Date(iso)).slice(0, 10) : "?");

function parseBound(value: string, end: boolean): Date | null {
  const trimmed = value.trim();
  if (isValidIsoDate(trimmed)) return zonedToUtc(end ? addDays(trimmed, 1) : trimmed, "00:00");
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function commitWindow(
  since: string | undefined,
  until: string | undefined,
  now = new Date(),
): { ok: true; since: Date; until?: Date } | { ok: false; message: string } {
  const from = since ? parseBound(since, false) : new Date(now.getTime() - 7 * 86_400_000);
  if (!from) return { ok: false, message: `ERROR: Could not read since="${since}". Use YYYY-MM-DD or an ISO timestamp.` };
  if (!until) return { ok: true, since: from };
  const to = parseBound(until, true);
  if (!to) return { ok: false, message: `ERROR: Could not read until="${until}". Use YYYY-MM-DD or an ISO timestamp.` };
  return { ok: true, since: from, until: to };
}

export function formatCommits(commits: StoredCommit[], limit: number): string {
  if (commits.length === 0) return "No commits found.";
  const lines = commits.slice(0, limit).map((commit) => {
    const branches = commit.branches.length > 0 ? ` [${commit.branches.join(", ")}]` : "";
    const author = commit.authorLogin ?? commit.authorName ?? commit.authorEmail ?? "unknown";
    return `${formatLocal(commit.authoredAt)} ${commit.repository}${branches} ${shortSha(commit.sha)} ${firstLine(commit.message)} (${author})`;
  });
  const more = commits.length > limit ? "\n…more commits match, narrow the filters or raise the limit" : "";
  return `${commits.length > limit ? `Newest ${limit} commits` : `${commits.length} commits`} (times Europe/Warsaw):\n${lines.join("\n")}${more}`;
}

export interface ContentEntry {
  name: string;
  path: string;
  type: string;
  size: number;
}

export function formatDirectory(repository: string, path: string, entries: ContentEntry[]): string {
  if (entries.length === 0) return `${repository}/${path} is empty.`;
  const sorted = [...entries].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  const lines = sorted.map((entry) => (entry.type === "dir" ? `${entry.name}/` : `${entry.name} (${entry.size} B)`));
  return `${repository}:${path || "/"}\n${lines.join("\n")}`;
}

export function formatFile(repository: string, path: string, text: string, maxChars = MAX_FILE_CHARS): string {
  if (text.includes("\u0000")) return `${repository}:${path} is a binary file (${Buffer.byteLength(text)} B), not shown.`;
  if (text.length <= maxChars) return `${repository}:${path}\n${text}`;
  const shown = text.slice(0, maxChars);
  const shownLines = shown.split("\n").length;
  const totalLines = text.split("\n").length;
  return `${repository}:${path} (truncated: showing the first ${shownLines} of ${totalLines} lines)\n${shown}`;
}

export function formatTreeMatches(repository: string, query: string, paths: string[], truncatedTree: boolean): string {
  const needle = query.toLowerCase();
  const matches = paths.filter((path) => path.toLowerCase().includes(needle));
  const note = truncatedTree ? "\n(GitHub truncated the tree, some paths may be missing)" : "";
  if (matches.length === 0) return `No paths in ${repository} contain "${query}".${note}`;
  const shown = matches.slice(0, MAX_TREE_MATCHES);
  const more = matches.length > shown.length ? `\n…${matches.length - shown.length} more, use a more specific find` : "";
  return `${matches.length} paths in ${repository} contain "${query}":\n${shown.join("\n")}${more}${note}`;
}

export interface PullSummary {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  merged_at?: string | null;
  html_url: string;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  updated_at: string;
}

export interface PullDetail extends PullSummary {
  body: string | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  mergeable_state?: string;
  requested_reviewers?: { login: string }[];
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface PullReview {
  user: { login: string } | null;
  state: string;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

const pullState = (pull: PullSummary) => (pull.merged_at ? "merged" : pull.draft && pull.state === "open" ? "draft" : pull.state);

export function formatPullList(repository: string, pulls: PullSummary[]): string {
  if (pulls.length === 0) return `No pull requests in ${repository} match.`;
  const lines = pulls.map(
    (pull) =>
      `#${pull.number} ${pull.title} [${pullState(pull)}] ${pull.user?.login ?? "?"} ${pull.head.ref} → ${pull.base.ref}, updated ${day(pull.updated_at)} ${pull.html_url}`,
  );
  return `${repository} pull requests:\n${lines.join("\n")}`;
}

export function latestReviews(reviews: PullReview[]): string[] {
  const byUser = new Map<string, string>();
  for (const review of reviews) {
    if (!review.user || review.state === "COMMENTED" || review.state === "PENDING") continue;
    byUser.set(review.user.login, review.state.toLowerCase().replaceAll("_", " "));
  }
  return [...byUser].map(([login, state]) => `${login}: ${state}`);
}

export function checksSummary(runs: CheckRun[] | null, statuses: { context: string; state: string }[] = []): string {
  if (runs === null) return "unavailable";
  const results = [
    ...runs.map((run) => ({ name: run.name, result: run.status === "completed" ? (run.conclusion ?? "unknown") : run.status })),
    ...statuses.map((status) => ({ name: status.context, result: status.state })),
  ];
  if (results.length === 0) return "none";
  const counts = new Map<string, number>();
  for (const { result } of results) counts.set(result, (counts.get(result) ?? 0) + 1);
  const failing = results.filter(({ result }) => ["failure", "error", "timed_out", "action_required"].includes(result));
  const summary = [...counts].map(([result, count]) => `${count} ${result}`).join(", ");
  return failing.length > 0 ? `${summary} (failing: ${failing.map(({ name }) => name).join(", ")})` : summary;
}

export function formatPull(repository: string, pull: PullDetail, files: PullFile[], reviews: PullReview[], checks: string): string {
  const lines = [
    `${repository}#${pull.number} ${pull.title} [${pullState(pull)}]`,
    `${pull.html_url}`,
    `Author: ${pull.user?.login ?? "?"}, ${pull.head.ref} → ${pull.base.ref}, updated ${day(pull.updated_at)}`,
  ];
  if (pull.additions !== undefined)
    lines.push(`Changes: +${pull.additions} -${pull.deletions ?? 0} in ${pull.changed_files ?? files.length} files`);
  const reviewed = latestReviews(reviews);
  const requested = (pull.requested_reviewers ?? []).map((reviewer) => reviewer.login);
  lines.push(
    `Reviews: ${reviewed.length > 0 ? reviewed.join(", ") : "none"}${requested.length > 0 ? `; requested: ${requested.join(", ")}` : ""}`,
  );
  lines.push(`Checks: ${checks}`);
  if (pull.mergeable_state && pull.state === "open") lines.push(`Mergeable state: ${pull.mergeable_state}`);
  const body = (pull.body ?? "").trim();
  if (body) lines.push("", body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n…(description truncated)` : body);
  if (files.length > 0) {
    lines.push("", "Files:");
    lines.push(...files.slice(0, MAX_FILES).map((file) => `${file.status} ${file.filename} +${file.additions} -${file.deletions}`));
    const total = Math.max(pull.changed_files ?? 0, files.length);
    if (total > MAX_FILES) lines.push(`…${total - MAX_FILES} more files`);
  }
  return lines.join("\n");
}
