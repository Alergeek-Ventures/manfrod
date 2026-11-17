"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createDesk, deleteDesk, getLayout, OfficeError, saveElements, saveLayoutSettings, updateDesk } from "@/lib/office/layout.ts";
import { addOfficeMember, removeOfficeMember } from "@/lib/office/members.ts";
import { DEFAULT_SIZES, deskDetailsSchema, deskGeometrySchema, layoutSettingsSchema } from "@/lib/office/model.ts";
import { requireAdmin } from "@/lib/web/session.ts";

export type Result = { ok: boolean; message: string; id?: string };

const id = z.string().uuid();
const deskPatchSchema = deskDetailsSchema.partial().extend(deskGeometrySchema.partial().shape);

async function attempt(run: () => Promise<string | Result>): Promise<Result> {
  await requireAdmin();
  try {
    const outcome = await run();
    revalidatePath("/admin/office");
    return typeof outcome === "string" ? { ok: true, message: outcome } : outcome;
  } catch (error) {
    if (error instanceof OfficeError) return { ok: false, message: error.message };
    if (error instanceof z.ZodError)
      return { ok: false, message: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ") };
    throw error;
  }
}

export async function saveOfficeElements(elements: unknown): Promise<Result> {
  return attempt(async () => {
    const layout = await getLayout();
    await saveElements(layout.id, elements);
    return "Map saved";
  });
}

export async function saveOfficeSettings(settings: unknown): Promise<Result> {
  return attempt(async () => {
    const layout = await getLayout();
    await saveLayoutSettings(layout.id, layoutSettingsSchema.parse(settings));
    return "Settings saved";
  });
}

export async function addDesk(label: unknown, position: unknown): Promise<Result> {
  return attempt(async () => {
    const at = z
      .object({ x: z.number().int().min(0), y: z.number().int().min(0) })
      .nullable()
      .parse(position);
    const desk = await createDesk({ label: z.string().parse(label), ...DEFAULT_SIZES.desk, x: at?.x ?? null, y: at?.y ?? null });
    return { ok: true, message: `Desk ${desk.label} added`, id: desk.id };
  });
}

export async function saveDesk(deskId: unknown, patch: unknown): Promise<Result> {
  return attempt(async () => {
    const desk = await updateDesk(id.parse(deskId), deskPatchSchema.parse(patch));
    return `Desk ${desk.label} saved`;
  });
}

export async function removeDesk(deskId: unknown): Promise<Result> {
  return attempt(async () => ((await deleteDesk(id.parse(deskId))) ? "Desk deleted" : { ok: false, message: "Desk not found" }));
}

export async function addMember(userId: unknown): Promise<Result> {
  return attempt(async () => {
    await addOfficeMember(id.parse(userId));
    return "Added to the office";
  });
}

export async function removeMember(userId: unknown): Promise<Result> {
  return attempt(async () =>
    (await removeOfficeMember(id.parse(userId))) ? "Removed from the office" : { ok: false, message: "Not an office member" },
  );
}
