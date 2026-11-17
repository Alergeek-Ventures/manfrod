import { asc, eq } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { User } from "../db/schema.ts";
import { getLayout } from "./layout.ts";

const { officeMembers, users } = tables;

export async function listOfficeMembers(): Promise<User[]> {
  const layout = await getLayout();
  const rows = await db
    .select({ user: users })
    .from(officeMembers)
    .innerJoin(users, eq(users.id, officeMembers.userId))
    .where(eq(officeMembers.layoutId, layout.id))
    .orderBy(asc(users.name));
  return rows.map((row) => row.user);
}

export async function addOfficeMember(userId: string): Promise<void> {
  const layout = await getLayout();
  await db
    .insert(officeMembers)
    .values({ userId, layoutId: layout.id })
    .onConflictDoUpdate({ target: officeMembers.userId, set: { layoutId: layout.id } });
}

export async function removeOfficeMember(userId: string): Promise<boolean> {
  const result = await db.delete(officeMembers).where(eq(officeMembers.userId, userId));
  return (result.rowCount ?? 0) > 0;
}
