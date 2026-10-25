import { defineHook } from "eve/hooks";
import { toolCtx } from "../../../../lib/agent/context.ts";
import { setStatus } from "../../../../lib/slack/api.ts";
import { ensureStream, getStream } from "../../../../lib/slack/stream.ts";

const KEEPALIVE_MS = 60_000;

const titles = new Map<string, string>();
const keepAlives = new Map<string, NodeJS.Timeout>();

const humanize = (name: string) => {
  const spaced = name.replaceAll(/[_-]/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

function streamFor(ctx: Parameters<typeof toolCtx>[0]) {
  const { msgCtx } = toolCtx(ctx);
  if (!msgCtx.channel || !msgCtx.threadTs) return null;
  const existing = getStream(msgCtx.channel, msgCtx.threadTs);
  if (existing && !existing.closed) return { stream: existing, ...msgCtx };
  if (!msgCtx.slackUserId || msgCtx.slackUserId.startsWith("system:")) return { stream: null, ...msgCtx };
  const recipient = msgCtx.channel.startsWith("D") ? null : { userId: msgCtx.slackUserId, teamId: null };
  return { stream: ensureStream(msgCtx.channel, msgCtx.threadTs, recipient), ...msgCtx };
}

function stopKeepAlive(sessionId: string) {
  clearInterval(keepAlives.get(sessionId));
  keepAlives.delete(sessionId);
}

export default defineHook({
  events: {
    "turn.started"(_event, ctx) {
      const { msgCtx } = toolCtx(ctx);
      const { channel, threadTs } = msgCtx;
      if (!channel || !threadTs) return;
      stopKeepAlive(ctx.session.id);
      const timer = setInterval(() => getStream(channel, threadTs)?.keepAlive(), KEEPALIVE_MS);
      timer.unref();
      keepAlives.set(ctx.session.id, timer);
    },

    "turn.completed"(_event, ctx) {
      stopKeepAlive(ctx.session.id);
    },

    "turn.failed"(_event, ctx) {
      stopKeepAlive(ctx.session.id);
    },

    "turn.cancelled"(_event, ctx) {
      stopKeepAlive(ctx.session.id);
    },

    "actions.requested"(event, ctx) {
      const target = streamFor(ctx);
      if (!target) return;
      for (const action of event.data.actions) {
        const name = "toolName" in action ? action.toolName : action.kind;
        const title = `Self-modify: ${event.data.presentation?.[action.callId]?.label ?? humanize(name)}`;
        const id = `self-modify:${action.callId}`;
        if (target.stream) {
          target.stream.planDefault("Modyfikuję swój kod");
          target.stream.task({ id, title, status: "in_progress" });
          titles.set(action.callId, title);
        } else if (target.channel && target.threadTs) {
          void setStatus(target.channel, target.threadTs, `is ${title.toLowerCase()}...`);
        }
      }
    },

    "action.result"(event, ctx) {
      const result = event.data.result;
      const title = titles.get(result.callId);
      if (!title) return;
      titles.delete(result.callId);
      const target = streamFor(ctx);
      if (!target?.stream) return;
      const isError = "isError" in result && result.isError === true;
      target.stream.task({ id: `self-modify:${result.callId}`, title, status: isError ? "error" : "complete" });
    },
  },
});
