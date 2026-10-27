import { getUser, systemUserId } from "../accounts.ts";
import type { Job } from "../db/schema.ts";
import { currentSession, hasActiveSession } from "../firmowid.ts";
import { agentRuntime, type HandoffAuth } from "../inngest/runtime.ts";
import { listOfficeAccessLog } from "../kalafiornia.ts";
import { logger } from "../log.ts";
import { builtinProviders, ensureValidToken, getConnection } from "../mcp/index.ts";
import { getRecurringReminder } from "../memory/reminders.ts";
import { deliverProactive, proactiveTitle, startThread, userAuth } from "../proactive.ts";
import { get as getRoutine } from "../routines.ts";
import { formatLocal } from "../time.ts";

export class JobError extends Error {}

const FIRMOWID = "firmowid";
const FORGOTTEN_SESSION_MS = 2 * 3_600_000;

export async function executeJob(job: Job): Promise<void> {
  const args = job.args as Record<string, string>;
  switch (job.kind) {
    case "trigger":
      return args.recurring_reminder_id ? runRecurringReminder(args) : runOneTimeTrigger(args);
    case "skill_trigger":
      return runSkill(args.skill_name, args.user_id ?? null);
    case "firmowid_session_check":
      return runFirmowidEveningCheck(args.user_id);
    case "firmowid_morning_session_check":
      return runFirmowidMorningCheck(args.user_id, args.date);
    default:
      throw new JobError(`unknown job kind ${job.kind}`);
  }
}

async function sendProactiveOrThrow(userId: string, prompt: string, triggerId: string) {
  const log = logger("TriggerWorker");
  const result = await deliverProactive(userId, prompt, "trigger");
  if (!result.ok) {
    log.error(`TriggerWorker: failed to send trigger '${triggerId}' for user ${userId}: ${result.error}`);
    throw new JobError(result.error);
  }
  log.info(`TriggerWorker: trigger '${triggerId}' sent via Proactive for user ${userId}`);
}

async function runRecurringReminder(args: Record<string, string>) {
  const log = logger("TriggerWorker");
  const { recurring_reminder_id: reminderId, user_id: userId } = args;
  log.info(`TriggerWorker: executing recurring reminder '${reminderId}' for user ${userId}`);
  const reminder = await getRecurringReminder(userId, reminderId);
  if (!reminder) {
    log.warn(`TriggerWorker: recurring reminder '${reminderId}' not found, skipping`);
    return;
  }
  if (!reminder.enabled) {
    log.info(`TriggerWorker: recurring reminder '${reminder.name}' is disabled, skipping`);
    return;
  }
  const prompt = `[Recurring Reminder: ${reminder.name}]\n\n${reminder.instructions}`.trim();
  await sendProactiveOrThrow(userId, prompt, `recurring:${reminder.name}`);
}

async function runOneTimeTrigger(args: Record<string, string>) {
  logger("TriggerWorker").info(`TriggerWorker: executing one-time trigger '${args.trigger_id}' for user ${args.user_id}`);
  await sendProactiveOrThrow(args.user_id, args.prompt, args.trigger_id);
}

async function skillRunnerAuth(): Promise<HandoffAuth> {
  const id = await systemUserId("system:skill-runner", "Skill Runner", "skill-runner@system.manfrod");
  return {
    authenticator: "manfrod",
    principalType: "service",
    principalId: id,
    attributes: { userId: id, slackUserId: "system:skill-runner", kind: "skill_channel" },
  };
}

export async function runSkill(skillName: string, userId: string | null, titleSource?: string): Promise<void> {
  const log = logger("SkillRunner");
  const skill = getRoutine(skillName);
  if (!skill) {
    log.error(`SkillRunner: cannot run '${skillName}': not_found`);
    throw new JobError("not_found");
  }

  if (userId === null) {
    if (!skill.channel) {
      log.error(`SkillRunner: cannot run '${skillName}': missing_channel`);
      throw new JobError("missing_channel");
    }
    await agentRuntime().sendToSlack({ channelId: skill.channel }, skill.body, {
      ...(await skillRunnerAuth()),
    });
    log.info(`SkillRunner: '${skillName}' started`);
    return;
  }

  const user = await getUser(userId);
  if (!user?.slackDmChannelId) {
    log.error(`SkillRunner: cannot run '${skillName}': no_dm_channel ${userId}`);
    throw new JobError("no_dm_channel");
  }
  const thread = await startThread(user.slackDmChannelId, await proactiveTitle(titleSource ?? `${skill.description}\n\n${skill.body}`));
  if (!thread.ok) {
    log.error(`SkillRunner: failed to start DM thread in ${user.slackDmChannelId}: ${thread.error}`);
    throw new JobError(thread.error);
  }
  await agentRuntime().sendToSlack(
    { channelId: user.slackDmChannelId, threadTs: thread.threadTs },
    skill.body,
    userAuth(userId, user.slackId, {
      kind: "skill_user",
      skillName,
      channelId: user.slackDmChannelId,
      threadTs: thread.threadTs,
    }),
  );
  log.info(`SkillRunner: '${skillName}' started for ${userId}`);
}

async function runFirmowidEveningCheck(userId: string) {
  const log = logger("FirmowidSessionCheckWorker");
  const connection = await getConnection(userId, FIRMOWID);
  const provider = builtinProviders().find((candidate) => candidate.id === FIRMOWID);
  if (!connection || !provider) return;
  const token = await ensureValidToken(connection);
  if (!token.ok) {
    log.debug(`FirmowidSessionCheckWorker: skipping ${userId}: ${token.error}`);
    return;
  }
  const session = await currentSession(provider.mcpUrl, token.value);
  if (!session.ok) {
    log.debug(`FirmowidSessionCheckWorker: skipping ${userId}: ${session.error}`);
    return;
  }
  const started = typeof session.value?.start_datetime === "string" ? new Date(session.value.start_datetime) : null;
  if (!started || Date.now() - started.getTime() <= FORGOTTEN_SESSION_MS) return;
  const title = typeof session.value?.title === "string" ? session.value.title : "";
  await runSkill(
    "firmowid-session-check",
    userId,
    `Sesja w Firmowidzie "${title}" trwa od ${formatLocal(started)}, może została zapomniana`,
  );
}

async function runFirmowidMorningCheck(userId: string, date: string) {
  const log = logger("FirmowidMorningSessionCheckWorker");
  const connection = await getConnection(userId, FIRMOWID);
  const provider = builtinProviders().find((candidate) => candidate.id === FIRMOWID);
  if (!connection || !provider) return;
  const token = await ensureValidToken(connection);
  if (!token.ok) {
    log.debug(`FirmowidMorningSessionCheckWorker: skipping ${userId}: ${token.error}`);
    return;
  }
  const active = await hasActiveSession(provider.mcpUrl, token.value);
  if (!active.ok) {
    log.debug(`FirmowidMorningSessionCheckWorker: skipping ${userId}: ${active.error}`);
    return;
  }
  if (active.value) return;

  const user = await getUser(userId);
  if (!user?.name) return;
  const entries = await listOfficeAccessLog({ since: date, userName: user.name });
  if (!entries.ok) {
    log.debug(`FirmowidMorningSessionCheckWorker: skipping ${userId}: ${entries.error}`);
    return;
  }
  if (entries.value.length === 0) return;
  await runSkill("firmowid-morning-checkin", userId);
}
