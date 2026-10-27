import { and, asc, countDistinct, desc, eq, isNull, like, sql } from "drizzle-orm";
import { isAdmin, isSystemUser, listUsers } from "../accounts.ts";
import { LANGUAGES, languageSettings } from "../agent-settings.ts";
import { db, tables } from "../db/index.ts";
import { listPendingJobs } from "../jobs/index.ts";
import { listConnections } from "../linear/index.ts";
import { listInstallations } from "../linear/installation.ts";
import { listAllRecurringReminders } from "../memory/reminders.ts";
import { listCronRoutines } from "../routines.ts";

const { agentSecrets, channelMappings, facts, projectMemberships, projects: projectsTable, users: usersTable } = tables;
const stamp = (value: unknown) => (value instanceof Date ? value.toISOString() : value ? String(value) : null);

export async function loadAccessData() {
  const projects = await db
    .select({
      id: projectsTable.id,
      slug: projectsTable.slug,
      name: projectsTable.name,
      channel_count: countDistinct(channelMappings.id),
      member_count: countDistinct(projectMemberships.id),
    })
    .from(projectsTable)
    .leftJoin(channelMappings, eq(channelMappings.projectId, projectsTable.id))
    .leftJoin(projectMemberships, and(eq(projectMemberships.projectId, projectsTable.id), isNull(projectMemberships.removedAt)))
    .groupBy(projectsTable.id)
    .orderBy(asc(projectsTable.slug));

  const channels = await db
    .select({
      id: channelMappings.id,
      slack_channel_id: channelMappings.slackChannelId,
      slack_channel_name: channelMappings.slackChannelName,
      client_id: channelMappings.clientId,
      status: channelMappings.status,
      source: channelMappings.source,
      project_slug: projectsTable.slug,
    })
    .from(channelMappings)
    .leftJoin(projectsTable, eq(projectsTable.id, channelMappings.projectId))
    .orderBy(desc(channelMappings.insertedAt));

  const users = await listUsers();

  const memberRows = await db
    .select({
      user_id: projectMemberships.userId,
      project_id: projectsTable.id,
      project_name: projectsTable.name,
      project_slug: projectsTable.slug,
      source: projectMemberships.source,
    })
    .from(projectMemberships)
    .innerJoin(projectsTable, eq(projectsTable.id, projectMemberships.projectId))
    .where(isNull(projectMemberships.removedAt))
    .orderBy(asc(projectsTable.slug));
  const members = users
    .filter((user) => !isSystemUser(user))
    .map((user) => ({
      user_id: user.id,
      user_name: user.name,
      user_slack_id: user.slackId,
      is_admin: isAdmin(user),
      memberships: memberRows
        .filter((row) => row.user_id === user.id)
        .map(({ project_id, project_name, project_slug, source }) => ({ project_id, project_name, project_slug, source })),
    }))
    .sort((a, b) => (a.user_name ?? "").localeCompare(b.user_name ?? ""));

  const vacations = (
    await db
      .select({
        id: facts.id,
        key: facts.key,
        value: facts.value,
        access: facts.access,
        user_name: usersTable.name,
        user_slack_id: usersTable.slackId,
        inserted_at: facts.insertedAt,
        updated_at: facts.updatedAt,
      })
      .from(facts)
      .leftJoin(usersTable, eq(usersTable.id, facts.setByUserId))
      .where(like(facts.key, "absence:%"))
      .orderBy(desc(facts.insertedAt))
  ).map((row) => ({ ...row, inserted_at: stamp(row.inserted_at), updated_at: stamp(row.updated_at) }));

  const cronRows = [
    ...listCronRoutines().map((skill) => ({
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
    auth: connection.installationId ? "app" : connection.encryptedApiKey ? "key" : "none",
    installation_id: connection.installationId,
    workspace: connection.organizationName,
    inserted_at: connection.insertedAt.toISOString(),
  }));

  const linearInstallations = (await listInstallations()).map((installation) => {
    const installer = installation.installedByUserId ? usersById.get(installation.installedByUserId) : null;
    return {
      id: installation.id,
      organization_name: installation.organizationName,
      status: installation.status,
      installed_by: installer?.name ?? installer?.email ?? null,
      projects: linearConnections.filter((connection) => connection.installation_id === installation.id).length,
      updated_at: installation.updatedAt.toISOString(),
    };
  });

  const secrets = (
    await db
      .select({
        name: agentSecrets.name,
        description: agentSecrets.description,
        updated_by: usersTable.name,
        updated_at: agentSecrets.updatedAt,
      })
      .from(agentSecrets)
      .leftJoin(usersTable, eq(usersTable.id, agentSecrets.updatedByUserId))
      .orderBy(asc(agentSecrets.name))
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
    linearInstallations,
    secrets,
    languages: await languageSettings(),
    languageOptions: Object.entries(LANGUAGES).map(([value, label]) => ({ value, label })),
  };
}

export type AccessData = Awaited<ReturnType<typeof loadAccessData>>;
