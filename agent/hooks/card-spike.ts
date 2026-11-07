import { defineHook } from "eve/hooks";
import { toolCtx } from "../../lib/agent/context.ts";
import { logger } from "../../lib/log.ts";
import { createElementScanner } from "../../lib/slack/card-scan.ts";
import { elementToBlock, parseElement } from "../../lib/slack/cards.ts";
import { getStream } from "../../lib/slack/stream.ts";

const log = logger("Agent.CardSpike");
const scanners = new Map<string, ReturnType<typeof createElementScanner>>();

export default defineHook({
  events: {
    "action.input.appended"(event, ctx) {
      const { toolName, callId, inputTextDelta, sequence } = event.data;
      if (toolName !== "card-spike") return;
      const tool = toolCtx(ctx);
      const channel = tool.msgCtx.channel;
      const threadTs = tool.msgCtx.threadTs;
      const stream = channel && threadTs ? getStream(channel, threadTs) : undefined;
      log.info(
        `delta seq=${sequence} len=${inputTextDelta.length} channel=${channel} thread=${threadTs} stream=${stream ? (stream.closed ? "closed" : "open") : "none"}`,
      );
      let scan = scanners.get(callId);
      if (!scan) {
        scan = createElementScanner();
        scanners.set(callId, scan);
      }
      const blocks = scan(inputTextDelta)
        .map(parseElement)
        .flatMap((element) => (element ? [elementToBlock(element)] : []));
      if (blocks.length > 0 && stream && !stream.closed) {
        log.info(`appending ${blocks.length} block(s) to the stream: ${JSON.stringify(blocks)}`);
        stream.blocks(blocks);
      }
    },

    "action.result"(event) {
      scanners.delete(event.data.result.callId);
    },
  },
});
