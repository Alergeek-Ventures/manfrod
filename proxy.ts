import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE_PREFIX } from "@/lib/auth-constants.ts";

const PANEL_PREFIXES = ["/dashboard", "/admin", "/graph", "/retrospection", "/integrations", "/chat"];

const matches = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const panel = pathname === "/" || PANEL_PREFIXES.some((prefix) => matches(pathname, prefix));
  if (!panel) return NextResponse.next();

  if (!getSessionCookie(request, { cookiePrefix: AUTH_COOKIE_PREFIX })) {
    const login = new URL("/login", request.url);
    login.searchParams.set("error", "You must sign in to access this page.");
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/|eve/|api/|auth/|mcp/|dev/|login|logout|images/|desk_maps/|favicon|robots.txt).*)"],
};
