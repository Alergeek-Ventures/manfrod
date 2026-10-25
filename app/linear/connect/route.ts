import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authorizeUrl, OAUTH_COOKIE, readIntent } from "../../../lib/linear/oauth.ts";
import { linearPage } from "../../../lib/linear/page.ts";

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("intent");
  if (!readIntent(token)) return linearPage("Link wygasł albo jest nieprawidłowy. Uruchom /linear-status w Slacku jeszcze raz.", 400);
  const state = randomBytes(24).toString("base64url");
  const url = authorizeUrl(state);
  if (!url) return linearPage("Integracja z Linearem nie jest skonfigurowana.", 500);

  (await cookies()).set(OAUTH_COOKIE, JSON.stringify({ state, intent: token }), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
    secure: process.env.NODE_ENV === "production",
  });
  return NextResponse.redirect(url);
}
