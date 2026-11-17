import { eq } from "drizzle-orm";
import { db, tables } from "../db/index.ts";

const { agentSettings } = tables;
const KEY = "self_modify.auto_merge";

export const isEnabledValue = (value: string | null | undefined) => value !== "off";

export async function autoMergeEnabled(): Promise<boolean> {
  const [row] = await db.select().from(agentSettings).where(eq(agentSettings.key, KEY)).limit(1);
  return isEnabledValue(row?.value);
}

export async function setAutoMerge(enabled: boolean, userId: string | null): Promise<void> {
  const value = enabled ? "on" : "off";
  await db
    .insert(agentSettings)
    .values({ key: KEY, value, updatedByUserId: userId })
    .onConflictDoUpdate({ target: agentSettings.key, set: { value, updatedByUserId: userId, updatedAt: new Date() } });
}
