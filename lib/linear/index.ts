import { and, asc, eq, isNotNull, or } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { ProjectLinearConnection } from "../db/schema.ts";
import { decrypt } from "../vault.ts";
import { type LResult, listTeams, type Team } from "./client.ts";
import { installationToken } from "./installation.ts";

const { linearInstallations, projectLinearConnections, projects } = tables;

export type LinearMode = "app" | "key";
export type LinearConnection = Omit<ProjectLinearConnection, "apiKey"> & { mode: LinearMode; encryptedApiKey: Buffer | null };

function decode(row: ProjectLinearConnection): LinearConnection {
  const { apiKey, ...rest } = row;
  return { ...rest, mode: row.installationId ? "app" : "key", encryptedApiKey: apiKey };
}

const hasCredentials = or(isNotNull(projectLinearConnections.installationId), isNotNull(projectLinearConnections.apiKey));

export async function getConnection(projectId: string | null | undefined): Promise<LinearConnection | null> {
  if (!projectId) return null;
  const [row] = await db
    .select()
    .from(projectLinearConnections)
    .where(and(eq(projectLinearConnections.projectId, projectId), eq(projectLinearConnections.status, "connected"), hasCredentials))
    .limit(1);
  return row ? decode(row) : null;
}

export async function authorization(connection: LinearConnection): Promise<LResult<string>> {
  if (connection.installationId) {
    const token = await installationToken(connection.installationId);
    return token.ok ? { ok: true, value: `Bearer ${token.value}` } : token;
  }
  if (connection.encryptedApiKey) return { ok: true, value: decrypt(connection.encryptedApiKey) };
  return { ok: false, error: "not_connected" };
}

export async function listConnections() {
  const rows = await db
    .select({ connection: projectLinearConnections, project: projects, installation: linearInstallations })
    .from(projectLinearConnections)
    .leftJoin(projects, eq(projects.id, projectLinearConnections.projectId))
    .leftJoin(linearInstallations, eq(linearInstallations.id, projectLinearConnections.installationId))
    .orderBy(asc(projectLinearConnections.insertedAt));
  return rows.map((row) => ({
    ...decode(row.connection),
    project: row.project,
    organizationName: row.installation?.organizationName ?? null,
  }));
}

export async function installedTeams(installationId: string): Promise<LResult<Team[]>> {
  const token = await installationToken(installationId);
  if (!token.ok) return token;
  return listTeams(`Bearer ${token.value}`);
}

export async function connect(
  projectId: string,
  userId: string | null,
  installationId: string,
  teamId: string,
): Promise<LResult<LinearConnection>> {
  const teams = await installedTeams(installationId);
  if (!teams.ok) return teams;
  const team = teams.value.find((candidate) => candidate.id === teamId);
  if (!team) return { ok: false, error: "unknown_team" };
  const values = {
    projectId,
    installationId,
    apiKey: null,
    status: "connected",
    linearTeamId: team.id,
    linearTeamName: team.name,
    connectedByUserId: userId,
    disconnectedAt: null,
  };
  try {
    const [row] = await db
      .insert(projectLinearConnections)
      .values(values)
      .onConflictDoUpdate({ target: projectLinearConnections.projectId, set: values })
      .returning();
    return { ok: true, value: decode(row) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export async function disconnect(projectId: string): Promise<void> {
  await db
    .update(projectLinearConnections)
    .set({ status: "disconnected", disconnectedAt: new Date(Math.floor(Date.now() / 1000) * 1000) })
    .where(eq(projectLinearConnections.projectId, projectId));
}
