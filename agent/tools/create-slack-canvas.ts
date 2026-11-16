import { z } from "zod";
import { getUser } from "../../lib/accounts.ts";
import { SELF_REVIEW_KIND } from "../../lib/self-review/rules.ts";
import { createCanvas, createChannelCanvas, getChannelCanvasId, resolveChannel } from "../../lib/slack/api.ts";
import { canvasLink, isChannelMember } from "../lib/slack.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Create a Slack canvas people can edit, from markdown (tables included), in a channel the person you act for is a member of. Without a title it becomes the channel canvas if the channel has none; otherwise it is a separate canvas tab in that channel. Returns the canvas ID for edit-slack-canvas and a link.",
  inputSchema: z.object({
    channel: z.string().describe("Channel name (e.g. 'general' or '#general') or Slack channel ID"),
    title: z.string().max(200).optional().describe("Title; makes a separate canvas tab instead of the channel canvas"),
    markdown: z.string().min(1).describe("Canvas content in markdown; tables as | a | b | rows"),
  }),
  label: { start: ({ channel }) => `Create canvas in ${channel}` },
  async execute({ channel, title, markdown }, ctx) {
    if (ctx.kind === SELF_REVIEW_KIND) return "Self-review can't create canvases.";
    const person = await getUser(ctx.userId);
    if (!person) return "I don't know who you are acting for, so I created nothing.";
    const resolved = await resolveChannel(channel.trim());
    if (!resolved.ok) return `Channel not found: ${channel}`;
    if (resolved.id.startsWith("D")) return "Canvases can only be created in channels, not in direct messages.";
    if (!(await isChannelMember(resolved.id, person.slackId)))
      return `${person.name ?? person.slackId} is not a member of <#${resolved.id}>, so you can't create a canvas there for them.`;
    const existing = await getChannelCanvasId(resolved.id);
    const useChannelCanvas = existing === null && !title;
    const created = useChannelCanvas ? await createChannelCanvas(resolved.id, markdown) : await createCanvas(markdown, title, resolved.id);
    if (!created.ok) {
      if (created.error === "not_in_channel") return `You are not a member of <#${resolved.id}>; someone has to add you there first.`;
      if (created.error === "channel_canvas_already_exists")
        return `<#${resolved.id}> already has a channel canvas; read it with read-slack-canvas and change it with edit-slack-canvas, or pass a title to create a separate canvas.`;
      return `Could not create the canvas: ${created.error}`;
    }
    const canvasId = String(created.body.canvas_id);
    const link = await canvasLink(canvasId);
    return `Created ${useChannelCanvas ? "the channel canvas" : "a canvas"} in <#${resolved.id}>${link ? ` (${link})` : ""}. canvas_id: ${canvasId}`;
  },
});
