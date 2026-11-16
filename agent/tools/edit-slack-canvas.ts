import { z } from "zod";
import { getUser } from "../../lib/accounts.ts";
import { SELF_REVIEW_KIND } from "../../lib/self-review/rules.ts";
import { editCanvas } from "../../lib/slack/api.ts";
import { canvasErrorText, isChannelMember, resolveCanvas } from "../lib/slack.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

const NEEDS_SECTION = new Set(["insert_after", "insert_before", "delete"]);

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Edit a Slack canvas: a channel's pinned canvas or a specific canvas ID. Only edit when someone asked for that change. Always read the canvas first with read-slack-canvas and preserve its existing structure, headings and wording. To add something at the top or bottom use insert_at_start / insert_at_end; to put content before or after a heading, or to replace or delete a heading section, get its section_id from find-slack-canvas-sections. Markdown tables can't be edited cell by cell: to fill in or change a table row, replace the whole canvas (replace without section_id) with its complete markdown, identical to what you read except for that row. To add e.g. a new month, insert a heading with its table at the right place instead of rewriting the canvas.",
  inputSchema: z.object({
    channel: z.string().optional().describe("Channel name or ID whose pinned canvas to edit. Ignored if canvas_id is given."),
    canvas_id: z.string().optional().describe("Specific canvas/file ID to edit, e.g. from list-slack-canvases (e.g. 'F123ABC')"),
    operation: z
      .enum(["insert_at_start", "insert_at_end", "insert_after", "insert_before", "replace", "delete"])
      .describe(
        "insert_after/insert_before/delete need section_id; replace without section_id replaces the whole canvas, with section_id only that section",
      ),
    markdown: z.string().optional().describe("Markdown content to insert or replace with; required for every operation except delete"),
    section_id: z.string().optional().describe("Section ID from find-slack-canvas-sections"),
  }),
  label: { start: ({ channel, canvas_id }) => `Edit canvas ${canvas_id ?? channel ?? ""}`.trim() },
  async execute({ channel, canvas_id, operation, markdown, section_id }, ctx) {
    if (ctx.kind === SELF_REVIEW_KIND) return "Self-review can't edit canvases.";
    if (NEEDS_SECTION.has(operation) && !section_id) return `${operation} needs a section_id; find it with find-slack-canvas-sections.`;
    if (operation !== "delete" && !markdown?.trim()) return `${operation} needs markdown content.`;
    const canvas = await resolveCanvas(channel, canvas_id);
    if (!canvas.ok) return canvas.message;
    if (canvas.channelId && !canvas.channelId.startsWith("D")) {
      const person = await getUser(ctx.userId);
      if (!person) return "I don't know who you are acting for, so I changed nothing.";
      if (!(await isChannelMember(canvas.channelId, person.slackId)))
        return `${person.name ?? person.slackId} is not a member of <#${canvas.channelId}>, so you can't edit its canvas for them.`;
    }
    const result = await editCanvas(canvas.id, {
      operation,
      ...(operation === "delete" ? {} : { markdown }),
      ...(section_id ? { sectionId: section_id } : {}),
    });
    if (!result.ok) return `Could not edit the canvas: ${canvasErrorText(result.error, "canvases:write")}`;
    return `Canvas ${canvas.id} updated (${operation}${section_id ? ` on section ${section_id}` : ""}).`;
  },
});
