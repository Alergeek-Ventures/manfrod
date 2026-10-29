import { defineSlackRenderer, type SlackEventContext } from "eve/channels/slack";
import { channelLanguage } from "../agent-settings.ts";
import { isEmptyReply } from "../agent/system-prompt.ts";
import { planTitle, threadTitle } from "../agent/titles.ts";
import { logger } from "../log.ts";
import { isUntitledProactiveThread, markProactiveThreadTitled } from "../proactive.ts";
import { isBackgroundKind, TASK_KIND, toolCtx, type ToolCtx } from "../agent/context.ts";
import { deleteMessage, post, setStatus, setTitle, type SlackBody } from "./api.ts";
import { feedbackBlock, feedbackChunk } from "./feedback.ts";
import { fromMarkdown, toBlocks } from "./mrkdwn.ts";
import { lastUserContent } from "./routing.ts";
import { TtlMap, shared } from "./state.ts";
import { ensureStream, getStream, type Recipient } from "./stream.ts";

const log = logger("Slack.ActivityHandler");
const PROVISIONAL_PLAN_TITLE = "Pracuję nad tym";
const MARKDOWN_BLOCK_LIMIT = 11_900;
const DETAILS_LIMIT = 120;

const titled = shared("titledThreads", () => new TtlMap<string, true>(24 * 60 * 60 * 1000));
const plannedTurns = shared("plannedTurns", () => new TtlMap<string, true>(60 * 60 * 1000));

interface Where {
  channel: string;
  threadTs: string | null;
  tool: ToolCtx;
}

function where(channel: SlackEventContext, ctx: Parameters<typeof toolCtx>[0]): Where | null {
  const tool = toolCtx(ctx);
  const channelId = channel.state.channelId ?? tool.msgCtx.channel;
  if (!channelId) return null;
  return { channel: channelId, threadTs: channel.state.threadTs ?? tool.msgCtx.threadTs, tool };
}

const humanize = (name: string) => {
  const spaced = name.replaceAll(/[_-]/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
};

function argsPreview(input: unknown): string | null {
  if (!input || typeof input !== "object" || Object.keys(input).length === 0) return null;
  const parts = Object.entries(input as Record<string, unknown>).flatMap(([key, value]) => {
    if (typeof value === "string") return [`${key}: ${value.slice(0, 60)}`];
    if (typeof value === "number" || typeof value === "boolean") return [`${key}: ${value}`];
    return [];
  });
  return parts.join(", ").slice(0, DETAILS_LIMIT) || null;
}

function resultSummary(output: unknown): string | null {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return null;
  const first = lines[0].slice(0, DETAILS_LIMIT);
  return lines.length === 1 ? first : `${first} (+${lines.length - 1} lin.)`;
}

function recipient(where: Where, channel: SlackEventContext): Recipient | null | "unsupported" {
  if (where.channel.startsWith("D")) return null;
  const userId = where.tool.msgCtx.slackUserId ?? channel.state.triggeringUserId ?? null;
  if (!userId || userId.startsWith("system:")) return "unsupported";
  return { userId, teamId: channel.state.teamId ?? null };
}

function streamFor(where: Where, channel: SlackEventContext) {
  if (!where.threadTs) return null;
  const existing = getStream(where.channel, where.threadTs);
  if (existing && !existing.closed) return existing;
  if (where.tool.kind === "skill_channel") return null;
  const target = recipient(where, channel);
  if (target === "unsupported") return null;
  return ensureStream(where.channel, where.threadTs, target);
}

async function postReply(where: Where, content: string, withFeedback: boolean) {
  const { text, blocks } = toBlocks(content);
  const body: SlackBody = { channel: where.channel, text };
  if (where.threadTs) body.thread_ts = where.threadTs;
  const bodyBlocks = blocks ?? (content.length <= MARKDOWN_BLOCK_LIMIT ? [{ type: "markdown", text: content }] : null);
  if (bodyBlocks) body.blocks = withFeedback ? [...bodyBlocks, feedbackBlock(where.tool.sessionKey)] : bodyBlocks;
  const result = await post("chat.postMessage", body);
  if (!result.ok) throw new Error(`chat.postMessage failed: ${result.error}`);
}

async function titleThreads(where: Where, content: string) {
  if (!where.threadTs) return;
  const threadTs = where.threadTs;
  let pending: Promise<string> | null = null;
  const title = () => (pending ??= threadTitle(content));
  if (await isUntitledProactiveThread(where.channel, threadTs)) {
    await markProactiveThreadTitled(threadTs);
    void title().then(async (text) => {
      const result = await post("chat.update", { channel: where.channel, ts: threadTs, text });
      if (!result.ok) log.error(`Slack ActivityHandler failed to update thread title in ${where.channel}: ${result.error}`);
    });
  }
  const key = `${where.channel}:${threadTs}`;
  if (where.channel.startsWith("D") && !titled.has(key)) {
    titled.set(key, true);
    void title().then(async (text) => {
      const result = await setTitle(where.channel, threadTs, text);
      if (!result.ok) log.warn(`Slack ActivityHandler failed to set thread title in ${where.channel}: ${result.error}`);
    });
  }
}

async function deliverFinal(where: Where, rawContent: string) {
  const content = rawContent.trim() === "" ? "👍" : rawContent;
  const skill = isBackgroundKind(where.tool.kind);
  const stream = where.threadTs ? getStream(where.channel, where.threadTs) : undefined;

  if ((skill || where.tool.kind === TASK_KIND) && isEmptyReply(content)) {
    await stream?.abort();
    if (where.tool.kind === "skill_user" && where.threadTs) await deleteMessage(where.channel, where.threadTs);
    return;
  }

  if (where.tool.kind === "skill_channel") {
    await stream?.abort();
    await post("chat.postMessage", { channel: where.channel, text: fromMarkdown(content) });
    return;
  }

  let delivered = false;
  if (stream && !stream.closed) {
    const outcome = await stream.finish(content, skill ? [] : [feedbackChunk(where.tool.sessionKey)]);
    delivered = outcome !== "not_streaming";
  }
  if (!delivered) {
    if (skill) {
      const body: SlackBody = { channel: where.channel, text: fromMarkdown(content) };
      if (where.threadTs) body.thread_ts = where.threadTs;
      await post("chat.postMessage", body);
    } else {
      await postReply(where, content, true);
    }
  }
  await titleThreads(where, content);
}

export const manfrodRenderer = defineSlackRenderer({
  received() {},
  events: {
    async "turn.started"(_event, channel, ctx) {
      const at = where(channel, ctx);
      if (!at?.threadTs) return;
      const stream = getStream(at.channel, at.threadTs);
      if (stream && !stream.closed) return;
      if (await isUntitledProactiveThread(at.channel, at.threadTs)) return;
      void setStatus(at.channel, at.threadTs, "is thinking...");
    },

    "step.started"() {},
    "reasoning.appended"() {},
    "reasoning.completed"() {},
    "action.partial"() {},

    "message.appended"(event, channel, ctx) {
      const at = where(channel, ctx);
      if (!at || at.tool.kind === "skill_channel") return;
      streamFor(at, channel)?.text(event.messageDelta);
    },

    "actions.requested"(event, channel, ctx) {
      const at = where(channel, ctx);
      if (!at) return;
      const stream = streamFor(at, channel);
      if (!stream) {
        const [first] = event.actions;
        const name = first && "toolName" in first ? first.toolName : "a tool";
        if (at.threadTs) void setStatus(at.channel, at.threadTs, `is using ${name}...`);
        return;
      }
      stream.planDefault(PROVISIONAL_PLAN_TITLE);
      for (const action of event.actions) {
        const name = "toolName" in action ? action.toolName : action.kind;
        stream.task({
          id: action.callId,
          title: humanize(name),
          status: "in_progress",
          details: argsPreview("input" in action ? action.input : null),
        });
      }
      const turnKey = `${ctx.session.id}:${event.turnId}`;
      if (!plannedTurns.has(turnKey) && at.tool.sessionKey) {
        plannedTurns.set(turnKey, true);
        const request = lastUserContent(at.tool.sessionKey);
        if (request) {
          void channelLanguage(at.channel)
            .then(({ name }) => planTitle(request, name))
            .then((title) => {
              if (title && !stream.closed) stream.plan(title);
            });
        }
      }
    },

    "action.result"(event, channel, ctx) {
      const at = where(channel, ctx);
      if (!at?.threadTs) return;
      const stream = getStream(at.channel, at.threadTs);
      if (!stream || stream.closed) return;
      const result = event.result;
      const isError = "isError" in result && result.isError === true;
      stream.task({
        id: result.callId,
        title: humanize("toolName" in result ? result.toolName : result.kind),
        status: isError ? "error" : "complete",
        output: resultSummary("output" in result ? result.output : null),
      });
    },

    async "message.completed"(event, channel, ctx) {
      if (event.finishReason === "tool-calls") return;
      const at = where(channel, ctx);
      if (!at) return;
      await deliverFinal(at, event.message ?? "");
    },

    "session.waiting"() {},
  },
});
