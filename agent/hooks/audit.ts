import { randomBytes } from "node:crypto";
import { defineHook } from "eve/hooks";
import { clearActiveAuthor, endTurn, setActiveAuthor, startTurn, turnFor } from "../../lib/agent/turns.ts";
import { broadcast, emit } from "../../lib/events/index.ts";
import { EVENTS, sendEvent } from "../../lib/inngest/client.ts";
import { cost } from "../../lib/pricing.ts";
import { createMessage } from "../../lib/memory/messages.ts";
import { logger } from "../../lib/log.ts";
import { toolCtx, type ToolCtx } from "../../lib/tools/context.ts";

const log = logger("Agent.Server");
const actionIds = new Map<string, string>();

function eventCtx(tool: ToolCtx) {
  return {
    userId: tool.userId || null,
    sessionKey: tool.sessionKey,
    source: tool.kind === "slack" ? "slack" : "proactive",
  };
}

function baseMeta(tool: ToolCtx) {
  return { write_access: tool.writeAccess, slack_channel_id: tool.msgCtx.channel };
}

const truncate = (text: string) => (text.length > 500 ? `${text.slice(0, 497)}...` : text);

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output) ?? "";
}

export default defineHook({
  events: {
    "turn.started"(_event, ctx) {
      const tool = toolCtx(ctx);
      startTurn(ctx.session.id, tool.userId);
      if (tool.sessionKey) setActiveAuthor(tool.sessionKey, tool.userId);
      emit("thinking", { ...eventCtx(tool), meta: baseMeta(tool) });
    },

    "step.started"(event, ctx) {
      const tool = toolCtx(ctx);
      const turn = turnFor(ctx.session.id) ?? startTurn(ctx.session.id, tool.userId);
      turn.stepStartedAt = Date.now();
      turn.modelId = event.data.modelId.replace(/^openrouter\//, "");
      emit("llm_call_started", {
        ...eventCtx(tool),
        source: "llm",
        meta: { model: turn.modelId, provider: "openrouter", tier: "paid", purpose: "agent", attempt: 1 },
      });
    },

    "step.completed"(event, ctx) {
      const tool = toolCtx(ctx);
      const turn = turnFor(ctx.session.id);
      const model = turn?.modelId ?? "unknown";
      const usage = event.data.usage ?? {};
      const tokens = {
        input_tokens: usage.inputTokens ?? 0,
        output_tokens: usage.outputTokens ?? 0,
        cached_tokens: usage.cacheReadTokens ?? 0,
        cache_creation_tokens: usage.cacheWriteTokens ?? 0,
      };
      emit("llm_call_succeeded", {
        ...eventCtx(tool),
        source: "llm",
        meta: {
          model,
          provider: "openrouter",
          tier: "paid",
          purpose: "agent",
          latency_ms: turn ? Date.now() - turn.stepStartedAt : null,
          total_tokens: tokens.input_tokens + tokens.output_tokens,
          cost_usd: usage.costUsd ?? cost(model, tokens),
          ...tokens,
        },
      });
    },

    "step.failed"(event, ctx) {
      const tool = toolCtx(ctx);
      emit("llm_call_failed", {
        ...eventCtx(tool),
        source: "llm",
        meta: { model: turnFor(ctx.session.id)?.modelId ?? "unknown", provider: "openrouter", tier: "paid", purpose: "agent", error: event.data.message },
      });
    },

    "actions.requested"(event, ctx) {
      const tool = toolCtx(ctx);
      const turn = turnFor(ctx.session.id);
      log.info(`Agent.Server executing ${event.data.actions.length} tool(s) for user ${tool.userId}`);
      for (const action of event.data.actions) {
        const actionId = randomBytes(8).toString("hex");
        actionIds.set(action.callId, actionId);
        turn?.actionStartedAt.set(action.callId, Date.now());
        const name = "toolName" in action ? action.toolName : action.kind;
        const input = "input" in action ? action.input : {};
        emit("action_started", {
          ...eventCtx(tool),
          meta: { action_id: actionId, action: name, args: JSON.stringify(input) },
        });
      }
    },

    "action.result"(event, ctx) {
      const tool = toolCtx(ctx);
      const result = event.data.result;
      const callId = result.callId;
      const startedAt = turnFor(ctx.session.id)?.actionStartedAt.get(callId);
      const isError = "isError" in result ? result.isError === true : false;
      emit("action_completed", {
        ...eventCtx(tool),
        meta: {
          action_id: actionIds.get(callId) ?? callId,
          action: "toolName" in result ? result.toolName : result.kind,
          result: truncate(outputText("output" in result ? result.output : "")),
          duration_ms: startedAt ? Date.now() - startedAt : null,
          success: !isError,
        },
      });
      actionIds.delete(callId);
    },

    async "message.completed"(event, ctx) {
      const tool = toolCtx(ctx);
      const text = event.data.message ?? "";
      if (event.data.finishReason === "tool-calls") {
        if (text.trim() !== "") emit("narrating", { ...eventCtx(tool), meta: { text } });
        return;
      }
      const content = text.trim() === "" ? "👍" : text;
      if (tool.sessionKey && tool.userId) {
        try {
          await createMessage(tool.userId, {
            role: "assistant",
            content,
            sessionKey: tool.sessionKey,
            receivedAt: new Date(Math.floor(Date.now() / 1000) * 1000),
          });
        } catch (error) {
          log.error(`Agent.Server failed to persist assistant message for user ${tool.userId}: ${(error as Error).message}`);
        }
        await sendEvent(EVENTS.sessionActivity, {
          sessionKey: tool.sessionKey,
          writeAccess: tool.writeAccess,
          slackChannelId: tool.msgCtx.channel,
        });
      }
      await broadcast("responding", { ...eventCtx(tool), meta: { content } });
      log.info(`Agent.Server broadcast response for user ${tool.userId} (${tool.kind})`);
    },

    "turn.completed"(_event, ctx) {
      finish(ctx);
    },
    "turn.failed"(_event, ctx) {
      finish(ctx);
    },
    "turn.cancelled"(_event, ctx) {
      finish(ctx);
    },
  },
});

function finish(ctx: Parameters<typeof toolCtx>[0] & { session: { id: string } }) {
  const tool = toolCtx(ctx);
  endTurn(ctx.session.id);
  if (tool.sessionKey) clearActiveAuthor(tool.sessionKey);
}
