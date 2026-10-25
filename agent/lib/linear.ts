import { getUser } from "../../lib/accounts.ts";
import type { Requester } from "../../lib/linear/calls.ts";
import { getActiveMapping } from "../../lib/memory/access.ts";

export async function linearProjectForChannel(channelId: string | null): Promise<string | null> {
  if (!channelId) return null;
  const mapping = await getActiveMapping(channelId);
  return mapping?.projectId ?? null;
}

export async function linearRequester(userId: string | null | undefined): Promise<Requester | null> {
  const user = userId ? await getUser(userId) : null;
  return user ? { name: user.name, email: user.email, image: user.image } : null;
}
