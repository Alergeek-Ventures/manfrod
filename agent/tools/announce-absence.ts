import { z } from "zod";
import { getUser } from "../../lib/accounts.ts";
import { post, resolveChannel } from "../../lib/slack/api.ts";
import { isChannelMember } from "../lib/slack.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Post a short note about the current user's absence to Slack channels they are a member of, e.g. their project channels. Only after they agreed to it and approved the wording. Mention them as <@SLACK_ID> in the text.",
  inputSchema: z.object({
    channels: z.array(z.string()).min(1).max(6).describe("Channel names or IDs"),
    text: z
      .string()
      .min(1)
      .max(600)
      .describe("The note, in the channel's language, e.g. '<@U123> ma urlop 9–13.11, wraca w poniedziałek 16.11.'"),
  }),
  async execute({ channels, text }, ctx) {
    const person = await getUser(ctx.userId);
    if (!person) return "Nie wiem, kim jesteś, więc nic nie wysłałem.";
    if (!text.includes(`<@${person.slackId}>`))
      return `Nic nie wysłałem: notka o nieobecności musi oznaczać tę osobę jako <@${person.slackId}>. Inne wiadomości na kanał wysyłaj przez post-slack-message.`;
    const results: string[] = [];
    for (const channel of channels) {
      const resolved = await resolveChannel(channel);
      if (!resolved.ok) {
        results.push(`${channel}: nie znalazłem kanału`);
        continue;
      }
      if (!(await isChannelMember(resolved.id, person.slackId))) {
        results.push(`${channel}: nie jesteś na tym kanale, pominąłem`);
        continue;
      }
      const sent = await post("chat.postMessage", { channel: resolved.id, text });
      results.push(sent.ok ? `<#${resolved.id}>: wysłane` : `${channel}: nie udało się (${sent.error})`);
    }
    return results.join("\n");
  },
});
