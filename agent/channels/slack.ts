import type { RouteHandlerArgs } from "eve/channels";
import { slackChannel, type SlackChannelState, type SlackInboundMessageContext, type SlackMessage } from "eve/channels/slack";
import { getUserBySlackId } from "../../lib/accounts.ts";
import { logger } from "../../lib/log.ts";
import { setStatus, setSuggestedPrompts } from "../../lib/slack/api.ts";
import { handleSlashCommand } from "../../lib/slack/commands.ts";
import { interceptInteractivity } from "../../lib/slack/interactivity.ts";
import { runKick } from "../../lib/slack/kick.ts";
import { post } from "../../lib/slack/api.ts";
import { manfrodRenderer } from "../../lib/slack/renderer.ts";
import { handleMessage, inboundFromRaw, type Dispatcher } from "../../lib/slack/routing.ts";
import { userContext } from "../../lib/slack/state.ts";
import { buildPrompts } from "../../lib/slack/suggested-prompts.ts";

const log = logger("Slack.EventHandler");
const KICK_CALLBACK_ID = "kick_manfrod";

function dispatcher(ctx: SlackInboundMessageContext): Dispatcher {
  return {
    send: (content, options) =>
      ctx.send(content, {
        auth: options.auth,
        context: options.context,
        history: options.history,
        turnPolicy: options.turnPolicy,
      }),
    isSubscribed: () => ctx.isSubscribed(),
    reset: (reason) => ctx.reset({ reason }),
  };
}

async function reportFailure(message: SlackMessage, error: unknown) {
  log.error(`Slack EventHandler failed for ${message.channelId}/${message.ts}: ${(error as Error).stack ?? error}`);
  const threadTs = message.threadTs ?? message.ts;
  await setStatus(message.channelId, threadTs, "");
  await post("chat.postMessage", {
    channel: message.channelId,
    thread_ts: threadTs,
    text: "Sorry, I encountered an error and couldn't answer. Please try again in a moment.",
  });
}

function route(ctx: SlackInboundMessageContext, message: SlackMessage, isMention: boolean) {
  void handleMessage(inboundFromRaw(message.raw, message.channelId), dispatcher(ctx), isMention).catch((error) =>
    reportFailure(message, error).catch((reportError) =>
      log.error(`Slack EventHandler could not report failure: ${(reportError as Error).message}`),
    ),
  );
  return null;
}

async function suggestPrompts(slackUserId: string | undefined, channelId: string | undefined, threadTs: string | undefined) {
  if (!slackUserId || !channelId) return;
  const prompts = await buildPrompts(await getUserBySlackId(slackUserId), slackUserId);
  const result = await setSuggestedPrompts(channelId, threadTs, prompts);
  if (!result.ok) log.debug(`Slack EventHandler could not set suggested prompts in ${channelId}: ${result.error}`);
}

const base = slackChannel({
  turnPolicy: "steer",
  renderers: [manfrodRenderer],

  onDirectMessage: (ctx, message) => route(ctx, message, false),
  onAppMention: (ctx, message) => route(ctx, message, true),
  onMessage: (ctx, message) => route(ctx, message, false),

  async onEvent(_ctx, event) {
    const data = event as Record<string, any>;
    switch (event.type) {
      case "assistant_thread_started": {
        const thread = data.assistant_thread ?? {};
        userContext.put(thread.user_id, thread.context);
        await suggestPrompts(thread.user_id, thread.channel_id, thread.thread_ts);
        return;
      }
      case "app_home_opened":
        userContext.put(data.user, data.app_context);
        if (data.tab === undefined || data.tab === null || data.tab === "messages") {
          await suggestPrompts(data.user, data.channel, data.thread_ts);
        }
        return;
      case "app_context_changed":
        userContext.put(data.user, data.app_context);
        return;
      default:
        log.debug(`Slack EventHandler ignoring event type: ${event.type}`);
    }
  },

  async onShortcut(shortcut) {
    if (shortcut.type !== "message_action" || shortcut.callbackId !== KICK_CALLBACK_ID) return;
    const threadTs = shortcut.message.threadTs ?? shortcut.message.ts;
    const user = await getUserBySlackId(shortcut.user.id);
    const result = await runKick(shortcut.channelId, threadTs, {
      userId: user?.id ?? null,
      slackUserId: shortcut.user.id,
      source: "shortcut",
    });
    if (result === "already_kicked") {
      await post("chat.postEphemeral", {
        channel: shortcut.channelId,
        thread_ts: threadTs,
        user: shortcut.user.id,
        text: "Już mnie tu nie ma — oznacz mnie `@Manfrod`, jeśli mam wrócić.",
      });
    }
  },

  async onSlashCommand(command) {
    await handleSlashCommand({
      command: command.command,
      text: command.text,
      userId: command.user.id,
      channelId: command.channelId,
      channelName: command.channelName,
    });
  },
});

async function withInteractivity(
  request: Request,
  args: RouteHandlerArgs<SlackChannelState>,
  handler: (request: Request, args: RouteHandlerArgs<SlackChannelState>) => Response | Promise<Response>,
): Promise<Response> {
  if (request.method !== "POST") return handler(request, args);
  const body = await request.text();
  const intercepted = interceptInteractivity(request.headers, body);
  if (intercepted) {
    args.waitUntil(intercepted.work);
    return intercepted.response;
  }
  return handler(new Request(request.url, { method: request.method, headers: request.headers, body }), args);
}

const channel: typeof base = {
  ...base,
  routes: base.routes.map((definition) =>
    definition.transport === "websocket"
      ? definition
      : {
          ...definition,
          handler: (request: Request, args: RouteHandlerArgs<SlackChannelState>) =>
            withInteractivity(request, args, definition.handler as never),
        },
  ),
};

export default channel;
