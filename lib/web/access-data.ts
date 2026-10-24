import { sql } from "drizzle-orm";
import { listUsers } from "../accounts.ts";
import { db } from "../db/index.ts";
import { listPendingJobs } from "../jobs/index.ts";
import { tables } from "../db/index.ts";
import { listConnections } from "../linear/index.ts";
import { listAllRecurringReminders } from "../memory/reminders.ts";
import { listCronSkills } from "../skills.ts";

const rows = async <T = Record<string, any>>(query: ReturnType<typeof sql>) => (await db.execute(query)).rows as T[];
const stamp = (value: unknown) => (value instanceof Date ? value.toISOString() : value ? String(value) : null);

export async function loadAccessData() {
  const projects = await rows(sql`
    SELECT p.id, p.slug, p.name, count(DISTINCT cm.id)::int channel_count, count(DISTINCT pm.id)::int member_count
    FROM projects p LEFT JOIN channel_mappings cm ON cm.project_id = p.id LEFT JOIN project_memberships pm ON pm.project_id = p.id
    GROUP BY p.id ORDER BY p.slug`);

  const channels = await rows(sql`
    SELECT cm.id, cm.slack_channel_id, cm.slack_channel_name, cm.client_id, cm.status, cm.source, p.slug project_slug
    FROM channel_mappings cm LEFT JOIN projects p ON p.id = cm.project_id ORDER BY cm.inserted_at DESC`);

  const memberRows = await rows(sql`
    SELECT u.name user_name, u.slack_id user_slack_id, p.name project_name, p.slug project_slug, pm.source
    FROM project_memberships pm JOIN users u ON u.id = pm.user_id JOIN projects p ON p.id = pm.project_id
    ORDER BY u.name, p.slug`);
  const membersBySlack = new Map<string, { user_slack_id: string; user_name: string | null; memberships: { project_name: string; project_slug: string }[] }>();
  for (const row of memberRows) {
    const entry = membersBySlack.get(row.user_slack_id) ?? {
      user_slack_id: row.user_slack_id as string,
      user_name: row.user_name as string | null,
      memberships: [] as { project_name: string; project_slug: string }[],
    };
    entry.memberships.push({ project_name: row.project_name, project_slug: row.project_slug });
    membersBySlack.set(row.user_slack_id, entry);
  }
  const members = [...membersBySlack.values()].sort((a, b) => (a.user_name ?? "").localeCompare(b.user_name ?? ""));

  const users = await listUsers();

  const vacations = (
    await rows<{ id: string; key: string; value: string; access: string[]; user_name: string | null; user_slack_id: string | null; inserted_at: unknown; updated_at: unknown }>(sql`
      SELECT f.id, f.key, f.value, f.access, u.name user_name, u.slack_id user_slack_id, f.inserted_at, f.updated_at
      FROM facts f LEFT JOIN users u ON u.id = f.set_by_user_id WHERE f.key LIKE 'absence:%' ORDER BY f.inserted_at DESC`)
  ).map((row) => ({ ...row, inserted_at: stamp(row.inserted_at), updated_at: stamp(row.updated_at) }));

  const cronRows = [
    ...listCronSkills().map((skill) => ({
      type: "skill" as const,
      id: null as string | null,
      name: skill.name,
      cron: skill.cron ?? "",
      timezone: "Europe/Warsaw",
      enabled: true,
      owner_name: "Skill" as string | null,
      owner_slack_id: null as string | null,
      detail: skill.description,
      channel: skill.channel,
    })),
    ...(await listAllRecurringReminders()).map((reminder) => ({
      type: "user" as const,
      id: reminder.id as string | null,
      name: reminder.name,
      cron: reminder.cron,
      timezone: reminder.timezone,
      enabled: reminder.enabled,
      owner_name: reminder.user?.name ?? null,
      owner_slack_id: reminder.user?.slackId ?? null,
      detail: reminder.instructions,
      channel: null as string | null,
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const usersById = new Map(users.map((user) => [user.id, user]));
  const reminderRows = (await listPendingJobs("trigger", sql`${tables.jobs.args}->>'trigger_id' LIKE 'reminder_%'`)).map((job) => {
    const args = job.args as Record<string, string>;
    const owner = usersById.get(args.user_id);
    return {
      id: job.id,
      message: args.message ?? args.prompt,
      scheduled_at: job.scheduledAt.toISOString(),
      state: job.state,
      owner_name: owner?.name ?? null,
      owner_slack_id: owner?.slackId ?? null,
    };
  });

  const linearConnections = (await listConnections()).map((connection) => ({
    id: connection.id,
    project_slug: connection.project?.slug ?? null,
    project_name: connection.project?.name ?? null,
    status: connection.status,
    linear_team_name: connection.linearTeamName,
    inserted_at: connection.insertedAt.toISOString(),
  }));

  const secrets = (
    await rows<{ name: string; description: string | null; updated_by: string | null; updated_at: unknown }>(sql`
      SELECT s.name, s.description, u.name updated_by, s.updated_at
      FROM agent_secrets s LEFT JOIN users u ON u.id = s.updated_by_user_id
      ORDER BY s.name
    `)
  ).map((row) => ({ ...row, updated_at: stamp(row.updated_at) }));

  return {
    projects,
    channels,
    members,
    users: users.map((user) => ({ id: user.id, label: user.name || user.email || user.slackId })),
    vacations,
    cronRows,
    reminderRows,
    linearConnections,
    secrets,
  };
}

export type AccessData = Awaited<ReturnType<typeof loadAccessData>>;
