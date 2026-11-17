import type { CheckRun, ComparedFile } from "../github.ts";
import { matches as secretRule } from "../security/gitleaks.ts";

export const MAX_CHANGED_LINES = 400;
export const MAX_BYTES = 100_000;
export const DAILY_LIMIT = 5;
export const REQUIRED_CHECKS = ["test"];

const SKILL = /^agent\/skills\/([a-z0-9-]+)\/SKILL\.md$/;
const ROUTINE = /^agent\/routines\/([a-z0-9-]+)\/ROUTINE\.md$/;
const NEVER = new Set(["proactive-style"]);
const PASSED = new Set(["success", "skipped", "neutral"]);

export type TargetKind = "skill" | "routine";

export interface Target {
  kind: TargetKind;
  name: string;
  path: string;
}

export interface FileVersions {
  mergeBase: string | null;
  main: string | null;
  head: string | null;
}

export type Eligibility = { ok: true; targets: Target[] } | { ok: false; reasons: string[] };

export const formatTarget = (target: Pick<Target, "kind" | "name">) => `${target.kind}:${target.name}`;

export function parseTarget(value: string): Pick<Target, "kind" | "name"> | null {
  const [kind, name] = value.split(":");
  return (kind === "skill" || kind === "routine") && name ? { kind, name } : null;
}

export function targetOf(path: string): Target | null {
  const skill = SKILL.exec(path);
  if (skill) return { kind: "skill", name: skill[1], path };
  const routine = ROUTINE.exec(path);
  if (routine) return { kind: "routine", name: routine[1], path };
  return null;
}

export const isCandidate = (files: Pick<ComparedFile, "path">[]) =>
  files.some((file) => file.path.startsWith("agent/skills/") || file.path.startsWith("agent/routines/"));

export function frontmatter(content: string): string | null {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  const close = end + 4;
  if (close < content.length && content[close] !== "\n") return null;
  return content.slice(0, close);
}

const URL_HOST = /\b[a-z][a-z0-9+.-]*:\/\/([^/\s)>\]|"'`]+)/gi;

export function hosts(text: string | null): Set<string> {
  return new Set([...(text ?? "").matchAll(URL_HOST)].map((match) => match[1].toLowerCase()));
}

export function eligibility(files: ComparedFile[], versions: Map<string, FileVersions>): Eligibility {
  const reasons: string[] = [];
  const targets: Target[] = [];
  if (files.length === 0) reasons.push("the pull request changes no files");
  let lines = 0;
  let bytes = 0;
  for (const file of files) {
    lines += file.changes;
    const target = targetOf(file.path);
    if (!target) {
      reasons.push(`${file.path}: only agent/skills/<name>/SKILL.md and agent/routines/<name>/ROUTINE.md can merge on their own`);
      continue;
    }
    if (NEVER.has(target.name)) {
      reasons.push(`${file.path}: this routine never merges on its own`);
      continue;
    }
    if ((file.status !== "added" && file.status !== "modified") || file.previousPath) {
      reasons.push(`${file.path}: ${file.status} files can't merge on their own`);
      continue;
    }
    const version = versions.get(file.path);
    if (!version || version.head === null) {
      reasons.push(`${file.path}: could not read the new version`);
      continue;
    }
    bytes += Buffer.byteLength(version.head);
    if (version.main !== version.mergeBase) reasons.push(`${file.path}: main changed this file after the branch was created`);
    if (target.kind === "routine") {
      if (file.status !== "modified" || version.main === null) {
        reasons.push(`${file.path}: new routines can't merge on their own`);
      } else {
        const before = frontmatter(version.main);
        if (before === null || before !== frontmatter(version.head)) reasons.push(`${file.path}: the routine's frontmatter changed`);
      }
    }
    const known = hosts(version.main);
    const added = [...hosts(version.head)].filter((host) => !known.has(host));
    if (added.length > 0) reasons.push(`${file.path}: adds links to ${added.join(", ")}`);
    const secret = secretRule(version.head);
    if (secret) reasons.push(`${file.path}: looks like it contains a secret (${secret})`);
    targets.push(target);
  }
  if (lines > MAX_CHANGED_LINES) reasons.push(`${lines} lines changed; the limit is ${MAX_CHANGED_LINES}`);
  if (bytes > MAX_BYTES) reasons.push(`${bytes} bytes in the changed files; the limit is ${MAX_BYTES}`);
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, targets };
}

export type CiState = "pending" | "green" | "failed";

export function ciState(runs: Pick<CheckRun, "name" | "status" | "conclusion">[]): CiState {
  if (runs.some((run) => run.status === "completed" && !PASSED.has(run.conclusion ?? ""))) return "failed";
  if (runs.some((run) => run.status !== "completed")) return "pending";
  const passed = new Set(runs.map((run) => run.name));
  return REQUIRED_CHECKS.every((name) => passed.has(name)) ? "green" : "pending";
}

export function underDailyLimit(mergedAt: Date[], now: Date): boolean {
  const since = now.getTime() - 86_400_000;
  return mergedAt.filter((date) => date.getTime() > since).length < DAILY_LIMIT;
}

export const containsMerge = (compareStatus: string | null) => compareStatus === "identical" || compareStatus === "ahead";
