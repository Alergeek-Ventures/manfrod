import { getUser } from "../accounts.ts";
import type { SelfModifyMerge, SelfModifyRehearsal } from "../db/schema.ts";
import { agentRuntime, type HandoffAuth } from "../inngest/runtime.ts";
import { logger } from "../log.ts";
import { readOnlyAccess } from "../memory/access.ts";
import { liveUnjudged, recordVerdict } from "../self-modify-merge/store.ts";
import { reopenFinding } from "../self-review/store.ts";
import { deactivatedSlackIds, post } from "../slack/api.ts";
import { REHEARSAL_KIND } from "./guard.ts";
import { jevJudge, outcome, transcriptFrom, type Judge, type RehearsalVerdict, type Transcript } from "./judge.ts";
import type { Scenario, Target } from "./scenarios.ts";
import { failedStart, finish, forMerges, markRunning, pendingLive, running } from "./store.ts";

const log = logger("SelfModify.Rehearsal");
const TIMEOUT_MINUTES = 30;
const PENDING_HOURS = 6;
const MAX_START_ATTEMPTS = 3;
const PER_RUN = 5;

export const escapeSlack = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function targetOf(merge: SelfModifyMerge): Target | null {
  if (!merge.targetProblem || !merge.targetExpected) return null;
  return {
    source: (merge.targetSource ?? "description") as Target["source"],
    title: merge.targetTitle ?? "",
    problem: merge.targetProblem,
    expected: merge.targetExpected,
    findingId: merge.findingId,
  };
}

const UNAVAILABLE = "The person or channel is no longer available.";

export async function rehearsalAuth(rehearsal: Pick<SelfModifyRehearsal, "id" | "userId" | "channelId">): Promise<HandoffAuth | null> {
  if (!rehearsal.channelId) return null;
  const person = await getUser(rehearsal.userId);
  if (!person || person.banned || (await deactivatedSlackIds()).has(person.slackId)) return null;
  const access = await readOnlyAccess(person.id, rehearsal.channelId);
  return {
    authenticator: "manfrod",
    principalType: "user",
    principalId: person.id,
    attributes: {
      userId: person.id,
      slackUserId: person.slackId,
      kind: REHEARSAL_KIND,
      rehearsalId: rehearsal.id,
      channelId: rehearsal.channelId,
      readableLevels: access.readableLevels,
      writeAccess: access.writeAccess,
    },
  };
}

export async function startPending(now = new Date()): Promise<number> {
  let started = 0;
  for (const rehearsal of await pendingLive(PER_RUN)) {
    try {
      if (now.getTime() - rehearsal.liveAt.getTime() > PENDING_HOURS * 3_600_000) {
        await finish(rehearsal.id, "failed", null, "unclear", `The rehearsal could not start within ${PENDING_HOURS} hours.`);
        continue;
      }
      const scenario = rehearsal.scenario as Scenario | null;
      const auth = await rehearsalAuth(rehearsal);
      if (!scenario || !auth) {
        await finish(rehearsal.id, "failed", null, "unclear", UNAVAILABLE);
        continue;
      }
      const sessionId = await agentRuntime().startHeadless(`rehearsal:${rehearsal.id}`, scenario.message, auth, scenario.history);
      await markRunning(rehearsal.id, sessionId);
      started += 1;
    } catch (error) {
      log.error(`SelfModify.Rehearsal: could not start ${rehearsal.id}: ${(error as Error).message}`);
      if ((await failedStart(rehearsal.id)) >= MAX_START_ATTEMPTS) {
        await finish(rehearsal.id, "failed", null, "unclear", `The rehearsal failed to start ${MAX_START_ATTEMPTS} times.`);
      }
    }
  }
  return started;
}

async function judged(judge: Judge, target: Target | null, scenario: Scenario, transcript: Transcript) {
  if (!target) return { verdict: "unclear" as const, reason: "No target was stored." };
  try {
    return await judge(target, scenario, transcript);
  } catch (error) {
    return { verdict: "unclear" as const, reason: `The judge failed: ${(error as Error).message}` };
  }
}

export async function collect(judge: Judge = jevJudge, now = new Date()): Promise<number> {
  const merges = new Map((await liveUnjudged()).map((merge) => [merge.id, merge]));
  let finished = 0;
  for (const rehearsal of await running(PER_RUN)) {
    const timedOut = !rehearsal.startedAt || now.getTime() - rehearsal.startedAt.getTime() > TIMEOUT_MINUTES * 60_000;
    try {
      let transcript: Transcript | null = null;
      try {
        transcript = transcriptFrom(await agentRuntime().sessionEvents(rehearsal.sessionId!));
      } catch (error) {
        if (!timedOut) throw error;
      }
      if (!transcript) {
        if (!timedOut) continue;
        await finish(rehearsal.id, "failed", null, "unclear", `The rehearsal did not finish within ${TIMEOUT_MINUTES} minutes.`);
      } else {
        const merge = merges.get(rehearsal.mergeId);
        const result = await judged(judge, merge ? targetOf(merge) : null, rehearsal.scenario as Scenario, transcript);
        await finish(rehearsal.id, "done", transcript, result.verdict, result.reason);
      }
      finished += 1;
      await agentRuntime()
        .endSession(rehearsal.sessionId!)
        .catch((error: Error) => log.warn(`SelfModify.Rehearsal: could not end ${rehearsal.sessionId}: ${error.message}`));
    } catch (error) {
      log.error(`SelfModify.Rehearsal: could not collect ${rehearsal.id}: ${(error as Error).message}`);
    }
  }
  return finished;
}

const HEADLINES: Record<RehearsalVerdict, string> = {
  fixed: ":white_check_mark: Fixed",
  still_broken: ":x: Still broken",
  unclear: ":grey_question: Unclear",
};

export function outcomeText(
  merge: Pick<SelfModifyMerge, "pullNumber" | "findingId">,
  rehearsals: Pick<SelfModifyRehearsal, "verdict" | "reason" | "evidenceLink">[],
  verdict: RehearsalVerdict,
): string {
  const lines = rehearsals.map((rehearsal, index) => {
    const label = `scenario ${index + 1}`;
    const named = rehearsal.evidenceLink ? `<${rehearsal.evidenceLink}|${label}>` : label;
    return `• ${named}: ${rehearsal.verdict ?? "unclear"}, ${escapeSlack(rehearsal.reason ?? "")}`;
  });
  const summary =
    rehearsals.length === 0
      ? "there was no scenario to rehearse."
      : `rehearsed ${rehearsals.length} scenario(s) on the new version of #${merge.pullNumber}.`;
  const reopened =
    verdict === "still_broken" && merge.findingId ? "\nI reopened the finding, so the nightly self-review picks it up again." : "";
  return `${HEADLINES[verdict]}: ${summary}${lines.length > 0 ? `\n${lines.join("\n")}` : ""}${reopened}`;
}

export async function settle(): Promise<number> {
  const merges = await liveUnjudged();
  const rehearsals = await forMerges(merges.map((merge) => merge.id));
  let settled = 0;
  for (const merge of merges) {
    const own = rehearsals.filter((rehearsal) => rehearsal.mergeId === merge.id);
    if (own.some((rehearsal) => rehearsal.status === "pending" || rehearsal.status === "running")) continue;
    try {
      const verdict = outcome(own.map((rehearsal) => (rehearsal.verdict ?? "unclear") as RehearsalVerdict));
      if (verdict === "still_broken" && merge.findingId) await reopenFinding(merge.findingId);
      if (merge.channelId && merge.threadTs) {
        await post("chat.postMessage", { channel: merge.channelId, thread_ts: merge.threadTs, text: outcomeText(merge, own, verdict) });
      }
      await recordVerdict(merge.id, verdict);
      settled += 1;
    } catch (error) {
      log.error(`SelfModify.Rehearsal: could not settle #${merge.pullNumber}: ${(error as Error).message}`);
    }
  }
  return settled;
}

export async function runRehearsals(judge: Judge = jevJudge): Promise<{ started: number; finished: number; settled: number }> {
  const started = await startPending();
  const finished = await collect(judge);
  const settled = await settle();
  return { started, finished, settled };
}
