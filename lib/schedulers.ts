import { Cron } from "croner";
import { getUser } from "./accounts.ts";
import { averageTimeOfDay, fetchRecentSessions } from "./firmowid.ts";
import { enqueue } from "./jobs/index.ts";
import { logger } from "./log.ts";
import { builtinProviders, ensureValidToken, listConnectionsForProvider } from "./mcp/index.ts";
import { listEnabledReminders } from "./memory/reminders.ts";
import { listCronRoutines, parseCron, type RoutineMeta } from "./routines.ts";
import { addDays, isoSeconds, localIsoWithOffset, localToday, TIMEZONE, zonedToUtc } from "./time.ts";

const SCHEDULE_WINDOW_HOURS = 12;
const FIRMOWID = "firmowid";
const SESSION_SAMPLE_SIZE = 100;
const FIRMOWID_OFFSET_MINUTES = 20;

export function nextOccurrences(cron: string, timezone: string, now: Date): Date[] {
  let schedule: Cron;
  try {
    schedule = new Cron(cron, { timezone, paused: true });
  } catch {
    return [];
  }
  const windowEnd = now.getTime() + SCHEDULE_WINDOW_HOURS * 3_600_000;
  const occurrences: Date[] = [];
  let cursor: Date | null = now;
  while (occurrences.length < 1_000) {
    cursor = schedule.nextRun(cursor);
    if (!cursor || cursor.getTime() > windowEnd) break;
    occurrences.push(cursor);
  }
  return occurrences;
}

export async function scheduleReminders(now = new Date()): Promise<number> {
  const log = logger("SchedulerWorker");
  log.info(`SchedulerWorker: scheduling triggers for next ${SCHEDULE_WINDOW_HOURS} hours`);
  let count = 0;
  for (const reminder of await listEnabledReminders()) {
    const occurrences = nextOccurrences(reminder.cron, reminder.timezone, now);
    if (occurrences.length === 0 && !validCron(reminder.cron, reminder.timezone)) {
      log.error(`SchedulerWorker: invalid cron expression for ${reminder.name}`);
      continue;
    }
    for (const scheduledAt of occurrences) {
      const iso = isoSeconds(scheduledAt);
      const { conflict } = await enqueue(
        "trigger",
        { recurring_reminder_id: reminder.id, user_id: reminder.userId, scheduled_at: iso },
        { scheduledAt, uniqueKey: `trigger:${reminder.id}:${iso}` },
      );
      if (!conflict) count += 1;
    }
  }
  log.info(`SchedulerWorker: scheduled ${count} new trigger jobs`);
  return count;
}

function validCron(cron: string, timezone: string): boolean {
  try {
    new Cron(cron, { timezone, paused: true });
    return true;
  } catch {
    return false;
  }
}

function randomInstant(date: string, start: string, end: string): Date {
  const startAt = zonedToUtc(date, start).getTime();
  const span = Math.max(Math.round((zonedToUtc(date, end).getTime() - startAt) / 1000), 1);
  return new Date(startAt + Math.floor(Math.random() * span) * 1000);
}

async function scheduleRandomOnce(skill: RoutineMeta, date: string, start: string, end: string, userId: string | null) {
  const args: Record<string, unknown> = { skill_name: skill.name, date };
  if (userId) args.user_id = userId;
  const uniqueKey = userId ? `skill_trigger:${skill.name}:${userId}:${date}` : `skill_trigger:${skill.name}:${date}`;
  const { conflict } = await enqueue("skill_trigger", args, { scheduledAt: randomInstant(date, start, end), uniqueKey });
  return conflict ? 0 : 1;
}

async function scheduleSkill(skill: RoutineMeta, now: Date): Promise<number> {
  const log = logger("SkillSchedulerWorker");
  const parsed = parseCron(skill.cron, TIMEZONE);
  if (!parsed) {
    log.error(`SkillSchedulerWorker: invalid cron expression for ${skill.name}`);
    return 0;
  }

  if (parsed.kind === "standard") {
    let count = 0;
    for (const scheduledAt of nextOccurrences(skill.cron!, TIMEZONE, now)) {
      const iso = isoSeconds(scheduledAt);
      const { conflict } = await enqueue(
        "skill_trigger",
        { skill_name: skill.name, scheduled_at: iso },
        { scheduledAt, uniqueKey: `skill_trigger:${skill.name}:${iso}` },
      );
      if (!conflict) count += 1;
    }
    return count;
  }

  const today = localToday();
  let count = 0;
  for (const date of [today, addDays(today, 1)]) {
    if (!parsed.dates.match(zonedToUtc(date, "00:00:00"))) continue;
    if (now >= zonedToUtc(date, parsed.end)) continue;
    if (skill.scope === "user") {
      if (!skill.requires_mcp) {
        log.error(`SkillSchedulerWorker: ${skill.name} has scope: user but no requires_mcp`);
        continue;
      }
      for (const connection of await listConnectionsForProvider(skill.requires_mcp)) {
        count += await scheduleRandomOnce(skill, date, parsed.start, parsed.end, connection.userId);
      }
    } else {
      count += await scheduleRandomOnce(skill, date, parsed.start, parsed.end, null);
    }
  }
  return count;
}

export async function scheduleCronSkills(now = new Date()): Promise<number> {
  const log = logger("SkillSchedulerWorker");
  log.info("SkillSchedulerWorker: scheduling cron-skill triggers");
  let count = 0;
  for (const skill of listCronRoutines()) count += await scheduleSkill(skill, now);
  log.info(`SkillSchedulerWorker: scheduled ${count} new trigger job(s)`);
  return count;
}

async function scheduleFirmowid(
  kind: "firmowid_session_check" | "firmowid_morning_session_check",
  name: string,
  field: "start_datetime" | "end_datetime",
  agg: "min" | "max",
  targetDate: (today: string) => string,
  metaKey: "avg_end_time" | "avg_start_time",
): Promise<number> {
  const log = logger(name);
  const provider = builtinProviders().find((candidate) => candidate.id === FIRMOWID);
  if (!provider) {
    log.error(`${name}: missing '${FIRMOWID}' provider`);
    return 0;
  }
  const today = localToday();
  const date = targetDate(today);
  let count = 0;

  for (const connection of await listConnectionsForProvider(FIRMOWID)) {
    const token = await ensureValidToken(connection);
    if (!token.ok) {
      log.debug(`${name}: skipping ${connection.userId}: ${token.error}`);
      continue;
    }
    const sessions = await fetchRecentSessions(provider.mcpUrl, token.value, SESSION_SAMPLE_SIZE);
    if (!sessions.ok) {
      log.debug(`${name}: skipping ${connection.userId}: ${sessions.error}`);
      continue;
    }
    const avgTime = averageTimeOfDay(sessions.value, today, field, agg);
    if (!avgTime) continue;

    const scheduledAt = new Date(zonedToUtc(date, avgTime).getTime() + FIRMOWID_OFFSET_MINUTES * 60_000);
    if (scheduledAt <= new Date()) continue;

    const user = await getUser(connection.userId);
    const { conflict } = await enqueue(
      kind,
      { user_id: connection.userId, date },
      {
        scheduledAt,
        uniqueKey: `${kind}:${connection.userId}:${date}`,
        meta: {
          user_id: connection.userId,
          user_name: user?.name ?? null,
          user_email: user?.email ?? null,
          [metaKey]: avgTime,
          scheduled_for_local: localIsoWithOffset(scheduledAt),
        },
      },
    );
    if (!conflict) count += 1;
  }
  log.info(`${name}: scheduled ${count} check(s)`);
  return count;
}

export function scheduleFirmowidEvening(): Promise<number> {
  return scheduleFirmowid(
    "firmowid_session_check",
    "FirmowidReminderSchedulerWorker",
    "end_datetime",
    "max",
    (today) => today,
    "avg_end_time",
  );
}

export function scheduleFirmowidMorning(): Promise<number> {
  return scheduleFirmowid(
    "firmowid_morning_session_check",
    "FirmowidMorningReminderSchedulerWorker",
    "start_datetime",
    "min",
    (today) => addDays(today, 1),
    "avg_start_time",
  );
}
