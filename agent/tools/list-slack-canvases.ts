import { z } from "zod";
import { getChannelCanvasId, listCanvases, resolveChannel } from "../../lib/slack/api.ts";
import { errorText } from "../lib/slack.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "List canvases (document-like pages) attached to a Slack channel, including its pinned channel canvas if it has one. Use before read-slack-canvas if you don't already know which canvas or file ID to read.",
  inputSchema: z.object({
    channel: z.string().describe("Channel name (e.g. 'general' or '#general') or Slack channel ID"),
  }),
  async execute({ channel }) {
    const resolved = await resolveChannel(channel);
    if (!resolved.ok) {
      return resolved.error === "not_found"
        ? `Nie znalazłem kanału: ${channel}`
        : `Nie udało się pobrać listy canvasów: ${errorText(resolved.error)}`;
    }
    const files = await listCanvases(resolved.id);
    if (!files) return "Nie udało się pobrać listy canvasów: :api_error";
    if (files.length === 0) return "Brak canvasów w tym kanale.";
    const pinned = (await getChannelCanvasId(resolved.id)) ?? null;
    return files.map((file) => `${file.id}: ${file.title ?? "(bez tytułu)"}${file.id === pinned ? " [canvas kanału]" : ""}`).join("\n");
  },
});
