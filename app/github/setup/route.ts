import { parseInstallationId } from "../../../lib/github/connect.ts";
import { EVENTS, sendEvent } from "../../../lib/inngest/client.ts";
import { integrationsRedirect } from "../connect/start.ts";

export async function GET(request: Request) {
  const installationId = parseInstallationId(new URL(request.url).searchParams.get("installation_id"));
  if (!installationId) return integrationsRedirect("info", "Nothing changed on GitHub.");
  await sendEvent(EVENTS.githubInstallationChanged, { installationId });
  return integrationsRedirect("info", "GitHub App installation updated. Repositories will sync in a moment.");
}
