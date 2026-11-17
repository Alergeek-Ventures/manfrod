import { config } from "../config.ts";
import {
  branchSha,
  checkRuns,
  compareCommits,
  fileAt,
  getPull,
  markReadyForReview,
  pullFiles,
  squashMerge,
  type ComparedFile,
} from "../github.ts";
import { logger } from "../log.ts";
import { resolveAccess } from "../memory/access.ts";
import { getRecentSessionMessages } from "../memory/messages.ts";
import { isProposal, publishedHead, recordedOpenPulls } from "../self-modify-pulls.ts";
import { findingForPull, linkedCases, selfReviewUserId } from "../self-review/store.ts";
import { post } from "../slack/api.ts";
import { createTask } from "../tasks/index.ts";
import { formatLocal } from "../time.ts";
import {
  ciState,
  containsMerge,
  eligibility,
  fileListProblems,
  formatTarget,
  isCandidate,
  targetOf,
  underDailyLimit,
  type FileVersions,
} from "./eligibility.ts";
import { JUDGES, securityReview, type Evidence, type ReviewedFile } from "./review.ts";
import { autoMergeEnabled } from "./settings.ts";
import {
  attachThread,
  attachVerification,
  awaitingDeploy,
  claimLive,
  decisionFor,
  lastThread,
  MAX_ATTEMPTS,
  mergedSince,
  mergingRows,
  recordDecision,
  recordRetry,
  releaseLive,
  settled,
  startMerging,
  type NewDecision,
} from "./store.ts";

const log = logger("SelfModify.Merge");
const TARGET_BRANCH = "main";
const CHECK_EVERY_MINUTES = 30;
const VERIFY_DAYS = 5;
const MERGE_TIMEOUT_MINUTES = 15;
const EVIDENCE_CONVERSATIONS = 4;
const EVIDENCE_MESSAGES = 20;
const MESSAGE_CHARS = 600;
const FINAL_MERGE_REFUSALS = new Set([405, 409, 422]);

export type Outcome = "merged" | "blocked" | "skipped" | "waiting" | "retrying" | "ignored";

type FoundPull = NonNullable<Awaited<ReturnType<typeof getPull>>>;

const clip = (text: string) => (text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS)}…` : text);
export const escapeSlack = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const link = (pull: Pick<FoundPull, "number" | "url" | "title">) => `<${pull.url}|#${pull.number} ${escapeSlack(pull.title)}>`;

async function thread(pullNumber: number): Promise<{ channelId: string; threadTs: string | null }> {
  const finding = await findingForPull(pullNumber);
  if (finding?.sessionChannelId && finding.sessionThreadTs)
    return { channelId: finding.sessionChannelId, threadTs: finding.sessionThreadTs };
  const earlier = await lastThread(pullNumber);
  return earlier ?? { channelId: config.selfReviewChannelId!, threadTs: null };
}

async function report(pullNumber: number, text: string): Promise<{ channelId: string; threadTs: string | null }> {
  const target = await thread(pullNumber);
  const result = await post("chat.postMessage", {
    channel: target.channelId,
    text,
    ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
  });
  if (!result.ok) {
    log.error(`SelfModify.Merge: could not post about #${pullNumber}: ${result.error}`);
    return target;
  }
  return { channelId: target.channelId, threadTs: target.threadTs ?? (result.body.ts as string) };
}

async function decide(
  pull: Pick<FoundPull, "number" | "headSha">,
  decision: Omit<NewDecision, "pullNumber" | "headSha" | "channelId" | "threadTs">,
  text: string,
) {
  const where = await report(pull.number, text);
  await recordDecision({
    ...decision,
    pullNumber: pull.number,
    headSha: pull.headSha,
    channelId: where.channelId,
    threadTs: where.threadTs,
  });
}

async function block(pull: FoundPull, targets: string[], reasons: string[]): Promise<Outcome> {
  const listed = reasons.map((reason) => `• ${escapeSlack(reason)}`).join("\n");
  await decide(
    pull,
    { decision: "blocked", reason: reasons.join("\n"), targets },
    `:no_entry: ${link(pull)} was not merged automatically (commit ${pull.headSha.slice(0, 7)}):\n${listed}\nIt stays open for a person to review.`,
  );
  return "blocked";
}

async function retry(pull: FoundPull, targets: string[], reason: string, replaceMerging = false): Promise<Outcome> {
  const attempts = await recordRetry(pull.number, pull.headSha, reason, targets, replaceMerging);
  if (attempts === null) {
    log.warn(`SelfModify.Merge: #${pull.number} has a merge in flight; leaving it to be settled: ${reason}`);
    return "waiting";
  }
  if (attempts < MAX_ATTEMPTS) {
    log.warn(`SelfModify.Merge: #${pull.number} attempt ${attempts} failed, retrying later: ${reason}`);
    return "retrying";
  }
  return block(pull, targets, [`Gave up after ${attempts} attempts that failed for a passing reason; the last one: ${reason}`]);
}

async function versionsOf(files: ComparedFile[], mergeBase: string, main: string, head: string): Promise<Map<string, FileVersions>> {
  const versions = new Map<string, FileVersions>();
  for (const file of files) {
    if (!targetOf(file.path) || file.status === "removed") continue;
    const [atBase, atMain, atHead] = await Promise.all([fileAt(file.path, mergeBase), fileAt(file.path, main), fileAt(file.path, head)]);
    versions.set(file.path, { mergeBase: atBase, main: atMain, head: atHead });
  }
  return versions;
}

async function evidence(pullNumber: number): Promise<Evidence> {
  const finding = await findingForPull(pullNumber);
  if (!finding) return { finding: null, conversations: [] };
  const sessions = [
    ...new Set((await linkedCases([finding.id])).flatMap((row) => (row.feedback.sessionKey ? [row.feedback.sessionKey] : []))),
  ].slice(0, EVIDENCE_CONVERSATIONS);
  const conversations = await Promise.all(
    sessions.map(async (sessionKey) =>
      (await getRecentSessionMessages(sessionKey, { windowHours: null, limit: EVIDENCE_MESSAGES }))
        .map((message) => `${message.role === "assistant" ? "Manfrod" : "Person"}: ${clip(message.content)}`)
        .join("\n"),
    ),
  );
  return { finding: { title: finding.title, problem: finding.problem, expected: finding.expected }, conversations };
}

export function mergeTarget(pull: FoundPull, published: { headSha: string | null; reviewVerdict: string | null } | null): string[] {
  const problems: string[] = [];
  if (!published?.headSha || published.headSha !== pull.headSha) problems.push("the head commit is not the one self-modify published");
  else if (published.reviewVerdict !== "approve") problems.push("self-modify's reviewer did not approve this commit");
  if (pull.baseRef !== TARGET_BRANCH) problems.push(`the pull request targets ${pull.baseRef}, not ${TARGET_BRANCH}`);
  if (!isProposal(pull)) problems.push("the branch is not a self-modify branch");
  if (pull.headRepository !== config.githubRepository) problems.push("the branch comes from another repository");
  return problems;
}

async function evaluate(pull: FoundPull): Promise<Outcome> {
  const files = await pullFiles(pull.number);
  if (!isCandidate(files)) {
    await recordDecision({ pullNumber: pull.number, headSha: pull.headSha, decision: "skipped", reason: "changes code", targets: [] });
    return "skipped";
  }
  const origin = mergeTarget(pull, await publishedHead(pull.number));
  if (origin.length > 0) return block(pull, [], origin);
  const comparison = await compareCommits(TARGET_BRANCH, pull.headSha);
  const main = await branchSha(TARGET_BRANCH);
  if (!comparison || !main) throw new Error("GitHub could not compare the branch with main");
  const listed = fileListProblems(files, pull.changedFiles, comparison.files);
  if (listed.length > 0) return block(pull, [], listed);
  const versions = await versionsOf(files, comparison.mergeBaseSha, main, pull.headSha);
  const gate = eligibility(files, versions);
  if (!gate.ok) return block(pull, [], gate.reasons);
  const targets = gate.targets.map(formatTarget);

  const ci = ciState(await checkRuns(pull.headSha));
  if (ci === "pending") return "waiting";
  if (ci === "failed") return block(pull, targets, ["CI did not pass on this commit"]);
  const now = new Date();
  if (!underDailyLimit(await mergedSince(new Date(now.getTime() - 86_400_000)), now)) {
    log.info(`SelfModify.Merge: #${pull.number} waits, the daily limit of auto-merges is reached`);
    return "waiting";
  }

  const reviewed: ReviewedFile[] = files.map((file) => ({
    path: file.path,
    status: file.status,
    before: versions.get(file.path)?.main ?? null,
    after: versions.get(file.path)?.head ?? "",
    patch: file.patch,
  }));
  const review = await securityReview({ files: reviewed, evidence: await evidence(pull.number) }, JUDGES);
  if (!review.pass && review.transient) return retry(pull, targets, `security review: ${review.reasons.join("; ")}`);
  if (!review.pass)
    return block(
      pull,
      targets,
      review.reasons.map((reason) => `Security review: ${reason}`),
    );

  const fresh = await getPull(pull.number);
  if (!fresh || fresh.state !== "open" || fresh.merged || fresh.headSha !== pull.headSha) return "waiting";
  if (!(await autoMergeEnabled())) return "waiting";
  const last = mergeTarget(fresh, await publishedHead(pull.number));
  if (last.length > 0) return block(pull, targets, last);
  if (!underDailyLimit(await mergedSince(new Date(Date.now() - 86_400_000)), new Date())) return "waiting";

  await startMerging(pull.number, pull.headSha, targets);
  if (fresh.draft) await markReadyForReview(fresh.nodeId);
  let merged;
  try {
    merged = await squashMerge(pull.number, pull.headSha, pull.title);
  } catch (error) {
    log.error(`SelfModify.Merge: merging #${pull.number} did not finish: ${(error as Error).message}`);
    return "waiting";
  }
  if (!merged.ok && merged.status >= 500) return retry(pull, targets, `GitHub failed to merge (HTTP ${merged.status}): ${merged.message}`);
  if (!merged.ok) {
    const final = FINAL_MERGE_REFUSALS.has(merged.status) ? "GitHub refused the merge" : "GitHub rejected the merge";
    return block(pull, targets, [`${final} (HTTP ${merged.status}): ${merged.message}`]);
  }
  await announceMerged(pull, targets, merged.sha, "");
  return "merged";
}

async function announceMerged(pull: FoundPull, targets: string[], mergeSha: string | null, note: string): Promise<void> {
  const commit = mergeSha ? `squash commit ${mergeSha.slice(0, 7)}` : "GitHub did not say which squash commit";
  const followUp = mergeSha
    ? "Once it is live I'll check whether conversations that use it go better."
    : "Without the commit I can't tell when it is live, so it won't be checked after the deploy.";
  await decide(
    pull,
    { decision: "merged", reason: null, targets, mergeSha },
    `:rocket: Merged ${link(pull)} automatically (${targets.join(", ")}; ${commit})${note}. CI is green and the security review passed. ${followUp}`,
  );
  log.info(`SelfModify.Merge: merged #${pull.number} as ${mergeSha}`);
}

export async function processPull(pullNumber: number): Promise<Outcome> {
  const found = await getPull(pullNumber);
  if (!found || found.state !== "open" || found.merged || !isProposal(found)) return "ignored";
  if (settled(await decisionFor(found.number, found.headSha))) return "ignored";
  try {
    return await evaluate(found);
  } catch (error) {
    return retry(found, [], (error as Error).message);
  }
}

export async function settleMerging(now = new Date()): Promise<number> {
  let settledCount = 0;
  for (const row of await mergingRows()) {
    try {
      const pull = await getPull(row.pullNumber);
      if (!pull) continue;
      const atHead = { ...pull, headSha: row.headSha };
      if (pull.merged) {
        await announceMerged(atHead, row.targets, pull.mergeCommitSha, ", confirmed after the merge call did not answer");
        settledCount += 1;
      } else if (!row.mergedAt || now.getTime() - row.mergedAt.getTime() > MERGE_TIMEOUT_MINUTES * 60_000) {
        await retry(atHead, row.targets, "the merge call did not answer and the pull request is still open", true);
        settledCount += 1;
      }
    } catch (error) {
      log.error(`SelfModify.Merge: could not settle the merge of #${row.pullNumber}: ${(error as Error).message}`);
    }
  }
  return settledCount;
}

function verificationGoal(pullNumber: number, url: string | null, targets: string[], liveAt: Date): string {
  return `Pull request #${pullNumber}${url ? ` (${url})` : ""} changed ${targets.join(", ")} and was merged automatically; it is live in production since ${formatLocal(liveAt)}. Find out whether the conversations that use it go better than before.

On every check call self-modify-impact with pull_number ${pullNumber}: it lists uses and negative ratings (👎 and the ones inferred from conversations) before and after the deploy, with links. Inferred ratings arrive the night after a conversation, so don't judge on a few fresh uses. When the numbers support a verdict, or on the last check, call self-modify-impact again with pull_number ${pullNumber}, the verdict (better, no_change, worse or not_enough_data) and a one or two sentence summary: that posts the verdict in this thread and closes the task. On worse, say so and recommend reverting the pull request; never revert or change anything yourself. post-slack-message does not work for you here.`;
}

export async function detectLive(): Promise<number> {
  const appCommit = config.appCommit;
  if (!appCommit) return 0;
  let live = 0;
  for (const row of await awaitingDeploy()) {
    try {
      const comparison = await compareCommits(row.mergeSha!, appCommit);
      if (!containsMerge(comparison?.status ?? null)) continue;
      const channelId = row.channelId ?? config.selfReviewChannelId;
      if (!channelId || !(await claimLive(row.id))) continue;
      const text = `:white_check_mark: #${row.pullNumber} is live in production (${appCommit.slice(0, 7)}). I'll compare conversations that use ${row.targets.join(", ")} before and after it every ${CHECK_EVERY_MINUTES} minutes on workdays, for up to ${VERIFY_DAYS} days.`;
      let threadTs = row.threadTs;
      if (!threadTs) {
        const root = await post("chat.postMessage", { channel: channelId, text });
        if (!root.ok) {
          await releaseLive(row.id);
          log.error(`SelfModify.Merge: #${row.pullNumber} is live but the thread could not be started: ${root.error}`);
          continue;
        }
        threadTs = root.body.ts as string;
        await attachThread(row.id, channelId, threadTs);
      }
      const pull = await getPull(row.pullNumber);
      const ownerUserId = await selfReviewUserId();
      const now = new Date();
      let task;
      try {
        task = await createTask({
          ownerUserId,
          title: `Check the effect of #${row.pullNumber}`,
          goal: verificationGoal(row.pullNumber, pull?.url ?? null, row.targets, now),
          successCriteria: `A verdict on #${row.pullNumber} was posted in this thread with self-modify-impact.`,
          plan: null,
          channelId,
          threadTs,
          ...(await resolveAccess(ownerUserId, channelId)),
          checkEveryMinutes: CHECK_EVERY_MINUTES,
          firstCheckAt: null,
          deadline: new Date(now.getTime() + VERIFY_DAYS * 86_400_000),
        });
      } catch (error) {
        await releaseLive(row.id);
        throw error;
      }
      await attachVerification(row.id, task.id, channelId, threadTs);
      if (row.threadTs) await post("chat.postMessage", { channel: channelId, thread_ts: threadTs, text });
      live += 1;
    } catch (error) {
      log.error(`SelfModify.Merge: live check failed for #${row.pullNumber}: ${(error as Error).message}`);
    }
  }
  return live;
}

export async function runAutoMerge(): Promise<{ live: number; settled: number; outcomes: Record<number, Outcome> }> {
  const live = await detectLive();
  const outcomes: Record<number, Outcome> = {};
  if (!config.selfReviewChannelId) return { live, settled: 0, outcomes };
  const settledCount = await settleMerging();
  if (!(await autoMergeEnabled())) return { live, settled: settledCount, outcomes };
  for (const pullNumber of await recordedOpenPulls()) {
    try {
      outcomes[pullNumber] = await processPull(pullNumber);
    } catch (error) {
      log.error(`SelfModify.Merge: failed for #${pullNumber}: ${(error as Error).message}`);
    }
  }
  return { live, settled: settledCount, outcomes };
}
