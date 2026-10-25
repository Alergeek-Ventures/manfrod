"use server";

import { revalidatePath } from "next/cache";
import { disconnect as disconnectKalafiornia, loginWithPin, requestPin } from "@/lib/kalafiornia.ts";
import { createCustomProvider, deleteCustomProvider, disconnect } from "@/lib/mcp/index.ts";
import { requireUser } from "@/lib/web/session.ts";

export type ActionResult = { ok: boolean; message: string };

export async function addCustomProvider(url: string, name: string, scope: string): Promise<ActionResult> {
  const user = await requireUser();
  if (url.trim() === "") return { ok: false, message: "MCP server URL is required" };
  try {
    await createCustomProvider(user.id, url.trim(), name.trim() || null, scope.trim() || null);
  } catch (error) {
    return { ok: false, message: `Could not add server: ${(error as Error).message}` };
  }
  revalidatePath("/integrations");
  return { ok: true, message: "Custom MCP server added" };
}

export async function removeCustomProvider(id: string): Promise<ActionResult> {
  const user = await requireUser();
  await deleteCustomProvider(user.id, id);
  revalidatePath("/integrations");
  return { ok: true, message: "Custom MCP server removed" };
}

export async function disconnectProvider(id: string): Promise<ActionResult> {
  const user = await requireUser();
  await disconnect(user.id, id);
  revalidatePath("/integrations");
  return { ok: true, message: "Disconnected" };
}

export async function kalafiorniaSendPin(email: string): Promise<ActionResult> {
  await requireUser();
  if (email.trim() === "") return { ok: false, message: "Email is required" };
  const result = await requestPin(email.trim());
  return result.ok ? { ok: true, message: `PIN sent to ${email}` } : { ok: false, message: `Could not send PIN: ${result.error}` };
}

export async function kalafiorniaVerifyPin(email: string, pin: string): Promise<ActionResult> {
  const user = await requireUser();
  const result = await loginWithPin(user.id, email.trim(), pin.trim());
  if (!result.ok) return { ok: false, message: "Wrong PIN, try again" };
  revalidatePath("/integrations");
  return { ok: true, message: "Kalafiornia connected" };
}

export async function kalafiorniaDisconnect(): Promise<ActionResult> {
  const user = await requireUser();
  await disconnectKalafiornia(user.id);
  revalidatePath("/integrations");
  return { ok: true, message: "Kalafiornia disconnected" };
}
