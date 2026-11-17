import { defineHook } from "eve/hooks";
import { toolCtx } from "../../../../lib/agent/context.ts";
import { isRehearsal } from "../../../../lib/rehearsal/guard.ts";

export default defineHook({
  events: {
    "turn.started"(_event, ctx) {
      if (isRehearsal(toolCtx(ctx).kind)) ctx.cancel();
    },
  },
});
