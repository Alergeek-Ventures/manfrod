import { z } from "zod";
import { getUser } from "../../lib/accounts.ts";
import type { ToolCtx } from "../../lib/agent/context.ts";
import { resolveAccess } from "../../lib/memory/access.ts";
import { resolveChannel } from "../../lib/slack/api.ts";
import { createTask, MAX_CHECK_MINUTES, MIN_CHECK_MINUTES } from "../../lib/tasks/index.ts";
import { formatLocal } from "../../lib/time.ts";
import { SELF_REVIEW_KIND } from "../../lib/self-review/rules.ts";
import { AT_DOC, parseAt } from "../lib/reminders.ts";
import { blank, isChannelMember } from "../lib/slack.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

type TaskThread = { channelId: string; threadTs: string; readableLevels: string[]; writeAccess: string[] };

async function taskThread(channel: string | undefined, threadTs: string | undefined, ctx: ToolCtx): Promise<TaskThread | string> {
  const named = blank(channel);
  const ts = blank(threadTs);
  if (!named) {
    const channelId = ctx.msgCtx.channel;
    const current = ts ?? ctx.msgCtx.threadTs ?? ctx.msgCtx.ts;
    if (!channelId || !current) return "There is no Slack conversation to attach the task to.";
    return { channelId, threadTs: current, readableLevels: ctx.readableLevels, writeAccess: ctx.writeAccess };
  }
  if (!ts) return "Give the thread_ts of the thread in that channel (post-slack-message returns it).";
  const resolved = await resolveChannel(named);
  if (!resolved.ok) return `Channel not found: ${channel}`;
  const person = await getUser(ctx.userId);
  if (!person || !(await isChannelMember(resolved.id, person.slackId)))
    return "You can only attach a task to a thread in a channel the person you act for is a member of.";
  return { channelId: resolved.id, threadTs: ts, ...(await resolveAccess(ctx.userId, resolved.id)) };
}

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Start a long-running task you will keep working on by yourself until it is done: you get woken up in its thread every check_every_minutes (only on workdays 8-18 Warsaw time), see the goal and your progress notes, and take the next step. Use it for anything that needs follow-through beyond this reply, e.g. collecting answers from several people, chasing something until it happens, multi-day work. The thread is this conversation unless you give channel and thread_ts of another one, e.g. the post you just made with post-slack-message; your checks then read and reply in that thread. Write the success criterion so a future you can verify it with tools.",
  inputSchema: z.object({
    title: z.string().min(1).max(120).describe("Short name of the task"),
    goal: z.string().min(1).max(2000).describe("What has to be achieved, for whom, and any constraints"),
    success_criteria: z
      .string()
      .min(1)
      .max(1000)
      .describe(
        "A concrete, checkable condition for done, e.g. 'every active developer listed in the plan answered in the thread or by DM'",
      ),
    plan: z.string().max(4000).optional().describe("Steps, people involved and anything your future self needs to know"),
    check_every_minutes: z
      .number()
      .int()
      .min(MIN_CHECK_MINUTES)
      .max(MAX_CHECK_MINUTES)
      .describe("How often to come back to it, sized to how fast things change (e.g. 120 for waiting on people's replies)"),
    first_check_at: z.string().optional().describe(`When to come back the first time; defaults to after one interval. ${AT_DOC}`),
    deadline: z.string().optional().describe(`When to stop and report however far you got. ${AT_DOC}`),
    channel: z
      .string()
      .optional()
      .describe("Channel name or ID of the thread to work in, when it is not this conversation; requires thread_ts"),
    thread_ts: z.string().optional().describe("thread_ts of that thread, e.g. from post-slack-message"),
  }),
  async execute(input, ctx) {
    if (ctx.kind === SELF_REVIEW_KIND) return "Self-review can't start tasks.";
    const thread = await taskThread(input.channel, input.thread_ts, ctx);
    if (typeof thread === "string") return thread;
    const firstCheckAt = input.first_check_at ? parseAt(input.first_check_at) : null;
    const deadline = input.deadline ? parseAt(input.deadline) : null;
    if ((input.first_check_at && !firstCheckAt) || (input.deadline && !deadline))
      return "Invalid datetime. Use ISO8601 UTC like '2026-02-04T14:00:00Z'";
    if (deadline && deadline <= new Date()) return "The deadline must be in the future.";
    const task = await createTask({
      ownerUserId: ctx.userId,
      title: input.title,
      goal: input.goal,
      successCriteria: input.success_criteria,
      plan: input.plan ?? null,
      ...thread,
      checkEveryMinutes: input.check_every_minutes,
      firstCheckAt: firstCheckAt && firstCheckAt > new Date() ? firstCheckAt : null,
      deadline,
    });
    return `Task ${task.id} created; first check ${task.nextCheckAt ? formatLocal(task.nextCheckAt) : "not scheduled"} (Warsaw time), then every ${task.checkEveryMinutes} minutes until you close it with update-task.`;
  },
});
