"use server";

import { revalidatePath } from "next/cache";
import { deleteSecret, saveSecret, type SecretScope } from "@/lib/secrets.ts";
import { requireUser } from "@/lib/web/session.ts";

export type Result = { ok: boolean; message: string };

export async function saveSecretAction(input: {
  name: string;
  value: string;
  description: string;
  hosts: string;
  scope: SecretScope;
}): Promise<Result> {
  const user = await requireUser();
  try {
    await saveSecret(user, {
      name: input.name.trim().toUpperCase(),
      value: input.value === "" ? null : input.value,
      description: input.description.trim() || null,
      scope: input.scope,
      allowedHosts: input.hosts.split(","),
    });
  } catch (error) {
    return { ok: false, message: `Error: ${(error as Error).message}` };
  }
  revalidatePath("/secrets");
  return { ok: true, message: `Secret ${input.name.trim().toUpperCase()} saved` };
}

export async function deleteSecretAction(id: string): Promise<Result> {
  const user = await requireUser();
  try {
    if (!(await deleteSecret(user, id))) return { ok: false, message: "Secret not found" };
  } catch (error) {
    return { ok: false, message: `Error: ${(error as Error).message}` };
  }
  revalidatePath("/secrets");
  return { ok: true, message: "Secret deleted" };
}
