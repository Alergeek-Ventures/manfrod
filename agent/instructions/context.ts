import { defineDynamic, defineInstructions } from "eve/instructions";
import { buildSystemPrompt, skillRunnerPrompt } from "../../lib/agent/system-prompt.ts";
import { toolCtx } from "../../lib/tools/context.ts";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const tool = toolCtx(ctx);
      if (tool.kind === "skill_channel" || tool.kind === "skill_user") {
        return defineInstructions({ content: await skillRunnerPrompt() });
      }
      return defineInstructions({ content: await buildSystemPrompt(tool.userId, tool.sessionKey) });
    },
  },
});
