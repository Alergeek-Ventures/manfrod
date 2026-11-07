import { defineHook } from "eve/hooks";
import { toolCtx } from "../../lib/agent/context.ts";
import { logger } from "../../lib/log.ts";
import { cancelCardCall, cardStreamThread, endCardTurn, streamCardInput } from "../../lib/slack/card-stream.ts";

const log = logger("Agent.CardStream");
const TOOL_NAME = "show-card";

export default defineHook({
  events: {
    "action.input.appended"(event, ctx) {
      const { toolName, callId, inputTextDelta, turnId } = event.data;
      if (toolName !== TOOL_NAME) return;
      const thread = cardStreamThread(toolCtx(ctx));
      if (!thread) return;
      const batch = streamCardInput(callId, thread, inputTextDelta, turnId ?? null);
      if (!batch) return;
      const blocks = batch.blocks.map((block) => `${block.type}:${block.length}`).join(",");
      log.info(`call=${callId} streamed=[${blocks}] dropped=${batch.dropped}`);
    },

    "action.result"(event) {
      const { result } = event.data;
      if ("toolName" in result && result.toolName !== TOOL_NAME) return;
      cancelCardCall(result.callId);
    },

    "turn.completed"(event) {
      endCardTurn(event.data.turnId);
    },

    "turn.failed"(event) {
      endCardTurn(event.data.turnId);
    },

    "turn.cancelled"(event) {
      endCardTurn(event.data.turnId);
    },
  },
});
