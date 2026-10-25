import { disconnect } from "../linear/index.ts";
import { CONNECT_CALLBACK_ID, getProject, handleConnectSubmission, openConnectModal, refresh } from "../linear/status.ts";
import { logger } from "../log.ts";
import { preselectedLevels, resolveEscalation } from "../memory/classifier.ts";
import { FEEDBACK_ACTION_ID, recordFeedback, REMOVE_ACTION_ID, removeMessage } from "./feedback.ts";
import { verifySlackSignature } from "./verify.ts";

const log = logger("Slack.EventHandler");

const OWNED_ACTIONS = new Set([
  "linear_connect",
  "linear_disconnect",
  FEEDBACK_ACTION_ID,
  REMOVE_ACTION_ID,
  "memory_escalation_save",
  "memory_escalation_cancel",
  "memory_escalation_levels",
]);

const LEVELS_BLOCK_ID = "memory_escalation_levels_block";
const LEVELS_ACTION_ID = "memory_escalation_levels";

const clicker = (payload: Record<string, any>) => ({
  slackUserId: payload.user?.id as string | undefined,
  threadTs: (payload.message?.thread_ts ?? payload.container?.thread_ts) as string | undefined,
});

async function selectedLevels(payload: Record<string, any>, botTs: string): Promise<string[]> {
  const options = payload.state?.values?.[LEVELS_BLOCK_ID]?.[LEVELS_ACTION_ID]?.selected_options;
  if (Array.isArray(options)) return options.flatMap((option) => (typeof option?.value === "string" ? [option.value] : []));
  return preselectedLevels(botTs);
}

async function handleBlockActions(payload: Record<string, any>) {
  const action = payload.actions?.[0] ?? {};
  const channelId: string | undefined = payload.channel?.id;
  const botTs: string | undefined = payload.message?.ts;

  switch (action.action_id) {
    case "linear_connect":
      await openConnectModal(payload.trigger_id, action.value, payload.response_url ?? null);
      return;
    case "linear_disconnect": {
      await disconnect(action.value);
      const project = await getProject(action.value);
      if (project) await refresh(payload.response_url, project);
      return;
    }
  }
  if (!channelId || !botTs) return;
  switch (action.action_id) {
    case FEEDBACK_ACTION_ID:
      await recordFeedback(payload, action);
      return;
    case REMOVE_ACTION_ID:
      await removeMessage(channelId, botTs);
      return;
    case "memory_escalation_save":
      await resolveEscalation("save", await selectedLevels(payload, botTs), channelId, botTs, clicker(payload));
      return;
    case "memory_escalation_cancel":
      await resolveEscalation("cancel", [], channelId, botTs, clicker(payload));
      return;
    default:
      return;
  }
}

export interface Intercepted {
  response: Response;
  work: Promise<void>;
}

export function interceptInteractivity(headers: Headers, body: string): Intercepted | null {
  if (!(headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) return null;
  const raw = new URLSearchParams(body).get("payload");
  if (!raw) return null;
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }

  const ownedSubmission = payload.type === "view_submission" && payload.view?.callback_id === CONNECT_CALLBACK_ID;
  const ownedAction = payload.type === "block_actions" && OWNED_ACTIONS.has(payload.actions?.[0]?.action_id);
  if (!ownedSubmission && !ownedAction) return null;

  if (!verifySlackSignature(headers, body))
    return { response: new Response("invalid signature", { status: 401 }), work: Promise.resolve() };

  const work = (async () => {
    try {
      if (ownedSubmission) {
        const apiKey = payload.view?.state?.values?.api_key_block?.api_key_input?.value ?? null;
        await handleConnectSubmission(payload.view.private_metadata, payload.user?.id, apiKey);
      } else {
        await handleBlockActions(payload);
      }
    } catch (error) {
      log.error(`Slack EventHandler interactive handling failed: ${(error as Error).message}`);
    }
  })();
  return { response: new Response(null, { status: 200 }), work };
}
