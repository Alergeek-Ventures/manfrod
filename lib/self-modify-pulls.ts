import { eq } from "drizzle-orm";
import { db, tables } from "./db/index.ts";
import { deleteBranch, getPull, openPulls, type OpenPull } from "./github.ts";
import { logger } from "./log.ts";
import { killSessionSandboxes, killStaleSandboxes } from "./sandboxes.ts";

const { selfModifyPulls } = tables;
const STALE_SANDBOX_DAYS = 2;
const SUMMARY_CHARS = 400;

export const SELF_MODIFY_BRANCH_PREFIX = "manfrod/self-modify/";
export const PROPOSAL_FOOTER = "\n\n---\nProposed by Manfrod's self-modify agent";

const log = logger("SelfModify.Cleanup");

export const isProposal = (pull: Pick<OpenPull, "branch">) => pull.branch.startsWith(SELF_MODIFY_BRANCH_PREFIX);

export async function openProposals(): Promise<OpenPull[]> {
  return (await openPulls()).filter(isProposal);
}

export function describeProposals(pulls: OpenPull[]): string {
  return pulls
    .map((pull) => {
      const summary = pull.body.split(PROPOSAL_FOOTER)[0].replace(/\s+/g, " ").trim();
      const clipped = summary.length > SUMMARY_CHARS ? `${summary.slice(0, SUMMARY_CHARS)}…` : summary;
      return `- #${pull.number} ${pull.title} (${pull.draft ? "draft" : "ready for review"}, ${pull.url})${clipped ? `: ${clipped}` : ""}`;
    })
    .join("\n");
}

export type CapabilityGate = { ok: true; extend: OpenPull | null } | { ok: false; message: string };

export function capabilityGate(pulls: OpenPull[], extendPull: number | undefined, checked: boolean): CapabilityGate {
  if (extendPull !== undefined) {
    const pull = pulls.find((candidate) => candidate.number === extendPull);
    if (pull) return { ok: true, extend: pull };
    const open = pulls.length > 0 ? `Open ones:\n${describeProposals(pulls)}` : "There are none open.";
    return { ok: false, message: `#${extendPull} is not an open self-modify pull request. ${open}` };
  }
  if (pulls.length === 0 || checked) return { ok: true, extend: null };
  return {
    ok: false,
    message: `Nothing was posted yet. These self-modify pull requests are still open:\n${describeProposals(pulls)}\n\nIf one of them already adds what you need, don't request it again: tell the person, with its link, that it works once it is merged and deployed. If one covers part of it, call request-capability again with extend_pull set to its number. If none is about this, call it again with checked_open_pulls set to true.`,
  };
}

export async function recordPull(pullNumber: number, branch: string, sessionId: string): Promise<void> {
  const [previous] = await db.select().from(selfModifyPulls).where(eq(selfModifyPulls.pullNumber, pullNumber)).limit(1);
  if (previous && previous.sessionId !== sessionId) {
    try {
      await killSessionSandboxes(previous.sessionId);
    } catch (error) {
      log.error(`SelfModify.Cleanup: could not stop the earlier sandbox of #${pullNumber}: ${(error as Error).message}`);
    }
  }
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
