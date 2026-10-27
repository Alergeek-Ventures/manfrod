import { and, asc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { isAdmin, systemUserId } from "../accounts.ts";
import { db, tables } from "../db/index.ts";
import type { MessageFeedback, SelfReviewCase, SelfReviewFinding, User } from "../db/schema.ts";
import { ACTIVE_STATUSES, SELF_REVIEW_SLACK_ID, type Category, type Rater } from "./rules.ts";

const { messageFeedback, selfReviewCases, selfReviewFindings, users } = tables;

export type FindingStatus = "open" | "in_progress" | "proposed" | "merged" | "closed" | "unresolved" | "dismissed";
export type CaseStatus = "linked" | "not_actionable" | "needs_input" | "asked" | "expired";

export interface NewFinding {
  title: string;
  problem: string;
  expected: string;
  summary: string | null;
  category: Category;
  severity: number;
}

export interface CaseWithFeedback {
  case: SelfReviewCase;
  feedback: MessageFeedback;
  user: User | null;
}

export function selfReviewUserId(): Promise<string> {
  return systemUserId(SELF_REVIEW_SLACK_ID, "Self Review", "self-review@system.manfrod");
}

export async function unreviewedFeedback(limit: number, excludeChannelId: string | null, since: Date): Promise<MessageFeedback[]> {
  return db
    .select({ feedback: messageFeedback })
    .from(messageFeedback)
    .leftJoin(selfReviewCases, eq(selfReviewCases.feedbackId, messageFeedback.id))
    .where(
      and(
        eq(messageFeedback.rating, "bad"),
        isNull(selfReviewCases.id),
        gte(messageFeedback.insertedAt, since),
        excludeChannelId ? ne(messageFeedback.slackChannelId, excludeChannelId) : undefined,
      ),
    )
    .orderBy(asc(messageFeedback.insertedAt))
    .limit(limit)
    .then((rows) => rows.map((row) => row.feedback));
}

export async function insertCase(
  feedbackId: string,
  attrs: { status: CaseStatus; findingId?: string | null; reason?: string | null; question?: string | null },
): Promise<void> {
  await db
    .insert(selfReviewCases)
    .values({ feedbackId, ...attrs })
    .onConflictDoNothing();
}

export async function updateCase(
  id: string,
  attrs: Partial<
    Pick<SelfReviewCase, "status" | "findingId" | "reason" | "question" | "clarificationChannelId" | "clarificationThreadTs" | "askedAt">
  >,
): Promise<void> {
  await db.update(selfReviewCases).set(attrs).where(eq(selfReviewCases.id, id));
}

export async function casesWithStatus(status: CaseStatus): Promise<CaseWithFeedback[]> {
  const rows = await db
    .select({ case: selfReviewCases, feedback: messageFeedback, user: users })
    .from(selfReviewCases)
    .innerJoin(messageFeedback, eq(messageFeedback.id, selfReviewCases.feedbackId))
    .leftJoin(users, eq(users.id, messageFeedback.userId))
    .where(eq(selfReviewCases.status, status))
    .orderBy(asc(selfReviewCases.insertedAt));
  return rows;
}

export async function linkedCases(findingIds: string[]): Promise<CaseWithFeedback[]> {
  if (findingIds.length === 0) return [];
  return db
    .select({ case: selfReviewCases, feedback: messageFeedback, user: users })
    .from(selfReviewCases)
    .innerJoin(messageFeedback, eq(messageFeedback.id, selfReviewCases.feedbackId))
    .leftJoin(users, eq(users.id, messageFeedback.userId))
    .where(and(eq(selfReviewCases.status, "linked"), inArray(selfReviewCases.findingId, findingIds)))
    .orderBy(asc(messageFeedback.insertedAt));
}

export function ratersOf(cases: CaseWithFeedback[]): Rater[] {
  return cases.map((row) => ({ slackUserId: row.feedback.slackUserId, admin: isAdmin(row.user) }));
}

export async function createFinding(attrs: NewFinding): Promise<SelfReviewFinding> {
  const [finding] = await db.insert(selfReviewFindings).values(attrs).returning();
  return finding;
}

export async function getFinding(id: string): Promise<SelfReviewFinding | null> {
  const [finding] = await db.select().from(selfReviewFindings).where(eq(selfReviewFindings.id, id)).limit(1);
  return finding ?? null;
}

export async function findingsWithStatus(statuses: FindingStatus[]): Promise<SelfReviewFinding[]> {
  return db
    .select()
    .from(selfReviewFindings)
    .where(inArray(selfReviewFindings.status, statuses))
    .orderBy(asc(selfReviewFindings.insertedAt));
}

export async function countActive(exceptId: string | null = null): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(selfReviewFindings)
    .where(and(inArray(selfReviewFindings.status, [...ACTIVE_STATUSES]), exceptId ? ne(selfReviewFindings.id, exceptId) : undefined));
  return Number(row?.count ?? 0);
}

export async function markStarted(id: string, channelId: string, threadTs: string): Promise<void> {
  await db
    .update(selfReviewFindings)
    .set({ status: "in_progress", sessionChannelId: channelId, sessionThreadTs: threadTs, startedAt: new Date() })
    .where(eq(selfReviewFindings.id, id));
}

export async function attachPull(id: string, pullNumber: number, pullUrl: string): Promise<void> {
  await db.update(selfReviewFindings).set({ status: "proposed", pullNumber, pullUrl }).where(eq(selfReviewFindings.id, id));
}

export async function resolveFinding(id: string, status: Extract<FindingStatus, "merged" | "closed" | "unresolved" | "dismissed">) {
  await db.update(selfReviewFindings).set({ status, resolvedAt: new Date() }).where(eq(selfReviewFindings.id, id));
}

export async function markNotified(id: string): Promise<void> {
  await db.update(selfReviewFindings).set({ notifiedAt: new Date() }).where(eq(selfReviewFindings.id, id));
}

export async function staleInProgress(olderThan: Date): Promise<SelfReviewFinding[]> {
  return db
    .select()
    .from(selfReviewFindings)
    .where(
      and(eq(selfReviewFindings.status, "in_progress"), isNull(selfReviewFindings.pullNumber), lt(selfReviewFindings.startedAt, olderThan)),
    );
}

export async function mergedUnnotified(): Promise<SelfReviewFinding[]> {
  return db
    .select()
    .from(selfReviewFindings)
    .where(and(eq(selfReviewFindings.status, "merged"), isNull(selfReviewFindings.notifiedAt)));
}
