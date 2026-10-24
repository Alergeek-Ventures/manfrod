import { makeSignature } from "better-auth/crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getUserByEmail } from "@/lib/accounts.ts";
import { auth } from "@/lib/auth.ts";
import { AUTH_COOKIE_PREFIX } from "@/lib/auth-constants.ts";
import { config } from "@/lib/config.ts";
import { homeFor } from "@/lib/web/session.ts";

const IMPERSONATION_EMAIL = "franek@alergeek.ventures";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOCAL_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const forwarded = request.headers.get("x-forwarded-for");
  if (!LOCAL_HOSTS.has(url.hostname) || (forwarded && !LOCAL_ADDRESSES.has(forwarded.split(",")[0].trim()))) {
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
  }
  const user = await getUserByEmail(IMPERSONATION_EMAIL);
  if (!user) {
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(`No local user found for ${IMPERSONATION_EMAIL}.`)}`, request.url));
  }
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(user.id);
  const signature = await makeSignature(session.token, config.betterAuthSecret);
  (await cookies()).set(`${AUTH_COOKIE_PREFIX}.session_token`, `${session.token}.${signature}`, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    expires: session.expiresAt,
  });
  return NextResponse.redirect(new URL(homeFor(user), request.url));
}
