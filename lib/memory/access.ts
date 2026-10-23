import { and, eq, isNotNull, sql, type SQL, type AnyColumn } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { ChannelMapping, Project } from "../db/schema.ts";

const { channelMappings, projectMemberships, projects } = tables;

export type MappingWithProject = ChannelMapping & { project: Project | null };

export function privateLevel(userId: string): string {
  return `private/${userId}`;
}

export function isPrivate(levels: string | readonly string[]): boolean {
  if (typeof levels === "string") return levels.startsWith("private/");
  return levels.some((level) => level.startsWith("private/"));
}

export function mappingWriteAccess(mapping: Pick<ChannelMapping, "clientId">): string[] {
  return mapping.clientId ? ["internal", `external/${mapping.clientId}`] : ["internal"];
}

export function levelsArray(levels: readonly string[]): SQL {
  if (levels.length === 0) return sql`ARRAY[]::varchar[]`;
  return sql`ARRAY[${sql.join(
    levels.map((level) => sql`${level}`),
    sql`, `,
  )}]::varchar[]`;
}

export function accessOverlaps(column: AnyColumn, readableLevels: readonly string[]): SQL {
  return sql`${column} && ${levelsArray(readableLevels)}`;
}

export function accessEquals(column: AnyColumn, access: readonly string[]): SQL {
  return sql`${column} = ${levelsArray(access)}`;
}

export async function getActiveMapping(channelId: string | null | undefined): Promise<MappingWithProject | null> {
  if (!channelId) return null;
  const rows = await db
    .select({ mapping: channelMappings, project: projects })
    .from(channelMappings)
    .leftJoin(projects, eq(projects.id, channelMappings.projectId))
    .where(and(eq(channelMappings.slackChannelId, channelId), eq(channelMappings.status, "active")))
    .limit(1);
  const row = rows[0];
  return row ? { ...row.mapping, project: row.project } : null;
}

export async function resolveForWrite(
  slackChannelId: string,
  authorUserId: string | null = null,
): Promise<string[]> {
  if (slackChannelId.startsWith("D")) {
    return authorUserId ? [privateLevel(authorUserId)] : ["internal"];
  }
  const mapping = await getActiveMapping(slackChannelId);
  return mapping ? mappingWriteAccess(mapping) : ["internal"];
}

async function clientIdsForUser(userId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ clientId: channelMappings.clientId })
    .from(projectMemberships)
    .innerJoin(
      channelMappings,
      and(
        eq(channelMappings.projectId, projectMemberships.projectId),
        isNotNull(channelMappings.clientId),
        eq(channelMappings.status, "active"),
      ),
    )
    .where(eq(projectMemberships.userId, userId));
  return rows.map((row) => row.clientId!).filter(Boolean);
}

export async function clientIdForProject(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ clientId: channelMappings.clientId })
    .from(channelMappings)
    .where(
      and(
        eq(channelMappings.projectId, projectId),
        eq(channelMappings.status, "active"),
        isNotNull(channelMappings.clientId),
      ),
    )
    .limit(1);
  return row?.clientId ?? null;
}

export async function resolveForRead(userId: string, slackChannelId: string): Promise<string[]> {
  if (slackChannelId.startsWith("D")) {
    const external = (await clientIdsForUser(userId)).map((id) => `external/${id}`);
    return [privateLevel(userId), "internal", ...external, "external/all"];
  }

  const mapping = await getActiveMapping(slackChannelId);
  if (!mapping) return ["internal", "external/all"];

  if (mapping.clientId === null && mapping.projectId === null) {
    const external = (await clientIdsForUser(userId)).map((id) => `external/${id}`);
    return ["internal", ...external, "external/all"];
  }

  if (mapping.clientId === null && mapping.projectId !== null) {
    const clientId = await clientIdForProject(mapping.projectId);
    return ["internal", ...(clientId ? [`external/${clientId}`] : []), "external/all"];
  }

  return [`external/${mapping.clientId}`, "external/all"];
}

export async function ensureMembership(userId: string, projectId: string): Promise<void> {
  await db
    .insert(projectMemberships)
    .values({ userId, projectId, source: "auto_detected" })
    .onConflictDoNothing({ target: [projectMemberships.userId, projectMemberships.projectId] });
}

export async function isMember(userId: string, projectId: string): Promise<boolean> {
  const rows = await db
    .select({ id: projectMemberships.id })
    .from(projectMemberships)
    .where(and(eq(projectMemberships.userId, userId), eq(projectMemberships.projectId, projectId)))
    .limit(1);
  return rows.length > 0;
}

export async function projectIdForChannel(channelId: string | null | undefined): Promise<string | null> {
  return (await getActiveMapping(channelId))?.projectId ?? null;
}

export async function clientIdForChannel(channelId: string): Promise<string | null> {
  const mapping = await getActiveMapping(channelId);
  if (mapping?.clientId) return mapping.clientId;
  if (mapping?.projectId) return clientIdForProject(mapping.projectId);
  return null;
}

export interface ResolvedAccess {
  writeAccess: string[];
  readableLevels: string[];
}

export async function resolveAccess(userId: string, channelId: string | null): Promise<ResolvedAccess> {
  if (!channelId) return { writeAccess: ["internal"], readableLevels: ["internal", "external/all"] };

  const mapping = await getActiveMapping(channelId);
  if (mapping?.projectId) await ensureMembership(userId, mapping.projectId);

  return {
    writeAccess: await resolveForWrite(channelId, userId),
    readableLevels: await resolveForRead(userId, channelId),
  };
}
