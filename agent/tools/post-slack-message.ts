import { z } from "zod";
import { getUser } from "../../lib/accounts.ts";
import { SELF_REVIEW_KIND } from "../../lib/self-review/rules.ts";
import { getPermalink, post, resolveChannel } from "../../lib/slack/api.ts";
import { isChannelMember } from "../lib/slack.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Post a message in a Slack channel, as a new message or as a reply in one of its threads, e.g. when a scheduled job tells you to ask a channel for something. Only in channels the person you act for is a member of. Returns the channel ID and the thread_ts of the message: pass both to create-task to keep following the replies in that thread. To answer in the conversation you are in, just reply; to message one person, use send-dm.",
  inputSchema: z.object({
    channel: z.string().describe("Channel name (e.g. 'general' or '#general') or Slack channel ID (e.g. 'C087QF130R3')"),
    text: z.string().min(1).max(4000).describe("The message, in Slack mrkdwn; mention people as <@SLACK_ID>"),
    thread_ts: z.string().optional().describe("thread_ts of a thread in that channel to reply in; omit for a new message"),
  }),
  async execute({ channel, text, thread_ts }, ctx) {
    if (ctx.kind === SELF_REVIEW_KIND) return "Self-review can't post on Slack.";
    const person = await getUser(ctx.userId);
    if (!person) return "I don't know who you are acting for, so I posted nothing.";
    const resolved = await resolveChannel(channel.trim());
    if (!resolved.ok) return `Channel not found: ${channel}`;
    if (resolved.id.startsWith("D")) return "That is a direct message; use send-dm to write to one person.";
    if (!(await isChannelMember(resolved.id, person.slackId)))
      return `${person.name ?? person.slackId} is not a member of <#${resolved.id}>, so you can't post there for them.`;
    const sent = await post("chat.postMessage", { channel: resolved.id, text, ...(thread_ts ? { thread_ts } : {}) });
    if (!sent.ok) {
      if (sent.error === "not_in_channel") return `You are not a member of <#${resolved.id}>; someone has to add you there first.`;
      return `Could not post it: ${sent.error}`;
    }
    const ts = sent.body.ts as string;
    const link = await getPermalink(resolved.id, ts);
    return `Posted in <#${resolved.id}>${link ? ` (${link})` : ""}. channel: ${resolved.id}, thread_ts: ${thread_ts ?? ts}`;
  },
});
