import { defineState } from "eve/context";
import type { SandboxSession } from "eve/sandbox";

export const REPO_DIR = "/workspace/repo";
export const BASE_TAG = "manfrod-base";
export const TARGET_BRANCH = "main";
export const BRANCH_PREFIX = "manfrod/self-modify/";
export const MAX_FILES = 40;
export const MAX_BYTES = 500_000;

const ALLOWED = ["agent/", "lib/agent/prompts.ts", "test/unit/"];
const BLOCKED = [
  "agent/agent.ts",
  "agent/lib/define-tool.ts",
  "agent/lib/e2b-sandbox.ts",
  "agent/lib/self-modify.ts",
  "agent/subagents/self-modify/",
];

export interface Proposal {
  baseSha: string | null;
  branch: string | null;
  headSha: string | null;
  pullNumber: number | null;
  pullUrl: string | null;
}

export const proposal = defineState<Proposal>("manfrod.self-modify.proposal", () => ({
  baseSha: null,
  branch: null,
  headSha: null,
  pullNumber: null,
  pullUrl: null,
}));

export interface Change {
  path: string;
  status: "A" | "M" | "D";
  mode: string;
}

export function pathViolation(path: string): string | null {
  if (path.split("/").some((part) => part === ".." || part === ".git")) return "unsafe path";
  if (BLOCKED.some((prefix) => path === prefix || path.startsWith(prefix))) return "protected path";
  if (!ALLOWED.some((prefix) => path === prefix || path.startsWith(prefix))) return "outside the allowed paths";
  return null;
}

export async function sh(sandbox: SandboxSession, command: string, abortSignal?: AbortSignal) {
  const result = await sandbox.run({ command, workingDirectory: REPO_DIR, abortSignal });
  if (result.exitCode !== 0)
    throw new Error(`\`${command}\` failed with exit ${result.exitCode}: ${(result.stderr || result.stdout).slice(-2000)}`);
  return result.stdout;
}

export async function localChanges(sandbox: SandboxSession): Promise<Change[]> {
  const raw = await sh(sandbox, `git add -A && git diff --cached --raw --no-renames -z ${BASE_TAG}`);
  const fields = raw.split("\0").filter((field) => field !== "");
  const changes: Change[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const match = /^:\d{6} (\d{6}) [0-9a-f]+ [0-9a-f]+ ([ADM])$/.exec(fields[index]);
    const path = fields[index + 1];
    if (!match || path === undefined) throw new Error("Could not parse the local git diff.");
    changes.push({ path, status: match[2] as Change["status"], mode: match[1] });
  }
  return changes;
}
