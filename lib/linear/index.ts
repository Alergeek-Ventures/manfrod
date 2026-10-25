import { and, asc, eq } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { ProjectLinearConnection } from "../db/schema.ts";
import { decrypt, encrypt } from "../vault.ts";
import { verifyKey } from "./client.ts";

const { projectLinearConnections, projects } = tables;

export type LinearConnection = Omit<ProjectLinearConnection, "apiKey"> & { apiKey: string | null };

function decode(row: ProjectLinearConnection): LinearConnection {
  return { ...row, apiKey: row.apiKey ? decrypt(row.apiKey) : null };
}

export async function getConnection(projectId: string | null | undefined): Promise<LinearConnection | null> {
  if (!projectId) return null;
  const [row] = await db
    .select()
    .from(projectLinearConnections)
    .where(and(eq(projectLinearConnections.projectId, projectId), eq(projectLinearConnections.status, "connected")))
    .limit(1);
  return row ? decode(row) : null;
}

export async function listConnections() {
  const rows = await db
    .select({ connection: projectLinearConnections, project: projects })
    .from(projectLinearConnections)
    .leftJoin(projects, eq(projects.id, projectLinearConnections.projectId))
    .orderBy(asc(projectLinearConnections.insertedAt));
  return rows.map((row) => ({ ...decode(row.connection), project: row.project }));
}

export async function connect(
  projectId: string,
  userId: string | null,
  apiKey: string,
): Promise<{ ok: true; connection: LinearConnection } | { ok: false; error: "invalid_key" | "no_team_scoped" | string }> {
  const team = await verifyKey(apiKey);
  if (!team.ok) return { ok: false, error: team.error === "no_team_scoped" ? "no_team_scoped" : "invalid_key" };
  const values = {
    projectId,
    apiKey: encrypt(apiKey),
    status: "connected",
    linearTeamId: team.value.id,
    linearTeamName: team.value.name,
    connectedByUserId: userId,
    disconnectedAt: null,
  };
  try {
    const [row] = await db
      .insert(projectLinearConnections)
      .values(values)
      .onConflictDoUpdate({ target: projectLinearConnections.projectId, set: values })
      .returning();
    return { ok: true, connection: decode(row) };
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
