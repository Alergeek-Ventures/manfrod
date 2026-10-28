"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { ADMIN_ROLE } from "@/lib/accounts.ts";
import { auth } from "@/lib/auth.ts";
import { db, tables } from "@/lib/db/index.ts";
import { isLanguageCode, setLanguages } from "@/lib/agent-settings.ts";
import { setFact } from "@/lib/facts.ts";
import { cancelJob } from "@/lib/jobs/index.ts";
import { disconnect as disconnectLinear } from "@/lib/linear/index.ts";
import { addMembership, removeMembership } from "@/lib/memory/access.ts";
import { uninstall as uninstallLinearApp } from "@/lib/linear/installation.ts";
import { ValidationError } from "@/lib/memory/nodes.ts";
import { deleteRecurringReminder, getRecurringReminderById, updateRecurringReminder } from "@/lib/memory/reminders.ts";
import { requireAdmin } from "@/lib/web/session.ts";

export type Result = { ok: boolean; message: string };

const done = (message: string): Result => {
  revalidatePath("/admin/access", "layout");
  return { ok: true, message };
};

const errorText = (error: unknown) =>
  error instanceof ValidationError
    ? Object.entries(error.errors)
        .map(([field, message]) => `${field}: ${message}`)
        .join(", ")
    : (error as Error).message;

export async function addProject(slug: string, name: string): Promise<Result> {
  await requireAdmin();
  if (slug.trim() === "" || name.trim() === "") return { ok: false, message: "Error: slug: can't be blank, name: can't be blank" };
  try {
    await db.insert(tables.projects).values({ slug: slug.trim(), name: name.trim() });
  } catch (error) {
    return { ok: false, message: `Error: ${errorText(error)}` };
  }
  return done("Project added");
}

export async function addProjectMember(userId: string, projectId: string): Promise<Result> {
  await requireAdmin();
  if (userId === "" || projectId === "") return { ok: false, message: "Select a person and a project" };
  try {
    await addMembership(userId, projectId);
  } catch (error) {
    return { ok: false, message: `Error: ${errorText(error)}` };
  }
  return done("Added to the project");
}

export async function removeProjectMember(userId: string, projectId: string): Promise<Result> {
  await requireAdmin();
  return (await removeMembership(userId, projectId)) ? done("Removed from the project") : { ok: false, message: "Membership not found" };
}

export async function setUserAdmin(userId: string, admin: boolean): Promise<Result> {
  const current = await requireAdmin();
  if (userId === current.id) return { ok: false, message: "You can't change your own admin role" };
  try {
    await auth.api.setRole({ body: { userId, role: admin ? ADMIN_ROLE : "user" }, headers: await headers() });
  } catch (error) {
    return { ok: false, message: `Error: ${errorText(error)}` };
  }
  return done(admin ? "Admin added" : "Admin removed");
}

export async function saveVacation(userId: string, startDate: string, endDate: string, note: string): Promise<Result> {
  await requireAdmin();
  if (userId === "" || startDate === "" || endDate === "") return { ok: false, message: "Select a person and vacation dates" };
  try {
    await setFact(
      `absence:${userId}:${startDate}`,
      `${startDate}..${endDate} — ${note || "vacation"}`,
      ["internal", "external/all"],
      userId,
    );
  } catch (error) {
    return { ok: false, message: `Error: ${errorText(error)}` };
  }
  return done("Vacation saved");
}

export async function updateVacation(id: string, value: string): Promise<Result> {
  await requireAdmin();
  const result = await db.update(tables.facts).set({ value }).where(eq(tables.facts.id, id)).returning({ id: tables.facts.id });
  return result.length === 0 ? { ok: false, message: "Vacation not found" } : done("Vacation updated");
}

export async function deleteVacation(id: string): Promise<Result> {
  await requireAdmin();
  const result = await db.delete(tables.facts).where(eq(tables.facts.id, id)).returning({ id: tables.facts.id });
  return result.length === 0 ? { ok: false, message: "Vacation not found" } : done("Vacation deleted");
}

export async function saveCron(id: string, cron: string, timezone: string, instructions: string): Promise<Result> {
  await requireAdmin();
  const reminder = await getRecurringReminderById(id);
  if (!reminder) return { ok: false, message: "Cron not found" };
  try {
    await updateRecurringReminder(reminder.userId, reminder, { cron, timezone, instructions });
  } catch (error) {
    return { ok: false, message: `Error: ${errorText(error)}` };
  }
  return done("Cron updated");
}

export async function toggleCron(id: string): Promise<Result> {
  await requireAdmin();
  const reminder = await getRecurringReminderById(id);
  if (!reminder) return { ok: false, message: "Cron not found" };
  try {
    await updateRecurringReminder(reminder.userId, reminder, { enabled: !reminder.enabled });
  } catch (error) {
    return { ok: false, message: `Error: ${errorText(error)}` };
  }
  return done("Updated");
}

export async function deleteCron(id: string): Promise<Result> {
  await requireAdmin();
  const reminder = await getRecurringReminderById(id);
  if (!reminder) return { ok: false, message: "Cron not found" };
  return (await deleteRecurringReminder(reminder.userId, reminder))
    ? done("Cron deleted")
    : { ok: false, message: "Failed to delete cron" };
}

export async function cancelReminder(id: number): Promise<Result> {
  await requireAdmin();
  await cancelJob(id);
  return done("Reminder cancelled");
}

export async function setMappingStatus(id: string, status: "active" | "pending"): Promise<Result> {
  await requireAdmin();
  const result = await db
    .update(tables.channelMappings)
    .set({ status })
    .where(eq(tables.channelMappings.id, id))
    .returning({ id: tables.channelMappings.id });
  return result.length === 0 ? { ok: false, message: "Mapping not found" } : done("Updated");
}

export async function deleteMapping(id: string): Promise<Result> {
  await requireAdmin();
  const result = await db
    .delete(tables.channelMappings)
    .where(eq(tables.channelMappings.id, id))
    .returning({ id: tables.channelMappings.id });
  return result.length === 0 ? { ok: false, message: "Mapping not found" } : done("Deleted");
}

export async function revokeLinear(id: string): Promise<Result> {
  await requireAdmin();
  const [connection] = await db
    .select({ projectId: tables.projectLinearConnections.projectId })
    .from(tables.projectLinearConnections)
    .where(eq(tables.projectLinearConnections.id, id))
    .limit(1);
  if (!connection) return { ok: false, message: "Linear connection not found" };
  await disconnectLinear(connection.projectId);
  return done("Linear connection revoked");
}

export async function uninstallLinear(id: string): Promise<Result> {
  await requireAdmin();
  if (!(await uninstallLinearApp(id))) return { ok: false, message: "Linear app installation not found" };
  return done("Linear app uninstalled");
}

export async function saveLanguages(internal: string, external: string): Promise<Result> {
  const admin = await requireAdmin();
  if (!isLanguageCode(internal) || !isLanguageCode(external)) return { ok: false, message: "Error: unknown language" };
  await setLanguages({ internal, external }, admin.id);
  return done("Languages saved");
}
