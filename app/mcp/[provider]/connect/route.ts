import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { config } from "../../../../lib/config.ts";
import { authorizeUrl, getProviderForUser } from "../../../../lib/mcp/index.ts";
import { redirectWith } from "../../../../lib/web/redirects.ts";
import { requireUser } from "../../../../lib/web/session.ts";

const MCP_OAUTH_COOKIE = "manfrod_mcp_oauth";

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const user = await requireUser();
  const mcpProvider = await getProviderForUser(user.id, provider);
  if (!mcpProvider) return redirectWith(request, "/integrations", { error: "Unknown provider." });
  if (mcpProvider.mock) return redirectWith(request, "/integrations", { error: `${provider} is not available yet.` });

  const redirectUri = `${config.appUrl}/mcp/${provider}/callback`;
  const result = await authorizeUrl(provider, mcpProvider.mcpUrl, redirectUri, mcpProvider.scope);
  if (!result.ok) return redirectWith(request, "/integrations", { error: `Failed to start ${provider} connection: ${result.error}` });

  (await cookies()).set(
    MCP_OAUTH_COOKIE,
    JSON.stringify({ provider, codeVerifier: result.value.codeVerifier, state: result.value.state }),
    { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600, secure: process.env.NODE_ENV === "production" },
  );
  return NextResponse.redirect(result.value.url);
}
