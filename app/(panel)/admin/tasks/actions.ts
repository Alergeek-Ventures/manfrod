"use server";

import { revalidatePath } from "next/cache";
import { closeTask, getTask, OPEN_STATUSES } from "@/lib/tasks/index.ts";
import { requireAdmin } from "@/lib/web/session.ts";

export async function cancelTask(id: string): Promise<{ ok: boolean; message: string }> {
  const admin = await requireAdmin();
  const task = await getTask(id);
  if (!task || !(OPEN_STATUSES as readonly string[]).includes(task.status))
    return { ok: false, message: "Task not found or already closed" };
  await closeTask(task, "cancelled", `Cancelled in the panel by ${admin.name ?? admin.email ?? admin.slackId}.`);
  revalidatePath("/admin/tasks");
  return { ok: true, message: "Task cancelled" };
}
