import { config } from "../config.ts";
import type { ComparedFile } from "../github.ts";
import { isProposal } from "../self-modify-pulls.ts";
import type { SelfModifyMerge } from "../db/schema.ts";
import { DAILY_LIMIT, eligibility, formatTarget, isCandidate, type CiState, type FileVersions, type Target } from "./eligibility.ts";

export const TARGET_BRANCH = "main";

export interface MergeablePull {
  headSha: string;
  baseRef: string;
  branch: string;
  headRepository: string | null;
}

export interface PublishedHead {
  headSha: string | null;
  reviewVerdict: string | null;
}

export function mergeTarget(pull: MergeablePull, published: PublishedHead | null): string[] {
  const problems: string[] = [];
  if (!published?.headSha || published.headSha !== pull.headSha) problems.push("the head commit is not the one self-modify published");
  else if (published.reviewVerdict !== "approve") problems.push("self-modify's reviewer did not approve this commit");
  if (pull.baseRef !== TARGET_BRANCH) problems.push(`the pull request targets ${pull.baseRef}, not ${TARGET_BRANCH}`);
  if (!isProposal(pull)) problems.push("the branch is not a self-modify branch");
  if (pull.headRepository !== config.githubRepository) problems.push("the branch comes from another repository");
  return problems;
}

export type PreCheck = { verdict: "code" } | { verdict: "blocked"; reasons: string[] } | { verdict: "eligible"; targets: Target[] };

export interface PreCheckInput {
  pull: MergeablePull;
  published: PublishedHead | null;
  files: ComparedFile[];
  versions: Map<string, FileVersions>;
  listed?: string[];
}

export function preCheck({ pull, published, files, versions, listed = [] }: PreCheckInput): PreCheck {
  if (!isCandidate(files)) return { verdict: "code" };
  const origin = mergeTarget(pull, published);
  if (origin.length > 0) return { verdict: "blocked", reasons: origin };
  if (listed.length > 0) return { verdict: "blocked", reasons: listed };
  const gate = eligibility(files, versions);
  return gate.ok ? { verdict: "eligible", targets: gate.targets } : { verdict: "blocked", reasons: gate.reasons };
}

export type Outlook =
  | { status: "code" }
  | { status: "blocked"; reasons: string[] }
  | { status: "switched_off"; targets: string[] }
  | { status: "daily_limit"; targets: string[] }
  | { status: "qualifies"; targets: string[] };

export function outlook(check: PreCheck, gates: { enabled: boolean; underLimit: boolean }): Outlook {
  if (check.verdict === "code") return { status: "code" };
  if (check.verdict === "blocked") return { status: "blocked", reasons: check.reasons };
  const targets = check.targets.map(formatTarget);
  if (!gates.enabled) return { status: "switched_off", targets };
  if (!gates.underLimit) return { status: "daily_limit", targets };
  return { status: "qualifies", targets };
}

const PERSON = "a person has to review and merge it";

export function outlookText(view: Outlook): string {
  switch (view.status) {
    case "code":
      return `Won't auto-merge: it changes more than skill or routine instructions, so ${PERSON}.`;
    case "blocked":
      return `Won't auto-merge, ${PERSON}:\n${view.reasons.map((reason) => `- ${reason}`).join("\n")}`;
    case "switched_off":
      return `Qualifies for auto-merge (${view.targets.join(", ")}), but auto-merge is switched off in the panel's Agent tab, so ${PERSON}.`;
    case "daily_limit":
      return `Qualifies for auto-merge (${view.targets.join(", ")}), but the limit of ${DAILY_LIMIT} auto-merges a day is reached; it merges on its own once the limit frees up, CI is green and the security review passes.`;
    case "qualifies":
      return `Will merge on its own once CI is green and the security review passes (${view.targets.join(", ")}). The outcome is posted in the thread it was requested in.`;
  }
}

type Decided = Pick<SelfModifyMerge, "decision" | "reason" | "mergeSha" | "attempts">;

export function statusText(input: {
  merged: boolean;
  open: boolean;
  decision: Decided | null;
  mergedAutomatically: boolean;
  outlook: Outlook | null;
  ci: CiState | null;
}): string {
  if (input.merged) return input.mergedAutomatically ? "merged automatically" : "merged by a person";
  if (!input.open) return "closed without merging";
  const decision = input.decision;
  if (decision?.decision === "merging") return "merging right now";
  if (decision?.decision === "skipped") return outlookText({ status: "code" });
  if (decision?.decision === "blocked")
    return outlookText({ status: "blocked", reasons: (decision.reason ?? "").split("\n").filter(Boolean) });
  if (decision?.decision === "retry")
    return `qualifies; attempt ${decision.attempts} failed (${decision.reason ?? "unknown"}), it retries on its own`;
  if (!input.outlook) return "auto-merge status unknown";
  if (input.outlook.status !== "qualifies") return outlookText(input.outlook);
  if (input.ci === "failed") return `Won't auto-merge, ${PERSON}: CI did not pass on this commit.`;
  if (input.ci === "green") return `qualifies, CI is green; the security review runs next (${input.outlook.targets.join(", ")})`;
  return `qualifies, waiting for CI (${input.outlook.targets.join(", ")})`;
}
