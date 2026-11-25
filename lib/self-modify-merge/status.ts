import { branchSha, checkRuns, compareCommits, getPull } from "../github.ts";
import { isProposal, publishedHead } from "../self-modify-pulls.ts";
import { ciState, isCandidate, underDailyLimit } from "./eligibility.ts";
import { versionsOf } from "./index.ts";
import { outlook, preCheck, statusText, TARGET_BRANCH, type MergeablePull, type Outlook } from "./outlook.ts";
import { autoMergeEnabled } from "./settings.ts";
import { decisionFor, mergedPull, mergedSince } from "./store.ts";

async function outlookAt(pull: MergeablePull & { number: number }): Promise<Outlook> {
  const comparison = await compareCommits(TARGET_BRANCH, pull.headSha);
  const main = await branchSha(TARGET_BRANCH);
  if (!comparison || !main) throw new Error("GitHub could not compare the branch with main");
  const files = comparison.files;
  const versions = isCandidate(files) ? await versionsOf(files, comparison.mergeBaseSha, main, pull.headSha) : new Map();
  const check = preCheck({ pull, published: await publishedHead(pull.number), files, versions });
  const now = new Date();
  return outlook(check, {
    enabled: await autoMergeEnabled(),
    underLimit: underDailyLimit(await mergedSince(new Date(now.getTime() - 86_400_000)), now),
  });
}

export async function publishOutlook(pullNumber: number, headSha: string): Promise<Outlook> {
  const pull = await getPull(pullNumber);
  if (!pull) throw new Error(`GitHub did not return #${pullNumber}`);
  return outlookAt({ ...pull, headSha });
}

export async function autoMergeStatus(pullNumber: number): Promise<string> {
  const pull = await getPull(pullNumber);
  if (!pull || !isProposal(pull)) return `#${pullNumber} is not a self-modify pull request.`;
  const open = pull.state === "open" && !pull.merged;
  const decision = open ? await decisionFor(pull.number, pull.headSha) : null;
  const view = open && !decision ? await outlookAt(pull) : null;
  const text = statusText({
    merged: pull.merged,
    open,
    decision,
    mergedAutomatically: pull.merged && (await mergedPull(pull.number)) !== null,
    outlook: view,
    ci: view?.status === "qualifies" ? ciState(await checkRuns(pull.headSha)) : null,
  });
  return `#${pull.number} ${pull.title} (${pull.url}): ${text}`;
}
