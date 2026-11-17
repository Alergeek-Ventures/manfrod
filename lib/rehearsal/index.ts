import { getUser } from "../accounts.ts";
import type { SelfModifyMerge, SelfModifyRehearsal } from "../db/schema.ts";
import { agentRuntime, type HandoffAuth } from "../inngest/runtime.ts";
import { logger } from "../log.ts";
import { resolveAccess } from "../memory/access.ts";
import { liveUnjudged, recordVerdict } from "../self-modify-merge/store.ts";
import { reopenFinding } from "../self-review/store.ts";
import { post } from "../slack/api.ts";
import { REHEARSAL_KIND } from "./guard.ts";
import { jevJudge, outcome, transcriptFrom, type Judge, type RehearsalVerdict } from "./judge.ts";
import type { Scenario, Target } from "./scenarios.ts";
import { finish, forMerges, markRunning, pendingLive, running } from "./store.ts";

const log = logger("SelfModify.Rehearsal");
const TIMEOUT_MINUTES = 30;

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

export async function rehearsalAuth(rehearsal: Pick<SelfModifyRehearsal, "id" | "userId" | "channelId">): Promise<HandoffAuth | null> {
  const person = await getUser(rehearsal.userId);
  if (!person) return null;
  const access = await resolveAccess(person.id, rehearsal.channelId);
  return {
    authenticator: "manfrod",
    principalType: "user",
    principalId: person.id,
    attributes: {
      userId: person.id,
      slackUserId: person.slackId,
      kind: REHEARSAL_KIND,
      rehearsalId: rehearsal.id,
      readableLevels: access.readableLevels,
      writeAccess: access.writeAccess,
      ...(rehearsal.channelId ? { channelId: rehearsal.channelId } : {}),
    },
  };
}

export async function startPending(): Promise<number> {
  let started = 0;
  for (const rehearsal of await pendingLive()) {
    try {
      const scenario = rehearsal.scenario as Scenario | null;
      const auth = await rehearsalAuth(rehearsal);
      if (!scenario || !auth) {
        await finish(rehearsal.id, "failed", null, "unclear", "The scenario or the person it belongs to is gone.");
        continue;
      }
      const sessionId = await agentRuntime().startHeadless(`rehearsal:${rehearsal.id}`, scenario.message, auth, scenario.history);
      await markRunning(rehearsal.id, sessionId);
      started += 1;
    } catch (error) {
      log.error(`SelfModify.Rehearsal: could not start ${rehearsal.id}: ${(error as Error).message}`);
    }
  }
  return started;
}

export async function collect(judge: Judge = jevJudge, now = new Date()): Promise<number> {
  const merges = new Map((await liveUnjudged()).map((merge) => [merge.id, merge]));
  let finished = 0;
  for (const rehearsal of await running()) {
    try {
      const merge = merges.get(rehearsal.mergeId);
      const target = merge ? targetOf(merge) : null;
      const transcript = transcriptFrom(await agentRuntime().sessionEvents(rehearsal.sessionId!));
      if (!transcript) {
        if (rehearsal.startedAt && now.getTime() - rehearsal.startedAt.getTime() > TIMEOUT_MINUTES * 60_000) {
          await finish(rehearsal.id, "failed", null, "unclear", `The rehearsal did not finish within ${TIMEOUT_MINUTES} minutes.`);
          await agentRuntime().endSession(rehearsal.sessionId!);
          finished += 1;
        }
        continue;
      }
      let judged: { verdict: RehearsalVerdict; reason: string };
      try {
        judged = target
          ? await judge(target, rehearsal.scenario as Scenario, transcript)
          : { verdict: "unclear", reason: "No target was stored." };
      } catch (error) {
        judged = { verdict: "unclear", reason: `The judge failed: ${(error as Error).message}` };
      }
      await finish(rehearsal.id, "done", transcript, judged.verdict, judged.reason);
      await agentRuntime().endSession(rehearsal.sessionId!);
      finished += 1;
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
