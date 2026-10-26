import { eq } from "drizzle-orm";
import { db, tables } from "./db/index.ts";
import { deleteBranch, getPull } from "./github.ts";
import { logger } from "./log.ts";
import { killSessionSandboxes, killStaleSandboxes } from "./sandboxes.ts";

const { selfModifyPulls } = tables;
const STALE_SANDBOX_DAYS = 2;

const log = logger("SelfModify.Cleanup");

export async function recordPull(pullNumber: number, branch: string, sessionId: string): Promise<void> {
  await db
    .insert(selfModifyPulls)
    .values({ pullNumber, branch, sessionId })
    .onConflictDoUpdate({
      target: selfModifyPulls.pullNumber,
      set: { branch, sessionId, status: "open", closedAt: null },
    });
}

export async function cleanUpPull(pullNumber: number): Promise<boolean> {
  const [row] = await db.select().from(selfModifyPulls).where(eq(selfModifyPulls.pullNumber, pullNumber)).limit(1);
  if (!row) return false;
  await killSessionSandboxes(row.sessionId);
  await deleteBranch(row.branch);
  await db.update(selfModifyPulls).set({ status: "closed", closedAt: new Date() }).where(eq(selfModifyPulls.pullNumber, pullNumber));
  return true;
}

export async function cleanUpClosedPulls(): Promise<{ closed: number[]; staleSandboxes: number }> {
  const open = await db.select().from(selfModifyPulls).where(eq(selfModifyPulls.status, "open"));
  const closed: number[] = [];
  const stillOpen: string[] = [];
  for (const row of open) {
    try {
      const pull = await getPull(row.pullNumber);
      if (pull && pull.state !== "closed") {
        stillOpen.push(row.sessionId);
        continue;
      }
      await cleanUpPull(row.pullNumber);
      closed.push(row.pullNumber);
    } catch (error) {
      stillOpen.push(row.sessionId);
      log.error(`SelfModify.Cleanup: failed for #${row.pullNumber}: ${(error as Error).message}`);
    }
  }
  const staleSandboxes = await killStaleSandboxes(new Date(Date.now() - STALE_SANDBOX_DAYS * 86_400_000), stillOpen);
  if (closed.length > 0 || staleSandboxes > 0) {
    log.info(`SelfModify.Cleanup: cleaned up ${closed.length} closed pull request(s) and ${staleSandboxes} stale sandbox(es)`);
  }
  return { closed, staleSandboxes };
}
