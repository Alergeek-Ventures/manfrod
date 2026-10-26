import { defineDynamic, defineInstructions } from "eve/instructions";
import { buildSystemPrompt, skillRunnerPrompt } from "../../lib/agent/system-prompt.ts";
import { isBackgroundKind, toolCtx } from "../../lib/agent/context.ts";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const tool = toolCtx(ctx);
      if (isBackgroundKind(tool.kind)) {
        return defineInstructions({ content: await skillRunnerPrompt() });
      }
      return defineInstructions({ content: await buildSystemPrompt(tool.userId, tool.sessionKey, tool.readableLevels) });
    },
  },
});
