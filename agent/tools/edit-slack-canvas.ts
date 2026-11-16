import { z } from "zod";
import { getUser } from "../../lib/accounts.ts";
import { SELF_REVIEW_KIND } from "../../lib/self-review/rules.ts";
import { editCanvas, findCanvasSections, getFileInfo } from "../../lib/slack/api.ts";
import { canvasChannels, isChannelMember } from "../lib/slack.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Change a Slack canvas shared in a channel the person you act for is a member of: replace all of it, add markdown at its start or end, or replace or add after the section containing given text. Read it with read-slack-canvas first.",
  inputSchema: z.object({
    canvas_id: z.string().describe("Canvas/file ID, e.g. from create-slack-canvas or list-slack-canvases"),
    operation: z
      .enum(["replace", "insert_at_start", "insert_at_end", "insert_after"])
      .describe("replace: the whole canvas, or the section when section_text is given; insert_after needs section_text"),
    markdown: z.string().min(1).describe("Markdown to write"),
    section_text: z.string().optional().describe("Text of the section (heading, paragraph or table row) to replace or insert after"),
  }),
  label: { start: () => "Edit canvas" },
  async execute({ canvas_id, operation, markdown, section_text }, ctx) {
    if (ctx.kind === SELF_REVIEW_KIND) return "Self-review can't edit canvases.";
    const person = await getUser(ctx.userId);
    if (!person) return "I don't know who you are acting for, so I changed nothing.";
    const file = await getFileInfo(canvas_id);
    if (!file) return `Canvas not found: ${canvas_id}`;
    const channels = canvasChannels(file).filter((id) => !id.startsWith("D"));
    let allowed = false;
    for (const id of channels) if (!allowed) allowed = await isChannelMember(id, person.slackId);
    if (!allowed)
      return `This canvas is not shared in a channel ${person.name ?? person.slackId} is a member of, so you can't edit it for them.`;
    const change: Record<string, unknown> = { operation, document_content: { type: "markdown", markdown } };
    if (operation === "insert_after" && !section_text) return "insert_after needs section_text.";
    if (section_text && operation !== "insert_at_start" && operation !== "insert_at_end") {
      const sections = await findCanvasSections(canvas_id, section_text);
      if (!sections) return "Could not look up sections in the canvas.";
      if (sections.length === 0) return `No section contains: ${section_text}`;
      if (sections.length > 1) return `${sections.length} sections contain that text; give more specific section_text.`;
      change.section_id = sections[0];
    }
    const result = await editCanvas(canvas_id, change);
    if (!result.ok) return `Could not edit the canvas: ${result.error}`;
    return "Canvas updated.";
  },
});
