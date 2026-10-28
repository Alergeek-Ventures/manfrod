import { getUserBySlackId, isAdmin } from "../accounts.ts";
import { logger } from "../log.ts";
import { normalizeHosts, placeholder, saveSecret, SECRET_NAME, type SecretScope } from "../secrets.ts";
import { post } from "./api.ts";

export const SECRET_ADD_ACTION_ID = "manfrod_secret_add";
export const SECRET_CALLBACK_ID = "manfrod_secret_modal";

const NAME_BLOCK = "secret_name";
const HOSTS_BLOCK = "secret_hosts";
const VALUE_BLOCK = "secret_value";
const DESCRIPTION_BLOCK = "secret_description";
const SCOPE_BLOCK = "secret_scope";
const FIELD = "input";

const log = logger("Slack.SecretModal");

export interface SecretRequest {
  name: string;
  hosts: string[];
  description: string | null;
  scope: SecretScope;
}

export function secretButton(request: SecretRequest, label: string) {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: SECRET_ADD_ACTION_ID,
        style: "primary",
        text: { type: "plain_text", text: label.slice(0, 75) },
        value: JSON.stringify(request).slice(0, 2000),
      },
    ],
  };
}

const textInput = (blockId: string, label: string, initial: string, options: { optional?: boolean; hint?: string } = {}) => ({
  type: "input",
  block_id: blockId,
  optional: options.optional ?? false,
  label: { type: "plain_text", text: label },
  ...(options.hint ? { hint: { type: "plain_text", text: options.hint } } : {}),
  element: { type: "plain_text_input", action_id: FIELD, ...(initial ? { initial_value: initial } : {}) },
});

export async function openSecretModal(
  triggerId: string,
  slackUserId: string,
  rawRequest: string,
  channel: string | null,
  threadTs: string | null,
) {
  let request: SecretRequest;
  try {
    request = JSON.parse(rawRequest);
  } catch {
    return;
  }
  const admin = isAdmin(await getUserBySlackId(slackUserId));
  const scopeOption = (scope: SecretScope) => ({
    text: { type: "plain_text", text: scope === "personal" ? "Prywatny (tylko ja)" : "Firmowy (wszyscy)" },
    value: scope,
  });
  const blocks = [
    textInput(NAME_BLOCK, "Nazwa", request.name, { hint: "Wielkie litery, cyfry i _, np. GITHUB_TOKEN" }),
    textInput(HOSTS_BLOCK, "Dozwolone hosty", request.hosts.join(", "), { hint: "Po przecinku, np. api.github.com, *.example.com" }),
    textInput(VALUE_BLOCK, "Wartość", "", { hint: "Trafia prosto do zaszyfrowanej bazy, Manfrod jej nie zobaczy" }),
    textInput(DESCRIPTION_BLOCK, "Opis", request.description ?? "", { optional: true }),
    ...(admin
      ? [
          {
            type: "input",
            block_id: SCOPE_BLOCK,
            label: { type: "plain_text", text: "Zakres" },
            element: {
              type: "static_select",
              action_id: FIELD,
              initial_option: scopeOption(request.scope),
              options: [scopeOption("personal"), scopeOption("company")],
            },
          },
        ]
      : []),
  ];
  const opened = await post("views.open", {
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: SECRET_CALLBACK_ID,
      private_metadata: JSON.stringify({ channel, threadTs }),
      title: { type: "plain_text", text: "Dodaj sekret" },
      submit: { type: "plain_text", text: "Zapisz" },
      close: { type: "plain_text", text: "Anuluj" },
      blocks,
    },
  });
  if (!opened.ok) log.error(`Slack.SecretModal: could not open the modal: ${opened.error}`);
}

interface Submission {
  name: string;
  hosts: string[];
  value: string;
  description: string | null;
  scope: SecretScope;
}

const fieldValue = (payload: Record<string, any>, blockId: string): string => {
  const field = payload.view?.state?.values?.[blockId]?.[FIELD];
  return String(field?.value ?? field?.selected_option?.value ?? "").trim();
};

export function readSubmission(payload: Record<string, any>): { submission: Submission } | { errors: Record<string, string> } {
  const name = fieldValue(payload, NAME_BLOCK).toUpperCase();
  const value = fieldValue(payload, VALUE_BLOCK);
  const errors: Record<string, string> = {};
  if (!SECRET_NAME.test(name)) errors[NAME_BLOCK] = "Użyj wielkich liter, cyfr i _ (2-64 znaki)";
  if (value === "") errors[VALUE_BLOCK] = "Wartość nie może być pusta";
  let hosts: string[] = [];
  try {
    hosts = normalizeHosts(fieldValue(payload, HOSTS_BLOCK).split(","));
    if (hosts.length === 0) errors[HOSTS_BLOCK] = "Podaj co najmniej jeden host";
  } catch (error) {
    errors[HOSTS_BLOCK] = (error as Error).message;
  }
  if (Object.keys(errors).length > 0) return { errors };
  const scope = fieldValue(payload, SCOPE_BLOCK) === "company" ? "company" : "personal";
  return { submission: { name, hosts, value, description: fieldValue(payload, DESCRIPTION_BLOCK) || null, scope } };
}

export async function handleSecretSubmission(payload: Record<string, any>, submission: Submission): Promise<void> {
  const slackUserId: string | undefined = payload.user?.id;
  const actor = await getUserBySlackId(slackUserId);
  const { channel, threadTs } = JSON.parse(payload.view?.private_metadata ?? "{}") as { channel?: string | null; threadTs?: string | null };
  let text: string;
  try {
    if (!actor) throw new Error("Nie znam Twojego konta.");
    await saveSecret(actor, {
      name: submission.name,
      value: submission.value,
      description: submission.description,
      scope: submission.scope,
      allowedHosts: submission.hosts,
    });
    text = `:lock: Zapisane: \`${placeholder(submission.name)}\` (${submission.scope === "company" ? "firmowy" : "prywatny"}, działa dla: ${submission.hosts.join(", ")}). Napisz, żebym kontynuował.`;
  } catch (error) {
    text = `:warning: Nie udało się zapisać sekretu: ${(error as Error).message}`;
  }
  if (channel && slackUserId) {
    await post("chat.postEphemeral", { channel, user: slackUserId, text, ...(threadTs ? { thread_ts: threadTs } : {}) });
  }
}
