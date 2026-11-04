import { getUser } from "../accounts.ts";
import { channelLanguage } from "../agent-settings.ts";
import { TASK_KIND } from "../agent/context.ts";
import type { AgentTask, AgentTaskUpdate, User } from "../db/schema.ts";
import { agentRuntime } from "../inngest/runtime.ts";
import { logger } from "../log.ts";
import { userAuth } from "../proactive.ts";
import { formatLocal } from "../time.ts";
import { repliedSince, taskDms } from "./dms.ts";
import { closeTask, getTask, isFinalCheck, markChecked, recentUpdates, scheduleCheck } from "./index.ts";

const log = logger("Tasks");

export interface Contact {
  name: string;
  slackId: string;
  at: Date;
  replied: boolean;
}

export function checkPrompt(input: {
  task: AgentTask;
  owner: Pick<User, "name" | "slackId">;
  updates: Pick<AgentTaskUpdate, "content" | "insertedAt">[];
  contacts: Contact[];
  final: boolean;
  language: string;
}): string {
  const { task, owner, updates, contacts, final, language } = input;
  const postHere = `post-slack-message with channel ${task.channelId} and thread_ts ${task.threadTs}`;
  const progress = updates.map((update) => `- ${formatLocal(update.insertedAt)}: ${update.content}`).join("\n") || "- (nothing yet)";
  const dms =
    contacts.length > 0
      ? `\nDirect messages you sent for this task:\n${contacts
          .map(
            (contact) =>
              `- ${contact.name} <@${contact.slackId}>, ${formatLocal(contact.at)}: ${contact.replied ? "replied since" : "no reply yet"}`,
          )
          .join("\n")}\n`
      : "";
  const ending = final
    ? `This is the last check: ${task.deadline && task.deadline.getTime() <= Date.now() ? "the deadline has passed" : "the check limit is reached"}. Close the task now with update-task (done if the criterion is met, otherwise failed with what is missing) and post a short summary for ${owner.name ?? "the person who asked"} in the thread with ${postHere}.`
    : `End with update-task: a one-line progress note, and next_check_in_minutes sized to how fast things are moving (a check every ${task.checkEveryMinutes} minutes is already scheduled if you don't change it).`;
  return `[Task check — not a message from a person] You are running on your own to move a long-running task forward. Nobody asked anything just now.

Task ${task.id}: "${task.title}"
Created by ${owner.name ?? "?"} <@${owner.slackId}> on ${formatLocal(task.insertedAt)}. Check ${task.checks} so far.${task.deadline ? ` Deadline: ${formatLocal(task.deadline)}.` : ""}
Goal: ${task.goal}
Done when: ${task.successCriteria}
Plan and working notes: ${task.plan ?? "(none)"}

Progress so far, oldest first:
${progress}
${dms}
1. Find out where things stand with your tools (read-slack-thread reads this thread; people's replies there are not shown to you unless they mention you).
2. If the success criterion is met, or ${owner.name ?? "the person who asked"} said it is done or no longer needed, close it with update-task (status done or cancelled, with the outcome) and post a short summary in the thread with ${postHere}.
3. Otherwise take the next useful step with the tools you have: ${postHere}, send-dm to the specific people you are waiting for, or anything else that moves it forward. Don't repeat a nudge you already sent unless enough time has passed, and never contact people whose Slack account is deactivated.
4. If you cannot move forward because you lack a tool, an integration or access, call request-capability with this task id instead of giving up or pretending.
5. ${ending}

Your final reply is never shown to anyone, so don't use it to report what you did or didn't do. The only way to write in the thread is ${postHere}; use it only for something people there should read now, and write it in ${language}. Never post there that nothing happened, that nobody answered yet, when you will check again, or comments on your own earlier messages; keep that in the update-task progress note and post nothing.`;
}

async function contactsOf(task: AgentTask): Promise<Contact[]> {
  const contacts: Contact[] = [];
  for (const dm of await taskDms(task.id)) {
    const recipient = await getUser(dm.recipientUserId);
    if (!recipient) continue;
    contacts.push({
      name: recipient.name ?? recipient.id,
      slackId: recipient.slackId,
      at: dm.insertedAt,
      replied: await repliedSince(dm, recipient.slackId),
    });
  }
  return contacts.reverse();
}

export async function runTaskCheck(taskId: string): Promise<void> {
  const found = await getTask(taskId);
  if (!found || found.status !== "active") return;
  const owner = await getUser(found.ownerUserId);
  if (!owner) {
    await closeTask(found, "failed", "The person who created the task no longer exists.");
    return;
  }
  const task = await markChecked(found);
  const final = isFinalCheck(task);
  if (!final) await scheduleCheck(task, new Date(Date.now() + task.checkEveryMinutes * 60_000));
  const prompt = checkPrompt({
    task,
    owner,
    updates: await recentUpdates(task.id),
    contacts: await contactsOf(task),
    final,
    language: (await channelLanguage(task.channelId)).name,
  });
  await agentRuntime().sendToSlack(
    { channelId: task.channelId, threadTs: task.threadTs },
    prompt,
    userAuth(owner.id, owner.slackId, {
      kind: TASK_KIND,
      taskId: task.id,
      channelId: task.channelId,
      threadTs: task.threadTs,
      readableLevels: task.readableLevels,
      writeAccess: task.writeAccess,
    }),
  );
  log.info(`Tasks: check ${task.checks} of ${task.id} started${final ? " (final)" : ""}`);
}
