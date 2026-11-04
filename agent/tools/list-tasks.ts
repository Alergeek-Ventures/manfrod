import { z } from "zod";
import { getUser, isAdmin } from "../../lib/accounts.ts";
import { listOpenTasks, taskDetails } from "../../lib/tasks/index.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "List open long-running tasks: the ones from this thread, the ones the person you are talking to started, or (admins only) all of them. Each comes with its thread, plan and latest progress notes. Before telling anyone what a task will do next, read them and the task's thread (read-slack-thread with that channel and thread_ts); never infer it from the goal or your notes.",
  inputSchema: z.object({
    scope: z
      .enum(["thread", "mine", "all"])
      .describe("thread: from this conversation; mine: started by this person; all: every open task (admins)"),
  }),
  async execute({ scope }, ctx) {
    let tasks;
    if (scope === "thread") {
      const threadTs = ctx.msgCtx.threadTs ?? ctx.msgCtx.ts;
      if (!ctx.msgCtx.channel || !threadTs) return "There is no Slack conversation here.";
      tasks = await listOpenTasks({ channelId: ctx.msgCtx.channel, threadTs });
    } else if (scope === "mine") {
      tasks = await listOpenTasks({ ownerUserId: ctx.userId });
    } else {
      if (!isAdmin(await getUser(ctx.userId))) return "Only admins can list every task.";
      tasks = await listOpenTasks();
    }
    return tasks.length > 0 ? (await Promise.all(tasks.map(taskDetails))).join("\n") : "No open tasks.";
  },
});
