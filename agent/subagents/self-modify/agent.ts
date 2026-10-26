import { defineAgent, defineDynamic } from "eve";
import { requireAdmin, toolCtx } from "../../../lib/agent/context.ts";
import { CONTEXT_WINDOW_TOKENS } from "../../../lib/agent/model-router.ts";
import { BRAIN_MODEL, openrouterProvider } from "../../../lib/llm/index.ts";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const { userId } = toolCtx(ctx);
      if (!userId || (await requireAdmin(userId)) !== null) return null;
      return defineAgent({
        description:
          "Changes Manfrod's own source code (skills, tools, prompts, instructions) in a sandboxed checkout, verifies it, and opens a draft GitHub pull request for review. Admins only. Use it when an admin asks you to fix or change your own behavior. Brief it with the exact request, why it is needed (quote the relevant conversation or feedback) and what good behavior looks like. After calling it, wait for its result with eve__task_wait before replying, then share the pull request link.",
        defaultTools: false,
        modelContextWindowTokens: CONTEXT_WINDOW_TOKENS,
        model: openrouterProvider().chat(BRAIN_MODEL, { usage: { include: true } }),
      });
    },
  },
});
