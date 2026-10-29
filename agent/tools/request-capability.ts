import { z } from "zod";
import { getUser } from "../../lib/accounts.ts";
import { SELF_REVIEW_KIND } from "../../lib/self-review/rules.ts";
import { requestCapability } from "../../lib/tasks/capabilities.ts";
import { canManage, getTask } from "../../lib/tasks/index.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Ask for approval to give yourself a capability you are missing (a new tool, an integration, an API you can't reach yet) when it blocks what you were asked to do. Posts the request with Approve and Reject buttons in this conversation; only an admin can decide. Once approved you build it yourself with the self-modify subagent, and a task passed as task_id waits until the change is merged and deployed, then resumes. Don't use it for one-off things you can already do with your tools, or for credentials (use request-secret).",
  inputSchema: z.object({
    title: z.string().min(1).max(100).describe("Short name of the capability, e.g. 'Read Google Sheets'"),
    description: z.string().min(1).max(2000).describe("What exactly it must do: inputs, outputs, which service or API, and limits"),
    reason: z.string().min(1).max(1000).describe("Why you need it now and what it unblocks"),
    message: z
      .string()
      .min(1)
      .max(500)
      .describe("One or two sentences for the admins in the conversation's language, explaining what you'd add and why"),
    approve_label: z.string().min(1).max(30).describe("Approve button text in the conversation's language, e.g. 'Zatwierdź'"),
    reject_label: z.string().min(1).max(30).describe("Reject button text in the conversation's language, e.g. 'Odrzuć'"),
    task_id: z.string().optional().describe("The long-running task this blocks; it is paused until the request is resolved"),
  }),
  async execute(input, ctx) {
    if (ctx.kind === SELF_REVIEW_KIND) return "Self-review can't request capabilities.";
    const channelId = ctx.msgCtx.channel;
    const threadTs = ctx.msgCtx.threadTs ?? ctx.msgCtx.ts;
    if (!channelId || !threadTs) return "There is no Slack conversation to post the request in.";
    const requester = await getUser(ctx.userId);
    if (!requester) return "I don't know who is asking.";
    const task = input.task_id ? await getTask(input.task_id) : null;
    if (input.task_id && !task) return `Task ${input.task_id} not found.`;
    if (task && !(await canManage(task, ctx.userId, channelId))) return "You can only pause a task from its own thread or with its owner.";
    const result = await requestCapability({
      requester,
      task,
      title: input.title,
      description: input.description,
      reason: input.reason,
      message: input.message,
      approveLabel: input.approve_label,
      rejectLabel: input.reject_label,
      channelId,
      threadTs,
    });
    if (!result.ok) return `Could not post the request: ${result.error}`;
    return `${result.elsewhere ? "Posted the request in the admins' channel, since no admin can approve it here." : "Posted the request here."} ${task ? `Task ${task.id} is paused until an admin decides.` : "Wait for an admin to decide."} Don't build it before it is approved.`;
  },
});
