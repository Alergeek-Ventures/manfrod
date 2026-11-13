import { cookies } from "next/headers";
import { connectAccount } from "../../../lib/github/accounts.ts";
import { appJwt, github, paginate } from "../../../lib/github/api.ts";
import { planCallback } from "../../../lib/github/connect.ts";
import { exchangeCode, OAUTH_COOKIE } from "../../../lib/github/oauth.ts";
import { type InstallationInput, upsertInstallation } from "../../../lib/github/store.ts";
import { EVENTS, sendEvent } from "../../../lib/inngest/client.ts";
import { logger } from "../../../lib/log.ts";
import { currentUser } from "../../../lib/web/session.ts";
import { integrationsRedirect } from "../connect/start.ts";

const log = logger("Github.Callback");
const SYNCING = "Repositories will sync in a moment.";

async function recordInstaller(installationId: number, userId: string, userToken: string) {
  const visible = await paginate<{ id: number }>(userToken, "/user/installations", (page) => page.installations);
  if (!visible.some((entry) => entry.id === installationId)) return;
  const installation = await github<InstallationInput>(appJwt(), "GET", `/app/installations/${installationId}`);
  if (installation) await upsertInstallation(installation, userId);
}

export async function GET(request: Request) {
  const jar = await cookies();
  const raw = jar.get(OAUTH_COOKIE)?.value;
  jar.delete(OAUTH_COOKIE);
  const user = await currentUser();
  const plan = planCallback(new URL(request.url).searchParams, raw, user?.id ?? null);

  if (plan.installationId) await sendEvent(EVENTS.githubInstallationChanged, { installationId: plan.installationId });
  if (plan.error) return integrationsRedirect("error", plan.error);
  if (!plan.linkUserId || !plan.code) return integrationsRedirect("info", `GitHub App installation updated. ${SYNCING}`);

  const tokens = await exchangeCode(plan.code);
  if (!tokens.ok) return integrationsRedirect("error", `Could not connect GitHub: ${tokens.error}`);
  let login: string;
  try {
    login = (await connectAccount(plan.linkUserId, tokens.value)).login;
  } catch (error) {
    log.warn("connecting account failed", error);
    return integrationsRedirect("error", "Could not read your GitHub profile. Try again.");
  }
  if (plan.installationId) {
    await recordInstaller(plan.installationId, plan.linkUserId, tokens.value.accessToken).catch((error: unknown) =>
      log.warn(`recording installation ${plan.installationId} failed`, error),
    );
  }
  return integrationsRedirect("info", plan.installationId ? `GitHub connected as @${login}. ${SYNCING}` : `GitHub connected as @${login}.`);
}
