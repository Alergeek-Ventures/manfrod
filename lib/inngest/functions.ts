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
import { deliverProactive } from "../proactive.ts";
import { scheduleCronSkills, scheduleFirmowidEvening, scheduleFirmowidMorning, scheduleReminders } from "../schedulers.ts";
import { refresh as refreshGitleaks } from "../security/gitleaks.ts";
import { EVENTS, inngest, ROOT_THREAD_KEY, type BufferPushedData, type JobScheduledData, type SessionActivityData } from "./client.ts";

const tz = (cron: string) => `TZ=Europe/Warsaw ${cron}`;

const cronFunctions = new Set<unknown>();

const cronFunction = (id: string, cron: string, run: () => Promise<unknown>) => {
  const fn = inngest.createFunction({ id, triggers: [{ cron: tz(cron) }], retries: 2, concurrency: 1 }, async ({ step }) =>
    step.run(id, async () => {
      await run();
      return null;
    }),
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
    const { jobId } = event.data as JobScheduledData;
    const scheduledAt = await step.run("load", async () => (await getJob(jobId))?.scheduledAt.toISOString() ?? null);
    if (!scheduledAt) return { skipped: "missing" };
    await step.sleepUntil("wait-until-due", scheduledAt);

    return step.run("execute", async () => {
      const job = await markExecuting(jobId);
      if (!job) return { skipped: "not_scheduled" };
      try {
        await executeJob(job);
        await completeJob(jobId);
        return { done: true };
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
  for (const { connection, provider } of all) {
    const token = await ensureValidToken(connection);
    if (token.ok) continue;
    log.info(`McpExpiryWorker: ${provider.id}/${connection.userId} unhealthy (${token.error}), marking expired`);
    invalidateTools(connection.userId, provider.id);
    const updated = await markExpired(connection);
    if (updated.notifiedExpiredAt === null) {
      await deliverProactive(connection.userId, expiredConnectionPrompt(provider.name));
      await markNotified(updated);
    }
  }
  log.info(`McpExpiryWorker: checked ${all.length} connection(s)`);
});

const maintenance = cronFunction("maintenance", "*/5 * * * *", async () => {
  await dispatchUndispatched();
  for (const key of await staleKeys(120)) await flush(key.channelId, key.threadTs);
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
  cronFunction("reminder-scheduler", "0 * * * *", () => scheduleReminders()),
  cronFunction("skill-scheduler", "0 * * * *", () => scheduleCronSkills()),
  cronFunction("firmowid-evening-scheduler", "0 9 * * 1-5", () => scheduleFirmowidEvening()),
  cronFunction("firmowid-morning-scheduler", "0 21 * * 0-4", () => scheduleFirmowidMorning()),
  cronFunction("analytics-rollup", "25 * * * *", async () => {
    await runRecent(4);
    logger("RollupWorker").info("RollupWorker: rolled up the last 4 day(s)");
  }),
  cronFunction("gitleaks-refresh", "0 3 * * *", () => refreshGitleaks()),
  mcpExpiry,
  maintenance,
  cleanup,
];

export const functions = config.cronsEnabled ? allFunctions : allFunctions.filter((fn) => !cronFunctions.has(fn));
