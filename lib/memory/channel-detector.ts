import { eq } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import { logger } from "../log.ts";
import { getChannelInfo } from "../slack/api.ts";
import { shared } from "../slack/state.ts";
import { getActiveMapping, mappingWriteAccess } from "./access.ts";
import { suggestProject } from "./action-decider.ts";
import { listProjects } from "./projects.ts";

const { channelMappings, projects } = tables;
const log = logger("ChannelDetector");

export type ChannelKind = "priv_channel" | "project_external" | "project_internal" | "company_channel";

export function detect(
  channelId: string,
  channelName: string | null | undefined,
): { kind: ChannelKind; clientId: string | null } | null {
  if (channelId.startsWith("D")) return { kind: "priv_channel", clientId: null };
  if (!channelName) return null;
  const external = /^av-x-(.+)$/.exec(channelName);
  if (external) return { kind: "project_external", clientId: external[1] };
  const internal = /^prywatnie-o-(.+)$/.exec(channelName);
  if (internal) return { kind: "project_internal", clientId: internal[1] };
  return null;
}

async function findProject(slug: string) {
  const [project] = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  return project ?? null;
}

async function upsertMapping(
  channelId: string,
  attrs: { slackChannelName: string | null; projectId: string; clientId: string | null },
) {
  const values = { ...attrs, source: "auto_detected", status: "active" };
  const [existing] = await db
    .select({ id: channelMappings.id })
    .from(channelMappings)
    .where(eq(channelMappings.slackChannelId, channelId))
    .limit(1);
  if (existing) {
    await db.update(channelMappings).set(values).where(eq(channelMappings.id, existing.id));
  } else {
    await db.insert(channelMappings).values({ slackChannelId: channelId, ...values });
  }
}

async function createPendingMapping(channelId: string, channelName: string | null, slug: string, clientId: string | null) {
  await db
    .insert(channelMappings)
    .values({ slackChannelId: channelId, slackChannelName: channelName, source: "auto_detected", status: "pending", clientId })
    .onConflictDoNothing({ target: channelMappings.slackChannelId });
  log.info(`ChannelDetector: pending mapping for ${channelId} (${channelName}) — missing project ${slug}`);
}

export async function ensureMapping(channelId: string, channelName: string | null): Promise<string[]> {
  const mapping = await getActiveMapping(channelId);
  if (mapping) return mappingWriteAccess(mapping);

  const detected = detect(channelId, channelName);
  if (detected?.kind === "project_external" || detected?.kind === "project_internal") {
    const slug = detected.clientId!;
    const external = detected.kind === "project_external";
    const project = await findProject(slug);
    if (!project) {
      await createPendingMapping(channelId, channelName, slug, external ? slug : null);
      return ["internal"];
    }
    await upsertMapping(channelId, {
      slackChannelName: channelName,
      projectId: project.id,
      clientId: external ? slug : null,
    });
    log.info(
      external
        ? `ChannelDetector: auto-mapped ${channelId} (${channelName}) → external/${slug}`
        : `ChannelDetector: auto-mapped ${channelId} (${channelName}) → internal for ${slug}`,
    );
    return external ? ["internal", `external/${slug}`] : ["internal"];
  }

  if (detected?.kind !== "priv_channel") {
    log.info(`ChannelDetector: ${channelId} (${channelName ?? "unknown"}) has no mapping, defaulting to internal`);
    await proposeProjectMapping(channelId, channelName);
  }
  return ["internal"];
}

const suggestionsChecked = shared("channelProjectSuggestions", () => new Set<string>());

async function proposeProjectMapping(channelId: string, channelName: string | null) {
  if (suggestionsChecked.has(channelId)) return;
  suggestionsChecked.add(channelId);
  const [existing] = await db
    .select({ id: channelMappings.id })
    .from(channelMappings)
    .where(eq(channelMappings.slackChannelId, channelId))
    .limit(1);
  if (existing) return;

  const info = await getChannelInfo(channelId);
  const known = await listProjects();
  const slug = await suggestProject(
    {
      name: channelName ?? info?.name ?? channelId,
      purpose: info?.purpose?.value ?? "",
      topic: info?.topic?.value ?? "",
    },
    known.map((project) => ({ slug: project.slug, name: project.name })),
  );
  const project = slug ? known.find((candidate) => candidate.slug === slug) : null;
  if (!project) return;

  await db
    .insert(channelMappings)
    .values({ slackChannelId: channelId, slackChannelName: channelName, projectId: project.id, source: "jev_suggested", status: "pending" })
    .onConflictDoNothing({ target: channelMappings.slackChannelId });
  log.info(`ChannelDetector: suggested project ${project.slug} for ${channelId} (${channelName}), waiting for an admin to activate it`);
}
