import { createHash } from "node:crypto";
import { Sandbox } from "e2b";

export const METADATA_KEY = "eveSandbox";

export const sandboxKey = (sessionId: string) => createHash("sha256").update(`manfrod:${sessionId}`).digest("hex").slice(0, 32);

async function listSandboxes(metadata?: Record<string, string>) {
  const paginator = Sandbox.list({ query: { state: ["running", "paused"], ...(metadata ? { metadata } : {}) } });
  const found = [];
  while (paginator.hasNext) found.push(...(await paginator.nextItems()));
  return found;
}

export async function killSessionSandboxes(sessionId: string): Promise<number> {
  const found = await listSandboxes({ [METADATA_KEY]: sandboxKey(sessionId) });
  await Promise.all(found.map((sandbox) => Sandbox.kill(sandbox.sandboxId)));
  return found.length;
}

export async function killStaleSandboxes(startedBefore: Date, keepSessionIds: string[]): Promise<number> {
  const keep = new Set(keepSessionIds.map(sandboxKey));
  const stale = (await listSandboxes()).filter((sandbox) => {
    const key = sandbox.metadata?.[METADATA_KEY];
    return key !== undefined && !keep.has(key) && sandbox.state === "paused" && sandbox.startedAt < startedBefore;
  });
  await Promise.all(stale.map((sandbox) => Sandbox.kill(sandbox.sandboxId)));
  return stale.length;
}
