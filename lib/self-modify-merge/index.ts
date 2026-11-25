import { config } from "../config.ts";
import { EVENTS, sendEvent, type SelfModifyPullSource } from "../inngest/client.ts";
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
import { getRecentSessionMessages } from "../memory/messages.ts";
import { isProposal, publishedHead, pullOrigin, recordedOpenPulls, type PullOrigin } from "../self-modify-pulls.ts";
import { planRehearsals, targetFor } from "../rehearsal/scenarios.ts";
import { insertPlanned } from "../rehearsal/store.ts";
import { findingForPull, linkedCases } from "../self-review/store.ts";
import { post } from "../slack/api.ts";
import {
  ciState,
  containsMerge,
  fileListProblems,
  formatTarget,
  isCandidate,
  targetOf,
  underDailyLimit,
  type FileVersions,
} from "./eligibility.ts";
import { mergeTarget, preCheck, TARGET_BRANCH } from "./outlook.ts";
import { JUDGES, securityReview, type Evidence, type ReviewedFile } from "./review.ts";
import { autoMergeEnabled } from "./settings.ts";
import {
  attachThread,
  awaitingDeploy,
  claimLive,
  decisionFor,
  lastThread,
  MAX_ATTEMPTS,
  mergedSince,
  mergingRows,
  recordDecision,
  recordRetry,
  recordTarget,
  releaseLive,
  settled,
  startMerging,
  type NewDecision,
} from "./store.ts";

const log = logger("SelfModify.Merge");
const MERGE_TIMEOUT_MINUTES = 15;
const EVIDENCE_CONVERSATIONS = 4;
const EVIDENCE_MESSAGES = 20;
const MESSAGE_CHARS = 600;
const FINAL_MERGE_REFUSALS = new Set([405, 409, 422]);

export type Outcome = "merged" | "blocked" | "skipped" | "waiting" | "retrying" | "ignored";

export type EvaluationMode = "sweep" | "event";

export interface ReportThread {
  channelId: string;
  threadTs: string | null;
}

type FoundPull = NonNullable<Awaited<ReturnType<typeof getPull>>>;

const clip = (text: string) => (text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS)}…` : text);
export const escapeSlack = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const link = (pull: Pick<FoundPull, "number" | "url" | "title">) => `<${pull.url}|#${pull.number} ${escapeSlack(pull.title)}>`;

export function pickThread(input: {
  finding: { sessionChannelId: string | null; sessionThreadTs: string | null } | null;
  origin: PullOrigin | null;
  earlier: { channelId: string; threadTs: string } | null;
  fallbackChannelId: string;
}): ReportThread {
  const { finding, origin, earlier } = input;
  if (finding?.sessionChannelId && finding.sessionThreadTs)
    return { channelId: finding.sessionChannelId, threadTs: finding.sessionThreadTs };
  if (origin) return origin;
  return earlier ?? { channelId: input.fallbackChannelId, threadTs: null };
}

async function thread(pullNumber: number): Promise<ReportThread> {
  return pickThread({
    finding: await findingForPull(pullNumber),
    origin: await pullOrigin(pullNumber),
    earlier: await lastThread(pullNumber),
    fallbackChannelId: config.selfReviewChannelId!,
  });
}

async function report(pullNumber: number, text: string): Promise<ReportThread> {
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

export async function versionsOf(files: ComparedFile[], mergeBase: string, main: string, head: string): Promise<Map<string, FileVersions>> {
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

async function evaluate(pull: FoundPull, mode: EvaluationMode): Promise<Outcome> {
  const files = await pullFiles(pull.number);
  if (!isCandidate(files)) {
    await recordDecision({ pullNumber: pull.number, headSha: pull.headSha, decision: "skipped", reason: "changes code", targets: [] });
    return "skipped";
  }
  const published = await publishedHead(pull.number);
  if (mode === "event" && published?.headSha !== pull.headSha) return "waiting";
  const origin = mergeTarget(pull, published);
  if (origin.length > 0) return block(pull, [], origin);
  const comparison = await compareCommits(TARGET_BRANCH, pull.headSha);
  const main = await branchSha(TARGET_BRANCH);
  if (!comparison || !main) throw new Error("GitHub could not compare the branch with main");
  const listed = fileListProblems(files, pull.changedFiles, comparison.files);
  const versions = await versionsOf(files, comparison.mergeBaseSha, main, pull.headSha);
  const check = preCheck({ pull, published, files, versions, listed });
  if (check.verdict !== "eligible") return block(pull, [], check.verdict === "blocked" ? check.reasons : ["changes code"]);
  const targets = check.targets.map(formatTarget);

  const ci = ciState(await checkRuns(pull.headSha));
  if (ci === "pending") return "waiting";
  if (ci === "failed") return mode === "event" ? "waiting" : block(pull, targets, ["CI did not pass on this commit"]);
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

async function prepareRehearsals(pull: FoundPull): Promise<number> {
  const row = await decisionFor(pull.number, pull.headSha);
  const target = row ? await targetFor(pull.number, pull.title) : null;
  if (!row || !target) return 0;
  await recordTarget(row.id, target);
  const planned = await planRehearsals(target, pull.number);
  await insertPlanned(row.id, planned);
  return planned.length;
}

async function announceMerged(pull: FoundPull, targets: string[], mergeSha: string | null, note: string): Promise<void> {
  const commit = mergeSha ? `squash commit ${mergeSha.slice(0, 7)}` : "GitHub did not say which squash commit";
  const followUp = mergeSha
    ? "Once it is live I'll replay the scenario it was meant to fix on the new version and judge the result."
    : "Without the commit I can't tell when it is live, so it won't be rehearsed after the deploy.";
  await decide(
    pull,
    { decision: "merged", reason: null, targets, mergeSha },
    `:rocket: Merged ${link(pull)} automatically (${targets.join(", ")}; ${commit})${note}. CI is green and the security review passed. ${followUp}`,
  );
  log.info(`SelfModify.Merge: merged #${pull.number} as ${mergeSha}`);
  try {
    await prepareRehearsals(pull);
  } catch (error) {
    log.error(`SelfModify.Merge: could not prepare the rehearsal of #${pull.number}: ${(error as Error).message}`);
  }
}

export async function processPull(pullNumber: number, mode: EvaluationMode = "sweep"): Promise<Outcome> {
  const found = await getPull(pullNumber);
  if (!found || found.state !== "open" || found.merged || !isProposal(found)) return "ignored";
  if (settled(await decisionFor(found.number, found.headSha))) return "ignored";
  try {
    return await evaluate(found, mode);
  } catch (error) {
    return retry(found, [], (error as Error).message);
  }
}

export async function settleMerging(now = new Date(), pullNumber?: number): Promise<number> {
  let settledCount = 0;
  const rows = (await mergingRows()).filter((row) => pullNumber === undefined || row.pullNumber === pullNumber);
  for (const row of rows) {
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
      const text = `:test_tube: #${row.pullNumber} is live in production (${appCommit.slice(0, 7)}). I'm replaying the scenario it was meant to fix on the new version and will post the verdict here.`;
      const posted = await post("chat.postMessage", { channel: channelId, text, ...(row.threadTs ? { thread_ts: row.threadTs } : {}) });
      if (!posted.ok) {
        await releaseLive(row.id);
        log.error(`SelfModify.Merge: #${row.pullNumber} is live but could not be announced: ${posted.error}`);
        continue;
      }
      if (!row.threadTs) await attachThread(row.id, channelId, posted.body.ts as string);
      live += 1;
    } catch (error) {
      log.error(`SelfModify.Merge: live check failed for #${row.pullNumber}: ${(error as Error).message}`);
    }
  }
  return live;
}

export interface PullRun {
  outcome: Outcome;
  settled: number;
  next: string | null;
}

async function nextRun(pullNumber: number, outcome: Outcome): Promise<string | null> {
  if (outcome !== "retrying" && outcome !== "waiting") return null;
  const pull = await getPull(pullNumber);
  const row = pull ? await decisionFor(pullNumber, pull.headSha) : null;
  if (outcome === "retrying" && row?.decision === "retry" && row.retryAt) return row.retryAt.toISOString();
  if (row?.decision === "merging" && row.mergedAt)
    return new Date(row.mergedAt.getTime() + (MERGE_TIMEOUT_MINUTES + 1) * 60_000).toISOString();
  return null;
}

export async function runPull(pullNumber: number, source: SelfModifyPullSource): Promise<PullRun> {
  if (!config.selfReviewChannelId) return { outcome: "ignored", settled: 0, next: null };
  const settledCount = await settleMerging(new Date(), pullNumber);
  if (!(await autoMergeEnabled())) return { outcome: "waiting", settled: settledCount, next: null };
  const outcome = await processPull(pullNumber, source === "sweep" ? "sweep" : "event");
  return { outcome, settled: settledCount, next: await nextRun(pullNumber, outcome) };
}

export async function requestEvaluation(pullNumbers: number[], source: SelfModifyPullSource): Promise<number> {
  let sent = 0;
  for (const pullNumber of new Set(pullNumbers)) {
    if (await sendEvent(EVENTS.selfModifyPullChanged, { pullNumber, source })) sent += 1;
  }
  return sent;
}

export async function sweepAutoMerge(): Promise<{ requested: number }> {
  if (!config.selfReviewChannelId) return { requested: 0 };
  const merging = (await mergingRows()).map((row) => row.pullNumber);
  return { requested: await requestEvaluation([...merging, ...(await recordedOpenPulls())], "sweep") };
}
