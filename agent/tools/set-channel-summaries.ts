import { z } from "zod";
import { channelSettings, setChannelSummaries } from "../../lib/nudges/store.ts";
import { channelFor } from "../lib/slack.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Turn the weekly project summary you post in a project channel on Friday afternoons on or off, or check whether it is on. Call it when someone in the channel asks you to stop or resume these summaries, and respect it from then on.",
  inputSchema: z.object({
    enabled: z.boolean().optional().describe("true to resume, false to stop; omit to only check"),
    channel: z.string().optional().describe("Channel name or ID; omit for the current channel"),
  }),
  async execute({ enabled, channel }, ctx) {
    const resolved = await channelFor(channel, ctx.msgCtx);
    if (!resolved.ok) return "Nie wiem, o który kanał chodzi.";
    if (enabled !== undefined) await setChannelSummaries(resolved.id, enabled);
    const { summaries } = await channelSettings(resolved.id);
    return summaries
      ? `Cotygodniowe podsumowania w <#${resolved.id}> są włączone.`
      : `Cotygodniowe podsumowania w <#${resolved.id}> są wyłączone.`;
  },
});
