import { cookies } from "next/headers";
import { config } from "../../../../lib/config.ts";
import { exchangeCode, invalidateTools, saveTokens } from "../../../../lib/mcp/index.ts";
import { redirectWith } from "../../../../lib/web/redirects.ts";
import { requireUser } from "../../../../lib/web/session.ts";

const MCP_OAUTH_COOKIE = "manfrod_mcp_oauth";

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const user = await requireUser();
  const url = new URL(request.url);
  const jar = await cookies();
  const raw = jar.get(MCP_OAUTH_COOKIE)?.value;
  jar.delete(MCP_OAUTH_COOKIE);
  const session = raw ? (JSON.parse(raw) as { provider: string; codeVerifier: string; state: string }) : null;

  if (url.searchParams.get("error")) return redirectWith(request, "/integrations", { error: `${provider} authorization was denied.` });
  if (!session || session.provider !== provider || url.searchParams.get("state") !== session.state) {
    return redirectWith(request, "/integrations", { error: "Invalid OAuth session, please try connecting again." });
  }

  const redirectUri = `${config.appUrl}/mcp/${provider}/callback`;
  const tokens = await exchangeCode(provider, url.searchParams.get("code") ?? "", session.codeVerifier, redirectUri);
  if (!tokens.ok) return redirectWith(request, "/integrations", { error: `Failed to connect ${provider}: ${tokens.error}` });

  await saveTokens(user.id, provider, {
    accessToken: tokens.value.accessToken,
    refreshToken: tokens.value.refreshToken,
    expiresAt: tokens.value.expiresIn ? new Date(Math.floor(Date.now() / 1000 + tokens.value.expiresIn) * 1000) : null,
    scope: tokens.value.scope,
    status: "connected",
    notifiedExpiredAt: null,
  });
  invalidateTools(user.id, provider);
  return redirectWith(request, "/integrations", { info: `${provider} connected.` });
}
