import { cookies } from "next/headers";
import { getUserBySlackId } from "../../../lib/accounts.ts";
import { listTeams, viewer } from "../../../lib/linear/client.ts";
import { saveInstallation } from "../../../lib/linear/installation.ts";
import { exchangeCode, OAUTH_COOKIE, readIntent } from "../../../lib/linear/oauth.ts";
import { linearPage } from "../../../lib/linear/page.ts";
import { finishInstall } from "../../../lib/linear/status.ts";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const jar = await cookies();
  const raw = jar.get(OAUTH_COOKIE)?.value;
  jar.delete(OAUTH_COOKIE);
  const session = raw ? (JSON.parse(raw) as { state: string; intent: string }) : null;
  const intent = readIntent(session?.intent, { allowExpired: true });

  if (url.searchParams.get("error")) return linearPage("Autoryzacja w Linearze została anulowana.", 400);
  if (!session || !intent || url.searchParams.get("state") !== session.state) {
    return linearPage("Nieprawidłowa sesja OAuth. Uruchom /linear-status w Slacku i spróbuj jeszcze raz.", 400);
  }

  const tokens = await exchangeCode(url.searchParams.get("code") ?? "");
  if (!tokens.ok) return linearPage(`Nie udało się połączyć z Linearem: ${tokens.error}`, 502);

  const auth = `Bearer ${tokens.value.accessToken}`;
  const [identity, teams] = await Promise.all([viewer(auth), listTeams(auth)]);
  if (!identity.ok || !teams.ok) return linearPage("Nie udało się odczytać workspace'u z Lineara.", 502);

  const user = await getUserBySlackId(intent.slackUserId);
  const { installation } = await saveInstallation(
    tokens.value,
    { id: identity.value.organizationId, name: identity.value.organizationName, appUserId: identity.value.userId },
    teams.value.map((team) => team.id),
    user?.id ?? null,
  );
  await finishInstall(intent.slackUserId, intent.projectId, installation.id, identity.value.organizationName, teams.value);
  return linearPage(
    `Aplikacja Manfrod jest zainstalowana w ${identity.value.organizationName}. Szczegóły dostaniesz na Slacku — możesz zamknąć tę kartę.`,
  );
}
