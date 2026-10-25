import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { db, tables } from "../db/index.ts";
import type { Link, Node, User } from "../db/schema.ts";
import { emit } from "../events/index.ts";
import { isUuid } from "../accounts.ts";
import { accessEquals, accessOverlaps, isPrivate } from "./access.ts";

const { nodes, links, users, projects } = tables;

export type NodeAttrs = {
  content: string;
  embedding?: number[] | null;
  conversationId?: string | null;
  projectId?: string | null;
  processedAt?: Date | null;
};

export class ValidationError extends Error {
  constructor(readonly errors: Record<string, string>) {
    super(
      Object.entries(errors)
        .map(([field, message]) => `${field}: ${message}`)
        .join(", "),
    );
  }
}

const preview = (content: string | null | undefined, length = 100) => (content ?? "").slice(0, length);

const nowSeconds = () => new Date(Math.floor(Date.now() / 1000) * 1000);

function validateNode(content: string | undefined, access: readonly string[] | undefined) {
  const errors: Record<string, string> = {};
  if (content !== undefined && content.trim() === "") errors.content = "can't be blank";
  if (access !== undefined && access.length < 1) errors.access = "should have at least 1 item(s)";
  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
}

export async function createNode(userId: string, access: string[], attrs: NodeAttrs): Promise<Node> {
  validateNode(attrs.content, access);
  const [node] = await db
    .insert(nodes)
    .values({
      userId,
      access,
      content: attrs.content,
      embedding: attrs.embedding ?? null,
      conversationId: attrs.conversationId ?? null,
      projectId: attrs.projectId ?? null,
      processedAt: attrs.processedAt ?? null,
    })
    .returning();

  emit("memory_node_created", {
    userId,
    source: "memory",
    meta: { node_id: node.id, access, content_preview: preview(node.content) },
  });

  return node;
}

export async function listNodes(userId: string, limit = 100): Promise<Node[]> {
  return db.select().from(nodes).where(eq(nodes.userId, userId)).orderBy(desc(nodes.insertedAt)).limit(limit);
}

export interface ListByDateOptions {
  since?: Date | null;
  until?: Date | null;
  limit?: number;
  order?: "asc" | "desc";
  projectId?: string | null;
}

export async function listNodesByDate(readableLevels: string[], opts: ListByDateOptions = {}): Promise<Node[]> {
  const conditions: SQL[] = [accessOverlaps(nodes.access, readableLevels)];
  if (opts.since) conditions.push(gte(nodes.insertedAt, opts.since));
  if (opts.until) conditions.push(lte(nodes.insertedAt, opts.until));
  if (opts.projectId) conditions.push(eq(nodes.projectId, opts.projectId));

  return db
    .select()
    .from(nodes)
    .where(and(...conditions))
    .orderBy(opts.order === "asc" ? asc(nodes.insertedAt) : desc(nodes.insertedAt))
    .limit(opts.limit ?? 50);
}

export async function getSlipboxNodes(userId: string, limit = 100): Promise<Node[]> {
  return db
    .select()
    .from(nodes)
    .where(and(eq(nodes.userId, userId), isNull(nodes.processedAt)))
    .orderBy(asc(nodes.insertedAt))
    .limit(limit);
}

export async function listSlipboxAccessBuckets(): Promise<string[][]> {
  const rows = await db.selectDistinct({ access: nodes.access }).from(nodes).where(isNull(nodes.processedAt));
  return rows.map((row) => row.access);
}

export async function getSlipboxNodesByAccess(access: string[], limit = 100): Promise<Node[]> {
  return db
    .select()
    .from(nodes)
    .where(and(isNull(nodes.processedAt), accessEquals(nodes.access, access)))
    .orderBy(asc(nodes.insertedAt))
    .limit(limit);
}

export async function listProcessedAccessBuckets(): Promise<string[][]> {
  const rows = await db.selectDistinct({ access: nodes.access }).from(nodes).where(isNotNull(nodes.processedAt));
  return rows.map((row) => row.access);
}

export async function getNode(userId: string, id: string): Promise<Node | null> {
  if (!isUuid(id)) return null;
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.userId, userId), eq(nodes.id, id)))
    .limit(1);
  return node ?? null;
}

export async function getNodeById(id: string): Promise<Node | null> {
  if (!isUuid(id)) return null;
  const [node] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
  return node ?? null;
}

export async function getNodeAccessible(readableLevels: string[], id: string): Promise<Node | null> {
  if (!isUuid(id)) return null;
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), accessOverlaps(nodes.access, readableLevels)))
    .limit(1);
  return node ?? null;
}

export async function markProcessed(userId: string, nodeId: string): Promise<void> {
  if (!isUuid(nodeId)) return;
  await db
    .update(nodes)
    .set({ processedAt: nowSeconds() })
    .where(and(eq(nodes.userId, userId), eq(nodes.id, nodeId)));
  emit("memory_node_processed", { userId, source: "memory", meta: { node_id: nodeId } });
}

export async function markProcessedAccessible(readableLevels: string[], nodeId: string): Promise<boolean> {
  if (!isUuid(nodeId)) return false;
  const result = await db
    .update(nodes)
    .set({ processedAt: nowSeconds() })
    .where(and(eq(nodes.id, nodeId), accessOverlaps(nodes.access, readableLevels)));
  if ((result.rowCount ?? 0) > 0) {
    emit("memory_node_processed", { userId: null, source: "memory", meta: { node_id: nodeId } });
    return true;
  }
  return false;
}

export type NodeUpdate = Partial<Pick<Node, "content" | "embedding" | "projectId" | "processedAt" | "access" | "conversationId">>;

async function applyUpdate(node: Node, attrs: NodeUpdate, eventUserId: string | null): Promise<Node> {
  validateNode(attrs.content, attrs.access);
  const [updated] = await db.update(nodes).set(attrs).where(eq(nodes.id, node.id)).returning();
  emit("memory_node_updated", {
    userId: eventUserId,
    source: "memory",
    meta: { node_id: updated.id, content_preview: preview(updated.content) },
  });
  return updated;
}

export async function updateNode(userId: string, nodeId: string, attrs: NodeUpdate): Promise<Node | null> {
  const node = await getNode(userId, nodeId);
  return node ? applyUpdate(node, attrs, userId) : null;
}

export async function updateNodeAccessible(readableLevels: string[], nodeId: string, attrs: NodeUpdate): Promise<Node | null> {
  const node = await getNodeAccessible(readableLevels, nodeId);
  return node ? applyUpdate(node, attrs, node.userId) : null;
}

export type DeleteResult = { ok: true; node: Node } | { ok: false; error: "not_found" | "soul" };

async function removeNode(node: Node, eventUserId: string | null): Promise<DeleteResult> {
  if (await isSoul(node.id)) return { ok: false, error: "soul" };
  await db.delete(links).where(or(eq(links.nodeAId, node.id), eq(links.nodeBId, node.id)));
  await db.delete(nodes).where(eq(nodes.id, node.id));
  emit("memory_node_deleted", { userId: eventUserId, source: "memory", meta: { node_id: node.id } });
  return { ok: true, node };
}

export async function deleteNode(userId: string, nodeId: string): Promise<DeleteResult> {
  const node = await getNode(userId, nodeId);
  return node ? removeNode(node, userId) : { ok: false, error: "not_found" };
}

export async function deleteNodeAccessible(readableLevels: string[], nodeId: string): Promise<DeleteResult> {
  const node = await getNodeAccessible(readableLevels, nodeId);
  return node ? removeNode(node, node.userId) : { ok: false, error: "not_found" };
}

function orderPair(a: string, b: string): [string, string] {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left > right ? [right, left] : [left, right];
}

export async function createLink(
  userId: string | null,
  nodeAId: string,
  nodeBId: string,
  opts: { context?: string | null } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isUuid(nodeAId) || !isUuid(nodeBId)) return { ok: false, error: "node_a_id/node_b_id: is invalid" };
  const [a, b] = orderPair(nodeAId, nodeBId);
  try {
    await db
      .insert(links)
      .values({ nodeAId: a, nodeBId: b, ...(opts.context ? { context: opts.context } : {}) })
      .onConflictDoNothing();
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  emit("memory_link_created", { userId, source: "memory", meta: { node_a_id: a, node_b_id: b } });
  return { ok: true };
}

export async function deleteLink(userId: string, nodeAId: string, nodeBId: string): Promise<Link | null> {
  if (!isUuid(nodeAId) || !isUuid(nodeBId)) return null;
  const [a, b] = orderPair(nodeAId, nodeBId);
  const owned = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.userId, userId), inArray(nodes.id, [a, b])));
  if (new Set(owned.map((row) => row.id)).size !== 2) return null;
  return removeLink(userId, a, b);
}

export async function deleteLinkAccessible(readableLevels: string[], nodeAId: string, nodeBId: string): Promise<Link | null> {
  if (!isUuid(nodeAId) || !isUuid(nodeBId)) return null;
  const [a, b] = orderPair(nodeAId, nodeBId);
  const accessible = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(inArray(nodes.id, [a, b]), accessOverlaps(nodes.access, readableLevels)));
  if (new Set(accessible.map((row) => row.id)).size !== 2) return null;
  return removeLink(null, a, b);
}

async function removeLink(userId: string | null, a: string, b: string): Promise<Link | null> {
  const [link] = await db
    .delete(links)
    .where(and(eq(links.nodeAId, a), eq(links.nodeBId, b)))
    .returning();
  if (!link) return null;
  emit("memory_link_deleted", { userId, source: "memory", meta: { node_a_id: a, node_b_id: b } });
  return link;
}

function linkedTo(nodeId: string): SQL {
  return or(and(eq(links.nodeAId, nodeId), eq(links.nodeBId, nodes.id)), and(eq(links.nodeBId, nodeId), eq(links.nodeAId, nodes.id)))!;
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

export async function getNodeLinks(userId: string, nodeId: string): Promise<Node[]> {
  if (!isUuid(nodeId)) return [];
  const rows = await db.select({ node: nodes }).from(nodes).innerJoin(links, linkedTo(nodeId)).where(eq(nodes.userId, userId));
  return dedupeById(rows.map((row) => row.node));
}

export async function getNodeLinksAccessible(readableLevels: string[], nodeId: string): Promise<Node[]> {
  if (!isUuid(nodeId)) return [];
  const rows = await db
    .select({ node: nodes })
    .from(nodes)
    .innerJoin(links, linkedTo(nodeId))
    .where(accessOverlaps(nodes.access, readableLevels));
  return dedupeById(rows.map((row) => row.node));
}

export async function getNodeLinksWithContextAccessible(
  readableLevels: string[],
  nodeId: string,
): Promise<{ node: Node; context: string | null }[]> {
  if (!isUuid(nodeId)) return [];
  const rows = await db
    .select({ node: nodes, context: links.context })
    .from(nodes)
    .innerJoin(links, linkedTo(nodeId))
    .where(accessOverlaps(nodes.access, readableLevels));
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.node.id) ? false : (seen.add(row.node.id), true)));
}

export async function getRandomNodes(userId: string, limit = 10): Promise<Node[]> {
  return db
    .select()
    .from(nodes)
    .where(and(eq(nodes.userId, userId), isNotNull(nodes.processedAt)))
    .orderBy(sql`RANDOM()`)
    .limit(limit);
}

export async function getRandomNodesByAccess(access: string[], limit = 10): Promise<Node[]> {
  return db
    .select()
    .from(nodes)
    .where(and(accessEquals(nodes.access, access), isNotNull(nodes.processedAt)))
    .orderBy(sql`RANDOM()`)
    .limit(limit);
}

const TIME_BOUND_PATTERN = String.raw`\d{4}-\d{2}-\d{2}|\m\d{1,2}[./]\d{1,2}\M|\m(jutr\w*|pojutrze|dzisiaj|dziś|wczoraj|tomorrow|today|yesterday|urlop\w*|wolne\w*|spotkani\w*|deadline\w*|termin\w*|poniedział\w*|wtor\w*|środ\w*|czwart\w*|piąt\w*|sobot\w*|niedziel\w*|stycz\w*|lut\w*|marc\w*|kwie\w*|maj[au]?|czerw\w*|lip\w*|sierp\w*|wrze[sś]\w*|październik\w*|listopad\w*|grud\w*|january|february|april|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\M`;

export async function getTimeBoundNodesByAccess(access: string[], opts: { limit?: number; minAgeDays?: number } = {}): Promise<Node[]> {
  const cutoff = new Date(Date.now() - (opts.minAgeDays ?? 1) * 86_400_000);
  const souls = db.select({ id: users.soulNodeId }).from(users).where(isNotNull(users.soulNodeId));
  return db
    .select()
    .from(nodes)
    .where(
      and(
        accessEquals(nodes.access, access),
        isNotNull(nodes.processedAt),
        lt(nodes.insertedAt, cutoff),
        sql`${nodes.content} ~* ${TIME_BOUND_PATTERN}`,
        notInArray(nodes.id, souls),
      ),
    )
    .orderBy(sql`RANDOM()`)
    .limit(opts.limit ?? 40);
}

export interface GraphStats {
  total_nodes: number;
  total_links: number;
  slipbox_count: number;
  orphan_count: number;
  weakly_connected_count: number;
  link_to_note_ratio: number;
}

function linkEnds() {
  return unionAll(
    db.select({ nodeId: links.nodeAId, linkId: links.id }).from(links),
    db.select({ nodeId: links.nodeBId, linkId: links.id }).from(links),
  ).as("link_ends");
}

function processedDegrees(scope: SQL | undefined) {
  const ends = linkEnds();
  return db
    .select({ id: nodes.id, degree: count(ends.linkId).as("degree") })
    .from(nodes)
    .leftJoin(ends, eq(ends.nodeId, nodes.id))
    .where(and(scope, isNotNull(nodes.processedAt)))
    .groupBy(nodes.id)
    .as("degrees");
}

async function countWithDegree(scope: SQL | undefined, degree: number): Promise<number> {
  const degrees = processedDegrees(scope);
  const [row] = await db.select({ n: count() }).from(degrees).where(eq(degrees.degree, degree));
  return row?.n ?? 0;
}

async function computeGraphStats(scope: SQL | undefined): Promise<GraphStats> {
  const scoped = db.select({ id: nodes.id }).from(nodes).where(scope);
  const [totalNodes, slipbox, totalLinks, orphans, weak] = await Promise.all([
    db.$count(nodes, scope),
    db.$count(nodes, and(scope, isNull(nodes.processedAt))),
    db.$count(links, and(inArray(links.nodeAId, scoped), inArray(links.nodeBId, scoped))),
    countWithDegree(scope, 0),
    countWithDegree(scope, 1),
  ]);
  return {
    total_nodes: totalNodes,
    total_links: totalLinks,
    slipbox_count: slipbox,
    orphan_count: orphans,
    weakly_connected_count: weak,
    link_to_note_ratio: totalNodes > 0 ? Math.round((totalLinks / totalNodes) * 100) / 100 : 0,
  };
}

export function graphStats(userId: string | null = null): Promise<GraphStats> {
  return computeGraphStats(userId ? eq(nodes.userId, userId) : undefined);
}

export function graphStatsByAccess(access: string[]): Promise<GraphStats> {
  return computeGraphStats(accessEquals(nodes.access, access));
}

type DegreeFilter = "orphan" | "weak";

async function nodesByDegree(scope: SQL, degree: DegreeFilter, limit: number): Promise<Node[]> {
  const ends = linkEnds();
  const rows = await db
    .select({ node: nodes })
    .from(nodes)
    .leftJoin(ends, eq(ends.nodeId, nodes.id))
    .where(and(scope, isNotNull(nodes.processedAt)))
    .groupBy(nodes.id)
    .having(eq(count(ends.linkId), degree === "orphan" ? 0 : 1))
    .orderBy(asc(nodes.insertedAt))
    .limit(limit);
  return rows.map((row) => row.node);
}

export function getOrphanNodes(userId: string, limit = 25) {
  return nodesByDegree(eq(nodes.userId, userId), "orphan", limit);
}

export function getWeaklyConnectedNodes(userId: string, limit = 25) {
  return nodesByDegree(eq(nodes.userId, userId), "weak", limit);
}

export function getOrphanNodesByAccess(access: string[], limit = 25) {
  return nodesByDegree(accessEquals(nodes.access, access), "orphan", limit);
}

export function getWeaklyConnectedNodesByAccess(access: string[], limit = 25) {
  return nodesByDegree(accessEquals(nodes.access, access), "weak", limit);
}

export async function getStalestNodes(userId: string, limit = 25): Promise<Node[]> {
  return db
    .select()
    .from(nodes)
    .where(and(eq(nodes.userId, userId), isNotNull(nodes.processedAt)))
    .orderBy(asc(nodes.insertedAt))
    .limit(limit);
}

export async function getStalestNodesByAccess(access: string[], limit = 25): Promise<Node[]> {
  return db
    .select()
    .from(nodes)
    .where(and(accessEquals(nodes.access, access), isNotNull(nodes.processedAt)))
    .orderBy(asc(nodes.insertedAt))
    .limit(limit);
}

export interface GraphNodeData {
  id: string;
  content: string;
  content_preview: string;
  processed: boolean;
  link_count: number;
  inserted_at: string;
}

export interface GraphData {
  nodes: GraphNodeData[];
  edges: { source: string; target: string }[];
}

export async function getGraphData(
  opts: { filter?: "all" | "processed" | "slipbox"; accessLevel?: string | null; projectId?: string | null } = {},
): Promise<GraphData> {
  const conditions: SQL[] = [];
  if (opts.filter === "processed") conditions.push(isNotNull(nodes.processedAt));
  if (opts.filter === "slipbox") conditions.push(isNull(nodes.processedAt));
  if (opts.accessLevel) conditions.push(accessOverlaps(nodes.access, [opts.accessLevel]));
  if (opts.projectId) conditions.push(eq(nodes.projectId, opts.projectId));

  const rows = await db
    .select()
    .from(nodes)
    .where(conditions.length ? and(...conditions) : undefined);
  const ids = new Set(rows.map((row) => row.id));

  const allLinks = await db.select({ a: links.nodeAId, b: links.nodeBId }).from(links);
  const counts = new Map<string, number>();
  for (const link of allLinks) {
    counts.set(link.a, (counts.get(link.a) ?? 0) + 1);
    counts.set(link.b, (counts.get(link.b) ?? 0) + 1);
  }

  return {
    nodes: rows.map((node) => ({
      id: node.id,
      content: node.content,
      content_preview: preview(node.content),
      processed: node.processedAt !== null,
      link_count: counts.get(node.id) ?? 0,
      inserted_at: node.insertedAt.toISOString(),
    })),
    edges: allLinks.filter((link) => ids.has(link.a) && ids.has(link.b)).map((link) => ({ source: link.a, target: link.b })),
  };
}

export async function getSoul(userId: string | null = null): Promise<Node | null> {
  if (userId === null) {
    const [row] = await db
      .select({ node: nodes })
      .from(nodes)
      .innerJoin(users, eq(users.soulNodeId, nodes.id))
      .orderBy(asc(nodes.insertedAt))
      .limit(1);
    return row?.node ?? null;
  }

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return null;
  if (user.soulNodeId === null) return adoptFirstNode(user);
  const node = await getNodeById(user.soulNodeId);
  return node ?? adoptFirstNode(user);
}

async function adoptFirstNode(user: User): Promise<Node | null> {
  if (user.slackId.startsWith("system:")) return null;
  const [first] = await db.select().from(nodes).where(eq(nodes.userId, user.id)).orderBy(asc(nodes.insertedAt), asc(nodes.id)).limit(1);
  if (first) await db.update(users).set({ soulNodeId: first.id }).where(eq(users.id, user.id));
  return first ?? null;
}

export async function hasSoul(userId: string): Promise<boolean> {
  return (await getSoul(userId)) !== null;
}

export async function isSoul(nodeId: string): Promise<boolean> {
  if (!isUuid(nodeId)) return false;
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.soulNodeId, nodeId)).limit(1);
  return rows.length > 0;
}

export async function soulNodeIds(): Promise<Set<string>> {
  const rows = await db.select({ id: users.soulNodeId }).from(users).where(isNotNull(users.soulNodeId));
  return new Set(rows.map((row) => row.id!));
}

export async function setSoul(userId: string, nodeId: string): Promise<Node | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const node = await getNodeById(nodeId);
  if (!user || !node) return null;
  await db.update(users).set({ soulNodeId: node.id }).where(eq(users.id, user.id));
  return node;
}

export async function updateSoul(userId: string, content: string, embedding: number[], access: string[]): Promise<Node> {
  const soul = await getSoul(userId);
  if (!soul) {
    const node = await createNode(userId, access, { content, embedding, processedAt: nowSeconds() });
    await setSoul(userId, node.id);
    return node;
  }
  validateNode(content, undefined);
  const [updated] = await db.update(nodes).set({ content, embedding }).where(eq(nodes.id, soul.id)).returning();
  emit("memory_node_updated", {
    userId,
    source: "memory",
    meta: { node_id: updated.id, content_preview: preview(updated.content) },
  });
  return updated;
}

export type EscalationError =
  | "not_found"
  | "external_channel_escalation_not_allowed"
  | "invalid_escalation_level"
  | "already_accessible"
  | "downward_or_cross_scope_escalation"
  | "external_all_escalation_not_allowed"
  | "cross_client_escalation_not_allowed";

function validateEscalationContext(level: string, readable: string[]): EscalationError | null {
  if (level === "internal") {
    return readable.includes("internal") ? null : "external_channel_escalation_not_allowed";
  }
  if (!level.startsWith("external/")) return "invalid_escalation_level";
  if (!readable.includes("internal")) return "external_channel_escalation_not_allowed";
  return null;
}

function validateEscalationTarget(current: string[], level: string): EscalationError | null {
  const currentExternal = current.filter((item) => item.startsWith("external/"));
  if (current.includes(level)) return "already_accessible";
  if (!current.includes("internal") && !isPrivate(current)) return "downward_or_cross_scope_escalation";
  if (level === "external/all" && currentExternal.length > 0) return "external_all_escalation_not_allowed";
  if (currentExternal.some((item) => item !== level)) return "cross_client_escalation_not_allowed";
  return null;
}

export async function escalateNoteAccess(
  nodeId: string,
  level: string,
  readableLevels: string[],
): Promise<{ ok: true; node: Node } | { ok: false; error: EscalationError }> {
  const contextError = validateEscalationContext(level, readableLevels);
  if (contextError) return { ok: false, error: contextError };

  const node = await getNodeAccessible(readableLevels, nodeId);
  if (!node) return { ok: false, error: "not_found" };

  const targetError = validateEscalationTarget(node.access, level);
  if (targetError) return { ok: false, error: targetError };

  const merged = [...new Set([...node.access, level])];
  const [updated] = await db.update(nodes).set({ access: merged }).where(eq(nodes.id, node.id)).returning();
  emit("memory_node_escalated", {
    source: "escalation",
    meta: { node_id: nodeId, from_access: node.access, to_access: merged },
  });
  return { ok: true, node: updated };
}

export async function linkCounts(nodeIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (nodeIds.length === 0) return counts;
  const rows = await db
    .select({ a: links.nodeAId, b: links.nodeBId })
    .from(links)
    .where(or(inArray(links.nodeAId, nodeIds), inArray(links.nodeBId, nodeIds)));
  const wanted = new Set(nodeIds);
  for (const row of rows) {
    for (const id of [row.a, row.b]) if (wanted.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

export async function projectNames(): Promise<Map<string, string>> {
  const rows = await db.select({ id: projects.id, name: projects.name }).from(projects);
  return new Map(rows.map((row) => [row.id, row.name]));
}
