import { and, asc, eq, isNull } from "drizzle-orm";
import { db, tables } from "./db/index.ts";
import type { Account, User } from "./db/schema.ts";

const { users, account } = tables;

export async function getUser(id: string): Promise<User | null> {
  if (!isUuid(id)) return null;
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user ?? null;
}

export async function getUserOrThrow(id: string): Promise<User> {
  const user = await getUser(id);
  if (!user) throw new Error(`user ${id} not found`);
  return user;
}

export async function getUserBySlackId(slackId: string | null | undefined): Promise<User | null> {
  if (!slackId) return null;
  const [user] = await db.select().from(users).where(eq(users.slackId, slackId)).limit(1);
  return user ?? null;
}

export async function getUserByEmail(email: string | null | undefined): Promise<User | null> {
  if (!email) return null;
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return user ?? null;
}

export async function listUsers(): Promise<User[]> {
  return db.select().from(users).orderBy(asc(users.insertedAt));
}

export const isAdmin = (user: Pick<User, "isAdmin"> | null | undefined) => user?.isAdmin === true;

export async function setAdmin(userId: string, admin: boolean): Promise<boolean> {
  const updated = await db.update(users).set({ isAdmin: admin }).where(eq(users.id, userId)).returning({ id: users.id });
  return updated.length > 0;
}

export function isSystemUser(user: Pick<User, "slackId">): boolean {
  return user.slackId.startsWith("system:");
}

export async function findOrCreateBySlackId(
  slackId: string,
  slackDmChannelId: string,
  name: string | null = null,
  email: string | null = null,
): Promise<User> {
  const existing = await getUserBySlackId(slackId);

  if (!existing) {
    const [created] = await db
      .insert(users)
      .values({ slackId, slackDmChannelId, name, ...(email ? { email } : {}) })
      .onConflictDoNothing()
      .returning();
    return created ?? (await getUserBySlackId(slackId))!;
  }

  const changes: Partial<User> = {};
  if (name && name !== existing.name) changes.name = name;
  if (email && existing.email === null) changes.email = email;

  if (Object.keys(changes).length === 0) return existing;

  const [updated] = await db.update(users).set(changes).where(eq(users.id, existing.id)).returning();
  return updated;
}

export async function systemUserId(slackId: string, name: string, email: string): Promise<string> {
  const existing = await getUserBySlackId(slackId);
  if (existing) return existing.id;
  const [created] = await db.insert(users).values({ slackId, slackDmChannelId: slackId, name, email }).onConflictDoNothing().returning();
  return created?.id ?? (await getUserBySlackId(slackId))!.id;
}

export async function getGoogleAccount(userId: string): Promise<Account | null> {
  const [row] = await db
    .select()
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "google")))
    .limit(1);
  return row ?? null;
}

export async function backfillNamesFromSlack(fetchName: (slackId: string) => Promise<string | null>) {
  const nameless = await db.select().from(users).where(isNull(users.name));
  for (const user of nameless) {
    const name = await fetchName(user.slackId);
    if (name) await db.update(users).set({ name }).where(eq(users.id, user.id));
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
