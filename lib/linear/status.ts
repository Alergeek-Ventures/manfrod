import { eq } from "drizzle-orm";
import { getUserBySlackId } from "../accounts.ts";
import { db, tables } from "../db/index.ts";
import type { Project } from "../db/schema.ts";
import { logger } from "../log.ts";
import { openDm, post, respond } from "../slack/api.ts";
import { connect, getConnection, type LinearConnection } from "./index.ts";

const log = logger("Linear.Status");
export const CONNECT_CALLBACK_ID = "linear_connect_modal";

function disconnectedText(project: Project): string {
  return (
    `🔴 *Linear nie jest połączony* dla projektu \`${project.slug}\`.\n\n` +
    "Żeby połączyć:\n" +
    "1. W Linearze: *Settings → API → Personal API keys → New API key*\n" +
    '2. *Permissions* → "Only select permissions..." → zaznacz tylko *Read*\n' +
    `3. *Team access* → "Only select teams..." → wybierz zespół odpowiadający projektowi \`${project.slug}\`\n` +
    "4. Utwórz klucz i skopiuj go\n" +
    "5. Kliknij *Connect* poniżej i wklej klucz"
  );
}

const connectedText = (connection: LinearConnection) =>
  `🟢 *Linear połączony* — zespół *${connection.linearTeamName ?? connection.linearTeamId}*.`;

function button(actionId: string, style: string, projectId: string, label: string) {
  return {
    type: "actions",
    elements: [{ type: "button", action_id: actionId, style, value: projectId, text: { type: "plain_text", text: label, emoji: true } }],
  };
}

async function render(project: Project): Promise<{ text: string; blocks: unknown[] }> {
  const connection = await getConnection(project.id);
  const text = connection ? connectedText(connection) : disconnectedText(project);
  const action = connection
    ? button("linear_disconnect", "danger", project.id, "Disconnect")
    : button("linear_connect", "primary", project.id, "Connect");
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }, action] };
}

export async function postStatus(channelId: string, slackUserId: string, project: Project): Promise<void> {
  const { text, blocks } = await render(project);
  await post("chat.postEphemeral", { channel: channelId, user: slackUserId, text, blocks });
}

export async function refresh(responseUrl: string | null | undefined, project: Project): Promise<void> {
  if (!responseUrl) return;
  const { text, blocks } = await render(project);
  await respond(responseUrl, { replace_original: true, text, blocks });
}

export async function openConnectModal(triggerId: string, projectId: string, responseUrl: string | null): Promise<void> {
  await post("views.open", {
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: CONNECT_CALLBACK_ID,
      private_metadata: JSON.stringify({ project_id: projectId, response_url: responseUrl }),
      title: { type: "plain_text", text: "Connect Linear" },
      submit: { type: "plain_text", text: "Connect" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "api_key_block",
          label: { type: "plain_text", text: "Personal API Key (read-only, team-scoped)" },
          element: { type: "plain_text_input", action_id: "api_key_input" },
        },
      ],
    },
  });
}

export async function getProject(projectId: string): Promise<Project | null> {
  const [project] = await db.select().from(tables.projects).where(eq(tables.projects.id, projectId)).limit(1);
  return project ?? null;
}

export async function handleConnectSubmission(privateMetadata: string, slackUserId: string, apiKey: string | null): Promise<void> {
  const { project_id: projectId, response_url: responseUrl } = JSON.parse(privateMetadata) as {
    project_id: string;
    response_url: string | null;
  };
  const user = await getUserBySlackId(slackUserId);
  const result = await connect(projectId, user?.id ?? null, (apiKey ?? "").trim());

  let message: string;
  if (result.ok) {
    message = `🟢 Linear connected — team *${result.connection.linearTeamName ?? result.connection.linearTeamId}*.`;
  } else if (result.error === "invalid_key") {
    message =
      "❌ Nieprawidłowy klucz Linear API — sprawdź czy ma uprawnienie *Read* i jest zawężony do właściwego zespołu (*Team access*). Uruchom `/linear-status` ponownie, żeby spróbować jeszcze raz.";
  } else if (result.error === "no_team_scoped") {
    message =
      "❌ Ten klucz nie jest zawężony do jednego zespołu (*Team access → Only select teams...*). Wygeneruj nowy klucz i uruchom `/linear-status` ponownie.";
  } else {
    log.error(`Linear.Status: connect failed: ${result.error}`);
    message = "❌ Nie udało się zapisać połączenia z Linear — spróbuj ponownie.";
  }

  const dm = await openDm(slackUserId);
  if (dm) await post("chat.postMessage", { channel: dm, text: message });
  else log.error(`Linear.Status: could not DM ${slackUserId}`);

  const project = await getProject(projectId);
  if (project) await refresh(responseUrl, project);
}
