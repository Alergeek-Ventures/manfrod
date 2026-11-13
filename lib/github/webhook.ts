import { EVENTS, sendEvent } from "../inngest/client.ts";
import { logger } from "../log.ts";
import {
  type CommitInput,
  deleteInstallation,
  type InstallationInput,
  listInstallations,
  removeRepositories,
  type RepositoryInput,
  setInstallationSuspended,
  storeCommits,
  upsertInstallation,
  upsertRepositories,
} from "./store.ts";
import { syncInstallation } from "./sync.ts";

const log = logger("Github.Webhook");
const ZERO_SHA = /^0+$/;
export const PUSH_COMMIT_LIMIT = 2048;

export interface PushPayload {
  ref: string;
  before: string;
  after: string;
  deleted?: boolean;
  installation?: { id: number };
  repository: RepositoryInput;
  commits?: {
    id: string;
    message: string;
    timestamp: string;
    url: string;
    author?: { name?: string; email?: string; username?: string };
  }[];
}

export function pushBranch(ref: string): string | null {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
}

export function pushCommits(payload: PushPayload): CommitInput[] {
  return (payload.commits ?? []).map((commit) => ({
    sha: commit.id,
    authorLogin: commit.author?.username ?? null,
    authorEmail: commit.author?.email?.toLowerCase() ?? null,
    authorName: commit.author?.name ?? null,
    authoredAt: new Date(commit.timestamp),
    message: commit.message,
    url: commit.url,
  }));
}

export function isTruncatedPush(payload: PushPayload): boolean {
  return (payload.commits?.length ?? 0) >= PUSH_COMMIT_LIMIT && !ZERO_SHA.test(payload.before);
}

async function ensureInstallation(installationId: number): Promise<void> {
  if ((await listInstallations()).some((installation) => installation.id === installationId)) return;
  await syncInstallation(installationId);
}

async function handlePush(payload: PushPayload): Promise<void> {
  const branch = pushBranch(payload.ref);
  const installationId = payload.installation?.id;
  if (!branch || payload.deleted || !installationId) return;
  await ensureInstallation(installationId);
  await upsertRepositories(installationId, [payload.repository]);
  await storeCommits(payload.repository.id, branch, pushCommits(payload));
  if (isTruncatedPush(payload)) {
    await sendEvent(EVENTS.githubPushTruncated, {
      installationId,
      repositoryId: payload.repository.id,
      fullName: payload.repository.full_name,
      branch,
      before: payload.before,
      after: payload.after,
    });
  }
}

export async function handleWebhook(event: string, payload: any): Promise<void> {
  const installationId: number | undefined = payload?.installation?.id;
  switch (event) {
    case "installation": {
      const installation = payload.installation as InstallationInput;
      if (payload.action === "deleted") return deleteInstallation(installation.id);
      if (payload.action === "suspend" || payload.action === "unsuspend") {
        return setInstallationSuspended(installation.id, payload.action === "suspend");
      }
      await upsertInstallation(installation);
      if (Array.isArray(payload.repositories)) await upsertRepositories(installation.id, payload.repositories);
      await sendEvent(EVENTS.githubInstallationChanged, { installationId: installation.id });
      return;
    }
    case "installation_repositories": {
      if (!installationId) return;
      await upsertInstallation(payload.installation);
      await upsertRepositories(installationId, payload.repositories_added ?? []);
      await removeRepositories((payload.repositories_removed ?? []).map((repository: RepositoryInput) => repository.id));
      await sendEvent(EVENTS.githubInstallationChanged, { installationId });
      return;
    }
    case "repository": {
      if (!installationId) return;
      if (payload.action === "deleted" || payload.action === "transferred") return removeRepositories([payload.repository.id]);
      await ensureInstallation(installationId);
      await upsertRepositories(installationId, [payload.repository]);
      return;
    }
    case "push":
      return handlePush(payload as PushPayload);
    default:
      log.debug(`Github.Webhook: ignoring ${event}${payload?.action ? `.${payload.action}` : ""}`);
  }
}
