import { defineHook } from "eve/hooks";
import { toolCtx } from "../../lib/agent/context.ts";
import { logger } from "../../lib/log.ts";
import { createElementScanner } from "../../lib/slack/card-scan.ts";
import { elementToBlock, parseElement } from "../../lib/slack/cards.ts";
import { TtlMap } from "../../lib/slack/state.ts";
import { getStream } from "../../lib/slack/stream.ts";

const log = logger("Agent.CardSpike");
const MAX_BLOCKS_PER_CALL = 40;
const MAX_TABLES_PER_CALL = 1;

interface CallState {
  scan: ReturnType<typeof createElementScanner>;
  blocks: number;
  tables: number;
}

const calls = new TtlMap<string, CallState>(15 * 60 * 1000);

function describe(blocks: Record<string, unknown>[]): string {
  return blocks.map((block) => `${String(block.type)}:${JSON.stringify(block).length}`).join(",");
}

export default defineHook({
  events: {
    "action.input.appended"(event, ctx) {
      const { toolName, callId, inputTextDelta, sequence } = event.data;
      if (toolName !== "card-spike") return;
      const tool = toolCtx(ctx);
      const channel = tool.msgCtx.channel;
      const threadTs = tool.msgCtx.threadTs;
      if (tool.kind !== "slack" || !channel?.startsWith("D") || !threadTs) return;

      const stream = getStream(channel, threadTs);
      log.info(
        `delta call=${callId} seq=${sequence} len=${inputTextDelta.length} stream=${stream ? (stream.closed ? "closed" : "open") : "none"}`,
      );
      let state = calls.get(callId);
      if (!state) {
        state = { scan: createElementScanner(), blocks: 0, tables: 0 };
        calls.set(callId, state);
      }

      const raw = state.scan(inputTextDelta);
      if (raw.length === 0) return;
      const dropped = { invalid: 0, limit: 0 };
      const blocks: Record<string, unknown>[] = [];
      for (const json of raw) {
        const element = parseElement(json);
        if (!element) {
          dropped.invalid += 1;
          continue;
        }
        const isTable = element.type === "table";
        if (state.blocks >= MAX_BLOCKS_PER_CALL || (isTable && state.tables >= MAX_TABLES_PER_CALL)) {
          dropped.limit += 1;
          continue;
        }
        state.blocks += 1;
        if (isTable) state.tables += 1;
        blocks.push(elementToBlock(element));
      }
      if (dropped.invalid > 0) log.warn(`dropped ${dropped.invalid} element(s) call=${callId} reason=invalid`);
      if (dropped.limit > 0) log.warn(`dropped ${dropped.limit} element(s) call=${callId} reason=limit`);
      if (blocks.length === 0) return;
      if (!stream || stream.closed) {
        log.warn(`dropped ${blocks.length} block(s) call=${callId} reason=${stream ? "closed" : "no stream"}`);
        return;
      }
      log.info(`appending ${blocks.length} block(s) call=${callId} [${describe(blocks)}]`);
      stream.blocks(blocks);
    },

    "action.result"(event) {
      calls.delete(event.data.result.callId);
    },
  },
});
