import { z } from "zod";
import { getChannelCanvasId, resolveChannel } from "../../lib/slack/api.ts";
import { errorText, readCanvas } from "../lib/slack.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Read the full markdown content of a Slack canvas. Give a channel to read that channel's pinned canvas, or a specific canvas/file ID (from list-slack-canvases) to read a particular one.",
  inputSchema: z.object({
    channel: z.string().optional().describe("Channel name or ID whose pinned canvas to read. Ignored if canvas_id is given."),
    canvas_id: z.string().optional().describe("Specific canvas/file ID to read, e.g. from list-slack-canvases (e.g. 'F123ABC')"),
  }),
  async execute({ channel, canvas_id }) {
    if (canvas_id) return readCanvas(canvas_id);
    if (!channel) return "Podaj channel lub canvas_id.";
    const resolved = await resolveChannel(channel);
    if (!resolved.ok) {
      return resolved.error === "not_found"
        ? `Nie znalazłem kanału: ${channel}`
        : `Nie udało się odczytać canvasu: ${errorText(resolved.error)}`;
    }
    const fileId = await getChannelCanvasId(resolved.id);
    if (fileId === undefined) return "Nie udało się odczytać canvasu: :api_error";
    if (fileId === null) return "Ten kanał nie ma przypiętego canvasu.";
    return readCanvas(fileId);
  },
});
