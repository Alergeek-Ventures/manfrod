import { eq } from "drizzle-orm";
import { getUserBySlackId } from "../accounts.ts";
import { db, tables } from "../db/index.ts";
import type { Project } from "../db/schema.ts";
import { logger } from "../log.ts";
import { openDm, post, respond } from "../slack/api.ts";
import type { LResult, Team } from "./client.ts";
import { connect, getConnection, installedTeams, type LinearConnection } from "./index.ts";
import { installLink } from "./oauth.ts";

const log = logger("Linear.Status");
export const CONNECT_CALLBACK_ID = "linear_connect_modal";
export const INSTALL_ACTION_ID = "linear_install";
export const PICK_TEAM_ACTION_ID = "linear_pick_team";
const TEAM_BLOCK_ID = "team_block";
const TEAM_ACTION_ID = "team_select";

function statusText(project: Project, connection: LinearConnection | null, canInstall: boolean): string {
  const team = connection?.linearTeamName ?? connection?.linearTeamId;
  if (connection?.mode === "app") return `🟢 *Linear połączony* — zespół *${team}*. Manfrod może czytać, tworzyć i komentować issues.`;
  const next = canInstall
    ? "Kliknij *Połącz z Linearem* i zatwierdź aplikację Manfrod w workspace Lineara tego projektu."
    : "Integracja z Linearem nie jest skonfigurowana (brak `LINEAR_CLIENT_ID`).";
  if (connection) return `🟡 *Linear połączony starym kluczem API* — zespół *${team}*, tylko odczyt.\n${next}`;
  return `🔴 *Linear nie jest połączony* dla projektu \`${project.slug}\`.\n${next}`;
}

const button = (actionId: string, label: string, extra: Record<string, unknown>) => ({
  type: "button",
  action_id: actionId,
  text: { type: "plain_text", text: label, emoji: true },
  ...extra,
});

async function render(project: Project, slackUserId: string | null): Promise<{ text: string; blocks: unknown[] }> {
  const connection = await getConnection(project.id);
  const link = slackUserId ? installLink({ projectId: project.id, slackUserId }) : null;
  const text = statusText(project, connection, link !== null);
  const buttons = [
    ...(connection?.mode === "app" ? [button("linear_connect", "Zmień zespół", { value: project.id })] : []),
    ...(connection?.mode !== "app" && link ? [button(INSTALL_ACTION_ID, "Połącz z Linearem", { url: link, style: "primary" })] : []),
    ...(connection ? [button("linear_disconnect", "Disconnect", { value: project.id, style: "danger" })] : []),
  ];
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text } }];
  if (buttons.length > 0) blocks.push({ type: "actions", elements: buttons });
  return { text, blocks };
}

export async function postStatus(channelId: string, slackUserId: string, project: Project): Promise<void> {
  const { text, blocks } = await render(project, slackUserId);
  await post("chat.postEphemeral", { channel: channelId, user: slackUserId, text, blocks });
}

export async function refresh(responseUrl: string | null | undefined, project: Project, slackUserId: string | null): Promise<void> {
  if (!responseUrl) return;
  const { text, blocks } = await render(project, slackUserId);
  await respond(responseUrl, { replace_original: true, text, blocks });
}

const textBlock = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });

const teamOptions = (teams: Team[]) =>
  teams.map((team) => ({ text: { type: "plain_text", text: `${team.name} (${team.key})` }, value: team.id }));

export async function openConnectModal(triggerId: string, projectId: string, responseUrl: string | null): Promise<void> {
  const connection = await getConnection(projectId);
  if (!connection?.installationId) return;
  const base = {
    type: "modal",
    callback_id: CONNECT_CALLBACK_ID,
    private_metadata: JSON.stringify({ project_id: projectId, installation_id: connection.installationId, response_url: responseUrl }),
    title: { type: "plain_text", text: "Zmień zespół" },
    close: { type: "plain_text", text: "Cancel" },
  };
  const opened = await post("views.open", { trigger_id: triggerId, view: { ...base, blocks: [textBlock("Ładuję zespoły z Lineara…")] } });
  const viewId = opened.ok ? (opened.body.view as { id?: string } | undefined)?.id : undefined;
  if (!viewId) return log.error("Linear.Status: could not open the connect modal");

  const teams = await installedTeams(connection.installationId);
  if (!teams.ok || teams.value.length === 0) {
    const reason = teams.ok ? "Aplikacja Manfrod nie ma dostępu do żadnego zespołu." : `Nie udało się pobrać zespołów: ${teams.error}`;
    await post("views.update", { view_id: viewId, view: { ...base, blocks: [textBlock(`❌ ${reason}`)] } });
    return;
  }
  await post("views.update", {
    view_id: viewId,
    view: {
      ...base,
      submit: { type: "plain_text", text: "Save" },
      blocks: [
        {
          type: "input",
          block_id: TEAM_BLOCK_ID,
          label: { type: "plain_text", text: "Zespół Lineara dla tego projektu" },
          element: { type: "static_select", action_id: TEAM_ACTION_ID, options: teamOptions(teams.value) },
        },
      ],
    },
  });
}

export const selectedTeam = (payload: Record<string, any>): string | null =>
  payload.view?.state?.values?.[TEAM_BLOCK_ID]?.[TEAM_ACTION_ID]?.selected_option?.value ?? null;

export async function getProject(projectId: string): Promise<Project | null> {
  const [project] = await db.select().from(tables.projects).where(eq(tables.projects.id, projectId)).limit(1);
  return project ?? null;
}

async function dm(slackUserId: string, payload: Record<string, unknown>): Promise<void> {
  const channel = await openDm(slackUserId);
  if (channel) await post("chat.postMessage", { channel, ...payload });
  else log.error(`Linear.Status: could not DM ${slackUserId}`);
}

function resultText(project: Project | null, result: LResult<LinearConnection>): string {
  if (result.ok)
    return `🟢 Linear połączony z projektem \`${project?.slug ?? "?"}\` — zespół *${result.value.linearTeamName ?? result.value.linearTeamId}*.`;
  if (result.error === "not_installed" || result.error === "expired")
    return "❌ Autoryzacja aplikacji Manfrod w Linearze wygasła — uruchom `/linear-status` i połącz ponownie.";
  log.error(`Linear.Status: connect failed: ${result.error}`);
  return "❌ Nie udało się zapisać połączenia z Linear — uruchom `/linear-status` i spróbuj ponownie.";
}

async function connectAs(slackUserId: string, projectId: string, installationId: string, teamId: string) {
  const user = await getUserBySlackId(slackUserId);
  return connect(projectId, user?.id ?? null, installationId, teamId);
}

export async function handleConnectSubmission(privateMetadata: string, slackUserId: string, teamId: string | null): Promise<void> {
  const {
    project_id: projectId,
    installation_id: installationId,
    response_url: responseUrl,
  } = JSON.parse(privateMetadata) as { project_id: string; installation_id: string; response_url: string | null };
  const result = teamId ? await connectAs(slackUserId, projectId, installationId, teamId) : ({ ok: false, error: "no_team" } as const);
  const project = await getProject(projectId);
  await dm(slackUserId, { text: resultText(project, result) });
  if (project) await refresh(responseUrl, project, slackUserId);
}

export async function finishInstall(slackUserId: string, projectId: string, installationId: string, organization: string, teams: Team[]) {
  const project = await getProject(projectId);
  if (teams.length === 1) {
    await dm(slackUserId, { text: resultText(project, await connectAs(slackUserId, projectId, installationId, teams[0].id)) });
    return;
  }
  if (teams.length === 0) {
    await dm(slackUserId, { text: `❌ Aplikacja Manfrod w workspace *${organization}* nie ma dostępu do żadnego zespołu.` });
    return;
  }
  const text = `Aplikacja Manfrod zainstalowana w *${organization}*. Wybierz zespół dla projektu \`${project?.slug ?? "?"}\`:`;
  await dm(slackUserId, {
    text,
    blocks: [
      textBlock(text),
      {
        type: "actions",
        block_id: `${PICK_TEAM_ACTION_ID}:${projectId}:${installationId}`,
        elements: [
          {
            type: "static_select",
            action_id: PICK_TEAM_ACTION_ID,
            placeholder: { type: "plain_text", text: "Zespół" },
            options: teamOptions(teams),
          },
        ],
      },
    ],
  });
}

export async function handleTeamPick(slackUserId: string, blockId: string, teamId: string, responseUrl: string | null): Promise<void> {
  const [, projectId, installationId] = blockId.split(":");
  if (!projectId || !installationId) return;
  const result = await connectAs(slackUserId, projectId, installationId, teamId);
  const text = resultText(await getProject(projectId), result);
  if (responseUrl) await respond(responseUrl, { replace_original: true, text });
}
