"use server";

import { eq } from "drizzle-orm";
import { db, tables } from "@/lib/db/index.ts";
import {
  deleteNodeAccessible,
  getGraphData,
  getNodeAccessible,
  getNodeLinksAccessible,
  graphStats,
  updateNodeAccessible,
} from "@/lib/memory/nodes.ts";
import { search } from "@/lib/memory/search.ts";
import { embedQuery } from "@/lib/voyage.ts";
import { requireAdmin } from "@/lib/web/session.ts";

export type Filter = "all" | "processed" | "slipbox";

export interface SelectedNode {
  id: string;
  content: string;
  processed: boolean;
  linkCount: number;
  insertedAt: string;
  projectId: string | null;
  links: { id: string; preview: string }[];
}

async function selected(levels: string[], nodeId: string): Promise<SelectedNode | null> {
  const node = await getNodeAccessible(levels, nodeId);
  if (!node) return null;
  const links = await getNodeLinksAccessible(levels, node.id);
  return {
    id: node.id,
    content: node.content,
    processed: node.processedAt !== null,
    linkCount: links.length,
    insertedAt: node.insertedAt.toISOString(),
    projectId: node.projectId,
    links: links.map((link) => ({ id: link.id, preview: (link.content ?? "").slice(0, 50) })),
  };
}

export async function loadGraph(filter: Filter, accessLevel: string, projectId: string | null) {
  await requireAdmin();
  return { graph: await getGraphData({ filter, accessLevel, projectId }), stats: await graphStats() };
}

export async function selectNode(accessLevel: string, nodeId: string) {
  await requireAdmin();
  return selected([accessLevel], nodeId);
}

export async function searchNodes(accessLevel: string, query: string): Promise<string[]> {
  await requireAdmin();
  if (query.length < 3) return [];
  const found = await search(null, [accessLevel], query, { limit: 20, expandQuery: false });
  return found.map((node) => node.id);
}

export async function saveNode(accessLevel: string, nodeId: string, content: string) {
  await requireAdmin();
  const trimmed = content.trim();
  if (trimmed === "") return { error: "Content can't be empty" };
  try {
    const node = await updateNodeAccessible([accessLevel], nodeId, { content: trimmed, embedding: await embedQuery(trimmed) });
    if (!node) return { error: "Node not found or not accessible" };
    return { node: await selected([accessLevel], nodeId), info: "Node updated" };
  } catch (error) {
    return { error: `Save failed: ${(error as Error).message}` };
  }
}

export async function deleteNode(accessLevel: string, nodeId: string) {
  await requireAdmin();
  const result = await deleteNodeAccessible([accessLevel], nodeId);
  if (result.ok) return { info: "Node deleted" };
  return { error: result.error === "soul" ? "This node is a soul and can't be deleted" : "Node not found or not accessible" };
}

export async function setNodeProject(accessLevel: string, nodeId: string, projectId: string | null) {
  await requireAdmin();
  try {
    const node = await updateNodeAccessible([accessLevel], nodeId, { projectId });
    if (!node) return { error: "Node not found or not accessible" };
    return { node: await selected([accessLevel], nodeId), info: "Project updated" };
  } catch (error) {
    return { error: `Save failed: ${(error as Error).message}` };
  }
}

export async function clientIds(): Promise<string[]> {
  await requireAdmin();
  const rows = await db
    .selectDistinct({ clientId: tables.channelMappings.clientId })
    .from(tables.channelMappings)
    .where(eq(tables.channelMappings.status, "active"));
  return rows.flatMap((row) => (row.clientId ? [row.clientId] : []));
}
