import { z } from "zod";
import { lookupCanvasSections } from "../../lib/slack/api.ts";
import { canvasErrorText, resolveCanvas } from "../lib/slack.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Find section IDs in a Slack canvas (a channel's pinned canvas or a specific canvas ID) to target with edit-slack-canvas, e.g. the heading of a month. Filter by section type and/or text the section contains.",
  inputSchema: z.object({
    channel: z.string().optional().describe("Channel name or ID whose pinned canvas to search. Ignored if canvas_id is given."),
    canvas_id: z.string().optional().describe("Specific canvas/file ID, e.g. from list-slack-canvases (e.g. 'F123ABC')"),
    section_types: z
      .array(z.enum(["h1", "h2", "h3", "any_header"]))
      .optional()
      .describe("Section types to match, e.g. ['any_header']"),
    contains_text: z.string().optional().describe("Text the section must contain, e.g. a heading title"),
  }),
  async execute({ channel, canvas_id, section_types, contains_text }) {
    if (!section_types?.length && !contains_text?.trim()) return "Give section_types or contains_text.";
    const canvas = await resolveCanvas(channel, canvas_id);
    if (!canvas.ok) return canvas.message;
    const result = await lookupCanvasSections(canvas.id, { sectionTypes: section_types, containsText: contains_text?.trim() });
    if (!result.ok) return `Could not look up sections: ${canvasErrorText(result.error, "canvases:read")}`;
    if (result.ids.length === 0) return `No matching sections in canvas ${canvas.id}.`;
    return `Canvas ${canvas.id}, matching section IDs:\n${result.ids.join("\n")}`;
  },
});
