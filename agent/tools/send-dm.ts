import { z } from "zod";
import { getUser, getUserBySlackId } from "../../lib/accounts.ts";
import { SELF_REVIEW_KIND } from "../../lib/self-review/rules.ts";
import { dmRefusal, sendDm } from "../../lib/tasks/dms.ts";
import { canManage, getTask } from "../../lib/tasks/index.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Send a direct message on Slack to one specific person, e.g. to ask someone who hasn't answered in a thread, or to pass something on when asked to. Say on whose behalf and why you are writing, and link the thread if there is one. Pass task_id when it is for a long-running task, so their reply comes back to it. Refuses people with deactivated accounts, people who turned these messages off, and repeating yourself within two hours.",
  inputSchema: z.object({
    recipient: z.string().describe("Slack ID (e.g. U094WT397D2) or Manfrod user ID of the person"),
    text: z.string().min(1).max(3000).describe("The message, in Slack mrkdwn, in the language you use with this person"),
    task_id: z.string().optional().describe("The long-running task this message is for"),
  }),
  async execute({ recipient, text, task_id }, ctx) {
    if (ctx.kind === SELF_REVIEW_KIND) return "Self-review can't send direct messages.";
    const person = (await getUserBySlackId(recipient.trim())) ?? (await getUser(recipient.trim()));
    if (!person) return `I don't know anyone with the ID ${recipient}; check list-team-members.`;
    let taskId: string | null = null;
    if (task_id) {
      const task = await getTask(task_id);
      if (!task) return `Task ${task_id} not found.`;
      if (!(await canManage(task, ctx.userId, ctx.msgCtx.channel)))
        return "You can only message people for a task from its own thread or with its owner.";
      taskId = task.id;
    }
    const refusal = await dmRefusal(person, taskId);
    if (refusal) return refusal;
    const sent = await sendDm({ recipient: person, senderUserId: ctx.userId, taskId, text });
    return sent.ok ? `Sent to ${person.name ?? person.slackId}.` : `Could not send it: ${sent.error}`;
  },
});
