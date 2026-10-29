import { z } from "zod";
import {
  addUpdate,
  canManage,
  CLOSED_STATUSES,
  closeTask,
  editTask,
  getTask,
  isFinalCheck,
  MAX_CHECK_MINUTES,
  MIN_CHECK_MINUTES,
  OPEN_STATUSES,
  scheduleCheck,
} from "../../lib/tasks/index.ts";
import { formatLocal } from "../../lib/time.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Record progress on a long-running task, change its plan, success criterion or check interval, schedule the next check, or close it (done, cancelled, failed). Call it at the end of every task check, and whenever someone gives you information that moves a task forward.",
  inputSchema: z.object({
    task_id: z.string().describe("Task ID"),
    note: z.string().max(2000).optional().describe("Progress note for your future self: what happened, what you are waiting for"),
    status: z
      .enum(CLOSED_STATUSES)
      .optional()
      .describe(
        "Close the task: done when the success criterion is met, cancelled when it's no longer needed, failed when it can't be done",
      ),
    outcome: z.string().max(2000).optional().describe("Required when closing: the result in one or two sentences"),
    plan: z.string().max(4000).optional().describe("Replaces the plan and working notes"),
    success_criteria: z.string().max(1000).optional().describe("Replaces the success criterion, only when the person who asked changes it"),
    check_every_minutes: z
      .number()
      .int()
      .min(MIN_CHECK_MINUTES)
      .max(MAX_CHECK_MINUTES)
      .optional()
      .describe("New default interval between checks"),
    next_check_in_minutes: z
      .number()
      .int()
      .min(MIN_CHECK_MINUTES)
      .max(MAX_CHECK_MINUTES)
      .optional()
      .describe("When to come back next time"),
  }),
  async execute(input, ctx) {
    let task = await getTask(input.task_id);
    if (!task) return `Task ${input.task_id} not found.`;
    if (!(await canManage(task, ctx.userId, ctx.msgCtx.channel)))
      return "You can only update this task from its own thread or with its owner.";
    if (!(OPEN_STATUSES as readonly string[]).includes(task.status)) return `Task ${task.id} is already ${task.status}.`;
    if (input.note) await addUpdate(task.id, input.note);
    if (input.status) {
      if (!input.outcome) return "Give the outcome when closing a task.";
      await closeTask(task, input.status, input.outcome);
      return `Task ${task.id} closed as ${input.status}.`;
    }
    if (input.plan !== undefined || input.success_criteria !== undefined || input.check_every_minutes !== undefined) {
      task = await editTask(task, {
        plan: input.plan,
        successCriteria: input.success_criteria,
        checkEveryMinutes: input.check_every_minutes,
      });
    }
    const minutes = input.next_check_in_minutes ?? (input.check_every_minutes !== undefined ? task.checkEveryMinutes : null);
    if (minutes !== null && task.status === "active") {
      if (isFinalCheck(task)) return "This task has reached its deadline or check limit; close it with a status and outcome instead.";
      const at = await scheduleCheck(task, new Date(Date.now() + minutes * 60_000));
      return `Task ${task.id} updated; next check ${formatLocal(at)} (Warsaw time).`;
    }
    if (task.status === "blocked") return `Task ${task.id} updated; it stays paused until the capability request is resolved.`;
    return `Task ${task.id} updated${task.nextCheckAt ? `; next check ${formatLocal(task.nextCheckAt)} (Warsaw time)` : ""}.`;
  },
});
