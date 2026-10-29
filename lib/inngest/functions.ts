import { NonRetriableError } from "inngest";
import { config } from "../config.ts";
import { runRecent } from "../analytics/rollup.ts";
import { deleteLogsOlderThan, deleteOlderThan } from "../events/store.ts";
import { executeJob, JobError } from "../jobs/execute.ts";
import { completeJob, dispatchUndispatched, failJob, getJob, markExecuting, pruneJobs } from "../jobs/index.ts";
import { logger } from "../log.ts";
import { ensureValidToken, invalidateTools, listAllConnectionsWithProvider, markExpired, markNotified } from "../mcp/index.ts";
import { expiredConnectionPrompt } from "../mcp/tools.ts";
import { flush, staleKeys } from "../memory/buffer.ts";
import { extractSession } from "../memory/extractor.ts";
import { sweep } from "../memory/pending.ts";
import { processAllBuckets, reviewProcessedGraph } from "../memory/retrospector.ts";
import { runHolidayCheck } from "../holidays.ts";
import { cleanUpClosedPulls } from "../self-modify-pulls.ts";
import { deliverProactive } from "../proactive.ts";
import { runMorning as selfReviewMorning, runNightly as selfReviewNightly } from "../self-review/index.ts";
import { scheduleCronSkills, scheduleFirmowidEvening, scheduleFirmowidMorning, scheduleReminders } from "../schedulers.ts";
import { refresh as refreshGitleaks } from "../security/gitleaks.ts";
import { runAbsenceFollowUp } from "../nudges/absence.ts";
import { runProjectSummaries } from "../nudges/projects.ts";
import { runWorkStartNudges } from "../nudges/waiting.ts";
import { runWeeklyWrapUps } from "../nudges/weekly.ts";
import { startCapabilityBuild, syncCapabilityRequests } from "../tasks/capabilities.ts";
import {
  EVENTS,
  inngest,
  ROOT_THREAD_KEY,
  type AbsenceRecordedData,
  type BufferPushedData,
  type JobScheduledData,
  type SessionActivityData,
} from "./client.ts";

const tz = (cron: string) => `TZ=Europe/Warsaw ${cron}`;

const cronFunctions = new Set<unknown>();

const cronFunction = (id: string, cron: string, run: () => Promise<unknown>) => {
  const fn = inngest.createFunction({ id, triggers: [{ cron: tz(cron) }], retries: 2, concurrency: 1 }, async ({ step }) =>
    step.run(id, async () => (await run()) ?? null),
  );
  cronFunctions.add(fn);
  return fn;
};

const runJob = inngest.createFunction(
  {
    id: "run-job",
    triggers: [{ event: EVENTS.jobScheduled }],
    retries: 2,
    idempotency: "event.data.jobId",
    cancelOn: [{ event: EVENTS.jobCancelled, match: "data.jobId" }],
  },
  async ({ event, step, attempt }) => {
    const { jobId, label } = event.data as JobScheduledData;
    const named = (id: string, name: string) => (label ? { id, name: `${name}: ${label}` } : id);
    const scheduledAt = await step.run(named("load", "load"), async () => (await getJob(jobId))?.scheduledAt.toISOString() ?? null);
    if (!scheduledAt) return { skipped: "missing", jobId, label };
    await step.sleepUntil(named("wait-until-due", `wait until ${scheduledAt}`), scheduledAt);

    return step.run(named("execute", "execute"), async () => {
      const job = await markExecuting(jobId);
      if (!job) return { skipped: "not_scheduled", jobId, label };
      try {
        await executeJob(job);
        await completeJob(jobId);
        return { done: true, jobId, kind: job.kind, label };
      } catch (error) {
        const final = error instanceof JobError || attempt >= 2;
        await failJob(jobId, error, final);
        if (error instanceof JobError) throw new NonRetriableError(error.message);
        throw error;
      }
    });
  },
);

const proactiveSend = inngest.createFunction(
  { id: "proactive-send", triggers: [{ event: EVENTS.proactiveRequested }], retries: 2 },
  async ({ event, step }) =>
    step.run("deliver", async () => {
      const { userId, prompt } = event.data as { userId: string; prompt: string };
      const result = await deliverProactive(userId, prompt);
      if (!result.ok) throw new NonRetriableError(result.error);
      return null;
    }),
);

const absenceFollowUp = inngest.createFunction(
  {
    id: "absence-follow-up",
    triggers: [{ event: EVENTS.absenceRecorded }],
    retries: 1,
    debounce: { key: "event.data.userId", period: "2m" },
  },
  async ({ event, step }) =>
    step.run("follow-up", async () => {
      const { userId, startDate, endDate, working } = event.data as AbsenceRecordedData;
      return { userId, period: `${startDate}..${endDate}`, sent: await runAbsenceFollowUp(userId, startDate, endDate, working) };
    }),
);

const capabilityBuild = inngest.createFunction(
  { id: "capability-build", triggers: [{ event: EVENTS.capabilityApproved }], retries: 1, idempotency: "event.data.requestId" },
  async ({ event, step }) =>
    step.run("start", async () => {
      const { requestId } = event.data as { requestId: string };
      return { requestId, started: await startCapabilityBuild(requestId) };
    }),
);

const extractSessionFn = inngest.createFunction(
  {
    id: "extract-session",
    triggers: [{ event: EVENTS.sessionActivity }],
    debounce: { key: "event.data.sessionKey", period: "1m" },
    retries: 2,
  },
  async ({ event, step }) =>
    step.run("extract", async () => {
      const { sessionKey, writeAccess, slackChannelId } = event.data as SessionActivityData;
      return { authors: await extractSession(sessionKey, writeAccess, slackChannelId) };
    }),
);

const flushBuffer = inngest.createFunction(
  {
    id: "memory-buffer-flush",
    triggers: [{ event: EVENTS.bufferPushed }],
    debounce: { key: 'event.data.channelId + ":" + event.data.threadKey', period: "60s" },
    retries: 2,
  },
  async ({ event, step }) =>
    step.run("flush", async () => {
      const { channelId, threadKey } = event.data as BufferPushedData;
      return { messages: await flush(channelId, threadKey === ROOT_THREAD_KEY ? null : threadKey) };
    }),
);

const mcpExpiry = cronFunction("mcp-expiry", "15 * * * *", async () => {
  const log = logger("McpExpiryWorker");
  const all = await listAllConnectionsWithProvider();
  const expired: string[] = [];
  for (const { connection, provider } of all) {
    const token = await ensureValidToken(connection);
    if (token.ok) continue;
    expired.push(`${provider.id}/${connection.userId}`);
    log.info(`McpExpiryWorker: ${provider.id}/${connection.userId} unhealthy (${token.error}), marking expired`);
    invalidateTools(connection.userId, provider.id);
    const updated = await markExpired(connection);
    if (updated.notifiedExpiredAt === null) {
      await deliverProactive(connection.userId, expiredConnectionPrompt(provider.name));
      await markNotified(updated);
    }
  }
  log.info(`McpExpiryWorker: checked ${all.length} connection(s)`);
  return { checked: all.length, expired };
});

const maintenance = cronFunction("maintenance", "*/5 * * * *", async () => {
  const dispatched = await dispatchUndispatched();
  const stale = await staleKeys(120);
  for (const key of stale) await flush(key.channelId, key.threadTs);
  return { dispatched, flushed: stale.length };
});

const cleanup = cronFunction("events-cleanup", "40 * * * *", async () => {
  await deleteLogsOlderThan(24);
  await deleteOlderThan(7);
  await sweep();
  await pruneJobs(7);
});

const allFunctions = [
  runJob,
  proactiveSend,
  absenceFollowUp,
  capabilityBuild,
  extractSessionFn,
  flushBuffer,
  cronFunction("retrospection", "5 */3 * * *", async () => {
    await processAllBuckets();
    logger("RetrospectionWorker").info("RetrospectionWorker: completed");
  }),
  cronFunction("graph-review", "10 2 * * *", async () => {
    await reviewProcessedGraph();
    logger("GraphReviewWorker").info("GraphReviewWorker: completed");
  }),
  cronFunction("reminder-scheduler", "0 * * * *", async () => ({ scheduled: await scheduleReminders() })),
  cronFunction("skill-scheduler", "0 * * * *", async () => ({ scheduled: await scheduleCronSkills() })),
  cronFunction("firmowid-evening-scheduler", "0 9 * * 1-5", () => scheduleFirmowidEvening()),
  cronFunction("firmowid-morning-scheduler", "0 21 * * 0-4", () => scheduleFirmowidMorning()),
  cronFunction("analytics-rollup", "25 * * * *", async () => {
    await runRecent(4);
    logger("RollupWorker").info("RollupWorker: rolled up the last 4 day(s)");
  }),
  cronFunction("holiday-check", "0 10 * * 1-5", () => runHolidayCheck()),
  cronFunction("nudges-work-start", "*/15 7-12 * * 1-5", async () => ({ sent: await runWorkStartNudges() })),
  cronFunction("nudges-weekly", "*/30 12-17 * * 5", async () => ({ sent: await runWeeklyWrapUps() })),
  cronFunction("nudges-project-summaries", "0 15 * * 5", async () => ({ posted: await runProjectSummaries() })),
  cronFunction("self-modify-cleanup", "20 * * * *", () => cleanUpClosedPulls()),
  cronFunction("capability-sync", "*/10 * * * *", () => syncCapabilityRequests()),
  cronFunction("gitleaks-refresh", "0 3 * * *", () => refreshGitleaks()),
  cronFunction("self-review", "30 3 * * *", () => selfReviewNightly()),
  cronFunction("self-review-outreach", "30 9 * * 1-5", () => selfReviewMorning()),
  mcpExpiry,
  maintenance,
  cleanup,
];

export const functions = config.cronsEnabled ? allFunctions : allFunctions.filter((fn) => !cronFunctions.has(fn));
