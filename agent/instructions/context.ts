import { defineDynamic, defineInstructions } from "eve/instructions";
import { buildSystemPrompt, skillRunnerPrompt } from "../../lib/agent/system-prompt.ts";
import { isBackgroundKind, toolCtx } from "../../lib/agent/context.ts";
import { isRehearsal } from "../../lib/rehearsal/guard.ts";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const tool = toolCtx(ctx);
      if (isBackgroundKind(tool.kind)) {
        return defineInstructions({ content: await skillRunnerPrompt(tool.msgCtx.channel, tool.userId) });
      }
      const channel = isRehearsal(tool.kind) ? tool.msgCtx.channel : null;
      return defineInstructions({ content: await buildSystemPrompt(tool.userId, tool.sessionKey, tool.readableLevels, channel) });
    },
  },
});
