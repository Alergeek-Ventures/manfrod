import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { tool, type ModelMessage, type ToolSet } from "ai";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { systemUserId } from "../accounts.ts";
import { search as braveSearch, BraveSearchError } from "../brave.ts";
import { db, tables } from "../db/index.ts";
import type { Node } from "../db/schema.ts";
import { broadcast } from "../events/index.ts";
import { deleteAbsencesEndedBefore } from "../facts.ts";
import { MEMORY_CHAIN, generateText, system, user } from "../llm/index.ts";
import { logger } from "../log.ts";
import { addDays, dateIsoInZone, localToday, weekdayName } from "../time.ts";
import { embedQuery } from "../voyage.ts";
import { accessEquals } from "./access.ts";
import {
  createLink,
  createNode,
  deleteLinkAccessible,
  deleteNodeAccessible,
  getNodeAccessible,
  getNodeLinksWithContextAccessible,
  getOrphanNodesByAccess,
  getRandomNodesByAccess,
  getSlipboxNodesByAccess,
  getStalestNodesByAccess,
  getTimeBoundNodesByAccess,
  getWeaklyConnectedNodesByAccess,
  graphStatsByAccess,
  isSoul,
  linkCounts,
  listProcessedAccessBuckets,
  listSlipboxAccessBuckets,
  markProcessedAccessible,
  markTimeChecked,
  projectNames,
  soulNodeIds,
  updateNodeAccessible,
} from "./nodes.ts";
import { findProject, listProjects } from "./projects.ts";
import { search as memorySearch, similarNodes } from "./search.ts";

const { nodes, links } = tables;
const log = logger("Retrospector");

const TIME_BOUND_BUDGET = 40;
const GRAPH_REVIEW_BUDGET = 40;
const ABSENCE_GRACE_DAYS = 7;
const NEIGHBOR_LIMIT = 3;
const NEIGHBOR_MAX_DISTANCE = 0.5;
const LIKELY_DUPLICATE_DISTANCE = 0.15;
const MAX_ITERATIONS = 40;
const RUN_ITERATION_BUDGET = 200;
const COMPACT_EVERY = 10;
const HEALTHY_LINK_RATIO = 3;
const MIN_REVIEW_NODES = 5;

interface RunBudget {
  iterations: number;
}

const newBudget = (): RunBudget => ({ iterations: RUN_ITERATION_BUDGET });

async function graphHealthy(bucket: string[]): Promise<boolean> {
  const stats = await graphStatsByAccess(bucket);
  if (stats.total_nodes < MIN_REVIEW_NODES) return true;
  return stats.orphan_count === 0 && stats.link_to_note_ratio >= HEALTHY_LINK_RATIO;
}

const SYSTEM_PROMPT_HEAD = `You are iteratively building a zettelkasten - a personal knowledge graph for
yourself, composed of atomic notes.

You have access to:
- Unprocessed notes from recent conversations (the slipbox)
- The existing knowledge graph (via search, find_similar, and list_links)
- Tools to create nodes, create links, delete nodes, delete links, and mark notes as processed
- A graph_stats tool to check overall graph health
- A web_search tool to look up current facts on the web when you need to verify or enrich notes

Every node listed in your input comes annotated with its nearest existing
nodes by embedding similarity (lines starting with "~", with a \`sim\` score).
These annotations are precomputed for you — they are your duplicate suspects
and link candidates. Use them; don't rediscover them with blind searches.

## First Step

Always call graph_stats first. This tells you the current state of the graph:
how many orphans need connecting, how many weakly connected nodes need
strengthening, and whether the link-to-note ratio is healthy (aim for > 3.0).

## Deduplication

Exact 1:1 text duplicates are merged mechanically before you run — what
reaches you are the judgment calls: near-duplicates and rewordings. Expect
many of them, both between slipbox items and against the existing graph.
That's because we extract all interesting facts from conversations without
regard to current contents. Your job is to keep the graph deduplicated.

The rule: **same fact, different wording → merge. Different facts about the
same topic → link, don't merge.**

- A "~" neighbor marked LIKELY DUPLICATE (sim ≥ 0.85): merge it unless the
  two clearly state different facts.
- A "~" neighbor with sim 0.7–0.85: read both carefully — reworded
  duplicates often score in this range. Use find_similar or get_node when
  the one-line preview isn't enough to decide.
- Two slipbox items can duplicate each other too — resolve those before
  integrating either.

When consolidating duplicates, prefer update_node over delete+create:
1. Pick the node with more links (it's better connected)
2. Use update_node to merge the best content from both into that node
3. Delete the other node

This preserves the surviving node's ID, links, and provenance.

You work on one access scope per run. Nodes from other scopes can show up as
neighbors and can be linked, but only nodes from this scope can be edited or
deleted — when a duplicate pair spans scopes, delete this scope's copy.

## Links

Link two notes only when they share something concrete: the same person,
event, decision, incident or piece of work, or when one explains, continues,
updates or contradicts the other. Sharing a project, a tool or a broad topic
is a reason to look closer, not a reason to link. Two strong links beat five
vague ones.

Every link needs a context that names that concrete connection, so someone
following it knows what they will find:
Good: "The outage reported on 28.10 that this production fix was meant to resolve"
Good: "The earlier plan to hire an architect; this note records that an external firm was hired instead"
Bad: "Both concern deployments of the same app" (only says they share a topic)
Bad: no context, or "related"

Never link the same pair twice; when unsure whether a link exists, check
list_links first.

## Graph Gardening

Don't just process the slipbox - tend to the garden. Each session, go deeper:
- Follow links from nodes you touch to see what's connected
- Look for clusters that could use structure notes
- Find orphans that deserve connections - these are your top priority. An
  orphan's "~" neighbors are ready-made link candidates: if one meets the
  bar in "Links", create the link rather than leaving the orphan
  unconnected. Only leave an orphan alone when none of its neighbors do —
  never because you didn't check.
- Strengthen weakly connected nodes (1 link) with additional connections
- Notice patterns emerging and create new linking opportunities
- Consolidate near-duplicates you discover while exploring (find_similar on
  any node you touch is a cheap check)
- Let structure emerge from your observations

The graph is alive. You're not just adding to it - you're shaping it, pruning
it, helping it grow in interesting directions. Log what you notice. React to
what you find. Iterate.

The review nodes you receive are prioritized: orphans first, then weakly
connected, then oldest nodes, then random. Tackle unprocessed slipbox notes
first, then work through all the review nodes. For each one, search for
missed connections, deduplicate, edit, consolidate.

## Project Grouping

Some nodes carry a project tag, shown as \`[project: Name]\` right after the
node's id in every listing and neighbor line — stamped automatically from
the Slack channel a note came from, when that channel is mapped to a
project. Not every node has one; an untagged node is a normal, expected
state, not something to fix by guessing.

Treat a shared project tag as a strong, deterministic clustering signal,
on top of (not instead of) embedding similarity:

- Two nodes sharing the same project are worth comparing even at moderate
  "~" similarity, since the embedding can underweight shared project
  context — but link them only when they meet the bar in "Links".
- When working through project-tagged slipbox or review nodes, use
  \`search\`'s \`project\` parameter to pull the rest of that project's nodes
  and check for missed connections within it, the same way you'd search
  keywords for a topic.
- If a project's own cluster grows dense enough that you're losing
  overview of it (the same "losing overview" trigger as Structure Notes
  below, just scoped to one project instead of the whole graph), create a
  structure note for it and tag it with that project via \`create_node\`'s
  \`project\` parameter — this lets a project's own hub emerge naturally
  from its nodes, the same way a general hub emerges from a topic cluster.
- If you find a node whose project tag looks wrong, or an obviously
  project-specific node with no tag at all, correct it with \`update_node\`'s
  \`project\` parameter — don't leave a wrong or missing tag once you've
  noticed it while working the graph.
- Use \`list_projects\` if you're unsure of a project's exact name/slug.

## Time-bound Notes

Your input starts with today's date, and every listed note shows the date
it was written. A note about a one-off event, plan, meeting, absence,
deadline or temporary state ("Franek jest na urlopie 8-16.10", "spotkanie
z klientem w czwartek", "trzeba wysłać ofertę do piątku") stops being
useful once that date has passed. Relative dates ("jutro", "w piątek")
count from the day the note was written.

- Over, with nothing lasting in it → delete_node.
- Over, but it records something that still matters (a decision taken, an
  outcome, how something works, someone's preference) → update_node to
  keep only that lasting part, in the past tense, without the stale
  schedule.
- Still upcoming or ongoing, recurring, or you can't tell → leave it.

## Souls

A note marked \`[soul]\` is the anchor of someone's graph: it opens every
conversation with them. Link to it freely, but never delete, merge away or
rewrite it — only its owner can change it. When a soul has a duplicate,
keep the soul and delete the duplicate.

## Contradictions

When two notes disagree, the newer one (by written date) is usually a
correction of the older: keep the newer, and fix or delete the older.

## Structure Notes

When the graph reaches ~700 nodes, start creating structure notes - hub nodes
that organize and link clusters of related ideas. These are like tables of
contents for topic areas. Don't force them before the graph is ready.

When finished, say "Done."

Here is a guide on zettelkasten best practices:

`;

function systemPrompt(): string {
  const guide = readFileSync(path.join(process.cwd(), "lib", "prompts", "zettelkasten.md"), "utf8");
  return `${SYSTEM_PROMPT_HEAD}${guide}`;
}

type Kind = "slipbox_drain" | "graph_review";

export interface ProcessOptions {
  batchSize?: number;
  maxBatches?: number;
}

export async function processAllBuckets(opts: ProcessOptions = {}): Promise<void> {
  await mergeExactDuplicates();
  const buckets = await listSlipboxAccessBuckets();
  if (buckets.length === 0) {
    log.debug("Retrospector: no pending nodes in any access bucket");
    return;
  }
  log.info(`Retrospector: processing ${buckets.length} access bucket(s)`);
  const budget = newBudget();
  for (const bucket of buckets) {
    if (budget.iterations <= 0) {
      log.warn("Retrospector: run iteration budget exhausted, leaving the remaining buckets for the next run");
      return;
    }
    const userId = await findBucketUserId(bucket);
    if (!userId) {
      log.warn(`Retrospector: no user found for bucket ${JSON.stringify(bucket)}, skipping`);
      continue;
    }
    await processBucket(userId, bucketReadableLevels(bucket), bucket, opts, budget);
  }
}

export async function reviewProcessedGraph(opts: { reviewBudget?: number } = {}): Promise<void> {
  await mergeExactDuplicates();
  await prunePastAbsences();
  const budget = opts.reviewBudget ?? GRAPH_REVIEW_BUDGET;
  const buckets = await listProcessedAccessBuckets();
  if (buckets.length === 0) {
    log.debug("Retrospector: no processed nodes in any access bucket");
    return;
  }
  log.info(`Retrospector: deep-reviewing ${buckets.length} access bucket(s)`);
  const runBudget = newBudget();
  for (const bucket of buckets) {
    if (runBudget.iterations <= 0) {
      log.warn("Retrospector: run iteration budget exhausted, leaving the remaining buckets for the next review");
      return;
    }
    const userId = await findBucketUserId(bucket);
    if (!userId) {
      log.warn(`Retrospector: no user found for bucket ${JSON.stringify(bucket)}, skipping`);
      continue;
    }
    const timeBound = await getTimeBoundNodesByAccess(bucket, { limit: TIME_BOUND_BUDGET });
    const healthy = await graphHealthy(bucket);
    if (healthy && timeBound.length === 0) {
      log.info(
        `Retrospector: bucket ${JSON.stringify(bucket)} needs no review (no orphans and link ratio ≥ ${HEALTHY_LINK_RATIO}, or under ${MIN_REVIEW_NODES} notes)`,
      );
      continue;
    }
    const reviewSample = healthy ? [] : await buildReviewSample(bucket, budget);
    if (reviewSample.length === 0 && timeBound.length === 0) continue;
    const stopWhenHealthy = timeBound.length === 0 ? () => graphHealthy(bucket) : undefined;
    const reviewed = await runAgent(
      userId,
      bucketReadableLevels(bucket),
      bucket,
      [],
      reviewSample,
      "graph_review",
      timeBound,
      runBudget,
      stopWhenHealthy,
    );
    if (reviewed) await markTimeChecked(timeBound.map((node) => node.id));
  }
}

export async function prunePastAbsences(): Promise<number> {
  const cutoff = addDays(localToday(), -ABSENCE_GRACE_DAYS);
  const count = await deleteAbsencesEndedBefore(cutoff);
  if (count > 0) log.info(`Retrospector: deleted ${count} absence fact(s) that ended before ${cutoff}`);
  return count;
}

export async function mergeExactDuplicates(): Promise<{ groups: number; deleted: number }> {
  const groups = await db
    .select({ content: sql<string>`btrim(${nodes.content})`, access: nodes.access })
    .from(nodes)
    .groupBy(sql`btrim(${nodes.content})`, nodes.access)
    .having(sql`count(${nodes.id}) > 1`);

  const result = { groups: 0, deleted: 0 };
  for (const group of groups) {
    const deleted = await mergeGroup(group.content, group.access);
    if (deleted > 0) {
      result.groups += 1;
      result.deleted += deleted;
    }
  }
  if (result.groups > 0) {
    log.info(`Retrospector: merged ${result.groups} exact-duplicate group(s), deleted ${result.deleted} node(s)`);
  }
  return result;
}

async function mergeGroup(content: string, access: string[]): Promise<number> {
  const members = await db
    .select()
    .from(nodes)
    .where(and(sql`btrim(${nodes.content}) = ${content}`, accessEquals(nodes.access, access)));
  if (members.length < 2) return 0;

  const counts = await linkCounts(members.map((node) => node.id));
  const souls = await soulNodeIds();
  const sorted = [...members].sort((a, b) => {
    const keyA = [souls.has(a.id) ? 0 : 1, -(counts.get(a.id) ?? 0), a.processedAt ? 0 : 1, a.insertedAt.getTime()];
    const keyB = [souls.has(b.id) ? 0 : 1, -(counts.get(b.id) ?? 0), b.processedAt ? 0 : 1, b.insertedAt.getTime()];
    for (let index = 0; index < keyA.length; index += 1) {
      if (keyA[index] !== keyB[index]) return keyA[index] - keyB[index];
    }
    return 0;
  });
  const [survivor, ...rest] = sorted;
  const losers = rest.filter((node) => !souls.has(node.id));
  const groupIds = new Set(members.map((node) => node.id));
  for (const loser of losers) await absorb(survivor, loser, groupIds);
  return losers.length;
}

async function absorb(survivor: Node, loser: Node, groupIds: Set<string>) {
  const loserLinks = await db
    .select()
    .from(links)
    .where(or(eq(links.nodeAId, loser.id), eq(links.nodeBId, loser.id)));
  for (const link of loserLinks) {
    const other = link.nodeAId === loser.id ? link.nodeBId : link.nodeAId;
    if (!groupIds.has(other)) await createLink(null, survivor.id, other, { context: link.context });
  }
  await db.delete(nodes).where(eq(nodes.id, loser.id));
  await broadcast("memory_node_deleted", {
    userId: loser.userId,
    source: "memory",
    meta: { node_id: loser.id, reason: "exact_duplicate", merged_into: survivor.id },
  });
}

export function bucketReadableLevels(bucket: string[]): string[] {
  if (bucket.includes("external/all")) return ["external/all"];
  const clients = bucket.filter((level) => level.startsWith("external/"));
  if (clients.length > 0) return clients.length === 1 ? [clients[0], "external/all"] : ["external/all"];
  if (bucket.includes("internal")) return ["internal", "external/all"];
  return bucket;
}

const sameLevels = (a: string[], b: string[]) => a.length === b.length && a.every((level) => b.includes(level));

async function findBucketUserId(bucket: string[]): Promise<string | null> {
  const [row] = await db
    .select({ userId: nodes.userId })
    .from(nodes)
    .where(accessEquals(nodes.access, bucket))
    .orderBy(desc(nodes.insertedAt))
    .limit(1);
  return row?.userId ?? null;
}

async function processBucket(
  userId: string,
  readableLevels: string[],
  writeAccess: string[],
  opts: ProcessOptions,
  budget: RunBudget,
): Promise<void> {
  const batchSize = opts.batchSize ?? 20;
  const maxBatches = opts.maxBatches ?? 5;

  for (let batchNo = 1; ; batchNo += 1) {
    const slipbox = await getSlipboxNodesByAccess(writeAccess, batchSize);
    if (slipbox.length === 0) {
      log.debug(`Retrospector: slipbox empty for bucket ${JSON.stringify(writeAccess)}`);
      return;
    }
    if (batchNo > maxBatches || budget.iterations <= 0) {
      log.info(
        `Retrospector: batch cap (${maxBatches}) reached for bucket ${JSON.stringify(writeAccess)}, ${slipbox.length}+ slipbox nodes left for next run`,
      );
      return;
    }
    log.info(`Retrospector: batch ${batchNo}/${maxBatches} — ${slipbox.length} slipbox nodes for bucket ${JSON.stringify(writeAccess)}`);

    const batchIds = slipbox.map((node) => node.id);
    if (!(await runAgent(userId, readableLevels, writeAccess, slipbox, [], "slipbox_drain", [], budget))) return;
    if ((await unprocessedCount(batchIds)) >= batchIds.length) {
      log.warn(`Retrospector: batch ${batchNo} made no slipbox progress for bucket ${JSON.stringify(writeAccess)}, stopping`);
      return;
    }
  }
}

async function unprocessedCount(nodeIds: string[]): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(nodes)
    .where(and(inArray(nodes.id, nodeIds), isNull(nodes.processedAt)));
  return Number(row?.value ?? 0);
}

async function buildReviewSample(access: string[], budget: number): Promise<Node[]> {
  const orphans = await getOrphanNodesByAccess(access, budget);
  const seen = new Set(orphans.map((node) => node.id));
  const picked = [...orphans];

  const tiers = [
    (limit: number) => getWeaklyConnectedNodesByAccess(access, limit),
    (limit: number) => getStalestNodesByAccess(access, limit),
    (limit: number) => getRandomNodesByAccess(access, limit),
  ];
  for (const tier of tiers) {
    const remaining = budget - picked.length;
    if (remaining <= 0) break;
    const fresh = (await tier(remaining + seen.size)).filter((node) => !seen.has(node.id)).slice(0, remaining);
    for (const node of fresh) seen.add(node.id);
    picked.push(...fresh);
  }
  return picked;
}

function writtenOn(node: Node): string {
  return node.insertedAt ? node.insertedAt.toISOString().slice(0, 10) : "?";
}

async function formatNodes(list: Node[], readableLevels: string[]): Promise<string> {
  if (list.length === 0) return "";
  const [names, souls] = await Promise.all([projectNames(), soulNodeIds()]);
  const soulTag = (node: Node) => (souls.has(node.id) ? " [soul]" : "");
  const projectTag = (node: Node) => {
    const name = node.projectId ? names.get(node.projectId) : undefined;
    return name ? ` [project: ${name}]` : "";
  };

  const lines = await Promise.all(
    list.map(async (node) => {
      const base = `- [${node.id}]${soulTag(node)}${projectTag(node)} (${writtenOn(node)}) ${node.content}`;
      const neighbors = await similarNodes(node, readableLevels, { limit: NEIGHBOR_LIMIT, maxDistance: NEIGHBOR_MAX_DISTANCE });
      const neighborLines = neighbors.map(({ node: other, distance }) => {
        const similarity = Math.round((1 - distance) * 100) / 100;
        const flag = distance < LIKELY_DUPLICATE_DISTANCE ? " LIKELY DUPLICATE —" : "";
        return `    ~ [${other.id}]${soulTag(other)}${projectTag(other)} (${writtenOn(other)}, sim ${similarity})${flag} ${other.content}`;
      });
      return [base, ...neighborLines].join("\n");
    }),
  );
  return lines.join("\n");
}

function buildUserMessage(slipboxText: string, reviewText: string, timeBoundText: string): string {
  const today = localToday();
  const dateLine = `Today is ${today} (${weekdayName(today)}). Dates in parentheses are when each note was written.\n\n`;

  const slipboxSection =
    slipboxText === ""
      ? "Your slipbox is empty - no new notes to process."
      : `## Slipbox (unprocessed notes)

Lines starting with "~" are the node's nearest existing nodes by
embedding similarity — your duplicate suspects and link candidates.
Treat "LIKELY DUPLICATE" as a merge unless the two clearly state
different facts.

${slipboxText}

Process these: resolve every duplicate suspect first (merge via
update_node + delete_node), then link, then mark as processed.
`;

  const reviewSection =
    reviewText === ""
      ? ""
      : `
## Graph Review (prioritized: orphans → weak → stale → random)

These nodes need attention. Orphans and weakly connected nodes appear first.
Each comes with its nearest neighbors ("~" lines) — for an orphan those are
your ready-made link candidates: if one genuinely relates, create the link
(with context) instead of leaving the orphan unconnected. Use list_links to
explore further, and merge any duplicate suspects you confirm:

${reviewText}
`;

  const timeBoundSection =
    timeBoundText === ""
      ? ""
      : `
## Possibly expired notes

These notes mention dates, days or one-off events. Check each one
against today's date (see "Time-bound Notes"): delete the ones that
are over, trim the ones that are over but hold something lasting,
leave the rest.

${timeBoundText}
`;

  return dateLine + slipboxSection + reviewSection + timeBoundSection;
}

interface Stats {
  nodes_processed: number;
  nodes_updated: number;
  links_created: number;
  insights_created: number;
  nodes_deleted: number;
  links_deleted: number;
  input_tokens_used: number;
}

const STAT_FOR_TOOL: Record<string, keyof Stats> = {
  mark_processed: "nodes_processed",
  update_node: "nodes_updated",
  create_link: "links_created",
  create_node: "insights_created",
  delete_node: "nodes_deleted",
  delete_link: "links_deleted",
};

async function runAgent(
  userId: string,
  readableLevels: string[],
  writeAccess: string[],
  slipbox: Node[],
  reviewSample: Node[],
  kind: Kind,
  timeBound: Node[] = [],
  budget: RunBudget = newBudget(),
  stopWhen?: () => Promise<boolean>,
): Promise<boolean> {
  const [slipboxText, reviewText, timeBoundText] = await Promise.all(
    [slipbox, reviewSample, timeBound].map((list) => formatNodes(list, readableLevels)),
  );

  await broadcast("retrospection_started", {
    userId,
    source: "retrospector",
    meta: { slipbox_count: slipbox.length, review_count: reviewSample.length, time_bound_count: timeBound.length, kind },
  });

  const messages: ModelMessage[] = [system(systemPrompt()), user(buildUserMessage(slipboxText, reviewText, timeBoundText))];
  const stats: Stats = {
    nodes_processed: 0,
    nodes_updated: 0,
    links_created: 0,
    insights_created: 0,
    nodes_deleted: 0,
    links_deleted: 0,
    input_tokens_used: 0,
  };

  try {
    await callWithTools(userId, readableLevels, writeAccess, messages, stats, budget, stopWhen);
    log.info(`Retrospector: agent completed successfully for user ${userId}`);
    await broadcast("retrospection_completed", { userId, source: "retrospector", meta: { ...stats } });
    return true;
  } catch (error) {
    log.error(`Retrospector: agent failed for user ${userId}: ${(error as Error).message}`);
    await broadcast("retrospection_failed", { userId, source: "retrospector", meta: { reason: (error as Error).message } });
    return false;
  }
}

async function callWithTools(
  userId: string,
  readableLevels: string[],
  writeAccess: string[],
  initial: ModelMessage[],
  stats: Stats,
  budget: RunBudget,
  stopWhen?: () => Promise<boolean>,
): Promise<string> {
  const toolset = definitions();
  const handlers = await toolHandlers(userId, readableLevels, writeAccess);
  let messages = initial;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    if (budget.iterations <= 0) {
      log.warn(`Retrospector: run iteration budget exhausted at iteration ${iteration}, stopping`);
      return "";
    }
    if (iteration > 0 && stopWhen && (await stopWhen())) {
      log.info(`Retrospector: graph reached the target health at iteration ${iteration}, stopping`);
      return "";
    }
    budget.iterations -= 1;
    const response = await generateText(messages, { purpose: "retrospector", userId, tools: toolset, chain: MEMORY_CHAIN });
    stats.input_tokens_used += response.usage.inputTokens ?? 0;

    if (response.finishReason !== "tool-calls" || response.toolCalls.length === 0) {
      const text = response.text ?? "";
      log.debug(`Retrospector: agent finished with: ${text.slice(0, 100)}`);
      if (text !== "") {
        await broadcast("narrating", { userId, source: "retrospector", meta: { text, iteration, final: true } });
      }
      return text;
    }

    log.debug(`Retrospector: executing ${response.toolCalls.length} tool(s), iteration ${iteration}`);
    if (response.text) {
      await broadcast("narrating", { userId, source: "retrospector", meta: { text: response.text, iteration } });
    }

    const prior = messages;
    const turn: ModelMessage[] = [...response.response.messages];
    for (const call of response.toolCalls) {
      const actionId = randomBytes(4).toString("hex");
      await broadcast("action_started", {
        userId,
        source: "retrospector",
        meta: { action_id: actionId, action: call.toolName, args: JSON.stringify(call.input), iteration },
      });
      const started = Date.now();
      const handler = handlers[call.toolName];
      let result: string;
      let success = true;
      try {
        result = handler ? await handler(call.input as Record<string, any>) : `Unknown tool: ${call.toolName}`;
        if (!handler) success = false;
      } catch (error) {
        result = `Tool error: ${(error as Error).message}`;
        success = false;
      }
      await broadcast("action_completed", {
        userId,
        source: "retrospector",
        meta: {
          action_id: actionId,
          action: call.toolName,
          result: result.length > 500 ? `${result.slice(0, 497)}...` : result,
          duration_ms: Date.now() - started,
          success,
          iteration,
        },
      });
      turn.push({
        role: "tool",
        content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: result } }],
      });
      const stat = STAT_FOR_TOOL[call.toolName];
      if (stat) stats[stat] += 1;
    }

    const full = [...prior, ...turn];
    messages = (iteration + 1) % COMPACT_EVERY === 0 ? [...full.slice(0, 2), user(progressSummary(stats, iteration + 1)), ...turn] : full;
  }
  log.warn(`Retrospector: reached ${MAX_ITERATIONS} iterations, stopping this run`);
  return "";
}

function progressSummary(stats: Stats, iteration: number): string {
  return `## Progress so far (iteration ${iteration})

To keep context small, earlier tool calls and their results have been
compacted out of this conversation. Cumulative progress across the whole
run: ${stats.nodes_processed} marked processed, ${stats.nodes_updated} updated, ${stats.links_created} links created, ${stats.insights_created} new nodes created, ${stats.nodes_deleted} deleted, ${stats.links_deleted} links deleted.

Keep working through the slipbox and review nodes listed above that you
haven't handled yet. If you're unsure whether a specific node was already
handled, use get_node or search to check its current state rather than
relying on memory of earlier tool calls.
`;
}

function definitions(): ToolSet {
  const id = z.string().describe("Node UUID");
  return {
    search: tool({
      description:
        "Search the knowledge graph for related nodes. Uses semantic similarity and keyword matching. Optionally scope to one project — useful when working through a cluster of project-tagged nodes to find its in-project connections.",
      inputSchema: z.object({
        query: z.string().describe("Search query text"),
        limit: z.number().int().optional().describe("Maximum results to return (default: 5)"),
        project: z.string().optional().describe("Project name or slug to scope results to (see list_projects)"),
      }),
    }),
    list_projects: tool({
      description:
        "List all known projects (name + slug). Use to confirm a project's exact name before scoping search to it or tagging a node with it.",
      inputSchema: z.object({}),
    }),
    get_node: tool({ description: "Fetch a specific node by its ID to see its full content.", inputSchema: z.object({ id }) }),
    find_similar: tool({
      description:
        "Find the nodes most semantically similar to a given node (by embedding distance). The primary tool for spotting near-duplicates and link candidates — more precise than text search when you already have a node in hand.",
      inputSchema: z.object({
        id: z.string().describe("Node UUID to find similar nodes for"),
        limit: z.number().int().optional().describe("Maximum results (default: 5)"),
      }),
    }),
    create_node: tool({
      description:
        "Create a new node in the knowledge graph. Returns the new node's ID. New nodes are created as already processed (they're derived insights, not raw observations). Tag it with `project` when it's a project-specific insight or structure/hub note for that project.",
      inputSchema: z.object({
        content: z.string().describe("The atomic idea or fact (1-2 sentences)"),
        project: z
          .string()
          .optional()
          .describe(
            "Project name or slug this node belongs to, if project-specific (see list_projects). Omit for general/cross-project nodes.",
          ),
      }),
    }),
    update_node: tool({
      description:
        "Update a node's content. Use this to consolidate duplicates: merge info into one node and delete the other. Re-embeds automatically. Preserves the node's ID, links, and provenance. Can also set/correct which project the node belongs to.",
      inputSchema: z.object({
        id: z.string().describe("Node UUID to update"),
        content: z.string().describe("The new content for the node (1-2 sentences)"),
        project: z
          .string()
          .optional()
          .describe(
            "Set/correct this node's project (name or slug, see list_projects). Omit to leave its current project attribution unchanged.",
          ),
      }),
    }),
    create_link: tool({
      description: "Create an undirected link between two nodes. Always provide context explaining why the link exists.",
      inputSchema: z.object({
        node_a_id: z.string().describe("First node UUID"),
        node_b_id: z.string().describe("Second node UUID"),
        context: z.string().optional().describe("Why this link exists - what should someone expect when following it?"),
      }),
    }),
    mark_processed: tool({
      description: "Mark a slipbox node as processed (integrated into the graph). Call this when you're done working with a node.",
      inputSchema: z.object({ id: z.string().describe("Node UUID to mark as processed") }),
    }),
    delete_node: tool({
      description:
        "Delete a node from the knowledge graph. Use this to remove duplicates. All links to/from this node are automatically deleted.",
      inputSchema: z.object({ id: z.string().describe("Node UUID to delete") }),
    }),
    delete_link: tool({
      description: "Delete a link between two nodes.",
      inputSchema: z.object({
        node_a_id: z.string().describe("First node UUID"),
        node_b_id: z.string().describe("Second node UUID"),
      }),
    }),
    list_links: tool({
      description: "List all nodes directly linked to a given node. Use this to explore the graph structure and follow connections.",
      inputSchema: z.object({ id: z.string().describe("Node UUID to get links for") }),
    }),
    graph_stats: tool({
      description:
        "Get graph health statistics: total nodes, total links, slipbox count, orphan count (0 links), weakly connected count (1 link), and link-to-note ratio. Call this at the start of each session to understand graph health and prioritize work.",
      inputSchema: z.object({}),
    }),
    web_search: tool({
      description:
        "Search the web for current information. Use this when you need up-to-date facts, news, documentation, or anything not in your notes.",
      inputSchema: z.object({ query: z.string().describe("Search query - what to look up on the web") }),
    }),
  };
}

const unknownProject = (name: string) => `Nie znalazłem projektu "${name}" — sprawdź listę przez list_projects.`;
const soulMessage = (id: string) => `Node ${id} is a soul — it can't be rewritten or deleted here. Link to it instead.`;
const foreignScopeMessage = (id: string) =>
  `Node ${id} belongs to a different access scope than this run — you can link to it, but only edit or delete nodes from this scope. If a node from this scope duplicates it, delete that copy instead: everyone who sees this scope can already see ${id}.`;

async function resolveProjectId(name: string | undefined): Promise<{ ok: true; id: string | null } | { ok: false }> {
  if (name === undefined || name === null) return { ok: true, id: null };
  const project = await findProject(name);
  return project ? { ok: true, id: project.id } : { ok: false };
}

export async function webSearchText(query: string): Promise<string> {
  try {
    return await braveSearch(query);
  } catch (error) {
    if (error instanceof BraveSearchError && error.reason === "api_key_not_configured") {
      return "Web search is not configured (missing API key).";
    }
    if (error instanceof BraveSearchError && error.reason === "rate_limited") {
      return "Web search rate limited. Try again in a moment.";
    }
    return `Web search failed: ${(error as Error).message}`;
  }
}

type Handler = (args: Record<string, any>) => Promise<string>;

async function toolHandlers(userId: string, readableLevels: string[], writeAccess: string[]): Promise<Record<string, Handler>> {
  const createUserId = await systemUserId("system:retrospector", "Retrospector", "retrospector@system.manfrod");

  const notEditable = async (id: string): Promise<string | null> => {
    const node = await getNodeAccessible(readableLevels, id);
    if (!node) return `Node not found: ${id}`;
    return sameLevels(node.access, writeAccess) ? null : foreignScopeMessage(id);
  };

  return {
    async search(args) {
      const project = await resolveProjectId(args.project);
      if (!project.ok) return unknownProject(args.project);
      const found = await memorySearch(userId, readableLevels, args.query, { limit: args.limit ?? 5, projectId: project.id });
      if (found.length === 0) return "No matching nodes found.";
      return `Found ${found.length} nodes:\n${found.map((node) => `- [${node.id}] ${node.content}`).join("\n")}`;
    },
    async list_projects() {
      const projects = await listProjects();
      if (projects.length === 0) return "No projects configured.";
      return `Projects:\n${projects.map((project) => `- ${project.name} (slug: ${project.slug})`).join("\n")}`;
    },
    async get_node(args) {
      const node = await getNodeAccessible(readableLevels, args.id);
      if (!node) return `Node not found: ${args.id}`;
      return `Node ${args.id}:\nContent: ${node.content}\nProcessed: ${node.processedAt ? "yes" : "no (in slipbox)"}`;
    },
    async find_similar(args) {
      const node = await getNodeAccessible(readableLevels, args.id);
      if (!node) return `Node not found: ${args.id}`;
      const results = await similarNodes(node, readableLevels, { limit: args.limit ?? 5 });
      if (results.length === 0) return `No similar nodes found for ${args.id}.`;
      const lines = results.map(
        ({ node: other, distance }) => `- [${other.id}] (similarity ${Math.round((1 - distance) * 100) / 100}) ${other.content}`,
      );
      return `Nodes most similar to [${args.id}]:\n${lines.join("\n")}`;
    },
    async create_node(args) {
      const project = await resolveProjectId(args.project);
      if (!project.ok) return unknownProject(args.project);
      let embedding: number[];
      try {
        embedding = await embedQuery(args.content);
      } catch (error) {
        return `Failed to generate embedding: ${(error as Error).message}`;
      }
      try {
        const node = await createNode(createUserId, writeAccess, {
          content: args.content,
          embedding,
          processedAt: new Date(Math.floor(Date.now() / 1000) * 1000),
          projectId: project.id,
        });
        return `Created node: ${node.id}`;
      } catch (error) {
        return `Failed to create node: ${(error as Error).message}`;
      }
    },
    async update_node(args) {
      if (await isSoul(args.id)) return soulMessage(args.id);
      const refusal = await notEditable(args.id);
      if (refusal) return refusal;
      const project = await resolveProjectId(args.project);
      if (!project.ok) return unknownProject(args.project);
      let embedding: number[];
      try {
        embedding = await embedQuery(args.content);
      } catch (error) {
        return `Failed to generate embedding: ${(error as Error).message}`;
      }
      const attrs =
        args.project !== undefined ? { content: args.content, embedding, projectId: project.id } : { content: args.content, embedding };
      try {
        const node = await updateNodeAccessible(readableLevels, args.id, attrs);
        return node ? `Updated node: ${args.id}` : `Node not found: ${args.id}`;
      } catch (error) {
        return `Failed to update node: ${(error as Error).message}`;
      }
    },
    async create_link(args) {
      const [a, b] = await Promise.all([
        getNodeAccessible(readableLevels, args.node_a_id),
        getNodeAccessible(readableLevels, args.node_b_id),
      ]);
      if (!a || !b) return `Node not found: ${!a ? args.node_a_id : args.node_b_id}`;
      const result = await createLink(userId, a.id, b.id, args.context ? { context: args.context } : {});
      return result.ok ? `Linked ${args.node_a_id} <-> ${args.node_b_id}` : `Failed to create link: ${result.error}`;
    },
    async mark_processed(args) {
      const refusal = await notEditable(args.id);
      if (refusal) return refusal;
      return (await markProcessedAccessible(readableLevels, args.id)) ? `Marked ${args.id} as processed` : `Node not found: ${args.id}`;
    },
    async delete_node(args) {
      if (await isSoul(args.id)) return soulMessage(args.id);
      const refusal = await notEditable(args.id);
      if (refusal) return refusal;
      const result = await deleteNodeAccessible(readableLevels, args.id);
      if (result.ok) return `Deleted node: ${args.id}`;
      return result.error === "soul" ? soulMessage(args.id) : `Node not found: ${args.id}`;
    },
    async delete_link(args) {
      const link = await deleteLinkAccessible(readableLevels, args.node_a_id, args.node_b_id);
      return link ? `Deleted link: ${args.node_a_id} <-> ${args.node_b_id}` : `Link not found: ${args.node_a_id} <-> ${args.node_b_id}`;
    },
    async list_links(args) {
      const linked = await getNodeLinksWithContextAccessible(readableLevels, args.id);
      if (linked.length === 0) return `Node ${args.id} has no links (orphan).`;
      const lines = linked.map(({ node, context }) => {
        const line = `- [${node.id}] ${node.content}`;
        return context ? `${line}\n  Context: ${context}` : line;
      });
      return `Node ${args.id} is linked to ${linked.length} nodes:\n${lines.join("\n")}`;
    },
    async graph_stats() {
      const stats = await graphStatsByAccess(writeAccess);
      return `Graph Health:
- Total nodes: ${stats.total_nodes}
- Total links: ${stats.total_links}
- Slipbox (unprocessed): ${stats.slipbox_count}
- Orphans (0 links): ${stats.orphan_count}
- Weakly connected (1 link): ${stats.weakly_connected_count}
- Link-to-note ratio: ${stats.link_to_note_ratio}`;
    },
    async web_search(args) {
      return webSearchText(args.query);
    },
  };
}
