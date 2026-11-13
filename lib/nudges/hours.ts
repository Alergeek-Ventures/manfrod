import { and, eq, isNull } from "drizzle-orm";
import { config } from "../config.ts";
import { db, tables } from "../db/index.ts";
import type { User } from "../db/schema.ts";
import { extractRecords, fetchRecentSessions } from "../firmowid.ts";
import { userRepositories } from "../github/access.ts";
import { getAccount, userToken } from "../github/accounts.ts";
import { listRepositoryLinks } from "../github/projects.ts";
import { listCommits, listRepositories, type StoredCommit } from "../github/store.ts";
import { listPublicHolidays, type CalendarEvent } from "../google.ts";
import { listOfficeAccessLog, type AccessEntry } from "../kalafiornia.ts";
import { teamActivity } from "../linear/calls.ts";
import { logger } from "../log.ts";
import { callTool } from "../mcp/client.ts";
import { addDays, dateIsoInZone, formatLocal, localToday, weekdayName, zonedToUtc } from "../time.ts";
import { run } from "./compose.ts";
import { firmowidAccess, isAbsent, meetings, nudgeablePeople, SlackWorkspace, type SlackThread } from "./signals.ts";
import { handled, isEnabled, recordDelivery } from "./store.ts";

const SESSION_SAMPLE = 80;
const PATTERN_DAYS = 28;
const SLACK_LOOKBACK_HOURS = 48;

const { channelMappings, projectMemberships, projects } = tables;
const log = logger("Nudges.Hours");

const GUIDANCE = `It is the evening of a workday. Check whether this person's Firmowid sessions for today cover the work they apparently did. If they have no session today, ask whether to add today's hours: propose concrete entries (Firmowid project, start–end, short title) built from the signals below, or simply ask what they worked on if there are no signals. If they have sessions but the signals clearly show work that is missing (meetings, commits or a stretch of activity for another project, or hours outside any session), propose adding just that. Use the Firmowid project names given. Keep it to a short question with the proposed entries, not a report of the signals. If today's sessions already cover the day, or the pattern shows they don't work on this weekday, do not send.`;

const FOLLOW_UP = `Gdy odpowie: najpierw ustal dokładnie, co wpisać (projekt, godziny, tytuł), jeśli czegoś brakuje. Potem dodaj wszystkie wpisy jednym wywołaniem firmowid__add_sessions: project_id z firmowid__list_projects, tytuł, is_remote (null, jeśli nie wiadomo) oraz start_datetime i end_datetime z offsetem strefy Europe/Warsaw (np. 2026-11-04T09:00:00+01:00). Wpisy nie mogą nachodzić na siebie ani na inne sesje z tego dnia; trwającej sesji nie ruszaj. Jeśli Firmowid odrzuci wpis (błąd wskazuje sessions.<index>), popraw go albo dopytaj. Na koniec potwierdź krótko, co wpisałeś. Jeśli napisze, że nie pracował albo że nic nie trzeba, przyjmij to i nie wracaj do tego.`;

export interface DaySession {
  start: Date;
  end: Date | null;
  title: string;
  project: string | null;
}

export function sessionsOn(records: Record<string, any>[], date: string): DaySession[] {
  return records
    .filter((record) => typeof record.start_datetime === "string" && dateIsoInZone(new Date(record.start_datetime)) === date)
    .map((record) => ({
      start: new Date(record.start_datetime),
      end: typeof record.end_datetime === "string" ? new Date(record.end_datetime) : null,
      title: typeof record.title === "string" ? record.title : "",
      project: typeof record.project?.name === "string" ? record.project.name : null,
    }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

export function weekdayPattern(records: Record<string, any>[], today: string): string {
  const since = addDays(today, -PATTERN_DAYS);
  const days = new Set(
    records
      .filter((record) => typeof record.start_datetime === "string")
      .map((record) => dateIsoInZone(new Date(record.start_datetime)))
      .filter((date) => date >= since && date < today),
  );
  const counts = new Map<string, number>();
  for (const date of days) counts.set(weekdayName(date), (counts.get(weekdayName(date)) ?? 0) + 1);
  return [...counts.entries()].map(([weekday, count]) => `${weekday} ×${count}`).join(", ");
}

export interface ChannelActivity {
  channelId: string;
  channelName: string;
  count: number;
  first: Date;
  last: Date;
}

export function slackActivity(slackUserId: string, threads: SlackThread[], since: Date): ChannelActivity[] {
  const byChannel = new Map<string, ChannelActivity>();
  for (const thread of threads) {
    for (const message of thread.messages) {
      if (message.user !== slackUserId || message.subtype) continue;
      const at = new Date(Number(message.ts) * 1000);
      if (at < since) continue;
      const entry = byChannel.get(thread.channelId);
      if (!entry) {
        byChannel.set(thread.channelId, { channelId: thread.channelId, channelName: thread.channelName, count: 1, first: at, last: at });
        continue;
      }
      entry.count += 1;
      if (at < entry.first) entry.first = at;
      if (at > entry.last) entry.last = at;
    }
  }
  return [...byChannel.values()].sort((a, b) => b.count - a.count);
}

const time = (date: Date) => formatLocal(date).slice(11);

const span = (start: Date, end: Date | null) => `${time(start)}–${end ? time(end) : "now"}`;

const sameName = (a: string | null | undefined, b: string | null | undefined) => {
  const left = a?.trim().toLowerCase();
  const right = b?.trim().toLowerCase();
  return !!left && !!right && (left === right || left.includes(right) || right.includes(left));
};

async function channelProjects(): Promise<Map<string, string>> {
  const rows = await db
    .select({ channelId: channelMappings.slackChannelId, project: projects.name })
    .from(channelMappings)
    .innerJoin(projects, eq(projects.id, channelMappings.projectId))
    .where(eq(channelMappings.status, "active"));
  return new Map(rows.map((row) => [row.channelId, row.project]));
}

async function firmowidProjects(mcpUrl: string, token: string): Promise<string[]> {
  const result = await callTool(mcpUrl, token, "list_projects", { input: { status: "active" }, limit: 100 });
  if (!result.ok) return [];
  return extractRecords(result.value).flatMap((project) => (typeof project.name === "string" ? [project.name] : []));
}

class LinearDay {
  private activity = new Map<string, ReturnType<typeof teamActivity>>();

  constructor(private readonly since: Date) {}

  async issuesFor(person: User): Promise<string[]> {
    const memberships = await db
      .select({ projectId: projects.id, project: projects.name })
      .from(projectMemberships)
      .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
      .where(and(eq(projectMemberships.userId, person.id), isNull(projectMemberships.removedAt)));
    const lines: string[] = [];
    for (const { projectId, project } of memberships) {
      if (!this.activity.has(projectId)) this.activity.set(projectId, teamActivity(projectId, this.since));
      const activity = await this.activity.get(projectId)!;
      for (const issue of activity?.issues ?? []) {
        if (sameName(issue.assignee?.name, person.name)) {
          lines.push(`- ${issue.identifier} [${issue.state?.name ?? "?"}] ${issue.title} (project ${project})`);
        }
      }
    }
    return lines;
  }
}

function describeMeetings(events: CalendarEvent[]): string {
  return events
    .filter((event) => event.start && event.end)
    .map((event) => `- ${span(new Date(event.start!), new Date(event.end!))} ${event.summary} (${event.attendees.length} attendee(s))`)
    .join("\n");
}

const COMMIT_MESSAGES_PER_REPOSITORY = 8;

export function describeCommits(commits: StoredCommit[], projectByRepository: Map<string, string>): string {
  const byRepository = new Map<string, StoredCommit[]>();
  for (const commit of commits) byRepository.set(commit.repository, [...(byRepository.get(commit.repository) ?? []), commit]);
  return [...byRepository.entries()]
    .map(([repository, list]) => {
      const sorted = [...list].sort((a, b) => a.authoredAt.getTime() - b.authoredAt.getTime());
      const branches = [...new Set(sorted.flatMap((commit) => commit.branches))].join(", ");
      const project = projectByRepository.get(repository);
      const messages = sorted
        .slice(-COMMIT_MESSAGES_PER_REPOSITORY)
        .map((commit) => `  - ${time(commit.authoredAt)} ${commit.message.split("\n")[0].slice(0, 120)}`);
      return [
        `- ${repository}${project ? ` (project ${project})` : ""}: ${sorted.length} commit(s), ${span(sorted[0].authoredAt, sorted.at(-1)!.authoredAt)}${branches ? ` on ${branches}` : ""}`,
        ...messages,
      ].join("\n");
    })
    .join("\n");
}

async function repositoryProjects(): Promise<Map<string, string>> {
  const [links, repositories, projectRows] = await Promise.all([listRepositoryLinks(), listRepositories(), db.select().from(projects)]);
  const names = new Map(projectRows.map((project) => [project.id, project.name]));
  const repositoryNames = new Map(repositories.map((repository) => [repository.id, repository.fullName]));
  const result = new Map<string, string>();
  for (const link of links) {
    const repository = repositoryNames.get(link.repositoryId);
    const project = names.get(link.projectId);
    if (repository && project) result.set(repository, result.has(repository) ? `${result.get(repository)}, ${project}` : project);
  }
  return result;
}

async function commitsBetween(person: User, since: Date, until: Date): Promise<StoredCommit[]> {
  const account = await getAccount(person.id);
  if (!account || account.status !== "connected") return [];
  const token = await userToken(person.id);
  if (!token.ok) return [];
  const readable = await userRepositories(person.id, token.value).catch(() => []);
  return listCommits({ since, until, author: account, repositoryIds: readable.map((repository) => repository.id) });
}

function firstEntry(person: User, office: AccessEntry[]): Date | null {
  const name = person.name?.toLowerCase();
  if (!name) return null;
  const entries = office.filter((entry) => (entry.user_name ?? "").toLowerCase().includes(name));
  return entries.length > 0 ? new Date(Math.min(...entries.map((entry) => entry.time.getTime()))) : null;
}

async function isPublicHoliday(today: string): Promise<boolean> {
  const holidays = await listPublicHolidays(config.holidayCalendarId, zonedToUtc(today, "00:00"), zonedToUtc(addDays(today, 1), "00:00"));
  return holidays.ok && holidays.value.some((holiday) => holiday.date === today);
}

export async function runEveningHours(today = localToday()): Promise<number> {
  if (await isPublicHoliday(today)) return 0;
  const dayStart = zonedToUtc(today, "00:00");
  const workspace = new SlackWorkspace(String(Math.floor((Date.now() - SLACK_LOOKBACK_HOURS * 3_600_000) / 1000)));
  const linear = new LinearDay(dayStart);
  const office = await listOfficeAccessLog({ since: dayStart });
  const officeEntries = office.ok ? office.value : [];
  const channels = await channelProjects();
  const repositories = await repositoryProjects();
  let sent = 0;
  for (const person of await nudgeablePeople()) {
    try {
      if (!(await isEnabled(person.id, "hours")) || (await handled(person.id, "hours", today))) continue;
      const access = await firmowidAccess(person.id);
      if (!access) continue;
      if (await isAbsent(person.id, today)) {
        await recordDelivery(person.id, "hours", today, false, "Absent today.");
        continue;
      }
      const records = await fetchRecentSessions(access.mcpUrl, access.token, SESSION_SAMPLE);
      if (!records.ok) continue;
      const sessions = sessionsOn(records.value, today);
      if (sessions.some((session) => session.end === null)) {
        await recordDelivery(person.id, "hours", today, false, "A session is still running.");
        continue;
      }

      const entered = firstEntry(person, officeEntries);
      const calendar = (await meetings(person.id, today, addDays(today, 1))) ?? [];
      const slack = slackActivity(person.slackId, await workspace.all(), dayStart);
      const issues = await linear.issuesFor(person);
      const commits = await commitsBetween(person, dayStart, zonedToUtc(addDays(today, 1), "00:00"));
      const projectNames = await firmowidProjects(access.mcpUrl, access.token);
      const pattern = weekdayPattern(records.value, today);
      const context = [
        `Today is ${weekdayName(today)} ${today}.`,
        sessions.length > 0
          ? `Firmowid sessions today:\n${sessions.map((session) => `- ${span(session.start, session.end)} ${session.project ?? "(no project)"}: ${session.title}`).join("\n")}`
          : "Firmowid sessions today: none",
        projectNames.length > 0 ? `Their active Firmowid projects: ${projectNames.join(", ")}` : "",
        pattern ? `Days with sessions in the last ${PATTERN_DAYS} days, by weekday: ${pattern}` : "",
        entered ? `Entered the office today at ${time(entered)}` : "",
        calendar.length > 0 ? `Meetings today:\n${describeMeetings(calendar)}` : "",
        slack.length > 0
          ? `Their Slack messages today:\n${slack
              .map(
                (channel) =>
                  `- #${channel.channelName}${channels.has(channel.channelId) ? ` (project ${channels.get(channel.channelId)})` : ""}: ${channel.count} message(s), ${span(channel.first, channel.last)}`,
              )
              .join("\n")}`
          : "",
        issues.length > 0 ? `Linear issues assigned to them and updated today:\n${issues.join("\n")}` : "",
        commits.length > 0 ? `Their GitHub commits today (author time, all branches):\n${describeCommits(commits, repositories)}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      if (await run({ kind: "hours", period: today, person, guidance: GUIDANCE, context, followUp: FOLLOW_UP })) sent += 1;
    } catch (error) {
      log.error(`Nudges.Hours: failed for ${person.id}: ${(error as Error).message}`);
    }
  }
  if (sent > 0) log.info(`Nudges.Hours: sent ${sent} evening hours check(s)`);
  return sent;
}
