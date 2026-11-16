import { getUser } from "../../lib/accounts.ts";
import { getConnection } from "../../lib/linear/index.ts";
import { resolveChannel } from "../../lib/slack/api.ts";
import { isChannelMember } from "./slack.ts";
import type { Requester } from "../../lib/linear/calls.ts";
import { getActiveMapping } from "../../lib/memory/access.ts";

export async function linearProjectForChannel(channelId: string | null): Promise<string | null> {
  if (!channelId) return null;
  const mapping = await getActiveMapping(channelId);
  return mapping?.projectId ?? null;
}

export async function linearProjectForPerson(
  channel: string,
  userId: string | null | undefined,
): Promise<{ ok: true; projectId: string } | { ok: false; message: string }> {
  const resolved = await resolveChannel(channel.trim());
  if (!resolved.ok) return { ok: false, message: `Channel not found: ${channel}` };
  const projectId = await linearProjectForChannel(resolved.id);
  if (!projectId || !(await getConnection(projectId)))
    return { ok: false, message: `<#${resolved.id}> has no project connected to Linear.` };
  const person = userId ? await getUser(userId) : null;
  if (!person?.slackId) return { ok: false, message: "I don't know who you are, so I can't read Linear for you." };
  if (!(await isChannelMember(resolved.id, person.slackId))) {
    return {
      ok: false,
      message: `${person.name ?? person.slackId} is not a member of <#${resolved.id}>, so I can't read its Linear team for them.`,
    };
  }
  return { ok: true, projectId };
}

export async function linearRequester(userId: string | null | undefined): Promise<Requester | null> {
  const user = userId ? await getUser(userId) : null;
  return user ? { name: user.name, email: user.email, image: user.image } : null;
}
