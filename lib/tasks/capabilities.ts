import { and, eq, lt } from "drizzle-orm";
import { getUser, getUserBySlackId, isAdmin, isUuid } from "../accounts.ts";
import { TASK_KIND } from "../agent/context.ts";
import { config } from "../config.ts";
import { db, tables } from "../db/index.ts";
import type { AgentTask, CapabilityRequest, User } from "../db/schema.ts";
import { getPull } from "../github.ts";
import { EVENTS, sendEvent } from "../inngest/client.ts";
import { agentRuntime } from "../inngest/runtime.ts";
import { logger } from "../log.ts";
import { resolveAccess } from "../memory/access.ts";
import { userAuth } from "../proactive.ts";
import { post, type SlackBody } from "../slack/api.ts";
import { blockTask, getTask, resumeTask } from "./index.ts";

const { capabilityRequests } = tables;
const log = logger("Tasks.Capabilities");

export const CAPABILITY_APPROVE_ACTION_ID = "capability_approve";
export const CAPABILITY_REJECT_ACTION_ID = "capability_reject";

const DEPLOY_DELAY_MINUTES = 20;
const BUILD_TIMEOUT_HOURS = 12;
const DECISION_TIMEOUT_DAYS = 3;

const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000);

async function getRequest(id: string): Promise<CapabilityRequest | null> {
  if (!isUuid(id)) return null;
  const [request] = await db.select().from(capabilityRequests).where(eq(capabilityRequests.id, id)).limit(1);
  return request ?? null;
}

async function setStatus(id: string, status: CapabilityRequest["status"], extra: Partial<CapabilityRequest> = {}) {
  await db
    .update(capabilityRequests)
    .set({ status, ...extra, updatedAt: new Date() })
    .where(eq(capabilityRequests.id, id));
}

async function approvalPlace(
  requester: User,
  channelId: string,
  threadTs: string,
): Promise<{ channel: string; threadTs: string | null } | null> {
  if (!channelId.startsWith("D") || isAdmin(requester)) return { channel: channelId, threadTs };
  const adminChannel = config.selfReviewChannelId;
  return adminChannel ? { channel: adminChannel, threadTs: null } : null;
}

export async function requestCapability(input: {
  requester: User;
  task: AgentTask | null;
  title: string;
  description: string;
  reason: string;
  message: string;
  approveLabel: string;
  rejectLabel: string;
  channelId: string;
  threadTs: string;
}): Promise<{ ok: true; request: CapabilityRequest; elsewhere: boolean } | { ok: false; error: string }> {
  const place = await approvalPlace(input.requester, input.channelId, input.threadTs);
  if (!place) return { ok: false, error: "This conversation has no admin to approve it and no admin channel is configured." };
  const [request] = await db
    .insert(capabilityRequests)
    .values({
      taskId: input.task?.id ?? null,
      requestedByUserId: input.requester.id,
      title: input.title,
      description: input.description,
      reason: input.reason,
      channelId: place.channel,
      threadTs: place.threadTs ?? "",
    })
    .returning();
  const sent = await post("chat.postMessage", {
    channel: place.channel,
    ...(place.threadTs ? { thread_ts: place.threadTs } : {}),
    text: input.message,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: input.message } },
      { type: "context", elements: [{ type: "mrkdwn", text: `*${input.title}*\n${input.description}`.slice(0, 2900) }] },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: CAPABILITY_APPROVE_ACTION_ID,
            style: "primary",
            value: request.id,
            text: { type: "plain_text", text: input.approveLabel },
          },
          {
            type: "button",
            action_id: CAPABILITY_REJECT_ACTION_ID,
            style: "danger",
            value: request.id,
            text: { type: "plain_text", text: input.rejectLabel },
          },
        ],
      },
    ],
  });
  if (!sent.ok) {
    await setStatus(request.id, "closed");
    return { ok: false, error: sent.error };
  }
  const messageTs = sent.body.ts as string;
  const threadTs = place.threadTs ?? messageTs;
  await setStatus(request.id, "pending", { messageTs, threadTs });
  if (input.task) await blockTask(input.task, `Waiting for an admin to approve a new capability: ${input.title}`);
  return { ok: true, request: { ...request, messageTs, threadTs }, elsewhere: place.channel !== input.channelId };
}

function ephemeral(payload: Record<string, any>, text: string) {
  const channel = payload.channel?.id;
  const user = payload.user?.id;
  if (!channel || !user) return;
  const threadTs = payload.message?.thread_ts ?? payload.container?.thread_ts;
  return post("chat.postEphemeral", { channel, user, text, ...(threadTs ? { thread_ts: threadTs } : {}) });
}

function decidedBlocks(payload: Record<string, any>, note: string): SlackBody[] {
  const blocks = ((payload.message?.blocks ?? []) as SlackBody[]).filter((block) => block.type !== "actions");
  return [...blocks, { type: "context", elements: [{ type: "mrkdwn", text: note }] }];
}

export async function handleCapabilityDecision(payload: Record<string, any>, approve: boolean): Promise<void> {
  const requestId = String(payload.actions?.[0]?.value ?? "");
  const actor = await getUserBySlackId(payload.user?.id);
  if (!actor || !isAdmin(actor)) {
    await ephemeral(payload, "Tylko admin może zdecydować, czy Manfrod ma dostać nową umiejętność.");
    return;
  }
  const [request] = await db
    .update(capabilityRequests)
    .set({ status: approve ? "approved" : "rejected", decidedByUserId: actor.id, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(capabilityRequests.id, requestId), eq(capabilityRequests.status, "pending")))
    .returning();
  if (!request) {
    await ephemeral(payload, "Ta prośba została już rozpatrzona.");
    return;
  }
  if (payload.channel?.id && payload.message?.ts) {
    const note = approve ? `:white_check_mark: Zatwierdzone przez <@${actor.slackId}>` : `:x: Odrzucone przez <@${actor.slackId}>`;
    await post("chat.update", {
      channel: payload.channel.id,
      ts: payload.message.ts,
      text: payload.message.text ?? request.title,
      blocks: decidedBlocks(payload, note),
    });
  }
  if (approve) {
    await sendEvent(EVENTS.capabilityApproved, { requestId: request.id });
    return;
  }
  if (request.taskId) {
    await resumeTask(
      request.taskId,
      `${actor.name ?? "An admin"} rejected the capability "${request.title}". Find another way, or report that it can't be done.`,
      new Date(),
    );
  }
}

function buildPrompt(request: CapabilityRequest, admin: User, task: AgentTask | null): string {
  return `[Capability approved — not a message from a person] ${admin.name ?? "An admin"} approved your request for a new capability.

Title: ${request.title}
What it must do: ${request.description}
Why it is needed: ${request.reason}
${task ? `It unblocks task ${task.id} "${task.title}": ${task.goal}\n` : ""}
Delegate it to the self-modify subagent now. Brief it with what the capability must do, why it is needed and what good behavior looks like, and ask for the smallest change that adds it, following the repository's conventions (one tool per file in agent/tools). Tell it not to put Slack links, names or quotes into the pull request. Wait for its result with eve__task_wait. Then reply here with the pull request link and one sentence on what it adds; it becomes available once the pull request is merged and deployed${task ? ", and the task resumes on its own then" : ""}. If self-modify could not do it, say why in one sentence.`;
}

export async function startCapabilityBuild(requestId: string): Promise<boolean> {
  const request = await getRequest(requestId);
  if (!request || request.status !== "approved" || !request.decidedByUserId) return false;
  const admin = await getUser(request.decidedByUserId);
  if (!admin) return false;
  const task = request.taskId ? await getTask(request.taskId) : null;
  const access = await resolveAccess(admin.id, request.channelId);
  await agentRuntime().sendToSlack(
    { channelId: request.channelId, threadTs: request.threadTs },
    buildPrompt(request, admin, task),
    userAuth(admin.id, admin.slackId, {
      kind: TASK_KIND,
      capabilityRequestId: request.id,
      ...(task ? { taskId: task.id } : {}),
      channelId: request.channelId,
      threadTs: request.threadTs,
      readableLevels: access.readableLevels,
      writeAccess: access.writeAccess,
    }),
  );
  log.info(`Tasks.Capabilities: build of ${request.id} started by ${admin.id}`);
  return true;
}

export async function attachCapabilityPull(requestId: string, pullNumber: number, pullUrl: string): Promise<void> {
  await db
    .update(capabilityRequests)
    .set({ pullNumber, pullUrl, updatedAt: new Date() })
    .where(and(eq(capabilityRequests.id, requestId), eq(capabilityRequests.status, "approved")));
}

async function finish(request: CapabilityRequest, status: "merged" | "closed", note: string, resumeAt: Date) {
  await setStatus(request.id, status);
  if (request.taskId) await resumeTask(request.taskId, note, resumeAt);
}

export async function syncCapabilityRequests(): Promise<{ merged: number; closed: number }> {
  let merged = 0;
  let closed = 0;
  const stale = await db
    .select()
    .from(capabilityRequests)
    .where(
      and(
        eq(capabilityRequests.status, "pending"),
        lt(capabilityRequests.insertedAt, new Date(Date.now() - DECISION_TIMEOUT_DAYS * 86_400_000)),
      ),
    );
  for (const request of stale) {
    await finish(request, "closed", `Nobody approved the capability "${request.title}" within ${DECISION_TIMEOUT_DAYS} days.`, new Date());
    closed += 1;
  }
  for (const request of await db.select().from(capabilityRequests).where(eq(capabilityRequests.status, "approved"))) {
    try {
      if (!request.pullNumber || !request.pullUrl) {
        if (request.decidedAt && request.decidedAt.getTime() < Date.now() - BUILD_TIMEOUT_HOURS * 3_600_000) {
          await finish(request, "closed", `No pull request was opened for the capability "${request.title}".`, new Date());
          closed += 1;
        }
        continue;
      }
      const pull = await getPull(request.pullNumber);
      if (pull?.merged) {
        await finish(
          request,
          "merged",
          `The capability "${request.title}" was merged (${request.pullUrl}) and should be available now.`,
          minutesFromNow(DEPLOY_DELAY_MINUTES),
        );
        merged += 1;
      } else if (pull?.state === "closed") {
        await finish(
          request,
          "closed",
          `The pull request for the capability "${request.title}" (${request.pullUrl}) was closed without merging. Find another way, or report that it can't be done.`,
          new Date(),
        );
        closed += 1;
      }
    } catch (error) {
      log.error(`Tasks.Capabilities: failed to sync ${request.id}: ${(error as Error).message}`);
    }
  }
  return { merged, closed };
}
