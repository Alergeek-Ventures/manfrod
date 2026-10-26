import { z } from "zod";
import { NUDGE_KINDS, preferences, setPreference, type NudgeKind } from "../../lib/nudges/store.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

const kinds = Object.keys(NUDGE_KINDS) as [NudgeKind, ...NudgeKind[]];

export default defineManfrodTool({
  description: `Show or change which messages you send this person on your own initiative. Call it whenever they say they don't want some of them any more, or want them back, and respect it from then on; call it without changes to see their current settings. Kinds: ${kinds.map((kind) => `"${kind}" (${NUDGE_KINDS[kind]})`).join(", ")}.`,
  inputSchema: z.object({
    changes: z
      .array(z.object({ kind: z.enum(kinds), enabled: z.boolean() }))
      .optional()
      .describe("Kinds to turn on or off; omit to only read the settings"),
  }),
  async execute({ changes }, ctx) {
    for (const change of changes ?? []) await setPreference(ctx.userId, change.kind, change.enabled);
    const current = await preferences(ctx.userId);
    return kinds.map((kind) => `- ${kind}: ${current[kind] ? "włączone" : "wyłączone"} (${NUDGE_KINDS[kind]})`).join("\n");
  },
});
