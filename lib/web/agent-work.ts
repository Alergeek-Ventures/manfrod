import { and, asc, count, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import { BAD_RATING, feedbackSince, INFERRED_RATING } from "../self-review/rules.ts";
import { archiveLink, botIdentity } from "../slack/api.ts";
import { MAX_CHECKS, OPEN_STATUSES } from "../tasks/index.ts";

const { agentTasks, agentTaskUpdates, capabilityRequests, messageFeedback, selfModifyPulls, selfReviewCases, selfReviewFindings } = tables;
const { selfReviewSessions, sentDms, users } = tables;

const CLOSED_WINDOW_DAYS = 30;
const SESSION_WINDOW_DAYS = 7;
const MAX_FINDINGS = 200;

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

async function threadLinker() {
  const url = (await botIdentity())?.url;
  return (channel: string | null, ts: string | null) => (url && channel && ts ? archiveLink(url, channel, ts) : null);
}

export async function loadTasks() {
  const link = await threadLinker();
  const rows = await db
    .select({ task: agentTasks, ownerName: users.name, ownerSlackId: users.slackId })
    .from(agentTasks)
    .leftJoin(users, eq(users.id, agentTasks.ownerUserId))
    .where(or(inArray(agentTasks.status, [...OPEN_STATUSES]), gte(agentTasks.closedAt, daysAgo(CLOSED_WINDOW_DAYS))))
    .orderBy(desc(agentTasks.insertedAt));
  const ids = rows.map((row) => row.task.id);
  const updates =
    ids.length === 0
      ? []
      : await db.select().from(agentTaskUpdates).where(inArray(agentTaskUpdates.taskId, ids)).orderBy(asc(agentTaskUpdates.insertedAt));
  const dms =
    ids.length === 0
      ? []
      : await db
          .select({ dm: sentDms, recipient: users.name })
          .from(sentDms)
          .leftJoin(users, eq(users.id, sentDms.recipientUserId))
          .where(inArray(sentDms.taskId, ids))
          .orderBy(asc(sentDms.insertedAt));
  const tasks = rows.map(({ task, ownerName, ownerSlackId }) => ({
    ...task,
    ownerName,
    ownerSlackId,
    maxChecks: MAX_CHECKS,
    link: link(task.channelId, task.threadTs),
    updates: updates.filter((update) => update.taskId === task.id),
    dms: dms
      .filter(({ dm }) => dm.taskId === task.id)
      .map(({ dm, recipient }) => ({ id: dm.id, recipient, text: dm.text, at: dm.insertedAt, link: link(dm.channelId, dm.messageTs) })),
  }));

  const requests = (
    await db
      .select({ request: capabilityRequests, requester: users.name })
      .from(capabilityRequests)
      .leftJoin(users, eq(users.id, capabilityRequests.requestedByUserId))
      .where(
        or(inArray(capabilityRequests.status, ["pending", "approved"]), gte(capabilityRequests.updatedAt, daysAgo(CLOSED_WINDOW_DAYS))),
      )
      .orderBy(desc(capabilityRequests.insertedAt))
  ).map(({ request, requester }) => ({ ...request, requester, link: link(request.channelId, request.threadTs) }));

  return { tasks, requests, closedWindowDays: CLOSED_WINDOW_DAYS };
}

export async function loadSelfReview() {
  const link = await threadLinker();
  const findings = await db.select().from(selfReviewFindings).orderBy(desc(selfReviewFindings.insertedAt)).limit(MAX_FINDINGS);
  const cases = await db
    .select({ case: selfReviewCases, feedback: messageFeedback })
    .from(selfReviewCases)
    .innerJoin(messageFeedback, eq(messageFeedback.id, selfReviewCases.feedbackId))
    .orderBy(desc(selfReviewCases.insertedAt));
  const evidence = (findingId: string) =>
    cases
      .filter((row) => row.case.findingId === findingId)
      .map(({ feedback }) => ({
        id: feedback.id,
        rater: feedback.slackUserName,
        rating: feedback.rating,
        at: feedback.insertedAt,
        link: feedback.permalink,
      }));

  const [untriaged] = await db
    .select({ count: count() })
    .from(messageFeedback)
    .leftJoin(selfReviewCases, eq(selfReviewCases.feedbackId, messageFeedback.id))
    .where(
      and(
        inArray(messageFeedback.rating, [BAD_RATING, INFERRED_RATING]),
        isNull(selfReviewCases.id),
        gte(messageFeedback.insertedAt, feedbackSince(new Date())),
      ),
    );
  const verdicts = await db
    .select({ verdict: selfReviewSessions.verdict, count: count() })
    .from(selfReviewSessions)
    .where(gte(selfReviewSessions.updatedAt, daysAgo(SESSION_WINDOW_DAYS)))
    .groupBy(selfReviewSessions.verdict);
  const [openPulls] = await db.select({ count: count() }).from(selfModifyPulls).where(eq(selfModifyPulls.status, "open"));

  return {
    findings: findings.map((finding) => ({
      ...finding,
      session: link(finding.sessionChannelId, finding.sessionThreadTs),
      evidence: evidence(finding.id),
    })),
    cases: cases
      .filter((row) => row.case.status !== "linked")
      .map(({ case: row, feedback }) => ({
        id: row.id,
        status: row.status,
        reason: row.reason,
        question: row.question,
        askedAt: row.askedAt,
        insertedAt: row.insertedAt,
        rater: feedback.slackUserName,
        rating: feedback.rating,
        link: feedback.permalink,
        clarification: link(row.clarificationChannelId, row.clarificationThreadTs),
      })),
    untriaged: Number(untriaged?.count ?? 0),
    verdicts: Object.fromEntries(verdicts.map((row) => [row.verdict, Number(row.count)])) as Record<string, number>,
    openPulls: Number(openPulls?.count ?? 0),
    sessionWindowDays: SESSION_WINDOW_DAYS,
  };
}

export type TasksData = Awaited<ReturnType<typeof loadTasks>>;
export type SelfReviewData = Awaited<ReturnType<typeof loadSelfReview>>;
