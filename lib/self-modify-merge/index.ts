import { config } from "../config.ts";
import { branchSha, checkRuns, compareCommits, fileAt, getPull, markReadyForReview, squashMerge, type ComparedFile } from "../github.ts";
import { logger } from "../log.ts";
import { resolveAccess } from "../memory/access.ts";
import { getRecentSessionMessages } from "../memory/messages.ts";
import { isProposal, recordedOpenPulls } from "../self-modify-pulls.ts";
import { findingForPull, linkedCases, selfReviewUserId } from "../self-review/store.ts";
import { post } from "../slack/api.ts";
import { createTask } from "../tasks/index.ts";
import { formatLocal } from "../time.ts";
import {
  ciState,
  containsMerge,
  eligibility,
  formatTarget,
  isCandidate,
  targetOf,
  underDailyLimit,
  type FileVersions,
} from "./eligibility.ts";
import { JUDGES, securityReview, type Evidence, type ReviewedFile } from "./review.ts";
import { autoMergeEnabled } from "./settings.ts";
import { awaitingDeploy, decided, lastThread, markLive, mergedSince, recordDecision, type NewDecision } from "./store.ts";

const log = logger("SelfModify.Merge");
const TARGET_BRANCH = "main";
const CHECK_EVERY_MINUTES = 30;
const VERIFY_DAYS = 5;
const EVIDENCE_CONVERSATIONS = 4;
const EVIDENCE_MESSAGES = 20;
const MESSAGE_CHARS = 600;

export type Outcome = "merged" | "blocked" | "skipped" | "waiting" | "ignored";

interface Pull {
  number: number;
  nodeId: string;
  draft: boolean;
  url: string;
  title: string;
  headSha: string;
}

const clip = (text: string) => (text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS)}…` : text);
const link = (pull: Pick<Pull, "number" | "url" | "title">) => `<${pull.url}|#${pull.number} ${pull.title}>`;

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

async function decide(pull: Pull, decision: Omit<NewDecision, "pullNumber" | "headSha" | "channelId" | "threadTs">, text: string) {
  const where = await report(pull.number, text);
  await recordDecision({
    ...decision,
    pullNumber: pull.number,
    headSha: pull.headSha,
    channelId: where.channelId,
    threadTs: where.threadTs,
  });
}

async function block(pull: Pull, targets: string[], reasons: string[]): Promise<Outcome> {
  const listed = reasons.map((reason) => `• ${reason}`).join("\n");
  await decide(
    pull,
    { decision: "blocked", reason: reasons.join("\n"), targets },
    `:no_entry: ${link(pull)} was not merged automatically (commit ${pull.headSha.slice(0, 7)}):\n${listed}\nIt stays open for a person to review.`,
  );
  return "blocked";
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

export async function processPull(pullNumber: number): Promise<Outcome> {
  const found = await getPull(pullNumber);
  if (!found || found.state !== "open" || found.merged || !isProposal(found)) return "ignored";
  const pull: Pull = found;
  if (await decided(pull.number, pull.headSha)) return "ignored";
  const comparison = await compareCommits(TARGET_BRANCH, pull.headSha);
  const main = await branchSha(TARGET_BRANCH);
  if (!comparison || !main) return "waiting";
  if (!isCandidate(comparison.files)) {
    await recordDecision({ pullNumber: pull.number, headSha: pull.headSha, decision: "skipped", reason: "changes code", targets: [] });
    return "skipped";
  }
  const versions = await versionsOf(comparison.files, comparison.mergeBaseSha, main, pull.headSha);
  const gate = eligibility(comparison.files, versions);
  if (!gate.ok) return block(pull, [], gate.reasons);
  const targets = gate.targets.map(formatTarget);

  const ci = ciState(await checkRuns(pull.headSha));
  if (ci === "pending") return "waiting";
  if (ci === "failed") return block(pull, targets, ["CI failed on this commit"]);
  const now = new Date();
  if (!underDailyLimit(await mergedSince(new Date(now.getTime() - 86_400_000)), now)) {
    log.info(`SelfModify.Merge: #${pull.number} waits, the daily limit of auto-merges is reached`);
    return "waiting";
  }

  const files: ReviewedFile[] = comparison.files.map((file) => ({
    path: file.path,
    status: file.status,
    before: versions.get(file.path)?.main ?? null,
    after: versions.get(file.path)?.head ?? "",
    patch: file.patch,
  }));
  const review = await securityReview({ files, evidence: await evidence(pull.number) }, JUDGES);
  if (!review.pass)
    return block(
      pull,
      targets,
      review.reasons.map((reason) => `Security review: ${reason}`),
    );

  const fresh = await getPull(pull.number);
  if (!fresh || fresh.state !== "open" || fresh.headSha !== pull.headSha) return "waiting";
  if (fresh.draft) await markReadyForReview(fresh.nodeId);
  const merged = await squashMerge(pull.number, pull.headSha, pull.title);
  if (!merged.ok) return block(pull, targets, [`GitHub refused the merge (HTTP ${merged.status}): ${merged.message}`]);
  await decide(
    pull,
    { decision: "merged", reason: null, targets, mergeSha: merged.sha },
    `:rocket: Merged ${link(pull)} automatically (${targets.join(", ")}; squash commit ${merged.sha.slice(0, 7)}). CI is green and the security review passed. Once it is live I'll check whether conversations that use it go better.`,
  );
  log.info(`SelfModify.Merge: merged #${pull.number} as ${merged.sha}`);
  return "merged";
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
      if (!channelId || !row.threadTs) continue;
      const pull = await getPull(row.pullNumber);
      const ownerUserId = await selfReviewUserId();
      const now = new Date();
      const task = await createTask({
        ownerUserId,
        title: `Check the effect of #${row.pullNumber}`,
        goal: verificationGoal(row.pullNumber, pull?.url ?? null, row.targets, now),
        successCriteria: `A verdict on #${row.pullNumber} was posted in this thread with self-modify-impact.`,
        plan: null,
        channelId,
        threadTs: row.threadTs,
        ...(await resolveAccess(ownerUserId, channelId)),
        checkEveryMinutes: CHECK_EVERY_MINUTES,
        firstCheckAt: null,
        deadline: new Date(now.getTime() + VERIFY_DAYS * 86_400_000),
      });
      await markLive(row.id, task.id);
      await post("chat.postMessage", {
        channel: channelId,
        thread_ts: row.threadTs,
        text: `:white_check_mark: #${row.pullNumber} is live in production (${appCommit.slice(0, 7)}). I'll compare conversations that use ${row.targets.join(", ")} before and after it every ${CHECK_EVERY_MINUTES} minutes on workdays, for up to ${VERIFY_DAYS} days.`,
      });
      live += 1;
    } catch (error) {
      log.error(`SelfModify.Merge: live check failed for #${row.pullNumber}: ${(error as Error).message}`);
    }
  }
  return live;
}

export async function runAutoMerge(): Promise<{ live: number; outcomes: Record<number, Outcome> }> {
  const live = await detectLive();
  const outcomes: Record<number, Outcome> = {};
  if (!config.selfReviewChannelId || !(await autoMergeEnabled())) return { live, outcomes };
  for (const pullNumber of await recordedOpenPulls()) {
    try {
      outcomes[pullNumber] = await processPull(pullNumber);
    } catch (error) {
      log.error(`SelfModify.Merge: failed for #${pullNumber}: ${(error as Error).message}`);
    }
  }
  return { live, outcomes };
}
