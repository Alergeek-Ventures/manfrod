import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { config } from "../../../lib/config.ts";
import { encodeOauthCookie, newOauthCookie, OAUTH_COOKIE_MAX_AGE } from "../../../lib/github/connect.ts";
import { OAUTH_COOKIE } from "../../../lib/github/oauth.ts";
import { currentUser } from "../../../lib/web/session.ts";

export const panelRedirect = (path: string) => NextResponse.redirect(new URL(path, config.appUrl));

export const integrationsRedirect = (kind: "info" | "error", message: string) =>
  panelRedirect(`/integrations?${kind}=${encodeURIComponent(message)}`);

export async function startOauth(target: (state: string) => Promise<string | null>): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return panelRedirect(`/login?error=${encodeURIComponent("You must sign in to access this page.")}`);
  const cookie = newOauthCookie(user.id);
  const url = await target(cookie.state).catch(() => null);
  if (!url) return integrationsRedirect("error", "The GitHub integration is not configured.");
  (await cookies()).set(OAUTH_COOKIE, encodeOauthCookie(cookie), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: OAUTH_COOKIE_MAX_AGE,
    secure: process.env.NODE_ENV === "production",
  });
  return NextResponse.redirect(url);
}
